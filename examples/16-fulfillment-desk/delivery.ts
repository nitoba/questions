import { Duration } from "../../src/index.ts";
import { DeskError } from "./domain.ts";
import type { DeskStore } from "./store.ts";

/**
 * Deliver approved work notifications, not model-driven refunds or carrier mutations.
 * At-least-once delivery: a crash AFTER receiver acceptance but BEFORE local acknowledgement
 * can cause redelivery. The receiver must persistently deduplicate the event ID.
 */
export async function deliver(
  store: DeskStore,
  target: string,
  token: string,
  signal: AbortSignal,
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> = fetch,
) {
  const url = new URL(target);
  if (
    url.username ||
    url.password ||
    url.hash ||
    url.search ||
    (url.protocol !== "https:" &&
      !(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
  )
    throw new DeskError(400, "Use HTTPS, or HTTP on loopback, without embedded credentials/query");
  let sent = 0;
  let failed = 0;
  for (const item of store.deliveries(50)) {
    signal.throwIfAborted();
    if (!store.claimDelivery(item.id)) continue;
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new DOMException("Delivery deadline", "TimeoutError")),
      Duration.toMilliseconds("5 seconds"),
    );
    try {
      const response = await fetcher(url, {
        method: "POST",
        redirect: "error",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          "idempotency-key": item.id,
        },
        body: item.payload_json,
        signal: AbortSignal.any([signal, controller.signal]),
      });
      void response.body?.cancel().catch(() => {});
      if (!response.ok) throw new DeskError(502, "Receiver rejected delivery");
      store.finishDelivery(item.id, true);
      sent++;
    } catch {
      store.finishDelivery(item.id, false);
      failed++;
      if (signal.aborted) throw signal.reason;
    } finally {
      clearTimeout(timer);
    }
  }
  // Retry failed deliveries by invoking deliver again; no implicit loop within this command.
  return { sent, failed };
}
