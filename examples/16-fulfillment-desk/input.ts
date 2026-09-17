import { DeskError } from "./domain.ts";

/**
 * Read actual byte streams with strict UTF-8 and explicit limits.
 * A file can be ingested incrementally; duplicate-safe storage makes partial-import recovery explicit.
 */
export async function* readLines(
  body: ReadableStream<Uint8Array>,
  signal: AbortSignal,
  maxBytes = 1_048_576,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  const cancel = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      signal.throwIfAborted();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new DeskError(413, "Input exceeds byte limit");
      pending += decoder.decode(next.value, { stream: true });
      let end: number;
      while ((end = pending.indexOf("\n")) !== -1) {
        const line = pending.slice(0, end).trim();
        if (line.length > 16_384) throw new DeskError(413, "Input line too long");
        pending = pending.slice(end + 1);
        if (line) yield line;
      }
      if (pending.length > 16_384) throw new DeskError(413, "Input line too long");
    }
    pending += decoder.decode();
    if (pending.trim()) yield pending.trim();
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Requests are bounded by actual bytes, not by trusting Content-Length. */
export async function requestJson(request: Request): Promise<unknown> {
  if (!request.body) throw new DeskError(400, "A JSON body is required");
  const lines: string[] = [];
  try {
    for await (const line of readLines(request.body, request.signal, 16_384)) lines.push(line);
  } catch (error) {
    if (error instanceof DeskError || request.signal.aborted) throw error;
    throw new DeskError(400, "Unreadable UTF-8 body");
  }
  try {
    return JSON.parse(lines.join("\n"));
  } catch {
    throw new DeskError(400, "Invalid JSON");
  }
}
