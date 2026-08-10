# Operating-model version 3 migration

Version 3 changes one thing: how a routed event becomes work.

## What changed

A route's steps used to be a strict chain. Each step waited on the step written before it, whatever
it actually needed. The board could therefore only ever offer one card, and the order in which
someone happened to type the steps became the order of the product. Two consequences were visible in
practice:

- **Validation design waited for implementation.** Both are written from the same delivery contract,
  and putting the test plan after the build turns it into a description of what was made rather than
  a statement of what was required.
- **Risk and logic audit was never asked.** RB-08 appeared only on workbook and governance routes, so
  an idea could travel from discovery to release without anyone challenging its assumptions.

A step now names what it waits on:

```json
{ "role": "RB-07", "title": "Design validation", "humanGate": "", "key": "validation-design", "after": ["contract"] }
```

- `key` names the step so later steps can refer to it. Unique within the route.
- `after` lists the keys of earlier steps that must be done first.
  - `[]` means the step waits on nothing and opens with the event.
  - Omitting `after` entirely keeps the old behaviour: wait on the step written before this one.

A key may only refer to a step written earlier in the same route. Configuration validation reports a
forward reference, a self reference, and a duplicate key. At runtime an unresolved key falls back to
waiting on the previous step — the conservative reading — so a typo can never make work start
earlier than intended.

## What the migration does to your routes

`product-ops migrate <target>` reports the exact migration without writing; `--apply` stores the
previous configuration under `.product-ops/migrations/<run-id>/` first.

For each route, the migration compares your steps against the shape every version-2 project was
generated with:

- **Untouched** — replaced with the current default, which carries keys, the parallel fan-out from
  the delivery contract, and the risk audit. Reported as `routing_steps_parallelised:<n>`.
- **Edited** — left exactly as you wrote it. Reported as `routing_steps_left_as_customised:<n>`.

A routing table is a statement about how a particular product works. An upgrade may improve what its
owner did not decide; it has no standing to overwrite what they did. If you want a customised route
parallelised too, add `key` and `after` to its steps yourself.

## What it does not change

Tasks already on the board keep the dependencies they were created with. Routing applies when an
event is routed, so the new shape governs the next event, not the ones already in flight.
