import { test } from "bun:test";
import assert from "node:assert/strict";
import { Streams, ValidationError } from "../src/index.ts";
import { deferred, tick } from "./helpers.ts";

function countingSource() {
  let pulled = 0;
  let canceled = 0;
  const source = new ReadableStream<number>(
    {
      pull(controller) {
        controller.enqueue(pulled++);
      },
      cancel() {
        canceled++;
      },
    },
    { highWaterMark: 0 },
  );
  return {
    source,
    get pulled() {
      return pulled;
    },
    get canceled() {
      return canceled;
    },
  };
}

test("construction and toReadable do not pull; take(0) does not acquire", async () => {
  let opened = 0;
  const flow = Streams.defer(() => {
    opened++;
    return [1, 2];
  }).map((n) => n * 2);
  const native = flow.toReadable();
  await tick();
  assert.equal(opened, 0);
  await native.cancel();
  assert.deepEqual(await flow.take(0).toArray(), []);
  assert.equal(opened, 0);
  assert.deepEqual(await flow.toArray(), [2, 4]);
});

test("repeatable arrays and per-run scan state, without emitting the seed", async () => {
  const flow = Streams.from([1, 2, 3]).scan(
    () => 0,
    (sum, n) => sum + n,
  );
  assert.deepEqual(await flow.toArray(), [1, 3, 6]);
  assert.deepEqual(await flow.toArray(), [1, 3, 6]);
});

test("mapAccum models state transitions and zero/multiple emitted events", async () => {
  const flow = Streams.from([1, 2, 3]).mapAccum(
    () => 0,
    async (state, n) => {
      const next = state + n;
      return [next, n === 2 ? [] : [next, next * 10]] as const;
    },
  );
  assert.deepEqual(await flow.toArray(), [1, 10, 6, 60]);
});

test("filter, tap and batches preserve order and flush partial batch", async () => {
  const seen: number[] = [];
  const flow = Streams.from([0, 1, 2, 3, 4, 5])
    .filter(async (n) => n % 2 === 1)
    .tap((n) => {
      seen.push(n);
    })
    .batch(2);
  assert.deepEqual(await flow.toArray(), [[1, 3], [5]]);
  assert.deepEqual(seen, [1, 3, 5]);
});

test("takeUntil includes matching item; takeWhile excludes it", async () => {
  assert.deepEqual(
    await Streams.from([1, 2, 3, 4])
      .takeUntil(async (n) => n === 3)
      .toArray(),
    [1, 2, 3],
  );
  assert.deepEqual(
    await Streams.from([1, 2, 3, 4])
      .takeWhile(async (n) => n < 3)
      .toArray(),
    [1, 2],
  );
  assert.deepEqual(await Streams.from([1, 2]).take(10).toArray(), [1, 2]);
});

test("take cancels native source and releases every owned reader", async () => {
  const tracked = countingSource();
  assert.deepEqual(await Streams.from(tracked.source).take(2).toArray(), [0, 1]);
  assert.equal(tracked.pulled, 2);
  assert.equal(tracked.canceled, 1);
  assert.equal(tracked.source.locked, false);
});

test("bounded map counts completed outputs, not only running tasks", async () => {
  const tracked = countingSource();
  const pending = [deferred<number>(), deferred<number>(), deferred<number>()];
  const started: number[] = [];
  const reader = Streams.from(tracked.source)
    .map(
      (n) => {
        started.push(n);
        return pending[n]!.promise;
      },
      { concurrency: 3 },
    )
    .toReadable()
    .getReader();
  const first = reader.read();
  await tick();
  assert.deepEqual(started, [0, 1, 2]);
  pending[1]!.resolve(11);
  pending[2]!.resolve(12);
  await tick();
  assert.equal(tracked.pulled, 3);
  pending[0]!.resolve(10);
  assert.deepEqual(await first, { value: 10, done: false });
  await tick();
  assert.equal(tracked.pulled, 3);
  await reader.cancel();
  reader.releaseLock();
  assert.equal(tracked.source.locked, false);
});

test("unordered map emits completion order and preserves undefined outputs", async () => {
  const a = deferred<number | undefined>();
  const b = deferred<number | undefined>();
  const reader = Streams.from([a, b])
    .map((d) => d.promise, { concurrency: 2, ordered: false })
    .toReadable()
    .getReader();
  const first = reader.read();
  await tick();
  b.resolve(undefined);
  assert.deepEqual(await first, { value: undefined, done: false });
  a.resolve(1);
  assert.deepEqual(await reader.read(), { value: 1, done: false });
  assert.equal((await reader.read()).done, true);
  reader.releaseLock();
});

test("later ordered rejection fails promptly and aborts noncooperative sibling", async () => {
  const failure = new Error("later failed");
  let sibling: AbortSignal | undefined;
  const result = Streams.from([0, 1])
    .map(
      (n, { signal }) => {
        if (n === 0) {
          sibling = signal;
          return new Promise<number>(() => {});
        }
        throw failure;
      },
      { concurrency: 2 },
    )
    .toArray();
  await assert.rejects(result, (error) => error === failure);
  assert.equal(sibling?.aborted, true);
});

