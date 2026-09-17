import type { AnyQuestion, Batch } from "./question.ts";
import type { Answers } from "./answer.ts";
import type { RunOptions, State } from "./types.ts";

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
  readonly inputTokens: number;
  readonly outputTokens: number;
}
/** Full typed evidence, including the actual model identifier and token usage. */
export interface Evaluation<B extends Batch> {
  readonly model: string;
  readonly usage: Usage;
  readonly answers: Answers<B>;
}
