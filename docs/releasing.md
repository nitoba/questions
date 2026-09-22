# Releasing Questions

This repository publishes `@nitoba/questions` as a public scoped package. Stable releases use the npm `latest` dist-tag; release candidates use `next`. The first stable release is `0.1.0`.

## Release checklist

1. Confirm the release source passes Node 22, Node 24, Bun, the minimum native Zod peer, installed-package smoke tests, README snippets, and documentation links.
2. Update `package.json`, `CHANGELOG.md`, and any versioned documentation. Stable versions use `x.y.z` without a prerelease suffix.
3. Run `bun install --frozen-lockfile` and `bun run check`.
4. Run `bun run release:dry-run` and inspect the package contents. The stable checkout uses `--tag latest`; use an explicit `--tag next` when preparing a release candidate.
5. Merge or fast-forward the validated release commit to `main`.
6. Create and push a Git tag that exactly matches `v` plus the package version.
7. Wait for **Publish to npm** to pass, then verify the version and dist-tags in the npm registry.

## npm Trusted Publishing

The existing Trusted Publisher configuration uses GitHub user `nitoba`, repository `questions`, workflow filename `publish.yml`, and no GitHub environment. The filename is case-sensitive and does not include `.github/workflows/`.

The workflow uses a GitHub-hosted runner, Node 24/npm 11, and `id-token: write`. npm exchanges that OIDC identity for short-lived publishing credentials. No long-lived npm write token is required. Keep publication in `publish.yml` so it continues to match the configured publisher.

## Tag-triggered publication

The workflow accepts `v*` tags only when the tag matches `package.json` and points to a commit contained in `main`. Versions shaped as `x.y.z` publish with `latest`; `x.y.z-rc.N` publishes with `next`. Other prerelease shapes are rejected.

For version `0.1.0`, after the validated release commit reaches `main`:

```sh
git switch main
git pull --ff-only origin main
git tag v0.1.0
git push origin v0.1.0
```

Do not repeat those tag commands after the release already exists. A pushed tag normally starts **Publish to npm** automatically. A tag created by another workflow using `GITHUB_TOKEN` does not emit a new workflow run; that workflow must explicitly dispatch `publish.yml` with `release_tag=v0.1.0` instead.

The effective stable publication command is:

```sh
npm publish --access public --tag latest
```

`prepublishOnly` runs the full validation gate before npm receives the package. Do not skip it during publication. An `ENEEDAUTH` error can indicate mismatched Trusted Publisher settings or unavailable OIDC permissions.

## Verify publication

```sh
npm view @nitoba/questions version
npm view @nitoba/questions dist-tags --json
npm install @nitoba/questions zod
```

For this release, both the default version and `dist-tags.latest` must resolve to `0.1.0`. An older version may remain under `next`; that does not affect normal installation. Do not reuse a published version, move an existing release tag, or publish an uncommitted working tree. Ordinary source changes do not publish automatically.
