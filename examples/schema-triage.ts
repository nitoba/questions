import { z } from "zod";
import { Schema, SchemaValidationError, Streams } from "../src/index.ts";
import { liveClient } from "./client.ts";

/** One schema supplies natural-language guidance, inferred types and runtime validation. */
export const triage = z
  .object({
    urgent: z.boolean().describe("Does the issue prevent production work?"),
    team: z.enum(["billing", "platform"]).meta({
      description: "Which team should investigate?",
      examples: ["platform"],
      questions: {
        options: { billing: "Invoices and payments", platform: "API outages and deployments" },
      },
    } satisfies Schema.Metadata),
    impact: z
      .number()
      .min(0)
      .max(2)
      .register(Schema.registry, {
        kind: "score",
        instructions: "How disruptive is the problem?",
        levels: ["Minor", "Impaired", "Unavailable"],
      }),
    escalation: z.number().min(0).max(1).register(Schema.registry, {
      kind: "probability",
      instructions: "Will this require specialist escalation?",
    }),
  })
  .transform((result) => ({ ...result, queue: `support:${result.team}` }));

export type Triage = z.output<typeof triage>;

const questions = liveClient();
const tickets = [
  "The production API returns 503 after deployment; no customer can access it.",
  "Please send another copy of the last invoice.",
];

// Two item evaluations, not one token stream. Every consumption incurs fresh inference.
try {
  await Streams.from(tickets)
    .map((ticket, { signal }) => questions.about(ticket).ask(triage, { signal }), {
      concurrency: 2,
    })
    .forEach(
      (result) => {
        console.log(result);
      },
      {
        signal: AbortSignal.timeout(30_000),
      },
    );
} catch (error) {
  if (error instanceof SchemaValidationError) console.error(error.issues);
  throw error;
}
