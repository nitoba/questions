import { z } from "zod";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "@ai-sdk/gateway";
import { Questions, Streams, type QuestionModel, type ProbabilitySource } from "../src/index.ts";
import * as Generative from "../src/providers/generative.ts";
import * as AISDK from "../src/providers/ai-sdk.ts";

const google = createGoogleGenerativeAI({ apiKey: "test-only" });
const anthropic = createAnthropic({ apiKey: "test-only" });
const openai = createOpenAI({ apiKey: "test-only" });
const gateway = createGateway({ apiKey: "test-only" });
for (const model of [
  google("gemini-test"),
  anthropic("claude-test"),
  openai("gpt-test"),
  gateway("google/test"),
]) {
  const adapter: QuestionModel = Generative.create({
    model,
    evidence: "estimated",
    timeout: "20 seconds",
    confidence: "margin",
  });
  void adapter;
}
// @ts-expect-error explicit acknowledgement is required
Generative.create({ model: google("test") });
// @ts-expect-error this adapter never claims calibrated or native probabilities
Generative.create({ model: google("test"), evidence: "calibrated" });
// @ts-expect-error an ID would implicitly route through a default provider
Generative.create({ model: "google/test", evidence: "estimated" });
// @ts-expect-error evaluation models are not language models
Generative.create({ model: gateway.evaluationModel("typesafe-ai/jev"), evidence: "estimated" });
// @ts-expect-error the existing evaluation adapter does not accept a language model
AISDK.create({ model: google("test") });

async function contracts() {
  const client = Questions.create({
    model: Generative.create({ model: google("test"), evidence: "estimated" }),
  });
  const schema = z
    .object({ team: z.enum(["a", "b"]) })
    .transform(({ team }) => ({ queue: team }))
    .readonly();
  const run = await client.about("ticket").run(schema);
  const queue: "a" | "b" = run.value.queue;
  // @ts-expect-error output transform must not expose input fields
  void run.value.team;
  // @ts-expect-error transformed readonly output survives the new provider
  run.value.queue = "a";
  const readable: ReadableStream<z.output<typeof schema>> = Streams.from(["x"])
    .map((v) => client.about(v).ask(schema))
    .toReadable();
  const replay: z.output<typeof schema> = (await run.replay()).value;
  const source: ProbabilitySource | undefined = run.diagnostics[0]?.answer.probabilitySource;
  void [queue, readable, replay, source];
}
void contracts;
