/**
 * 10 — An unreliable upstream: explicit retry policy, safe HTTP hooks and total deadlines.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/10-http-retries-and-deadlines.ts
 * One semantic evaluation, up to three HTTP attempts. No Zod and no streams.
 * This example does not manufacture a 503. Tests inject HTTP failures without using a paid model.
 * Retry a POST only when duplicate inference/billing is acceptable; handlers are never retried.
 */
import { Duration, Questions, TypeSafe, type DurationInput } from "../src/index.ts";
import { cli, failureKind, required } from "./shared/runtime.ts";

export function configuredModel(apiKey: string, fetcher?: typeof globalThis.fetch) {
  const delays = ["200 milis", "1 second"] as const satisfies readonly DurationInput[];
  return TypeSafe.create({
    apiKey,
    ...(fetcher ? { fetch: fetcher } : {}),
    timeout: "8 seconds",
    retry: {
      maxRetries: 2,
      statusCodes: [429, 503, 529],
      networkErrors: false,
      delay: ({ attempt }) => delays[Math.min(attempt - 1, delays.length - 1)]!,
      maxDelay: "2 seconds",
    },
    hooks: {
      onRequest: ({ attempt }) => {
        console.log("HTTP attempt", attempt);
      },
      onResponse: ({ status }) => {
        console.log("Headers arrived", status);
      },
      onRetry: ({ nextAttempt, delayMs }) => {
        console.log("Waiting", delayMs, "before", nextAttempt);
      },
      onError: ({ error }) => {
        console.log("Transport failed", error.kind);
      },
    },
  });
}
export async function main(apiKey: string, fetcher?: typeof globalThis.fetch) {
  // Strings from .env must be parsed, rather than cast to DurationInput.
  const deadline = Duration.parse(process.env.EXAMPLE_TIMEOUT ?? "10 seconds");
  const client = Questions.create({ model: configuredModel(apiKey, fetcher) });
  const controller = new AbortController();
  const cancel = () => controller.abort(new DOMException("Interrupted", "AbortError"));
  process.once("SIGINT", cancel);
  try {
    const value = await client
      .about("The shipment has not moved for five days.")
      .is("Does this need carrier investigation?", {
        timeout: deadline, // Includes context, semantic hooks, retries and output validation.
        signal: controller.signal,
      });
    console.log({ value, milliseconds: Duration.toMilliseconds("1.5 s") });
    return value;
  } catch (error) {
    console.error(failureKind(error)); // Do not log raw transport causes.
    throw error;
  } finally {
    process.off("SIGINT", cancel);
  }
}
if (import.meta.main) await cli(async () => main(required("TYPESAFE_API_KEY")));
