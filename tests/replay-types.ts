import { z } from "zod";
import {
  Questions,
  Question,
  TypeSafe,
  type QuestionModel,
  type Execution,
  type Prepared,
  type HttpHooks,
} from "../src/index.ts";
import * as Vercel from "../src/providers/vercel.ts";

declare const model: QuestionModel;
const q = Questions.create({ model }).about("x");
const schema = z
  .object({ route: z.enum(["a", "b"]) })
  .transform((v) => ({ id: v.route }))
  .readonly();
const prepared: Prepared<z.output<typeof schema>> = await q.prepare(schema);
const execution: Execution<z.output<typeof schema>> = await prepared.run();
const result = await execution.replay({ model });
const id: "a" | "b" = result.value.id;
// @ts-expect-error transforms remove the original object fields
void result.value.route;
// @ts-expect-error literal result is preserved
const bad: "c" = result.value.id;
// @ts-expect-error Zod readonly survives replay
result.value.id = "a";
const batch = await q.run({ route: Question.choice("Which?", { a: "A", b: "B" }), ok: "OK?" });
const choice: "a" | "b" | undefined = batch.evidence?.answers.route.choice;
const boolean: boolean = (await batch.replay()).value.ok;
// @ts-expect-error batches have exact keys
void batch.value.missing;
// @ts-expect-error not a model
await result.replay({ model: "TypeSafe" });
const hooks: HttpHooks = {
  onRetry(c) {
    const attempt: number = c.nextAttempt;
    // @ts-expect-error no request headers in safe lifecycle events
    void c.headers;
    // @ts-expect-error event fields are read-only
    c.delayMs = 0;
    void attempt;
  },
};
const direct = TypeSafe.create({ apiKey: "x", retry: 2, hooks });
const gateway = Vercel.create({
  apiKey: "x",
  retry: { maxRetries: 3, delayMs: ({ attempt }) => attempt * 100 },
});
// @ts-expect-error no unbounded or implicit retry=true policy
TypeSafe.create({ apiKey: "x", retry: true });
// @ts-expect-error delay policy is synchronous
Vercel.create({ apiKey: "x", retry: { maxRetries: 2, delayMs: async () => 100 } });
void [id, bad, choice, boolean, direct, gateway];
