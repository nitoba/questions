# Questions

Typed semantic decisions in ordinary TypeScript. **No Effect and no runtime dependencies.**

Ask yes/no questions, choose among your own objects, score against explicit rubrics, and branch on validated evidence. Compose these operations with lazy, cancellable **native Web Streams**.

This is an independent implementation inspired by [effect-questions](https://github.com/saiashirwad/effect-questions), not an Effect wrapper. **Alpha: API may change; not published to npm by this implementation.**

## Run from source

Use Bun **1.4.2**. The toolchain pins TypeScript **7.0.2**, Oxlint, Oxfmt and tsdown in `bun.lock`.

```sh
git clone https://github.com/nitoba/questions.git
cd questions
bun install --frozen-lockfile
bun run check
TYPESAFE_API_KEY=your-key bun examples/triage.ts
```

Live examples require a TypeSafe API key and may incur charges. Tests use deterministic provider fixtures and an in-process HTTP server, never a live paid model. The repository is private unless its owner changes visibility.

To install a local build into another project:

```sh
bun run build
bun pm pack --filename /tmp/questions.tgz
cd ../your-app
bun add /tmp/questions.tgz
```

## Ask typed questions

```ts
import { Jev, Question, Questions } from "@nitoba/questions";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Missing TYPESAFE_API_KEY");

const questions = Questions.create({
  model: Jev.create({ apiKey, timeoutMs: 15_000 }),
});

const q = questions.about({ title: "Production API is unavailable after deployment" });
const result = await q.ask({
  blocked: "Is production work blocked?",
  team: Question.choice("Which team owns the problem?", {
    billing: "Invoices and payments",
    platform: "API outages and deployments",
  }),
  impact: Question.score("How disruptive?", ["Low", "Impaired", "Unavailable"]),
});
// result: { readonly blocked: boolean; readonly team: "billing" | "platform"; readonly impact: number }
```

One `ask` is **one provider evaluation**, regardless of the number of independent questions. A score is a probability-weighted, zero-based rubric index: three levels produce a number in `[0, 2]`, including fractional values.

`q.is`, `q.probability`, `q.score`, `q.choose`, `q.rank`, `q.branch`, and `q.evidence` each perform a new evaluation when called. Re-awaiting the same Promise does **not** perform another evaluation. There is no global client, service container or hidden runtime.

## Keep decisions explicit

```ts
import { UncertainDecision } from "@nitoba/questions";

try {
  const destination = await q.branch(
    "What kind of help is needed?",
    {
      "Invoice or payment problem": () => ({ queue: "billing" }),
      "Bug, outage or deployment failure": async () => ({ queue: "platform" }),
    },
    { confidence: 0.6 },
  );
  console.log(destination);
} catch (error) {
  if (!(error instanceof UncertainDecision)) throw error;
  console.log("Needs human review", error.evidence);
}
```

Only the selected handler runs. A rejected confidence gate runs **no handler**. A handler's exception is not retried or converted into an automatic fallback. Handlers may receive `{ signal }` for cooperative cancellation.

For boolean evidence, confidence means `abs(2 * P(true) - 1)`, not `P(true)`. A confidence requirement of `0.8` requires `P(true) <= 0.1` or `P(true) >= 0.9`. A tie projects to `true` unless confidence rejects it. Choice and score confidence come from the provider; they are not guarantees of correctness.

## Select your own objects

```ts
const teams = [
  { id: 1, name: "Billing", responsibility: "Charges and refunds" },
  { id: 2, name: "Platform", responsibility: "Infrastructure and deployments" },
];
const team = await q.choose("Who should handle this?", teams, (item) => item.responsibility);
// team is an original object from teams, not generated JSON or a reconstructed copy.
const ranking = await q.rank("Who is best suited?", teams, (item) => item.responsibility);
```

Arrays and records with stable IDs are supported. At least two candidates are required. Only descriptions are sent; arbitrary application objects and private fields can remain local. Add an explicit “none / ask a human” candidate when appropriate.

## Live context and collection batching

```ts
let findings: string[] = [];
const investigation = questions.about(() => ({ findings }));
findings = [...findings, "The rotated credential lacks deploy:write"];
const settled = await investigation.is("Do the findings establish a likely cause?");

const urgency = await questions
  .each(["API down", "Please change the icon"])
  .score("How urgent?", ["Low", "Medium", "High"]);
```

A context function is invoked on every operation and may be asynchronous; it receives `{ signal }`. Static JSON objects are snapshotted when an operation runs. Question definitions and collection descriptions are snapshotted at construction.

`each(items).ask(batch)` evaluates the whole collection in one request and preserves input order. Empty collections return `[]` without a provider call. This is different from streaming one request per item. Batching does not bypass the provider's context window, costs, rate limits or criteria limits.

## Streams: convenient by default

```ts
import { Streams } from "@nitoba/questions";

const tickets = ["API unavailable", "Billing question", "Deployment failed"];
const pipeline = Streams.from(tickets)
  .map(
    async (ticket, { signal, index }) => ({
      index,
      ticket,
      urgent: await questions.about(ticket).is("Does this require urgent attention?", { signal }),
    }),
    { concurrency: 4 },
  )
  .filter((item) => item.urgent)
  .take(10);

await pipeline.forEach(
  (item) => {
    console.log(item);
  },
  {
    signal: AbortSignal.timeout(30_000),
  },
);
```

`map` is sequential and ordered by default. `{ concurrency: 4 }` bounds **running tasks plus completed outputs waiting for the consumer**, not merely active requests. `{ ordered: false }` emits in completion order. A later failed task is not hidden behind an earlier slow task.

The facade supports `map`, asynchronous `filter`, type-guard `filter`, `tap`, `scan`, `mapAccum`, `batch`, `take`, `takeUntil` (inclusive), `takeWhile` (exclusive), `through`, `forEach`, `toArray`, `pipeTo` and `for await`. `scan` and `mapAccum` take seed factories so separate runs do not share state. See the complete [conversation example](examples/conversation.ts).

Construction is lazy. Each terminal consumption is a **new execution**, with no replay or caching. Arrays are repeatable. Native streams and generators are single-use; a second consumption rejects. Use `Streams.defer(({ signal }) => acquireFreshSource(signal))` for fresh resources. Consumer cancellation, early termination and failures cancel upstream and signal in-flight callbacks.

For finite materialization, `await pipeline.toArray({ maxItems: 100 })` rejects if the stream exceeds the limit. It does not silently truncate. Prefer `take(100)` for deliberate truncation.

## Native APIs remain available

```ts
const bytes = pipeline.through(
  () =>
    new TransformStream({
      transform(value, controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify(value) + "\n"));
      },
    }),
);

const readable: ReadableStream<Uint8Array> = bytes.toReadable();
const response = new Response(readable, {
  headers: { "content-type": "application/x-ndjson; charset=utf-8" },
});
```

Use `.toReadable()` for `getReader`, `pipeThrough`, `pipeTo`, `tee`, framework adapters or native queue strategies. Use `.through(() => new TransformStream(...))` to preserve lazy, fresh-per-run composition. Advanced native operations retain their platform semantics; an implicit unbounded `tee` is deliberately not introduced by this library.

**Jev does not return token streams through this adapter.** Its documented `/v1/systemone` endpoint returns structured decisions as JSON. These streams process input items incrementally. See [stream lifetime and backpressure](docs/streams.md).

## Evidence and expected loss

```ts
import { Answer, Decision } from "@nitoba/questions";

const { answers, usage } = await q.evidence({
  situation: Question.choice("Is this a duplicate charge?", {
    duplicate: "The same purchase charged twice",
    legitimate: "Two distinct purchases",
  }),
});
console.log(Answer.rank(answers.situation), usage);
const decision = Decision.minimizeLoss(answers.situation, {
  refund: { duplicate: 0, legitimate: 100 },
  reject: { duplicate: 50, legitimate: 0 },
  humanReview: 2,
});
```

`Answer` exposes `fromBoolean`, `rank`, `topK`, `margin`, `probabilityOf`, `coarsen`, `expectedValue` and `confidence`. Helpers are data-first functions, not an Effect-style dual-function framework. They never invent independence between questions or silently normalize probability mass.

`Decision.risks` evaluates all alternatives; `minimizeLoss` chooses the lowest expected loss with stable tie-breaking; `match` requires handlers for every possible choice and runs only the selected one. Costs may be finite constants, complete tables or pure functions. Negative costs are rewards. Evidence is not authorization to charge money, change permissions or perform other sensitive actions.

## Providers, validation and errors

Implement `QuestionModel` to add a provider. Its `evaluate(request, { signal })` returns `Promise<unknown>` deliberately: the client validates every response before exposing typed values. Normalized answers, usage and definitions are documented in [architecture](docs/architecture.md).

The Jev adapter uses native `fetch`, supports transport injection, converts `noul` to boolean evidence and snake-case token counters to camelCase, bounds JSON response bytes, and accepts an overall timeout including response reads and backoff. Structured option descriptions are encoded as JSON text. The model object does not expose the API key.

There are **no retries by default**. Opt in explicitly:

```ts
const model = Jev.create({
  apiKey,
  timeoutMs: 20_000,
  maxResponseBytes: 1_048_576,
  retry: { maxRetries: 2, initialDelayMs: 200, maxDelayMs: 5_000 },
});
```

Only HTTP `429` and `529` are retried. Network failures, malformed responses and other HTTP statuses are not retried. `Retry-After` is a minimum delay; if it exceeds the configured maximum wait, the adapter fails instead of retrying earlier. A retry is not a guarantee against duplicate provider billing.

Malformed context, questions or normalized evidence raise `ValidationError`. Transport/status/JSON decoding failures raise `ProviderError`. An expired provider budget raises `TimeoutError`. A confidence rejection raises `UncertainDecision`. Caller cancellation preserves `signal.reason`; arbitrary application/provider failures preserve their original values. These are ordinary thrown errors, **not a typed Promise error channel**. Original error causes can contain sensitive details from a custom transport; sanitize application logs.

The decoder rejects missing/extra answer keys, undeclared choices, invalid probabilities, non-normalized distributions (tolerance `1e-6`), inconsistent winners, scores inconsistent with the weighted rubric, changed legends and invalid usage counters. Validation checks structure and arithmetic, not whether a semantic judgment is factually correct.

## Development

`bun run check` runs TypeScript 7, Oxlint, Oxfmt check, Bun tests, tsdown build, declaration generation, an installed-tarball smoke test under Node and Bun, and publint. `bun run test:coverage` reports coverage. `tsdown` builds JavaScript; TypeScript 7 emits `.d.ts` files directly, avoiding reliance on the older compiler API for declaration bundling.

The runtime uses only Web APIs. CI targets Bun and Node 22/24; browser/edge compatibility is architectural, not a claim that every browser or deployment target has been tested. Keep provider API keys on your server. See [migration notes](docs/migration.md), [contributing guidance](AGENTS.md), and JSDoc in `src`.

MIT. No telemetry, background jobs, model-generated executable code, implicit caches or hidden retries.
