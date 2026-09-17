# Fulfillment exception desk

A runnable, multi-file operations application built on Questions. It ingests shipment
exceptions, proposes structured assessments, sends uncertain decisions to human review,
and delivers **only operator-approved** work notifications.

This is not an autonomous refund or carrier-management agent. The sample shipments are
fictional, but storage, HTTP, cancellation, processing and delivery are real. The model
is selected explicitly and uses your actual provider account when you run `process` or
`assess`. Test fixtures exist only in `examples/tests`.

## The workflow

```text
NDJSON file or POST /cases
  -> ordinary Zod input validation
  -> SQLite queued case (duplicate ID checked)
  -> atomic claim
  -> Questions run(Zod assessment)       <-- potentially paid inference
  -> persist value + evidence + diagnostics
  -> human review (including uncertain results)
  -> authenticated operator approval with expectedVersion
  -> one transaction: approval audit + case state + outbox event
  -> explicit delivery command
  -> idempotent notification receiver
```

The non-streaming `assessOne()` service is reused by a bounded `Streams.map()` worker.
NDJSON input and output use native byte streams. HTTP review operations are plain
async/await and never call a model. Domain transforms are pure; database writes and
business approvals are outside Zod callbacks.

## Files and reading order

| File                                       | Responsibility                                                                                           |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------- |
| [domain.ts](domain.ts)                     | Input validation, finite decision schema, output transform and operator commands                         |
| [store.ts](store.ts)                       | Real SQLite tables, short atomic transitions, version checking, audit, outbox and receiver deduplication |
| [input.ts](input.ts)                       | Bounded UTF-8/NDJSON parsing and request-body limits                                                     |
| [service.ts](service.ts)                   | Non-streaming assessment, bounded processing and paginated streaming reports                             |
| [delivery.ts](delivery.ts)                 | Explicit outbox delivery, timeout, stable idempotency keys and acknowledgement                           |
| [http.ts](http.ts)                         | Framework-neutral `Request -> Response` review API                                                       |
| [main.ts](main.ts)                         | Bun CLI/server hosting and graceful interruption                                                         |
| [sample.ndjson](sample.ndjson)             | Four fictional input records                                                                             |
| [tests](../tests/fulfillment-desk.test.ts) | Executable storage, HTTP and recovery contracts                                                          |

