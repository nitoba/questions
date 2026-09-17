import {
  Duration,
  Questions,
  TypeSafe,
  ProviderError,
  SchemaValidationError,
  UncertainDecision,
  TimeoutError,
  ValidationError,
} from "../../src/index.ts";
import type { QuestionModel, QuestionsClient } from "../../src/index.ts";

/** Examples read credentials only when their CLI is invoked, never when imported by tests. */
export function required(name: string): string {
  const value = process.env[name];
  if (!value)
    throw new Error(`Set ${name}; see examples/README.md. Live evaluations can incur charges.`);
  return value;
}

/** Use the direct provider by default; switching hosts never changes a tutorial's questions. */
export async function liveModel(): Promise<QuestionModel> {
  const timeout = Duration.parse(process.env.EXAMPLE_TIMEOUT ?? "20 seconds");
  switch (process.env.QUESTIONS_PROVIDER ?? "typesafe") {
    case "typesafe":
      return TypeSafe.create({ apiKey: required("TYPESAFE_API_KEY"), timeout, retry: false });
    case "vercel": {
      const Vercel = await import("../../src/providers/vercel.ts");
      return Vercel.create({ apiKey: required("AI_GATEWAY_API_KEY"), timeout });
    }
    default:
      throw new Error(
        "QUESTIONS_PROVIDER must be typesafe or vercel. See tutorial 12 for custom hosts.",
      );
  }
}

/** Only configuration plumbing is shared. Each tutorial shows its own actual Questions calls. */
export async function liveClient(): Promise<QuestionsClient> {
  return Questions.create({ model: await liveModel(), defaults: { timeout: "30 seconds" } });
}

/** Do not print transport causes, contexts, or model judgments in a default error logger. */
export function failureKind(error: unknown): string {
  if (error instanceof UncertainDecision) return "needs-review";
  if (error instanceof SchemaValidationError) return "schema-rejected";
  if (error instanceof TimeoutError) return "timeout";
  if (error instanceof ProviderError) return `provider-${error.kind}`;
  if (error instanceof ValidationError) return "invalid-input-or-evidence";
  if (error instanceof DOMException && error.name === "AbortError") return "aborted";
  return "application";
}

/** Entry-point boundary: errors produce a nonzero exit code without exposing provider secrets. */
export async function cli(work: () => Promise<unknown>): Promise<void> {
  try {
    await work();
  } catch (error) {
    console.error(`Example failed (${failureKind(error)}).`);
    // Missing configuration is local, deliberate guidance rather than a remote error cause.
    if (error instanceof Error && error.message.startsWith("Set ")) console.error(error.message);
    process.exitCode = 1;
  }
}
