import { Question, Streams } from "../src/index.ts";
import type { Values } from "../src/index.ts";
import { liveClient } from "./client.ts";

const questions = liveClient();
const transcript = [
  { from: "customer", text: "My account was charged twice." },
  { from: "agent", text: "Could you confirm the invoice numbers?" },
  { from: "customer", text: "INV-10 and INV-11. This is the second month; I need a manager." },
  { from: "agent", text: "The duplicate charge is now refunded." },
  { from: "customer", text: "I see it. That solves everything, thanks." },
];
const batch = {
  stage: Question.choice("What is the customer's situation after the latest message?", {
    open: "Still investigating", escalated: "Customer asks for a manager or threatens to leave", resolved: "Customer confirms resolution",
  }),
  temperature: Question.score("How is the customer feeling?", ["Calm", "Frustrated", "Very angry"]),
};
type Stage = Values<typeof batch>["stage"];

const events = Streams.from(transcript)
  .scan(() => [] as typeof transcript, (log, message) => [...log, message])
  .filter((log) => log.at(-1)?.from === "customer")
  .map((log, { signal }) => questions.about({ transcript: log }).ask(batch, { signal }))
  .mapAccum(() => "open" as Stage, (previous, observed) => {
    const stage = previous === "escalated" && observed.stage === "open" ? previous : observed.stage;
    return [stage, [{ ...observed, stage, changed: stage !== previous }]] as const;
  })
  .takeUntil((event) => event.stage === "resolved");

await events.forEach((event) => { console.log(event); }, { signal: AbortSignal.timeout(60_000) });
