import { packDependencies } from "./pack-dependencies.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "questions-sdk-consumer-"));
const tarball = join(directory, "questions.tgz");
try {
  const overrides = packDependencies(root, directory, ["zod", "ofetch", "@ai-sdk/gateway"]);
  execFileSync("bun", ["pm", "pack", "--filename", tarball], { cwd: root, stdio: "pipe" });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module", overrides }),
  );
  execFileSync("bun", ["add", tarball, overrides.zod, overrides["@ai-sdk/gateway"]], {
    cwd: directory,
    stdio: "pipe",
  });
  const source = `
import assert from "node:assert/strict";
import { z } from "zod";
import { createGateway } from "@ai-sdk/gateway";
import { Questions, Question } from "@nitoba/questions";
import * as Vercel from "@nitoba/questions/providers/vercel";
import * as AISDK from "@nitoba/questions/providers/ai-sdk";
let calls = 0;
const fetcher = async (url, init) => {
  calls++;
  assert.equal(String(url), "https://ai-gateway.vercel.sh/v4/ai/evaluation-model");
  assert.equal(new Headers(init.headers).get("ai-model-id"), "typesafe-ai/jev");
  const request = JSON.parse(String(init.body));
  return Response.json({ answers: Object.fromEntries(Object.entries(request.questions).map(([id, q]) => [id, q.type === "boolean" ? { type:"boolean", probability:0.9 } : { type:"choice", choice:Object.keys(q.criteria)[0], probabilities:Object.fromEntries(Object.keys(q.criteria).map((key,index) => [key, index===0 ? 0.8 : 0.2])) }])), usage: { inputTokens: 5 } });
};
const client = Questions.create({ model: Vercel.create({ apiKey:"test", fetch:fetcher }) });
assert.deepEqual(await client.about("x").ask(z.object({ ok:z.boolean() })), { ok:true });
const evidence = await client.about("x").evidence({ route:Question.choice("Which?", { a:"A", b:"B" }) });
assert.equal(evidence.answers.route.confidenceSource, "margin");
assert.equal(evidence.usage.outputTokens, undefined);
const official = createGateway({ apiKey:"test", fetch:fetcher }).evaluationModel("typesafe-ai/jev");
assert.equal(await Questions.create({ model:AISDK.create({model:official}) }).about("x").is("OK?"), true);
assert.equal(calls, 3);
const recorded = await client.about("x").run(z.object({ ok: z.boolean() }));
assert.deepEqual((await recorded.replay()).value, { ok:true });
assert.equal(calls, 5);
console.log("Installed Gateway SDK and schema/bridge runtime passed");
`;
  writeFileSync(join(directory, "consumer.mjs"), source);
  for (const runtime of ["node", "bun"])
    execFileSync(runtime, ["consumer.mjs"], { cwd: directory, stdio: "inherit" });
  writeFileSync(
    join(directory, "consumer.ts"),
    `
import { z } from "zod";
import { Questions, type QuestionModel, type ChoiceAnswer } from "@nitoba/questions";
import * as Vercel from "@nitoba/questions/providers/vercel";
import * as AISDK from "@nitoba/questions/providers/ai-sdk";
const model: QuestionModel = Vercel.create({ apiKey: "test" });
const result = await Questions.create({ model }).about("x").ask(z.enum(["a", "b"]).transform(value => ({ id:value })));
const id: "a" | "b" = result.id;
// @ts-expect-error schema literals must survive the optional provider boundary
const invalid: "c" = result.id;
// @ts-expect-error explicit API key is required
Vercel.create({});
// @ts-expect-error generic bridge accepts evaluation models, never string/text model IDs
AISDK.create({ model: "typesafe-ai/jev" });
const configured = AISDK.create({ model: {
  specificationVersion: "v4", provider: "custom", modelId: "eval", supportedQuestionTypes: ["boolean"],
  async doEvaluate(request) { request.abortSignal?.throwIfAborted(); return { answers:{} }; },
}});
const source: ChoiceAnswer["confidenceSource"] = "margin";
void [id, invalid, configured, source];
`,
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: false,
        module: "NodeNext",
        target: "ES2023",
        exactOptionalPropertyTypes: true,
        lib: ["ES2023", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
      },
      include: ["consumer.ts"],
    }),
  );
  execFileSync(resolve(root, "node_modules/.bin/tsc"), ["-p", join(directory, "tsconfig.json")], {
    cwd: directory,
    stdio: "inherit",
  });
  assert.equal(
    JSON.parse(readFileSync(join(directory, "node_modules/@ai-sdk/gateway/package.json"))).version,
    JSON.parse(readFileSync(join(root, "node_modules/@ai-sdk/gateway/package.json"))).version,
  );
  console.log("Packed optional provider declarations passed without ambient Node/Bun types");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
