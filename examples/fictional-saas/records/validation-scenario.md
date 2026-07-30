# VSC-20260729-001 — Save and reject weekly summary days

- Status: `ready`
- Plan / ticket: `VPL-20260729-001` / `TKT-20260729-001`
- Owner: `RB-07 / actor.validation`

Precondition: reset synthetic workspace `pine-demo-01` in unambiguously local environment
`local-demo`.

| Step | Action | Fixed expected outcome |
| --- | --- | --- |
| 1 | Read the existing setting | Monday is selected |
| 2 | Select Friday and save | Read-back returns Friday |
| 3 | Attempt unsupported value Sunday | Save is rejected |
| 4 | Read the setting again | Friday remains selected |

Pass requires every expected outcome. Any mismatch is fail; an unavailable or ambiguous environment
is inconclusive or not run. Outcomes cannot be changed after execution starts.
