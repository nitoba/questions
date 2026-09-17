import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "questions-consumer-"));
const tarball = join(directory, "questions.tgz");
const zodTarball = join(directory, "zod.tgz");
try {
  // Test the actual distributable, not a source import or workspace symlink.
  execFileSync("bun", ["pm", "pack", "--filename", tarball], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module", overrides: { zod: `file:${zodTarball}` } }),
  );
  // Package the installed peer too: consumers remain isolated and the smoke test needs no network.
  execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", zodTarball], {
    cwd: join(root, "node_modules/zod"),
    stdio: "pipe",
    encoding: "utf8",
  });
  execFileSync("bun", ["add", tarball, zodTarball], {
    cwd: directory,
    stdio: "pipe",
    encoding: "utf8",
  });
  const installed = JSON.parse(
    readFileSync(join(directory, "node_modules/@nitoba/questions/package.json"), "utf8"),
  );
  assert.equal(Object.keys(installed.dependencies ?? {}).length, 0);
  assert.deepEqual(installed.peerDependencies, { zod: "^4.0.0" });
  const source = `
import assert from "node:assert/strict";
import { Questions, Question, Answer, Decision, Schema, SchemaValidationError } from "@nitoba/questions";
import * as z from "zod";
import { registry } from "@nitoba/questions/schema";
import { from } from "@nitoba/questions/streams";
import { create } from "@nitoba/questions/providers/jev";
assert.equal(typeof create, "function");
const model = { name: "contract", async evaluate(request) {
  return { model: "contract-v1", usage: { inputTokens: 1, outputTokens: 1 },
    answers: Object.fromEntries(Object.keys(request.questions).map(key => [key, { type: "boolean", probability: 0.9 }])) };
}};
assert.equal(await Questions.create({ model }).about("x").is("OK?"), true);
assert.equal(registry, Schema.registry);
const schema = z.object({ ok: z.boolean().describe("Is it OK?") }).transform(value => ({ state: value.ok ? "yes" : "no" }));
assert.deepEqual(await Questions.create({ model }).about("x").ask(schema), { state: "yes" });
assert.equal(await Questions.create({ model }).about("x").ask(z.number().register(registry, { kind: "probability" })), 0.9);
await assert.rejects(Questions.create({ model }).about("x").ask(z.boolean().refine(() => false)), SchemaValidationError);
assert.equal(Question.choice("Route?", { a: "A", b: "B" }).type, "choice");
assert.deepEqual(await from([1, 2, 3]).map(n => n * 2).toArray(), [2, 4, 6]);
assert.equal(Decision.minimizeLoss(Answer.fromBoolean({type:"boolean",probability:0.9}), {act:1}).choice, "act");
console.log("Installed package runtime smoke passed");
`;
  writeFileSync(join(directory, "consumer.mjs"), source);
  for (const runtime of ["node", "bun"])
    execFileSync(runtime, ["consumer.mjs"], { cwd: directory, stdio: "inherit" });
  writeFileSync(
    join(directory, "consumer.ts"),
    `
import { Questions, Question, type QuestionModel } from "@nitoba/questions";
import * as z from "zod";
import { annotate, compile, type Output } from "@nitoba/questions/schema";
import { from, type Stream } from "@nitoba/questions/streams";
import { create } from "@nitoba/questions/providers/jev";
declare const model: QuestionModel;
const result = await Questions.create({ model }).about("x").ask({ route: Question.choice("Which?", {a:"A",b:"B"}) });
const route: "a" | "b" = result.route;
// @ts-expect-error literal keys must survive packaging
const invalid: "c" = result.route;
const stream: Stream<string> = from([1]).map(String);
const schema = z.object({ route: z.enum(["a", "b"]) }).transform(value => ({ id: value.route })).readonly();
const parsed = await Questions.create({ model }).about("x").ask(schema);
const output: Output<typeof schema> = parsed;
const id: "a" | "b" = parsed.id;
// @ts-expect-error transformed output must not expose input keys
void parsed.route;
// @ts-expect-error readonly output must survive packaging
parsed.id = "a";
const probability = annotate(z.number(), { kind: "probability" });
const plan = compile(schema);
void [route, invalid, stream, create, output, id, probability, plan];
`,
  );
  const tsconfig = {
    compilerOptions: {
      strict: true,
      noEmit: true,
      types: [],
      skipLibCheck: false,
      module: "NodeNext",
      target: "ES2023",
      lib: ["ES2023", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
    },
    include: ["consumer.ts"],
  };
  writeFileSync(join(directory, "tsconfig.json"), JSON.stringify(tsconfig));
  execFileSync(resolve(root, "node_modules/.bin/tsc"), ["-p", join(directory, "tsconfig.json")], {
    cwd: directory,
    stdio: "inherit",
  });
  execFileSync(
    resolve(root, "node_modules/.bin/publint"),
    [join(directory, "node_modules/@nitoba/questions"), "--strict"],
    { cwd: directory, stdio: "inherit" },
  );
  // These narrow entry points remain executable without loading or installing Zod.
  rmSync(join(directory, "node_modules/zod"), { recursive: true, force: true });
  writeFileSync(
    join(directory, "subpaths.mjs"),
    `
import assert from "node:assert/strict";
import { from } from "@nitoba/questions/streams";
import { create } from "@nitoba/questions/providers/jev";
assert.deepEqual(await from([1, 2]).map(n => n + 1).toArray(), [2, 3]);
assert.equal(typeof create, "function");
`,
  );
  for (const runtime of ["node", "bun"])
    execFileSync(runtime, ["subpaths.mjs"], { cwd: directory, stdio: "inherit" });
  console.log("Packed declarations, schema peer integration and independent subpaths passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
