/**
 * 12 — Choose a protocol, not just a base URL.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/12-providers-and-custom-models.ts typesafe
 * Modes: typesafe | jev | vercel | sdk | system-one | generative. Exactly one evaluation in the selected mode.
 * No Zod and no streams. Optional SDK imports are lazy; credentials are always explicit.
 * Learn: native presets, a custom host, existing Evaluation V4 models and QuestionModel decoration.
 */
import { Questions, TypeSafe, SystemOne, Jev, type QuestionModel } from "../src/index.ts";
import { cli, liveModel, required } from "./shared/runtime.ts";

/** A real decorator, not a fake LLM. It forwards the full request, original this, and signal. */
export function measured(model: QuestionModel, record: (elapsedMs: number) => void): QuestionModel {
  const evaluate = model.evaluate.bind(model);
  return {
    name: `measured:${model.name}`,
    async evaluate(request, options) {
      const started = performance.now();
      try {
        return await evaluate(request, options); // Remains unknown; Questions validates evidence.
      } finally {
        record(performance.now() - started);
      }
    },
  };
}
export async function selectedProvider(mode: string): Promise<QuestionModel> {
  switch (mode) {
    case "typesafe":
      return TypeSafe.create({ apiKey: required("TYPESAFE_API_KEY"), timeout: "15 s" });
    case "jev":
      return Jev.create({ apiKey: required("TYPESAFE_API_KEY"), timeout: "15 s" });
    case "system-one":
      return SystemOne.create({
        baseURL: required("INFERENCE_BASE_URL"),
        model: required("INFERENCE_MODEL"),
        apiKey: required("INFERENCE_API_KEY"),
        timeout: "15 s",
        headers: { "x-project-id": "questions-tutorial" },
      });
    case "vercel": {
      const Vercel = await import("../src/providers/vercel.ts");
      return Vercel.create({ apiKey: required("AI_GATEWAY_API_KEY"), timeout: "15 s" });
    }
    case "sdk": {
      const { createGateway } = await import("@ai-sdk/gateway");
      const AISDK = await import("../src/providers/ai-sdk.ts");
      const gateway = createGateway({ apiKey: required("AI_GATEWAY_API_KEY") });
      return AISDK.create({
        model: gateway.evaluationModel("typesafe-ai/jev"),
        timeout: "15 s",
        // Optional policy: maximum mass, explicitly tagged "custom" in choice/score evidence.
        // This differs from both the native provider metric and the bridge's default top-two margin.
        confidence: (evidence) => Math.max(...Object.values(evidence.probabilities)),
      });
    }
    case "generative":
      // Tutorial 17 opens up this adapter; here we focus on the shared QuestionModel boundary.
      return liveModel({ ...process.env, QUESTIONS_PROVIDER: "generative" });
    default:
      throw new Error("Set the mode to typesafe, jev, vercel, sdk, system-one or generative.");
  }
}
export async function main(model: QuestionModel) {
  const timings: number[] = [];
  const client = Questions.create({ model: measured(model, (ms) => timings.push(ms)) });
  const evidence = await client.about("The course teaches TypeScript fundamentals.").evidence({
    beginnerFriendly: "Does the course target beginners?",
  });
  console.log({
    model: evidence.model,
    usage: evidence.usage,
    timings,
    probabilitySource: evidence.answers.beginnerFriendly.probabilitySource ?? "unreported",
  });
  return { evidence, timings };
}
if (import.meta.main)
  await cli(async () =>
    main(await selectedProvider(process.argv[2] ?? process.env.QUESTIONS_PROVIDER ?? "typesafe")),
  );
