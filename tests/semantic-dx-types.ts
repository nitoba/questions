// Compile-only contracts for client derivation, durations, diagnostics and semantic events.
import { z } from "zod";
import {
  Duration,
  Questions,
  TypeSafe,
  Schema,
  Streams,
  type QuestionModel,
  type DurationInput,
  type FieldDiagnostic,
  type SemanticHooks,
  type Defaults,
  type OperationOptions,
  type Execution,
} from "../src/index.ts";
import * as Vercel from "../src/providers/vercel.ts";
import * as AISDK from "../src/providers/ai-sdk.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function exact<_T extends true>() {}

export async function contracts(
  model: QuestionModel,
  sdk: AISDK.EvaluationModel,
  environment: string,
) {
  const durations: DurationInput[] = [
    200,
    "1 ms",
    "200 milis",
    "1.5 s",
    "10 seconds",
    "2 min",
    "1 HOUR",
  ];
  const numeric: number = Duration.parse(environment);
  // @ts-expect-error duration units are literal-checked; use seconds, not secods
  const typo: DurationInput = "10 secods";
  // @ts-expect-error unitless strings are ambiguous
  Duration.toMilliseconds("100");
  // @ts-expect-error widened external strings need runtime parsing
  TypeSafe.create({ apiKey: "test", timeout: environment });
  const native = TypeSafe.create({
    apiKey: "test",
    timeout: Duration.parse(environment),
    retry: {
      maxRetries: 2,
      initialDelay: "200 millis",
      maxDelay: "5 s",
      delay: ({ attempt }) => (attempt > 1 ? "1 s" : "100 ms"),
    },
  });
  Vercel.create({
    apiKey: "test",
    timeout: "10 seconds",
    retry: { maxRetries: 2, delay: "250 ms" },
  });
  AISDK.create({ model: sdk, timeout: "10 s" });
  // @ts-expect-error a delay is synchronous, not a promise that might stall policy evaluation
  TypeSafe.create({ apiKey: "test", retry: { maxRetries: 1, delay: async () => "1 s" } });
  // @ts-expect-error legacy suffix retains numeric semantics
  TypeSafe.create({ apiKey: "test", timeoutMs: "1 s" });
  const hooks: SemanticHooks = {
    onEvaluate(event) {
      const id: string = event.operationId;
      // @ts-expect-error semantic events cannot be mutated
      event.operationId = "mutated";
      // @ts-expect-error no prompt or response data in telemetry
      void event.state;
      void id;
    },
    onDecision: [
      async (event) => {
        const tokens: number | undefined = event.usage?.inputTokens;
        void tokens;
      },
    ],
    onError(event) {
      const kind:
        | "provider"
        | "validation"
        | "schema"
        | "uncertain"
        | "timeout"
        | "aborted"
        | "application" = event.kind;
      // @ts-expect-error raw user/provider errors are not exposed to telemetry
      void event.error;
      void kind;
    },
  };
  const defaults = { confidence: 0.6, timeout: "20 seconds" } satisfies Defaults;
  // @ts-expect-error signals are per-call lifetimes, never shared defaults
  const badDefaults: Defaults = { signal: new AbortController().signal };
  const base = Questions.create({ model, defaults, hooks });
  const derived = base.extend({
    model: native,
    defaults: { timeout: "1 min" },
    hooks: { onDecision: false },
  });
  // @ts-expect-error defaults are readonly
  derived.defaults.confidence = 1;
  const options = { timeout: false, hooks: false } satisfies OperationOptions;
  const schema = z
    .object({ team: z.enum(["billing", "support"]) })
    .transform((value) => ({ queue: value.team }))
    .readonly();
  const run = await derived.about("x").run(schema, options);
  exact<Equal<typeof run.value, z.output<typeof schema>>>();
  const replay = await run.replay({ timeout: "10 s", hooks: { onError: false } });
  exact<Equal<typeof replay.value.queue, "billing" | "support">>();
  // @ts-expect-error input keys do not reappear in transformed output
  void replay.value.team;
  // @ts-expect-error readonly output survives derived client and replay
  replay.value.queue = "billing";
  const diagnostics: readonly FieldDiagnostic[] = run.diagnostics;
  // @ts-expect-error diagnostic collections are immutable
  run.diagnostics.push(diagnostics[0]!);
  // @ts-expect-error lossless paths are immutable
  diagnostics[0]!.path[0] = "mutated";
  const plan = Schema.compile(schema);
  const path: readonly (string | number)[] = plan.fields[0]!.path;
  const diagnosis: readonly FieldDiagnostic[] = plan.diagnose(run.evidence);
  const array = await derived.each(["a", "b"]).ask(schema, { timeout: "1 s" });
  exact<Equal<typeof array, z.output<typeof schema>[]>>();
  const pipeline = Streams.from(["x"])
    .map((ticket, { signal }) => derived.about(ticket).run(schema, { signal }))
    .toReadable();
  const nativeStream: ReadableStream<Execution<z.output<typeof schema>>> = pipeline;
  const batch = await derived.about("x").run({ ok: "Yes?" });
  exact<Equal<typeof batch.value.ok, boolean>>();
  exact<Equal<NonNullable<typeof batch.evidence>["answers"]["ok"]["probability"], number>>();
  void [durations, numeric, typo, badDefaults, path, diagnosis, nativeStream];
}