No extra database installation is needed. The host uses
[Bun's SQLite driver](https://bun.com/docs/runtime/sqlite). SQLite transactions are synchronous;
network waits do not occur inside them.

## 1. Inspect and ingest without a model key

From the repository root:

```sh
bun install --frozen-lockfile
bun examples/16-fulfillment-desk/main.ts --help
bun examples/16-fulfillment-desk/main.ts ingest examples/16-fulfillment-desk/sample.ndjson
bun examples/16-fulfillment-desk/main.ts report
```

On a fresh database, ingestion reports `{ inserted: 4, duplicate: 0 }` and the report shows
four `queued` cases. Running ingestion again reports four duplicates without changing the
stored data. Reusing an ID with different input is a conflict, not a silent update.

The default database is `.data/fulfillment-desk.sqlite`, outside the examples source tree
and ignored by Git. Set `DESK_DB` to use another path. Back it up before adapting the schema.

Intake commits **one record at a time**. If line 8 is invalid, lines 1-7 stay committed.
Correct the file and rerun it; identical records are deduplicated. The importer enforces a
1 MiB total input budget, 16 KiB-ish character limit per line, strict UTF-8, and bounded
domain fields. Split larger files deliberately instead of removing the limits.

## 2. Assess queued cases

```sh
export TYPESAFE_API_KEY='your-own-key'
bun examples/16-fulfillment-desk/main.ts process 20
```

Or choose Gateway explicitly:

```sh
export QUESTIONS_PROVIDER=vercel
export AI_GATEWAY_API_KEY='your-own-key'
bun examples/16-fulfillment-desk/main.ts process 20
```

`process` selects at most 20 queued cases by default (maximum 100), claims each atomically
and evaluates with concurrency 2. Each case has a 30-second operation budget and a 0.65
confidence minimum. Native/Gateway confidence metrics differ: validate thresholds with
your own representative dataset instead of assuming cross-provider calibration.

One accepted assessment stores a schema-version label, operation ID, parsed output,
reported usage, evidence and field diagnostics. No real tracking data is fabricated or
fetched behind the scenes: the assessment is based on the supplied notes and fields.

Confident results propose a fixed action. Uncertain or schema-rejected results also
enter `review`, but without inventing an accepted output. Both need an operator.
Transport/protocol failures enter `failed`; the command returns nonzero if any case failed.

To assess a single queued case without any stream pipeline:

```sh
bun examples/16-fulfillment-desk/main.ts assess SHIP-001
```

A case that is not queued is skipped. Re-running `process` after completing all input does
not repeat inference. Stream concurrency is a per-process bound, not a global distributed
rate limiter.

## 3. Start the review API

In a second terminal, using the same working directory / `DESK_DB`:

```sh
export DESK_TOKEN="$(bun -e 'console.log(crypto.randomUUID())')"
bun examples/16-fulfillment-desk/main.ts serve
```

Copy the same token securely into the shell used for review and delivery. Do not create a
different token in each shell. The API binds to **127.0.0.1** by default. Except for `/health`,
every endpoint requires `Authorization: Bearer ...`.

```sh
curl -fsS -H "Authorization: Bearer $DESK_TOKEN" \
  http://127.0.0.1:3131/cases

curl -fsS -H "Authorization: Bearer $DESK_TOKEN" \
  http://127.0.0.1:3131/cases/SHIP-001
```

The list response contains summaries and a `nextCursor` when another page may exist; pass
it as `?after=...`. The detail response intentionally contains stored input, evidence and
diagnostics for operator review. Treat the database and detail endpoint as sensitive.

### Approve a specific action

Read the current `version` first. The example below uses version 2, as expected after one
completed assessment on a fresh case; use the actual returned version.

```sh
curl -fsS -X POST \
  -H "Authorization: Bearer $DESK_TOKEN" \
  -H "Content-Type: application/json" \
  http://127.0.0.1:3131/cases/SHIP-001/review \
  --data '{
    "reviewId": "review-ship-001",
    "expectedVersion": 2,
    "decision": "approve",
    "action": "request_carrier_update",
    "reviewer": "Warehouse operator",
    "note": "Checked the carrier record and confirmed that an update is needed."
  }'
```

Other allowed actions are `verify_address`, `inspect_damage` and `manual_investigation`.
The operator can override the proposed action after checking the evidence.
A dismissal uses `"decision": "dismiss"` and **omits** `action`.

A stale version or a case outside `review` produces HTTP 409. The exact same command with
the same `reviewId` is idempotent; reusing that ID with different data is a conflict.
The case transition, review audit and outbox insertion happen in one transaction.
There is no moment where approval commits but its outbox event is lost.

The shared token authorizes this local demonstration; `reviewer` is a caller-supplied label,
not a verified person identity. Replace this with authenticated identities and roles before
using it for real operator accountability or exposing it beyond loopback.

## 4. Deliver approved notifications

The included `/notifications` endpoint is a real local receiver that persists receipts;
it does not contact a customer or mutate a carrier system.

```sh
WEBHOOK_URL=http://127.0.0.1:3131/notifications \
WEBHOOK_TOKEN="$DESK_TOKEN" \
bun examples/16-fulfillment-desk/main.ts deliver
```

After one approval, the first delivery normally reports one sent event. Another invocation
has no pending events. Unapproved and dismissed cases never create a notification.

Each event uses a stable `Idempotency-Key`. The receiver atomically checks the key and its
payload. A different payload with the same key is a conflict. A repeated identical event
returns success without creating another receipt.

A send uses a 5-second budget. Failed sends remain retryable on the **next explicit command**,
up to five attempts, with at most 50 events selected per invocation. There is no unbounded
background retry loop. Credentials are sent only to the explicitly configured target;
redirects are prohibited and non-loopback targets require HTTPS.

**Delivery is at least once, not exactly once.** If the receiver commits a receipt but its
response is lost, the sender cannot know that delivery succeeded. It will retry using the
same event ID; persistent receiver deduplication makes that safe for this receiver.
A third-party webhook must implement equivalent semantics.

## 5. Export stored results without rerunning the model

```sh
bun examples/16-fulfillment-desk/main.ts report > /tmp/desk-report.ndjson

curl -fsS -H "Authorization: Bearer $DESK_TOKEN" \
  http://127.0.0.1:3131/report.ndjson
```

The report uses paginated reads and native byte streams. It contains ID, state, version and
update time, not original notes or model judgments. HTTP cancellation closes its reader.
It is a live paginated view, **not** a transactionally consistent snapshot of concurrent edits.

## 6. Failure and recovery exercises

Stop all old `process`/`assess` workers before recovering an abandoned case:

```sh
bun examples/16-fulfillment-desk/main.ts requeue SHIP-001
bun examples/16-fulfillment-desk/main.ts assess SHIP-001
```

Only `failed` or abandoned `evaluating` cases can be requeued. A completed review cannot be
silently reassessed. An interrupted inference may already have been accepted/billed upstream;
a new assessment can incur another charge.

A process crash can similarly leave a notification in `sending`. After stopping old senders:

```sh
bun examples/16-fulfillment-desk/main.ts recover-delivery SHIP-001:review-ship-001
bun examples/16-fulfillment-desk/main.ts deliver
```

The attempt ceiling remains in place. A record exhausted at five attempts needs explicit
operator investigation; recovery is not an automatic way to bypass that ceiling.

No leases, fencing tokens, durable workflow engine or background scheduler are claimed here.
Atomic claims prevent ordinary competing workers from selecting the same queued record, but
**manual recovery while an old worker is still alive is unsupported**. SIGINT/SIGTERM abort
cooperative work and mark claimed failures; a hard crash requires the manual recovery above.

## Tests and expected guarantees

```sh
bun test examples/tests/fulfillment-desk.test.ts
```

The tests use actual SQLite files/reopening, HTTP over a real local socket and the same
application modules as the CLI. Only model responses and a deliberate lost acknowledgement
are controlled fixtures. Covered scenarios include ingestion duplicate/conflict, partial
progress, competing claims, uncertainty, transport failure, cancellation, stale approval,
atomic outbox, authentication, byte limits, report streaming and redelivery deduplication.

The example is a complete runnable application slice, not a production-readiness claim.
Before production, add schema migrations, verified operator identity/roles, retention and
encryption for sensitive evidence, representative model evaluations, distributed leases and
global rate limiting where needed, delivery scheduling/alerts, backup/restore procedures and
provider-specific idempotency support. Do not replace these boundaries with additional prompts.
