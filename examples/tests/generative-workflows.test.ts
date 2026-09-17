import { test, expect } from "bun:test";
import { MockLanguageModelV4 } from "ai/test";
import { Questions } from "../../src/index.ts";
import * as Generative from "../../src/providers/generative.ts";
import { main as native } from "../02-native-question-schema.ts";
import { main as batching } from "../04-collection-batching.ts";
import { main as schemas } from "../07-zod-decision-schemas.ts";
import { main as advanced } from "../07b-zod-advanced-inputs.ts";
import { main as diagnostics } from "../08-schema-diagnostics.ts";
import { main as replay } from "../11-preparation-and-replay.ts";
import { main as streams } from "../13-bounded-stream-pipelines.ts";
import { DeskStore } from "../16-fulfillment-desk/store.ts";
import { shipmentInput } from "../16-fulfillment-desk/domain.ts";
import { assessOne, processPending, report } from "../16-fulfillment-desk/service.ts";

/** Test-only generated distributions, not a live provider, calibration dataset or offline replay. */
function estimatedFixture(uncertain = false) {
  const model = new MockLanguageModelV4({
    doGenerate: async (call) => {
      if (call.responseFormat?.type !== "json") throw new Error("Expected structured output");
      const schema = call.responseFormat.schema as {
        properties: Record<string, { type: string; properties?: Record<string, unknown> }>;
      };
      const output = Object.fromEntries(
        Object.entries(schema.properties).map(([id, field]) => [
          id,
          field.type === "number"
            ? uncertain
              ? 0.5
              : 0.95
            : Object.fromEntries(
                Object.keys(field.properties!).map((option, index) => [
                  option,
                  index === 0
                    ? uncertain
                      ? 0.5
                      : 0.95
                    : index === 1
                      ? uncertain
                        ? 0.5
                        : 0.05
                      : 0,
                ]),
              ),
        ]),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        finishReason: { unified: "stop" as const, raw: "stop" },
        usage: {
          inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
          outputTokens: { total: 5, text: 5, reasoning: undefined },
        },
        warnings: [],
      };
    },
  });
  return {
    model,
    client: Questions.create({ model: Generative.create({ model, evidence: "estimated" }) }),
  };
}

test("existing native, batched and Classic/Mini lessons also run through the generative adapter", async () => {
  const { client, model } = estimatedFixture();
  expect((await native(client)).category).toBe("electrical");
  expect((await batching(client)).rows).toHaveLength(3);
  expect((await schemas(client)).reviewQueue).toBe("damage-review");
  const wrapped = await advanced(client);
  expect(Object.isFrozen(wrapped.result)).toBe(true);
  expect(wrapped.constant).toEqual({ format: "survey-v1" });
  const result = await diagnostics(client);
  expect(result.diagnostics.every((field) => field.answer.probabilitySource === "estimated")).toBe(
    true,
  );
  // 2 native + 3 batches + 1 Classic + 2 advanced + 1 diagnostic. Constants add zero.
  expect(model.doGenerateCalls).toHaveLength(9);
});

test("existing stream lesson does not re-consume its paid pipeline with a generative model", async () => {
  const { client, model } = estimatedFixture();
  const result = await streams(client);
  expect(result.recommendations).toHaveLength(3);
  expect(model.doGenerateCalls).toHaveLength(8);
});

test("existing replay lesson preserves snapshots and reports estimated sources for both targets", async () => {
  const primary = estimatedFixture();
  const other = estimatedFixture();
  const result = await replay(
    primary.client,
    Generative.create({ model: other.model, evidence: "estimated" }),
  );
  expect(primary.model.doGenerateCalls).toHaveLength(2);
  expect(other.model.doGenerateCalls).toHaveLength(1);
  const prompts = [...primary.model.doGenerateCalls, ...other.model.doGenerateCalls].map((call) =>
    JSON.stringify(call.prompt),
  );
  expect(
    prompts.every(
      (prompt) => prompt.includes("online portal") && !prompt.includes("delivered in person"),
    ),
  ).toBe(true);
  expect(
    result.comparison?.diagnostics.every((field) => field.answer.probabilitySource === "estimated"),
  ).toBe(true);
});

for (const uncertain of [false, true]) {
  test(`fulfillment desk persists ${uncertain ? "rejected" : "accepted"} estimated evidence without approving actions`, async () => {
    const store = new DeskStore(":memory:");
    const { client, model } = estimatedFixture(uncertain);
    const signal = new AbortController().signal;
    try {
      for (const id of ["SINGLE", "STREAMED"])
        store.ingest(
          shipmentInput.parse({
            id,
            orderId: id,
            carrier: "Test-only",
            daysLate: 4,
            priority: "priority",
            notes: "Fictional delayed shipment",
          }),
        );
      const policy = client.extend({ defaults: { confidence: 0.65 } });
      expect(await assessOne(store, policy, "SINGLE", signal)).toEqual({
        id: "SINGLE",
        outcome: "review",
      });
      expect(await processPending(store, policy, signal)).toEqual([
        { id: "STREAMED", outcome: "review" },
      ]);
      for (const id of ["SINGLE", "STREAMED"]) {
        const stored = JSON.parse(store.get(id).assessment_json!);
        expect(stored.disposition).toBe(uncertain ? "needs-human-analysis" : "proposed");
        expect(
          stored.diagnostics.every(
            (field: { answer: { probabilitySource: string } }) =>
              field.answer.probabilitySource === "estimated",
          ),
        ).toBe(true);
        if (uncertain) expect(stored.value).toBeUndefined();
        else {
          expect(stored.value.proposedAction).toBe("request_carrier_update");
          expect(stored.evidence.providerMetadata.questionsGenerative.probabilitySource).toBe(
            "estimated",
          );
        }
      }
      expect(store.deliveries()).toHaveLength(0); // A model never approves notification delivery.
      expect((await new Response(report(store)).text()).trim().split("\n")).toHaveLength(2);
      expect(await processPending(store, policy, signal)).toEqual([]);
      expect(model.doGenerateCalls).toHaveLength(2); // Reporting and re-running a drained worker are free.
    } finally {
      store.close();
    }
  });
}
