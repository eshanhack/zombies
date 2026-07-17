# Security and dependency scope

## Supported release

Only the current production revision is supported. The game stores settings, records, and resumable room tokens locally; it does not implement accounts, payments, chat, analytics, or personal-data collection.

## Server surface

The production server exposes the Colyseus matchmaking/room transport and `/health`. CORS is restricted to exact origins from `CLIENT_ORIGIN`. Mutating F1/gate commands are rejected whenever `NODE_ENV=production`.

The umbrella `colyseus@0.17.10` package remains exactly pinned as required for framework compatibility, but is development-only. Production imports use the exact `@colyseus/core`, `@colyseus/tools`, WebSocket transport, schema, and Redis packages directly. This excludes the unused authentication and playground packages—and their advisory-bearing OAuth dependency chain—from the production dependency graph. `npm audit --omit=dev` and `npm run gate:p10:release` enforce that boundary.

The required schema release declares TypeScript support through major version 6, while this project is required to pin TypeScript 7.0.2. `.npmrc` records `legacy-peer-deps=true` for deterministic CI installation. This is a peer-metadata mismatch only: strict typecheck, emitted server build, and the complete automated suite are release gates.

## Reporting

Report a suspected vulnerability privately to the repository owner with reproduction steps, affected revision, and impact. Do not include deployment tokens, resume tokens, or private room codes in a public issue.
