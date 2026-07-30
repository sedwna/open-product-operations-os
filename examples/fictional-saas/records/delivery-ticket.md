# TKT-20260729-001 — Configurable weekly summary day

- Status: `accepted`
- Owner: `RB-06 / actor.delivery`
- Development adapter: `RB-13 / actor.development-adapter`
- Event / issue / decision: `EVT-20260729-001` / `ISS-20260729-001` /
  `DEC-20260729-001`

Outcome: In the local demo, a workspace coordinator can select Monday or Friday for the weekly
summary.

Acceptance criteria:

1. Given an existing fictional workspace, when the setting is read, then Monday remains selected.
2. Given a coordinator selects Friday, when the setting is saved and read again, then Friday is
   shown.
3. Given an unsupported day, when save is attempted, then the value is rejected and Monday remains.

Boundaries: local demo preference behavior only; no messaging provider, scheduled delivery,
credentials, network calls, or production data.

Development return:

- implementation reference: `dev-ref/fictional-42`
- development status: `implementation_complete`
- development notes: `Local demo state transition added; no deployment performed.`

Validation plan: `VPL-20260729-001`.
