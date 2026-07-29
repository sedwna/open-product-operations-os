# VRN-20260729-001 — Local demo execution

- Status: `completed`
- Executor: `RB-09 / actor.qa`
- Scenario / plan / ticket: `VSC-20260729-001` / `VPL-20260729-001` /
  `TKT-20260729-001`
- Environment: `local-demo`
- Implementation: `dev-ref/fictional-42`
- Started / ended: `2026-07-29T10:00:00Z` / `2026-07-29T10:08:00Z`

| Step | Actual observation | Evidence item |
| --- | --- | --- |
| 1 | Initial value was Monday | EVI-001 |
| 2 | Save read-back returned Friday | EVI-001 |
| 3 | Sunday was rejected as unsupported | EVI-001 |
| 4 | Final read-back remained Friday | EVI-001 |

Cleanup reset `pine-demo-01` to Monday. No residual state, credential, external call, or private data
remained.

- Result: `VRS-20260729-001`
- Evidence manifest: `EVD-20260729-001`
