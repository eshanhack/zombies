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

Status: passed

- Timestamp: 2026-07-17T12:55:45+10:00
- Implementation commit: `cb5e0d1c59f2`
- Browser seed: solo `12345`; four-client room `RYXC9E`, authoritative seed `1153375570`
- Client count: 4
- Automated checks:
  - `npm run typecheck`: passed with zero diagnostics across client, tests, and gate scripts.
  - `npm test`: 5 files / 19 tests passed.
  - The 54-node hand-authored graph is unique, reciprocal, fully connected, and spans all four rooms.
  - Fixed-step tests measured the canonical four-second sprint drain and three-second refill, capsule wall rejection, stair/Catwalk floor resolution, deterministic input replay, and solo noclip traversal.
  - Four independent predicted states traversed Start Hall → Armory → Generator → stairs → Catwalk against the same authoritative collision world with zero numeric divergence.
  - `npm run gate:p1:network`: four real Colyseus clients joined room `VRFT7S`, each traveled 3.15 m under server authority, acknowledged input 31, and reported exactly 0 m cross-client state divergence.
  - `npm run build`: production PWA client and authoritative server passed.
- Browser acceptance:
  - Solo production preview entered the playable bunker and F1 reported seed `12345`, phase `playing`, player position `0.00, 0.00, -1.50`, 60 FPS, 25 visible draw calls, and offline cache `ready`.
  - Noclip and navgraph controls toggled in the live solo runtime; co-op noclip remains rejected by the controller.
  - Four independent browser tabs joined one private room, the host started the roster-locked run, and every tab transitioned to the first-person state.
  - All four browser consoles remained empty after room creation, join, lock, and start.
  - The embedded verification browser intentionally denies Pointer Lock; both Playwright and native click paths were exercised, rejection was handled without a console error, and the click-to-lock affordance remained available. Re-run the physical mouse-lock check in a direct production browser before P10 promotion.
- Performance: 60 FPS in solo and four-client start scenes; 25 visible draw calls in the production solo view, well below the 150-call budget.

## P2 — Barriers and enemies

Status: in progress
