# Proportional delivery

The operating system must produce enough understanding and engineering for the decision in front
of it — no less, and no more. Two failure modes violate that rule:

- **Overqualification** keeps collecting facts or asking the owner questions after the next safe
  action is already clear.
- **Overengineering** adds architecture, process, abstractions, dependencies, or evidence whose
  cost is not justified by a present requirement or risk.

This policy applies to setup, discovery, decisions, delivery contracts, engineering, validation,
verification, and reporting.

## Qualification budget

1. Read canonical state and inspect the product before asking the owner. Do not ask a person for a
   fact the repository, configuration, taskboard, or evidence already contains.
2. Ask only when the answer changes a material product choice, risk acceptance, irreversible
   action, sensitive access, or final acceptance. Mechanical choices are made by the agent and
   stated briefly.
3. Ask one decision at a time. Explain why it is needed now, show two or three mutually exclusive
   options, state a recommendation and consequences, and allow a free-form answer. The owner must
   never have to invent an actor ID, schema value, path, or command.
4. An unknown is a valid record. Do not manufacture certainty to complete a form, and do not block a
   reversible next step on information that cannot change it.
5. Stop discovery when the remaining uncertainty cannot change the next decision. Record the
   uncertainty and the condition that would justify reopening research.

## Engineering budget

Understand the request before trying to minimize it. Read the affected code and trace the real flow
end to end. For a defect, inspect every caller of the shared behavior and fix the root cause once;
a tiny patch in the wrong path is not a proportional change.

Then stop at the first solution rung that satisfies the approved outcome:

1. **No build:** the requested capability is unnecessary or the claimed gap does not reproduce.
2. **Reuse:** the repository already has a helper, type, component, path, or established pattern.
3. **Standard or native:** the language standard library, database, browser, operating system, or
   other native platform capability covers the need.
4. **Installed capability:** an already-approved dependency covers it without a new package or
   operational surface.
5. **Local implementation:** only then, write the smallest complete, reversible implementation.
   Prefer deletion to addition, boring code to clever code, and the fewest affected files.

Do not add an abstraction, service, queue, store, dependency, configuration layer, extension point,
or operational process for a hypothetical future use. Any added complexity must name:

   - the present requirement or observed risk that needs it;
   - the simpler alternative considered and why it is insufficient now;
   - its maintenance and operational cost;
   - the rollback, removal, or later-expansion trigger.

Without that evidence, choose the simpler design. If two choices cost the same, choose the one that
handles real edge cases correctly. Scope is a boundary, not a suggestion: do not refactor adjacent
code or "clean up" unrelated areas unless the approved outcome requires it.

When a deliberately simple design has a known ceiling, record the ceiling and an observable trigger
for replacement beside the decision or code. A deferral without a trigger is hidden debt.

For bounded external collection, add retry, backoff, or a resumable checkpoint only when an observed
failure or the measured run length makes repeated work material; a short request does not need a
workflow engine. Keep evidence identity separate from execution identity: changing a URL path,
schedule, query, or collection mode does not create an independent source when the evidence still
comes from the same authority or marketplace. Separate run records are useful provenance, but must
not inflate corroboration or confidence as if another source confirmed the claim.

## Quality floor

Minimal is not careless. Never simplify away:

- understanding of the real flow and affected callers;
- validation at trust boundaries, security controls, and credential hygiene;
- error handling that prevents data loss;
- accessibility requirements;
- calibration or tuning required by real hardware or external systems;
- anything explicit in the approved acceptance criteria.

Non-trivial logic leaves the smallest runnable check that would fail if it breaks. Prefer one
focused check using the existing test path; do not introduce a framework, fixture system, or broad
suite for a trivial change. Material and high-risk claims still require the assurance depth below.

## Assurance depth

Assurance is proportional to impact while the baseline invariants remain mandatory.

| Change | Expected depth |
| --- | --- |
| Low-risk and reversible | Existing pattern, narrow diff, smallest runnable check where logic is non-trivial, concise evidence |
| Medium-risk or cross-boundary | Impact review, integration/regression proof, explicit rollback |
| High-risk, sensitive, production, or irreversible | Specialist gates, complete evidence, independent reproduction, human authority |

The baseline never shrinks: stay inside scope, keep credentials out of Git, prove material claims,
separate producer from verifier, and preserve human product and production authority. Proportional
delivery removes ceremony that cannot change an outcome; it does not waive safety.

## Review test

Before accepting a product or engineering result, ask:

- Did every human question cross the qualification threshold?
- Does every new layer or dependency have a current complexity justification?
- Did the solution stop at the earliest viable rung: no build, reuse, standard/native, installed,
  then local implementation?
- Is this the smallest complete change and the narrowest useful evidence?
- For a defect, was the shared root cause fixed after checking every caller?
- Does each deliberate shortcut name its ceiling and a measurable replacement trigger?
- Do collection retries/checkpoints match measured failure cost, and do multiple runs preserve one
  real source identity instead of manufacturing corroboration?
- Did the work stop when the approved outcome was met?
- Would deleting any new artifact, abstraction, or gate leave the outcome and risk control intact?

If the last answer is yes, remove it.

## Evidence behind the policy

This policy operationalizes recurring findings from real agent use: intent misreading and
self-initiated scope expansion commonly co-occur; visible corrections overwhelmingly require user
pushback; agents may modify already-correct code; and iterative agent output can accumulate
verbosity and structural erosion. Ponytail's agentic benchmark also provides a useful bounded
result: on twelve feature tasks its ladder reduced mean added lines by 54%, with the largest cuts
where native controls replaced custom components; on already-compact backend work the approaches
largely converged. Its safety tier kept all tested guards, while a bare "YAGNI + one-line" prompt
missed one. This is evidence for ordered reuse plus a quality floor, not for code golf. The study
used one model, four runs per cell, and a small deterministic safety suite, so the figures are a
directional benchmark rather than a universal guarantee. See:

- [Ponytail rules](https://github.com/DietrichGebert/ponytail/blob/main/AGENTS.md)
- [Ponytail agentic benchmark](https://github.com/DietrichGebert/ponytail/blob/main/benchmarks/results/2026-06-18-agentic.md)
- [How Coding Agents Fail Their Users](https://arxiv.org/abs/2605.29442)
- [Coding Agents Don't Know When to Act](https://www.sri.inf.ethz.ch/publications/gloaguen2026coding)
- [SlopCodeBench](https://arxiv.org/abs/2603.24755)
