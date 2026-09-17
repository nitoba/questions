# Schema-backed decisions

Questions accepts Zod 4 schemas directly. A schema describes the result, guides inference through metadata, and validates the reconstructed input with `z.safeParseAsync`. The return type is `z.output<typeof schema>`, including transforms, defaults, brands and readonly modifiers. Zod Classic and Zod Mini are supported through `zod/v4/core`.

Zod is a required peer for the root package and `/schema`. Install it alongside Questions. The standalone `/streams`, native provider and `/providers/ai-sdk` entry points do not load Zod. The optional Vercel SDK has its own Zod peer requirement; see [providers](providers.md).

## Start with a schema

```ts
import { z } from "zod";
import { Jev, Questions, Schema } from "@nitoba/questions";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY");
const questions = Questions.create({ model: Jev.create({ apiKey }) });

const triage = z.object({
  urgent: z.boolean().describe("Does this issue prevent production work?"),
  team: z.enum(["billing", "platform"]).meta({
    title: "Owning team",
    description: "Which team should investigate?",
    examples: ["platform"],
    questions: {
      options: { billing: "Invoices and payments", platform: "API and deployments" },
    },
  } satisfies Schema.Metadata),
  impact: z
    .number()
    .min(0)
    .max(2)
    .register(Schema.registry, {
      kind: "score",
      instructions: "How disruptive is the incident?",
      levels: ["Minor inconvenience", "Work impaired", "Production unavailable"],
    }),
});

const result = await questions.about("The API returns 503 after deployment").ask(triage);
// { urgent: boolean; team: "billing" | "platform"; impact: number }
type Triage = z.output<typeof triage>;
```

All decision leaves are evaluated in one provider request. Constant-only schemas need no request and do not resolve a live context function. The existing `ask({ flag: "Question?", ... })` API remains available, unchanged; a raw object containing Zod fields is not a schema. Wrap it in `z.object()`.

## Descriptions, metadata and typed annotations

For ordinary booleans and enums, `.describe()` is sufficient. Without a description, Questions generates an instruction from the field path. Object and tuple descriptions supply context to their descendants.

Metadata precedence on an individual schema instance, from lowest to highest, is:

1. Zod's standard `title`, `description` and `examples` metadata.
2. The `questions` namespace inside `.meta()`.
3. An entry in `Schema.registry` (set with `.register()` or `Schema.annotate()`).

Merging is field-by-field, not a deep merge of `options`. Outer wrapper annotations override the wrapped input's fields. Parent, wrapper and operation confidence requirements can only increase a descendant's minimum. Other application metadata, such as UI configuration or internal IDs, is **not forwarded**. Values deliberately included in descriptions, examples or annotations are sent to the provider, so do not put secrets there.

```ts
const risk = z
  .number()
  .min(0)
  .max(1)
  .register(Schema.registry, {
    kind: "probability",
    instructions: "Will this issue require escalation?",
    criteria: {
      true: "Specialist intervention needed",
      false: "First-line support can resolve it",
    },
  });

const blocked = Schema.annotate(z.boolean().describe("Is production blocked?"), {
  criteria: { true: "No work can continue", false: "A workaround remains available" },
  confidence: 0.7,
});
```

Both registry APIs preserve the exact schema subtype and its Zod methods. `Schema.annotate(schema, annotation)` returns the **same instance** and changes the registry entry, not the schema. Register annotations on the final instance: methods such as `.refine()` and `.transform()` can create a new schema. A custom registry does not automatically copy entries to those new instances. There is no global augmentation of Zod's metadata types; use `satisfies Schema.Metadata` for `.meta()` or the typed registry for stronger annotation checking.

Only finite JSON examples are accepted. Misspelled Questions annotation keys, invalid confidence, mismatched option labels and incompatible kinds are rejected before inference. Primitive union alternatives can carry their own descriptions, instructions, string option labels and confidence. The selected alternative's minimum applies before parsing; duplicate alternatives combine their guidance and retain the stricter minimum.

## Supported schema inputs

| Zod input                                                                                               | Decision meaning                                                               |
| ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `z.boolean()`                                                                                           | Most likely boolean, using `P(true) >= 0.5`                                    |
| `z.enum(...)`                                                                                           | A declared option; numeric TypeScript enums also retain numeric values         |
| Primitive `z.literal(...)` / unions of primitive literals, enums, booleans, null or undefined           | Finite choice; one possible value is a local constant                          |
| `z.object(...)`, including nesting                                                                      | Named independent decisions, then object-level validation                      |
| Fixed `z.tuple(...)`                                                                                    | Position-preserving independent decisions                                      |
| `z.number()` annotated `probability`                                                                    | The provider's `P(true)`, in `[0, 1]`                                          |
| `z.number()` annotated `score` with levels                                                              | Probability-weighted, zero-based level index                                   |
| `z.string()` annotated with explicit `options`                                                          | A closed choice validated as a string; use `z.enum()` to infer a literal union |
| `.optional()`, `.nullable()`, `.default()`, `.prefault()`                                               | Explicit presence decision plus the inner decision                             |
| `.refine()`, `.superRefine()`, output `.transform()` / `.pipe()`, `.readonly()`, `.brand()`, `.catch()` | Original Zod parsing semantics applied locally                                 |
| Finite `z.lazy()`                                                                                       | Expanded once per occurrence; cycles are rejected                              |

