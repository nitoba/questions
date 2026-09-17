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
import type { Model as LanguageModel } from "../../src/providers/generative.ts";

/** Explicit configuration inputs keep tests independent of ambient credentials. */
export type Environment = Readonly<Record<string, string | undefined>>;

/** Examples read credentials only when their CLI is invoked, never when imported by tests. */
export function required(name: string, env: Environment = process.env): string {
  const value = env[name];
  if (!value?.trim())
    throw new Error(`Set ${name}; see examples/README.md. Live evaluations can incur charges.`);
  return value;
}

/**
 * Configure exactly one LanguageModelV4. Model IDs are account-specific and never guessed.
 * This is configuration plumbing, not an evaluation: constructing a model makes no paid call.
 * A supplied fetch is used by contract tests; live examples use the vendor SDK's transport.
 */
export async function languageModel(
  env: Environment = process.env,
  fetcher?: typeof fetch,
): Promise<LanguageModel> {
  const provider = required("GENERATIVE_PROVIDER", env);
  const id = required("GENERATIVE_MODEL", env);
  const transport = fetcher === undefined ? {} : { fetch: fetcher };
  switch (provider) {
    case "google": {
      const apiKey = required("GOOGLE_GENERATIVE_AI_API_KEY", env);
      const { createGoogleGenerativeAI } = await import("@ai-sdk/google");
      return createGoogleGenerativeAI({ apiKey, ...transport })(id);
    }
    case "anthropic": {
      const apiKey = required("ANTHROPIC_API_KEY", env);
      const { createAnthropic } = await import("@ai-sdk/anthropic");
      return createAnthropic({ apiKey, ...transport })(id);
    }
    case "openai": {
      const apiKey = required("OPENAI_API_KEY", env);
      const { createOpenAI } = await import("@ai-sdk/openai");
      return createOpenAI({ apiKey, ...transport })(id);
    }
    case "gateway": {
      const apiKey = required("AI_GATEWAY_API_KEY", env);
      const { createGateway } = await import("@ai-sdk/gateway");
      // A language model, NOT gateway.evaluationModel("typesafe-ai/jev").
      return createGateway({ apiKey, ...transport })(id);
    }
    default:
      throw new Error("Set GENERATIVE_PROVIDER to google, anthropic, openai or gateway.");
  }
}

/**
 * Choose an evaluation protocol or prompted generation without changing a tutorial's questions.
 * Native remains the default. Generative selection is explicit, including estimated evidence.
 * No missing key/model causes a fallback to another provider, mock or implicit SDK routing.
 */
export async function liveModel(
  env: Environment = process.env,
  fetcher?: typeof fetch,
): Promise<QuestionModel> {
  const timeout = Duration.parse(env.EXAMPLE_TIMEOUT ?? "20 seconds");
  const transport = fetcher === undefined ? {} : { fetch: fetcher };
  switch (env.QUESTIONS_PROVIDER ?? "typesafe") {
    case "typesafe":
      return TypeSafe.create({
        apiKey: required("TYPESAFE_API_KEY", env),
        timeout,
        retry: false,
        ...transport,
      });
    case "vercel": {
      const Vercel = await import("../../src/providers/vercel.ts");
      return Vercel.create({
        apiKey: required("AI_GATEWAY_API_KEY", env),
        timeout,
        retry: false,
        ...transport,
      });
    }
    case "generative": {
      const Generative = await import("../../src/providers/generative.ts");
      return Generative.create({
        model: await languageModel(env, fetcher),
        evidence: "estimated",
        timeout,
        maxRetries: 0, // SDK retries, not the ofetch policy used by native integrations.
      });
    }
    default:
      throw new Error(
        "Set QUESTIONS_PROVIDER to typesafe, vercel or generative. See tutorial 12 for custom hosts.",
      );
  }
}

/** Only configuration plumbing is shared. Each tutorial shows its own actual Questions calls. */
export async function liveClient(
  env: Environment = process.env,
  fetcher?: typeof fetch,
): Promise<QuestionsClient> {
  return Questions.create({
    model: await liveModel(env, fetcher),
    defaults: { timeout: "30 seconds" },
  });
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
