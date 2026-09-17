import { TimeoutError } from "../errors.ts";
import { integer } from "./validation.ts";

/** An owned cancellation scope. Disposal never changes an already-observed result. */
export function cancellation(parent?: AbortSignal, timeoutMs?: number) {
  if (timeoutMs !== undefined) {
    integer(timeoutMs, 1, "timeoutMs");
    if (timeoutMs > 2_147_483_647)
      throw new RangeError("timeoutMs exceeds the platform timer limit");
  }
  const controller = new AbortController();
  const deadline = timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
  const relay = () => controller.abort(parent?.reason);
  if (parent?.aborted) relay();
  else parent?.addEventListener("abort", relay, { once: true });
  const timer =
    timeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          controller.abort(new TimeoutError(timeoutMs));
        }, timeoutMs);
  return {
    controller,
    signal: controller.signal,
    /** Check again after synchronous user work, before a delayed timer can run. */
    check() {
      if (!controller.signal.aborted && deadline !== undefined && performance.now() >= deadline)
        controller.abort(new TimeoutError(timeoutMs!));
      controller.signal.throwIfAborted();
    },
    dispose() {
      if (timer !== undefined) clearTimeout(timer);
      parent?.removeEventListener("abort", relay);
    },
  };
}

/** Observe late rejection while letting cancellation settle a non-cooperative promise promptly. */
export function abortable<T>(value: T | PromiseLike<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    if (signal.aborted) {
      Promise.resolve(value).catch(() => {});
      reject(signal.reason);
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(value).then(
      (result) => {
        signal.removeEventListener("abort", abort);
        resolve(result);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const finish = () => {
      signal.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}
