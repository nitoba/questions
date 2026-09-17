/**
 * 08 — Document intake: explain which INPUT field rejected a decision.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/08-schema-diagnostics.ts
 * Or select QUESTIONS_PROVIDER=generative; see the shared configuration in examples/README.md.
 * One evaluation. Zod, no streams. diagnose() adds ZERO inference and ZERO Zod callbacks.
 * Learn: fields, opaque question IDs, lossless paths, inactive optional fields, typed failures.
 */
import { z } from "zod";
import {
  Schema,
  SchemaValidationError,
  UncertainDecision,
  type QuestionsClient,
} from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export const intake = z.object({
  "document.kind": z.enum(["invoice", "letter"]), // A literal dotted key, not a nested path.
  document: z.object({
    kind: z.enum(["original", "copy"]),
    attachment: z.boolean().optional(),
  }),
});

export async function main(client: QuestionsClient) {
  const compiled = Schema.compile(intake);
  console.table(
    compiled.fields.map(({ path, questionId, role }) => ({
      path: JSON.stringify(path),
      questionId,
      role,
    })),
  );
  const evidence = await client
    .about("An original invoice is attached, with no additional supporting files.")
    .evidence(compiled.questions);
  const diagnostics = compiled.diagnose(evidence, { confidence: 0.9 });
  console.table(
    diagnostics.map(({ path, active, confidence, confidencePassed, answer }) => ({
      path: JSON.stringify(path),
      active,
      confidence,
      confidencePassed,
      probabilitySource: answer.probabilitySource ?? "unreported",
      confidenceSource:
        answer.type === "boolean"
          ? "boolean-separation"
          : (answer.confidenceSource ?? "unreported"),
    })),
  );
  try {
    const value = await compiled.parse(evidence, { confidence: 0.9 });
    console.log(value);
  } catch (error) {
    if (error instanceof UncertainDecision) {
      console.log("Request human review for input field", error.path, error.questionId);
    } else if (error instanceof SchemaValidationError) {
      console.log(
        "Local schema rejected paths",
        error.issues.map((issue) => issue.path),
      );
    } else {
      throw error;
    }
  }
  return { fields: compiled.fields, diagnostics };
}
if (import.meta.main) await cli(async () => main(await liveClient()));
