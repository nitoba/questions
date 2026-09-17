/**
 * 11 — Compare a procurement assessment without accidentally reading new context.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/11-preparation-and-replay.ts
 * Two evaluations; COMPARE_PROVIDER explicitly adds a third, separately paid evaluation.
 * See examples/README.md for generative and cross-provider comparison configuration.
 * No streams. Zod. Learn: prepare/run, immutable inputs, value/evidence, replay after failure.
 */
import { z } from "zod";
import { type QuestionsClient, type QuestionModel } from "../src/index.ts";
import { cli, liveClient, liveModel, required, type Environment } from "./shared/runtime.ts";

const eligibility = z.object({
  equipment: z.boolean().describe("Does the opportunity concern equipment procurement?"),
  remoteSubmission: z.boolean().describe("Does the notice explicitly permit online submission?"),
});
export async function main(client: QuestionsClient, alternative?: QuestionModel) {
  let currentNotice = "Supply 20 laptops. Bids may be submitted using the online portal.";
  const q = client.about(() => ({ notice: currentNotice }));
  const prepared = await q.prepare(eligibility);
  currentNotice = "Updated notice: bids must be delivered in person.";

  const first = await prepared.run({ timeout: "20 seconds" });
  const second = await first.replay({ timeout: "20 seconds" });
  // first and second both used the ORIGINAL notice. q.run(eligibility) would read the update.
  // prepared.run() remains usable after rejection, when there is no successful Execution to replay.
  const comparison = alternative
    ? await first.replay({ model: alternative, confidence: 0 })
    : undefined;
  console.log({
    first: first.value,
    second: second.value,
    operationIds: [first.operationId, second.operationId],
    comparison: comparison?.value,
    // Both kinds of evidence can be structurally valid without comparable calibration.
    probabilitySources: [first, second, ...(comparison ? [comparison] : [])].map((run) =>
      run.diagnostics.map((field) => field.answer.probabilitySource ?? "unreported"),
    ),
  });
  return { prepared, first, second, comparison };
}
/** Explicit comparison only. Reuse credentials, but never silently reuse a generative model ID. */
export async function comparisonModel(
  env: Environment = process.env,
): Promise<QuestionModel | undefined> {
  if (env.COMPARE_PROVIDER !== undefined && env.COMPARE_WITH_VERCEL === "1")
    throw new Error("Set only COMPARE_PROVIDER; do not combine it with COMPARE_WITH_VERCEL.");
  const target = env.COMPARE_PROVIDER ?? (env.COMPARE_WITH_VERCEL === "1" ? "vercel" : undefined);
  if (target === undefined) return undefined;
  if (target !== "typesafe" && target !== "vercel" && target !== "generative")
    throw new Error("Set COMPARE_PROVIDER to typesafe, vercel or generative, or leave it unset.");
  return liveModel({
    ...env,
    QUESTIONS_PROVIDER: target,
    ...(target === "generative"
      ? {
          GENERATIVE_PROVIDER: required("COMPARE_GENERATIVE_PROVIDER", env),
          GENERATIVE_MODEL: required("COMPARE_GENERATIVE_MODEL", env),
        }
      : {}),
  });
}

if (import.meta.main)
  await cli(async () => {
    // Resolve both configurations before spending on the first evaluation.
    const alternative = await comparisonModel();
    await main(await liveClient(), alternative);
  });
