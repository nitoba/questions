import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  Questions,
  TypeSafe,
  ValidationError,
  ProviderError,
  TimeoutError,
  UncertainDecision,
} from "../src/index.ts";
import * as Vercel from "../src/providers/vercel.ts";
import type { Hooks, Retry, RetryContext } from "../src/http.ts";
import { deferred, tick } from "./helpers.ts";

const transport = (f: (url: RequestInfo | URL, init?: RequestInit) => Promise<Response>) =>
  f as typeof globalThis.fetch;
for (const [name, create] of [
  ["TypeSafe", TypeSafe.create],
  ["Vercel", Vercel.create],
] as const) {
  const wire = (init?: RequestInit) => {
    const request = JSON.parse(String(init?.body));
    return Response.json({
      model: "test",
      usage: { input_tokens: 1, output_tokens: 1, inputTokens: 1 },
      answers: Object.fromEntries(
        Object.keys(request.questions).map((key) => [
          key,
          name === "TypeSafe" ? { type: "noul", noul: 0.9 } : { type: "boolean", probability: 0.9 },
        ]),
      ),
    });
  };
  const client = (options: {
    retry?: Retry;
    hooks?: Hooks;
    timeoutMs?: number;
    fetch: typeof globalThis.fetch;
  }) =>
    Questions.create({ model: create({ apiKey: "never-disclose", ...options }) }).about(
      "private-state",
    );

  test(`${name}: numeric/false retry and HTTP status policies are explicit`, async () => {
    for (const retry of [undefined, false, 0, 1, { maxRetries: 2, delayMs: 0 }] as const) {
      let calls = 0;
      const q = client({
        ...(retry === undefined ? {} : { retry }),
        fetch: transport(async () => {
          calls++;
          return new Response("secret body", { status: 429 });
        }),
      });
      await assert.rejects(
        q.is("private-question"),
        (error) =>
          error instanceof ProviderError &&
          error.status === 429 &&
          !String(error).includes("secret") &&
          !String(error).includes("private") &&
          error.cause === undefined,
      );
      assert.equal(
        calls,
        typeof retry === "number" ? retry + 1 : retry && typeof retry === "object" ? 3 : 1,
      );
    }
  });

  test(`${name}: ofetch retries replay identical POST bytes without shared header mutation`, async () => {
    const requests: string[] = [];
    const statuses = [503];
    const options = { maxRetries: 2, statusCodes: statuses, delayMs: 0 };
    const q = client({
      retry: options,
      fetch: transport(async (url, init) => {
        assert.ok(init);
        assert.equal(init.redirect, "error");
        assert.equal(new Headers(init.headers).get("authorization"), "Bearer never-disclose");
        requests.push(String(init.body));
        (init.headers as Headers).set("authorization", "changed");
        (url as URL).pathname = "/mutated";
        return requests.length < 3 ? new Response("busy", { status: 503 }) : wire(init);
      }),
    });
    statuses.length = 0;
    options.maxRetries = 0;
    assert.equal(await q.is("OK?"), true);
    assert.equal(requests.length, 3);
    assert.equal(new Set(requests).size, 1);
  });

  test(`${name}: network retries need separate opt-in and do not enable HTTP 500`, async () => {
    for (const networkErrors of [false, true]) {
      let calls = 0;
      const q = client({
        retry: { maxRetries: 1, networkErrors, delayMs: 0 },
        fetch: transport(async (_, init) => {
          if (++calls === 1) throw new Error("custom transport may retain a secret");
          return wire(init);
        }),
      });
      if (networkErrors) assert.equal(await q.is("OK?"), true);
      else await assert.rejects(q.is("OK?"), ProviderError);
      assert.equal(calls, networkErrors ? 2 : 1);
    }
    let calls = 0;
    const q = client({
      retry: { maxRetries: 2, networkErrors: true, delayMs: 0 },
      fetch: transport(async () => {
        calls++;
        return new Response("bad", { status: 500 });
      }),
    });
    await assert.rejects(q.is("OK?"), ProviderError);
    assert.equal(calls, 1);
  });

  test(`${name}: async hook arrays are ordered, snapshotted and credential-safe`, async () => {
    const events: string[] = [];
    let calls = 0;
    const hooks: Hooks = {
      onRequest: [
        async (c) => {
          await tick();
          events.push(`request:${c.attempt}`);
        },
        (c) => {
          assert.ok(Object.isFrozen(c));
          assert.equal("request" in c, false);
          assert.equal("options" in c, false);
          assert.equal("headers" in c, false);
          assert.equal("url" in c, false);
          assert.equal(c.provider, name);
          assert.ok(c.elapsedMs >= 0);
          events.push("second-hook");
        },
      ],
      onResponse: (c) => {
        events.push(`response:${c.status}`);
      },
      onRetry: (c) => {
        assert.equal(c.nextAttempt, 2);
        assert.equal(c.error.cause, undefined);
        events.push(`retry:${c.delayMs}`);
      },
      onError: () => {
        assert.fail("success must not invoke onError");
      },
    };
    const q = client({
      retry: { maxRetries: 1, delayMs: 0 },
      hooks,
      fetch: transport(async (_, init) => {
        return ++calls === 1 ? new Response("secret", { status: 429 }) : wire(init);
      }),
    });
    (hooks.onRequest as unknown[]).push(() => assert.fail("must snapshot arrays"));
    assert.equal(await q.is("OK?"), true);
    assert.deepEqual(events, [
      "request:1",
      "second-hook",
      "response:429",
      "retry:0",
      "request:2",
      "second-hook",
      "response:200",
    ]);
  });

  test(`${name}: final onError is once and strips custom fetch causes`, async () => {
    let calls = 0,
      errors = 0;
    const q = client({
      retry: { maxRetries: 2, networkErrors: true, delayMs: 0 },
      hooks: {
        onError: (c) => {
          errors++;
          assert.equal(c.attempt, 3);
          assert.equal(c.error.cause, undefined);
          assert.ok(Object.isFrozen(c.error));
        },
      },
      fetch: transport(async () => {
        calls++;
        throw new Error("secret cause");
      }),
    });
    await assert.rejects(q.is("OK?"), ProviderError);
    assert.equal(calls, 3);
    assert.equal(errors, 1);
  });

  test(`${name}: hooks and delay callbacks preserve thrown values without retry`, async () => {
    for (const hook of ["onRequest", "onResponse", "onRetry", "onError", "delay"] as const) {
      const cause = { hook };
      let calls = 0;
      const q = client({
        retry: {
          maxRetries: hook === "onError" ? 0 : 2,
          delayMs:
            hook === "delay"
              ? () => {
                  throw cause;
                }
              : 0,
        },
        hooks:
          hook === "delay"
            ? {}
            : {
                [hook]: () => {
                  throw cause;
                },
              },
        fetch: transport(async () => {
          calls++;
          return new Response(null, { status: 429 });
        }),
      });
      await assert.rejects(q.is("OK?"), (e) => e === cause);
      assert.equal(calls, hook === "onRequest" ? 0 : 1);
    }
  });

  test(`${name}: Retry-After overrides custom delays and a wait above budget stops`, async () => {
    for (const retryAfter of [
      "0.02",
      "999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999999",
      new Date(Date.now() + 3600_000).toUTCString(),
    ]) {
      let calls = 0;
      const times: number[] = [];
      const q = client({
        retry: { maxRetries: 1, maxDelayMs: 100, delayMs: () => 0 },
        fetch: transport(async (_, init) => {
          times.push(performance.now());
          return ++calls === 1
            ? new Response(null, { status: 429, headers: { "retry-after": retryAfter } })
            : wire(init);
        }),
      });
      if (retryAfter === "0.02") {
        assert.equal(await q.is("OK?"), true);
        assert.ok(times[1]! - times[0]! >= 18);
      } else {
        await assert.rejects(q.is("OK?"), ProviderError);
        assert.equal(calls, 1);
      }
    }
  });

  test(`${name}: cancel during backoff prevents later HTTP requests`, async () => {
    const controller = new AbortController(),
      scheduled = deferred<void>();
    let calls = 0;
    const reason = new Error("cancel retry");
    const q = client({
      retry: { maxRetries: 3, delayMs: 1000 },
      hooks: {
        onRetry: () => {
          scheduled.resolve();
        },
      },
      fetch: transport(async () => {
        calls++;
        return new Response(null, { status: 429 });
      }),
    });
    const pending = q.is("OK?", { signal: controller.signal });
    await scheduled.promise;
    controller.abort(reason);
    await assert.rejects(pending, (e) => e === reason);
    await tick();
    assert.equal(calls, 1);
  });

  test(`${name}: timeout covers an uncooperative hook and prevents late dispatch`, async () => {
    const paused = deferred<void>();
    let calls = 0;
    const q = client({
      timeoutMs: 10,
      hooks: { onRequest: () => paused.promise },
      fetch: transport(async (_, init) => {
        calls++;
        return wire(init);
      }),
    });
    await assert.rejects(q.is("OK?"), TimeoutError);
    paused.resolve();
    await tick();
    assert.equal(calls, 0);
  });

  test(`${name}: throwing/aborted response hooks close the owned native body`, async () => {
    const reason = new Error("hook failed");
    let canceled = false;
    const q = client({
      hooks: {
        onResponse: () => {
          throw reason;
        },
      },
      fetch: transport(
        async () =>
          new Response(
            new ReadableStream({
              cancel() {
                canceled = true;
              },
            }),
          ),
      ),
    });
    await assert.rejects(q.is("OK?"), (e) => e === reason);
    assert.equal(canceled, true);
  });

  test(`${name}: JSON, body read, evidence, confidence and Zod failures are not retried`, async () => {
    for (const kind of ["json", "body", "evidence", "confidence", "zod"] as const) {
      let calls = 0,
        parses = 0;
      const q = client({
        retry: { maxRetries: 3, statusCodes: [500], networkErrors: true, delayMs: 0 },
        fetch: transport(async (_, init) => {
          calls++;
          if (kind === "json") return new Response("not JSON");
          if (kind === "body")
            return new Response(
              new ReadableStream({
                start(c) {
                  c.error(new Error("body failure"));
                },
              }),
            );
          if (kind === "evidence") return Response.json({ answers: {} });
          return wire(init);
        }),
      });
      if (kind === "zod")
        await assert.rejects(
          q.ask(
            z.boolean().transform(() => {
              parses++;
              throw new Error("transform");
            }),
          ),
        );
      else if (kind === "confidence")
        await assert.rejects(q.is("OK?", { confidence: 0.99 }), UncertainDecision);
      else await assert.rejects(q.is("OK?"));
      assert.equal(calls, 1);
      assert.equal(parses, kind === "zod" ? 1 : 0);
    }
  });

  test(`${name}: independent concurrent calls have independent attempt counters`, async () => {
    const counts = new Map<string, number>();
    const seen: number[] = [];
    const q = client({
      retry: { maxRetries: 1, delayMs: 0 },
      hooks: {
        onRequest: (c) => {
          seen.push(c.attempt);
        },
      },
      fetch: transport(async (_, init) => {
        const body = String(init?.body);
        const count = (counts.get(body) ?? 0) + 1;
        counts.set(body, count);
        await tick();
        return count === 1 ? new Response(null, { status: 429 }) : wire(init);
      }),
    });
    assert.deepEqual(await Promise.all([q.is("first?"), q.is("second?")]), [true, true]);
    assert.deepEqual(seen.sort(), [1, 1, 2, 2]);
  });
}

