# Releasing Questions

This repository publishes `@nitoba/questions` as a public scoped package. Release candidates use the npm `next` dist-tag so a prerelease never replaces `latest` accidentally.

## Release checklist

1. Confirm `main` is green on Node 22, Node 24, Bun, the minimum native Zod peer, installed-package smoke tests, README snippets, and documentation links.
2. Update `package.json`, `CHANGELOG.md`, and any versioned documentation.
3. Run `bun install --frozen-lockfile` and `bun run check`.
4. Run `bun run release:dry-run`. This executes the same `prepublishOnly` validation and asks npm to build the publish tarball without uploading it.
5. Inspect the dry-run file list and package metadata. Release candidates must publish with `access=public` and `tag=next`.
6. Use the manual **Publish to npm** workflow and enter the exact version from `package.json`. Leave `dry_run=true` for validation. Set it to `false` only when the release is approved and npm Trusted Publishing is configured for `publish.yml`.
7. Verify the package and dist-tags on npm after publication before creating downstream upgrade instructions.

## First manual publication

The first publication of `@nitoba/questions` can be performed manually with your normal npm authentication. The package must exist in the npm registry before a Trusted Publisher relationship can be configured.

For `0.1.0-rc.1`, publish with the prerelease tag explicitly:

```sh
npm publish --access public --tag next
```

Do not publish the release candidate as `latest`.

## Configure npm Trusted Publishing

After the package exists on npm, open its **Settings → Trusted Publisher** page and add a GitHub Actions publisher with these exact values:

- Organization or user: `nitoba`
- Repository: `questions`
- Workflow filename: `publish.yml`
- Environment: leave empty unless this workflow is later changed to use a GitHub environment
- Allowed action: enable direct `npm publish` (staged publishing may also be enabled separately if desired)

The workflow lives at `.github/workflows/publish.yml`, but npm expects only the filename `publish.yml` in the Trusted Publisher configuration. The values are case-sensitive.

The workflow uses a GitHub-hosted runner, Node 24/npm 11, and declares `id-token: write`. npm automatically exchanges the GitHub OIDC identity for short-lived publishing credentials when `npm publish` runs. No `NPM_TOKEN` or other long-lived npm write secret is used by the workflow.

Trusted Publishing requires an npm CLI version that supports OIDC publishing; the Node 24 runner currently satisfies npm's minimum requirement. If the runner/toolchain changes, revalidate this before publishing.

Because this GitHub repository is private, npm provenance attestations are not generated even though Trusted Publishing itself works. Do not add `--provenance` or `publishConfig.provenance: true` unless the repository becomes public and the release workflow is revalidated.

After OIDC publishing is verified, remove any obsolete long-lived npm publish token from GitHub Actions and, where appropriate, restrict traditional token-based publication in npm package settings.

## Publishing through GitHub Actions

The workflow is intentionally manual and never publishes from an ordinary push or pull request.

1. Open **GitHub → Actions → Publish to npm**.
2. Choose **Run workflow** on `main`.
3. Enter the exact package version, for example `0.1.0-rc.2`.
4. Run once with `dry_run=true` to rebuild and inspect the package without uploading it.
5. Run again with `dry_run=false` to publish through npm Trusted Publishing/OIDC.

The publish command is:

```sh
npm publish --access public --tag next
```

An `ENEEDAUTH` error usually means the npm Trusted Publisher values do not exactly match the GitHub repository/workflow, `id-token: write` is missing, or the package trust relationship has not been configured yet.

## Promoting a stable release later

`0.1.0-rc.2` is published under `next`. A future stable `0.1.0` should remove the prerelease suffix and the `publishConfig.tag` override (or change the publish command deliberately) so the stable package can become `latest` only after its own release validation.

Do not publish from an uncommitted working tree, do not reuse a version already present in the registry, and do not publish automatically from ordinary pushes or pull requests.
