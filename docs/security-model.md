# Security model

## Default position

Credentials, tokens, cookies, private keys, recovery codes, personal data, production-derived
fixtures, and provider secrets do not belong in Git, prompts, screenshots, receipts, or handoffs.

Runtime secrets are resolved from an approved local or managed store.

## Human gates

Explicit human authorization is required before:

- real-money movement;
- provider-backed payment or identity operations;
- production writes;
- destructive or irreversible changes;
- credential creation, rotation, export, or disclosure;
- changes to governance or role lifecycle;
- acceptance of unresolved risk.

## Test fixtures

Committed fixtures may contain public test constants only when all of these are true:

- identities are visibly synthetic;
- domains are reserved and non-deliverable;
- the runtime is proven local and non-production;
- a confirmation flag is mandatory;
- remote, staging, production, or ambiguous databases are refused before connection;
- reset is namespace-scoped, deterministic, and independently verified;
- no provider identity, real payment instrument, or production-derived data is present;
- deployment artifacts reject fixture identities and constants.

## Controlled writes

A live writer must:

1. accept only an owner-authorized manifest;
2. validate scope and field authority;
3. check old-value preconditions;
4. write the smallest bounded range;
5. read back through two independent paths where possible;
6. compare the entire affected record or tab;
7. prove idempotent replay performs zero writes;
8. produce a receipt and rollback plan.

## Public-package boundary

This repository must not include source-product credentials, spreadsheet IDs, private URLs,
customer data, proprietary screenshots, internal evidence, or product-specific decisions.

