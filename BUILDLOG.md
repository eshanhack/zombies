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

## P5 — Power, perks, power-ups, co-op life cycle, and Höllenwölfe

Status: passed

- Timestamp: 2026-07-17T15:12:26+10:00
- Implementation commit: `3103cc19ee2b`
- Browser seed: solo production `12345`; authoritative two-client room `XGHQW3`
- Client count: 2 authoritative clients plus production-browser solo
- Automated checks:
  - `npm run check`: passed with zero TypeScript diagnostics; 9 files / 93 tests passed; production PWA client and authoritative server built successfully.
  - Real breaker interaction keeps every machine inactive before power, stages the 3,000 ms room surge once, and exposes shared power state to every client.
  - Eisenbräu measured exactly five 50-damage hits; Schnellwasser measured exactly 0.5 reload time; Doppelschuss measured the configured 1.33 fire-rate multiplier. Solo Zweiter Atem consumed one of three stocks, waited exactly 3,000 ms, restored both weapons, and removed all perks.
  - Insta-Kill and Double Points lasted exactly 30,000 ms. Double Points covered bullets, melee, repairs, and team awards. Nuke waited 500 ms, killed live enemies without consuming the queue, and awarded 400 team-wide. Carpenter restored all barriers and awarded 200 team-wide. Untouched drops despawned at exactly 30,000 ms.
  - Max Ammo refilled every reserve and grenades to four while preserving each loaded magazine byte-for-byte.
  - Co-op tests measured 4,500 ms normal revives, 2,250 ms Zweiter Atem revives, +50 to the reviver, 30,000 ms bleedout, next-round Melder return with preserved points, and reconnect return with inventory/perks/statistics preserved.
  - Deterministic wolf tests proved first round in 5–7, subsequent 5–7 intervals, 6/6/8 per-player populations, two-active-per-player cap under the global 24 cap, health sequence 400 / 900 / 1,300 / 1,600 capped, 5.5 m/s speed, 40 damage, 700 ms attack cadence, and guaranteed final-wolf Max Ammo.
  - `npm run gate:p5:network`: room `XGHQW3` rejected a late join after start, synchronized shared power, observed the exact five-hit Eisenbräu down, timed 2.25 s and 4.5 s revives, awarded +50, synchronized Schnellwasser/Doppelschuss, preserved a 7-round loaded magazine through team Max Ammo, reconnected the original session as a spectator with state preserved, returned it at the next round boundary, and completed a 12-wolf round with guaranteed Max Ammo.
  - `npm run gate:p4:network` was rerun against the P5 server; all prior doors, wall buys, ten conventional weapons, exclusive crate, and grenade synchronization remained green.
  - Final production client payload: 795.44 kB JS / 214.19 kB gzip before later phase splitting.
- Browser acceptance:
  - The exact production artifact loaded seed `12345` with PWA cache `ready`; F1 showed P5 system state, deterministic next-wolf round, power, perks, active effects, life state, and zero console errors.
  - Live controls activated power, granted all four perk icons, triggered timed Insta-Kill/Double Points presentation, and started the seeded wolf round. F1 observed `wolves`, red close fog, 250 Eisenbräu HP, synchronized counts, and 60 FPS at 39 draw calls.
  - Distinct procedural quadruped wolf batches, authored fog-bank spawning, powered perk-machine emissives, physical breaker lever, spinning/blinking power-up geometry, downed/spectator overlays, and the co-op resume entry point are rendered production code rather than test-only state.
  - Production browser diagnostics reported offline cache `ready`, 60 FPS, 39 draw calls, and `Console errors: 0` throughout the exercised gate.
- Authority/lifecycle evidence: the server owns all P5 state and rejects production mutations; gameplay pauses when every roster member disconnects, retains the locked room for ten minutes, and then disposes it. Colyseus cryptographic reconnection tokens are persisted under the versioned resume key; a reconnecting original cannot play until the next round boundary.

## P6 — Forge and wonder weapons

Status: passed

- Timestamp: 2026-07-17T15:42:26+10:00
- Implementation commit: `15a50434009e`
- Browser seed: solo production `12345`; authoritative two-client room `AGCG2L`
- Client count: 2 authoritative clients plus production-browser solo
- Automated checks:
  - `npm run check`: passed with zero TypeScript diagnostics; 10 files / 98 tests passed; production PWA client and authoritative server built successfully.
  - Die Schmiede is power-gated and globally exclusive, debits exactly 5,000 points, locks combat for exactly 3,000 ms, and returns the same active weapon with damage ×2, configured spread tightening, a full reserve, and the `Über-` prefix.
  - Small magazines measured exactly +100% (Jäger K-8: 5 → 10); large magazines measured exactly +50% (Sturmvogel: 32 → 48). Reload logic uses the upgraded capacity, and upgraded wall ammunition costs exactly 4,500 while leaving the loaded magazine untouched.
  - A round-25 eleven-target bound test proved Blitzwerfer selects and kills no more than ten linked enemies. Its accepted shot consumed one loaded round, awarded ten flat explosive-kill bonuses, and left the eleventh enemy alive.
  - Sonnenpistole tests proved 1,000 direct damage plus radial splash, full-radius lethality, protected outer-radius one-shot behavior, crawler conversion, deterministic falloff, owner self-damage, no friendly-fire path, and flat explosive-kill scoring.
  - `npm run gate:p6:network`: room `AGCG2L` held a two-client exclusive Forge transaction for 3,000 ms, rejected the second purchaser without charging them, synchronized a 10-round upgraded Jäger magazine, measured exactly 190 authoritative body damage, chained through ten round-25 enemies, and synchronized Sonnenpistole self-damage plus ten crawler conversions.
  - P4 and P5 network regressions were rerun against the P6 server. Rooms `PCLGZN` and `3DX6GT` kept every prior door, wall-buy, conventional weapon, crate, grenade, power, perk, Max Ammo, revive, reconnect, roster-lock, and Höllenwölfe contract green.
  - Final production client payload: 816.74 kB JS / 219.82 kB gzip; generated service worker precached the complete static client.
