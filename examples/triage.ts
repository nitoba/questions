import { Question, UncertainDecision } from "../src/index.ts";
import { liveClient } from "./client.ts";

const q = liveClient().about({
  title: "Production API rejects all requests after credential rotation",
  retries: 3,
});
const result = await q.ask({
  blocked: "Is production work blocked?",
  team: Question.choice("Which team should investigate?", {
    billing: "Invoices and payments",
    platform: "API and deployment failures",
  }),
  impact: Question.score("How disruptive is this?", [
    "Low",
    "Work impaired",
    "Production unavailable",
  ]),
});
console.log(result);
try {
  const owner = await q.branch(
    "Which response is appropriate?",
    {
      "An API or deployment failure": () => ({ queue: "platform", priority: "high" }),
      "An invoice or payment issue": () => ({ queue: "billing", priority: "normal" }),
    },
    { confidence: 0.6 },
  );
  console.log(owner);
} catch (error) {
  if (!(error instanceof UncertainDecision)) throw error;
  console.log("Human review required", { confidence: error.confidence, minimum: error.minimum });
}
