# Policies and descriptive routing

**Available since 0.1.0:** ordered policies and descriptive routing are included in the stable npm package. No additional dependency or runtime is required. Existing question batches, Zod
`ask()` calls, and function-only `branch()` calls retain their contracts.

`Question` describes what to ask. `Policy` combines the resulting evidence into an ordered
decision. The existing client performs inference. Business functions stay outside policies.

## Define questions and rules

```ts
import { Policy, Question, Questions, TypeSafe } from "@nitoba/questions";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY");
const questions = Questions.create({
  model: TypeSafe.create({ apiKey, timeout: "15 seconds" }),
});

const review = Policy.from(
  {
    impact: Question.choice("Classify the public API impact of this change.", {
      none: "No public API change.",
      additive: "Adds API without changing existing behavior.",
      behavioral: "Changes an existing API's behavior.",
      breaking: "Existing consumers can break.",
    }),
    regression: Question.boolean("Are there concrete indications of a regression?"),
  },
  { thresholds: { accept: 0.8, reject: 0.2 } },
)
  .when(
    ({ impact, regression }) => impact.is("breaking").and(regression.is(true, { reject: 0.5 })),
    "block",
  )
  .when(({ impact }) => impact.is("breaking"), "migration-required")
  .onUncertain("human-review")
  .otherwise("ship");

const change = {
  id: "PR-42",
  summary: "Remove the public retry option.",
  diff: "- retry?: number;",
};
const verdict = await questions.about(change).decide(review);
// "block" | "migration-required" | "human-review" | "ship"
```

These cutoffs are illustrative. Neither a provider's probabilities nor a prompted model's
estimates establish measured accuracy. Tune them against representative cases before making
consequential decisions. An inferred result is not authorization to publish or change data.

Construction performs no inference. Each `.when()` callback runs synchronously once to create
an immutable condition description; it does not receive model answers. Derived builders do not
mutate their predecessors. Finish a policy with `.otherwise()`; there is no additional build step.

Native keys identify observations locally: using `impact` in several rules still sends one
`impact` question. Each execution evaluates the whole declared batch once, even if some rules
will not be reached. Configured provider retries may create more HTTP attempts; they do not
retry policy selection or application functions.

## Conditions and probability cutoffs

`accept` and `reject` are finite values satisfying `0 <= reject < accept <= 1`. An individual
condition can override either value; the resolved pair is validated at construction time.

| Mass of the condition's selected outcomes | Status      |
| ----------------------------------------- | ----------- |
| At least `accept`                         | `match`     |
| At most `reject`                          | `miss`      |
| Between the cutoffs                       | `uncertain` |

Inclusive comparisons account for ordinary floating-point addition/complement rounding at a
boundary. The original probabilities, provenance and precision are retained, not renormalized.

| Reference                      | Operations                                                          |
| ------------------------------ | ------------------------------------------------------------------- |
| Boolean                        | `.is(true)`, `.is(false)`                                           |
| Finite choice                  | `.is(value)`, `.oneOf(values)`                                      |
| Score or finite numeric choice | `.is(value)`, `.oneOf(values)`, `.atLeast(level)`, `.atMost(level)` |
| Any condition                  | `.and(other)`, `.or(other)`, `.not()`                               |

All leaf operations accept optional cutoff overrides as their final argument. `.oneOf()` sums
distinct outcomes once and rejects an empty set or an undeclared value. Labels remain literal
TypeScript unions; invalid options are also rejected at runtime.

Score comparisons use **probability mass over qualifying levels**, not the weighted score. For
a three-level rubric, `.atLeast(1)` adds the probabilities for levels `1` and `2`. Numeric choices
use their actual declared numeric values. The threshold in `.atLeast(1)` is a level boundary;
`thresholds.accept` is a probability boundary. They are different quantities.

Use `.and()` and `.or()`, not JavaScript `&&` or `||`. Conditions are objects, so JavaScript logical
operators cannot compose them. Three-valued composition does not multiply probabilities or
assume independent questions:

| Left      | Right     | `.and()`  | `.or()`   |
| --------- | --------- | --------- | --------- |
| match     | match     | match     | match     |
| match     | miss      | miss      | match     |
| match     | uncertain | uncertain | match     |
| miss      | miss      | miss      | miss      |
| miss      | uncertain | miss      | uncertain |
| uncertain | uncertain | uncertain | uncertain |

Both operators are symmetric. `.not()` swaps match and miss while keeping uncertainty.
Conditions from a different `Policy.from()` definition cannot be combined. Nesting is bounded
to 100 levels; invalid or asynchronous condition callbacks fail during construction.

## Priority, values and failures

Rules are considered in declaration order. A match selects its value. A miss advances to the
next rule. An uncertain rule **stops selection**, even if a later rule would match.

For the review above:

