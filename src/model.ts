import type { AnyQuestion, Batch } from "./question.ts";
import type { Answers } from "./answer.ts";
import type { JsonObject, RunOptions, State } from "./types.ts";

/** One batched evaluation. Question keys are transport IDs, not natural-language instructions. */
export interface EvaluationRequest {
  readonly state: State;
  readonly questions: Readonly<Record<string, AnyQuestion>>;
}
/** Implement this boundary to add a provider. All returned data is validated by the client. */
export interface QuestionModel {
  readonly name: string;
  evaluate(request: EvaluationRequest, options?: RunOptions): Promise<unknown>;
}
/** Normalized token usage, counted once per provider request rather than once per question. */
export interface Usage {
  /** Undefined means unreported, never zero. */
  readonly inputTokens?: number;
  readonly outputTokens?: number;
}
/** Precision explicitly reported by an evaluation provider; values are preserved, not normalized. */
export interface Rounding {
  readonly probabilityDecimals?: number;
  readonly scoreDecimals?: number;
}
/** Diagnostics are returned to the caller, never automatically logged. */
export type EvaluationWarning =
  | {
      readonly type: "unsupported" | "compatibility";
      readonly feature: string;
      readonly details?: string;
    }
  | { readonly type: "deprecated"; readonly setting: string; readonly message: string }
  | { readonly type: "other"; readonly message: string };
/** Full typed evidence, including the reported model identifier and token usage. */
export interface Evaluation<B extends Batch> {
  readonly model: string;
  readonly usage: Usage;
  readonly answers: Answers<B>;
  readonly rounding?: Rounding;
  readonly warnings?: readonly EvaluationWarning[];
  /** Provider-specific JSON. May contain sensitive diagnostics; do not log indiscriminately. */
  readonly providerMetadata?: Readonly<Record<string, JsonObject>>;
}
