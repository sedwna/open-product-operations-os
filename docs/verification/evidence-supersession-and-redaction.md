# Evidence supersession and public redaction policy

Verification records are retained as historical evidence. A later implementation does not delete
an earlier proof or receipt; it marks that record as superseded for current release evaluation and
links to the newer state.

Public clean-room policy creates one narrow exception to byte-level immutability: if a historical
file at the public branch tip repeats a policy-excluded source identity, the tip copy may replace
only that identity with a generic category. The correction must:

- preserve the file, result, revision, counts, limitations, and evidence meaning;
- record the pre-redaction Git blob identifier and the current public path;
- avoid restating the excluded value in the correction;
- leave existing Git history intact rather than rewriting it;
- remain classified as producer evidence unless an independent verifier issues a new disposition.

## Recorded public-tip redactions

| Current public path | Pre-redaction Git blob | Treatment | Evidence effect |
| --- | --- | --- | --- |
| `2026-07-30-final-fd5b620-two-host-proof.md` | `bd6d47c90ebd5305f6b0611bd5fc6d71bcbe8ccf` | Source identity replaced by `private source-product` | No result or isolation claim changed |
| `2026-07-30-final-fd5b620-linux-installed-cli-receipt.json` | `5ee7e7a0bb3d9357ffffa45556a974cbb673ff81` | Source identity replaced by `private source-product` | No receipt field, count, or outcome changed |
| `2026-07-30-final-two-host-proof.md` | `564daeddb6e8e2774abaebe8d7c1910a1fd5d258` | Source identity replaced by `private source-product` | No result or isolation claim changed |
| `2026-07-30-linux-installed-cli-receipt.json` | `a031ec5293ff09ebe1d38527925b351863fd5134` | Source identity replaced by `private source-product` | No receipt field, count, or outcome changed |

## Current supersession chain

1. The 2026-07-29, 39-test proof is historical and superseded.
2. The earlier 2026-07-30, 46-test proof is historical and superseded.
3. The `fd5b620` 56-test proof is the latest completed two-host producer proof for its exact
   implementation revision.
4. The corrective implementation that contains
   [the BRD-0-141 producer status](2026-07-30-brd-0-141-producer-correction-status.md) changes that
   implementation. Independent BRD-0-149 verification later found its Windows clean-clone
   portability claim false at exact head `e224428`; the file remains historical evidence.
5. The
   [BRD-0-149 producer correction status](2026-07-30-brd-0-149-producer-correction-status.md)
   supersedes only that producer portability claim, records the corrective design, and requires
   fresh exact-head independent verification.
6. The predecessor correction `cc391dc` passed its Windows path but produced different Windows and
   Linux npm package hashes. The
   [BRD-0-149 cross-host follow-up status](2026-07-30-brd-0-149-cross-host-follow-up-status.md)
   preserves that mismatch, supersedes the predecessor's producer hash claim, and routes the final
   exact head back to independent verification.

No entry in this chain is an independent `PASS`, merge authorization, tag, or release decision.
