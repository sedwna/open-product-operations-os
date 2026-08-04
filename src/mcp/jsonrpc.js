export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;

const MAX_LINE_BYTES = 4 * 1024 * 1024;

export class RpcError extends Error {
  constructor(code, message, data = undefined) {
    super(message);
    this.name = "RpcError";
    this.code = code;
    this.data = data;
  }
}

/**
 * Newline-delimited JSON-RPC 2.0 over a stdio pair, as required by the MCP stdio transport.
 * Nothing except protocol messages may reach the output stream; diagnostics belong on stderr.
 */
export function serveStdio({ input, output, handlers, onError = () => {} }) {
  let buffer = "";
  let closed = false;
  const pending = new Set();
  // Requests this server sends to the client, awaiting their responses. Elicitation needs this:
  // the human-authority path asks the host to collect a disposition from a person.
  const outbound = new Map();
  let outboundId = 0;

  const write = (message) => {
    if (closed) return;
    output.write(`${JSON.stringify(message)}\n`);
  };

  const respond = (id, result) => write({ jsonrpc: "2.0", id, result });
  const fail = (id, error) => write({
    jsonrpc: "2.0",
    id,
    error: { code: error.code ?? INTERNAL_ERROR, message: error.message, ...(error.data === undefined ? {} : { data: error.data }) }
  });

  const dispatch = async (message) => {
    const { id = null, method, params } = message;

    // A message carrying a result or an error is the client answering something we asked.
    if (method === undefined && message.id !== undefined) {
      const waiter = outbound.get(message.id);
      if (!waiter) return;
      outbound.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new RpcError(message.error.code ?? INTERNAL_ERROR, message.error.message ?? "The client returned an error."));
      else waiter.resolve(message.result ?? {});
      return;
    }

    const notification = message.id === undefined;
    if (message.jsonrpc !== "2.0" || typeof method !== "string") {
      if (!notification) fail(id, new RpcError(INVALID_REQUEST, "Request is not a valid JSON-RPC 2.0 message."));
      return;
    }
    const handler = handlers[method];
    if (!handler) {
      if (!notification) fail(id, new RpcError(METHOD_NOT_FOUND, `Method "${method}" is not supported.`));
      return;
    }
    try {
      const result = await handler(params ?? {});
      if (!notification) respond(id, result ?? {});
    } catch (error) {
      // A protocol-level RpcError is an ordinary client mistake and is reported in the response.
      // Only unexpected faults are worth a diagnostic line.
      if (!(error instanceof RpcError)) onError(error);
      if (!notification) {
        fail(id, error instanceof RpcError ? error : new RpcError(INTERNAL_ERROR, error.message));
      }
    }
  };

  const consume = (line) => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "Message is not valid JSON." } });
      return;
    }
    const messages = Array.isArray(message) ? message : [message];
    for (const entry of messages) {
      const task = dispatch(entry).finally(() => pending.delete(task));
      pending.add(task);
    }
  };

  input.setEncoding("utf8");
  input.on("data", (chunk) => {
    buffer += chunk;
    if (buffer.length > MAX_LINE_BYTES) {
      buffer = "";
      write({ jsonrpc: "2.0", id: null, error: { code: INVALID_REQUEST, message: "Message exceeds the transport size limit." } });
      return;
    }
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      consume(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      index = buffer.indexOf("\n");
    }
  });

  return {
    notify(method, params = {}) {
      write({ jsonrpc: "2.0", method, params });
    },
    /**
     * Ask the client something and wait for its answer. The timeout must be generous: an
     * elicitation waits on a person, not on a machine.
     */
    request(method, params = {}, { timeoutMs = 10 * 60 * 1000 } = {}) {
      if (closed) return Promise.reject(new RpcError(INTERNAL_ERROR, "The transport is closed."));
      const id = `server-${(outboundId += 1)}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          outbound.delete(id);
          reject(new RpcError(INTERNAL_ERROR, `The client did not answer "${method}" within the allowed time.`));
        }, timeoutMs);
        timer.unref?.();
        outbound.set(id, { resolve, reject, timer });
        write({ jsonrpc: "2.0", id, method, params });
      });
    },
    async close() {
      await Promise.allSettled([...pending]);
      closed = true;
      for (const waiter of outbound.values()) {
        clearTimeout(waiter.timer);
        waiter.reject(new RpcError(INTERNAL_ERROR, "The transport closed before the client answered."));
      }
      outbound.clear();
    },
    closed: new Promise((resolve) => {
      input.on("end", resolve);
      input.on("close", resolve);
    })
  };
}
