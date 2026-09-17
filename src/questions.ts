import type { Defaults, OperationOptions, SemanticHooks, Operation } from "./lifecycle.ts";
import {
  settings,
  withOperation,
  checkModel,
  operationContext,
  type Settings,
  type OperationContext,
} from "./internal/operation.ts";
import * as Schema from "./schema.ts";
import * as Question from "./question.ts";
import { prepare as prepareExecution } from "./execution.ts";
import type { Execution, Prepared } from "./execution.ts";
import * as Answer from "./answer.ts";
import { requireConfidence } from "./decision.ts";
import type { Evaluation, QuestionModel } from "./model.ts";
import type { Awaitable, CallContext, Description, State, StateSource } from "./types.ts";
import { cancellation, abortable } from "./internal/abort.ts";
import { decode } from "./internal/decode.ts";
import { probability, state } from "./internal/validation.ts";

/** Optional confidence gate and operation-level cancellation. No implicit retry or fallback. */
export interface Options extends OperationOptions {}
/** Client-level policies are immutable; derive a new client with extend(). */
export interface ClientOptions {
  readonly model: QuestionModel;
  readonly defaults?: Defaults;
  readonly hooks?: SemanticHooks | false;
}
/** Explicit overrides for an independently configured client. */
export type ExtendOptions = Omit<ClientOptions, "model"> & { readonly model?: QuestionModel };
const scopeOperation = Symbol("questions.scope");
/** A collection of original application values identified by position or stable record keys. */
export type Candidates = readonly unknown[] | Readonly<Record<string, unknown>>;
/** The element type of an array or keyed collection. */
export type Candidate<C extends Candidates> = C extends readonly (infer T)[] ? T : C[keyof C];
/** Predicate that can be passed directly to asynchronous stream operators. */
export type Predicate = (context: State, options?: OperationOptions) => Promise<boolean>;

