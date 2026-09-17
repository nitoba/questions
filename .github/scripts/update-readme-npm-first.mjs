import { readFileSync, writeFileSync } from "node:fs";

const path = "README.md";
let text = readFileSync(path, "utf8");

const oldQuickStart = `## Quick start

Use the Bun version pinned in [package.json](package.json) to work on the repository:

\`\`\`sh
git clone https://github.com/nitoba/questions.git
cd questions
bun install --frozen-lockfile
bun run test:examples
\`\`\`

The tests require no API keys and do not call paid models. Start with direct Jev evaluation:

\`\`\`sh
TYPESAFE_API_KEY='your-own-key' bun examples/01-first-question.ts
\`\`\`

Or run a schema tutorial with a generative model available to your account:

\`\`\`sh
QUESTIONS_PROVIDER=generative GENERATIVE_PROVIDER=google \\
GENERATIVE_MODEL='your-structured-output-model-id' \\
GOOGLE_GENERATIVE_AI_API_KEY='your-own-key' \\
bun examples/07-zod-decision-schemas.ts
\`\`\`

The shared selection also works for native-question tutorials, streams and the complete app.
Use \`GENERATIVE_PROVIDER=anthropic\`, \`openai\` or \`gateway\` with the corresponding key and model
ID. The [configuration matrix](examples/README.md#choose-one-model-configuration) lists exact
variables and the few intentionally provider-specific lessons. Model IDs are explicit, not
hardcoded recommendations or automatically chosen defaults.

The [learning path](examples/README.md) includes native questions, Zod, non-streaming workflows,
streams and a complete application. [Environment setup](examples/.env.example) documents the
available provider settings. Live commands may incur charges; there is no automatic fake-model
fallback or command that runs every paid tutorial.

### Install the release candidate from npm

After \`0.1.0-rc.1\` is published, install the prerelease explicitly through the \`next\` dist-tag:

\`\`\`sh
bun add '@nitoba/questions@next' 'zod@^4.0.0'
\`\`\`

Do not rely on \`latest\` for the release candidate. Optional Gateway and generative integrations
have additional peers described in [Providers](#providers). The package is public but live model
calls still require your own provider credentials and may incur charges.

### Use a local build in another project

These commands do not depend on the package being published to npm:

\`\`\`sh
# In this repository:
bun run build
bun pm pack --filename /tmp/questions.tgz

# In your application:
cd ../your-app
bun add /tmp/questions.tgz 'zod@^4.0.0'
\`\`\`

The root import requires the Zod 4 peer, even when your application uses only native question
batches. Generative and Vercel support have additional optional peers; see [Providers](#providers).
The examples in this repository import source files so they can run without a build.
The snippets below use package imports and run in server-side TypeScript on Node or Bun.
`;

const newQuickStart = `## Quick start

Install the published release candidate from npm. The \`next\` dist-tag tracks the current prerelease:

\`\`\`sh
bun add '@nitoba/questions@next' 'zod@^4.0.0'
\`\`\`

With npm:

\`\`\`sh
npm install '@nitoba/questions@next' 'zod@^4.0.0'
\`\`\`

Then create a client and ask your first typed question:

\`\`\`ts
import { Questions, TypeSafe } from "@nitoba/questions";

const apiKey = process.env.TYPESAFE_API_KEY;
if (!apiKey) throw new Error("Set TYPESAFE_API_KEY");

const questions = Questions.create({
  model: TypeSafe.create({ apiKey, timeout: "15 seconds" }),
});

const ticket = {
  title: "Production API is unavailable",
  details: "Every request returns 503 after the deployment.",
};

const urgent = await questions.about(ticket).is("Is production work blocked?");
console.log(urgent); // boolean, inferred and validated
\`\`\`

The root import requires the Zod 4 peer even when you use only native question batches. Optional
Gateway and generative integrations have additional peers described in [Providers](#providers).
Live model calls require your own provider credentials and may incur charges.

If you want to learn the full API, see the [examples and tutorial path](examples/README.md). Those
examples live in this repository and are intended for learning, testing and development; using the
published package in an application does **not** require cloning the repository.
`;

if (!text.includes(oldQuickStart)) throw new Error("README quick-start block changed unexpectedly");
text = text.replace(oldQuickStart, newQuickStart);

const oldDev = `## Development and compatibility

\`\`\`sh
bun run check          # Types, lint, format, tests, build, installed consumers and local doc links
bun run test:examples  # Executable tutorials, SQLite/HTTP/CLI tests and local doc links
bun run test:coverage
bun run test:docs      # Typecheck README snippets against the built package; no inference
\`\`\`
`;

const newDev = `## Development and compatibility

Clone the repository only if you want to contribute to Questions, run its test suite, or execute the
repository tutorials locally:

\`\`\`sh
git clone https://github.com/nitoba/questions.git
cd questions
bun install --frozen-lockfile
\`\`\`

Then use the development commands:

\`\`\`sh
bun run check          # Types, lint, format, tests, build, installed consumers and local doc links
bun run test:examples  # Executable tutorials, SQLite/HTTP/CLI tests and local doc links
bun run test:coverage
bun run test:docs      # Typecheck README snippets against the built package; no inference
\`\`\`
`;

if (!text.includes(oldDev)) throw new Error("README development block changed unexpectedly");
text = text.replace(oldDev, newDev);

writeFileSync(path, text);
