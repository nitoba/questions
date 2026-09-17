# Releasing Questions

This repository publishes `@nitoba/questions` as a public scoped package. Release candidates use the npm `next` dist-tag; stable releases use `latest`.

## Release checklist

1. Confirm `main` is green on Node 22, Node 24, Bun, the minimum native Zod peer, installed-package smoke tests, README snippets, and documentation links.
2. Update `package.json`, `CHANGELOG.md`, and any versioned documentation.
3. Run `bun install --frozen-lockfile` and `bun run check`.
4. Run `bun run release:dry-run` and inspect the package contents.
5. Merge or fast-forward the validated release commit to `main`.
6. Create a Git tag whose name exactly matches `v` plus the package version, for example `v0.1.0-rc.2`.
7. Push the tag. The **Publish to npm** workflow validates the tag and publishes automatically through npm Trusted Publishing/OIDC.
8. Verify the package and npm dist-tags after publication before creating downstream upgrade instructions.

## npm Trusted Publishing

The package already exists on npm. Configure its **Settings → Trusted Publisher** entry for GitHub Actions with these exact values:

- Organization or user: `nitoba`
- Repository: `questions`
- Workflow filename: `publish.yml`
- Environment: leave empty unless the workflow later uses a GitHub environment
- Allowed action: direct `npm publish`

The workflow lives at `.github/workflows/publish.yml`, but npm expects only the filename `publish.yml`. Values are case-sensitive.

The workflow uses a GitHub-hosted runner, Node 24/npm 11, and declares `id-token: write`. npm exchanges the GitHub OIDC identity for short-lived publishing credentials when `npm publish` runs. No `NPM_TOKEN` or other long-lived npm write secret is used.

Because this GitHub repository is private, npm provenance attestations are not generated even though Trusted Publishing itself works. Do not add `--provenance` or `publishConfig.provenance: true` unless the repository becomes public and the release workflow is revalidated.

## Tag-triggered publication

The workflow runs on pushed tags matching `v*`, but publication continues only after stricter validation:

- the tag must equal `v` plus the exact `package.json` version;
- the tagged commit must be contained in `main`;
- `x.y.z-rc.N` publishes with npm dist-tag `next`;
- `x.y.z` publishes with npm dist-tag `latest`;
- any other prerelease shape is rejected rather than assigned a dist-tag implicitly.

For the current release candidate:

```sh
git switch main
git pull --ff-only origin main
git tag v0.1.0-rc.2
git push origin v0.1.0-rc.2
```

Pushing the tag starts **Publish to npm** automatically. The workflow runs the package `prepublishOnly` gate through `npm publish`, so typechecks, lint, formatting, tests, build, installed-consumer checks, README snippets, and documentation links must pass before npm receives the package.

For a release candidate the effective command is:

```sh
npm publish --access public --tag next
```

For a stable version it is:

```sh
npm publish --access public --tag latest
```

An `ENEEDAUTH` error usually means the npm Trusted Publisher values do not exactly match the GitHub repository/workflow or `id-token: write` is unavailable.

## Stable release later

A future stable `0.1.0` should update `package.json` to `0.1.0`, update the release notes, validate the exact tarball, merge that commit to `main`, and push `v0.1.0`. The workflow will publish it with `latest`.

The existing `publishConfig.tag = "next"` is appropriate while the repository is on release candidates; the workflow explicitly passes `--tag latest` for a stable tag. It can be removed as part of the stable-release cleanup to keep package metadata self-explanatory.

Do not reuse a version already present in the npm registry, do not tag a commit outside `main`, and do not publish from an uncommitted working tree.
