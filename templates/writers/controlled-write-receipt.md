# Controlled-write receipt

> Catalog: `../config/operating-model.yaml`

- Receipt ID: `<identifier_patterns.write_receipt>`
- Manifest / event IDs:
- Status: `<statuses.write_receipt>`
- Writer role / actor: `RB-10 / <ACTOR_ID>`
- Target alias / environment:
- Started / completed:
- Canonical revision:

## Preconditions

| Record key | Field | Expected old value | Observed old value | Match |
| --- | --- | --- | --- | --- |
| | | | | |

## Write

- Authorized bounded range:
- Records attempted / changed / unchanged:
- Exact failed records:
- Failure and recovery:

## Complete read-back

| Record key | Field | Expected new value | Primary read | Independent read | Match |
| --- | --- | --- | --- | --- | --- |
| | | | | | |

- Whole affected record or tab compared:
- Header or schema drift:
- Unexpected differences:

## Replay and rollback

- Idempotent replay attempted at:
- Replay writes: `<must be 0 for replay_verified>`
- Rollback plan reference:
- Rollback tested or reason not tested:

## Verification

- Receipt evidence references:
- Producer / writer actor ID:
- Independent verifier role / actor: `RB-12 / <must differ>`
- QC record ID / disposition:

## Security declaration

No credential value, token, cookie, private key, private URL, personal data, or production payload
is included. Any runtime access appears only as an approved store alias.
