import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';
import { FORGE } from '../src/map/blueprint.js';

interface GateWeapon { id: string; magazine: number; reserve: number; upgraded: boolean }
interface GatePlayer {
  x: number;
  y: number;
  z: number;
  points: number;
  hp: number;
  lastProcessedInput: number;
  activeWeaponIndex: number;
  weapons: { readonly [index: number]: GateWeapon | undefined; length: number };
}
interface GateEnemy { id: number; kind: string; state: string; x: number; y: number; z: number; hp: number }
interface GateState {
  started: boolean;
  round: number;
  alive: number;
  powerOn: boolean;
  forgePhase: string;
  forgePlayerId: string;
  forgeWeaponId: string;
  forgeRemainingMs: number;
  players: { get(id: string): GatePlayer | undefined };
  enemies: { forEach(callback: (enemy: GateEnemy, key: string) => void): void };
}
interface CombatFeedback {
  source: string;
  accepted: boolean;
  weaponId: string;
  hit: boolean;
  headshot: boolean;
  killed: boolean;
  pelletHits: number;
  damage: number;
  points: number;
  affectedEnemyIds: number[];
}
type GateType = 'grantPoints' | 'teleport' | 'grantWeapon' | 'setPower' | 'openDoors' | 'spawnWonderPack' | 'aimNearest';
interface GateRequest { type: GateType; x?: number; y?: number; z?: number; weaponId?: string; hitbox?: 'body' | 'head' }

const endpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const host = await new Client(endpoint).create('stahlbunker', { name: 'P6 Host' });
const guest = await new Client(endpoint).joinById(host.roomId, { name: 'P6 Guest' });
const feedback: CombatFeedback[] = [];
const damageFeedback: number[] = [];
installHandlers(host, feedback, damageFeedback);
installHandlers(guest, [], []);

