/**
 * 02 — A typed decision shape without Zod: classify an equipment maintenance note.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/02-native-question-schema.ts
 * One batched evaluation + one standalone score. No Zod and no streams.
 * "Schema" here means a native Question.Batch, NOT JSON Schema or a Zod-compatible codec.
 * Learn: boolean criteria, choice literals, score rubrics, Values inference, satisfies.
 */
import { Question, type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export const inspection = {
  stopMachine: Question.boolean("Does this report recommend taking the machine out of service?", {
    true: "The report explicitly calls for stopping the machine.",
    false: "The report permits continued operation or only routine maintenance.",
  }),
  category: Question.choice("Which maintenance team should inspect the report?", {
    electrical: "Wiring, sensors, power and control circuits",
    mechanical: "Bearings, belts, lubrication and moving parts",
    unknown: "Insufficient evidence to select a specialist",
  }),
  disruption: Question.score("How disruptive is the reported condition?", [
    "Routine maintenance",
    "Reduced throughput",
    "Unable to operate",
  ]),
} satisfies Question.Batch;

export type Inspection = Question.Values<typeof inspection>;

export async function main(client: QuestionsClient) {
  const q = client.about("The conveyor bearing is grinding; the operator stopped the line.");
  const result: Inspection = await q.ask(inspection); // One request for three independent decisions.
  const disruption = await q.score("How disruptive is this?", ["Routine", "Reduced", "Stopped"]);
  // Score is a probability-weighted index in [0, 2], not necessarily an integer.
  // A semantic label is not permission to operate dangerous equipment.
  console.log(result, { disruption });
  return result;
}
if (import.meta.main) await cli(async () => main(await liveClient()));
