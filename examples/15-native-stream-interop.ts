/**
 * 15 — Export a finite report through actual Web Streams.
 *
 * Run: bun examples/15-native-stream-interop.ts
 * No credentials, no inference, no Zod. The static report is explicitly application data.
 * Learn: from(ReadableStream), through(fresh TransformStream), Response, pipeTo(WritableStream),
 * native reader cleanup and single-use ownership. No SSE/token protocol is invented.
 */
import * as Streams from "../src/streams.ts";

export async function main() {
  const source = new ReadableStream<{ id: string; status: string }>({
    start(controller) {
      controller.enqueue({ id: "CASE-1", status: "review" });
      controller.enqueue({ id: "CASE-2", status: "approved" });
      controller.close();
    },
  });
  const stream = Streams.from(source).through(
    () =>
      new TransformStream<{ id: string; status: string }, Uint8Array>({
        transform(row, controller) {
          controller.enqueue(new TextEncoder().encode(`${JSON.stringify(row)}\n`));
        },
      }),
  );
  const response = new Response(stream.toReadable(), {
    headers: { "content-type": "application/x-ndjson; charset=utf-8" },
  });
  const text = await response.text(); // This finite tutorial response is safe to materialize.

  const saved: string[] = [];
  await Streams.from(text.trim().split("\n")).pipeTo(
    new WritableStream<string>({
      write(line) {
        saved.push(line);
      }, // A real application could use an async file/socket sink.
    }),
  );

  // Native escape hatch; each reader owns its lock and cleanup.
  const reader = Streams.from(saved).toReadable().getReader();
  try {
    console.log("First persisted report line", (await reader.read()).value);
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  // Do not consume `stream` again: its original native source was single-use.
  return { contentType: response.headers.get("content-type"), saved };
}
if (import.meta.main) console.log(await main());
