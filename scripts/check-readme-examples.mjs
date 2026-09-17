import { readFileSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// Compile the documented cumulative snippets against package self-references in dist/.
// Never execute them: they intentionally contain potentially paid model calls.
const root = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const snippets = [
  ...readFileSync(join(root, "README.md"), "utf8").matchAll(/^```ts\n([\s\S]*?)^```/gm),
];
if (!snippets.length) throw new Error("README contains no TypeScript snippets");
const directory = mkdtempSync(join(root, ".readme-check-"));
try {
  writeFileSync(
    join(directory, "readme.ts"),
    snippets.map((match, index) => `// README snippet ${index + 1}\n${match[1]}`).join("\n"),
  );
  writeFileSync(
    join(directory, "tsconfig.json"),
    JSON.stringify({
      extends: "../tsconfig.json",
      include: ["readme.ts"],
      exclude: [],
    }),
  );
  execFileSync(join(root, "node_modules/.bin/tsc"), ["-p", join(directory, "tsconfig.json")], {
    cwd: root,
    stdio: "inherit",
  });
  console.log(
    `Checked ${snippets.length} README TypeScript snippets against the built package (no execution).`,
  );
} finally {
  rmSync(directory, { recursive: true, force: true });
}
