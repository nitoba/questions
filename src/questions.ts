import * as Question from "./question.ts";
import * as Answer from "./answer.ts";
import { requireConfidence } from "./decision.ts";
import type { Evaluation, QuestionModel } from "./model.ts";
import type { Awaitable, CallContext, Description, RunOptions, State, StateSource } from "./types.ts";
import { cancellation, abortable } from "./internal/abort.ts";
import { decode } from "./internal/decode.ts";
import { probability, state, text } from "./internal/validation.ts";

/** Optional confidence gate and operation-level cancellation. No implicit retry or fallback. */
export interface Options extends RunOptions { readonly confidence?: number }
/** A collection of original application values identified by position or stable record keys. */
export type Candidates = readonly unknown[] | Readonly<Record<string, unknown>>;
/** The element type of an array or keyed collection. */
export type Candidate<C extends Candidates> = C extends readonly (infer T)[] ? T : C[keyof C];
/** Predicate that can be passed directly to asynchronous stream operators. */
export type Predicate = (context: State, options?: RunOptions) => Promise<boolean>;

function projected(answer: Answer.AnyAnswer): boolean | string | number {
  switch (answer.type) {
    case "boolean": return answer.probability >= 0.5;
    case "choice": return answer.choice;
    case "score": return answer.score;
  }
}

/** An immutable client with explicit model injection and no global runtime. */
export class QuestionsClient {
  readonly #model: QuestionModel;
  constructor(model: QuestionModel) {
    text(model.name, "model.name");
    if (typeof model.evaluate !== "function") throw new TypeError("model.evaluate must be a function");
    this.#model = model;
  }

