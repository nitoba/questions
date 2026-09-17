import { describe, test } from "bun:test";
import assert from "node:assert/strict";
import * as z from "zod";
import * as mini from "zod/mini";
import {
  Questions,
  Question,
  Schema,
  SchemaValidationError,
  Streams,
  UncertainDecision,
  ValidationError,
} from "../src/index.ts";
import type { AnyQuestion } from "../src/question.ts";
import { deferred, evidence, fixture, tick } from "./helpers.ts";

function selected(question: AnyQuestion, index = 0) {
  if (question.type !== "choice") return evidence(question);
  const keys = Object.keys(question.criteria);
  return {
    type: "choice",
    choice: keys[index],
    confidence: 1,
    probabilities: Object.fromEntries(keys.map((key, i) => [key, i === index ? 1 : 0])),
  };
}

function weighted(question: AnyQuestion) {
  if (question.type !== "score") return evidence(question);
  return {
    type: "score",
    score: 0.75,
    confidence: 0.5,
    probabilities: { "0": 0.5, "1": 0.25, "2": 0.25 },
    legend: Object.fromEntries(question.criteria.map((level, index) => [String(index), level])),
  };
}

describe("schema-backed decisions", () => {
  test("infers nested objects and sends all leaves in one provider request", async () => {
    const { model, calls } = fixture();
    const schema = z
      .object({
        urgent: z.boolean().describe("Is production blocked?"),
        routing: z.object({
          team: z.enum(["billing", "support"]).describe("Who owns the ticket?"),
        }),
      })
      .describe("Customer support triage");
    assert.deepEqual(await Questions.create({ model }).about("An outage").ask(schema), {
      urgent: true,
      routing: { team: "billing" },
    });
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]!.questions), ["q0", "q1"]);
    assert.ok(calls[0]!.questions.q0!.instructions.includes("Customer support triage"));
    assert.ok(calls[0]!.questions.q0!.instructions.includes("Is production blocked?"));
  });

  test("uses describe, meta, examples and option descriptions without leaking unrelated metadata", async () => {
    const { model, calls } = fixture();
    const schema = z.enum(["billing", "support"]).meta({
      title: "Owning team",
      description: "Choose the team",
      examples: ["billing"],
      privateInternalToken: "must-not-leak",
      ui: { color: "blue" },
      questions: { options: { billing: "Invoices and payments", support: "Bugs and outages" } },
    } satisfies Schema.Metadata);
    await Questions.create({ model }).about("x").ask(schema);
    const question = calls[0]!.questions.q0!;
    assert.ok(question.instructions.includes("Owning team"));
    assert.ok(question.instructions.includes('Examples: ["billing"]'));
    assert.ok(JSON.stringify(question.criteria).includes("Invoices and payments"));
    assert.ok(!JSON.stringify(calls).includes("must-not-leak"));
    assert.ok(!JSON.stringify(calls).includes("blue"));
  });

  test("typed annotations and native registry preserve schema identity and override metadata", () => {
    const original = z
      .boolean()
      .meta({ questions: { instructions: "Old", criteria: { true: "YES", false: "NO" } } });
    assert.equal(Schema.annotate(original, { instructions: "New" }), original);
    const question = Schema.compile(original).questions.q0!;
    assert.ok(question.instructions.includes("New"));
    assert.ok(!question.instructions.includes("Old"));
    assert.deepEqual(question.criteria, { true: "YES", false: "NO" });
    const native = z
      .number()
      .register(Schema.registry, { kind: "probability", instructions: "Likely?" });
    assert.equal(Schema.compile(native).questions.q0!.type, "boolean");
  });

  test("metadata attached to output transforms guides the input decision", async () => {
    const { model, calls } = fixture();
    const schema = z
      .enum(["billing", "support"])
      .transform((value) => ({ id: value, upper: value.toUpperCase() }))
      .meta({ questions: { instructions: "Route this case", options: { billing: "Payments" } } });
    assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), {
      id: "billing",
      upper: "BILLING",
    });
    assert.ok(calls[0]!.questions.q0!.instructions.includes("Route this case"));
  });

  test("returns raw probabilities and weighted scores, without clamping or rounding", async () => {
    const { model } = fixture(weighted);
    const schema = z.object({
      chance: Schema.annotate(z.number().min(0).max(1), { kind: "probability" }),
      priority: z
        .number()
        .meta({ questions: { kind: "score", levels: ["Low", "Medium", "High"] } }),
    });
    assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), {
      chance: 0.9,
      priority: 0.75,
    });
  });

  test("honors numeric schema constraints and exposes original Zod issues", async () => {
    const { model, calls } = fixture(weighted);
    const schema = z.object({
      priority: Schema.annotate(z.number().int(), {
        kind: "score",
        levels: ["Low", "Medium", "High"],
      }),
    });
    try {
      await Questions.create({ model }).about("x").ask(schema);
      throw new Error("expected rejection");
    } catch (error) {
      assert.ok(error instanceof SchemaValidationError);
      const failure = error as SchemaValidationError;
      assert.deepEqual(failure.issues[0]!.path, ["priority"]);
      assert.notEqual(failure.cause, undefined);
    }
    assert.equal(calls.length, 1);
  });

  test("runs object-level async refinements and transforms exactly once", async () => {
    let refinements = 0;
    let transforms = 0;
    const { model } = fixture();
    const schema = z
      .object({ urgent: z.boolean() })
      .refine(async (input) => {
        refinements++;
        await tick();
        return input.urgent;
      })
      .transform(async (input) => {
        transforms++;
        await tick();
        return { status: input.urgent ? ("urgent" as const) : ("normal" as const) };
      });
    assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), {
      status: "urgent",
    });
    assert.equal(refinements, 1);
    assert.equal(transforms, 1);
  });

  test("failed cross-field refinement never returns a partially typed result", async () => {
    const { model } = fixture();
    const schema = z
      .object({ a: z.boolean(), b: z.boolean() })
      .refine((value) => value.a !== value.b, { path: ["b"], message: "Flags must differ" });
    await assert.rejects(Questions.create({ model }).about("x").ask(schema), SchemaValidationError);
  });

  test("preserves thrown user callback errors without retrying", async () => {
    const { model, calls } = fixture();
    const failure = new Error("callback failed");
    const schema = z.boolean().transform(() => {
      throw failure;
    });
    await assert.rejects(
      Questions.create({ model }).about("x").ask(schema),
      (error) => error === failure,
    );
    assert.equal(calls.length, 1);
  });

  test("supports Zod Mini through the shared core", async () => {
    const { model } = fixture();
    const schema = mini.object({ ok: mini.boolean(), route: mini.enum(["a", "b"]) });
    assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), {
      ok: true,
      route: "a",
    });
  });

  test("supports fixed tuples and primitive literal unions without stringifying the result", async () => {
    const { model } = fixture();
    const schema = z.tuple([z.union([z.literal(10), z.literal("10"), z.null()]), z.boolean()]);
    assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), [10, true]);
  });

  test("uses literal variant descriptions as choice criteria", () => {
    const schema = z.union([
      z.literal("billing").describe("Payments"),
      z.literal("support").describe("Technical incidents"),
    ]);
    const question = Schema.compile(schema).questions.q0!;
    assert.ok(JSON.stringify(question.criteria).includes("Payments"));
    assert.ok(JSON.stringify(question.criteria).includes("Technical incidents"));
  });

  test("supports numeric TypeScript enum values without reverse mapping strings", async () => {
    const { model } = fixture();
    const schema = z.enum({ 1: "Low", 2: "High", Low: 1, High: 2 });
    assert.equal(await Questions.create({ model }).about("x").ask(schema), 1);
    assert.equal(
      Object.keys((Schema.compile(schema).questions.q0 as Question.ChoiceQuestion).criteria).length,
      2,
    );
  });

  test("constant-only schemas parse without provider or live context evaluation", async () => {
    const { model, calls } = fixture();
    let contexts = 0;
    const q = Questions.create({ model }).about(() => {
      contexts++;
      return "x";
    });
    assert.deepEqual(await q.ask(z.object({ version: z.literal("v1"), absent: z.null() })), {
      version: "v1",
      absent: null,
    });
    assert.deepEqual(await q.ask(z.object({})), {});
    assert.equal(calls.length, 0);
    assert.equal(contexts, 0);
  });

  test("optional/nullable fields use explicit presence decisions and retain false values", async () => {
    const { model } = fixture((question) => ({
      type: "boolean",
      probability: question.instructions.includes("Presence check") ? 1 : 0,
    }));
    assert.deepEqual(
      await Questions.create({ model })
        .about("x")
        .ask(z.object({ optional: z.boolean().optional(), nullable: z.boolean().nullable() })),
      { optional: false, nullable: false },
    );
  });

  test("absent fields are omitted or null and Zod defaults/prefaults execute locally", async () => {
    const { model } = fixture(() => ({ type: "boolean", probability: 0 }));
    const schema = z.object({
      optional: z.boolean().optional(),
      nullable: z.boolean().nullable(),
      defaulted: z.boolean().default(true),
      prefaulted: z
        .boolean()
        .transform((value) => (value ? "yes" : "no"))
        .prefault(true),
    });
    assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), {
      nullable: null,
      defaulted: true,
      prefaulted: "yes",
    });
  });

  test("output readonly modifiers and explicit catch semantics are executed by Zod", async () => {
    const { model } = fixture();
    const schema = z
      .object({
        ok: z
          .boolean()
          .refine(() => false)
          .catch(false),
      })
      .readonly();
    const result = await Questions.create({ model }).about("x").ask(schema);
    assert.deepEqual(result, { ok: false });
    assert.equal(Object.isFrozen(result), true);
  });

  test("string schemas can opt into an explicitly finite choice set", async () => {
    const { model } = fixture();
    const schema = z
      .string()
      .min(2)
      .meta({ questions: { kind: "choice", options: { yes: "Approved", no: "Rejected" } } });
    assert.equal(await Questions.create({ model }).about("x").ask(schema), "yes");
  });

  test("preserves transport identity for dotted, quoted and reserved-looking property names", async () => {
    const { model, calls } = fixture();
    const schema = z.object({
      "a.b": z.boolean(),
      a: z.object({ b: z.boolean() }),
      q0: z.boolean(),
      'x"]': z.boolean(),
    });
    assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), {
      "a.b": true,
      a: { b: true },
      q0: true,
      'x"]': true,
    });
    assert.equal(Object.keys(calls[0]!.questions).length, 4);
  });

  test("shared schema instances are not mistaken for recursion", async () => {
    const { model } = fixture();
    const flag = z.boolean().describe("Enabled?");
    assert.deepEqual(
      await Questions.create({ model })
        .about("x")
        .ask(z.object({ a: flag, b: flag })),
      { a: true, b: true },
    );
  });

  test("snapshot compilation is reusable and never caches provider results or transformations", async () => {
    const { model, calls } = fixture();
    let transforms = 0;
    const schema = Schema.annotate(
      z.boolean().transform((value) => {
        transforms++;
        return value;
      }),
      { instructions: "Original" },
    );
    const compiled = Schema.compile(schema);
    Schema.annotate(schema, { instructions: "Changed" });
    const q = Questions.create({ model }).about("x");
    for (let i = 0; i < 2; i++)
      assert.equal(await compiled.parse(await q.evidence(compiled.questions)), true);
    assert.equal(calls.length, 2);
    assert.equal(transforms, 2);
    assert.ok(compiled.questions.q0!.instructions.includes("Original"));
  });
});