test("external abort settles pending map and cancels source", async () => {
  const tracked = countingSource();
  const controller = new AbortController();
  const reason = new Error("stop");
  let callbackSignal: AbortSignal | undefined;
  const result = Streams.from(tracked.source)
    .map((_, { signal }) => {
      callbackSignal = signal;
      return new Promise<number>(() => {});
    })
    .toArray({ signal: controller.signal });
  await tick();
  controller.abort(reason);
  await assert.rejects(result, (error) => error === reason);
  await tick();
  assert.equal(callbackSignal?.aborted, true);
  assert.equal(tracked.source.locked, false);
  assert.equal(tracked.canceled, 1);
});

test("preaborted consumption never acquires a source", async () => {
  let acquired = false;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    Streams.defer(() => {
      acquired = true;
      return [1];
    }).toArray({ signal: controller.signal }),
  );
  assert.equal(acquired, false);
});

test("late-acquired native sources are canceled after abort", async () => {
  const d = deferred<ReadableStream<number>>();
  const controller = new AbortController();
  const result = Streams.defer(() => d.promise).toArray({ signal: controller.signal });
  await tick();
  controller.abort();
  await assert.rejects(result);
  const tracked = countingSource();
  d.resolve(tracked.source);
  await tick();
  assert.equal(tracked.canceled, 1);
  assert.equal(tracked.source.locked, false);
});

test("native source errors release locks", async () => {
  const failure = new Error("source failed");
  const source = new ReadableStream<number>({
    pull(controller) {
      controller.error(failure);
    },
  });
  await assert.rejects(Streams.from(source).toArray(), (error) => error === failure);
  await tick();
  assert.equal(source.locked, false);
});

test("failed predicates release source and preserve failure", async () => {
  const failure = new Error("predicate failed");
  const tracked = countingSource();
  await assert.rejects(
    Streams.from(tracked.source)
      .takeUntil(() => {
        throw failure;
      })
      .toArray(),
    (error) => error === failure,
  );
  await tick();
  assert.equal(tracked.source.locked, false);
});

test("async iteration break finalizes a synchronous generator", async () => {
  let finalized = 0;
  function* items() {
    try {
      yield 1;
      yield 2;
    } finally {
      finalized++;
    }
  }
  for await (const item of Streams.from(items())) {
    assert.equal(item, 1);
    break;
  }
  assert.equal(finalized, 1);
});

test("single-use generator/native inputs reject a second run; arrays repeat", async () => {
  function* items() {
    yield 1;
  }
  const flow = Streams.from(items());
  assert.deepEqual(await flow.toArray(), [1]);
  await assert.rejects(flow.toArray(), ValidationError);
  const native = Streams.from(
    new ReadableStream<number>({
      start(c) {
        c.enqueue(1);
        c.close();
      },
    }),
  );
  assert.deepEqual(await native.toArray(), [1]);
  await assert.rejects(native.toArray(), ValidationError);
});

test("iterable factories are acquired exactly once per execution", async () => {
  let factories = 0;
  const source = {
    [Symbol.iterator]() {
      factories++;
      return [1, 2][Symbol.iterator]();
    },
  };
  const flow = Streams.from(source);
  assert.deepEqual(await flow.toArray(), [1, 2]);
  assert.equal(factories, 1);
  assert.deepEqual(await flow.toArray(), [1, 2]);
  assert.equal(factories, 2);
});

test("callback failures and maxItems cancel upstream", async () => {
  const tracked = countingSource();
  const failure = new Error("consumer");
  await assert.rejects(
    Streams.from(tracked.source).forEach(() => {
      throw failure;
    }),
    (error) => error === failure,
  );
  assert.equal(tracked.source.locked, false);
  const another = countingSource();
  await assert.rejects(Streams.from(another.source).toArray({ maxItems: 3 }), ValidationError);
  assert.equal(another.canceled, 1);
});

test("native transforms and WritableStream interoperate without sharing transform locks", async () => {
  const pipeline = Streams.from([1, 2]).through(
    () =>
      new TransformStream<number, string>({
        transform(n, c) {
          c.enqueue(String(n));
        },
      }),
  );
  assert.deepEqual(await pipeline.toArray(), ["1", "2"]);
  const values: string[] = [];
  await pipeline.pipeTo(
    new WritableStream({
      write(value) {
        values.push(value);
      },
    }),
  );
  assert.deepEqual(values, ["1", "2"]);
});

test("destination failure cancels source", async () => {
  const tracked = countingSource();
  const failure = new Error("destination");
  await assert.rejects(
    Streams.from(tracked.source).pipeTo(
      new WritableStream({
        write() {
          throw failure;
        },
      }),
    ),
    (error) => error === failure,
  );
  assert.equal(tracked.source.locked, false);
});

test("invalid stream options are rejected synchronously", () => {
  const flow = Streams.from([1]);
  for (const concurrency of [0, -1, 1.1, Infinity, NaN])
    assert.throws(() => flow.map((n) => n, { concurrency }), ValidationError);
  assert.throws(() => flow.batch(0), ValidationError);
  assert.throws(() => flow.take(-1), ValidationError);
});

test("string iterables work through from and defer", async () => {
  assert.deepEqual(await Streams.from("abc").toArray(), ["a", "b", "c"]);
  assert.deepEqual(await Streams.defer(() => "ab").toArray(), ["a", "b"]);
});

test("iterator read failures call return for cleanup", async () => {
  let closed = 0;
  const source: Iterable<number> = {
    [Symbol.iterator]() {
      return {
        next() {
          throw new Error("read");
        },
        return() {
          closed++;
          return { done: true, value: undefined };
        },
      };
    },
  };
  await assert.rejects(Streams.from(source).toArray(), /read/);
  assert.equal(closed, 1);
});
