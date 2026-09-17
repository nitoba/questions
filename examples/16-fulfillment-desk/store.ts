import { Database } from "bun:sqlite";
import {
  DeskError,
  reviewInput,
  shipmentInput,
  notificationSchema,
  type Review,
  type Shipment,
} from "./domain.ts";

export type CaseState = "queued" | "evaluating" | "review" | "approved" | "dismissed" | "failed";
export interface CaseRow {
  id: string;
  input_json: string;
  state: CaseState;
  version: number;
  assessment_json: string | null;
  last_error_kind: string | null;
  created_at: string;
  updated_at: string;
}
export interface OutboxRow {
  id: string;
  payload_json: string;
  state: "pending" | "sending" | "sent" | "failed";
  attempts: number;
}

/**
 * Actual durable SQLite storage. Every transition is synchronous and short.
 * Never hold a database transaction open while waiting for an LLM or webhook.
 */
export class DeskStore {
  readonly #db: Database;
  constructor(path: string) {
    this.#db = new Database(path, { create: true, strict: true });
    this.#db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA foreign_keys=ON;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS cases (
        id TEXT PRIMARY KEY, input_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'queued',
        version INTEGER NOT NULL DEFAULT 1,
        assessment_json TEXT, last_error_kind TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
        command_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, case_id TEXT NOT NULL REFERENCES cases(id),
        payload_json TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS receipts (id TEXT PRIMARY KEY, payload_json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS cases_state_idx ON cases(state, id);
      CREATE INDEX IF NOT EXISTS outbox_state_idx ON outbox(state, id);
    `);
  }
  close(): void {
    this.#db.close();
  }

  /** Duplicate identical input is harmless; a reused ID with changed data is a conflict. */
  ingest(input: Shipment): boolean {
    const parsed = shipmentInput.parse(input);
    const json = JSON.stringify(parsed);
    return this.#db
      .transaction(() => {
        const current = this.#db
          .query<{ input_json: string }, [string]>("SELECT input_json FROM cases WHERE id=?")
          .get(parsed.id);
        if (current) {
          if (current.input_json !== json)
            throw new DeskError(409, "Case ID already contains different input");
          return false;
        }
        this.#db.query("INSERT INTO cases(id,input_json) VALUES(?,?)").run(parsed.id, json);
        return true;
      })
      .immediate();
  }
  get(id: string): CaseRow {
    const row = this.#db.query<CaseRow, [string]>("SELECT * FROM cases WHERE id=?").get(id);
    if (!row) throw new DeskError(404, "Case not found");
    return row;
  }
  list(after = "", limit = 100): CaseRow[] {
    return this.#db
      .query<CaseRow, [string, number]>("SELECT * FROM cases WHERE id>? ORDER BY id LIMIT ?")
      .all(after, limit);
  }
  queued(limit: number): string[] {
    return this.#db
      .query<{ id: string }, [number]>(
        "SELECT id FROM cases WHERE state='queued' ORDER BY id LIMIT ?",
      )
      .all(limit)
      .map((row) => row.id);
  }
  /** Atomic claim allows two local worker processes to compete without assessing the same row. */
  claim(id: string): boolean {
    return (
      this.#db
        .query(
          "UPDATE cases SET state='evaluating',updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state='queued'",
        )
        .run(id).changes === 1
    );
  }
  finish(id: string, assessment: unknown): void {
    const result = this.#db
      .query(`UPDATE cases SET state='review',version=version+1,assessment_json=?,last_error_kind=NULL,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state='evaluating'`)
      .run(JSON.stringify(assessment), id);
    if (result.changes !== 1) throw new DeskError(409, "Case no longer belongs to this assessment");
  }
  fail(id: string, kind: string): void {
    this.#db
      .query(`UPDATE cases SET state='failed',last_error_kind=?,version=version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state='evaluating'`)
      .run(kind, id);
  }
  /** Manual recovery only AFTER stopping old workers. Retrying inference may incur another charge. */
  requeue(id: string): void {
    if (
      this.#db
        .query(`UPDATE cases SET state='queued',version=version+1,
      updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=? AND state IN ('failed','evaluating')`)
        .run(id).changes !== 1
    )
      throw new DeskError(409, "Only a failed or abandoned evaluating case can be requeued");
  }

  /** Approval, review audit and outbox insertion commit together, with optimistic version checking. */
  review(id: string, input: Review): { duplicate: boolean } {
    const command = reviewInput.parse(input);
    const serialized = JSON.stringify(command);
    return this.#db
      .transaction(() => {
        const previous = this.#db
          .query<{ case_id: string; command_json: string }, [string]>(
            "SELECT case_id,command_json FROM reviews WHERE id=?",
          )
          .get(command.reviewId);
        if (previous) {
          if (previous.case_id !== id || previous.command_json !== serialized)
            throw new DeskError(409, "Review ID reused with different data");
          return { duplicate: true };
        }
        const row = this.get(id);
        if (row.state !== "review" || row.version !== command.expectedVersion)
          throw new DeskError(409, "Refresh the case before reviewing");
        this.#db
          .query("INSERT INTO reviews(id,case_id,command_json) VALUES(?,?,?)")
          .run(command.reviewId, id, serialized);
        this.#db
          .query(`UPDATE cases SET state=?,version=version+1,
        updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`)
          .run(command.decision === "approve" ? "approved" : "dismissed", id);
        if (command.decision === "approve") {
          const eventId = `${id}:${command.reviewId}`;
          this.#db
            .query("INSERT INTO outbox(id,case_id,payload_json) VALUES(?,?,?)")
            .run(eventId, id, JSON.stringify({ eventId, caseId: id, action: command.action }));
        }
        return { duplicate: false };
      })
      .immediate();
  }
  deliveries(limit = 50): OutboxRow[] {
    return this.#db
      .query<OutboxRow, [number]>(
        "SELECT * FROM outbox WHERE state IN ('pending','failed') AND attempts<5 ORDER BY id LIMIT ?",
      )
      .all(limit);
  }
  claimDelivery(id: string): boolean {
    return (
      this.#db
        .query(
          "UPDATE outbox SET state='sending',attempts=attempts+1 WHERE id=? AND state IN ('pending','failed') AND attempts<5",
        )
        .run(id).changes === 1
    );
  }
  finishDelivery(id: string, sent: boolean): void {
    this.#db
      .query("UPDATE outbox SET state=? WHERE id=? AND state='sending'")
      .run(sent ? "sent" : "failed", id);
  }
  recoverDelivery(id: string): void {
    if (
      this.#db.query("UPDATE outbox SET state='pending' WHERE id=? AND state='sending'").run(id)
        .changes !== 1
    )
      throw new DeskError(409, "Only an abandoned sending delivery can be recovered");
  }
  /** Local demonstration receiver: one persisted receipt per event ID, even after redelivery. */
  receive(value: unknown, idempotencyKey: string | null): { duplicate: boolean } {
    const payload = notificationSchema.parse(value);
    if (payload.eventId !== idempotencyKey)
      throw new DeskError(400, "Idempotency key must match eventId");
    const json = JSON.stringify(payload);
    return this.#db
      .transaction(() => {
        const old = this.#db
          .query<{ payload_json: string }, [string]>("SELECT payload_json FROM receipts WHERE id=?")
          .get(payload.eventId);
        if (old) {
          if (old.payload_json !== json)
            throw new DeskError(409, "Event ID reused with different payload");
          return { duplicate: true };
        }
        this.#db
          .query("INSERT INTO receipts(id,payload_json) VALUES(?,?)")
          .run(payload.eventId, json);
        return { duplicate: false };
      })
      .immediate();
  }
  receiptCount(): number {
    return this.#db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM receipts").get()!
      .count;
  }
}
