# Releasing nfd-ghost-sdk

GitHub Actions tests and publishes `projects/sdk` with [`.github/workflows/nfd-ghost-sdk.yml`](.github/workflows/nfd-ghost-sdk.yml). On every push and pull request to `main` it checks the versions, type-checks, builds, checks that `dist/` is browser-safe and that the generated reader matches the committed `NfdQueryReader` spec, and runs the unit tests (the integration tests skip without a dtalgod). On a `v<version>` tag it also packs the tested build, publishes it to npm with provenance once the `npm` environment's reviewer approves, and creates a GitHub release with the tarball.

## Versions

`<x.y.z>-dt.<n>`, such as `2.0.0-dt.6`: `x.y.z` is the SDK's version (bump `x` for a breaking change to its API, `y` for features, `z` for fixes) and `n` counts the releases of it, starting again at 1 when `x.y.z` changes. They're prereleases, so `^` ranges don't match them: apps pin the exact version. `publishConfig.tag` is `latest`, so each release becomes what `npm install nfd-ghost-sdk` gets.

## Steps

In `projects/sdk`:

1. Set the version in `package.json`.
2. When moving to new forks: set `algosdk` and `@algorandfoundation/algokit-utils` in `devDependencies` (`npm:dt-algosdk@<version>`, `npm:@d13co/dt-algokit-utils@<version>`, exact) and in `pnpm-workspace.yaml`'s `overrides`, the peer ranges to `^<version>`, then `pnpm install` and `pnpm release:update`, which sets the fork versions in the README.
3. `pnpm build`, `pnpm test` (against a dtalgod, see the README), `pnpm check-dist`, `pnpm release:check`, then `pnpm pack` and check its contents (`dist/`, `README.md`, `package.json`).
4. Commit, merge to `main` through a pull request, then tag the merge commit and push the tag: `git tag v<version> && git push origin v<version>`.
5. The workflow checks that the tag is on `main` and matches `package.json`, and that the forks agree across `package.json`, `pnpm-workspace.yaml`, `pnpm-lock.yaml` and the README (`pnpm release:check v<version>` runs the same check locally). It then runs the tests and, once approved, publishes with `npm publish --tag latest`. If the version is already on npm, it doesn't publish it again and only creates the GitHub release, with npm's tarball.

Tell the apps that vendor the SDK (reti-ui, algo.surf) about the release.

## Repository settings

- **Rulesets.** `main`: changes through pull requests (merge commits only) that pass `Test (Node 22.x)` and `Test (Node 24.x)`, no force pushes; repository admins can bypass. `main deletion`: `main` can't be deleted, by anyone. `release tags`: `v*-dt.*` tags can't be moved or deleted, by anyone.
- **Environment.** The publish job runs in `npm`, which needs a reviewer (`d13co`) to approve each release and lets only `v*-dt.*` tags deploy (Settings → Environments). The trusted publisher names it.

## One-time setup on npm

- **First version, by hand.** The workflow publishes only through npm trusted publishing, which is set up on a package that already exists. Publish the first version from a checkout: steps 1 to 3, then `npm publish ./nfd-ghost-sdk-<version>.tgz --tag latest --access public`, then push the tag (step 4). The workflow sees that the version is on npm, skips publishing, and creates the GitHub release.
- **Trusted publisher.** Right after the first publish, add one for the workflow, either in the package's settings on npmjs.com (Trusted publishing → GitHub Actions: owner `d13co`, repository `nfd-ghost-sdk`, workflow `nfd-ghost-sdk.yml`, environment `npm`, publishing allowed) or with npm 11.5.1 or later: `npm trust github nfd-ghost-sdk --file nfd-ghost-sdk.yml --repo d13co/nfd-ghost-sdk --env npm --allow-publish`. Publishing isn't allowed unless it's turned on. npm drops a new trusted publisher if nothing is published with it within 2 days, so add it when the next release is close. Trusted publishing adds provenance to each version and needs no token: the repository has no `NPM_TOKEN` secret.
