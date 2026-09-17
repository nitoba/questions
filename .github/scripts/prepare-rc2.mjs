import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, before, after) {
  const input = readFileSync(path, "utf8");
  if (!input.includes(before)) throw new Error(`${path}: expected text not found`);
  writeFileSync(path, input.replace(before, after));
}

replaceOnce(
  "README.md",
  "this README describes the `0.1.0-rc.1` API",
  "this README describes the `0.1.0-rc.2` API",
);

replaceOnce(
  "CHANGELOG.md",
  "## 0.1.0-rc.1\n",
  "## 0.1.0-rc.2\n\n- Republish the release candidate with the npm-first README that was added after `0.1.0-rc.1` had already been published.\n- Keep the runtime API unchanged; this release only aligns the npm package documentation and release metadata with the repository.\n- Publish through the existing `next` dist-tag and npm Trusted Publishing/OIDC workflow.\n\n## 0.1.0-rc.1\n",
);

replaceOnce(
  ".github/workflows/publish.yml",
  "default: 0.1.0-rc.1",
  "default: 0.1.0-rc.2",
);

replaceOnce(
  "docs/generative.md",
  "Available in `0.1.0-rc.1`.",
  "Available in `0.1.0-rc.2`.",
);

replaceOnce(
  "docs/generative.md",
  "For an installed local Questions tarball (or a published version once available):\n\n```sh\nbun add ./questions.tgz 'zod@^4.1.8' 'ai@^7.0.105' '@ai-sdk/provider@^4.0.17' '@ai-sdk/google@^4.0.74'\n```",
  "Install Questions from npm together with the optional AI SDK peers and the provider you use:\n\n```sh\nbun add '@nitoba/questions@next' 'zod@^4.1.8' 'ai@^7.0.105' '@ai-sdk/provider@^4.0.17' '@ai-sdk/google@^4.0.74'\n```",
);

replaceOnce(
  "docs/releasing.md",
  "Enter the exact package version, for example `0.1.0-rc.1`.",
  "Enter the exact package version, for example `0.1.0-rc.2`.",
);

replaceOnce(
  "docs/releasing.md",
  "`0.1.0-rc.1` is published under `next`.",
  "`0.1.0-rc.2` is published under `next`.",
);
