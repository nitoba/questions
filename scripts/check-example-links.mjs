import { readdir, readFile, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
async function markdown(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return (
    await Promise.all(
      entries.map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return markdown(path);
        return entry.name.endsWith(".md") ? [path] : [];
      }),
    )
  ).flat();
}
const paths = [
  resolve(root, "README.md"),
  ...(await markdown(resolve(root, "docs"))),
  ...(await markdown(resolve(root, "examples"))),
];
const failures = [];
for (const file of paths) {
  const content = await readFile(file, "utf8");
  for (const match of content.matchAll(/\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const href = match[1];
    if (/^(?:https?:|mailto:|#)/.test(href)) continue;
    const target = resolve(dirname(file), decodeURIComponent(href.split("#")[0]));
    try {
      await access(target);
    } catch {
      failures.push(`${file}: ${href}`);
    }
  }
}
if (failures.length) throw new Error(`Broken local documentation links:\n${failures.join("\n")}`);
console.log(`Checked local links in ${paths.length} Markdown files.`);
