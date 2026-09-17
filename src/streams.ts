import type { Awaitable, CallContext, RunOptions } from "./types.ts";
import { ValidationError } from "./errors.ts";
import { integer } from "./internal/validation.ts";
import { abortable } from "./internal/abort.ts";
import { concurrent, isReadable, owned, sourceStream } from "./internal/stream-runtime.ts";
import type { Factory, Source } from "./internal/stream-runtime.ts";

export type { Source } from "./internal/stream-runtime.ts";
/** Context associated with one input item; index always refers to this operator's input order. */
export interface ItemContext extends CallContext { readonly index: number }
/** Concurrency bounds running tasks plus completed outputs waiting for consumption. */
export interface MapOptions {
  readonly concurrency?: number;
  /** Preserve input order by default. false emits in completion order. */
  readonly ordered?: boolean;
}
/** Materialization options. maxItems rejects instead of silently truncating a result. */
export interface CollectOptions extends RunOptions { readonly maxItems?: number }

/**
 * A lazy description built on native Web Streams. Not a subclass of ReadableStream.
 * Every terminal operation creates a fresh run; no caching, replay, or implicit tee.
 * Use toReadable() or through() when native APIs are the better abstraction.
 */
export class Stream<T> implements AsyncIterable<T> {
  readonly #factory: Factory<T>;
  constructor(factory: Factory<T>) { this.#factory = factory; }

  /**
   * Open a fresh native stream without pulling any items. Canceling its reader aborts the run.
   * @example
   * await pipeline.toReadable({ signal }).pipeTo(destination);
   */
  toReadable(options: RunOptions = {}): ReadableStream<T> { return owned(this.#factory, options.signal); }

  /**
   * Transform items with bounded concurrency. Defaults to sequential, ordered evaluation.
   * Failures abort sibling callbacks and cancel upstream; callbacks must cooperate with signal.
   * @example
   * const assessed = Streams.from(tickets).map(
   *   (ticket, { signal }) => client.about(ticket).ask(batch, { signal }),
   *   { concurrency: 4 },
   * );
   */
  map<R>(mapper: (value: T, context: ItemContext) => Awaitable<R>, options: MapOptions = {}): Stream<R> {
    const capacity = integer(options.concurrency ?? 1, 1, "concurrency");
    return new Stream((signal) => concurrent(
      (parent) => this.toReadable({ signal: parent }),
      (value, itemSignal, index) => mapper(value, { signal: itemSignal, index }),
      capacity, options.ordered ?? true, signal,
    ));
  }

  /** Narrow with a synchronous type guard, preserving the narrowed element type. */
  filter<S extends T>(predicate: (value: T, context: ItemContext) => value is S): Stream<S>;
  /** Keep values accepted by an asynchronous predicate, with sequential evaluation. */
  filter(predicate: (value: T, context: ItemContext) => Awaitable<boolean>): Stream<T>;
  filter(predicate: (value: T, context: ItemContext) => Awaitable<boolean>): Stream<T> {
    return this.through((signal) => {
      let index = 0;
      return new TransformStream<T, T>({
        async transform(value, controller) {
          if (await abortable(predicate(value, { signal, index: index++ }), signal)) controller.enqueue(value);
        },
      });
    });
  }

  /** Observe each item sequentially without changing its value. Callback failures stop the stream. */
  tap(effect: (value: T, context: ItemContext) => Awaitable<unknown>): Stream<T> {
    return this.map(async (value, context) => { await effect(value, context); return value; });
  }

  /**
   * Emit accumulated state after every input. A seed factory isolates mutable state between runs.
   * The seed itself is not emitted. Return immutable snapshots when retaining earlier outputs.
   */
  scan<S>(seed: () => S, reducer: (state: S, value: T, context: ItemContext) => Awaitable<S>): Stream<S> {
    return this.through((signal) => {
      let state = seed();
      let index = 0;
      return new TransformStream<T, S>({
        async transform(value, controller) {
          state = await abortable(reducer(state, value, { signal, index: index++ }), signal);
          controller.enqueue(state);
        },
      });
    });
  }

  /**
   * Advance local state and emit zero or more events per item. State is never shared across runs.
   * Useful for sticky escalation and other state machines over semantic decisions.
   */
  mapAccum<S, R>(seed: () => S,
    step: (state: S, value: T, context: ItemContext) => Awaitable<readonly [S, readonly R[]]>,
  ): Stream<R> {
    return this.through((signal) => {
      let state = seed();
      let index = 0;
      return new TransformStream<T, R>({
        async transform(value, controller) {
          const [next, events] = await abortable(step(state, value, { signal, index: index++ }), signal);
          state = next;
          for (const event of events) controller.enqueue(event);
        },
      });
    });
  }

  /** Group at most size adjacent items. Flush the final, possibly smaller batch on normal EOF. */
  batch(size: number): Stream<readonly T[]> {
    integer(size, 1, "batch.size");
    return this.through(() => {
      let pending: T[] = [];
      return new TransformStream<T, readonly T[]>({
        transform(value, controller) {
          pending.push(value);
          if (pending.length === size) { controller.enqueue(pending); pending = []; }
        },
        flush(controller) { if (pending.length > 0) controller.enqueue(pending); },
      });
    });
  }

  /** Take at most count items, then cancel upstream. Zero does not acquire the source. */
  take(count: number): Stream<T> {
    integer(count, 0, "take.count");
    return count === 0 ? from<T>([]) : this.#until((_, { index }) => index + 1 >= count, true);
  }

  /** Stop after the first matching item, including it in the output (inclusive semantics). */
  takeUntil(predicate: (value: T, context: ItemContext) => Awaitable<boolean>): Stream<T> {
    return this.#until(predicate, true);
  }

  /** Stop before the first rejected item, excluding it from the output. */
  takeWhile(predicate: (value: T, context: ItemContext) => Awaitable<boolean>): Stream<T> {
    return this.#until(async (value, context) => !await predicate(value, context), false);
  }

  #until(predicate: (value: T, context: ItemContext) => Awaitable<boolean>, inclusive: boolean): Stream<T> {
    return new Stream((signal) => {
      const reader = this.toReadable({ signal }).getReader();
      let index = 0;
      let ended = false;
      const stop = async (reason?: unknown) => {
        if (ended) return;
        ended = true;
        try { await reader.cancel(reason); } finally { reader.releaseLock(); }
      };
      return new ReadableStream<T>({
        async pull(controller) {
          const next = await reader.read();
          if (next.done) { await stop(); controller.close(); return; }
          const matches = await abortable(predicate(next.value, { signal, index: index++ }), signal);
          if (!matches || inclusive) controller.enqueue(next.value);
          if (matches) { await stop(); controller.close(); }
        },
        cancel: stop,
      }, { highWaterMark: 0 });
    });
  }

  /**
   * Apply a native TransformStream. The factory is called once per run, avoiding reused locks/state.
   * Native transforms choose their own queue strategies; custom fan-out may buffer multiple outputs.
   * @example
   * const bytes = pipeline.through(() => new TransformStream({
   *   transform(value, controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n")); },
   * }));
   */
  through<R>(factory: (signal: AbortSignal) => TransformStream<T, R>): Stream<R> {
    return new Stream((signal) => this.toReadable({ signal }).pipeThrough(factory(signal), { signal }));
  }

  /** Materialize a finite stream. Supply maxItems when the upstream size is not trusted. */
  async toArray(options: CollectOptions = {}): Promise<T[]> {
    if (options.maxItems !== undefined) integer(options.maxItems, 0, "maxItems");
    const result: T[] = [];
    await this.forEach((value) => {
      if (options.maxItems !== undefined && result.length >= options.maxItems) {
        throw new ValidationError("stream exceeds maxItems", "collect");
      }
      result.push(value);
    }, options);
    return result;
  }

  /** Consume sequentially; errors in the callback cancel the source and preserve the original error. */
  async forEach(callback: (value: T, context: ItemContext) => Awaitable<unknown>, options: RunOptions = {}): Promise<void> {
    const reader = this.map(callback).toReadable(options).getReader();
    try { while (!(await reader.read()).done) { /* Pull drives bounded evaluation. */ } }
    finally {
      try { await reader.cancel(); } catch { /* Preserve the original error. */ }
      reader.releaseLock();
    }
  }

  /** Pipe to a native WritableStream with standard close/error/cancel propagation. */
  pipeTo(destination: WritableStream<T>, options: StreamPipeOptions = {}): Promise<void> {
    return this.toReadable(options).pipeTo(destination, options);
  }

  /** Async iteration cancels on break/return/throw. Each iteration is a separate execution. */
  async *[Symbol.asyncIterator](): AsyncGenerator<T, void, unknown> {
    const reader = this.toReadable().getReader();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) return;
        yield next.value;
      }
    } finally {
      try { await reader.cancel(); } finally { reader.releaseLock(); }
    }
  }
}

