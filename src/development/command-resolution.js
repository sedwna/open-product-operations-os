import fs from "node:fs/promises";
import path from "node:path";

/**
 * Resolve a configured development command to something safe to execute directly.
 *
 * On Windows the official Claude Code install puts a `claude.cmd` batch shim on PATH. Running a
 * batch file means running it through the command interpreter, which brings shell quoting and
 * everything that follows from it into a path that takes contract text. So the shim is not run:
 * the package-owned launcher behind it is found and executed directly.
 *
 * This is the one piece of provider-specific knowledge the development boundary still needs. It
 * lived in the CLI readiness probes, which existed to support the retired one-click delivery model
 * and went with it; the shim problem did not.
 */
export async function resolveDevelopmentCommand(executable, args) {
  if (process.platform !== "win32" || !/\.(?:cmd|bat)$/i.test(executable)) {
    return { executable, args };
  }
  if (path.basename(executable).toLowerCase() !== "claude.cmd") {
    // Any other batch file would be run through the interpreter, which is the thing being avoided.
    throw new Error("The development adapter refuses Windows batch launchers other than the Claude shim.");
  }

  const packageRoot = path.join(path.dirname(executable), "node_modules", "@anthropic-ai", "claude-code");
  const nativeLauncher = path.join(packageRoot, "bin", "claude.exe");
  try {
    await fs.access(nativeLauncher);
    return { executable: nativeLauncher, args };
  } catch {
    // Older official npm releases ship the JavaScript launcher below instead.
  }

  const javascriptLauncher = path.join(packageRoot, "cli.js");
  try {
    await fs.access(javascriptLauncher);
  } catch {
    throw new Error("The Claude command shim has no resolvable package-owned native or JavaScript launcher.");
  }

  // Prefer the runtime shipped beside the shim; fall back to the one already running this process,
  // which is trusted by definition.
  const bundledNode = path.join(path.dirname(executable), "node.exe");
  let nodeExecutable = process.execPath;
  try {
    await fs.access(bundledNode);
    nodeExecutable = bundledNode;
  } catch {
    // Keep process.execPath.
  }
  return { executable: nodeExecutable, args: [javascriptLauncher, ...args] };
}
