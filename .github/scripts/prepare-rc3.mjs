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

for (const file of files) {
  const input = readFileSync(file, "utf8");
  const output = input.replaceAll("0.1.0-rc.2", "0.1.0-rc.3");
  if (output !== input) writeFileSync(file, output);
}

const changelogPath = "CHANGELOG.md";
let changelog = readFileSync(changelogPath, "utf8");
if (!changelog.includes("## 0.1.0-rc.3")) {
  changelog = changelog.replace(
    "# Changelog\n\n",
    "# Changelog\n\n## 0.1.0-rc.3\n\n- Refresh consumer installation documentation to use unpinned package names and let package managers resolve compatible current releases.\n- Stop instructing consumers to install `@ai-sdk/provider` directly; generative users install `ai` plus the provider package they use.\n- Keep runtime behavior unchanged and publish this documentation/release metadata update through the tag-triggered npm Trusted Publishing workflow.\n\n",
  );
  writeFileSync(changelogPath, changelog);
}
