/**
 * 04 — Catalog enrichment: one request for a whole finite collection.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/04-collection-batching.ts
 * Three batched evaluations; no Zod, no streams, no Promise.all.
 * Learn: each().ask/is/score, preserving input order, redacting private fields, empty batches.
 * Batch only manageable collections; one request still has a provider context/criteria limit.
 */
import { Question, type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export const products = [
  { sku: "KIT-1", description: "An unassembled oak desk kit with screws.", supplierCost: 48 },
  { sku: "LAMP-2", description: "An assembled reading lamp, bulb included.", supplierCost: 12 },
  {
    sku: "SHELF-3",
    description: "Wall shelves; mounting hardware sold separately.",
    supplierCost: 21,
  },
];
export async function main(client: QuestionsClient) {
  const collection = client.each(products, (product) => product.description);
  const tags = await collection.ask({
    assembly: "Does the customer need to assemble this item?",
    department: Question.choice("Which catalog department fits?", {
      furniture: "Furniture and storage",
      lighting: "Lamps and light fixtures",
      other: "Something else or unclear",
    }),
  });
  const hardware = await collection.is(
    "Does the listing explicitly include the required hardware?",
  );
  const effort = await collection.score("How much setup effort is needed?", [
    "None",
    "Some",
    "Substantial",
  ]);
  const rows = products.map(({ sku }, index) => ({
    sku,
    tags: tags[index],
    hardware: hardware[index],
    effort: effort[index],
  }));
  const empty = await client.each([]).ask({ assembly: "Assembly needed?" }); // [] and zero inference.
  console.table(rows);
  return { rows, empty };
}
if (import.meta.main) await cli(async () => main(await liveClient()));
