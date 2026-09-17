import { apiKey as validateKey } from "../internal/http.ts";
import type { QuestionModel } from "../model.ts";
import type { Options as TypeSafeOptions } from "./typesafe.ts";
import { ValidationError } from "../errors.ts";
import * as SystemOne from "./system-one.ts";

/** Existing Jev configuration. Prefer TypeSafe.create for provider-oriented code. */
export interface Options extends TypeSafeOptions {
  /** Compatibility spelling for baseURL. Supplying both spellings is an error. */
  readonly baseUrl?: string;
}
export type { RetryOptions } from "./system-one.ts";

/**
 * Backwards-compatible TypeSafe preset, retaining the Jev diagnostic name and baseUrl spelling.
 * New code may use TypeSafe.create({ apiKey }) or another provider without changing questions.
 * @example
 * const model = Jev.create({ apiKey, baseUrl: "https://api.typesafe.ai/v1" });
 */
export function create(options: Options): QuestionModel {
  if (options.baseUrl !== undefined && options.baseURL !== undefined)
    throw new ValidationError("supply only baseURL or baseUrl, not both", "baseURL");
  return SystemOne.create({
    ...options,
    apiKey: validateKey(options.apiKey),
    name: "Jev",
    model: options.model ?? "jev-latest",
    baseURL: options.baseURL ?? options.baseUrl ?? "https://api.typesafe.ai/v1",
    maxCriteria: 255,
    path: "systemone",
  });
}