describe("schema validation boundaries", () => {
  test("unsupported schemas fail before reading live context or invoking the provider", async () => {
    const { model, calls } = fixture();
    let reads = 0;
    const q = Questions.create({ model }).about(() => {
      reads++;
      return "x";
    });
    for (const schema of [
      z.string(),
      z.number(),
      z.array(z.boolean()),
      z.record(z.string(), z.boolean()),
      z.any(),
      z.unknown(),
      z.date(),
      z.tuple([z.boolean()]).rest(z.boolean()),
      z.union([z.object({ a: z.boolean() }), z.object({ b: z.boolean() })]),
      z.preprocess(Boolean, z.boolean()),
    ]) {
      await assert.rejects(q.ask(schema), ValidationError);
    }
    assert.equal(reads, 0);
    assert.equal(calls.length, 0);
  });

  test("recursive schemas fail with a useful error instead of overflowing the stack", () => {
    const recursive: z.ZodType = z.lazy(() => z.object({ next: recursive }));
    assert.throws(
      () => Schema.compile(recursive),
      (error: unknown) => error instanceof Error && error.message.includes("recursive schemas"),
    );
  });

  test("rejects mistyped or contradictory metadata before inference", async () => {
    const { model, calls } = fixture();
    const q = Questions.create({ model }).about("x");
    for (const schema of [
      z.boolean().meta({ questions: { kind: "score", levels: ["Low", "High"] } }),
      z.number().meta({ questions: { kind: "score", levels: ["Only"] } }),
      z.number().meta({ questions: { kind: "probability", levels: ["Low", "High"] } }),
      z.enum(["a", "b"]).meta({ questions: { options: { typo: "A" } } }),
      z.boolean().meta({ questions: { confidnce: 0.8 } }),
      z.boolean().meta({ questions: { confidence: 2 } }),
      z.boolean().meta({ questions: { instructions: "" } }),
      z.boolean().meta({ examples: "not-an-array" }),
      z.object({ ok: z.boolean() }).meta({ questions: { kind: "boolean" } }),
    ])
      await assert.rejects(q.ask(schema), ValidationError);
    assert.equal(calls.length, 0);
  });

  test("malformed provider data cannot reach a Zod transform or catch fallback", async () => {
    const { model } = fixture(() => ({ type: "boolean", probability: 12 }));
    let transformed = false;
    const schema = z
      .boolean()
      .transform((value) => {
        transformed = true;
        return value;
      })
      .catch(false);
    await assert.rejects(Questions.create({ model }).about("x").ask(schema), ValidationError);
    assert.equal(transformed, false);
  });

  test("compiled parse revalidates externally supplied evidence", async () => {
    const compiled = Schema.compile(z.boolean());
    await assert.rejects(
      compiled.parse({
        model: "x",
        usage: { inputTokens: 0, outputTokens: 0 },
        answers: { q0: { type: "boolean", probability: NaN } },
      }),
      ValidationError,
    );
  });

  test("confidence gates run before refinements; per-field gates cannot weaken global or parent gates", async () => {
    const { model } = fixture();
    let transformed = false;
    const schema = z
      .object({ ok: Schema.annotate(z.boolean(), { confidence: 0.1 }) })
      .transform((value) => {
        transformed = true;
        return value;
      })
      .meta({ questions: { confidence: 0.95 } });
    await assert.rejects(Questions.create({ model }).about("x").ask(schema), UncertainDecision);
    assert.equal(transformed, false);
    await assert.rejects(
      Questions.create({ model })
        .about("x")
        .ask(Schema.annotate(z.boolean(), { confidence: 0.1 }), { confidence: 0.95 }),
      UncertainDecision,
    );
  });

  test("absent optional branches do not gate unused child decisions", async () => {
    const { model } = fixture((question) => ({
      type: "boolean",
      probability: question.instructions.includes("Presence check") ? 0 : 0.5,
    }));
    const schema = z
      .object({ optional: z.boolean().optional() })
      .meta({ questions: { confidence: 0.9 } });
    assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), {});
  });

  test("already aborted calls invoke neither inference nor user validation", async () => {
    const { model, calls } = fixture();
    let validations = 0;
    const schema = z.literal("constant").transform((value) => {
      validations++;
      return value;
    });
    const reason = new Error("stopped");
    await assert.rejects(
      Questions.create({ model })
        .about("x")
        .ask(schema, { signal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
    assert.equal(calls.length, 0);
    assert.equal(validations, 0);
  });

  test("cancels pending asynchronous validation and observes late rejection", async () => {
    const { model } = fixture();
    const waiting = deferred<boolean>();
    const started = deferred<void>();
    const controller = new AbortController();
    const schema = z.boolean().refine(async () => {
      started.resolve();
      return waiting.promise;
    });
    const result = Questions.create({ model })
      .about("x")
      .ask(schema, { signal: controller.signal });
    await started.promise;
    const reason = new Error("cancelled during validation");
    controller.abort(reason);
    await assert.rejects(result, (error) => error === reason);
    waiting.reject(new Error("late validator failure"));
    await tick();
  });
});

describe("schemas with batches and streams", () => {
  test("each(schema) uses one request and validates transformed rows in input order", async () => {
    const { model, calls } = fixture((question, key) =>
      selected(question, key.startsWith("i1") ? 1 : 0),
    );
    const schema = z
      .object({ route: z.enum(["a", "b"]) })
      .transform(async (value) => value.route.toUpperCase());
    assert.deepEqual(await Questions.create({ model }).each(["one", "two"]).ask(schema), [
      "A",
      "B",
    ]);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]!.state, { item0: "one", item1: "two" });
  });

  test("empty batches validate the schema but do not run transforms or inference", async () => {
    const { model, calls } = fixture();
    let transforms = 0;
    const each = Questions.create({ model }).each([]);
    assert.deepEqual(
      await each.ask(
        z.boolean().transform((value) => {
          transforms++;
          return value;
        }),
      ),
      [],
    );
    await assert.rejects(each.ask(z.string()), ValidationError);
    assert.equal(calls.length, 0);
    assert.equal(transforms, 0);
  });

  test("constant batches validate each row separately without inference", async () => {
    const { model, calls } = fixture();
    let count = 0;
    const schema = z.literal("x").transform(() => ++count);
    assert.deepEqual(await Questions.create({ model }).each(["one", "two"]).ask(schema), [1, 2]);
    assert.equal(calls.length, 0);
  });

  test("existing plain question batches retain their behavior", async () => {
    const { model } = fixture();
    assert.deepEqual(await Questions.create({ model }).about("x").ask({ ok: "OK?" }), { ok: true });
    assert.deepEqual(
      await Questions.create({ model })
        .each(["x"])
        .ask({ route: Question.choice("Route?", { a: "A", b: "B" }) }),
      [{ route: "a" }],
    );
  });

  test("streams preserve typed output, concurrency and native Web Stream interoperability", async () => {
    const { model, calls } = fixture();
    const client = Questions.create({ model });
    const schema = z.object({ urgent: z.boolean(), route: z.enum(["a", "b"]) });
    const native = Streams.from(["one", "two"])
      .map((item, { signal }) => client.about(item).ask(schema, { signal }), { concurrency: 2 })
      .toReadable();
    const reader = native.getReader();
    try {
      assert.deepEqual((await reader.read()).value, { urgent: true, route: "a" });
      assert.deepEqual((await reader.read()).value, { urgent: true, route: "a" });
      assert.equal((await reader.read()).done, true);
    } finally {
      reader.releaseLock();
    }
    assert.equal(calls.length, 2);
  });
});

