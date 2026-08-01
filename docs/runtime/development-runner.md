# Development runner

The development runner implements the RB-13 adapter boundary. It accepts only a task that:

- exists in the canonical taskboard;
- is owned by RB-13;
- is `ready` or `in_progress`;
- has complete dependencies;
- has an attributed approval for any declared human gate;
- uses an explicitly enabled `command-runner` adapter.

The runner writes a structured input file, invokes the configured executable without a command
shell, validates standard output against `development-run.schema.json`, checks the returned task
identity, rejects obvious credential material, and persists the validated return.

The child process receives only a minimal platform environment plus configured environment-variable
names. Secrets must remain in an approved runtime store. The adapter config stores names, not values.

An optional local Git adapter checks for a clean repository, captures the base revision, and creates
a task-scoped branch before execution. It is disabled by default.

## Trust boundary

The command runner does not provide an operating-system sandbox. An untrusted coding agent must run
inside a separately constrained worker, container, virtual machine, or hosted agent environment.
`allowedPaths` is part of the agent contract and evidence; it is not an OS access-control mechanism.

The returned implementation reference and tests are producer claims. RB-09 still executes the
approved validation scenarios and RB-12 independently verifies material claims.
