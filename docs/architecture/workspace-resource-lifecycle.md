# Workspace and resource lifecycle

Temporary workspaces and Docker resources are governed product-delivery resources. They are not
anonymous scratch space. The objective is to keep every resource attributable, recoverable, and
bounded from creation through terminal disposition without turning cleanup into a broad deletion
mechanism.

This policy applies to Git worktrees, Docker containers, images, volumes, networks and build cache,
temporary folders, mounts, and execution leases created for Product or Development work.

## Creation contract

Record a resource in the suite-root `.workspace/resources.csv` before creating it, then read back
both the record and the created resource. Every row has these fields:

| Field | Contract |
| --- | --- |
| `resource_id` | Stable identifier that is never reused. |
| `resource_type` | Git worktree, Docker resource, temporary folder, mount, or lease. |
| `project_id` | Product suite that authorizes and owns the resource. |
| `owner_actor_id` | Accountable human or agent actor. It may not be blank. |
| `owner_task_id` | Card, workstream, or bounded purpose that created it. |
| `purpose` | Present reason the resource is needed. |
| `source_repository` | Canonical repository or Docker/Compose authority from which it derives. |
| `authority_root` | Absolute or suite-relative boundary allowed to manage it. |
| `base_sha` | Git revision used to create or build it. Record the source revision for Docker resources too. |
| `created_at` | ISO-8601 creation time. |
| `retention_class` | Bounded retention rule such as task, session, TTL, or explicit hold. |
| `expires_at` | ISO-8601 expiry when TTL-based; otherwise blank only when the trigger is event-based. |
| `cleanup_trigger` | Observable event that opens cleanup review. |
| `inventory_disposition` | Exactly one of the four inventory states below. |
| `terminal_disposition` | Blank only while active; required before the owning task closes. |
| `native_resource_id` | Git worktree path, Docker ID/name, mount identity, or lease identity. |
| `evidence_refs` | Read-back, retained ref, health check, or quarantine evidence. |
| `updated_at` | ISO-8601 time of the latest verified state. |

Use native labels in addition to the inventory where the platform supports them. Docker resources
must carry discoverable project, owner, task/purpose, base-SHA, creation, retention, and cleanup
labels. When a Docker resource type cannot carry all labels, the canonical inventory remains
mandatory and records its native ID.

## Worktree placement

All managed worktrees for a suite live under one hierarchy:

```text
.workspace/worktrees/<repo>/<card-or-purpose>
```

`<repo>` and `<card-or-purpose>` are stable, filesystem-safe identifiers. Do not create project
worktrees at drive roots, beside unrelated repositories, or in ad-hoc temporary folders. The
worktree contents are local and ignored by the primary checkout; `.workspace/resources.csv` is the
tracked lifecycle record.

## Read-only inventory and classification

Before any cleanup, establish the authoritative project roots and take a read-only baseline:

- actual free disk space and logical candidate sizes;
- `git worktree list --porcelain`, status, HEAD, branch, upstream and ahead/behind state;
- active processes, locks, mounts and shared paths;
- Docker containers, images, volumes, networks, build cache, Compose project labels and health;
- the lifecycle inventory and the owning cards or workstreams.

Classify every candidate into exactly one state:

| State | Meaning |
| --- | --- |
| `KEEP_ACTIVE` | Current task, active process, healthy runtime, or explicitly retained resource. |
| `REMOVE_PROVEN` | Clean, inactive, reproducible and deletion-safe with exact ownership and recovery evidence. |
| `QUARANTINE` | Unregistered residue or uncertain filesystem ownership that can be moved recoverably inside `.workspace/quarantine/<project>/<resource-id>`. |
| `HOLD_REVIEW` | Dirty, detached, unpushed, data-bearing, mounted, shared, locked, or authority-ambiguous. |

Name similarity, age, a dangling label, or a crossed TTL does not by itself prove removability. TTL
opens a cleanup review; it is not permission to destroy ambiguous data.

## Git removal contract

- Never remove a dirty, detached, unpushed, locked, shared, or authority-ambiguous worktree.
- Remove a registered worktree only with `git worktree remove <exact-path>` from its authoritative
  repository. Do not replace that operation with recursive filesystem deletion.
- Do not use `--force` unless the human owner explicitly authorizes that exact destructive target
  after its risk is shown.
- Before removal, capture HEAD, branch/ref, upstream and status. After removal, read back
  `git worktree list --porcelain` and prove the required branch/ref still exists.
- Unregistered residue may be quarantined recoverably. It is not silently promoted to
  `REMOVE_PROVEN`.

## Docker removal contract

- A Docker volume is never removable merely because it is dangling. Inspect identity, labels,
  mounts and data purpose. PostgreSQL, Redis, object-store or unknown data remains `HOLD_REVIEW`
  until ownership and disposal evidence are explicit.
- On a shared host, never use broad `docker system prune`. Select resources by exact ID and verified
  project/Compose labels. Cache-specific pruning is allowed only for reproducible cache inside the
  authorized scope.
- Mounted, shared, running, unhealthy-dependent, data-bearing or ownership-ambiguous resources are
  not removed.
- After a bounded Docker batch, read back containers, volumes, networks, mounts, Compose labels and
  the health of every protected running service.

## Bounded cleanup and authority

Full access removes repeated technical-access questions; it does not authorize deletion of an
ambiguous resource or anything outside the approved project boundary. Resolve every destructive
target to an absolute path and prove it lies inside the declared project-managed root. On Windows,
keep discovery, validation and mutation in one PowerShell flow; never pass a generated path list to
another shell.

Clean in small, reviewable batches. After each batch, verify:

1. actual free space, reported separately from logical candidate sizes;
2. Git worktree registration and preserved refs;
3. Docker inventory, mounts and protected-service health;
4. protected paths and current task resources;
5. inventory rows and terminal dispositions.

Stop on unexpected drift. A resource that cannot be proved safe moves to `HOLD_REVIEW`, not to a
larger or forced cleanup command.

## Terminalization

Cleanup review is triggered when a task ends, a TTL expires, a disk threshold is crossed, or before
another large environment is created. A task cannot reach terminal status while any worktree,
container, image, volume, network, build cache, temporary folder, mount, or lease it created lacks
an owner and terminal disposition.

The final record states whether the resource was removed, retained and transferred to a named
owner, or quarantined for a named review; it links the read-back evidence and the next trigger.
Passing automation is producer evidence. Material cleanup claims remain subject to independent
verification under the suite governance contract.
