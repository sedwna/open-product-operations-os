# Operating-model version 4 migration

Version 4 puts product authority before the delivery contract on finding and incident routes.

## What changed

Finding triage can record an issue as `needs_decision`. The previous route nevertheless made the
next RB-06 card runnable, even though RB-06 authors a canonical delivery ticket and that ticket must
reference an attributed approved product decision. The route asked only for engineering export
later, which authorizes a repository crossing rather than deciding what the product should deliver.

The first RB-06 step on any route now requires `product_direction_or_priority` unless an earlier
step already carries that gate. RB-05 may prepare the exact options, consequences, and recommendation
for a finding so the owner sees a product question rather than an internal gate identifier.

## What the migration does

`product-ops migrate <target>` reports the change without writing. `--apply` first stores the prior
configuration under `.product-ops/migrations/<run-id>/`, then adds the missing gate to the first
RB-06 step. Step order, dependencies, titles, and all other route fields are preserved. The change
is reported as `delivery_contract_direction_gates_added:<n>`.

This authority invariant also applies to customised routes. A route that reaches RB-06 without an
earlier or same-step product-direction gate fails configuration validation.

## What it does not change

Tasks already on the board keep the gate values with which they were created. If a finding is
already in flight at RB-06, attach the product-direction gate to that card and record the owner's
decision before continuing. Version 4 prevents the gap for newly routed events.
