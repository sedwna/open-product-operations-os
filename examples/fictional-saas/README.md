<div align="center">

# PineDesk weekly digest

### A fictional, local-only story showing one complete evidence-backed product change.

`no customers` · `no credentials` · `no providers` · `no production writes`

</div>

---

## The change

A workspace coordinator wants to choose whether a synthetic weekly summary arrives on Monday or
Friday. The example follows that request through discovery, an explicit human decision, a bounded
delivery contract, fictional implementation, local validation, human observation, controlled
workbook write, independent QC, readiness, and local-demo release.

```mermaid
flowchart LR
    A[Idea] --> B[Discovery]
    B --> C[Decision]
    C --> D[Issue]
    D --> E[Delivery ticket]
    E --> F[Validation]
    F --> G[Development]
    G --> H[QA + evidence]
    H --> I[Controlled write]
    I --> J[Independent QC]
    J --> K[Readiness + release]
```

## Reconstructable lineage

```text
IDEA-20260729-001
→ EVT-20260729-001
→ DSC-20260729-001
→ DEC-20260729-001
→ ISS-20260729-001
→ TKT-20260729-001
→ VPL-20260729-001
→ VSC-20260729-001
→ VRN-20260729-001
→ VRS-20260729-001
→ EVD-20260729-001
→ HOB-20260729-001
→ WRITE-001
→ RECEIPT-001
→ QCV-20260729-001
→ RDY-20260729-001
→ RELEASE-001
```

[`lineage.csv`](lineage.csv) normalizes every edge for workbook import. The files under
[`records/`](records/) present the same chain as readable contracts.

## Independence by design

| Actor | Responsibility |
| --- | --- |
| `actor.idea` | Prepare the product decision |
| `human.owner` | Decide product direction and visible-behavior acceptance |
| `actor.validation` | Fix expected outcomes before execution |
| `actor.qa` | Execute the run and report factual observations |
| `actor.writer` | Apply the authorized workbook manifest |
| `actor.verifier` | Reproduce the result and writer receipt independently |

No producer verifies the same claim. The independent verifier's own task is reviewed through the
separate risk-and-logic role so verification never becomes self-certification.

## Safe runtime fixtures

The [`runtime/`](runtime/) directory contains inputs for normalized intake, setup configuration,
and provider-outbox dry runs. Provider execution remains disabled and references only fictional
`example/example` data.

> [!NOTE]
> This example demonstrates record lineage and control behavior. Its local evidence says nothing
> about production performance, real users, or a live deployment.
