import ms from "ms";
import { ValidationError } from "./errors.ts";

/** Supported fixed units. Months/years are deliberately excluded from execution deadlines. */
export type Unit =
  | "ms"
  | "msec"
  | "msecs"
  | "millisecond"
  | "milliseconds"
  | "millis"
  | "milis"
  | "s"
  | "sec"
  | "secs"
  | "second"
  | "seconds"
  | "m"
  | "min"
  | "mins"
  | "minute"
  | "minutes"
  | "h"
  | "hr"
  | "hrs"
  | "hour"
  | "hours"
  | "d"
  | "day"
  | "days"
  | "w"
  | "week"
  | "weeks";
/** Literal-friendly durations; widened environment strings should use Duration.parse(). */
export type StringValue = `${number}${"" | " "}${Unit | Uppercase<Unit> | Capitalize<Unit>}`;
/** Numbers retain their original meaning: milliseconds. Strings must include an explicit unit. */
export type Input = number | StringValue;

/**
 * Parse external configuration into nonnegative, finite milliseconds using the ms package.
 * Requires an explicit unit for strings and rejects partial input, typos, sub-ms precision and
 * calendar units. It never repairs unknown units ("10 secods" is an error, not ten seconds).
 * @example
 * Duration.parse(process.env.REQUEST_TIMEOUT ?? "15 seconds");
 * Duration.parse("200 milis"); // 200; millis/milis are explicit aliases for milliseconds
 */
export function parse(value: string | number): number {
  let result: number;
  if (typeof value === "number") result = value;
  else {
    if (typeof value !== "string" || value.length > 100)
      throw new ValidationError("expected a duration of at most 100 characters", "duration");
    const match =
      /^(\d+(?:\.\d+)?|\.\d+)\s*(ms|msecs?|milliseconds?|millis|milis|s|secs?|seconds?|m|mins?|minutes?|h|hrs?|hours?|d|days?|w|weeks?)$/i.exec(
        value.trim(),
      );
    if (!match)
      throw new ValidationError(
        'expected a duration such as "200 ms", "10 seconds" or "2 min"',
        "duration",
      );
    const unit = /^(milis|millis)$/i.test(match[2]!) ? "ms" : match[2]!;
    // Anchored grammar above validates the entire input before narrowing for ms.
    result = ms(`${match[1]} ${unit}` as ms.StringValue);
  }
  if (!Number.isSafeInteger(result) || result < 0)
    throw new ValidationError(
      "expected nonnegative whole milliseconds within the safe integer range",
      "duration",
    );
  return result;
}

/**
 * Convert a typed duration to milliseconds; numeric inputs are already milliseconds.
 * @example
 * Duration.toMilliseconds("1.5 s"); // 1500
 * Duration.toMilliseconds(250); // 250
 */
export function toMilliseconds(value: Input): number {
  return parse(value);
}
