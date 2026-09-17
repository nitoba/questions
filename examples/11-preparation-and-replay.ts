/**
 * 11 — Compare a procurement assessment without accidentally reading new context.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/11-preparation-and-replay.ts
 * Two evaluations; add COMPARE_WITH_VERCEL=1 for a third, separately paid evaluation.
 * No streams. Zod. Learn: prepare/run, immutable inputs, value/evidence, replay after failure.
 */
import { z } from "zod";
import { type QuestionsClient, type QuestionModel } from "../src/index.ts";
import { cli, liveClient, required } from "./shared/runtime.ts";

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
  });
  return { prepared, first, second, comparison };
}
if (import.meta.main)
  await cli(async () => {
    const alternative =
      process.env.COMPARE_WITH_VERCEL === "1"
        ? (await import("../src/providers/vercel.ts")).create({
            apiKey: required("AI_GATEWAY_API_KEY"),
            timeout: "15 s",
          })
        : undefined;
    await main(await liveClient(), alternative);
  });