try {
  await waitFor(() => state(host).players.get(guest.sessionId) !== undefined, 3_000);
  host.send('start');
  await waitFor(() => state(host).started, 3_000);
  mark('two-client authoritative room started');

  gate(host, { type: 'grantPoints' });
  gate(host, { type: 'openDoors' });
  gate(host, { type: 'setPower' });
  gate(host, { type: 'grantWeapon', weaponId: 'jaeger' });
  gate(host, { type: 'teleport', x: FORGE.x, y: FORGE.y, z: FORGE.z });
  gate(guest, { type: 'teleport', x: FORGE.x + 0.35, y: FORGE.y, z: FORGE.z });
  await waitFor(() => state(host).powerOn && activeWeapon(host)?.id === 'jaeger', 2_000);
  const ownerPointsBefore = localPlayer(host).points;
  const guestPointsBefore = state(host).players.get(guest.sessionId)!.points;
  host.send('action', { type: 'interact', held: true });
  await waitFor(() => state(host).forgePhase === 'upgrading', 2_000);
  host.send('action', { type: 'interact', held: false });
  guest.send('action', { type: 'interact', held: true });
  await delay(CONFIG.controller.interactionHoldMs + 120);
  guest.send('action', { type: 'interact', held: false });
  if (state(host).forgePlayerId !== host.sessionId || state(host).forgeWeaponId !== 'jaeger') {
    throw new Error('The globally exclusive Forge owner changed during the transaction.');
  }
  if (state(host).players.get(guest.sessionId)!.points !== guestPointsBefore) throw new Error('A second client paid into an occupied Forge.');
  if (localPlayer(host).points !== ownerPointsBefore - CONFIG.economy.forgeUpgrade) throw new Error('Forge did not debit exactly 5000 points.');
  await waitFor(() => state(host).forgePhase === 'idle' && activeWeapon(host)?.upgraded === true, CONFIG.forge.animationMs + 1_500);
  const forged = activeWeapon(host)!;
  if (forged.magazine !== CONFIG.weapons.jaeger.magazine * CONFIG.forge.smallMagazineMultiplier
    || forged.reserve !== CONFIG.weapons.jaeger.reserve) throw new Error('Forge capacity or reserve refill was incorrect.');
  const forgedMagazineCapacity = forged.magazine;
  mark('exclusive 3-second Forge transaction synchronized');

  gate(host, { type: 'teleport', x: 0, y: 0, z: 0 });
  await waitFor(() => Math.abs(localPlayer(host).z) < 0.01, 2_000);
  gate(host, { type: 'spawnWonderPack' });
  await waitFor(() => enemies(host).filter((enemy) => enemy.state !== 'dead').length === CONFIG.debug.wonderPackCount, 2_000);
  gate(host, { type: 'aimNearest', hitbox: 'body' });
  await delay(30);
  host.send('action', { type: 'fire', ads: true });
  await waitFor(() => feedback.length >= 1, 2_000);
  const doubled = feedback.at(-1)!;
  if (!doubled.accepted || !doubled.hit || doubled.headshot
    || doubled.damage !== CONFIG.weapons.jaeger.damage * CONFIG.forge.damageMultiplier) {
    throw new Error(`Authoritative upgraded damage was not exactly doubled: ${JSON.stringify(doubled)}.`);
  }
  mark('authoritative upgraded damage measured at exactly 2x');

  gate(host, { type: 'grantWeapon', weaponId: 'blitzwerfer' });
  gate(host, { type: 'spawnWonderPack' });
  await waitFor(() => state(host).round === CONFIG.debug.wonderGateRound
    && enemies(host).filter((enemy) => enemy.state !== 'dead').length === CONFIG.debug.wonderPackCount, 2_000);
  gate(host, { type: 'aimNearest', hitbox: 'head' });
  await delay(30);
  host.send('action', { type: 'fire', ads: true });
  await waitFor(() => feedback.length >= 2, 2_000);
  const lightning = feedback.at(-1)!;
  if (!lightning.accepted || lightning.weaponId !== 'blitzwerfer' || lightning.pelletHits !== CONFIG.wonder.blitzChainTargets
    || lightning.affectedEnemyIds.length !== CONFIG.wonder.blitzChainTargets) {
    throw new Error(`Blitzwerfer did not chain through ten targets: ${JSON.stringify(lightning)}.`);
  }
  await waitFor(() => state(host).alive === 0, 2_000);
  mark('round-25 Blitzwerfer ten-target chain synchronized');

  gate(host, { type: 'grantWeapon', weaponId: 'sonnenpistole' });
  gate(host, { type: 'spawnWonderPack' });
  await waitFor(() => enemies(host).filter((enemy) => enemy.state !== 'dead').length === CONFIG.debug.wonderPackCount, 2_000);
  const hpBeforeSun = localPlayer(host).hp;
  gate(host, { type: 'aimNearest', hitbox: 'body' });
  await delay(30);
  host.send('action', { type: 'fire', ads: true });
  await waitFor(() => feedback.length >= 3 && localPlayer(host).hp < hpBeforeSun, 2_000);
  const sun = feedback.at(-1)!;
  if (!sun.accepted || sun.weaponId !== 'sonnenpistole' || !sun.hit) throw new Error('Sonnenpistole shot was not authoritative.');
  if (!enemies(host).some((enemy) => enemy.kind === 'crawler')) throw new Error('Sonnenpistole outer splash did not create crawlers.');
  await waitFor(() => damageFeedback.length > 0, 2_000);
  mark('Sonnenpistole splash, crawler conversion, and self-damage synchronized');

  console.log(JSON.stringify({
    ok: true,
    roomCode: host.roomId,
    forgeCost: CONFIG.economy.forgeUpgrade,
    forgeDurationMs: CONFIG.forge.animationMs,
    upgradedMagazine: forgedMagazineCapacity,
    upgradedDamage: doubled.damage,
    blitzRound: state(host).round,
    blitzTargets: lightning.affectedEnemyIds.length,
    sunSelfDamage: hpBeforeSun - localPlayer(host).hp,
    sunCrawlerCount: enemies(host).filter((enemy) => enemy.kind === 'crawler').length,
  }, null, 2));
} finally {
  await Promise.race([Promise.allSettled([host.leave(true), guest.leave(true)]), delay(1_500)]);
}

function installHandlers(room: Room, combat: CombatFeedback[], damage: number[]): void {
  room.onMessage('combatFeedback', (message: CombatFeedback) => combat.push(message));
  room.onMessage('damageFeedback', (message: { amount: number }) => damage.push(message.amount));
  room.onMessage('pointTransaction', () => undefined);
  room.onMessage('reloadFeedback', () => undefined);
  room.onMessage('gateAck', () => undefined);
  room.onMessage('runStarted', () => undefined);
  room.onMessage('gameEvent', () => undefined);
}

function state(room: Room): GateState {
  return room.state as GateState;
}

function localPlayer(room: Room): GatePlayer {
  const value = state(room).players.get(room.sessionId);
  if (value === undefined) throw new Error('Local authoritative player is missing.');
  return value;
}

function activeWeapon(room: Room): GateWeapon | undefined {
  const value = localPlayer(room);
  return value.weapons[value.activeWeaponIndex];
}

function enemies(room: Room): GateEnemy[] {
  const values: GateEnemy[] = [];
  state(room).enemies.forEach((enemy) => values.push(enemy));
  return values;
}

function gate(room: Room, request: GateRequest): void {
  room.send('gate', { version: CONFIG.debug.apiVersion, ...request });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for the P6 network gate.');
    await delay(20);
  }
}

function mark(message: string): void {
  process.stderr.write(`[p6-network] ${message}\n`);
}
