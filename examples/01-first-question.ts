/**
 * 01 — A first decision: does a museum visitor need a step-free entrance?
 *
 * Run: TYPESAFE_API_KEY=... bun examples/01-first-question.ts
 * Prerequisites: bun install. Two evaluations; no Zod and no streams.
 * Learn: explicit provider injection, about(), is(), probability(), ordinary eager Promises.
 * Observe: a boolean and a number in [0, 1], not generated prose.
 */
import { Questions, TypeSafe, type QuestionsClient } from "../src/index.ts";
import { cli, required } from "./shared/runtime.ts";

export async function main(client: QuestionsClient) {
  const visit = client.about({
    request: "We are bringing a stroller and would prefer an entrance without stairs.",
    entrances: ["Main stairs", "Courtyard ramp"],
  });

  // Step 1: ask for a yes/no decision.
  const needsRamp = await visit.is("Does the visitor need a step-free entrance?");

  // Step 2: request the probability rather than letting the library project it to boolean.
  // This is a NEW evaluation; reuse evidence (tutorial 06) to derive several views of one call.
  const probability = await visit.probability("Does the visitor need a step-free entrance?");
  console.log({ needsRamp, probability });
  return { needsRamp, probability };
}

if (import.meta.main) {
  await cli(async () => {
    const apiKey = required("TYPESAFE_API_KEY");
    const client = Questions.create({
      model: TypeSafe.create({ apiKey, timeout: "15 seconds" }),
    });
    await main(client);
  });
}
