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

Status: passed

- Timestamp: 2026-07-17T13:20:34+10:00
- Implementation commit: `0a9281281d10`
- Browser seed: solo `12345`; authoritative network rooms `BS3UFH` (two players) and `NBECSH` (four players)
- Client count: 4
- Automated checks:
  - `npm run check`: passed with zero TypeScript diagnostics; 6 files / 26 tests passed; production PWA client and server both built successfully.
  - Deterministic solo round 1 spawned exactly six walkers. The shared simulator measured one board per 1,500 ms, a 1,200 ms interruptible vault, one repair per 900 ms with exactly +10 points, and a 150-damage round-one melee kill with exactly +130 points.
  - Non-lethal explosive damage produced a 0.6 m/s crawler while retaining remaining HP; equal seeds reproduced enemy, speed-tier, and barrier state exactly.
  - `npm run gate:p2:network`: real SDK clients observed the authoritative historical opening populations—7 at two players and 10 at four players—with nine synchronized barriers, matching seeds, matching live counts, and walker-only speed assignment.
  - Final production client payload: 721.27 kB JS / 193.63 kB gzip before later phase splitting.
- Browser acceptance:
  - The production artifact loaded seed `12345`; F1 first observed `spawn:1`, one alive, five queued, 54 / 54 boards, 100 HP, and 500 points.
  - After the timed spawn/tear interval, F1 observed five live enemies (`tear:4 · spawn:1`) and 43 / 54 boards; the visible board instances disappeared from the authored wall openings as the synchronized counts changed.
  - The completed opening population reached exactly six. Kill-all immediately changed the live count to zero and marked the rendered enemy dead; skip-round exhausted the queue and entered the 9-second intermission.
  - Production F1 stabilized at 60 FPS and 38 draw calls with six procedural enemies, fog, open window geometry, barriers, HUD, and the Melder viewmodel visible. Offline cache reported `ready`.
  - Production browser logs contained zero errors and zero warnings throughout spawn, tear, kill, and intermission transitions.
- Architecture evidence: solo and Colyseus use the same fixed-step `GameSimulation`; gameplay RNG is isolated by stream and never calls `Math.random()`; client enemies render through six dynamic `InstancedMesh` batches capped at 24.
