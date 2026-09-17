/**
 * Lesson 17 — use a language model for finite decisions, not free-form generation.
 * Prerequisites: AI SDK 7 and one configured provider (included as development dependencies).
 * Run: GENERATIVE_PROVIDER=google GENERATIVE_MODEL=<model-id> GOOGLE_GENERATIVE_AI_API_KEY=<key>
 *      bun examples/17-generative-models.ts
 * Cost: one potentially paid inference. There is no automatic comparison, replay or repair.
 * Output: validated release assessment, field diagnostics and explicit estimated provenance.
 * Probabilities are elicited estimates, not measured model accuracy; validate your own thresholds.
 */
import { z } from "zod";
import { Questions, Schema } from "../src/index.ts";
import * as Generative from "../src/providers/generative.ts";
import { cli, required } from "./shared/runtime.ts";

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
export async function tutorial(model: Generative.Model) {
  const client = Questions.create({
    model: Generative.create({
      model,
      evidence: "estimated",
      timeout: "20 seconds",
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

/** Model IDs and credentials are explicit; import only the selected provider's factory. */
async function languageModel(): Promise<Generative.Model> {
  const id = required("GENERATIVE_MODEL");
  switch (required("GENERATIVE_PROVIDER")) {
    case "google": {
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey: required("GOOGLE_GENERATIVE_AI_API_KEY") })(id);
    }
    case "anthropic": {
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey: required("ANTHROPIC_API_KEY") })(id);
    }
    case "openai": {
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey: required("OPENAI_API_KEY") })(id);
    }
    case "gateway": {
      const { createGateway } = await import("@ai-sdk/gateway");
      // This is a LANGUAGE model, not gateway.evaluationModel("typesafe-ai/jev").
      return createGateway({ apiKey: required("AI_GATEWAY_API_KEY") })(id);
    }
    default:
      throw new Error("Set GENERATIVE_PROVIDER to google, anthropic, openai or gateway.");
  }
}

if (import.meta.main)
  await cli(async () => {
    const result = await tutorial(await languageModel());
    // These fictional demo diagnostics can include prompt text. Do not log real inputs indiscriminately.
    console.log(JSON.stringify(result, null, 2));
  });
