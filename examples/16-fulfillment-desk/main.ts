/**
 * A runnable operations application. Start with README.md in this directory.
 * Bun-only host adapters live in this EXAMPLE, never in Questions' portable src/.
 * No paid work occurs on import, ingest, review, serve, report or deliver.
 */
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { DeskStore } from "./store.ts";
import { ingest, assessOne, processPending, report } from "./service.ts";
import { deliver } from "./delivery.ts";
import { handler } from "./http.ts";
import { cli, liveClient, required } from "../shared/runtime.ts";

const usage = `Usage: bun examples/16-fulfillment-desk/main.ts <command>
  ingest <path.ndjson>     Persist input; identical IDs are deduplicated
  process [limit=20]       Assess queued cases with concurrency 2 (paid)
  assess <case-id>         One ordinary async/await assessment (paid)
  requeue <case-id>        Recover failed/abandoned work AFTER stopping old workers
  recover-delivery <id>   Recover an abandoned sending event AFTER stopping old senders
  report                  Stream persisted status records to stdout (no inference)
  deliver                 Send approved outbox records to WEBHOOK_URL using WEBHOOK_TOKEN
  serve                   Start the authenticated loopback review API on DESK_PORT (default 3131)
Environment: DESK_DB (default .data/fulfillment-desk.sqlite), DESK_TOKEN.
Paid commands use QUESTIONS_PROVIDER=typesafe|vercel|generative (default typesafe).
Generative also needs GENERATIVE_PROVIDER=google|anthropic|openai|gateway, GENERATIVE_MODEL,
and that vendor's API key. See examples/README.md. Other commands need no model configuration.`;

export async function main(args = process.argv.slice(2)): Promise<void> {
  const command = args[0];
  if (!command || command === "--help") {
    console.log(usage);
    return;
  }
  if (
    ![
      "ingest",
      "process",
      "assess",
      "requeue",
      "recover-delivery",
      "report",
      "deliver",
      "serve",
    ].includes(command)
  )
    throw new Error(usage);
  const file = process.env.DESK_DB ?? ".data/fulfillment-desk.sqlite";
  await mkdir(dirname(file), { recursive: true });
  const store = new DeskStore(file);
  const controller = new AbortController();
  const stop = () => controller.abort(new DOMException("Operator interrupted work", "AbortError"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    switch (command) {
      case "ingest":
        if (!args[1]) throw new Error("Provide an NDJSON file path");
        console.log(
          JSON.stringify(await ingest(store, Bun.file(args[1]).stream(), controller.signal)),
        );
        break;
      case "process":
      case "assess": {
        const client = (await liveClient()).extend({
          defaults: { timeout: "30 seconds", confidence: 0.65 },
          hooks: {
            onDecision: ({ operationId, elapsedMs, evaluationCount }) => {
              console.error({ operationId, elapsedMs, evaluationCount });
            },
            onError: ({ operationId, stage, kind }) => {
              console.error({ operationId, stage, kind });
            },
          },
        });
        if (command === "assess" && !args[1]) throw new Error("Provide a case ID");
        const results =
          command === "assess"
            ? [await assessOne(store, client, args[1]!, controller.signal)]
            : await processPending(store, client, controller.signal, Number(args[1] ?? 20));
        console.log(JSON.stringify(results));
        if (results.some((result) => result.outcome === "failed")) process.exitCode = 1;
        break;
      }
      case "requeue":
        if (!args[1]) throw new Error("Provide a case ID");
        store.requeue(args[1]);
        console.log(
          "Requeued. Stop all old workers before recovery; another inference can be billed.",
        );
        break;
      case "recover-delivery":
        if (!args[1]) throw new Error("Provide an outbox event ID");
        store.recoverDelivery(args[1]);
        console.log("Recovered. Stop old senders first; receiver deduplication is required.");
        break;
      case "report":
        for await (const bytes of report(store, controller.signal)) {
          // Await filesystem writes rather than scheduling unbounded stdout promises.
          await Bun.write(Bun.stdout, bytes);
        }
        break;
      case "deliver": {
        const result = await deliver(
          store,
          required("WEBHOOK_URL"),
          required("WEBHOOK_TOKEN"),
          controller.signal,
        );
        console.log(JSON.stringify(result));
        if (result.failed) process.exitCode = 1;
        break;
      }
      case "serve": {
        const port = Number(process.env.DESK_PORT ?? "3131");
        if (!Number.isInteger(port) || port < 0 || port > 65535)
          throw new RangeError("Invalid DESK_PORT");
        const server = Bun.serve({
          hostname: "127.0.0.1",
          port,
          fetch: handler(store, required("DESK_TOKEN")),
        });
        console.error(`Review API listening on ${server.url}`);
        try {
          await new Promise<void>((resolve) => {
            if (controller.signal.aborted) resolve();
            else controller.signal.addEventListener("abort", () => resolve(), { once: true });
          });
        } finally {
          await server.stop(true);
        }
        break;
      }
    }
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    store.close();
  }
}
if (import.meta.main) await cli(() => main());
