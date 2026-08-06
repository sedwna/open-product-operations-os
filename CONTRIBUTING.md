# Contributing

The project is in foundation stage. Contributions should preserve these invariants:

- no product-specific or private data;
- no credential values;
- no direct producer self-certification;
- no silent status invention;
- no live-write claim without read-back;
- no generated result for an unexecuted test;
- no development completion invented by Product Operations roles.

Each change should include:

1. the problem and intended contract;
2. affected roles, schemas, templates, or adapters;
3. verification commands and results;
4. migration and compatibility notes;
5. evidence for any behavior claim.

Keep one logical change per commit.

## Verifying a change

```text
npm ci
npm run check          # lint, clean-room scan, the full suite, portability
npm run supply-chain   # audit, licences, and the bill of materials
npm run smoke          # the CLI end to end
```

`npm run packed:check` compares a real packed artifact against the recorded cross-host hash. It
fails whenever source changes until the hash is regenerated, and regenerating it from a single
platform has produced a false agreement before — so it belongs to CI or a second host, not to a
local run.

