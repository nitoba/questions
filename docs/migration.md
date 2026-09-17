# From effect-questions

This is a semantic redesign, not a source-compatible drop-in replacement.

| Effect version                                            | Native Questions                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `Questions.about(state)` with provided Layer              | `const questions = Questions.create({ model }); questions.about(state)`      |
| `yield* q.is(...)`                                        | `await q.is(...)`                                                            |
| Effect-valued live context                                | `questions.about(({ signal }) => readCurrentContext(signal))`                |
| A reusable Effect                                         | A function returning a fresh Promise                                         |
| `Effect.catchTag("UncertainDecision", ...)`               | `try/catch` and `error instanceof UncertainDecision`                         |
| `Question.choice` / `Question.score` / `Question.boolean` | Same concepts; normalized immutable definitions, no Effect Schema codecs     |
| `Stream.fromIterable(items)`                              | `Streams.from(items)`                                                        |
| `Stream.mapEffect(f, { concurrency })`                    | `.map(f, { concurrency })`; callback receives `{ signal, index }`            |
| `Stream.filterEffect(predicate)`                          | `.filter(predicate)`; sequential, or concurrent `.map` followed by `.filter` |
| `Stream.scan(seed, reducer)`                              | `.scan(() => seed, reducer)`; no seed emission                               |
| `Stream.mapAccumEffect(seed, step)`                       | `.mapAccum(() => seed, step)`                                                |
| `Stream.takeUntil(predicate)`                             | `.takeUntil(predicate)`, inclusive                                           |
| `Stream.runForEach(effect)`                               | `.forEach(callback, { signal })`                                             |
| Effect timeout / interruption                             | Provider `timeoutMs`, or an AbortSignal passed to a terminal/operation       |
| Curried dual Answer/Decision helpers                      | Ordinary data-first functions                                                |
| Effect services / Layers                                  | Explicit `QuestionModel` injection                                           |

`each` is still one request for the collection, not parallel per-item calls. `choose` still returns an original candidate, and `branch` still runs only one lazy handler. Add explicit fallback candidates and handle confidence rejection at the application boundary.

Validation is intentionally stricter: probability mass, chosen maximum, weighted score and rubric legend must agree. Inconsistent provider responses fail instead of being silently projected. Numeric options reject NaN, Infinity and invalid ranges. Do not confuse score confidence, boolean separation and P(true).

The native implementation has no built-in Effect metrics/tracing service. Decorate `QuestionModel.evaluate` or inject a traced fetch. Observe one evaluation rather than incrementing metrics for every projected batch field. Propagate cancellation through decorators and avoid logging context, credentials or sensitive error causes by default.

Original inspiration is acknowledged, but the runtime and validation code are independently implemented. No Effect code, runtime dependency, schemas or internal abstractions are bundled.

## Adopt Zod incrementally (alpha.2)

Existing `Question.boolean`, `Question.choice`, `Question.score`, plain batches and their inferred results remain supported. For schema-driven results, pass a `z.object(...)` (not a raw object of Zod fields) to `ask`. Attach instructions with `.describe()`, standard `.meta()` fields, or typed `.register(Schema.registry, ...)` annotations. Explicitly annotate numbers as probability or score. The result is the parsed `z.output<typeof schema>`, including transforms.

Install the Zod 4 peer alongside the package. Existing clients importing the root now resolve that peer even when using only the question-batch API. Applications using only streams or the standalone Jev provider can keep their independent subpath imports. No Effect schema adapter or free-form extraction is implied; see [the schema guide](schemas.md).

## Multiple providers (alpha.3)

Existing `Jev.create({ apiKey, baseUrl })` calls remain valid. New code can use `TypeSafe.create` with `baseURL`, a configured System One host, or the optional Vercel integration. Passing both URL spellings to Jev is rejected.

**Type change:** usage counters are now optional, because SDK providers may omit them. Missing tokens are unknown, not zero; account for that explicitly. Choice/score evidence now optionally records `confidenceSource`; native TypeSafe reports `provider`, SDK defaults to `margin`, and custom policies report `custom`. Thresholds may need recalibration across providers. New optional envelope fields preserve rounding, warnings and provider metadata. Missing SDK distributions are rejected.

The root package still needs only Zod. The Vercel subpath adds an optional `@ai-sdk/gateway` peer and requires Zod >=4.1.8 for the SDK, while native schema support retains its Zod 4.0.0 minimum. See [provider setup and contracts](providers.md).
