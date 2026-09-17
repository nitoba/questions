import { packDependencies } from "./pack-dependencies.mjs";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "questions-consumer-"));
const tarball = join(directory, "questions.tgz");

try {
  // Test the actual distributable, not a source import or workspace symlink.
  execFileSync("bun", ["pm", "pack", "--filename", tarball], {
    cwd: root,
    stdio: "pipe",
    encoding: "utf8",
  });
  const overrides = packDependencies(root, directory, ["zod", "ofetch", "ms"]);
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module", overrides }),
  );
  execFileSync("bun", ["add", tarball, overrides.zod], {
    cwd: directory,
    stdio: "pipe",
    encoding: "utf8",
  });
  const installed = JSON.parse(
    readFileSync(join(directory, "node_modules/@nitoba/questions/package.json"), "utf8"),
  );
  assert.deepEqual(installed.dependencies, { ofetch: "1.5.0", ms: "2.1.3" });
  assert.deepEqual(installed.peerDependencies, {
    zod: "^4.0.0",
    "@ai-sdk/gateway": "^4.0.85",
    ai: "^7.0.105",
    "@ai-sdk/provider": "^4.0.17",
  });
  assert.deepEqual(installed.peerDependenciesMeta, {
    "@ai-sdk/gateway": { optional: true },
    ai: { optional: true },
    "@ai-sdk/provider": { optional: true },
  });
  assert.equal(existsSync(join(directory, "node_modules/@ai-sdk/gateway")), false);
  assert.equal(existsSync(join(directory, "node_modules/ai")), false);
  assert.equal(existsSync(join(directory, "node_modules/@ai-sdk/provider")), false);
  const source = `
import assert from "node:assert/strict";
import { Questions, Question, Answer, Decision, Schema, SchemaValidationError, Duration } from "@nitoba/questions";
import { parse as parseDuration } from "@nitoba/questions/duration";
import * as z from "zod";
import { registry } from "@nitoba/questions/schema";
import { from } from "@nitoba/questions/streams";
import { create } from "@nitoba/questions/providers/jev";
import * as TypeSafe from "@nitoba/questions/providers/typesafe";
import * as SystemOne from "@nitoba/questions/providers/system-one";
import * as AISDK from "@nitoba/questions/providers/ai-sdk";
assert.equal(typeof create, "function");
assert.equal(typeof TypeSafe.create, "function");
assert.equal(typeof SystemOne.create, "function");
assert.equal(typeof AISDK.create, "function");
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
const prepared = await Questions.create({ model }).about("x").prepare(schema);
const executed = await prepared.run();
assert.deepEqual((await executed.replay()).value, { state:"yes" });
let httpAttempts = 0;
const overHttp = Questions.create({ model:TypeSafe.create({apiKey:"test", retry:{maxRetries:1,delayMs:0}, fetch:async (_,init) => {
  httpAttempts++;
  if (httpAttempts===1) return new Response(null,{status:429});
  const request = JSON.parse(init.body);
  return Response.json({ model:"test", usage:{input_tokens:1,output_tokens:1}, answers:Object.fromEntries(Object.keys(request.questions).map(key=>[key,{type:"noul",noul:0.9}])) });
}}) });
assert.equal(await overHttp.about("x").is("OK?"),true);
assert.equal(httpAttempts,2);
assert.equal(Duration.parse("200 milis"),200);
assert.equal(parseDuration("1.5 seconds"),1500);
const events=[];
const parent=Questions.create({model,defaults:{timeout:"2 seconds",confidence:0.2},hooks:{onEvaluate:e=>{events.push(e)},onDecision:e=>{events.push(e)}}});
const child=parent.extend({defaults:{confidence:0.7,timeout:"3 s"}});
const detailed=await child.about("x").run(schema);
assert.equal(detailed.diagnostics[0].path[0],"ok");
assert.equal(detailed.diagnostics[0].confidencePassed,true);
assert.equal(detailed.operationId,events[0].operationId);
assert.equal(events.length,2);
assert.equal(Schema.compile(schema).fields[0].path[0],"ok");
assert.equal(Schema.compile(schema).diagnose(detailed.evidence)[0].active,true);
assert.equal(parent.defaults.confidence,0.2);
assert.equal(child.defaults.confidence,0.7);
await detailed.replay({timeout:"1 second",hooks:false});
assert.equal(events.length,2);
console.log("Installed package runtime smoke passed");
`;
  writeFileSync(join(directory, "consumer.mjs"), source);
  for (const runtime of ["node", "bun"])
    execFileSync(runtime, ["consumer.mjs"], { cwd: directory, stdio: "inherit" });
  writeFileSync(
    join(directory, "consumer.ts"),
    `
import { Questions, Question, Duration, type QuestionModel, type DurationInput, type SemanticHooks, type FieldDiagnostic } from "@nitoba/questions";
import { toMilliseconds } from "@nitoba/questions/duration";
import * as z from "zod";
import { annotate, compile, type Output } from "@nitoba/questions/schema";
import { from, type Stream } from "@nitoba/questions/streams";
import { create } from "@nitoba/questions/providers/jev";
import * as TypeSafe from "@nitoba/questions/providers/typesafe";
import * as SystemOne from "@nitoba/questions/providers/system-one";
import * as AISDK from "@nitoba/questions/providers/ai-sdk";
declare const model: QuestionModel;
const prepared = await Questions.create({model}).about("x").prepare(z.object({ok:z.boolean()}).readonly());
const executed = await prepared.run();
const typedReplay: boolean = (await executed.replay()).value.ok;
// @ts-expect-error readonly schema output must survive replay
executed.value.ok = false;
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
const direct: QuestionModel = TypeSafe.create({ apiKey: "test", retry:{maxRetries:2,statusCodes:[503],delayMs:({attempt})=>attempt*100},
  hooks:{ onRetry({delayMs, nextAttempt}) { const value:number=delayMs+nextAttempt; void value; } } });
const custom: QuestionModel = SystemOne.create({ baseURL: "http://localhost:9000", model: "local" });
// @ts-expect-error arbitrary URLs require a protocol model ID
SystemOne.create({ baseURL: "http://localhost:9000" });
void [direct, custom, AISDK];
const duration:DurationInput="250 ms";
const hooks:SemanticHooks={onDecision(event){const tokens:number|undefined=event.usage?.inputTokens;void tokens;}};
const child=Questions.create({model,defaults:{timeout:"10 s"},hooks}).extend({defaults:{confidence:0.7}});
const detailed=await child.about("x").run(schema,{timeout:"5 s"});
const diagnostics:readonly FieldDiagnostic[]=detailed.diagnostics;
const typedPath:readonly (string|number)[]=plan.fields[0]!.path;
const inspected:readonly FieldDiagnostic[]=plan.diagnose(detailed.evidence);
// @ts-expect-error unknown duration units must still fail in installed declarations
child.extend({defaults:{timeout:"10 secods"}});
// @ts-expect-error readonly derived client defaults
child.defaults.confidence=0;
void [duration,Duration,toMilliseconds,diagnostics,typedPath,inspected];
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
import * as TypeSafe from "@nitoba/questions/providers/typesafe";
import * as SystemOne from "@nitoba/questions/providers/system-one";
import * as AISDK from "@nitoba/questions/providers/ai-sdk";
assert.deepEqual(await from([1, 2]).map(n => n + 1).toArray(), [2, 3]);
assert.equal(typeof create, "function");
assert.equal(typeof TypeSafe.create, "function");
assert.equal(typeof SystemOne.create, "function");
assert.equal(typeof AISDK.create, "function");
`,
  );
  for (const runtime of ["node", "bun"])
    execFileSync(runtime, ["subpaths.mjs"], { cwd: directory, stdio: "inherit" });
  // Streams and the structural SDK bridge must not acquire the new HTTP runtime dependency.
  for (const name of ["ofetch", "destr", "node-fetch-native", "ufo"])
    rmSync(join(directory, "node_modules", name), { recursive: true, force: true });
  writeFileSync(
    join(directory, "no-http.mjs"),
    `
import assert from "node:assert/strict";
import { from } from "@nitoba/questions/streams";
import * as AISDK from "@nitoba/questions/providers/ai-sdk";
assert.deepEqual(await from([1]).toArray(), [1]);
assert.equal(typeof AISDK.create,"function");
`,
  );
  for (const runtime of ["node", "bun"])
    execFileSync(runtime, ["no-http.mjs"], { cwd: directory, stdio: "inherit" });
  // Streams alone must not load any schema, HTTP, duration or SDK dependency.
  rmSync(join(directory, "node_modules/ms"), { recursive: true, force: true });
  writeFileSync(
    join(directory, "streams-only.mjs"),
    `
import assert from "node:assert/strict";
import { from } from "@nitoba/questions/streams";
assert.deepEqual(await from([1]).map(x=>x+1).toArray(),[2]);
`,
  );
  for (const runtime of ["node", "bun"])
    execFileSync(runtime, ["streams-only.mjs"], { cwd: directory, stdio: "inherit" });
  console.log("Packed declarations, schema peer integration and independent subpaths passed");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
