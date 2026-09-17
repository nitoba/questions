import { Jev, Questions } from "../src/index.ts";

/** Explicit environment access belongs to the application, never inside the library. */
export function liveClient() {
  const apiKey = process.env.TYPESAFE_API_KEY;
  if (!apiKey) throw new Error("Set TYPESAFE_API_KEY to run this live, potentially paid example.");
  return Questions.create({ model: Jev.create({ apiKey, timeoutMs: 15_000 }) });
}
