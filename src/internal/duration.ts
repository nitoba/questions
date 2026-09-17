import { parse, type Input } from "../duration.ts";
import { ValidationError } from "../errors.ts";

/** @internal Read canonical and deprecated numeric forms, rejecting ambiguous configuration. */
export function resolve(
  value: Input | undefined,
  legacy: number | undefined,
  name: string,
  minimum = 0,
): number | undefined {
  if (value !== undefined && legacy !== undefined)
    throw new ValidationError(`supply ${name} or ${name}Ms, not both`, name);
  if (value === undefined && legacy === undefined) return undefined;
  if (legacy !== undefined && typeof legacy !== "number")
    throw new ValidationError("expected numeric milliseconds", `${name}Ms`);
  let result: number;
  try {
    result = parse(value ?? legacy!);
  } catch (cause) {
    throw new ValidationError('invalid duration; use e.g. "200 ms" or "10 seconds"', name, {
      cause,
    });
  }
  if (result < minimum || result > 2_147_483_647)
    throw new ValidationError(`expected milliseconds in [${minimum}, 2147483647]`, name);
  return result;
}