A three-level score is in `[0, 2]` and can be fractional. `.int()` does not round it: a fractional result fails the schema. `min`, `max`, refinements and transforms constrain or process the result locally; they do not silently rescale the provider's answer. Confidence is not the same as probability: for boolean evidence the existing confidence metric is `abs(2 * P(true) - 1)`.

The current provider contract is a **finite-decision protocol**, not arbitrary JSON generation. Unconstrained strings/numbers, variable arrays, records, object/discriminated unions, recursive schemas, preprocessors, and unsupported schema kinds fail before any context callback or HTTP request. An output transform can create richer values, but that is deterministic application processing, not extraction of new facts. Input types inside output pipelines must still be supported. Transforms inside finite union alternatives are not supported.

Each optional/nullable wrapper adds a boolean presence question. Presence and inner decisions are included in the **same request**, not evaluated conditionally in separate calls. Absent optional fields are omitted, nullable fields become null, and defaults/prefaults are handled by Zod. A present `false` is not mistaken for absence. Required `z.undefined()` fields remain own properties. Absent branches ignore their unused leaf confidence, but all returned wire evidence is still validated. No unsupported field is silently dropped; in particular, a `__proto__` object field is rejected because Zod's object parser discards it.

## Validated output and errors

```ts
import { SchemaValidationError, UncertainDecision } from "@nitoba/questions";

const routing = z
  .enum(["billing", "platform"])
  .transform(async (team) => ({ team, queue: `support:${team}` }));

try {
  const result = await questions.about("An outage").ask(routing, {
    confidence: 0.6,
    signal: AbortSignal.timeout(15_000),
  });
  // result: { team: "billing" | "platform"; queue: string }
  console.log(result.queue);
} catch (error) {
  if (error instanceof SchemaValidationError) console.error(error.issues);
  else if (error instanceof UncertainDecision) console.error("Needs review", error.evidence);
  else throw error;
}
```

The order is: compile and validate annotations, evaluate once, validate the provider's evidence, apply confidence requirements, reconstruct schema input, then run `safeParseAsync`. A malformed response or uncertain decision cannot be repaired by a user transform or `.catch()`. `SchemaValidationError.issues` preserves Zod issue paths and `cause` is the original Zod error. An exception thrown by a user callback is propagated unchanged. There is no automatic retry, fallback inference or duplicated parsing pass.

Zod defaults and `.catch()` remain explicit user policies with Zod's own semantics. The library does not strengthen or bypass them. Output is not frozen unless the schema asks for it. A valid schema result guarantees the declared structural constraints, **not the factual correctness of an LLM decision**.

Aborting cancels the wait and propagates through cooperative provider calls. Zod callbacks do not receive an injected signal: pass cancellation into your own async work when necessary. A callback that ignores cancellation may continue after the caller stops waiting; late rejections are observed. Use pure validation/transformation callbacks where practical.

## Collections and streams

```ts
import { Streams } from "@nitoba/questions";

const tickets = ["API outage", "Invoice request"];
const results = await questions.each(tickets).ask(triage); // one batched request

const readable = Streams.from(tickets)
  .map((ticket, { signal }) => questions.about(ticket).ask(triage, { signal }), {
    concurrency: 4,
  })
  .toReadable(); // native ReadableStream<z.output<typeof triage>>
```

`each().ask(schema)` compiles once and validates rows in input order, sequentially. Empty collections validate the schema but perform no inference or user parsing. Validation is not a transaction: transforms for earlier rows may have run before a later row fails. Streams use separate item evaluations, retain existing backpressure/cancellation behavior, and start new work on every consumption; they do not cache schema results.

## Advanced: inspect and reuse the compiled plan

```ts
const compiled = Schema.compile(triage);
console.log(compiled.questions);
const evidence = await questions.about("An outage").evidence(compiled.questions);
const result = await compiled.parse(evidence, { confidence: 0.6 });
```

A compiled plan snapshots metadata and uses opaque, collision-free `q0`, `q1`, ... transport IDs. `parse` revalidates the supplied evidence even when called outside the client; it never blindly trusts an asserted TypeScript type. It runs the original schema on each invocation. Do not mutate schema definitions after compilation. Constant-only plans have no questions and should use `compiled.parse()` without calling `evidence({})`.

The same exports are available from `@nitoba/questions/schema`; its registry is the same instance used by the root `Schema` namespace. See [Zod metadata](https://zod.dev/metadata), [Zod library-author guidance](https://zod.dev/library-authors), and the [TypeSafe API protocol](https://docs.typesafe.ai/api).
