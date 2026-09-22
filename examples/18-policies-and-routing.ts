/**
 * 18 — Reusable policies, ordered uncertainty, and routing ordinary functions.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/18-policies-and-routing.ts
 * Or use the shared QUESTIONS_PROVIDER configuration in examples/README.md.
 * Unreleased API: run from this checkout, not the published rc.3 package.
 * Cost: four or five evaluations (one direct policy, two stream items, one router,
 * plus one policy only if the router selects review). No hidden replay or retries.
 * Each policy batches its two questions once. Thresholds are illustrative, not calibration.
 */
import { z } from "zod";
import { Policy, Question, Streams, type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export type Change = {
  readonly id: string;
  readonly summary: string;
  readonly diff: string;
};
export const changes: readonly Change[] = [
  {
    id: "PR-42",
    summary: "Remove the public retry configuration field.",
    diff: "- retry?: number;\nExisting integrations still pass this field.",
  },
  {
    id: "PR-43",
    summary: "Add an optional label to diagnostic events.",
    diff: "+ label?: string;\nExisting fields and behaviors are unchanged.",
  },
];

export const releaseReview = Policy.from(
  {
    impact: Question.choice("Classify the public API impact of this change.", {
      none: "No public API change.",
      additive: "Adds API without changing existing behavior.",
      behavioral: "Changes how an existing API behaves.",
      breaking: "Existing consumers can break.",
    }),
    regression: Question.boolean("Does the change contain concrete indications of a regression?"),
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

// Zod describes the decisions, not the Change input. This policy is constructed but not
// executed by main(), so showing the alternative does not incur another evaluation.
export const zodReview = Policy.from(
  z.object({
    impact: z.enum(["none", "breaking"]).describe("Can existing API consumers break?"),
    regression: z.boolean().describe("Are there concrete indications of regression?"),
  }),
  { thresholds: { accept: 0.8, reject: 0.2 } },
)
  .when(({ impact, regression }) => impact.is("breaking").and(regression.is(true)), "block")
  .onUncertain("human-review")
  .otherwise("ship");

/** Reuse plain functions. Only the intent enters the routing prompt; no arguments are generated. */
export function answerChange(client: QuestionsClient, request: { ask: string; change: Change }) {
  return client.about(request.ask).branch(
    "Which operation satisfies the request?",
    {
      review: {
        description: "Assess whether a change requires blocking, migration or human review.",
        examples: ["Is this safe to release?", "Will this break existing consumers?"],
        enabled: request.change.diff.trim().length > 0,
        run: ({ signal }) => client.about(request.change).decide(releaseReview, { signal }),
      },
      explain: {
        description: "Return the existing summary of a change, without assessing release safety.",
        examples: ["What changed?", "Show the summary."],
        run: () => request.change.summary,
      },
    },
    {
      selection: { minProbability: 0.75, minMargin: 0.2, allowUnmatched: true },
      onUncertain: () => "Do you need a release review or the existing summary?",
      onUnmatched: ({ reason }) =>
        reason === "unavailable"
          ? "No operations are available for this input."
          : "This assistant cannot fulfill that request.",
    },
  );
}

/** The same policy is reusable across direct, detailed, stream and routed execution. */
export async function main(client: QuestionsClient) {
  // run() instead of decide(): keep the result AND its trace from the SAME evaluation.
  const detailed = await client.about(changes[0]!).run(releaseReview);
  // detailed.replay() would perform a new potentially paid inference; it is not called here.
  const batch = await Streams.from(changes)
    .map((change, { signal }) => client.about(change).decide(releaseReview, { signal }), {
      concurrency: 2,
      ordered: true,
    })
    .toArray({ maxItems: 2 });
  const routed = await answerChange(client, {
    ask: "Show the existing summary.",
    change: changes[0]!,
  });
  return { direct: detailed.value, trace: detailed.trace, batch, routed };
}

if (import.meta.main)
  await cli(async () => {
    const result = await main(await liveClient());
    // Fictional examples only. Evidence and traces can contain sensitive prompt details.
    console.log(JSON.stringify(result, null, 2));
  });
