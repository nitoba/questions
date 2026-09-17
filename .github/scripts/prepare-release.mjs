import { readFileSync, writeFileSync } from "node:fs";

function replaceOnce(path, before, after) {
  const input = readFileSync(path, "utf8");
  if (!input.includes(before)) throw new Error(`${path}: expected release marker not found`);
  writeFileSync(path, input.replace(before, after));
}

replaceOnce(
  "README.md",
  "> **Alpha:** this README describes the `0.1.0-alpha.6` API. See the [changelog](CHANGELOG.md)\n> and [migration guide](docs/migration.md) before upgrading. Decisions are finite classifications,\n> not arbitrary JSON generation, factual guarantees or authorization to execute business actions.",
  "> **Release candidate:** this README describes the `0.1.0-rc.1` API. The public surface is now\n> frozen for the 0.1.0 release candidate; fixes and compatibility validation take priority over new\n> features. Decisions are finite classifications, not arbitrary JSON generation, factual guarantees\n> or authorization to execute business actions. See the [changelog](CHANGELOG.md) and\n> [migration guide](docs/migration.md) before upgrading.",
);

replaceOnce(
  "README.md",
  "### Use a local build in another project\n",
  `### Install the release candidate from npm\n\nAfter \`0.1.0-rc.1\` is published, install the prerelease explicitly through the \`next\` dist-tag:\n\n\`\`\`sh\nbun add '@nitoba/questions@next' 'zod@^4.0.0'\n\`\`\`\n\nDo not rely on \`latest\` for the release candidate. Optional Gateway and generative integrations\nhave additional peers described in [Providers](#providers). The package is public but live model\ncalls still require your own provider credentials and may incur charges.\n\n### Use a local build in another project\n`,
);

replaceOnce("docs/generative.md", "Available in `0.1.0-alpha.6`.", "Available in `0.1.0-rc.1`.");

replaceOnce(
  "CHANGELOG.md",
  "## Unreleased — generative examples and README\n",
  "## 0.1.0-rc.1\n\n- Promote the tested alpha API to the first release candidate without adding new runtime features.\n- Prepare the scoped package for public npm publication under the `next` dist-tag, with an exact-version manual release workflow and a local `npm publish --dry-run` command.\n- Add npm release metadata, package discovery fields, a prepublish validation gate and a documented first-publish/Trusted-Publishing migration procedure.\n",
);

replaceOnce(
  "CHANGELOG.md",
  "This implementation does not publish the package or run paid live-model evaluations.",
  "Repository changes do not publish the package automatically, and release validation does not run paid live-model evaluations.",
);
