import { z } from "zod";
import * as mini from "zod/mini";
import {
  Policy,
  Question,
  Questions,
  Schema,
  Streams,
  type PolicyExecution,
  type QuestionModel,
  type BranchValue,
  type Branches,
  type UncertainBranchContext,
  type UnmatchedBranchContext,
} from "../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
declare const model: QuestionModel;
const client = Questions.create({ model });
const builder = Policy.from(
  {
    impact: Question.choice("Impact?", {
      none: "None",
      additive: "Adds API",
      breaking: "Breaks callers",
    }),
    regression: Question.boolean("Regression?"),
    urgent: "Urgent?",
    effort: Question.score("Effort?", ["Low", "High"]),
  },
  { thresholds: { accept: 0.8, reject: 0.2 } },
);

const review = builder
  .when(
    ({ impact, regression }) => impact.is("breaking").and(regression.is(true, { reject: 0.5 })),
    "block",
  )
  .when(({ impact }) => impact.oneOf(["additive", "breaking"]), "migration")
  .when(
    ({ urgent, effort }) =>
      urgent
        .is(false)
        .not()
        .or(effort.atLeast(1).and(effort.atMost(1))),
    "urgent",
  )
  .onUncertain("human")
  .otherwise("ship");
const verdict = await client.about("change").decide(review);
type Verdict = Expect<Equal<typeof verdict, "block" | "migration" | "urgent" | "human" | "ship">>;
type Inferred = Expect<Equal<Policy.Output<typeof review>, typeof verdict>>;
const execution = await client.about("change").run(review);
const replay = await execution.replay({ model, timeout: "10 ms" });
const retained: typeof verdict = replay.value;
const trace: Policy.Trace = replay.trace;
const p: number | undefined = execution.evidence?.answers.regression.probability;
const impact: "none" | "additive" | "breaking" | undefined =
  execution.evidence?.answers.impact.choice;
const genericExecution: PolicyExecution<typeof verdict> = execution;
// @ts-expect-error policy results retain literal values
const wrong: "other" = verdict;
// @ts-expect-error trace is immutable
trace.rules.push({});
// @ts-expect-error no undeclared evidence keys
void execution.evidence?.answers.missing;
// @ts-expect-error unrecognized choice label
builder.when(({ impact }) => impact.is("unknown"), "bad");
// @ts-expect-error oneOf preserves finite options
builder.when(({ impact }) => impact.oneOf(["none", "unknown"]), "bad");
// @ts-expect-error native boolean references are not string labels
builder.when(({ regression }) => regression.is("true"), "bad");
// @ts-expect-error probability rules are condition descriptions, not bool-returning callbacks
builder.when(() => true, "bad");
// @ts-expect-error async construction is not allowed
builder.when(async ({ urgent }) => urgent.is(true), "bad");
// @ts-expect-error score-only comparison methods do not appear on boolean references
builder.when(({ urgent }) => urgent.atLeast(1), "bad");
builder.when(
  ({ urgent }) => urgent.is(true),
  // @ts-expect-error policies select static data, not functions
  () => "action",
);
// @ts-expect-error policies do not await result promises
builder.otherwise(Promise.resolve("value"));
// @ts-expect-error unfinished builders are not executable
await client.about("x").decide(builder);
// @ts-expect-error thresholds are explicit
Policy.from({ ready: "Ready?" });

const structured = builder
  .when(({ urgent }) => urgent.is(true), { action: "notify", channels: ["email"] })
  .onUncertain({ action: "review" })
  .otherwise({ action: "ignore" });
const structuredValue = await client.about("x").decide(structured);
if (structuredValue.action === "notify") {
  const channel: "email" = structuredValue.channels[0];
  // @ts-expect-error literal result tuples are readonly
  structuredValue.channels.push("sms");
  void channel;
}
const undefinedPolicy = builder.onUncertain(undefined).otherwise("default");
const maybe: "default" | undefined = await client.about("x").decide(undefinedPolicy);
const schema = z
  .object({
    change: z.object({ impact: z.enum(["none", "breaking"]), regression: z.boolean() }),
    pair: z.tuple([z.boolean(), z.literal("fixed")]),
    level: Schema.annotate(z.number(), { kind: "score", levels: ["Low", "High"] }),
    code: z.union([z.literal(200), z.literal(500)]),
    allowed: z.literal(true),
  })
  .readonly();