test("HTTP retry configuration validation is eager and policies cannot return async/invalid delays", async () => {
  const make = (retry: Retry) => TypeSafe.create({ apiKey: "test", retry });
  for (const retry of [
    true,
    -1,
    1.1,
    Infinity,
    { maxRetries: 11 },
    { maxRetries: 1, statusCodes: [200] },
    { maxRetries: 1, statusCodes: [NaN] },
    { maxRetries: 1, networkErrors: "yes" },
    { maxRetries: 1, delayMs: -1 },
  ]) {
    assert.throws(() => make(retry as Retry), ValidationError);
  }
  assert.throws(
    () => TypeSafe.create({ apiKey: "x", hooks: { onRequest: [3] as never } }),
    ValidationError,
  );
  for (const delayMs of [
    () => NaN,
    () => -1,
    () => Promise.resolve(0),
    () => Promise.reject(new Error("invalid async retry policy")),
  ]) {
    let calls = 0;
    const model = TypeSafe.create({
      apiKey: "x",
      retry: { maxRetries: 2, delayMs: delayMs as (c: RetryContext) => number },
      fetch: transport(async () => {
        calls++;
        return new Response(null, { status: 429 });
      }),
    });
    await assert.rejects(Questions.create({ model }).about("x").is("OK?"), ValidationError);
    assert.equal(calls, 1);
  }
});