  /**
   * Bind static or live context. Every method invocation performs a new evaluation.
   * A Promise is not a reusable lazy Effect: use a function to repeat an operation.
   * @example
   * const q = client.about(() => ({ findings }));
   * const settled = () => q.is("Is the cause established?");
   */
  about(source: StateSource): BoundQuestions { return new BoundQuestions(this.#model, source); }

  /** Create an asynchronous predicate; a consumer signal overrides the bound signal. */
  is(question: string, options: Options = {}): Predicate {
    Question.boolean(question);
    return (context, run = {}) => this.about(context).is(question, { ...options, ...run });
  }

  /**
   * Evaluate all items in one request. Unlike stream.map, this is batching, not concurrency.
   * Empty input returns [] without an evaluation; the question definition is still validated.
   */
  each<T extends Description>(items: readonly T[]): EachQuestions;
  /** Supply a description to avoid sending private fields or non-JSON application objects. */
  each<T>(items: readonly T[], describe: (item: T, index: number) => Description): EachQuestions;
  each<T>(items: readonly T[], describe: (item: T, index: number) => Description = (item) => item as Description): EachQuestions {
    return new EachQuestions(this, items.map(describe));
  }
}

/** Operations on one bound context. Construct through client.about(). */
export class BoundQuestions {
  readonly #model: QuestionModel;
  readonly #source: StateSource;
  constructor(model: QuestionModel, source: StateSource) { this.#model = model; this.#source = source; }

  /**
   * Evaluate a nonempty batch and retain distributions, model, and usage.
   * All provider outputs are validated before they become typed evidence.
   */
  async evidence<const B extends Question.Batch>(batch: B, options: RunOptions = {}): Promise<Evaluation<B>> {
    const questions = Question.normalize(batch);
    const scope = cancellation(options.signal);
    try {
      scope.signal.throwIfAborted();
      const current = typeof this.#source === "function"
        ? await abortable(this.#source({ signal: scope.signal }), scope.signal) : this.#source;
      scope.signal.throwIfAborted();
      const response = await abortable(this.#model.evaluate(
        { state: state(current), questions }, { signal: scope.signal },
      ), scope.signal);
      scope.signal.throwIfAborted();
      return decode<B>(response, questions);
    } finally { scope.dispose(); }
  }

  /**
   * Evaluate independent questions in one request and return their plain typed values.
   * @example
   * const { blocked, team } = await q.ask({
   *   blocked: "Is production blocked?",
   *   team: Question.choice("Which team?", { billing: "Payments", support: "Bugs" }),
   * });
   */
  async ask<const B extends Question.Batch>(batch: B, options: Options = {}): Promise<Question.Values<B>> {
    if (options.confidence !== undefined) probability(options.confidence, "confidence.minimum");
    const result = await this.evidence(batch, options);
    return Object.freeze(Object.fromEntries(Object.entries(result.answers).map(([key, answer]) => {
      if (options.confidence !== undefined) {
        const question = batch[key]!;
        requireConfidence(answer, options.confidence, typeof question === "string" ? question : question.instructions);
      }
      return [key, projected(answer)];
    }))) as Question.Values<B>;
  }

  /** Return the most likely boolean. An exact tie favors true; gate confidence to reject ties. */
  async is(question: string, options?: Options): Promise<boolean> {
    return (await this.ask({ answer: question }, options)).answer;
  }

  /** Return P(true), leaving probability thresholds to the application. */
  async probability(question: string, options?: RunOptions): Promise<number> {
    return (await this.evidence({ answer: question }, options)).answers.answer.probability;
  }

  /** Return a zero-based weighted rubric score, potentially between levels. */
  async score(question: string, levels: Question.ScoreQuestion["criteria"], options?: Options): Promise<number> {
    return (await this.ask({ answer: Question.score(question, levels) }, options)).answer;
  }

  async #select<C extends Candidates>(question: string, candidates: C,
    describe: (item: Candidate<C>, key: string) => Description, options: RunOptions = {}) {
    const entries = Object.entries(candidates) as [string, Candidate<C>][];
    const objects = Object.fromEntries(entries) as Record<string, Candidate<C>>;
    const definitions = Object.fromEntries(entries.map(([key, value]) => [key, describe(value, key)]));
    const result = await this.evidence({ answer: Question.choice(question, definitions) }, options);
    return { objects, answer: result.answers.answer };
  }

  /** Select and return the original object by identity; only descriptions are sent to the model. */
  async choose<const C extends Candidates>(question: string, candidates: C,
    describe: (item: Candidate<C>, key: string) => Description, options: Options = {}): Promise<Candidate<C>> {
    if (options.confidence !== undefined) probability(options.confidence, "confidence.minimum");
    const { objects, answer } = await this.#select(question, candidates, describe, options);
    if (options.confidence !== undefined) requireConfidence(answer, options.confidence, question);
    return objects[answer.choice]!;
  }

  /** Return every original candidate, ordered by probability. Ties preserve enumeration order. */
  async rank<const C extends Candidates>(question: string, candidates: C,
    describe: (item: Candidate<C>, key: string) => Description, options?: RunOptions): Promise<Answer.Ranked<Candidate<C>>[]> {
    const { objects, answer } = await this.#select(question, candidates, describe, options);
    return Answer.rank(answer).map(({ value, probability: mass }) => ({ value: objects[value]!, probability: mass }));
  }

  /**
   * Select a descriptive branch and invoke only its handler. The inference may fail without
   * running any handler. Handler failures are preserved and never trigger an automatic fallback.
   */
  async branch<const H extends Readonly<Record<string, (context: CallContext) => unknown>>>(
    question: string, handlers: H, options: Options = {},
  ): Promise<Awaited<ReturnType<H[keyof H]>>> {
    const chosen = await this.choose(question, handlers, (_, key) => key, options);
    const signal = options.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    return await chosen({ signal }) as Awaited<ReturnType<H[keyof H]>>;
  }
}

/** Collection-scoped batch operations, preserving input order. */
export class EachQuestions {
  readonly #client: QuestionsClient;
  readonly #items: readonly Description[];
  constructor(client: QuestionsClient, items: readonly Description[]) {
    this.#client = client;
    this.#items = Object.freeze(items.map((item) => item === null ? null : state(item)));
  }

  /** Ask each question about each item, with numeric transport IDs that cannot collide with user keys. */
  async ask<const B extends Question.Batch>(batch: B, options: Options = {}): Promise<Question.Values<B>[]> {
    const questions = Object.entries(Question.normalize(batch));
    if (options.confidence !== undefined) probability(options.confidence, "confidence.minimum");
    options.signal?.throwIfAborted();
    if (this.#items.length === 0) return [];
    const flattened = Object.fromEntries(this.#items.flatMap((_, itemIndex) => questions.map(([, question], questionIndex) => [
      `i${itemIndex}q${questionIndex}`, { ...question, instructions: `About item${itemIndex}: ${question.instructions}` },
    ])));
    const context = Object.fromEntries(this.#items.map((item, index) => [`item${index}`, item]));
    const values = await this.#client.about(context).ask(flattened, options);
    return this.#items.map((_, itemIndex) => Object.freeze(Object.fromEntries(questions.map(([key], questionIndex) => [
      key, values[`i${itemIndex}q${questionIndex}`],
    ]))) as Question.Values<B>);
  }

  /** Ask the same yes/no question about all items in one request. */
  async is(question: string, options?: Options): Promise<boolean[]> {
    return (await this.ask({ answer: question }, options)).map((row) => row.answer);
  }

  /** Score all items against the same ordered rubric in one request. */
  async score(question: string, levels: Question.ScoreQuestion["criteria"], options?: Options): Promise<number[]> {
    return (await this.ask({ answer: Question.score(question, levels) }, options)).map((row) => row.answer);
  }
}

/**
 * Create a client with an explicit model. Construction performs no network activity.
 * @example
 * const questions = Questions.create({ model: Jev.create({ apiKey }) });
 * const urgent = await questions.about(ticket).is("Is this urgent?");
 */
export function create(options: { readonly model: QuestionModel }): QuestionsClient {
  return new QuestionsClient(options.model);
}

// Kept in the public module so consumers can name inferred batch result types.
export type { Batch, Values } from "./question.ts";
export type { Awaitable };
