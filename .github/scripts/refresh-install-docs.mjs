import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const roots = ["README.md", "docs", "examples"];
const files = [];

function collect(path) {
  const stat = statSync(path);
  if (stat.isDirectory()) {
    for (const entry of readdirSync(path)) collect(join(path, entry));
    return;
  }
  if (path.endsWith(".md")) files.push(path);
}

for (const root of roots) collect(root);

const knownPackages = [
  "@nitoba/questions",
  "zod",
  "ai",
  "@ai-sdk/provider",
  "@ai-sdk/gateway",
  "@ai-sdk/google",
  "@ai-sdk/anthropic",
  "@ai-sdk/openai",
  "@types/json-schema",
];

function stripInstallVersions(line) {
  if (!/^\s*(bun add|npm install|npm i)\b/.test(line)) return line;

  let output = line;
  for (const pkg of knownPackages) {
    const escaped = pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    output = output
      .replace(new RegExp(`'${escaped}(?:@(?:next|latest|[~^]?[0-9][^']*))?'`, "g"), pkg)
      .replace(new RegExp(`\"${escaped}(?:@(?:next|latest|[~^]?[0-9][^\"]*))?\"`, "g"), pkg)
      .replace(new RegExp(`${escaped}@(?:next|latest|[~^]?[0-9][^\\s]*)`, "g"), pkg);
  }

  output = output
    .replace(/\s+@ai-sdk\/provider(?=\s|$)/g, "")
    .replace(/\s{2,}/g, " ")
    .trimEnd();

  return output;
}

for (const file of files) {
  let text = readFileSync(file, "utf8");
  text = text
    .split("\n")
    .map(stripInstallVersions)
    .join("\n");

  text = text
    .replace(
      /For Claude or GPT, use `@ai-sdk\/anthropic@\^[^`]+` or `@ai-sdk\/openai@\^[^`]+` instead of\nGoogle; for a Gateway language model, use `@ai-sdk\/gateway@\^[^`]+`\./g,
      "For Claude or GPT, use `@ai-sdk/anthropic` or `@ai-sdk/openai` instead of\nGoogle; for a Gateway language model, use `@ai-sdk/gateway`.",
    )
    .replace(
      /The ranges start at the tested versions; later releases, every model and older SDK majors are not automatically verified\.\n/g,
      "Questions targets the current supported AI SDK major; individual model availability and structured-output support remain provider-specific.\n",
    )
    .replace(
      /`ai` and `@ai-sdk\/provider` are optional peers of Questions, resolved only by consumers using this\nintegration\. The latter supplies the precise public `LanguageModelV4` type without pulling the\nlarge AI SDK barrel into Questions' declarations\./g,
      "`ai` is the runtime integration package. The selected AI SDK provider package supplies the shared provider contract transitively, so consumers do not need to install `@ai-sdk/provider` directly.",
    )
    .replace(
      /The native Questions API still supports Zod 4\.0\.0 and does not load AI SDK packages\. This optional\nintegration requires Zod >=4\.1\.8 within v4 because of its SDK dependencies\. The tested versions are\nAI SDK 7\.0\.105, provider 4\.0\.17, Google 4\.0\.74, Anthropic 4\.0\.56, OpenAI 4\.0\.69 and Gateway 4\.0\.85\./g,
      "Questions targets Zod 4 and AI SDK 7. Install the packages by name and let your package manager resolve compatible current releases.",
    )
    .replace(
      /This integration targets the \*\*experimental Evaluation V4\*\* contract and is tested with `@ai-sdk\/gateway@[^`]+` and its `@ai-sdk\/provider@[^`]+`\. Gateway is an optional peer \(`[^`]+`\)\. Its own Zod requirement is `[^`]+`; use \*\*Zod >=4\.1\.8\*\* with Questions \+ Gateway\. The native Questions package continues to support Zod 4\.0\.0\./g,
      "This integration targets the **experimental Evaluation V4** contract. Install `@ai-sdk/gateway` and `zod` by name and let your package manager resolve compatible current releases. Questions targets Zod 4.",
    )
    .replace(
      /`probabilitySource: \"estimated\"`\. Install its optional `ai` and `@ai-sdk\/provider` peers and the\nchosen SDK provider\./g,
      "`probabilitySource: \"estimated\"`. Install `ai` and the chosen SDK provider; `@ai-sdk/provider` does not need to be installed directly by the consumer.",
    )
    .replace(
      /The current integration uses AI SDK 7 LanguageModelV4 and Zod >=4\.1\.8 within v4; the native\npackage still supports Zod 4\.0\.0\./g,
      "The current integration uses AI SDK 7 LanguageModelV4 and Zod 4.",
    )
    .replace(
      /These examples target the repository's current \*\*0\.1\.0-alpha\.6\*\* API\./g,
      "These examples target the repository's current **0.1.0-rc.2** API.",
    )
    .replace(
      /The package is not published by this change\. After creating its local tarball, install it with Zod and the optional SDK:\n\n```sh\nbun add \/tmp\/questions\.tgz zod @ai-sdk\/gateway\n```/g,
      "Install Questions, Zod and the optional Gateway SDK from npm:\n\n```sh\nbun add @nitoba/questions zod @ai-sdk/gateway\n```",
    );

  writeFileSync(file, text);
}

const markdown = files.map((file) => `${file}\n${readFileSync(file, "utf8")}`).join("\n");
const forbidden = [
  /@nitoba\/questions@next/,
  /zod@\^?[0-9]/,
  /ai@\^?[0-9]/,
  /@ai-sdk\/(?:provider|gateway|google|anthropic|openai)@\^?[0-9]/,
];
for (const pattern of forbidden) {
  if (pattern.test(markdown)) throw new Error(`Version-pinned user documentation remains: ${pattern}`);
}

const directProviderInstall = markdown
  .split("\n")
  .filter((line) => /^(\s*)(bun add|npm install|npm i)\b/.test(line) && line.includes("@ai-sdk/provider"));
if (directProviderInstall.length > 0) {
  throw new Error(`User-facing install commands must not require @ai-sdk/provider directly:\n${directProviderInstall.join("\n")}`);
}
