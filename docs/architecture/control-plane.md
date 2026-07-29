# Product Operations control plane

The Control Tower converts product events into a governed sequence of owner-scoped tasks. It does
not replace specialist judgment and does not write fields owned by development or the human product
owner.

## Responsibilities

- reconcile canonical repositories before scheduling work;
- classify each incoming event and calculate affected artifacts;
- assign one semantic owner to every required output;
- order dependencies and allow safe parallel work;
- prevent direct, untracked agent-to-agent coordination;
- require manifests for cross-system writes;
- keep producers separate from independent verifiers;
- surface only genuine decisions and risks to the human product owner;
- close an event only after canonical, live, evidence, and downstream state agree.

## Event record

Every material event should contain:

```text
event ID
source and timestamp
canonical revision
scope
affected artifacts and live systems
owners
dependencies
human gates
write manifests
verification claims
downstream tasks
final disposition
```

## Scheduling rule

Tasks may run in parallel when they have disjoint semantic and write ownership. A downstream task
opens only after its declared prerequisites are evidenced. A producer's completion signal is not
the same as an independent PASS.

## Blocker handling

Blockers are classified before work is deferred:

```text
environment or freshness
authentication or fixture access
missing deterministic test data
missing test oracle or evidence contract
product decision
unsafe provider or real-world side effect
product defect
control-plane failure
live propagation failure
```

The Control Tower assigns the blocker to the role that can remove it. It does not relabel a missing
precondition as a product defect, and it does not accept a generic "blocked" verdict without a
reproduction path and next owner.
