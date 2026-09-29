# Releasing

spec2mcp is published to npm as `spec2mcp` from the GitHub release flow. There
are no manual publishes: a maintainer cuts a GitHub release and the
[Publish workflow](.github/workflows/publish.yml) does the rest.

## Version strategy

- [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.
- While the package is 0.x, breaking changes bump the minor version and
  backwards-compatible additions and fixes bump the patch version.
- The first public release is **0.1.0**. The `[Unreleased]` section of
  [CHANGELOG.md](CHANGELOG.md) is its release notes.
- Every release gets a GitHub release and a tag named `vX.Y.Z` (for example
  `v0.1.0`). The tag version must match `version` in `package.json` exactly,
  without the leading `v`.

## Release steps

1. Move the entries for this release out of `[Unreleased]` in
   [CHANGELOG.md](CHANGELOG.md) into a new `## [X.Y.Z] - YYYY-MM-DD` section,
   and update the comparison links at the bottom of the file.
2. Bump the version: `npm version X.Y.Z` (this commits the `package.json`
   change and creates the `vX.Y.Z` tag in one step).
3. Push the branch and the tag: `git push && git push --tags`.
4. Create a GitHub release from the `vX.Y.Z` tag. Paste the new changelog
   section as the release notes.
5. Publishing the release triggers the Publish workflow, which installs
   dependencies with `npm ci`, runs the test suite, and only then publishes.
   The released package is exactly what CI validated for the tagged commit.

If the publish step fails, do not retry it blindly: npm accepts a given
`name@version` exactly once. Fix the cause, bump to the next patch version,
and cut a new release.

## Trusted publishing

The workflow publishes with
[npm trusted publishing](https://docs.npmjs.com/trusted-publishers/), so there
is no long-lived npm token anywhere: GitHub Actions authenticates to npm with
an OIDC identity token and npm mints a short-lived credential for the publish.

For this to work:

- The npm package `spec2mcp` must have a trusted publisher configured for the
  `rowkavdev/spec2mcp` GitHub repository, pointing at the
  `.github/workflows/publish.yml` workflow. That setup lives on npmjs.com and
  is done once, outside this repository.
- The job needs `permissions: id-token: write` so Actions can issue the OIDC
  token. The workflow also sets `contents: read` and nothing more.
- Trusted publishing requires npm CLI 11.5.1 or later. Node 22 ships an older
  npm, so the workflow upgrades npm before publishing.
- The publish runs with `--provenance`, so each released version carries a
  provenance attestation linking it back to the exact commit and workflow run
  on GitHub.

Because authentication is tied to this repository and this workflow file,
publishing from anywhere else (a fork, a local machine, a renamed workflow) is
rejected by npm. If the workflow file is renamed, update the trusted publisher
on npm to match before the next release.
