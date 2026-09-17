/**
 * 03 — Conference planning: select original objects, rank alternatives, dispatch one branch.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/03-select-and-route.ts
 * Or select QUESTIONS_PROVIDER=generative; see the shared configuration in examples/README.md.
 * Three evaluations; no Zod and no streams.
 * Learn: choose returns identity, rank returns every candidate, branch runs only one handler.
 * Only descriptions cross the model boundary; private contact data stays local.
 */
import { type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export const rooms = [
  {
    id: "workshop",
    description: "Small hands-on lab with desks and power",
    privateContact: "local-only",
  },
  {
    id: "auditorium",
    description: "Large seated keynote hall with a stage",
    privateContact: "local-only",
  },
  { id: "unassigned", description: "Needs organizer review", privateContact: "local-only" },
] as const;

export async function main(client: QuestionsClient) {
  const q = client.about(
    "Forty developers will build a working browser extension in a guided lab.",
  );
  const chosen = await q.choose(
    "Which room best fits the session?",
    rooms,
    (room) => room.description,
  );
  console.log("Original object:", rooms.includes(chosen), chosen.id);

  // Stable record keys are useful when enumeration order is not a domain identifier.
  const ranking = await q.rank(
    "Which room fits best?",
    Object.fromEntries(rooms.map((room) => [room.id, room])),
    (room) => room.description,
  );
  const action = await q.branch("What follow-up does this session need?", {
    "Hands-on workshop": ({ signal }) => {
      signal.throwIfAborted();
      return { checklist: "Prepare desk power and starter repository" };
    },
    "Presentation or keynote": () => ({ checklist: "Schedule an AV rehearsal" }),
    "Not enough information": () => ({ checklist: "Ask the organizer for clarification" }),
  });
  // These handlers build local plans; no invitation, purchase or booking is sent automatically.
  console.log(
    ranking.map(({ value, probability }) => ({ id: value.id, probability })),
    action,
  );
  return { chosen, ranking, action };
}
if (import.meta.main) await cli(async () => main(await liveClient()));
