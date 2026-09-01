# Controlled writer adapter interface

The controlled-writer interface is the provider-neutral boundary between an authorized Workbook
manifest and an implementation that can apply it. The descriptor is validated by
`schemas/controlled-writer-adapter.schema.json`; an adopter starts from
`templates/writers/controlled-writer-adapter.json`.

An adapter exposes exactly five lifecycle methods:

1. `plan` validates the manifest, target, ownership, preconditions and smallest bounded scope. It
   changes nothing and returns a content-addressed plan hash.
2. `apply` accepts only the exact preceding plan hash and records an append-only journal before the
   first external mutation. An acknowledgement is not a success claim.
3. `readBack` reads the complete affected state and a second independent path, then emits a receipt
   conforming to `schemas/workbook-write-receipt.schema.json`.
4. `replay` proves that the same manifest and plan produce zero writes after verified application.
5. `rollback` restores the recorded preimage, or performs the declared compensating action, and
   reads the result back. Ambiguous or changed state fails closed for reconciliation.

The descriptor cannot disable dry-run-first operation, exact plan binding, old-state
preconditions, bounded scope, complete read-back, a second read path, replay-zero, rollback or the
secret-value prohibition. It carries no endpoint, credential name or vendor-specific object ID.
Provider configuration belongs in the adopting project's disabled-by-default adapter settings.

`src/adapters/controlled-writer-contract.js` validates both the descriptor and the executable method
surface. Passing that check proves interface shape only. It does not prove provider behavior,
authorize production access, independently verify a receipt or turn an incomplete read-back into a
success claim.

The packaged local CSV writer remains the reference implementation for control mechanics. A remote
adapter must preserve the same manifest, plan-hash, read-back, replay and rollback semantics and
must add provider-specific authentication and failure handling outside committed artifacts.
