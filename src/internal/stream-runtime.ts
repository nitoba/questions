import type { Awaitable } from "../types.ts";
import { abortable, cancellation } from "./abort.ts";

export type Source<T> = ReadableStream<T> | Iterable<T> | AsyncIterable<T>;
export type Factory<T> = (signal: AbortSignal) => ReadableStream<T>;

export function isReadable<T>(source: Source<T>): source is ReadableStream<T> {
  return typeof (source as ReadableStream<T>).getReader === "function";
}

/** Own a reader and its signal, acquiring the underlying stream on the first pull only. */
export function owned<T>(factory: Factory<T>, parent?: AbortSignal): ReadableStream<T> {
  const scope = cancellation(parent);
  let reader: ReadableStreamDefaultReader<T> | undefined;
  let ended = false;
  let cleaned: Promise<void> | undefined;
  let output: ReadableStreamDefaultController<T>;
  const cleanup = (reason?: unknown): Promise<void> => {
    if (cleaned) return cleaned;
    scope.signal.removeEventListener("abort", onAbort);
    scope.dispose();
    cleaned = (async () => {
      if (reader) {
        try {
          await reader.cancel(reason);
        } catch {
          /* Preserve the primary failure. */
        } finally {
          reader.releaseLock();
        }
      }
    })();
    return cleaned;
  };
  const onAbort = () => {
    if (ended) return;
    ended = true;
    output.error(scope.signal.reason);
    void cleanup(scope.signal.reason);
  };
  return new ReadableStream<T>(
    {
      start(controller) {
        output = controller;
        if (scope.signal.aborted) onAbort();
        else scope.signal.addEventListener("abort", onAbort, { once: true });
      },
      async pull(controller) {
        try {
          scope.signal.throwIfAborted();
          reader ??= factory(scope.signal).getReader();
          const next = await reader.read();
          if (ended) return;
          if (next.done) {
            ended = true;
            scope.signal.removeEventListener("abort", onAbort);
            scope.dispose();
            reader.releaseLock();
            reader = undefined;
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          if (!ended) {
            ended = true;
            controller.error(error);
            scope.controller.abort(error);
            await cleanup(error);
          }
        }
      },
      cancel(reason) {
        ended = true;
        scope.controller.abort(reason);
        return cleanup(reason);
      },
    },
    { highWaterMark: 0 },
  );
}

/** Adapt one source without prefetching. Iterators remain cooperative on cancellation. */
export function sourceStream<T>(source: Source<T>, signal: AbortSignal): ReadableStream<T> {
  if (isReadable(source)) return source;
  const iterator: Iterator<T> | AsyncIterator<T> =
    typeof (source as AsyncIterable<T>)[Symbol.asyncIterator] === "function"
      ? (source as AsyncIterable<T>)[Symbol.asyncIterator]()
      : (source as Iterable<T>)[Symbol.iterator]();
  let ended = false;
  const stop = () => {
    if (ended) return;
    ended = true;
    // A generator awaiting an unrelated promise cannot be forcibly interrupted.
    // Request cleanup and observe rejection without blocking cancellation on arbitrary user code.
    try {
      if (iterator.return) void Promise.resolve(iterator.return()).catch(() => {});
    } catch {
      /* Do not replace the primary error with an iterator cleanup error. */
    }
  };
  return new ReadableStream<T>(
    {
      async pull(controller) {
        try {
          const next = await abortable(iterator.next(), signal);
          if (ended) return;
          if (next.done) {
            ended = true;
            controller.close();
          } else controller.enqueue(next.value);
        } catch (error) {
          stop();
          throw error;
        }
      },
      cancel: stop,
    },
    { highWaterMark: 0 },
  );
}

interface Slot<T> {
  ready: boolean;
  value?: T;
}

/** Bounded window: running tasks AND completed, not-yet-consumed outputs count toward capacity. */
export function concurrent<T, R>(
  source: Factory<T>,
  mapper: (value: T, signal: AbortSignal, index: number) => Awaitable<R>,
  concurrency: number,
  ordered: boolean,
  parent: AbortSignal,
): ReadableStream<R> {
  const scope = cancellation(parent);
  const slots = new Map<number, Slot<R>>();
  const ready: number[] = [];
  let reader: ReadableStreamDefaultReader<T> | undefined;
  let inputDone = false;
  let ended = false;
  let pumping = false;
  let issued = 0;
  let nextOutput = 0;
  let wake: (() => void) | undefined;
  let output: ReadableStreamDefaultController<R>;
  let cleanupPromise: Promise<void> | undefined;
  const notify = () => {
    const resolve = wake;
    wake = undefined;
    resolve?.();
  };
  const cleanup = (reason?: unknown): Promise<void> => {
    if (cleanupPromise) return cleanupPromise;
    scope.dispose();
    slots.clear();
    ready.length = 0;
    cleanupPromise = (async () => {
      if (reader) {
        try {
          await reader.cancel(reason);
        } catch {
          /* Preserve primary error. */
        } finally {
          reader.releaseLock();
        }
      }
    })();
    return cleanupPromise;
  };
  const fail = (error: unknown) => {
    if (ended) return;
    ended = true;
    output.error(error);
    scope.controller.abort(error);
    notify();
    void cleanup(error);
  };
  const pump = async () => {
    if (pumping || inputDone || ended) return;
    pumping = true;
    try {
      reader ??= source(scope.signal).getReader();
      while (!ended && !inputDone && slots.size < concurrency) {
        const item = await reader.read();
        if (ended) break;
        if (item.done) {
          inputDone = true;
          notify();
          break;
        }
        const index = issued++;
        const slot: Slot<R> = { ready: false };
        slots.set(index, slot);
        // Handle every rejection at launch time, including failures in later ordered slots.
        void Promise.resolve()
          .then(() => {
            scope.signal.throwIfAborted();
            return mapper(item.value, scope.signal, index);
          })
          .then((value) => {
            if (ended) return;
            slot.ready = true;
            slot.value = value;
            if (!ordered) ready.push(index);
            notify();
          }, fail);
      }
    } catch (error) {
      fail(error);
    } finally {
      pumping = false;
    }
  };
  return new ReadableStream<R>(
    {
      start(controller) {
        output = controller;
      },
      async pull(controller) {
        void pump();
        while (!ended) {
          const key = ordered ? nextOutput : ready[0];
          const slot = key === undefined ? undefined : slots.get(key);
          if (slot?.ready) {
            slots.delete(key!);
            if (ordered) nextOutput++;
            else ready.shift();
            controller.enqueue(slot.value as R);
            // Refill only when the consumer asks for another output, not on task completion.
            return;
          }
          if (inputDone && slots.size === 0) {
            ended = true;
            scope.dispose();
            reader?.releaseLock();
            reader = undefined;
            controller.close();
            return;
          }
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
      cancel(reason) {
        ended = true;
        scope.controller.abort(reason);
        notify();
        return cleanup(reason);
      },
    },
    { highWaterMark: 0 },
  );
}
