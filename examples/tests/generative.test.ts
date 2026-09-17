import { test } from "bun:test";
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { tutorial } from "../17-generative-models.ts";

/** Exercise the actual tutorial, not a second implementation or live paid fallback. */
test("generative tutorial exposes the inferred assessment and its estimated field provenance", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            q0: 0.9,
            q1: { o0: 0.7, o1: 0.2, o2: 0.1 },
            q2: { o0: 0.1, o1: 0.3, o2: 0.6 },
          }),
        },
      ],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 12, noCache: 12, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 4, text: 4, reasoning: undefined },
      },
      warnings: [],
    },
  });
  const result = await tutorial(model);
  assert.deepEqual(result.value, { needsReview: true, owner: "platform", impact: 1.5 });
  assert.equal(result.generation?.probabilitySource, "estimated");
  assert.deepEqual(
    result.diagnostics.map((field) => field.path),
    [["needsReview"], ["owner"], ["impact"]],
  );
  assert.ok(result.diagnostics.every((field) => field.answer.probabilitySource === "estimated"));
  assert.equal(model.doGenerateCalls.length, 1);
});
