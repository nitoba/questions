import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tutorial = (name: string) => resolve(root, name);
async function run(args: string[], variables: Record<string, string> = {}) {
  const env = { ...process.env };
  // Never inherit a developer's paid-model keys or selection in subprocess tests.
  for (const key of [
    "TYPESAFE_API_KEY",
    "AI_GATEWAY_API_KEY",
    "GOOGLE_GENERATIVE_AI_API_KEY",
    "ANTHROPIC_API_KEY",
    "OPENAI_API_KEY",
    "GENERATIVE_MODEL",
    "GENERATIVE_PROVIDER",
    "QUESTIONS_PROVIDER",
    "COMPARE_PROVIDER",
    "COMPARE_GENERATIVE_PROVIDER",
    "COMPARE_GENERATIVE_MODEL",
    "COMPARE_WITH_VERCEL",
    "EXAMPLE_TIMEOUT",
  ])
    delete env[key];
  Object.assign(env, variables);
  const child = Bun.spawn([process.execPath, ...args], {
    cwd: resolve(root, ".."),
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
}

test("CLI: native stream tutorial and help run without credentials; paid tutorial refuses missing key", async () => {
  expect((await run([tutorial("15-native-stream-interop.ts")])).code).toBe(0);
  const help = await run([tutorial("16-fulfillment-desk/main.ts"), "--help"]);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain("ingest");
  const missing = await run([tutorial("01-first-question.ts")]);
  expect(missing.code).toBe(1);
  expect(missing.stderr).toContain("Set TYPESAFE_API_KEY");
});

test("CLI: ingest, duplicate intake and streaming report use a real persistent database", async () => {
  const folder = await mkdtemp(join(tmpdir(), "desk-cli-"));
  const vars = { DESK_DB: join(folder, "desk.sqlite"), QUESTIONS_PROVIDER: "generative" };
  try {
    const entry = tutorial("16-fulfillment-desk/main.ts");
    const sample = tutorial("16-fulfillment-desk/sample.ndjson");
    const imported = await run([entry, "ingest", sample], vars);
    expect(imported.code).toBe(0);
    expect(JSON.parse(imported.stdout)).toEqual({ inserted: 4, duplicate: 0 });
    const repeated = await run([entry, "ingest", sample], vars);
    expect(repeated.code).toBe(0);
    expect(JSON.parse(repeated.stdout)).toEqual({ inserted: 0, duplicate: 4 });
    const report = await run([entry, "report"], vars);
    expect(report.code).toBe(0);
    const rows = report.stdout
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(rows).toHaveLength(4);
    expect(rows.every((row) => row.state === "queued")).toBe(true);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test("CLI: shared tutorials and dedicated generative lesson reject missing configuration before inference", async () => {
  const vars = {
    QUESTIONS_PROVIDER: "generative",
    GENERATIVE_PROVIDER: "google",
    GENERATIVE_MODEL: "test-only-model",
  };
  for (const name of [
    "02-native-question-schema.ts",
    "07-zod-decision-schemas.ts",
    "13-bounded-stream-pipelines.ts",
    "17-generative-models.ts",
  ]) {
    const result = await run([tutorial(name)], vars);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Set GOOGLE_GENERATIVE_AI_API_KEY");
  }
  const invalid = await run([tutorial("07-zod-decision-schemas.ts")], {
    QUESTIONS_PROVIDER: "unknown",
  });
  expect(invalid.code).toBe(1);
  expect(invalid.stderr).toContain("Set QUESTIONS_PROVIDER");
  const comparison = await run([tutorial("11-preparation-and-replay.ts")], {
    COMPARE_PROVIDER: "generative",
  });
  expect(comparison.code).toBe(1);
  expect(comparison.stderr).toContain("COMPARE_GENERATIVE_PROVIDER");
});
