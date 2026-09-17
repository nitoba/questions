/**
 * 07 — Inspect a return request with a Zod-defined output.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/07-zod-decision-schemas.ts
 * Or select QUESTIONS_PROVIDER=generative; see the shared configuration in examples/README.md.
 * One evaluation. Zod, no streams.
 * Learn: describe, metadata, typed annotations, probability vs score, z.output and transforms.
 * Input is a fixed set of decisions, not arbitrary generated strings or variable arrays.
 */
import { z } from "zod";
import { Schema, type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export const returnAssessment = z
  .object({
    damaged: z.boolean().describe("Does the customer report physical damage?"),
    reason: z.enum(["damaged", "wrong_item", "changed_mind", "unclear"]).meta({
      title: "Return category",
      description: "Which reason best matches the customer's account?",
      examples: ["damaged"],
      questions: {
        options: {
          damaged: "Reported breakage or damage",
          wrong_item: "A different product arrived",
          changed_mind: "No defect; the customer no longer wants it",
          unclear: "Insufficient evidence",
        },
      },
      ui: { widget: "select" }, // Application metadata is NOT forwarded to the provider.
    } satisfies Schema.Metadata),
    escalationProbability: Schema.annotate(z.number().min(0).max(1), {
      kind: "probability",
      instructions: "Will a specialist need to investigate this return?",
    }),
    disruption: z
      .number()
      .min(0)
      .max(2)
      .register(Schema.registry, {
        kind: "score",
        instructions: "How much does the reported issue impair use?",
        levels: ["Usable", "Partly usable", "Unusable"],
      }),
  })
  .transform((value) => ({
    ...value,
    reviewQueue: value.damaged ? "damage-review" : "returns-review",
  }));
export type ReturnAssessment = z.output<typeof returnAssessment>;

export async function main(client: QuestionsClient): Promise<ReturnAssessment> {
  const result = await client
    .about("The ceramic planter arrived in three broken pieces.")
    .ask(returnAssessment);
  // reviewQueue is produced by our deterministic transform, NOT extracted or invented by the model.
  console.log(result);
  return result;
}
if (import.meta.main) await cli(async () => main(await liveClient()));
