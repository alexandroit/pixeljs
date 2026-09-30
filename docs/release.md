# Releasing PixelJS

`@pixeljs/core` and `@pixeljs/create` are published to npm only by the [`publish.yml`](../.github/workflows/publish.yml) workflow, with provenance. Releases are never published from a local machine.

Both packages always share one version. `node tools/check-release.mjs [vX.Y.Z]` (also part of `npm run verify`) enforces the shared version, the tag, the MIT license files, public/non-private package metadata, the repository URL that provenance requires, the starters' dependency on the matching core version and a `CHANGELOG.md` section for the version.

## How a release is published

The build is reproducible: two clean builds pack byte-identical tarballs. The release therefore publishes exactly the bytes that CI tested.

1. **Prepare the version.** Update the version in `packages/core/package.json`, `packages/create/package.json` and `export const version` in `packages/core/src/index.ts`; run `npm install --package-lock-only --ignore-scripts`; add a `## X.Y.Z` section to `CHANGELOG.md`; merge to `main`.
2. **Tag the tested commit.** Push the tag `vX.Y.Z` on that commit. CI runs on the tag; when it passes, its run summary lists the SHA-512 digests of the two tarballs it tested, and the tarballs are kept as the `npm-candidates-*` artifact.
3. **Dispatch the publication.** Run the workflow on the tag with those digests (the summary prints the exact command):

   ```sh
   gh workflow run publish.yml --ref vX.Y.Z -f core_sha512=<digest> -f create_sha512=<digest>
   ```

4. **What the workflow does.** It checks that it runs on the tag matching the package version, audits the runtime dependencies (there are none), runs `npm run verify` again (native and sanitizer C, WASM, Node, packed consumers and starters, documentation, three browsers, the game), refuses versions that already exist on npm, packs both tarballs and requires their SHA-512 to equal the tested digests, generates CycloneDX SBOMs, keeps tarballs, `SHA512SUMS` and SBOMs as the `npm-release` artifact, publishes `@pixeljs/core` then `@pixeljs/create` with `--provenance`, checks that the registry serves the same bytes (`dist.integrity`, waiting up to ten minutes for a new package's metadata) and finally attaches everything to the GitHub release `vX.Y.Z`, creating it when needed and never replacing existing assets.
5. **Check the result.** Look at the provenance on the npm package pages, then install the published version in a clean project (`npm create @pixeljs@latest my-game`). Only then update the website's install instructions.

## One-time setup

1. **Environment.** The repository's `npm` environment only admits tags matching `v*`. Only the publish job uses it, and only that job receives an OIDC token (`id-token: write`).
2. **First publication.** npm trusted publishing can only be configured for packages that already exist, so the first release authenticates with an `NPM_TOKEN` secret stored in the `npm` environment (a token of the account that owns the `@pixeljs` scope).
3. **Trusted publishing afterwards.** Once both packages exist, add the trusted publisher on npmjs.com (or with `npm trust github <package> --file publish.yml --repo alexandroit/pixeljs --env npm --allow-publish`, which asks for the account's two-factor confirmation) for both packages, then **delete the `NPM_TOKEN` secret and revoke that token**. Publication then uses the job's short-lived OIDC identity; `npm publish --provenance` works the same way.
4. GitHub private vulnerability reporting is enabled for the repository (see [SECURITY](../SECURITY.md)).

## What a release does not do

Publishing to npm does not deploy pixeljs.com; the website is built with `npm run build:site` and deployed separately.
