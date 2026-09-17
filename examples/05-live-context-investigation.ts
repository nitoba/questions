/**
 * 05 — Investigate a failed deployment with a bounded async/await loop.
 *
 * Run: TYPESAFE_API_KEY=... bun examples/05-live-context-investigation.ts
 * At most four evaluations. No Zod and no streams.
 * Learn: live context callbacks are read on every operation; a predicate is reusable.
 * No autonomous tools run: observations below are a finite, fictional incident log.
 */
import { type QuestionsClient } from "../src/index.ts";
import { cli, liveClient } from "./shared/runtime.ts";

export async function main(client: QuestionsClient) {
  let findings: string[] = [];
  const observations = [
    "The release job failed after credentials were rotated.",
    "DNS resolution and TLS connectivity both succeeded.",
    "The server returned 403: the new token lacks the deploy:write permission.",
  ];
  const investigation = client.about(({ signal }) => {
    signal.throwIfAborted();
    return { findings }; // Fresh state on each call; no stale closure snapshot.
  });
  let settled = false;
  for (const observation of observations) {
    findings = [...findings, observation];
    settled = await investigation.is("Do the observations establish a specific likely cause?");
    if (settled) break;
  }

  // A predicate can be used by ordinary application code, not only stream.filter().
  const requiresPermissionFix = client.is("Does the report indicate a missing permission?");
  const permissionIssue = await requiresPermissionFix({ findings });
  console.log({ findings, settled, permissionIssue });
  return { findings, settled, permissionIssue };
}
if (import.meta.main) await cli(async () => main(await liveClient()));
