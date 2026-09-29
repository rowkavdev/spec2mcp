# Vendored @cloudflare/forge

Source: https://github.com/cloudflare/forge, package `packages/forge`
Pinned commit: cfe397c296a5e6d9fce01eb335ed805821e5547c (2026-09-29)
Licence: Apache-2.0 (see LICENSE in this directory), copyright Cloudflare, Inc.

Vendored because `@cloudflare/forge` is not yet published to npm. When it is,
this directory gets replaced by the npm dependency. Test files were dropped;
everything else is verbatim. There is no automated sync script: the previous
script used a placeholder URL and an unverified fallback, which could silently
replace this pinned source with a different revision. For an update, check out
the desired full upstream commit, replace this package source from
`packages/forge` (excluding tests), copy the upstream Apache-2.0 LICENSE,
update the pinned commit here, and run typecheck, build, and tests. Review the
vendored diff before committing; keep attribution and the license.

## Deviations from verbatim

- openapi-resolver.ts: additively carries the OpenAPI `allowReserved`
  parameter flag through Parameter -> ParameterInfo (3 interface fields +
  1 extraction line, no behavior change to existing paths), for #108.
  Applied 2026-09-29; drop if upstream adopts the same carry.
