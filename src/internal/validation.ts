import { ValidationError } from "../errors.ts";
import type { JsonValue, State } from "../types.ts";

export function record(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ValidationError("expected an object", path);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new ValidationError("expected a plain object", path);
  }
  return value as Record<string, unknown>;
}

export function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError("expected non-empty text", path);
  }
  return value;
}

export function finite(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ValidationError("expected a finite number", path);
  }
  return value;
}

export function probability(value: unknown, path: string): number {
  const number = finite(value, path);
  if (number < 0 || number > 1) throw new ValidationError("expected a number in [0, 1]", path);
  return number;
}

export function integer(value: unknown, minimum: number, path: string): number {
  const number = finite(value, path);
  if (!Number.isSafeInteger(number) || number < minimum) {
    throw new ValidationError(`expected an integer >= ${minimum}`, path);
  }
  return number;
}

export function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  path: string,
): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new ValidationError("keys do not match the declared questions or options", path);
  }
}

/** Snapshot and freeze JSON, rejecting cycles, undefined, sparse arrays and class instances. */
export function json(value: unknown, path: string, parents = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return finite(value, path);
  if (typeof value !== "object") throw new ValidationError("expected JSON-compatible data", path);
  if (parents.has(value)) throw new ValidationError("cyclic data is not supported", path);
  if (parents.size >= 100) throw new ValidationError("JSON nesting exceeds 100 levels", path);
  parents.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonValue[] = [];
      for (let index = 0; index < value.length; index++) {
        result.push(json(value[index], `${path}[${index}]`, parents));
      }
      return Object.freeze(result);
    }
    return Object.freeze(
      Object.fromEntries(
        Object.entries(record(value, path)).map(([key, entry]) => [
          key,
          json(entry, `${path}.${key}`, parents),
        ]),
      ),
    );
  } finally {
    parents.delete(value);
  }
}

export function state(value: unknown, path = "state"): State {
  const result = json(value, path);
  if (result === null || typeof result === "number" || typeof result === "boolean") {
    throw new ValidationError("expected text, an object, or an array", path);
  }
  return result;
}
