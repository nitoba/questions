import { z } from "zod";
import { Questions, Schema, Streams } from "../src/index.ts";
import * as Vercel from "../src/providers/vercel.ts";

const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error("Set AI_GATEWAY_API_KEY; this live example may incur charges");
const questions = Questions.create({
  model: Vercel.create({
    apiKey,
    model: process.env.GATEWAY_EVALUATION_MODEL ?? "typesafe-ai/jev",
    timeoutMs: 15_000,
  }),
});

const triage = z
  .object({
    urgent: z.boolean().describe("Does this incident prevent production work?"),
    team: z.enum(["billing", "platform"]).meta({
      description: "Which team should investigate?",
      questions: {
        options: {
          billing: "Invoices and payments",
          platform: "API, infrastructure and deployments",
        },
      },
    } satisfies Schema.Metadata),
    impact: z
      .number()
      .min(0)
      .max(2)
      .register(Schema.registry, {
        kind: "score",
        instructions: "How disruptive is the incident?",
        levels: ["Minor", "Impaired", "Unavailable"],
      }),
  })
  .transform((value) => ({ ...value, queue: `support:${value.team}` }));

// Every item is one paid evaluation. This is item streaming, never a fake token stream.
await Streams.from(["The production API returns 503 after deployment", "Please resend my invoice"])
  .map((ticket, { signal }) => questions.about(ticket).ask(triage, { signal }), { concurrency: 2 })
  .forEach(
    (result) => {
      console.log(result);
    },
    { signal: AbortSignal.timeout(30_000) },
  );
