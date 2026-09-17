/** Data that can be transmitted without lossy JSON serialization. */
export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[];
/** A JSON object with string keys. */
export type JsonObject = { readonly [key: string]: JsonValue };
/** The evaluation context accepted by Jev: text, a JSON object, or an array. */
export type State = string | JsonObject | readonly JsonValue[];
/** Option descriptions. Providers may serialize structured descriptions to text. */
export type Description = State | null;
/** A synchronous value or a promise-like value. */
export type Awaitable<T> = T | PromiseLike<T>;
/** A callback receives the signal belonging to this execution, not a global signal. */
export interface CallContext {
  readonly signal: AbortSignal;
}
/** Per-operation cooperative cancellation. */
export interface RunOptions {
  readonly signal?: AbortSignal;
}
/** A value or a function evaluated afresh on every operation. */
export type StateSource = State | ((context: CallContext) => Awaitable<State>);
