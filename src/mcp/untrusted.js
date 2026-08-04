const DEFAULT_LIMIT = 600;
const OPEN = "<untrusted-record";
const CLOSE = "</untrusted-record>";

/**
 * Wrap text that originated outside this system — intake records, workbook cells, blocked reasons,
 * executor error strings — so a host model reports it instead of obeying it.
 *
 * The envelope markers are neutralised inside the payload; otherwise injected text could close the
 * envelope early and present the remainder as server-authored instruction.
 */
export function untrusted(value, { source = "record", id = "", limit = DEFAULT_LIMIT } = {}) {
  const raw = String(value ?? "").trim();
  if (raw === "") return null;
  const neutralised = raw.replaceAll(OPEN, "‹untrusted-record").replaceAll(CLOSE, "‹/untrusted-record›");
  const clipped = neutralised.length > limit ? `${neutralised.slice(0, limit)}…` : neutralised;
  const attributes = [`source="${attribute(source)}"`, id ? `id="${attribute(id)}"` : ""].filter(Boolean).join(" ");
  return `${OPEN} ${attributes}>${clipped}${CLOSE}`;
}

export function untrustedList(values, options = {}) {
  return (Array.isArray(values) ? values : [])
    .map((value) => untrusted(value, options))
    .filter(Boolean);
}

function attribute(value) {
  return String(value).replaceAll('"', "'").replaceAll(/[<>\n\r]/g, " ").slice(0, 120);
}
