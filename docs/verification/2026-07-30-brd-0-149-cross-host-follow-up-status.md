# BRD-0-149 cross-host packed-artifact follow-up status

## Scope and authority

- Public pull request: `sedwna/open-product-operations-os#1`
- Branch: `codex/brd-0-121-foundation`
- Predecessor correction revision: `cc391dc8d782b122927519a54c439cb1609dd792`
- Producer status: cross-host corrective implementation and regressions prepared
- Independent status: fresh exact-head verification required

This producer artifact accepts the packed-artifact SHA mismatch found after the first BRD-0-149
correction. It appends to, and does not delete or rewrite, the earlier BRD-0-149 status. It does
not issue an independent `PASS`, modify an owner-controlled taskboard row, authorize merge, create
a tag, or authorize a release.

## Reproduced mismatch and root cause

The predecessor produced:

- Windows package SHA-256:
  `6464031209ec5e959c236e4ed84ba073184f6e95a8c613507a754def9455fa58`
- Linux package SHA-256:
  `da2d8563b462360ed7188faa6a6e0d96b1dedc286a2c37410a27c9c277491c30`

The two npm tarballs each contained 156 entries. Entry order, POSIX path names, modes, uid/gid,
fixed npm mtime, type, USTAR fields, and absence of PAX headers were identical. All 156 content
payloads differed by CRLF-to-LF conversion only; there were no non-EOL content differences.

The Linux packaging input had been created by `git archive` on a host whose effective
`core.autocrlf=true` checkout filter exported CRLF bytes. After extraction in Linux, the source
had no `.git` directory, so the Git-backed prepack canonicalizer intentionally had no blob or
checkout-filter reference and left those archive bytes unchanged. The mismatch was therefore
source EOL state, not tar ordering, permissions, timestamps, PAX metadata, path separators, gzip
header time, or omitted files.

## Corrective design

Git worktrees keep the original fail-closed contract: actual bytes must equal either the indexed
blob or Git's exact current checkout-filter output, and only an EOL-only checkout conversion may be
temporarily replaced by the blob.

For a source archive without Git metadata, prepack now:

1. reads the explicit `package.json` payload allowlist plus npm's automatic metadata files;
2. refuses ambiguous paths, path escape, symlinks, non-files, and CRLF-bearing binary or invalid
   UTF-8 bytes;
3. temporarily canonicalizes CRLF only in promised text payloads;
4. records original and canonical hashes plus original bytes in an exclusive archive-local state;
5. restores only files that still equal the canonical bytes after packing;
6. retains visible recovery state and fails closed instead of overwriting concurrent changes.

No promised file is removed or excluded. The Git blob/tamper and stale-attributes-transition
checks remain unchanged for ordinary clones.

## Regression contract

- Unit tests cover no-Git archive normalization, exact restoration, concurrent-pack refusal,
  concurrent-change preservation, and binary fail-closed behavior.
- The Windows clean-clone regression creates an ordinary clone inheriting
  `core.autocrlf=true`, proves CRLF checkout bytes, and compares its real npm tarball byte-for-byte
  with a CRLF Git archive packed without `.git`.
- The Linux clean-archive regression creates an exact Git archive, packs it without `.git`, checks
  the repository-controlled SHA-256, and proves byte-for-byte source restoration.
- The exact cross-host regression creates the ordinary Windows clone and a clean Linux Git archive
  inside the pinned Node 20 container, then requires the two real npm tarballs to be byte-for-byte
  identical.
- Every CI platform continues to install and exercise the real tarball against one controlled
  SHA-256; Windows and Linux additionally run their respective clean-source regressions.

## Remaining gate

Producer checks are execution signals, not an independent release disposition. Control
Tower/Agent 12 must verify the final exact public head and create final proof. Until then the
repository remains `Foundation / Evaluation`; merge, tag, release, self-approval, and status
promotion remain prohibited.
