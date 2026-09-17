import { z } from "zod";
import {
  Duration,
  Questions,
  Schema,
  TypeSafe,
  SchemaValidationError,
  UncertainDecision,
} from "../src/index.ts";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey)
  throw new Error("Set TYPESAFE_API_KEY; this example makes one potentially paid evaluation");

const questions = Questions.create({
  model: TypeSafe.create({ apiKey, timeout: "15 seconds", retry: false }),
  defaults: { timeout: Duration.parse(process.env.OPERATION_TIMEOUT ?? "30 seconds") },
  hooks: {
    onEvaluate: ({ operationId, operation }) => console.log("Started", operationId, operation),
    onDecision: ({ operationId, elapsedMs, usage }) =>
      console.log("Validated", operationId, elapsedMs, usage),
    onError: ({ operationId, kind, stage }) => console.log("Failed", operationId, kind, stage),
  },
});
const support = questions.extend({ defaults: { confidence: 0.6 } });
const schema = z.object({
  incident: z.object({
    urgent: z.boolean().describe("Does this incident prevent production work?"),
    team: z.enum(["billing", "platform"]).meta({
      description: "Which team should investigate?",
      questions: { options: { billing: "Payments and invoices", platform: "API and deployments" } },
    } satisfies Schema.Metadata),
  }),
});
const plan = Schema.compile(schema);
// These paths are available before any model request.
console.log(
  "Field mappings",
  plan.fields.map(({ path, questionId }) => ({ path, questionId })),
);

try {
  const run = await support.about("The production API returns 503 after deployment").run(schema);
  console.log(run.value);
  for (const field of run.diagnostics) {
    // Deliberate local inspection, not default production telemetry.
    console.log(JSON.stringify(field.path), field.role, field.confidence, field.confidencePassed);
  }
} catch (error) {
  if (error instanceof UncertainDecision)
    console.error("Needs review", error.path, error.questionId);
  else if (error instanceof SchemaValidationError) console.error("Schema rejected", error.issues);
  throw error;
}
