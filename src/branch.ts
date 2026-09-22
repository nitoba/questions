import type { CallContext, Awaitable } from "./types.ts";
import type { OperationOptions } from "./lifecycle.ts";
import type { ChoiceAnswer } from "./answer.ts";
import { rank } from "./answer.ts";
import * as Question from "./question.ts";
import { ValidationError } from "./errors.ts";
import { probability, record, text } from "./internal/validation.ts";

/** An ordinary local function. The model selects it but never generates its arguments. */
export type BranchHandler = (context: CallContext) => unknown;
/** A local handler with separate, serializable routing guidance. */
export interface DescriptiveBranch {
  readonly description: string;
  readonly examples?: readonly string[];
  /** Local eligibility, not authorization. Disabled handlers never become model alternatives. */
  readonly enabled?: boolean;
  readonly run: BranchHandler;
}
/** Function-only maps remain compatible. Descriptors may be mixed with existing functions. */
export type Branches = Readonly<Record<string, BranchHandler | DescriptiveBranch>>;
/** Infer the union of the original synchronous/async handler results. */
export type BranchValue<H extends Branches> = {
  [K in keyof H]: Awaited<
    ReturnType<
      H[K] extends BranchHandler ? H[K] : H[K] extends DescriptiveBranch ? H[K]["run"] : never
    >
  >;
}[keyof H];
/** Acceptance criteria computed locally from the complete routing distribution. */
export interface BranchSelection {
  readonly minProbability?: number;
  readonly minMargin?: number;
  /** Add an explicit rejection alternative. Never select a sole enabled handler by elimination. */
  readonly allowUnmatched?: boolean;
}
/** A ranked routing option. null identifies the internal rejection alternative without reserving IDs. */
export interface RankedBranch {
  readonly id: string | null;
  readonly probability: number;
}
/** Reasons a routing distribution cannot confidently select an operation. */
export type BranchUncertaintyReason = "tie" | "min-probability" | "min-margin";
/** Validated routing evidence passed only to an explicitly configured uncertainty handler. */
export interface UncertainBranchContext extends CallContext {
  readonly reason: BranchUncertaintyReason;
  readonly ranked: readonly RankedBranch[];
  readonly evidence: ChoiceAnswer;
}
/** A request outside the available operations, or no locally enabled operations. */
export interface UnmatchedBranchContext extends CallContext {
  readonly reason: "unmatched" | "unavailable";
  readonly ranked: readonly RankedBranch[];
  readonly evidence: ChoiceAnswer | undefined;
}
/** Existing operation/confidence settings plus opt-in semantic routing criteria and fallbacks. */
export interface BranchOptions<U = never, M = never> extends OperationOptions {
  readonly selection?: BranchSelection;
  /** Only routing ambiguity, not provider, schema, confidence-gate, timeout or handler failures. */
  readonly onUncertain?: (context: UncertainBranchContext) => Awaitable<U>;
  readonly onUnmatched?: (context: UnmatchedBranchContext) => Awaitable<M>;
}

