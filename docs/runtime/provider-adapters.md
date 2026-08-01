# Provider adapters

Generated projects include a disabled provider catalog for development, work-management, and
workbook systems. Supported presets are GitHub, GitLab, Jira, Linear, Azure DevOps, Google Sheets,
Microsoft Graph workbooks, and Airtable.

The current adapter is a bounded HTTPS outbox, not a background synchronizer. A caller queues an
operation with an explicit provider, operation, method, endpoint, and payload. Dry-run validates and
shows the exact request. `--apply` requires the provider to be enabled and its configured credential
environment variable to exist.

Workbook writes additionally require an approved plan hash and attributed human authorization.
`DELETE` is refused for every provider. Redirects are refused. Successful receipts contain only the
operation identity, HTTP status, response hash, and completion time.

Read operations and mutation responses can declare a small `responseFields` allowlist. Only those
projected fields are stored in the provider inbox; the raw body remains hash-only. This enables
bounded inbound reconciliation without copying an entire provider payload into the project.

Workbook mutations additionally declare old-state and plan hashes, a rollback plan, a read-back
endpoint, and the exact expected read-back SHA-256. The adapter performs the read-back immediately.
A mismatch is durably marked `needs_reconciliation` and cannot be silently replayed.

Provider-specific bidirectional reconciliation, pagination cursors, webhook verification, and
rate-limit scheduling should be implemented as separate adapters behind this outbox contract. They
must preserve the same dry-run, attribution, receipt, and replay rules.

Forced scaffold refresh preserves configured provider values and adds newly published provider
entries. The catalog remains schema-validated after the merge.
