import { apiKey as validateKey } from "../internal/http.ts";
import type { QuestionModel } from "../model.ts";
import * as SystemOne from "./system-one.ts";

/** TypeSafe defaults with explicit credentials. All transport options remain available. */
export interface Options extends Omit<
  SystemOne.Options,
  "name" | "model" | "baseURL" | "apiKey" | "path" | "maxCriteria"
> {
  readonly apiKey: string;
  /** Defaults to jev-latest. */
  readonly model?: string;
  /** Defaults to https://api.typesafe.ai/v1. */
  readonly baseURL?: string;
}
export type { RetryOptions } from "./system-one.ts";

/**
 * Create the TypeSafe AI provider. This is a preset of the System One HTTP transport.
 * Credentials are explicit; no environment variables, SDK retries or global clients are used.
 * @example
 * const model = TypeSafe.create({ apiKey, timeoutMs: 15_000 });
 * const result = await Questions.create({ model }).about(ticket).ask(schema);
 */
export function create(options: Options): QuestionModel {
  return SystemOne.create({
    ...options,
    apiKey: validateKey(options.apiKey),
    name: "TypeSafe",
    model: options.model ?? "jev-latest",
    baseURL: options.baseURL ?? "https://api.typesafe.ai/v1",
    maxCriteria: 255,
    path: "systemone",
  });
}
