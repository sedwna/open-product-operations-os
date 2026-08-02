export function effectiveCodexSandboxArguments(args, environment = process.env) {
  const sandboxIndex = args.indexOf("--sandbox");
  if (sandboxIndex < 0 || !["workspace-write", "read-only"].includes(args[sandboxIndex + 1])) return args;
  if (environment.CODEX_PERMISSION_PROFILE !== ":danger-full-access") return args;
  const effective = [...args];
  effective[sandboxIndex + 1] = "danger-full-access";
  return effective;
}
