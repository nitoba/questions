/**
 * 14 — Training-session feedback: turn a sequence into transitions and summaries.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/14-stateful-streams.ts
 * Or select QUESTIONS_PROVIDER=generative; see the shared configuration in examples/README.md.
 * At most three evaluations. Native questions, no Zod.
 * Learn: defer/fresh async iterators, mapAccum, isolated seeds, scan, takeUntil/takeWhile,
 * for-await cancellation. No hidden background listener or unbounded state history.
 */
import { Streams, type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

type Transition = { kind: "help-needed" | "resolved"; message: string };

export async function main(client: QuestionsClient) {
  const source = Streams.defer(({ signal }) =>
    (async function* () {
      try {
        for (const message of [
          "I cannot start the exercise.",
          "I found the setup command.",
          "The exercise now works.",
        ]) {
          signal.throwIfAborted();
          yield message;
        }
      } finally {
        console.log("Feedback source closed"); // Also runs when an async iterator is closed early.
      }
    })(),
  );
  const transitions = source.mapAccum(
    () => ({ waitingForHelp: false }),
    async (
      state,
      message,
      { signal },
    ): Promise<readonly [{ waitingForHelp: boolean }, readonly Transition[]]> => {
      const waitingForHelp = await client
        .about(message)
        .is("Is the attendee currently blocked and asking for help?", { signal });
      const events: Transition[] =
        waitingForHelp === state.waitingForHelp
          ? []
          : [{ kind: waitingForHelp ? "help-needed" : "resolved", message }];
      return [{ waitingForHelp }, events];
    },
  );
  const events: Transition[] = [];
  for await (const event of transitions.takeUntil((event) => event.kind === "resolved")) {
    events.push(event);
    console.log(event);
  }

  // Pure local summary over retained transitions: no second inference.
  const counts = await Streams.from(events)
    .scan(
      () => ({ requested: 0, resolved: 0 }),
      (state, event) => ({
        requested: state.requested + Number(event.kind === "help-needed"),
        resolved: state.resolved + Number(event.kind === "resolved"),
      }),
    )
    .toArray({ maxItems: 3 });
  const beforeResolution = await Streams.from(events)
    .takeWhile((event) => event.kind !== "resolved") // Exclusive, unlike takeUntil.
    .toArray({ maxItems: 3 });
  return { events, counts, beforeResolution };
}
if (import.meta.main) await cli(async () => main(await liveClient()));