| P(breaking) | P(regression) | Result               |
| ----------- | ------------- | -------------------- |
| 0.94        | 0.91          | `block`              |
| 0.94        | 0.35          | `migration-required` |
| 0.94        | 0.62          | `human-review`       |
| 0.05        | 0.62          | `ship`               |

`.otherwise()` runs only after every rule misses. `.onUncertain(value)` is optional and can be
specified once; omitting it makes uncertainty throw `UncertainPolicyError`. An explicit
`.onUncertain(undefined)` remains a configured result, not a missing handler.

Results are **static JSON-compatible data or top-level `undefined`**, snapshotted and frozen at
construction. Functions, promises, class instances and non-finite numbers are not policy values.
Object results preserve discriminated literal unions without repetitive `as const` annotations.
Keep actions in ordinary application code after `.decide()`, or in descriptive branches.

Existing client/call `confidence` gates and schema confidence minima are additional **hard
constraints**, checked before policy selection. They are not replaced by probability cutoffs.
For example, boolean `P(true) = 0.8` has `Answer.confidence() = 0.6`, not `0.8`. A failed confidence
gate still throws `UncertainDecision`; it does not select the policy's `onUncertain` value.

Malformed responses, provider failures, schema-refinement failures, cancellation and timeouts
retain their original error contracts. None become `otherwise` or `onUncertain` values, and
none trigger an implicit retry. The entire provider batch is validated before Zod callbacks or
policy interpretation, including questions that later turn out not to affect the result.

## Detailed runs and replay

Use `.run(policy)` **instead of** `.decide(policy)` when evidence and diagnostics are needed:

```ts
const execution = await questions.about(change).run(review);
console.log(execution.value);
console.log(execution.trace.selected);
console.log(execution.evidence?.answers.impact);

// Explicitly performs NEW inference over captured inputs. May incur another charge.
const repeated = await execution.replay({ timeout: "10 seconds" });
console.log(repeated.value, repeated.trace);
```

Calling both `.decide()` and `.run()` performs two executions. There is no implicit cache.
Replay captures the original context and policy, does not reread a live source, and never
executes a business handler. It retains effective settings unless overridden and never reuses
the previous AbortSignal. Zod refinements execute again. No offline simulation is introduced.

A policy execution retains the existing `operationId`, `evidence`, `diagnostics` and `replay`
contract and adds `trace`. Trace rules have zero-based indexes and only include reached rules.
The selected entry identifies a rule, an uncertain rule, or the otherwise result. Condition
traces preserve input paths, selected outcomes, observed mass, cutoffs and available probability
provenance. Composite traces retain the conditions they combined; they have no fabricated joint
probability or generated explanation of the model's internal reasoning.

`UncertainPolicyError` includes the validated `evidence` and `trace` for an unhandled uncertain
rule. Traces and evidence can contain sensitive information: they are not automatically included
in semantic hooks. A `decide`, `run` or `replay` produces one top-level lifecycle operation, not
extra events for its internal helpers. Both policy and routing uncertainty use the existing
`uncertain` error-event kind.

## Zod decision schemas

Only the definition changes; the rule and execution syntax remains the same:

```ts
import { z } from "zod";

const schemaReview = Policy.from(
  z.object({
    impact: z.enum(["none", "breaking"]).describe("Can existing consumers break?"),
    regression: z.boolean().describe("Are there indications of regression?"),
  }),
  { thresholds: { accept: 0.8, reject: 0.2 } },
)
  .when(({ impact, regression }) => impact.is("breaking").and(regression.is(true)), "block")
  .onUncertain("human-review")
  .otherwise("ship");
```

This schema describes **decisions**, not the application's `change` input. Input validation can
stay in the application. Native question batches remain usable without declaring a Zod schema;
the root package still requires its existing Zod peer.

Policy references support required objects, fixed tuples, booleans, finite enums/literal choices,
annotated finite choices and score rubrics, readonly wrappers, constants, and local refinements
including asynchronous refinements. References mirror the **schema input** paths and translate
the compiler's wire IDs/options back to the original primitive values. Zod Classic and Mini use
the same path. Constant-only policies require no model or live-context call but still perform
local schema validation.

For this initial API, transforms/pipes/overwrites, optional/nullable/default/catch/presence wrappers,
recursive schemas and probability-number annotations are rejected **before inference**. Use a
boolean decision and `.is(true, limits)` to express probability thresholds. This avoids pretending
an output transformation, weighted value or optional absence has an unambiguous probability
mapping. Free strings and dynamic arrays remain outside the finite compiler's contract.
`ask(schema)` retains all its existing supported wrappers and transformations; it is not narrowed
by these policy restrictions. See [schemas](schemas.md).

## Descriptive branches

Extend the existing `branch()` operation rather than creating a second procedure registry:

