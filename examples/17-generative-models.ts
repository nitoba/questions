/**
 * Lesson 17 — use a language model for finite decisions, not free-form generation.
 * Prerequisites: AI SDK 7 and one configured provider (included as development dependencies).
 * Run: GENERATIVE_PROVIDER=google GENERATIVE_MODEL=<model-id> GOOGLE_GENERATIVE_AI_API_KEY=<key>
 *      bun examples/17-generative-models.ts
 * This dedicated lesson always uses Generative; QUESTIONS_PROVIDER is not consulted.
 * Other lessons use QUESTIONS_PROVIDER=generative with these same GENERATIVE_* settings.
 * Cost: one potentially paid inference. There is no automatic comparison, replay or repair.
 * Output: validated release assessment, field diagnostics and explicit estimated provenance.
 * Probabilities are elicited estimates, not measured model accuracy; validate your own thresholds.
 */
import { z } from "zod";
import { Questions, Schema, Duration, type DurationInput } from "../src/index.ts";
import * as Generative from "../src/providers/generative.ts";
import { cli, languageModel } from "./shared/runtime.ts";

const release = {
  changes: ["Database index added", "Cache invalidation changed"],
  observations: ["Staging tests pass", "Rollback procedure has not been rehearsed"],
};

export const assessment = z.object({
  needsReview: z.boolean().describe("Does this release require a human review before deployment?"),
  owner: z.enum(["platform", "application", "manual_review"]).meta({
    description: "Who should review the release?",
    questions: {
      options: {
        platform: "Database, infrastructure and deployment operations",
        application: "Application behavior and product regressions",
        manual_review: "The available information does not establish a responsible team",
      },
    },
  } satisfies Schema.Metadata),
  impact: z
    .number()
    .min(0)
    .max(2)
    .register(Schema.registry, {
      kind: "score",
      instructions: "What is the plausible operational impact?",
      levels: ["Small localized issue", "Service impaired", "Broad outage"],
    }),
});

/** Keep the same public schema regardless of the configured language model's provider. */
export async function tutorial(model: Generative.Model, timeout: DurationInput = "20 seconds") {
  const client = Questions.create({
    model: Generative.create({
      model,
      evidence: "estimated",
      timeout,
      maxRetries: 0,
    }),
    defaults: { timeout: "30 seconds" },
  });
  const run = await client.about(release).run(assessment);
  return {
    value: run.value,
    generation: run.evidence?.providerMetadata?.questionsGenerative,
    diagnostics: run.diagnostics,
  };
}

if (import.meta.main)
  await cli(async () => {
    const result = await tutorial(
      await languageModel(),
      Duration.parse(process.env.EXAMPLE_TIMEOUT ?? "20 seconds"),
    );
    // These fictional demo diagnostics can include prompt text. Do not log real inputs indiscriminately.
    console.log(JSON.stringify(result, null, 2));
  });
