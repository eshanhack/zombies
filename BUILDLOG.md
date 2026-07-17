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

## P3 — Core gunplay and HUD

Status: passed

- Timestamp: 2026-07-17T13:47:44+10:00
- Implementation commit: `93172b97ddd7`
- Browser seed: solo `12345`; authoritative combat rooms `VUDV94` (body), `T5LW4N` (head), and `UECQU4` (melee)
- Client count: 3 independent authoritative gate rooms plus production-browser solo
- Automated checks:
  - `npm run check`: passed under the requested TypeScript `7.0.2` pin with zero diagnostics; 7 files / 30 tests passed; production PWA client and server built successfully.
  - Local combat tests verified deterministic ray hitboxes/spread, 180 RPM cadence rejection, loaded-ammo consumption, exact 1,600 ms Melder reload transfer, +10 connecting hits, +60 body killing shots, and +100 Jäger K-8 headshot kills.
  - `npm run gate:p3:network`: real Colyseus rooms produced body transactions `[10,10,10,10,60]` and 600 final points, head transactions `[10,100]` and 610 final points, and one 150-damage melee kill worth exactly +130. Ammo, reserve, reload, hitbox, and point state synchronized back through schema patches.
  - Final production client payload: 742.91 kB JS / 199.85 kB gzip before later phase splitting.
- Browser acceptance:
  - Production seed `12345` loaded round 1 with the canvas-generated red tally, full points/ammo HUD, four-line crosshair, F1 combat state, and offline cache `ready`.
  - A visible centered target was hit in the production artifact: Melder changed from 8 / 32 to 7 / 32, points changed from 500 to 510, the `+10` headshot ledger entry rendered, hitmarker/audio events fired, and authoritative enemy HP changed.
  - The distinct Jäger K-8 primitive viewmodel and HUD showed 5 / 50; a live headshot awarded +100 and changed it to 4 / 50. Reload displayed a timed `RELOADING · 2.7s` state and completed at 5 / 49 after 2.8 seconds.
  - Procedural Melder and Jäger firing/reload layers initialized from a user gesture without browser errors. Recoil is applied to the actual input aim and recovers over the canonical 150 ms, while muzzle light and viewmodel kick remain immediate client cosmetics.
  - Production F1 held 60 FPS at 38 calls with the Melder and 40 calls with the more detailed Jäger viewmodel; production browser logs contained zero errors and zero warnings.
- Presentation evidence: round 1–5 uses original distressed canvas tally strokes; the numeral renderer, flare/burn/settle transition, point ledger, directional damage layer foundation, low-health treatment, hitmarker, expanding crosshair, ammo/reserve, grenade count, and weapon naming are all live rather than static mockups.

## P4 — Full conventional arsenal and economy

Status: passed

- Timestamp: 2026-07-17T14:28:06+10:00
- Implementation commit: `1890bdb2a0f1`
- Browser seed: solo production `12345`; authoritative two-client room `GCUTJX`
- Client count: 2 authoritative clients plus production-browser solo
- Automated checks:
  - `npm run check`: passed with zero TypeScript diagnostics; 8 files / 73 tests passed; production PWA client and authoritative server built successfully.
  - Every conventional firearm—Melder, Jäger K-8, Kurier, Sturmvogel, Doppelhieb, Lastträger, .44 Richter, Grabenfeger, Fernblick, and Kettenhund—passed its table damage, head multiplier, RPM lock, magazine/reserve, and exact reload-duration checks. Grabenfeger loads one shell per 720 ms and can fire-cancel once a shell is loaded; switching locks fire for exactly 600 ms without erasing either weapon's own cadence.
  - Shotgun tests verified all configured pellets at close range and the hard damage falloff beginning beyond 8 m. Accepted trigger pulls consume exactly one loaded shell; rejected cooldown/reload attempts consume none.
  - All six wall placements charge their canonical price, owned wall weapons refill reserve at the 0.5 price factor, frag resupply fills to four for 250, inventory never exceeds two weapons, and only the active slot is replaced.
  - Door A/B/C charged exactly 750 / 1,000 / 1,250. A deterministic simultaneous-purchase test and the real network gate both charged exactly one buyer.
  - Two independent seed-`12345` crate streams reproduced all 200 results exactly. Locked histogram: Jäger 9, Grabenfeger 22, Kurier 23, Sonnenpistole 7, Fernblick 15, Richter 24, Sturmvogel 23, Puppe 31, Doppelhieb 19, Lastträger 10, Kettenhund 13, Blitzwerfer 4. The two wonder weights sum to the specified 5%, and a 1,000-roll held-weapon comparison measured Jäger 65 unheld versus 19 held under the exact 0.25 multiplier.
  - Seed `9` deterministically produced Puppe, refunded the full 950 after exactly 5,000 ms, closed the crate, reset location uses, and relocated to a different authored site. Normal spins settle after 5,000 ms, remain purchaser-exclusive for 10,000 ms, and then expire.
  - Frag tests verified 300 close damage, flat +50 explosive kill points, no one-shot beyond 2.5 m, crawler conversion at nonlethal blast range, deterministic fuse cooking, and synchronized inventory consumption.
  - `npm run gate:p4:network`: room `GCUTJX` resolved a simultaneous Door A interaction to balances `[9750,10500]`, purchased a live wall Jäger, fired all ten conventional weapons with synchronized one-round magazine consumption, rejected a rival during the globally exclusive crate spin, collected/refunded the outcome correctly, and synchronized grenade count from four to three.
  - Final production client payload: 763.71 kB JS / 205.89 kB gzip before later phase splitting.
- Browser acceptance:
  - Production seed `12345` loaded the finished P4 runtime with offline cache `ready`; F1 reported the active crate site and phase, open-door count, grenade stock, complete weapon/ammo state, 60 FPS, and 38 draw calls.
  - All ten conventional procedural viewmodels were cycled and rendered in the live browser; HUD names and canonical starting magazines read 8, 5, 15, 32, 2, 30, 6, 6, 5, and 125 respectively.
  - Authored chalk wall-buy panels, three physical crate candidates, active blue shaft, animated lid/weapon roll, synchronized doors, and thrown-frag instances are live scene objects rather than HUD-only state.
  - The production browser console contained zero errors and zero warnings. The authoritative server gate completed without exceptions or stderr output.
- Authority/security evidence: solo and co-op share the same economy simulator and isolated crate RNG stream; the server owns spends, inventory, doors, spin exclusivity, outcomes, refunds, and grenades. Versioned gate mutations are rejected whenever `NODE_ENV=production`.
