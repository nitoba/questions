/**
 * 07b — Structured survey decisions: wrappers, tuples, literal unions and Zod Mini.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/07b-zod-advanced-inputs.ts
 * Or select QUESTIONS_PROVIDER=generative; see the shared configuration in examples/README.md.
 * Two evaluations and one constant-only parse. Zod Classic/Mini; no streams.
 * Learn: nullable/optional/default presence, numeric literals, output refinement/brand/readonly.
 * These input wrappers create finite questions. A free-form z.string() or z.array() does not.
 */
import { z } from "zod";
import * as mini from "zod/mini";
import { Schema, type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export const survey = z
  .object({
    department: z.enum(["engineering", "design"]).optional(),
    remote: z.boolean().nullable(),
    renewal: z.enum(["yes", "no"]).default("no"),
    satisfaction: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .describe("Choose the stated survey rating, or the closest supported level."),
    onboarding: z.tuple([
      z.boolean().describe("Was setup easy?"),
      z.boolean().describe("Was documentation sufficient?"),
    ]),
  })
  .refine((value) => value.satisfaction >= 1, "A survey rating must be positive")
  .transform(async (value) => ({ ...value, reviewedBy: "survey-pipeline" as const }))
  .brand<"SurveyDecision">()
  .readonly();

export async function main(client: QuestionsClient) {
  const result = await client
    .about(
      "An engineer rated onboarding 3/3. Setup was easy, but docs were thin. They want to renew.",
    )
    .ask(survey);
  const constant = await client
    .about(() => {
      throw new Error("A constant-only schema must not read context.");
    })
    .ask(z.object({ format: z.literal("survey-v1") }));
  const miniSchema = mini.object({
    needsDocumentation: Schema.annotate(mini.boolean(), {
      instructions: "Does the feedback request better documentation?",
    }),
  });
  // Schema-driven collection batching preserves one output per item in input order.
  const miniResult = await client
    .each([
      "Please add more setup examples to the documentation.",
      "The current documentation answered all of my questions.",
    ])
    .ask(miniSchema);

  console.log({ result, constant, miniResult, frozen: Object.isFrozen(result) });
  return { result, constant, miniResult };
}
if (import.meta.main) await cli(async () => main(await liveClient()));
