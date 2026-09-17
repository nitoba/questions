import { test } from "bun:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  Questions,
  Schema,
  SchemaValidationError,
  UncertainDecision,
  ValidationError,
} from "../src/index.ts";
import { fixture } from "./helpers.ts";

test("compiled fields preserve lossless nested paths, tuple indices and option mappings", () => {
  const schema = z.object({
    "a.b": z.tuple([z.boolean(), z.enum(["x", "y"]).describe("Route?")]),
    nested: z.object({ "0": z.boolean() }),
  });
  const compiled = Schema.compile(schema);
  assert.deepEqual(
    compiled.fields.map((field) => field.path),
    [
      ["a.b", 0],
      ["a.b", 1],
      ["nested", "0"],
    ],
  );
  assert.equal(compiled.fields[1]!.questionId, "q1");
  assert.deepEqual(compiled.fields[1]!.choices, { o0: "x", o1: "y" });
  assert.equal(compiled.fields[1]!.annotations.description, "Route?");
  assert.ok(Object.isFrozen(compiled.fields));
  assert.ok(Object.isFrozen(compiled.fields[1]!.path));
  assert.ok(Object.isFrozen(compiled.fields[1]!.choices));
  assert.ok(Object.isFrozen(compiled.fields[1]!.annotations));
});

test("diagnose joins existing evidence without inference, confidence enforcement or Zod callbacks", async () => {
  let parses = 0;
  const { model, calls } = fixture();
  const compiled = Schema.compile(
    z.object({ ok: z.boolean().register(Schema.registry, { confidence: 0.95 }) }).transform((v) => {
      parses++;
      return v.ok;
    }),
  );
  const evidence = await Questions.create({ model }).about("x").evidence(compiled.questions);
  const diagnostic = compiled.diagnose(evidence)[0]!;
  assert.equal(diagnostic.confidencePassed, false);
  assert.equal(diagnostic.minimum, 0.95);
  assert.equal(parses, 0);
  assert.equal(calls.length, 1);
  assert.deepEqual(diagnostic.path, ["ok"]);
  assert.equal(diagnostic.answer.type, "boolean");
});

test("run exposes field diagnostics from the same inference, before output path transforms", async () => {
  let parses = 0;
  const { model, calls } = fixture();
  const schema = z.object({ input: z.boolean() }).transform((v) => {
    parses++;
    return { renamed: v.input };
  });
  const result = await Questions.create({ model }).about("x").run(schema);
  assert.equal(result.value.renamed, true);
  assert.equal(parses, 1);
  assert.equal(calls.length, 1);
  assert.deepEqual(result.diagnostics[0]!.path, ["input"]);
  assert.ok(Object.isFrozen(result.diagnostics));
  assert.ok(Object.isFrozen(result.diagnostics[0]!.answer));
  const second = await result.replay();
  assert.equal(calls.length, 2);
  assert.equal(parses, 2);
  assert.notEqual(result.operationId, second.operationId);
});

test("presence diagnostics mark absent descendants inactive without discarding their wire validation", async () => {
  const { model } = fixture((_question, key) => ({
    type: "boolean",
    probability: key === "q0" ? 0 : 0.5,
  }));
  const compiled = Schema.compile(
    z.object({ maybe: z.boolean().register(Schema.registry, { confidence: 0.9 }).optional() }),
  );
  const evidence = await Questions.create({ model }).about("x").evidence(compiled.questions);
  const diagnostics = compiled.diagnose(evidence);
  assert.deepEqual(
    diagnostics.map((d) => d.role),
    ["presence", "value"],
  );
  assert.deepEqual(
    diagnostics.map((d) => d.active),
    [true, false],
  );
  assert.equal(diagnostics[1]!.confidencePassed, undefined);
  assert.deepEqual(await compiled.parse(evidence), {});
  assert.throws(
    () => compiled.diagnose({ ...evidence, answers: { q0: evidence.answers.q0 } }),
    ValidationError,
  );
});

test("diagnostic minimum includes schema ancestors, selected union alternatives and call policy", async () => {
  const schema = z
    .object({
      route: z.union([
        z.literal("x").register(Schema.registry, { confidence: 0.9 }),
        z.literal("y"),
      ]),
    })
    .register(Schema.registry, { confidence: 0.6 });
  const { model } = fixture();
  const compiled = Schema.compile(schema);
  const evidence = await Questions.create({ model }).about("x").evidence(compiled.questions);
  assert.equal(compiled.diagnose(evidence, { confidence: 0.8 })[0]!.minimum, 0.9);
  assert.equal(compiled.diagnose(evidence, { confidence: 0.99 })[0]!.minimum, 0.99);
});

test("uncertainty carries its exact field path and diagnostics before parsing", async () => {
  let parses = 0;
  const { model } = fixture();
  const schema = z
    .object({
      incident: z.object({ urgent: z.boolean().register(Schema.registry, { confidence: 0.99 }) }),
    })
    .transform((v) => {
      parses++;
      return v;
    });
  await assert.rejects(Questions.create({ model }).about("x").ask(schema), (e: unknown) => {
    assert.ok(e instanceof UncertainDecision);
    assert.deepEqual(e.path, ["incident", "urgent"]);
    assert.equal(e.questionId, "q0");
    assert.equal(e.diagnostics?.[0]?.confidencePassed, false);
    return true;
  });
  assert.equal(parses, 0);
});

test("Zod failures retain original issues and link them to input-field evidence", async () => {
  const { model } = fixture();
  await assert.rejects(
    Questions.create({ model })
      .about("x")
      .ask(z.object({ ok: z.boolean().refine(() => false, "rejected") })),
    (e: unknown) => {
      assert.ok(e instanceof SchemaValidationError);
      assert.deepEqual(e.issues[0]!.path, ["ok"]);
      assert.deepEqual(e.diagnostics[0]!.path, ["ok"]);
      assert.equal(e.diagnostics[0]!.confidencePassed, true);
      return true;
    },
  );
});

test("constant plans and shared schema instances have deterministic diagnostics", async () => {
  const { model, calls } = fixture();
  assert.deepEqual(
    (await Questions.create({ model }).about("x").run(z.literal("constant"))).diagnostics,
    [],
  );
  assert.equal(calls.length, 0);
  const child = z.boolean();
  const compiled = Schema.compile(z.object({ a: child, b: child }));
  assert.deepEqual(
    compiled.fields.map((d) => d.path),
    [["a"], ["b"]],
  );
  Schema.annotate(child, { instructions: "changed" });
  assert.ok(!JSON.stringify(compiled.fields).includes("changed"));
});