```ts
async function answerChange(request: { ask: string; change: typeof change }) {
  return questions.about(request.ask).branch(
    "Which operation satisfies the request?",
    {
      review: {
        description: "Assess release safety, migration needs or human review.",
        examples: ["Is this safe to release?", "Will this break existing consumers?"],
        enabled: request.change.diff.trim().length > 0,
        run: ({ signal }) => questions.about(request.change).decide(review, { signal }),
      },
      explain: {
        description: "Return the existing summary without assessing release safety.",
        examples: ["What changed?", "Show the summary."],
        run: () => request.change.summary,
      },
    },
    {
      selection: { minProbability: 0.75, minMargin: 0.2, allowUnmatched: true },
      onUncertain: () => "Do you need a release review or the summary?",
      onUnmatched: ({ reason }) =>
        reason === "unavailable"
          ? "No operations are currently available."
          : "This assistant does not handle that request.",
    },
  );
}
```

Only `request.ask` is routing context. Serializable descriptions/examples describe available
operations; handlers, eligibility values and closed-over application data are not sent. The
selected handler accesses the full request through an ordinary closure. The model selects an
operation ID; it does **not** generate arguments or synthesize an invocation.

`enabled` is a local boolean, not authorization. Validate authorization, business preconditions
and idempotency inside the actual action. Guidance, eligibility, criteria and fallback references
are snapshotted before awaiting context so caller mutation cannot switch the selected handler.

### Selection and no-match behavior

`minProbability` and `minMargin` default to `0` in new descriptive/criteria-based routing. The
margin is the top probability minus the second highest, **including rejection when enabled**.
Exact ties remain uncertain even at a zero minimum. Tiny arithmetic roundoff at inclusive cutoffs
is tolerated without modifying evidence. Changing the available alternatives changes the
classification problem and requires rechecking calibrated cutoffs.

`allowUnmatched` defaults to `false` for compatibility. Explicitly setting it to `true` adds a
“none of these operations” alternative. Its transport ID is collision-free; public ranked
results represent it as `id: null` rather than reserving an application key.

| Situation                                        | Behavior                                                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| A real option passes probability/margin criteria | Run that handler once                                                                                 |
| Exact tie or selection criterion fails           | `onUncertain`, otherwise `UncertainBranchError`                                                       |
| Rejection wins and passes the same criteria      | `onUnmatched` with `reason: "unmatched"`, otherwise `UnmatchedBranchError`                            |
| No enabled operations                            | No context or inference; `onUnmatched` with `reason: "unavailable"`, otherwise `UnmatchedBranchError` |
| One enabled operation with rejection enabled     | Compare that operation with rejection in one inference                                                |
| One enabled operation without rejection          | Fail validation; never select by elimination                                                          |

`onUncertain` receives `{ signal, reason, ranked, evidence }`; its reason is `tie`,
`min-probability` or `min-margin`. `onUnmatched` receives the same fields, but evidence is
undefined when no operations are enabled. Rankings and evidence are frozen. Missing-handler
errors retain these details without storing the operation's live signal.

These fallbacks are **not catch handlers**. Confidence gates still throw `UncertainDecision`.
Invalid provider data, timeouts, cancellation, provider failures and handler failures propagate
without invoking another branch. Semantic `onDecision` runs once before the selected business
or fallback handler; it can cancel execution. The same operation signal/deadline covers inference
and that handler, while arbitrary noncooperative promises cannot be forcibly stopped.

Function-only maps with no new routing criteria or callbacks keep their previous key-based
guidance and declared-winner/tie behavior. Mixing functions and descriptors is supported, using
the safer descriptive routing semantics for the entire call. New criteria/callbacks also opt a
function-only map into those semantics. Empty old-style function maps still fail validation;
explicit no-match configuration or a fully disabled descriptor map can represent unavailable.

### Evaluation counts

A direct `decide(review)` takes one logical evaluation for its question batch. A summary-only
branch takes one routing evaluation. Selecting the review branch adds the policy evaluation,
for a total of two. Invoking a known operation directly skips routing entirely. There is no
hidden caching, replay, persistent queue or autonomous loop. Configured transport retries are
separate from logical evaluation counts.

## Streams

```ts
import { Streams } from "@nitoba/questions";

const decisions = await Streams.from([change])
  .map((item, { signal }) => questions.about(item).decide(review, { signal }), {
    concurrency: 4,
    ordered: true,
  })
  .toArray({ maxItems: 100 });
```

One policy evaluation per item; stream concurrency is not collection batching. Reconsumption
performs new work. See [streams](streams.md) and the executable
[policy and routing tutorial](../examples/18-policies-and-routing.ts), which is covered by
offline tests. The runtime/typing suites verify selection semantics and API contracts, not real
model accuracy or production calibration.
