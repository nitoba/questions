/**
 * 06 — Editorial review: compare policies over ONE evidence batch.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/06-evidence-and-decision-costs.ts
 * Or select QUESTIONS_PROVIDER=generative; see the shared configuration in examples/README.md.
 * One evaluation. No Zod and no streams. All Answer/Decision calculations below are local.
 * Learn: complete distributions, confidence vs probability, aggregation and expected loss.
 * Costs are illustrative editorial effort units, not measured model accuracy.
 */
import {
  Answer,
  Decision,
  Question,
  UncertainDecision,
  type QuestionsClient,
} from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export async function main(client: QuestionsClient) {
  const evaluation = await client
    .about({
      draft: "A guest article repeats several claims but provides no citations.",
      policy:
        "Verify factual claims before publishing. Do not infer that missing citations make a claim false.",
    })
    .evidence({
      needsSources: "Does the draft need additional sources?",
      category: Question.choice("What is the principal editorial issue?", {
        unsupported: "Factual claims without supporting sources",
        style: "Writing clarity or formatting",
        ready: "Ready for editorial approval",
      }),
    });
  const answer = evaluation.answers.category;
  const booleanDistribution = Answer.fromBoolean(evaluation.answers.needsSources);
  const shortlist = Answer.topK(answer, 2);
  const ranking = Answer.rank(answer);
  const margin = Answer.margin(answer);
  const reviewProbability = Answer.probabilityOf(answer, (key) => key !== "ready");
  const groups = Answer.coarsen(answer, (key) => (key === "ready" ? "ready" : "review"));
  const effort = Answer.expectedValue(
    answer,
    (key) => ({ unsupported: 30, style: 10, ready: 2 })[key],
  );
  const confidence = Answer.confidence(answer);

  const costs = {
    publish: { unsupported: 100, style: 10, ready: 0 },
    requestRevision: { unsupported: 5, style: 4, ready: 8 },
    humanReview: 3,
  };
  const risks = Decision.risks(answer, costs);
  const selected = Decision.minimizeLoss(answer, costs);
  const plan = await Decision.match(selected, {
    publish: () => "Prepare a publication candidate; an editor still approves it.",
    requestRevision: async () => "Prepare an author revision checklist.",
    humanReview: () => "Add the article to an editor's review queue.",
  });
  let confident = true;
  try {
    Decision.requireConfidence(answer, 0.8);
  } catch (error) {
    if (!(error instanceof UncertainDecision)) throw error;
    confident = false;
  }
  console.log({
    shortlist,
    ranking,
    margin,
    reviewProbability,
    groups,
    effort,
    confidence,
    probabilitySource: answer.probabilitySource ?? "unreported",
    confidenceSource: answer.confidenceSource ?? "unreported",
    confident,
    risks,
    plan,
    booleanDistribution,
    usage: evaluation.usage,
  });
  // With Generative these are prompted estimates, NOT measured accuracy or interchangeable thresholds.
  // None of these calculations triggers another evaluation or actually publishes the article.
  return { evaluation, selected, plan };
}
if (import.meta.main) await cli(async () => main(await liveClient()));