describe("schema edge contracts", () => {
  test("required undefined remains an own property while an absent optional is omitted", async () => {
    const { model } = fixture(() => ({ type: "boolean", probability: 0 }));
    const result = await Questions.create({ model })
      .about("x")
      .ask(
        z.object({
          required: z.undefined(),
          optional: z.boolean().optional(),
        }),
      );
    assert.equal(Object.hasOwn(result, "required"), true);
    assert.equal(Object.hasOwn(result, "optional"), false);
    assert.equal(result.required, undefined);
  });

  test("rejects object fields discarded by the underlying Zod parser", () => {
    const shape = Object.fromEntries([["__proto__", z.boolean()]]);
    assert.throws(() => Schema.compile(z.object(shape)), ValidationError);
    assert.doesNotThrow(() => Schema.compile(z.enum(["__proto__", "normal"])));
  });

  test("union alternative instructions, options and confidence are not silently discarded", async () => {
    const schema = z.union([
      z.enum(["billing", "payments"]).meta({
        questions: {
          instructions: "Money-related",
          options: { billing: "Invoices" },
          confidence: 0.9,
        },
      }),
      z.literal("support").describe("Technical support"),
    ]);
    const { model, calls } = fixture((question) =>
      Object.assign({}, selected(question), { confidence: 0.8 }),
    );
    await assert.rejects(Questions.create({ model }).about("x").ask(schema), UncertainDecision);
    assert.ok(JSON.stringify(calls[0]!.questions.q0!.criteria).includes("Money-related"));
    assert.ok(JSON.stringify(calls[0]!.questions.q0!.criteria).includes("Invoices"));
    const { model: support } = fixture((question) =>
      Object.assign({}, selected(question, 2), { confidence: 0.8 }),
    );
    assert.equal(await Questions.create({ model: support }).about("x").ask(schema), "support");
  });

  test("rejects malformed or inapplicable annotations before any provider invocation", async () => {
    const { model, calls } = fixture();
    const q = Questions.create({ model }).about("x");
    for (const schema of [
      z.boolean().meta({ questions: { kind: ["boolean"] } }),
      z.boolean().meta({ questions: { criteria: { true: "Yes", false: "No", typo: "ignored?" } } }),
      z.enum(["a", "b"]).meta({ questions: { options: { a: 42 } } }),
      z.union([
        z.literal("a").meta({ questions: { kind: "score", levels: ["a", "b"] } }),
        z.literal("b"),
      ]),
    ])
      await assert.rejects(q.ask(schema), ValidationError);
    assert.equal(calls.length, 0);
  });
});
