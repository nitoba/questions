import { test } from "bun:test";
import assert from "node:assert/strict";
import { Questions, TypeSafe, ProviderError } from "../src/index.ts";
import * as Vercel from "../src/providers/vercel.ts";

for (const provider of [TypeSafe, Vercel]) {
  test(`${provider === TypeSafe ? "TypeSafe" : "Vercel"} handles arbitrary thrown fetch values`, async () => {
    for (const cause of [undefined, null, "offline"]) {
      let calls = 0;
      const model = provider.create({
        apiKey: "test",
        retry: { maxRetries: 1, networkErrors: true, delayMs: 0 },
        fetch: (async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
          calls++;
          throw cause;
        }) as typeof fetch,
      });
      await assert.rejects(
        Questions.create({ model }).about("ticket").is("Urgent?"),
        ProviderError,
      );
      assert.equal(calls, 2);
    }
  });
}
