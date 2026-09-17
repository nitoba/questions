import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Questions, ProviderError } from "../../src/index.ts";
import { fixture, evidence } from "../../tests/helpers.ts";
import { DeskStore } from "../16-fulfillment-desk/store.ts";
import { shipmentInput, type Review } from "../16-fulfillment-desk/domain.ts";
import { ingest, assessOne, processPending, report } from "../16-fulfillment-desk/service.ts";
import { handler } from "../16-fulfillment-desk/http.ts";
import { deliver } from "../16-fulfillment-desk/delivery.ts";
import { readLines } from "../16-fulfillment-desk/input.ts";

const signal = () => new AbortController().signal;
const token = "local-test-token-16-characters";
const shipment = shipmentInput.parse({
  id: "SHIP-TEST",
  orderId: "ORDER-1",
  carrier: "Example Carrier",
  daysLate: 4,
  priority: "priority",
  notes: "The parcel is delayed.",
});
const approve = (version: number): Review => ({
  reviewId: "operator-review-1",
  expectedVersion: version,
  decision: "approve",
  action: "request_carrier_update",
  reviewer: "Operator A",
  note: "Checked the carrier record.",
});

test("capstone persists intake and decisions, detects duplicates, and atomically records approval/outbox", async () => {
  const directory = await mkdtemp(join(tmpdir(), "questions-desk-"));
  const path = join(directory, "desk.sqlite");
  let store = new DeskStore(path);
  try {
    expect(store.ingest(shipment)).toBe(true);
    expect(store.ingest(shipment)).toBe(false);
    expect(() => store.ingest({ ...shipment, notes: "Changed" })).toThrow();
    const f = fixture();
    const client = Questions.create({ model: f.model });
    const results = await processPending(store, client, signal());
    expect(results).toEqual([{ id: shipment.id, outcome: "review" }]);
    expect(store.deliveries()).toHaveLength(0); // LLM cannot approve a business action.
    const assessed = store.get(shipment.id);
    const snapshot = JSON.parse(assessed.assessment_json!);
    expect(snapshot.schemaVersion).toBe("delivery-assessment-v1");
    expect(snapshot.diagnostics).toHaveLength(3);
    expect(snapshot.expedited).toBe(true);
    expect(await processPending(store, client, signal())).toEqual([]);
    expect(f.calls).toHaveLength(1);
    expect(store.review(shipment.id, approve(assessed.version))).toEqual({ duplicate: false });
    expect(store.review(shipment.id, approve(assessed.version))).toEqual({ duplicate: true });
    expect(() =>
      store.review(shipment.id, { ...approve(assessed.version), reviewId: "another" }),
    ).toThrow();
    expect(store.deliveries()).toHaveLength(1);
    store.close();
    store = new DeskStore(path);
    expect(store.get(shipment.id).state).toBe("approved");
    expect(store.deliveries()).toHaveLength(1);
    expect(store.get(shipment.id).assessment_json).toBe(assessed.assessment_json);
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("two workers do not assess the same claimed case twice", async () => {
  const store = new DeskStore(":memory:");
  try {
    for (let i = 0; i < 5; i++) store.ingest({ ...shipment, id: `SHIP-${i}` });
    const f = fixture();
    const client = Questions.create({ model: f.model });
    await Promise.all([
      processPending(store, client, signal()),
      processPending(store, client, signal()),
    ]);
    expect(f.calls).toHaveLength(5);
    expect(store.list().every((row) => row.state === "review")).toBe(true);
  } finally {
    store.close();
  }
});

test("uncertain evidence goes to human review; transport failure is persisted and explicitly recoverable", async () => {
  const store = new DeskStore(":memory:");
  try {
    store.ingest(shipment);
    const uncertain = fixture((question) =>
      question.type === "boolean" ? { type: "boolean", probability: 0.5 } : evidence(question),
    );
    await processPending(store, Questions.create({ model: uncertain.model }), signal());
    const snapshot = JSON.parse(store.get(shipment.id).assessment_json!);
    expect(snapshot.disposition).toBe("needs-human-analysis");
    expect(snapshot.value).toBeUndefined();
    expect(snapshot.diagnostics).toHaveLength(3);

    store.ingest({ ...shipment, id: "SHIP-FAIL" });
    const failing = Questions.create({
      model: {
        name: "failure",
        async evaluate() {
          throw new ProviderError("failure", "http", "unavailable", { status: 503 });
        },
      },
    });
    expect((await assessOne(store, failing, "SHIP-FAIL", signal())).outcome).toBe("failed");
    expect(store.get("SHIP-FAIL").last_error_kind).toBe("provider-http");
    store.requeue("SHIP-FAIL");
    expect(
      (await assessOne(store, Questions.create({ model: fixture().model }), "SHIP-FAIL", signal()))
        .outcome,
    ).toBe("review");
  } finally {
    store.close();
  }
});

test("cancellation marks claimed work failed and prevents approval or delivery", async () => {
  const store = new DeskStore(":memory:");
  try {
    store.ingest(shipment);
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const client = Questions.create({
      model: {
        name: "blocked",
        evaluate() {
          entered();
          return new Promise(() => {});
        },
      },
    });
    const pending = assessOne(store, client, shipment.id, controller.signal);
    await ready;
    controller.abort(new DOMException("Stopped", "AbortError"));
    await expect(pending).rejects.toThrow();
    expect(store.get(shipment.id).state).toBe("failed");
    expect(store.deliveries()).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("NDJSON ingestion has real byte limits, UTF-8 decoding and explicit partial-progress recovery", async () => {
  const store = new DeskStore(":memory:");
  try {
    const text = `${JSON.stringify(shipment)}\n`;
    const body = () => new Response(text).body!;
    expect(await ingest(store, body(), signal())).toEqual({ inserted: 1, duplicate: 0 });
    expect(await ingest(store, body(), signal())).toEqual({ inserted: 0, duplicate: 1 });
    await expect(
      ingest(
        store,
        new Response(`${JSON.stringify({ ...shipment, id: "SHIP-SECOND" })}\nnot-json`).body!,
        signal(),
      ),
    ).rejects.toThrow();
    expect(store.get("SHIP-SECOND").state).toBe("queued");
    const read = async () => {
      for await (const _line of readLines(new Response("too long").body!, signal(), 2)) {
      }
    };
    await expect(read()).rejects.toThrow();
    const response = new Response(report(store));
    const rows = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(2);
    expect(rows[0].notes).toBeUndefined();
  } finally {
    store.close();
  }
});

test("real localhost review API validates auth, versions and bodies; delivery redelivery is deduplicated", async () => {
  const store = new DeskStore(":memory:");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler(store, token) });
  const base = server.url.toString();
  const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  try {
    expect((await fetch(new URL("/cases", base))).status).toBe(401);
    expect(
      (
        await fetch(new URL("/cases", base), {
          method: "POST",
          headers,
          body: JSON.stringify(shipment),
        })
      ).status,
    ).toBe(201);
    await assessOne(store, Questions.create({ model: fixture().model }), shipment.id, signal());
    const version = store.get(shipment.id).version;
    const reviewUrl = new URL(`/cases/${shipment.id}/review`, base);
    const command = approve(version);
    expect(
      (
        await fetch(reviewUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({ ...command, expectedVersion: version + 1 }),
        })
      ).status,
    ).toBe(409);
    expect(
      (await fetch(reviewUrl, { method: "POST", headers, body: JSON.stringify(command) })).status,
    ).toBe(200);
    expect((await fetch(reviewUrl, { method: "POST", headers, body: "not-json" })).status).toBe(
      400,
    );
    expect(
      (await fetch(reviewUrl, { method: "POST", headers, body: "a".repeat(20_000) })).status,
    ).toBe(413);
    expect(
      (await fetch(reviewUrl, { method: "POST", headers, body: new Uint8Array([0xff]) })).status,
    ).toBe(400);

    const target = new URL("/notifications", base).toString();
    // The first receiver accepts, then the sender loses its response. This is an intentional failure injection.
    const lostAcknowledgement = async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      await response.body?.cancel();
      throw new Error("Test: connection lost after receiver commit");
    };
    expect(await deliver(store, target, token, signal(), lostAcknowledgement)).toEqual({
      sent: 0,
      failed: 1,
    });
    expect(store.receiptCount()).toBe(1);
    expect(await deliver(store, target, token, signal())).toEqual({ sent: 1, failed: 0 });
    expect(store.receiptCount()).toBe(1);
    expect(store.deliveries()).toHaveLength(0);
    const reportResponse = await fetch(new URL("/report.ndjson", base), { headers });
    expect(reportResponse.headers.get("content-type")).toContain("application/x-ndjson");
    expect(JSON.parse((await reportResponse.text()).trim()).state).toBe("approved");
  } finally {
    await server.stop(true);
    store.close();
  }
});

test("invalid model evidence is persisted as a failure, never an approved action", async () => {
  const store = new DeskStore(":memory:");
  try {
    store.ingest(shipment);
    const client = Questions.create({
      model: {
        name: "invalid",
        async evaluate() {
          return { model: "invalid", usage: {}, answers: {} };
        },
      },
    });
    const outcome = await assessOne(store, client, shipment.id, signal());
    expect(outcome.outcome).toBe("failed");
    expect(store.get(shipment.id).last_error_kind).toBe("invalid-input-or-evidence");
    expect(store.deliveries()).toHaveLength(0);
  } finally {
    store.close();
  }
});

test("a dismissed review creates no outbox record; invalid commands leave review intact", async () => {
  const store = new DeskStore(":memory:");
  try {
    store.ingest(shipment);
    await assessOne(store, Questions.create({ model: fixture().model }), shipment.id, signal());
    const current = store.get(shipment.id);
    expect(() =>
      store.review(shipment.id, { ...approve(current.version), expectedVersion: 1 }),
    ).toThrow();
    expect(store.get(shipment.id).state).toBe("review");
    store.review(shipment.id, {
      reviewId: "dismiss-1",
      expectedVersion: current.version,
      decision: "dismiss",
      reviewer: "Operator",
      note: "Carrier record shows normal delivery.",
    });
    expect(store.get(shipment.id).state).toBe("dismissed");
    expect(store.deliveries()).toHaveLength(0);
  } finally {
    store.close();
  }
});
