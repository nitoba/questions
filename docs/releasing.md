# Releasing Questions

This repository publishes `@nitoba/questions` as a public scoped package. Release candidates use the npm `next` dist-tag so a prerelease never replaces `latest` accidentally.

## Release checklist

1. Confirm `main` is green on Node 22, Node 24, Bun, the minimum native Zod peer, installed-package smoke tests, README snippets, and documentation links.
2. Update `package.json`, `CHANGELOG.md`, and any versioned documentation.
3. Run `bun install --frozen-lockfile` and `bun run check`.
4. Run `bun run release:dry-run`. This executes the same `prepublishOnly` validation and asks npm to build the publish tarball without uploading it.
5. Inspect the dry-run file list and package metadata. Release candidates must publish with `access=public` and `tag=next`.
6. Use the manual **Publish to npm** workflow and enter the exact version from `package.json`. Leave `dry_run=true` for validation. Set it to `false` only when the release is approved.
7. Verify the package and dist-tags on npm after publication before creating downstream upgrade instructions.

## First publication

The first publication of `@nitoba/questions` needs an npm credential with permission to create a public package in the `@nitoba` scope. Store it as the GitHub Actions secret `NPM_TOKEN`; do not commit it or place it in example environment files.

The workflow uses `npm publish --access public --tag next`. Scoped packages need explicit public access on first publication, and prereleases intentionally avoid the `latest` tag.

## Trusted Publishing after the package exists

npm Trusted Publishing can replace the long-lived publish token after the package has been created. npm requires an existing package before a trusted publisher can be configured.

Configure the GitHub trusted publisher for:

- owner/user: `nitoba`
- repository: `questions`
- workflow file: `publish.yml`
- permission: direct publish (and staged publish as desired)

The workflow already requests `id-token: write`. After the trust relationship is configured and verified, remove the explicit first-publication `NPM_TOKEN` requirement from the workflow and stop using a long-lived write token.

Because this GitHub repository is private, npm provenance attestations are not available even when Trusted Publishing is used. Do not add `--provenance` or `publishConfig.provenance: true` unless the repository becomes public and the release workflow is revalidated.

## Promoting a stable release later

`0.1.0-rc.1` is published under `next`. A future stable `0.1.0` should remove the prerelease suffix and the `publishConfig.tag` override (or change the publish command deliberately) so the stable package can become `latest` only after its own release validation.

Do not publish from an uncommitted working tree, do not reuse a version already present in the registry, and do not publish automatically from ordinary pushes or pull requests.
