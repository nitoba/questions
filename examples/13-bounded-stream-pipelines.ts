/**
 * 13 — Search-result screening: bounded per-item evaluation, then collection micro-batches.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/13-bounded-stream-pipelines.ts
 * Up to eight evaluations: three screening calls, two micro-batches, three predicate calls.
 * Native questions, no Zod. Learn: filter type guard, async predicate, map concurrency/order,
 * batch, tap, take, toArray and forEach. A new consumption repeats inference.
 */
import { Streams, type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export async function main(client: QuestionsClient) {
  const excerpts: readonly (string | null)[] = [
    "A guide to browser accessibility and keyboard navigation.",
    null,
    "A report about warehouse forklifts.",
    "Testing accessible forms with screen readers.",
  ];
  const relevant = Streams.from(excerpts)
    .filter((item): item is string => item !== null)
    .map(
      async (text, { signal, index }) => ({
        text,
        index,
        keep: await client.about(text).is("Is this relevant to web accessibility?", { signal }),
      }),
      { concurrency: 2, ordered: false },
    )
    .filter((row) => row.keep)
    .tap((row) => {
      console.log("Relevant excerpt", row.index);
    })
    .take(3);
  const rows = await relevant.toArray({ maxItems: 3 });

  // We use the MATERIALIZED rows, not a second consumption of `relevant`.
  const recommendations: { text: string; beginner: boolean }[] = [];
  await Streams.from(rows)
    .batch(2)
    .map(async (batch, { signal }) => {
      const beginner = await client
        .each(batch, (row) => row.text)
        .is("Is the excerpt suitable for a beginner?", { signal });
      return batch.map((row, index) => ({ text: row.text, beginner: beginner[index]! }));
    })
    .forEach((batch) => {
      recommendations.push(...batch);
    });

  // Client predicates also compose directly with async filter (sequential evaluation).
  const predicate = client.is("Does this explicitly mention keyboard navigation?");
  const keyboard = await Streams.from(rows.map((row) => row.text))
    .filter((text, { signal }) => predicate(text, { signal }))
    .toArray({ maxItems: 3 });
  console.log({ recommendations, keyboard });
  return { recommendations, keyboard };
}
if (import.meta.main) await cli(async () => main(await liveClient()));
