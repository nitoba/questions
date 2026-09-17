import { z } from "zod";
import { DeskError, reviewInput, shipmentInput } from "./domain.ts";
import { requestJson } from "./input.ts";
import { report } from "./service.ts";
import type { DeskStore } from "./store.ts";

/** Framework-free Request -> Response boundary. It performs no paid inference. */
export function handler(store: DeskStore, token: string): (request: Request) => Promise<Response> {
  if (token.length < 16) throw new Error("DESK_TOKEN must contain at least 16 characters");
  return async (request) => {
    try {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health")
        return Response.json({ status: "ok" });
      if (request.headers.get("authorization") !== `Bearer ${token}`)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (request.method === "POST" && url.pathname === "/cases") {
        const inserted = store.ingest(shipmentInput.parse(await requestJson(request)));
        return Response.json({ inserted }, { status: inserted ? 201 : 200 });
      }
      if (request.method === "GET" && url.pathname === "/cases") {
        const after = url.searchParams.get("after") ?? "";
        const rows = store.list(after);
        return Response.json({
          rows: rows.map(({ input_json: _input, assessment_json: _assessment, ...row }) => row),
          nextCursor: rows.length === 100 ? rows[99]!.id : null,
        });
      }
      if (request.method === "GET" && url.pathname === "/report.ndjson") {
        return new Response(report(store, request.signal), {
          headers: { "content-type": "application/x-ndjson; charset=utf-8" },
        });
      }
      const match = /^\/cases\/([A-Z0-9_-]{1,64})(\/review)?$/.exec(url.pathname);
      if (match && request.method === "GET" && !match[2]) {
        const row = store.get(match[1]!);
        return Response.json({
          id: row.id,
          state: row.state,
          version: row.version,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
          lastErrorKind: row.last_error_kind,
          input: JSON.parse(row.input_json),
          assessment: row.assessment_json ? JSON.parse(row.assessment_json) : null,
        });
      }
      if (match && request.method === "POST" && match[2]) {
        return Response.json(
          store.review(match[1]!, reviewInput.parse(await requestJson(request))),
        );
      }
      if (request.method === "POST" && url.pathname === "/notifications") {
        return Response.json(
          store.receive(await requestJson(request), request.headers.get("idempotency-key")),
        );
      }
      return Response.json({ error: "Not found" }, { status: 404 });
    } catch (error) {
      if (error instanceof DeskError)
        return Response.json({ error: error.message }, { status: error.status });
      if (error instanceof z.ZodError)
        return Response.json(
          { error: "Invalid request", paths: error.issues.map((issue) => issue.path) },
          { status: 400 },
        );
      return Response.json({ error: "Internal error" }, { status: 500 });
    }
  };
}