/** An immutable client with explicit model injection and no global runtime. */
export class QuestionsClient {
  readonly #model: QuestionModel;
  readonly #settings: Settings;
  /** Effective, normalized defaults. Numeric timeout values are milliseconds. */
  readonly defaults: Readonly<Defaults>;
  constructor(model: QuestionModel, options: Omit<ClientOptions, "model"> = {}) {
    this.#model = checkModel(model);
    this.#settings = settings(undefined, options.defaults, options.hooks);
    this.defaults = Object.freeze({
      ...(this.#settings.confidence === undefined ? {} : { confidence: this.#settings.confidence }),
      ...(this.#settings.timeoutMs === undefined ? {} : { timeout: this.#settings.timeoutMs }),
    });
    Object.freeze(this);
  }

  /**
   * Derive an independent immutable client. Overrides win; undefined inherits.
   * Parent hooks run before child hooks. hooks:false (or a false event) clears inheritance.
   * timeout:false removes an inherited operation timeout; schema confidence minima remain intact.
   * @example
   * const support = client.extend({ defaults: { confidence: 0.7, timeout: "30 s" } });
   */
  extend(options: ExtendOptions = {}): QuestionsClient {
    const policy = settings(this.#settings, options.defaults, options.hooks);
    return new QuestionsClient(options.model ?? this.#model, {
      defaults: {
        timeout: policy.timeoutMs ?? false,
        ...(policy.confidence === undefined ? {} : { confidence: policy.confidence }),
      },
      hooks: policy.hooks,
    });
  }

  /** @internal A collection uses the same outer boundary without nested operation events. */
  [scopeOperation]<T>(
    name: Operation,
    options: OperationOptions,
    work: (options: OperationOptions, context: OperationContext) => Promise<T>,
  ): Promise<T> {
    return withOperation(this.#model, this.#settings, name, options, work);
  }

  /**
   * Bind static or live context. Every method invocation performs a new evaluation.
   * A Promise is not a reusable lazy Effect: use a function to repeat an operation.
   * @example
   * const q = client.about(() => ({ findings }));
   * const settled = () => q.is("Is the cause established?");
   */
  about(source: StateSource): BoundQuestions {
    return new BoundQuestions(this.#model, source, this.#settings);
  }

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
  each<T>(
    items: readonly T[],
    describe: (item: T, index: number) => Description = (item) => item as Description,
  ): EachQuestions {
    return new EachQuestions(this, items.map(describe));
  }
}

/** Operations on one bound context. Construct through client.about(). */
export class BoundQuestions {
  readonly #model: QuestionModel;
  readonly #source: StateSource;
  readonly #settings: Settings | undefined;
  constructor(model: QuestionModel, source: StateSource, defaults?: Settings) {
    this.#model = checkModel(model);
    this.#source = source;
    this.#settings = defaults;
    Object.freeze(this);
  }

  /**
   * Evaluate a nonempty batch and retain distributions, model, and usage.
   * All provider outputs are validated before they become typed evidence.
   */
  async evidence<const B extends Question.Batch>(
    batch: B,
    options: OperationOptions = {},
  ): Promise<Evaluation<B>> {
    return withOperation(
      this.#model,
      this.#settings,
      "evidence",
      options ?? {},
      async (options, _context) => {
        const questions = Question.normalize(batch);
        const scope = cancellation(options.signal);
        const operation = operationContext(options);
        if (operation) {
          operation.stage = "context";
          operation.questionCount = Object.keys(questions).length;
        }
        try {
          operation?.check();
          scope.check();
          const current =
            typeof this.#source === "function"
              ? await abortable(this.#source({ signal: scope.signal }), scope.signal)
              : this.#source;
          operation?.check();
          scope.check();
          if (operation) {
            operation.stage = "inference";
            operation.evaluationCount++;
          }
          const response = await abortable(
            this.#model.evaluate({ state: state(current), questions }, { signal: scope.signal }),
            scope.signal,
          );
          operation?.check();
          scope.check();
          if (operation) operation.stage = "validation";
          const result = decode<B>(response, questions);
          if (operation) operation.evidence = result;
          return result;
        } finally {
          scope.dispose();
        }
      },
    );
  }

  /**
   * Evaluate a Zod schema in one request, validate asynchronously, and infer its output.
   * Descriptions, metadata and Schema annotations guide the finite decision compiler.
   * Plain question batches remain supported; no caller-supplied result cast is needed.
   * @example
   * const { blocked, team } = await q.ask({
   *   blocked: "Is production blocked?",
   *   team: Question.choice("Which team?", { billing: "Payments", support: "Bugs" }),
   * });
   */
  async ask<S extends Schema.Type>(schema: S, options?: Options): Promise<Schema.Output<S>>;
  /** Existing question batches keep their literal-key inference and behavior. */
  async ask<const B extends Question.Batch>(
    batch: B,
    options?: Options,
  ): Promise<Question.Values<B>>;
  async ask(batch: Question.Batch | Schema.Type, options: Options = {}): Promise<unknown> {
    return withOperation(
      this.#model,
      this.#settings,
      "ask",
      options ?? {},
      async (options, _context) => {
        const run = { ...options };
        return (await (await prepareExecution(this.#model, this.#source, batch, run)).run(run))
          .value;
      },
    );
  }

  /**
   * Evaluate once and retain the validated value, evidence and an explicit replay operation.
   * Unlike ask(), the result exposes replay(), which makes a NEW potentially paid inference.
   * It captures context once; replay never invokes branch handlers or rereads a live source.
   * @example
   * const result = await q.run(z.object({ urgent: z.boolean().describe("Is it urgent?") }));
   * console.log(result.value.urgent, result.evidence?.usage);
   * const repeated = await result.replay({ signal: AbortSignal.timeout(10_000) });
   */
  async run<S extends Schema.Type>(
    schema: S,
    options?: Options,
  ): Promise<Execution<Schema.Output<S>>>;
  /** Question batches retain their exact literal keys in both value and evidence. */
  async run<const B extends Question.Batch>(
    batch: B,
    options?: Options,
  ): Promise<Execution<Question.Values<B>, B>>;
  async run(
    batch: Question.Batch | Schema.Type,
    options: Options = {},
  ): Promise<Execution<unknown>> {
    return withOperation(
      this.#model,
      this.#settings,
      "run",
      options ?? {},
      async (options, _context) => {
        const run = { ...options };
        return (await prepareExecution(this.#model, this.#source, batch, run)).run(run);
      },
    );
  }

  /**
   * Capture questions and one context snapshot without inference or user parsing callbacks.
   * Keep the prepared handle to run again after a failure. Each run has its own cancellation.
   * The preparation signal covers context acquisition only, not future runs.
   * @example
   * const prepared = await q.prepare(schema);
   * const first = await prepared.run();
   * const second = await prepared.run({ model: anotherProvider });
   */
  async prepare<S extends Schema.Type>(
    schema: S,
    options?: Options,
  ): Promise<Prepared<Schema.Output<S>>>;
  /** Plain question batches have the same snapshot and replay behavior as schemas. */
  async prepare<const B extends Question.Batch>(
    batch: B,
    options?: Options,
  ): Promise<Prepared<Question.Values<B>, B>>;
  async prepare(
    batch: Question.Batch | Schema.Type,
    options: Options = {},
  ): Promise<Prepared<unknown>> {
    return prepareExecution(this.#model, this.#source, batch, options, this.#settings);
  }

  /** Return the most likely boolean. An exact tie favors true; gate confidence to reject ties. */
  async is(question: string, options?: Options): Promise<boolean> {
    return withOperation(
      this.#model,
      this.#settings,
      "is",
      options ?? {},
      async (options, _context) => {
        return (await this.ask({ answer: question }, options)).answer;
      },
    );
  }

  /** Return P(true), leaving probability thresholds to the application. */
  async probability(question: string, options?: OperationOptions): Promise<number> {
    return withOperation(
      this.#model,
      this.#settings,
      "probability",
      options ?? {},
      async (options, _context) => {
        return (await this.evidence({ answer: question }, options)).answers.answer.probability;
      },
    );
  }

  /** Return a zero-based weighted rubric score, potentially between levels. */
  async score(
    question: string,
    levels: Question.ScoreQuestion["criteria"],
    options?: Options,
  ): Promise<number> {
    return withOperation(
      this.#model,
      this.#settings,
      "score",
      options ?? {},
      async (options, _context) => {
        return (await this.ask({ answer: Question.score(question, levels) }, options)).answer;
      },
    );
  }

  async #select<C extends Candidates>(
    question: string,
    candidates: C,
    describe: (item: Candidate<C>, key: string) => Description,
    options: OperationOptions = {},
  ) {
    const entries = Object.entries(candidates) as [string, Candidate<C>][];
    const objects = Object.fromEntries(entries) as Record<string, Candidate<C>>;
    const definitions = Object.fromEntries(
      entries.map(([key, value]) => [key, describe(value, key)]),
    );
    const result = await this.evidence({ answer: Question.choice(question, definitions) }, options);
    return { objects, answer: result.answers.answer };
  }

  /** Select and return the original object by identity; only descriptions are sent to the model. */
  async choose<const C extends Candidates>(
    question: string,
    candidates: C,
    describe: (item: Candidate<C>, key: string) => Description,
    options: Options = {},
  ): Promise<Candidate<C>> {
    return withOperation(
      this.#model,
      this.#settings,
      "choose",
      options ?? {},
      async (options, context) => {
        context.stage = "decision";
        if (options.confidence !== undefined) probability(options.confidence, "confidence.minimum");
        const { objects, answer } = await this.#select(question, candidates, describe, options);
        if (options.confidence !== undefined)
          requireConfidence(answer, options.confidence, question);
        return objects[answer.choice]!;
      },
    );
  }

  /** Return every original candidate, ordered by probability. Ties preserve enumeration order. */
  async rank<const C extends Candidates>(
    question: string,
    candidates: C,
    describe: (item: Candidate<C>, key: string) => Description,
    options?: OperationOptions,
  ): Promise<Answer.Ranked<Candidate<C>>[]> {
    return withOperation(
      this.#model,
      this.#settings,
      "rank",
      options ?? {},
      async (options, context) => {
        context.stage = "decision";
        const { objects, answer } = await this.#select(question, candidates, describe, options);
        return Answer.rank(answer).map(({ value, probability: mass }) => ({
          value: objects[value]!,
          probability: mass,
        }));
      },
    );
  }

  /**
   * Select a descriptive branch and invoke only its handler. The inference may fail without
   * running any handler. Handler failures are preserved and never trigger an automatic fallback.
   */
  async branch<const H extends Readonly<Record<string, (context: CallContext) => unknown>>>(
    question: string,
    handlers: H,
    options: Options = {},
  ): Promise<Awaited<ReturnType<H[keyof H]>>> {
    return withOperation<Awaited<ReturnType<H[keyof H]>>>(
      this.#model,
      this.#settings,
      "branch",
      options ?? {},
      async (options, context): Promise<Awaited<ReturnType<H[keyof H]>>> => {
        const chosen = await this.choose(question, handlers, (_, key) => key, options);
        await context.decision();
        context.stage = "handler";
        const signal = context.signal;
        context.check();
        return (await chosen({ signal })) as Awaited<ReturnType<H[keyof H]>>;
      },
    );
  }
}

/** Collection-scoped batch operations, preserving input order. */
export class EachQuestions {
  readonly #client: QuestionsClient;
  readonly #items: readonly Description[];
  constructor(client: QuestionsClient, items: readonly Description[]) {
    this.#client = client;
    this.#items = Object.freeze(items.map((item) => (item === null ? null : state(item))));
  }

  /** Evaluate one schema per item in a single request and validate each result in input order. */
  async ask<S extends Schema.Type>(schema: S, options?: Options): Promise<Schema.Output<S>[]>;
  /** Existing per-item question batches preserve literal-key inference. */
  async ask<const B extends Question.Batch>(
    batch: B,
    options?: Options,
  ): Promise<Question.Values<B>[]>;
  async ask(batch: Question.Batch | Schema.Type, options: Options = {}): Promise<unknown[]> {
    return this.#client[scopeOperation]("each.ask", options, async (options, operation) => {
      operation.itemCount = this.#items.length;
      if (Schema.isSchema(batch)) return this.#askSchema(batch, options);
      const questions = Object.entries(Question.normalize(batch));
      if (options.confidence !== undefined) probability(options.confidence, "confidence.minimum");
      options.signal?.throwIfAborted();
      if (this.#items.length === 0) return [];
      const flattened = Object.fromEntries(
        this.#items.flatMap((_, itemIndex) =>
          questions.map(([, question], questionIndex) => [
            `i${itemIndex}q${questionIndex}`,
            { ...question, instructions: `About item${itemIndex}: ${question.instructions}` },
          ]),
        ),
      );
      const context = Object.fromEntries(this.#items.map((item, index) => [`item${index}`, item]));
      const values = await this.#client.about(context).ask(flattened, options);
      return this.#items.map(
        (_, itemIndex) =>
          Object.freeze(
            Object.fromEntries(
              questions.map(([key], questionIndex) => [
                key,
                values[`i${itemIndex}q${questionIndex}`],
              ]),
            ),
          ) as Question.Values<Question.Batch>,
      );
    });
  }

  async #askSchema<S extends Schema.Type>(
    schema: S,
    options: Options,
  ): Promise<Schema.Output<S>[]> {
    if (options.confidence !== undefined) probability(options.confidence, "confidence.minimum");
    options.signal?.throwIfAborted();
    const compiled = Schema.compile(schema);
    const questions = Object.entries(compiled.questions);
    if (this.#items.length === 0) return [];
    const flattened = Object.fromEntries(
      this.#items.flatMap((_, itemIndex) =>
        questions.map(([, question], questionIndex) => [
          `i${itemIndex}q${questionIndex}`,
          { ...question, instructions: `About item${itemIndex}: ${question.instructions}` },
        ]),
      ),
    );
    const context = Object.fromEntries(this.#items.map((item, index) => [`item${index}`, item]));
    const evaluation =
      questions.length === 0
        ? undefined
        : await this.#client.about(context).evidence(flattened, options);
    const results: Schema.Output<S>[] = [];
    // Sequential parsing bounds async user callbacks; all inference still uses one request.
    for (let itemIndex = 0; itemIndex < this.#items.length; itemIndex++) {
      operationContext(options)?.check();
      options.signal?.throwIfAborted();
      const itemEvidence =
        evaluation === undefined
          ? undefined
          : {
              ...evaluation,
              answers: Object.fromEntries(
                questions.map(([key], questionIndex) => [
                  key,
                  evaluation.answers[`i${itemIndex}q${questionIndex}`],
                ]),
              ),
            };
      const context = operationContext(options);
      if (context) context.stage = "validation";
      results.push(await compiled.parse(itemEvidence, options));
    }
    return results;
  }

  /** Ask the same yes/no question about all items in one request. */
  async is(question: string, options?: Options): Promise<boolean[]> {
    return this.#client[scopeOperation]("each.is", options ?? {}, async (options, _context) => {
      return (await this.ask({ answer: question }, options)).map((row) => row.answer);
    });
  }

  /** Score all items against the same ordered rubric in one request. */
  async score(
    question: string,
    levels: Question.ScoreQuestion["criteria"],
    options?: Options,
  ): Promise<number[]> {
    return this.#client[scopeOperation]("each.score", options ?? {}, async (options, _context) => {
      return (await this.ask({ answer: Question.score(question, levels) }, options)).map(
        (row) => row.answer,
      );
    });
  }
}

/**
 * Create a client with an explicit model. Construction performs no network activity.
 * @example
 * const questions = Questions.create({
 *   model: TypeSafe.create({ apiKey, timeout: "15 s" }),
 *   defaults: { confidence: 0.6, timeout: "30 s" },
 * });
 * const urgent = await questions.about(ticket).is("Is this urgent?");
 */
export function create(options: ClientOptions): QuestionsClient {
  return new QuestionsClient(options.model, options);
}

// Kept in the public module so consumers can name inferred batch result types.
export type { Batch, Values } from "./question.ts";
export type { Awaitable };

export type { Defaults, OperationOptions, SemanticHooks } from "./lifecycle.ts";
