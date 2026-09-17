# Architecture

## Boundaries

`question.ts` defines and snapshots boolean, choice and score questions. `model.ts` declares the provider boundary. `questions.ts` binds context, performs one batch evaluation, validates it, and projects values or dispatches a selected handler. `answer.ts` implements probability mathematics. `decision.ts` implements policies over evidence. `providers/jev.ts` owns HTTP, wire conversion, retries and response-size limits. `streams.ts` is a generic Web Streams facade; it does not know about Jev or models. `internal` contains validation, response decoding, cancellation and bounded stream-window mechanics.

There is no DI container: `Questions.create({ model })` captures a model. There is no global environment lookup. Applications provide secrets, logging, authorization, rate limiting and persistence. JavaScript and declarations are separate build outputs from tsdown and TypeScript 7 respectively.

## Provider contract

```ts
interface QuestionModel {
  readonly name: string;
  evaluate(request: EvaluationRequest, options?: { signal?: AbortSignal }): Promise<unknown>;
}
```

The request includes JSON-compatible `state` and a nonempty record of normalized question definitions. Question keys identify transport fields; question `instructions` carry semantic meaning. Providers must respect `signal` where possible. Return:

```ts
{
  model: "actual-model-id",
  usage: { inputTokens: 100, outputTokens: 5 },
  answers: {
    allowed: { type: "boolean", probability: 0.9 },
    route: { type: "choice", choice: "billing", confidence: 0.8,
      probabilities: { billing: 0.9, support: 0.1 } },
    urgency: { type: "score", score: 1.6, confidence: 0.35,
      probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
      legend: { "0": "Low", "1": "Medium", "2": "High" } },
  },
}
```

Answer keys must exactly match the request. Choices include every declared option; scores include every zero-based rubric index and the original legend. The client validates and freezes normalized evidence. Implementations may return untrusted JSON; casts are not needed in custom provider implementations.

Jev maps booleans to wire `noul` and usage from snake case. It uses the documented JSON endpoint, not a guessed streaming API. The adapter permits up to 255 criteria per choice/score and serializes structured option descriptions to strings. Direct `model.evaluate` is a low-level unknown-data boundary; use the client for typed, validated results.

## Deliberate differences from Effect

Operations return normal eager Promises once invoked. Repeat with `() => q.is(...)`; do not re-await a Promise expecting another execution. Cancellation uses AbortSignal. Errors are exceptions, not an `E` generic. No fibers, services, Layers, scheduler runtime, generic retry operators or hidden lifecycle scope are recreated.

Confidence gates do not provide model calibration. Expected loss assumes comparable finite costs and normalized probabilities; it does not establish factual correctness, independence, authorization or exactly-once execution. Pure helpers do not silently normalize distributions. A business action's idempotency belongs to the application.

## Verification

The suite includes deterministic provider contracts, actual localhost fetch, malformed envelopes, probability/score invariants, confidence rejection before side effects, object identity, collection regrouping, live state, reader cleanup, cancellation, late acquisition, bounded concurrent windows, order, generator lifetime, native transforms and sinks. Compile-only tests cover literal inference and negative contracts. A packed tarball is installed outside the workspace and consumed under Node, Bun and the TypeScript compiler without ambient Bun types. The same runtime tests are runnable under Node through the tiny test-loader adapter.

Live semantic accuracy and real TypeSafe account permissions require an API key and a representative evaluation dataset; the offline suite does not claim to establish either.

## References

- [effect-questions inspected revision](https://github.com/saiashirwad/effect-questions/tree/7f1fdc188ae455b6e770f3807d081018712f83bd)
- [TypeSafe API](https://docs.typesafe.ai/api)
- [WHATWG Streams specification](https://streams.spec.whatwg.org/)