- Browser acceptance:
  - The exact production artifact `index-BGUEw33v.js` loaded seed `12345`, reported PWA cache `ready`, and held 60 FPS with 45 draw calls during the authored round-25 ten-target stress scene.
  - F1 observed `10 / 10 / 0` before firing. One production Blitzwerfer shot changed the state to `10 / 0 / 0`, marked all ten enemies dead, consumed magazine 3 → 2, awarded exactly +500, and entered intermission.
  - The production Forge gate opened all three authored doors, activated shared power, moved to its Catwalk station, debited exactly 5,000, displayed `Forge upgrading`, lowered the Jäger viewmodel into the chamber, and rendered the powered portal, insertion weapon, sparks, and return treatment.
  - Distinct original Blitzwerfer coil and Sonnenpistole pressure-chamber viewmodels, additive lightning links, solar splash geometry, dark etched `Über-` materials, and synchronized Forge state are rendered runtime systems rather than test-only stand-ins.
  - Production diagnostics remained at `Console errors: 0`; server stderr contained no exceptions across P4–P6 network gates.
- Authority evidence: the shared simulator owns Forge spends/jobs, upgrade stats, wall-ammo pricing, wonder targeting, damage, crawler conversion, self-damage, kills, and points. Co-op schema patches expose read-only Forge state; production mutating diagnostics remain rejected server-side.

## P7 — Production audio

Status: passed

- Timestamp: 2026-07-17T16:18:05+10:00
- Implementation commit: `5edc250eb7b03735e8c4cb1549e122273195c56a`
- Browser seed: solo production `12345`; authoritative two-client room `H7WMTE`
- Client count: 2 authoritative clients plus production-browser solo
- Automated checks:
  - `npm run check`: passed with zero TypeScript diagnostics; 11 files / 106 tests passed; the production PWA client and authoritative server built successfully.
  - The audio contract verifies a 48 kHz graph, dynamics-compressor headroom, a strict 56-transient voice ceiling, twelve unique firearm reports and reload-mechanism signatures, five distinct zombie formant families, separate Höllenwölfe synthesis, four original perk jingles, original zombie/wolf/Puppe/round/game-over material, and phoneme-authored calls for all five power-ups.
  - Listener-relative tests passed at zero and 90-degree yaw. Distance rolloff, cross-room low-pass/gain occlusion, and four distinct room reverb sends are numerically covered. The source audit found no `Math.random`, runtime fetch, `Audio` element, external recording, or nondeterministic gameplay dependency.
  - The browser's offline 48 kHz production graph rendered the left/right breach pair with 2.11× left-channel dominance, 2.09× right-channel dominance, and a 0.059 peak under the 0.98 ceiling. This provides a measured blind-localization and non-silence check independent of the embedded browser's muted live-output policy.
  - `npm run gate:p7:network`: room `H7WMTE` delivered authoritative remote melee, Melder fire, weapon-specific reload, enemy species/voice, grenade throw, and post-despawn explosion cues to both clients with exact world coordinates.
  - Isolated regressions passed in P4 room `YK4QJR`, P5 room `P7FEJW`, and P6 room `2HYESM`. One deliberately concurrent four-gate run invalidated the P5 wolf-drain timing sample under shared dev-server load; the immediate isolated rerun completed the 12-wolf round and guaranteed Max Ammo without a code change.
  - Final production client payload: 861.06 kB JS / 231.25 kB gzip; generated service worker precached the complete static client.
- Browser acceptance:
  - The exact production artifact `index-CW7N7SxB.js` loaded seed `12345`, reported PWA cache `ready`, stayed in active round-one play, and held 60 FPS at 40 draw calls with six enemies.
  - F1 reported `48 kHz`, the 56-voice limiter, 4.8 dB nominal bus headroom, per-cue activity, listener room, and `RENDER PASS · L 2.11× · R 2.09× · peak 0.059`. Production console errors remained zero.
  - The in-app verification browser intentionally reports its live `AudioContext` as suspended even after native input because that harness suppresses speaker output; the same shipped context calls `resume()` on native pointer/keyboard input. The production `OfflineAudioContext` rendered the exact cue chain and channel evidence above inside that artifact.
- Mix and sourcing evidence: effects, ambience, music, voice, and UI buses feed a configured compressor; HRTF panners feed generated room convolution; room and wolf transitions ramp without queued automation buildup. Firearms layer transient/body/noise/mechanism components, barriers and mechanisms use deterministic material synthesis, machines emit powered/dead hum plus coded jingles, and all work remains original procedural code documented in `assets/CREDITS.md`.
