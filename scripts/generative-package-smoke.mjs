import { packDependencies } from "./pack-dependencies.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const directory = mkdtempSync(join(tmpdir(), "questions-generative-consumer-"));
try {
  const overrides = packDependencies(root, directory, [
    "zod",
    "ofetch",
    "ms",
    "ai",
    "@ai-sdk/google",
    "@ai-sdk/anthropic",
    "@ai-sdk/openai",
    "@types/json-schema",
  ]);
  const tarball = join(directory, "questions.tgz");
  execFileSync("bun", ["pm", "pack", "--filename", tarball], { cwd: root, stdio: "pipe" });
  writeFileSync(
    join(directory, "package.json"),
    JSON.stringify({ private: true, type: "module", overrides }),
  );
  execFileSync(
    "bun",
    [
      "add",
      tarball,
      overrides.zod,
      overrides.ai,
      overrides["@types/json-schema"],
      overrides["@ai-sdk/google"],
      overrides["@ai-sdk/anthropic"],
      overrides["@ai-sdk/openai"],
    ],
    { cwd: directory, stdio: "pipe" },
  );
  writeFileSync(
    join(directory, "consumer.mjs"),
    `
import assert from "node:assert/strict";
import { MockLanguageModelV4 } from "ai/test";
import { z } from "zod";
import { Questions, Streams } from "@nitoba/questions";
import * as Generative from "@nitoba/questions/providers/generative";
const model = new MockLanguageModelV4({ doGenerate: {
  content:[{type:"text",text:JSON.stringify({q0:{o0:0.8,o1:0.2}})}],
  finishReason:{unified:"stop",raw:"stop"},
  usage:{inputTokens:{total:3},outputTokens:{total:2}}, warnings:[],
}});
const client = Questions.create({model:Generative.create({model,evidence:"estimated",timeout:"2 seconds"})});
const schema = z.enum(["a","b"]).transform(team=>({team}));
const run = await client.about("x").run(schema);
assert.deepEqual(run.value,{team:"a"});
assert.equal(run.diagnostics[0].answer.probabilitySource,"estimated");
assert.equal(run.evidence.providerMetadata.questionsGenerative.promptVersion,Generative.PROMPT_VERSION);
assert.deepEqual((await run.replay()).value,{team:"a"});
assert.deepEqual(await Streams.from(["x"]).map(v=>client.about(v).ask(schema)).toArray(),[{team:"a"}]);
assert.equal(model.doGenerateCalls.length,3);
console.log("Installed generative SDK, schemas, diagnostics, replay and streams passed");
`,
  );
  for (const runtime of ["node", "bun"])
    execFileSync(runtime, ["consumer.mjs"], { cwd: directory, stdio: "inherit" });
  writeFileSync(
    join(directory, "consumer.ts"),
    `
import { Questions, type ProbabilitySource } from "@nitoba/questions";
import * as Generative from "@nitoba/questions/providers/generative";
import { z } from "zod";
declare const model: Generative.Model;
const client=Questions.create({model:Generative.create({model,evidence:"estimated"})});
const result=await client.about("x").run(z.enum(["a","b"]).transform(id=>({id})).readonly());
const id:"a"|"b"=result.value.id;
const source:ProbabilitySource|undefined=result.diagnostics[0]?.answer.probabilitySource;
// @ts-expect-error readonly output must survive installed provider declarations
result.value.id="a";
// @ts-expect-error explicit acknowledgement required
Generative.create({model});
// @ts-expect-error no implicit provider routing
Generative.create({model:"google/test",evidence:"estimated"});
// @ts-expect-error evaluation is a distinct protocol
Generative.create({model: { specificationVersion: "v4", provider: "x", modelId: "x", doEvaluate: async()=>({}) },evidence:"estimated"});
void [id,source];
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
  console.log(
    "Installed generative declarations passed with skipLibCheck:false and no ambient Node/Bun types",
  );
  // The SDK 7 barrel/provider-utils declarations have independent Buffer/Tool constraints.
  // Check actual model assignability separately without weakening our own declaration check.
  writeFileSync(
    join(directory, "sdk-consumer.ts"),
    `
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { createGateway } from "@ai-sdk/gateway";
import * as Generative from "@nitoba/questions/providers/generative";
for (const model of [createGoogleGenerativeAI()('test'),createAnthropic()('test'),createOpenAI()('test'),createGateway()('google/test')]) {
  Generative.create({model,evidence:"estimated",timeout:"2 s"});
}
// @ts-expect-error evaluation and language models remain distinct
Generative.create({model:createGateway().evaluationModel('typesafe-ai/jev'),evidence:"estimated"});
`,
  );
  writeFileSync(
    join(directory, "sdk-tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: true,
        module: "NodeNext",
        target: "ES2023",
        exactOptionalPropertyTypes: true,
        lib: ["ES2023", "DOM", "DOM.Iterable", "DOM.AsyncIterable"],
      },
      include: ["sdk-consumer.ts"],
    }),
  );
  execFileSync(
    resolve(root, "node_modules/.bin/tsc"),
    ["-p", join(directory, "sdk-tsconfig.json")],
    { cwd: directory, stdio: "inherit" },
  );
  console.log("Installed model assignability passed for Google, Anthropic, OpenAI and Gateway");
} finally {
  rmSync(directory, { recursive: true, force: true });
}
