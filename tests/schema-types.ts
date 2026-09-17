// Compile-only contracts: inference must come from validated schema output, never a caller cast.
import * as z from "zod";
import * as mini from "zod/mini";
import { Questions, Schema, Streams, type QuestionModel } from "../src/index.ts";

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
function exact<_T extends true>() {}

export async function schemaTypeContracts(model: QuestionModel) {
  const q = Questions.create({ model }).about("Context");
  const schema = z.object({
    urgent: z.boolean(),
    route: z.enum(["billing", "support"]),
    nested: z.object({ value: z.boolean().optional() }),
    priority: Schema.annotate(z.number(), { kind: "score", levels: ["Low", "High"] }),
    risk: z.number().register(Schema.registry, { kind: "probability" }),
  });
  const result = await q.ask(schema);
  exact<Equal<typeof result, z.output<typeof schema>>>();
  exact<Equal<typeof result.route, "billing" | "support">>();
  // @ts-expect-error no arbitrary result properties
  void result.missing;
  // @ts-expect-error enum output must not widen to string
  const invalid: typeof result.route = "sales";
  void invalid;

  const transformed = z
    .enum(["a", "b"])
    .transform((value) => ({ id: value, enabled: true as const }))
    .readonly();
  const transformedResult = await q.ask(transformed);
  exact<Equal<typeof transformedResult, z.output<typeof transformed>>>();
  // @ts-expect-error output is an object, not the input string
  const input: string = transformedResult;
  // @ts-expect-error readonly modifiers survive parsing
  transformedResult.id = "b";
  void input;

  const branded = z.boolean().brand<"Decision">();
  const brand = await q.ask(branded);
  exact<Equal<typeof brand, z.output<typeof branded>>>();
  const rows = await Questions.create({ model }).each(["a", "b"]).ask(transformed);
  exact<Equal<(typeof rows)[number], z.output<typeof transformed>>>();
  const outputs = await Streams.from(["a"])
    .map((state, { signal }) => Questions.create({ model }).about(state).ask(schema, { signal }))
    .toArray();
  exact<Equal<(typeof outputs)[number], z.output<typeof schema>>>();
  const compiled = Schema.compile(transformed);
  const parsed = await compiled.parse();
  exact<Equal<typeof parsed, z.output<typeof transformed>>>();
  const miniSchema = mini.object({ ok: mini.boolean() });
  const miniResult = await q.ask(miniSchema);
  exact<Equal<typeof miniResult, { ok: boolean }>>();
  const original = z.number().min(0);
  const annotated = Schema.annotate(original, { kind: "probability" });
  exact<Equal<typeof annotated, typeof original>>();
  annotated.max(1);
  // @ts-expect-error scores require levels in typed annotations
  Schema.annotate(z.number(), { kind: "score" });
  // @ts-expect-error levels have at least two descriptions
  Schema.annotate(z.number(), { kind: "score", levels: ["Only"] });
  // @ts-expect-error probability is not a score rubric
  Schema.annotate(z.number(), { kind: "probability", levels: ["Low", "High"] });
  const meta = { questions: { kind: "probability" } } satisfies Schema.Metadata;
  z.number().meta(meta);
}
