import { z } from "zod";
import { Questions, TypeSafe } from "../src/index.ts";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey)
  throw new Error(
    "Set TYPESAFE_API_KEY; this example makes two paid evaluations plus any configured retries.",
  );

const questions = Questions.create({
  model: TypeSafe.create({
    apiKey,
    timeoutMs: 15_000,
    retry: { maxRetries: 2, statusCodes: [429, 503, 529], initialDelayMs: 250, maxDelayMs: 2_000 },
    hooks: {
      onRetry: ({ nextAttempt, delayMs }) => {
        console.log("HTTP retry", { nextAttempt, delayMs });
      },
    },
  }),
});

const triage = z.object({
  urgent: z.boolean().describe("Does the incident block production work?"),
  team: z.enum(["billing", "platform"]).describe("Which team should investigate?"),
});
const prepared = await questions
  .about("The production API returns 503 after deployment.")
  .prepare(triage);
const first = await prepared.run({ signal: AbortSignal.timeout(15_000) });
console.log("First decision", first.value, first.evidence?.usage);
// This deliberately performs another inference, not a cache read or a replay of business actions.
const second = await first.replay({ signal: AbortSignal.timeout(15_000) });
console.log("Second decision", second.value, second.evidence?.usage);