const typedSchema = Policy.from(schema, { thresholds: { accept: 0.8, reject: 0.2 } })
  .when(
    ({ change, pair, level, code, allowed }) =>
      change.impact
        .is("breaking")
        .and(change.regression.is(true))
        .and(pair[0].is(false).not())
        .and(pair[1].is("fixed"))
        .and(level.atLeast(1))
        .and(code.oneOf([200, 500]))
        .and(allowed.is(true)),
    "act",
  )
  .otherwise("wait");
const schemaResult: "act" | "wait" = await client.about("x").decide(typedSchema);
const zodBuilder = Policy.from(schema, { thresholds: { accept: 0.8, reject: 0.2 } });
// @ts-expect-error Zod enum outcomes remain finite
zodBuilder.when(({ change }) => change.impact.is("unknown"), "bad");
// @ts-expect-error literal numeric union outcomes stay narrow
zodBuilder.when(({ code }) => code.is(404), "bad");
// @ts-expect-error literal booleans stay narrow
zodBuilder.when(({ allowed }) => allowed.is(false), "bad");
// @ts-expect-error tuples retain their exact indices
zodBuilder.when(({ pair }) => pair[2].is(true), "bad");
const miniPolicy = Policy.from(mini.object({ urgent: mini.boolean() }), {
  thresholds: { accept: 0.8, reject: 0.2 },
})
  .when(({ urgent }) => urgent.is(true), 1)
  .otherwise(0);
const binary: 0 | 1 = await client.about("x").decide(miniPolicy);
const stream = Streams.from(["change"]).map((item, { signal }) =>
  client.about(item).decide(review, { signal }),
);
const streamed: Array<typeof verdict> = await stream.toArray();

const routed = await client.about("intent").branch(
  "Route?",
  {
    review: {
      description: "Review",
      examples: ["Is it safe?"],
      enabled: true,
      run: ({ signal }) => {
        const s: AbortSignal = signal;
        return client.about("diff").decide(review, { signal: s });
      },
    },
    count: ({ signal }) => {
      void signal;
      return 42;
    },
  },
  {
    selection: { minProbability: 0.8, minMargin: 0.2, allowUnmatched: true },
    onUncertain: async (context) => {
      const typed: UncertainBranchContext = context;
      const signal: AbortSignal = typed.signal;
      void signal;
      return { needsInput: true };
    },
    onUnmatched: (context) => {
      const typed: UnmatchedBranchContext = context;
      void typed;
      return null;
    },
  },
);
type Routed = Expect<
  Equal<typeof routed, typeof verdict | number | { needsInput: boolean } | null>
>;
const basic = await client.about("x").branch("Route?", { a: () => 1, b: async () => "text" });
type Basic = Expect<Equal<typeof basic, string | number>>;
const mixed = {
  a: { description: "A", run: () => 1 },
  b: async () => "text",
} satisfies Branches;
type Mixed = Expect<Equal<BranchValue<typeof mixed>, string | number>>;
// @ts-expect-error descriptors require a local handler, not a result
await client.about("x").branch("Route?", { a: { description: "A", run: 1 } });
// @ts-expect-error eligibility is a local boolean, not an inferred string
await client.about("x").branch("Route?", { a: { description: "A", enabled: "yes", run: () => 1 } });
// @ts-expect-error fallback requires an explicit local function
await client.about("x").branch("Route?", mixed, { onUncertain: "review" });
void [retained, trace, p, impact, genericExecution, wrong, maybe, schemaResult, binary, streamed];
export type Contracts = [Verdict, Inferred, Routed, Basic, Mixed];
