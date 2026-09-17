# Stream contracts

A `Stream<T>` is a lazy description, not a native stream subclass, scheduler, Fiber, or observable subject. Operators create a new description. Terminal consumers acquire resources when the first item is requested. `toReadable()` yields a native `ReadableStream<T>` with a zero-prefetch outer queue.

## Lifetime

Each execution owns an AbortController linked to the caller. The scope releases listeners and timers on completion, failure or cancellation. Sources are acquired lazily. Readers owned by the library are canceled where appropriate and their locks are released, including when a source errors. Late-acquired sources and responses are canceled after cancellation.

Callbacks receive `signal`; pass it to `fetch`, question operations, and other cooperative work. Abort cannot kill arbitrary JavaScript, roll back an already completed side effect, or forcibly settle a user-created Promise. The consumer can stop waiting for a noncooperative callback, and late rejections are observed, but that callback may continue working. Iterator `return()` is requested; an async generator blocked on unrelated work may finish its `finally` later. A custom native source whose `cancel()` never settles can also delay cleanup. Do not write noncooperative resource adapters and assume the facade makes them interruptible.

Stopping with `take`, `takeUntil`, iterator `break`, a destination error, or explicit cancellation disposes upstream. `take(0)` never acquires upstream. Normal EOF closes without inventing a cancellation error.

## Backpressure and concurrency

`map({ concurrency: N })` keeps at most N unconsumed input slots in its own stage: running callbacks plus completed outputs awaiting demand. Task completion does not automatically refill an exhausted consumer's queue. Input reads are serialized; asynchronous callbacks run concurrently. The default order is input order, with head-of-line blocking for successful results. Failures are fail-fast even for later ordered slots. Unordered mode emits completed results in completion order.

This is a **per-stage item bound**, not a global byte/memory/request-rate limit. Multiple stages, source queues, sink queues and in-flight provider bodies have their own memory. A single item may be very large. `mapAccum` can emit several events per input; a custom TransformStream may fan out arbitrarily. Native transforms retain native queue strategies and may prefetch according to those strategies. Set concurrency 1 when speculative later work must not start before earlier decisions finish. Even cancellation cannot undo requests already sent before `take` reaches its limit.

No helper silently tees or replays. Native `tee()` can buffer for a slow branch; choosing it through the raw escape hatch makes that tradeoff explicit. `toArray` retains its result; use `maxItems`, `take`, `forEach` or `pipeTo` when the source is untrusted or infinite.

## Repetition and state

Arrays return fresh iterators. Native streams and generators are single-use. `from` rejects attempts to reuse a known consumed iterator or native source. `defer` creates a fresh source per run; freshness is the factory's responsibility. A second consumption makes new inference requests, not cached observations.

`scan(() => seed, reducer)` emits only after processing input, not the initial seed. `mapAccum(() => seed, step)` returns `[nextState, events]` and can emit zero or more events. Return immutable snapshots if earlier emitted states must not mutate. Reusing a mutable object from outside a seed factory intentionally shares it; the library cannot clone arbitrary application state.

## Escape hatches

`toReadable({ signal })` provides the standard reader, cancellation and piping APIs. `through(signal => new TransformStream(...))` preserves repeatable composition through a fresh transform per execution. `pipeTo(writable, nativeOptions)` delegates close/error/cancel options to the platform. `preventCancel: true` deliberately opts out of native upstream cancellation; the application becomes responsible for any retained stream lifetime.

Use `for await` for normal iteration. Use an explicit native reader for `preventCancel`-style iteration or detailed lock management. Always release readers you acquire yourself.