/**
 * Adapt an iterable, async iterable or native stream. Arrays are repeatable; native streams and
 * self-iterating generators are single-use and reject a second consumption instead of returning [] silently.
 * No items are pulled until a terminal consumer requests them.
 */
export function from<T>(source: Source<T>): Stream<T> {
  let nativeUsed = false;
  const iterators = new WeakSet<object>();
  return defer(() => {
    if (isReadable(source)) {
      if (nativeUsed) throw new ValidationError("single-use source already consumed; use Streams.defer", "stream");
      nativeUsed = true;
      return source;
    }
    if (typeof (source as AsyncIterable<T>)[Symbol.asyncIterator] === "function") {
      const iterator = (source as AsyncIterable<T>)[Symbol.asyncIterator]();
      if (iterators.has(iterator)) throw new ValidationError("iterator already consumed; use Streams.defer", "stream");
      iterators.add(iterator);
      return { [Symbol.asyncIterator]: () => iterator };
    }
    const iterator = (source as Iterable<T>)[Symbol.iterator]();
    if (iterators.has(iterator)) throw new ValidationError("iterator already consumed; use Streams.defer", "stream");
    iterators.add(iterator);
    return { [Symbol.iterator]: () => iterator };
  });
}

/**
 * Define a fresh source per execution. The factory runs on first pull and receives cancellation.
 * @example
 * const events = Streams.defer(async ({ signal }) => {
 *   const response = await fetch(url, { signal });
 *   if (!response.ok || !response.body) throw new Error("Cannot read events");
 *   return response.body;
 * });
 */
