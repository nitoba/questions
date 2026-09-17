import { Streams } from "../src/index.ts";
import type { QuestionsClient } from "../src/index.ts";

/** A framework-neutral streaming HTTP response: one JSON decision per input, not token streaming. */
export function triageResponse(client: QuestionsClient, tickets: AsyncIterable<string>, signal: AbortSignal): Response {
  const bytes = Streams.from(tickets)
    .map(async (ticket, { signal: itemSignal, index }) => ({
      index, urgent: await client.about(ticket).is("Does this require urgent attention?", { signal: itemSignal }),
    }), { concurrency: 4 })
    .through(() => new TransformStream<{ index: number; urgent: boolean }, Uint8Array>({
      transform(event, controller) {
        controller.enqueue(new TextEncoder().encode(`${JSON.stringify(event)}\n`));
      },
    }))
    .toReadable({ signal });
  return new Response(bytes, { headers: { "content-type": "application/x-ndjson; charset=utf-8" } });
}
