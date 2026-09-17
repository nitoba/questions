// Compile-only contracts. Invalid examples must continue producing TypeScript diagnostics.
import { Questions, Question, Decision, Streams } from "../src/index.ts";
import type { QuestionModel, Stream, ChoiceAnswer } from "../src/index.ts";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
function exact<T extends true>() {}

export async function typeContracts(model: QuestionModel, evidence: ChoiceAnswer<"billing" | "support">) {
  const q = Questions.create({ model }).about("Context");
  const batch = {
    blocked: "Blocked?",
    team: Question.choice("Who?", { billing: "Invoices", support: "Bugs" }),
    priority: Question.score("Urgency?", ["Low", "High"]),
  };
  const values = await q.ask(batch);
  exact<Equal<typeof values.blocked, boolean>>();
  exact<Equal<typeof values.team, "billing" | "support">>();
  exact<Equal<typeof values.priority, number>>();
  // @ts-expect-error nonexistent batch key
  values.missing;
  // @ts-expect-error choice keys are not arbitrary strings
  const invalid: typeof values.team = "sales";
  void invalid;
  const full = await q.evidence(batch);
  exact<Equal<typeof full.answers.team.choice, "billing" | "support">>();
  // @ts-expect-error nonexistent probability key
  full.answers.team.probabilities.sales;
  const candidates = [{ id: "one", label: "One" }, { id: "two", label: "Two" }] as const;
  const chosen = await q.choose("Which?", candidates, (candidate) => candidate.label);
  exact<Equal<typeof chosen, (typeof candidates)[number]>>();
  const result = await q.branch("Route?", {
    "Invoices": () => ({ kind: "billing" as const }),
    "Bugs": async () => ({ kind: "support" as const }),
  });
  exact<Equal<typeof result, { kind: "billing" } | { kind: "support" }>>();
  const matched = Decision.match(evidence, { billing: () => 1 as const, support: () => "support" as const });
  exact<Equal<typeof matched, 1 | "support">>();
  // @ts-expect-error exhaustive handlers are required for every possible evidence choice
  Decision.match(evidence, { billing: () => 1 });
  // @ts-expect-error a cost table must include every evidence outcome
  Decision.risks(evidence, { send: { billing: 0 } });
  // @ts-expect-error scores require two levels
  Question.score("How?", ["Low"]);
  const narrowed = Streams.from<string | number>(["a", 1]).filter((item): item is string => typeof item === "string");
  const strings: Stream<string> = narrowed;
  const lengths: number[] = await strings.map((s) => s.length).toArray();
  void lengths;
  const rows = await Questions.create({ model }).each(["a", "b"]).ask(batch);
  exact<Equal<(typeof rows)[number]["team"], "billing" | "support">>();
}
