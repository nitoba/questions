/**
 * 09 — Team-specific review policies without shared mutable configuration.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/09-derived-clients-and-observability.ts
 * Three evaluations; native Question batches, no Zod and no streams.
 * Learn: extend, precedence, hook arrays/resets, operation IDs, semantic vs HTTP counts.
 */
import { Questions, type QuestionModel } from "../src/index.ts";
import { cli, liveModel } from "./shared/runtime.ts";

export async function main(model: QuestionModel) {
  const events: string[] = [];
  const client = Questions.create({
    model,
    defaults: { timeout: "30 s", confidence: 0.5 },
    hooks: {
      onEvaluate: ({ operationId, operation }) => {
        console.log(operationId, operation);
      },
      onDecision: [
        ({ operation, evaluationCount, usage }) => {
          events.push(`base:${operation}`);
          console.log({ evaluationCount, usage }); // No prompt or result body.
        },
      ],
      onError: ({ kind, stage }) => {
        console.log({ kind, stage });
      },
    },
  });
  const release = client.extend({
    defaults: { confidence: 0.7, timeout: "10 seconds" },
    hooks: {
      onDecision: ({ operation }) => {
        events.push(`release:${operation}`);
      },
    },
  });
  const report = "The release notes contain customer-visible API changes.";
  // A call-level 0 removes the client gate, not any minimum embedded in a schema.
  await release.about(report).is("Are there public API changes?", { confidence: 0 });
  await release.about(report).ask(
    { migrationGuide: "Is a migration guide likely useful?" },
    {
      confidence: 0,
      hooks: { onDecision: false }, // Clear inherited decision hooks for this operation.
    },
  );
  const quiet = release.extend({ defaults: { timeout: false }, hooks: false });
  await quiet.about(report).probability("Are these changes relevant to integration developers?");
  console.log({ original: client.defaults, derived: release.defaults, events });
  return { events, original: client.defaults, derived: release.defaults };
}
if (import.meta.main) await cli(async () => main(await liveModel()));
