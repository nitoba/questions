import {
  Streams,
  SchemaValidationError,
  UncertainDecision,
  type QuestionsClient,
} from "../../src/index.ts";
import { failureKind } from "../shared/runtime.ts";
import { assessmentSchema, shipmentInput, SCHEMA_VERSION } from "./domain.ts";
import { readLines } from "./input.ts";
import type { DeskStore } from "./store.ts";

/** Ingest a real NDJSON file. Each validated record is committed independently. */
export async function ingest(
  store: DeskStore,
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
) {
  let inserted = 0;
  let duplicate = 0;
  for await (const line of readLines(body, signal)) {
    const input = shipmentInput.parse(JSON.parse(line));
    if (store.ingest(input)) inserted++;
    else duplicate++;
  }
  return { inserted, duplicate };
}

/**
 * One non-streaming business operation, also reused by the stream worker.
 * Confident and uncertain results BOTH require explicit human review.
 */
export async function assessOne(
  store: DeskStore,
  client: QuestionsClient,
  id: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (!store.claim(id)) return { id, outcome: "skipped" as const };
  let operationId: string | undefined;
  try {
    const input = shipmentInput.parse(JSON.parse(store.get(id).input_json));
    // Only the relevant context is sent, not review audit records or outbox delivery details.
    const run = await client
      .about({
        carrier: input.carrier,
        notes: input.notes,
        daysLate: input.daysLate,
        priority: input.priority,
      })
      .run(assessmentSchema, {
        signal,
        hooks: {
          onEvaluate: (event) => {
            operationId = event.operationId;
          },
        },
      });
    // Business prioritization uses trusted numeric data in addition to the semantic judgment.
    const expedited = input.priority === "priority" && input.daysLate >= 3;
    store.finish(id, {
      schemaVersion: SCHEMA_VERSION,
      operationId: run.operationId,
      disposition: "proposed",
      value: run.value,
      expedited,
      diagnostics: run.diagnostics,
      evidence: run.evidence,
    });
    return { id, outcome: "review" as const };
  } catch (error) {
    if (
      !signal.aborted &&
      (error instanceof UncertainDecision || error instanceof SchemaValidationError)
    ) {
      store.finish(id, {
        schemaVersion: SCHEMA_VERSION,
        operationId,
        disposition: "needs-human-analysis",
        kind: failureKind(error),
        diagnostics: error.diagnostics,
      });
      return { id, outcome: "review" as const };
    }
    store.fail(id, failureKind(error));
    if (signal.aborted || failureKind(error) === "application") throw error;
    return { id, outcome: "failed" as const };
  }
}

/** Bound work per invocation and per stage. A failed upstream does not discard successful cases. */
export async function processPending(
  store: DeskStore,
  client: QuestionsClient,
  signal: AbortSignal,
  limit = 20,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new RangeError("limit must be 1..100");
  const worker = client.extend({ defaults: { confidence: 0.65, timeout: "30 seconds" } });
  return Streams.from(store.queued(limit))
    .map((id, { signal: itemSignal }) => assessOne(store, worker, id, itemSignal), {
      concurrency: 2,
      ordered: false,
    })
    .toArray({ signal, maxItems: limit });
}

/** Read persisted rows in pages. Exporting a report never starts inference again. */
export function report(store: DeskStore, signal?: AbortSignal): ReadableStream<Uint8Array> {
  return Streams.defer(() =>
    (async function* () {
      let cursor = "";
      while (true) {
        const page = store.list(cursor, 50);
        if (!page.length) return;
        for (const row of page) {
          yield { id: row.id, state: row.state, version: row.version, updatedAt: row.updated_at };
        }
        cursor = page[page.length - 1]!.id;
      }
    })(),
  )
    .through(
      () =>
        new TransformStream<
          { id: string; state: string; version: number; updatedAt: string },
          Uint8Array
        >({
          transform(value, controller) {
            controller.enqueue(new TextEncoder().encode(`${JSON.stringify(value)}\n`));
          },
        }),
    )
    .toReadable(signal ? { signal } : {});
}
