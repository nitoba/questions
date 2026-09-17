import { test, expect } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const tutorial = (name: string) => resolve(root, name);
async function run(args: string[], variables: Record<string, string> = {}) {
  const env = { ...process.env, ...variables };
  delete env.TYPESAFE_API_KEY;
  delete env.AI_GATEWAY_API_KEY;
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
  const vars = { DESK_DB: join(folder, "desk.sqlite") };
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
