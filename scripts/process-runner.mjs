import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function npmInvocation(args) {
  const npmCli = resolveNpmCli();
  if (npmCli) {
    return {
      command: process.execPath,
      args: [npmCli, ...args]
    };
  }
  if (process.platform === "win32") {
    throw new Error(
      "Cannot locate npm-cli.js; refusing to concatenate arguments through npm.cmd."
    );
  }
  return { command: "npm", args };
}

export function runProcess(
  command,
  args,
  { cwd, encoding = "utf8", env = process.env } = {}
) {
  return spawnSync(command, args, {
    cwd,
    encoding,
    env,
    windowsHide: true
  });
}

function resolveNpmCli() {
  const candidates = [
    process.env.npm_execpath,
    path.join(
      path.dirname(process.execPath),
      "node_modules",
      "npm",
      "bin",
      "npm-cli.js"
    ),
    process.env.APPDATA
      ? path.join(
          process.env.APPDATA,
          "npm",
          "node_modules",
          "npm",
          "bin",
          "npm-cli.js"
        )
      : null,
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .filter(Boolean)
      .map((entry) =>
        path.join(entry, "node_modules", "npm", "bin", "npm-cli.js")
      )
  ].filter(Boolean);
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}
