import { Answer, Decision, Question } from "../src/index.ts";
import { liveClient } from "./client.ts";

const result = await liveClient().about("Duplicate debit reported, but invoice references differ").evidence({
  category: Question.choice("Which situation best fits?", { duplicate: "A duplicated payment", legitimate: "Two distinct purchases" }),
});
const evidence = result.answers.category;
console.log({ ranked: Answer.rank(evidence), separation: Answer.margin(evidence), usage: result.usage });
const decision = Decision.minimizeLoss(evidence, {
  refund: { duplicate: 0, legitimate: 100 },
  reject: { duplicate: 50, legitimate: 0 },
  humanReview: 2,
});
// A model decision is not authorization to transfer money. The application retains that boundary.
console.log({ recommendedAction: decision.choice, alternatives: decision.alternatives });
