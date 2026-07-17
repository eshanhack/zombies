# Stahlbunker 1945 Build Log

Every phase is gated by automated checks and an in-browser acceptance pass. A phase remains open until its evidence is recorded here.

## P0 — Foundation

Status: passed

- Timestamp: 2026-07-17T12:33:00+10:00
- Implementation commit: `e45f7cf390b0`
- Browser seed: `12345` (second client deliberately booted with `999` before joining)
- Client count: 2
- Automated checks:
  - `npm run typecheck`: passed with zero diagnostics.
  - `npm test`: 2 files / 9 tests passed; deterministic RNG streams and canonical round/health/population formula checks included.
  - `npm run build`: passed; Vite production client, generated service worker, and authoritative server all built successfully.
  - Production client payload: 659.65 kB JS / 175.47 kB gzip before later phase splitting.
- Browser acceptance:
  - Seeded menu loaded with one WebGL canvas and no browser errors or warnings.
  - F1 reported seed `12345`, 60 FPS, 97 draw calls, phase `menu`, and offline cache `ready` from the production preview.
  - Private room `TGQSZW` created by client one; client two joined by code.
  - Both clients reported authoritative seed `3869781387`, room code `TGQSZW`, and `2 / 4 operatives connected`.
  - Both browser consoles remained empty after create/join synchronization.
  - Server `/health` returned `{ ok: true, service: "stahlbunker-server", protocolVersion: 1 }`.
- Evidence: in-app browser DOM snapshots and rendered menu review were observed during the gate; no phase was advanced from source inspection alone.
- Follow-up tracked for release audit: npm reports eight low/moderate advisories in Colyseus's unused optional auth/playground dependency chain; no vulnerable package is imported by the game server. Resolve or formally isolate before P10.

## P1 — Controller and original greybox

Status: in progress