export function defer<T>(factory: (context: CallContext) => Awaitable<Source<T>>): Stream<T> {
  return new Stream((signal) => {
    let reader: ReadableStreamDefaultReader<T> | undefined;
    let acquiring: Promise<void> | undefined;
    let ended = false;
    const stop = async (reason?: unknown) => {
      ended = true;
      const current = reader;
      reader = undefined;
      if (current) {
        try { await current.cancel(reason); } catch { /* Preserve the source/consumer error. */ }
        finally { current.releaseLock(); }
      }
      // A late-acquired source is canceled by the acquisition continuation below.
    };
    return new ReadableStream<T>({
      async pull(controller) {
        try {
          acquiring ??= Promise.resolve().then(() => {
            signal.throwIfAborted();
            return factory({ signal });
          }).then(async (source) => {
            reader = sourceStream(source, signal).getReader();
            if (ended) await stop(signal.reason);
          });
          await abortable(acquiring, signal);
          if (ended) return;
          const next = await reader!.read();
          if (ended) return;
          if (next.done) { ended = true; reader!.releaseLock(); reader = undefined; controller.close(); }
          else controller.enqueue(next.value);
        } catch (error) {
          // cancel() is not called by the platform after a stream errors. Release explicitly.
          await stop(error);
          throw error;
        }
      },
      cancel: stop,
    }, { highWaterMark: 0 });
  });
}
