import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

/** Package real installed dependencies for isolated, network-independent consumer tests. */
export function packDependencies(root, directory, names) {
  const overrides = {};
  function pack(name) {
    if (Object.hasOwn(overrides, name)) return;
    const location = realpathSync(join(root, "node_modules", name));
    const manifest = JSON.parse(readFileSync(join(location, "package.json"), "utf8"));
    const archive = join(directory, `${name.replaceAll("/", "-")}.tgz`);
    execFileSync("bun", ["pm", "pack", "--ignore-scripts", "--filename", archive], {
      cwd: location,
      stdio: "pipe",
    });
    overrides[name] = `file:${archive}`;
    for (const dependency of Object.keys(manifest.dependencies ?? {})) pack(dependency);
  }
  for (const name of names) pack(name);
  return overrides;
}
