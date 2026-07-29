# Fictional SaaS example: PineDesk weekly digest

PineDesk is a fictional, local-only SaaS used to demonstrate lineage. It has no real customers,
credentials, providers, URLs, or proprietary content.

## Change

A workspace coordinator wants to choose whether a synthetic weekly summary appears on Monday or
Friday. Discovery supports the need, a human approves Friday as an option, a bounded delivery
contract is returned with a fictional implementation reference, a local demo run passes, a human
accepts the visible behavior, a controlled workbook write is read back and replayed with zero
writes, independent QC passes, and a local-demo release closes.

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

`lineage.csv` normalizes each edge for direct import into the workbook's `Lineage` tab. The
records under `records/` show the same chain as readable contracts.

## Actors and independence

- `actor.idea` prepares the decision.
- `human.owner` makes product and visible-behavior dispositions.
- `actor.validation` fixes expected outcomes.
- `actor.qa` executes and reports the run.
- `actor.writer` applies the authorized workbook manifest.
- `actor.verifier` independently reproduces the result and writer receipt.

No producer verifies the same claim, and no secret value appears anywhere in the example.
