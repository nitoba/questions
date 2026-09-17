// The tests deliberately use only the shared `test` API plus node:assert.
// This loader runs the same source suite under Node without making Bun a runtime dependency.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === "bun:test") return { url: "node:test", shortCircuit: true };
  return nextResolve(specifier, context);
}
