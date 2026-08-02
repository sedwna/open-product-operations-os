# Product-cycle root-cause remediation

This change set closes the ten findings reproduced from the first complete three-task product test.

| Finding | Systemic control |
| --- | --- |
| Readiness contradicted the report | `ready` now requires human risk acceptance, rollback, and a linked release; the cycle records `conditionally_ready` otherwise. |
| Verification was inferred from completion | `ENG-15` must return an explicit passing disposition; missing, failed, or blocked dispositions cannot seal a verified delivery. |
| Gate evidence repeated every workstream | Gate evidence has a published schema and contains only gate-owner and independent-verifier workstreams through `relevantWorkstreamIds`. |
| Two taskboards diverged | The CSV under `taskboard/` is canonical; workbook tab 06 is updated synchronously and validated field by field. |
| Writer audit tabs stayed empty | Domain manifests and receipts are projected automatically, with fail-closed rollback if receipt registration fails. |
| Human decisions were absent | Approved attributed product-direction records are materialized and linked to idea, discovery, issue, and delivery rows. |
| Infrastructure errors consumed logical retries | Transient errors use a separate bounded counter and exponential retry schedule. |
| Autopilot helpers were duplicated | Git execution, identifier validation, and JSON writing share one module. |
| Browser and service rules diverged | Engineering plans now require one shared domain/service contract consumed by clients. |
| Frontend tests inspected source only | Engineering plans and prompts require behavioral DOM/browser evidence; the reference product uses a real DOM test. |

The generated workbook remains append-oriented. Writer-audit control-plane writes are deliberately
separate from the domain manifests they register so the audit log cannot recurse infinitely.