/** @internal Snapshot before reading asynchronous application context. */
export interface Routing {
  readonly question: Question.ChoiceQuestion | undefined;
  readonly handlers: Readonly<Record<string, BranchHandler>>;
  readonly unmatchedKey: string | undefined;
  readonly legacy: boolean;
  readonly minProbability: number;
  readonly minMargin: number;
}
/** @internal Describe functions but never serialize application functions or captured values. */
export function prepareRouting(
  question: string,
  branches: Branches,
  options: BranchOptions<unknown, unknown>,
): Routing {
  text(question, "branch.question");
  const input = Object.entries(record(branches, "branches"));
  const selection =
    options.selection === undefined ? {} : record(options.selection, "branch.selection");
  for (const key of Object.keys(selection))
    if (!["minProbability", "minMargin", "allowUnmatched"].includes(key))
      throw new ValidationError("unknown routing criterion", `branch.selection.${key}`);
  if (selection.allowUnmatched !== undefined && typeof selection.allowUnmatched !== "boolean")
    throw new ValidationError("expected a boolean", "branch.selection.allowUnmatched");
  const minProbability = probability(
    selection.minProbability === undefined ? 0 : selection.minProbability,
    "branch.selection.minProbability",
  );
  const minMargin = probability(
    selection.minMargin === undefined ? 0 : selection.minMargin,
    "branch.selection.minMargin",
  );
  for (const name of ["onUncertain", "onUnmatched"] as const)
    if (options[name] !== undefined && typeof options[name] !== "function")
      throw new ValidationError("expected a function", `branch.${name}`);
  let legacy =
    options.selection === undefined &&
    options.onUncertain === undefined &&
    options.onUnmatched === undefined;
  const handlers: [string, BranchHandler][] = [];
  const descriptions: [
    string,
    { readonly description: string; readonly examples?: readonly string[] } | string,
  ][] = [];
  for (const [id, value] of input) {
    if (typeof value === "function") {
      handlers.push([id, value as BranchHandler]);
      descriptions.push([id, id]);
      continue;
    }
    legacy = false;
    const descriptor = record(value, `branches.${id}`);
    const description = text(descriptor.description, `branches.${id}.description`);
    if (typeof descriptor.run !== "function")
      throw new ValidationError("expected a function", `branches.${id}.run`);
    if (descriptor.enabled !== undefined && typeof descriptor.enabled !== "boolean")
      throw new ValidationError("expected a boolean", `branches.${id}.enabled`);
    let examples: readonly string[] | undefined;
    if (descriptor.examples !== undefined) {
      if (!Array.isArray(descriptor.examples))
        throw new ValidationError("expected an array", `branches.${id}.examples`);
      examples = Object.freeze(
        descriptor.examples.map((value, index) => text(value, `branches.${id}.examples.${index}`)),
      );
    }
    if (descriptor.enabled === false) continue;
    handlers.push([id, descriptor.run as BranchHandler]);
    descriptions.push([
      id,
      Object.freeze({ description, ...(examples === undefined ? {} : { examples }) }),
    ]);
  }
  let unmatchedKey: string | undefined;
  if (selection.allowUnmatched === true && handlers.length > 0) {
    unmatchedKey = "__unmatched__";
    const ids = new Set(input.map(([id]) => id));
    while (ids.has(unmatchedKey)) unmatchedKey = `_${unmatchedKey}`;
    descriptions.push([
      unmatchedKey,
      "None of the available operations satisfies the user's request.",
    ]);
  }
  if (descriptions.length === 1)
    throw new ValidationError(
      "use at least two enabled branches or selection.allowUnmatched:true",
      "branches",
    );
  return Object.freeze({
    question:
      handlers.length === 0 && !legacy
        ? undefined
        : Question.choice(question, Object.fromEntries(descriptions)),
    handlers: Object.freeze(Object.fromEntries(handlers)),
    unmatchedKey,
    legacy,
    minProbability,
    minMargin,
  });
}
/** @internal A route is selected before any business or explicit fallback handler is entered. */
export type Route =
  | { readonly kind: "selected"; readonly handler: BranchHandler }
  | { readonly kind: "uncertain"; readonly details: Omit<UncertainBranchContext, "signal"> }
  | { readonly kind: "unmatched"; readonly details: Omit<UnmatchedBranchContext, "signal"> };
/** @internal Consume already validated evidence; do not reinterpret transport/handler failures. */
export function selectRoute(routing: Routing, evidence: ChoiceAnswer | undefined): Route {
  if (!evidence)
    return {
      kind: "unmatched",
      details: Object.freeze({
        reason: "unavailable",
        ranked: Object.freeze([]),
        evidence: undefined,
      }),
    };
  if (routing.legacy) return { kind: "selected", handler: routing.handlers[evidence.choice]! };
  const ranked = Object.freeze(
    rank(evidence).map(({ value, probability }) =>
      Object.freeze({ id: value === routing.unmatchedKey ? null : value, probability }),
    ),
  );
  const mass = ranked[0]!.probability;
  const margin = mass - ranked[1]!.probability;
  const reason: BranchUncertaintyReason | undefined =
    margin === 0
      ? "tie"
      : mass < routing.minProbability && routing.minProbability - mass > Number.EPSILON * 4
        ? "min-probability"
        : margin < routing.minMargin && routing.minMargin - margin > Number.EPSILON * 4
          ? "min-margin"
          : undefined;
  if (reason) return { kind: "uncertain", details: Object.freeze({ reason, ranked, evidence }) };
  if (ranked[0]!.id === null)
    return { kind: "unmatched", details: Object.freeze({ reason: "unmatched", ranked, evidence }) };
  return { kind: "selected", handler: routing.handlers[ranked[0]!.id!]! };
}
