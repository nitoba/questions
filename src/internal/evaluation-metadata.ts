import { ValidationError } from "../errors.ts";
import type { Rounding, Usage, EvaluationWarning } from "../model.ts";
import type { JsonObject } from "../types.ts";
import { integer, json, record } from "./validation.ts";

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new ValidationError("expected a string", path);
  return value;
}

/** @internal Missing counters are unknown, not zero; the envelope still requires a usage object. */
export function usage(value: unknown): Usage {
  const object = record(value, "response.usage");
  return Object.freeze({
    ...(object.inputTokens === undefined
      ? {}
      : { inputTokens: integer(object.inputTokens, 0, "response.usage.inputTokens") }),
    ...(object.outputTokens === undefined
      ? {}
      : { outputTokens: integer(object.outputTokens, 0, "response.usage.outputTokens") }),
  });
}

/** @internal Match the Evaluation V4 precision contract; reject invalid or excessively broad declarations. */
export function rounding(value: unknown): Rounding | undefined {
  if (value === undefined) return undefined;
  const object = record(value, "response.rounding");
  const fields = ["probabilityDecimals", "scoreDecimals"] as const;
  for (const key of Object.keys(object)) {
    if (!fields.includes(key as (typeof fields)[number]))
      throw new ValidationError("unknown rounding field", `response.rounding.${key}`);
  }
  return Object.freeze(
    Object.fromEntries(
      fields.flatMap((key) => {
        if (object[key] === undefined) return [];
        const decimals = integer(object[key], 0, `response.rounding.${key}`);
        if (decimals > 15)
          throw new ValidationError("at most 15 decimal places", `response.rounding.${key}`);
        return [[key, decimals]];
      }),
    ),
  );
}

/** @internal Half a unit in the last reported decimal place. */
export function roundingError(decimals: number | undefined): number {
  return decimals === undefined ? 0 : 0.5 * 10 ** -decimals;
}

/** @internal Snapshot provider namespaces; never retain raw response bodies or headers. */
export function providerMetadata(value: unknown): Readonly<Record<string, JsonObject>> | undefined {
  if (value === undefined) return undefined;
  const object = record(value, "response.providerMetadata");
  for (const [key, entry] of Object.entries(object))
    record(entry, `response.providerMetadata.${key}`);
  return json(object, "response.providerMetadata") as Readonly<Record<string, JsonObject>>;
}

/** @internal Preserve standardized warnings without an implicit console side effect. */
export function warnings(value: unknown): readonly EvaluationWarning[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value))
    throw new ValidationError("expected warnings array", "response.warnings");
  return Object.freeze(
    value.map((raw, index) => {
      const path = `response.warnings[${index}]`;
      const item = record(raw, path);
      switch (item.type) {
        case "unsupported":
        case "compatibility":
          return Object.freeze({
            type: item.type,
            feature: string(item.feature, `${path}.feature`),
            ...(item.details === undefined
              ? {}
              : { details: string(item.details, `${path}.details`) }),
          });
        case "deprecated":
          return Object.freeze({
            type: item.type,
            setting: string(item.setting, `${path}.setting`),
            message: string(item.message, `${path}.message`),
          });
        case "other":
          return Object.freeze({
            type: item.type,
            message: string(item.message, `${path}.message`),
          });
        default:
          throw new ValidationError("unknown warning type", `${path}.type`);
      }
    }),
  );
}
