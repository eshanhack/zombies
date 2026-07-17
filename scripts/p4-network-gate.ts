import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';
import { CRATE_LOCATIONS, WALL_BUYS } from '../src/map/blueprint.js';

interface GateWeapon { id: string; magazine: number; reserve: number }
interface GatePlayer {
  points: number;
  x: number;
  y: number;
  z: number;
  activeWeaponIndex: number;
  grenades: number;
  crateRolls: number;
  weapons: { readonly [index: number]: GateWeapon | undefined; length: number };
}
interface GateState {
  started: boolean;
  cratePhase: string;
  crateLocationId: string;
  crateWeaponId: string;
  openDoors: { readonly [index: number]: string | undefined; length: number };
  players: { get(id: string): GatePlayer | undefined };
}
interface CombatFeedback { accepted: boolean; weaponId: string; magazine: number; reason: string }

const endpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const host = await new Client(endpoint).create('stahlbunker', { name: 'P4 Host' });
const guest = await new Client(endpoint).joinById(host.roomId, { name: 'P4 Guest' });
mark('clients connected');
const hostFeedback: CombatFeedback[] = [];
host.onMessage('combatFeedback', (message: CombatFeedback) => hostFeedback.push(message));
host.onMessage('pointTransaction', () => undefined);
host.onMessage('damageFeedback', () => undefined);
host.onMessage('gateAck', () => undefined);
host.onMessage('runStarted', () => undefined);
host.onMessage('gameEvent', () => undefined);
guest.onMessage('combatFeedback', () => undefined);
guest.onMessage('pointTransaction', () => undefined);
guest.onMessage('damageFeedback', () => undefined);
guest.onMessage('gateAck', () => undefined);
guest.onMessage('runStarted', () => undefined);
guest.onMessage('gameEvent', () => undefined);

try {
  await waitFor(() => player(host, guest.sessionId) !== undefined, 3000);
  host.send('start');
  await waitFor(() => state(host).started, 3000);
  mark('room started');
  gate(host, { type: 'grantPoints' });
  gate(guest, { type: 'grantPoints' });
  await waitFor(() => player(host, host.sessionId)!.points === CONFIG.points.starting + CONFIG.debug.gatePointGrant
    && player(host, guest.sessionId)!.points === CONFIG.points.starting + CONFIG.debug.gatePointGrant, 2000);

  gate(host, { type: 'teleport', x: -5.2, y: 0, z: 5.5 });
  gate(guest, { type: 'teleport', x: -5.2, y: 0, z: 5.5 });
  await waitFor(() => Math.abs(player(host, host.sessionId)!.z - 5.5) < 0.1 && Math.abs(player(host, guest.sessionId)!.z - 5.5) < 0.1, 2000);
  host.send('action', { type: 'interact', held: true });
  guest.send('action', { type: 'interact', held: true });
  await delay(CONFIG.controller.interactionHoldMs + 650);
  host.send('action', { type: 'interact', held: false });
  guest.send('action', { type: 'interact', held: false });
  await waitFor(() => doors(host).includes('doorA'), 2000);
  mark('simultaneous door resolved');
  const doorBalances = [player(host, host.sessionId)!.points, player(host, guest.sessionId)!.points].sort((left, right) => left - right);
  const fullBalance = CONFIG.points.starting + CONFIG.debug.gatePointGrant;
  if (JSON.stringify(doorBalances) !== JSON.stringify([fullBalance - CONFIG.economy.doorCosts[0], fullBalance])) {
    throw new Error(`Simultaneous door balances were ${JSON.stringify(doorBalances)}.`);
  }

  const buyer = player(host, host.sessionId)!.points < player(host, guest.sessionId)!.points ? host : guest;
  const jaegerWall = WALL_BUYS.find((wall) => wall.id === 'wall-jaeger')!;
  gate(buyer, { type: 'teleport', x: jaegerWall.x, y: 0, z: jaegerWall.z });
  await waitFor(() => Math.abs(player(host, buyer.sessionId)!.x - jaegerWall.x) < 0.1, 2000);
  const wallBalance = player(host, buyer.sessionId)!.points;
  buyer.send('action', { type: 'interact', held: true });
  await delay(CONFIG.controller.interactionHoldMs + 650);
  buyer.send('action', { type: 'interact', held: false });
  await waitFor(() => weapons(player(host, buyer.sessionId)!).includes('jaeger'), 2000);
  mark('wall weapon purchased');
  if (player(host, buyer.sessionId)!.points !== wallBalance - CONFIG.weapons.jaeger.cost) throw new Error('Wall weapon price did not synchronize.');

  const conventional = ['melder', 'jaeger', 'kurier', 'sturmvogel', 'doppelhieb', 'lasttraeger', 'richter', 'grabenfeger', 'fernblick', 'kettenhund'] as const;
  const arsenal: Array<{ weaponId: string; before: number; after: number }> = [];
  for (const weaponId of conventional) {
    gate(host, { type: 'grantWeapon', weaponId });
    await waitFor(() => activeWeapon(player(host, host.sessionId)!)?.id === weaponId, 2000);
    const before = activeWeapon(player(host, host.sessionId)!)!.magazine;
    const feedbackIndex = hostFeedback.length;
    host.send('action', { type: 'fire', ads: true });
    await waitFor(() => hostFeedback.length > feedbackIndex, 2000);
    const feedback = hostFeedback[feedbackIndex]!;
    if (!feedback.accepted || feedback.weaponId !== weaponId) throw new Error(`${weaponId} rejected over the network: ${JSON.stringify(feedback)}.`);
    await waitFor(() => activeWeapon(player(host, host.sessionId)!)!.magazine === before - 1, 2000);
    arsenal.push({ weaponId, before, after: before - 1 });
    mark(`fired ${weaponId}`);
  }

  const crate = CRATE_LOCATIONS.find((location) => location.id === CONFIG.mysteryCrate.startingLocationId)!;
  gate(host, { type: 'teleport', x: crate.x, y: crate.y, z: crate.z });
  gate(guest, { type: 'teleport', x: crate.x, y: crate.y, z: crate.z });
  await waitFor(() => Math.abs(player(host, host.sessionId)!.x - crate.x) < 0.1 && Math.abs(player(host, guest.sessionId)!.x - crate.x) < 0.1, 2000);
  const crateBuyerBefore = player(host, host.sessionId)!.points;
  const rivalBefore = player(host, guest.sessionId)!.points;
  host.send('action', { type: 'interact', held: true });
  await delay(CONFIG.controller.interactionHoldMs + 650);
  host.send('action', { type: 'interact', held: false });
  await waitFor(() => state(host).cratePhase === 'spinning', 2000);
  if (player(host, host.sessionId)!.points !== crateBuyerBefore - CONFIG.economy.mysteryCrate) throw new Error('Crate purchaser was not charged exactly 950.');
  guest.send('action', { type: 'interact', held: true });
  await delay(CONFIG.controller.interactionHoldMs + 650);
  guest.send('action', { type: 'interact', held: false });
  if (player(host, guest.sessionId)!.points !== rivalBefore) throw new Error('Crate rival was charged during an exclusive spin.');
  await waitFor(() => state(host).cratePhase !== 'spinning', CONFIG.mysteryCrate.spinMs + 2000);
  mark('crate settled');
  const crateOutcome = state(host).cratePhase === 'available' ? state(host).crateWeaponId : 'puppe';
  if (state(host).cratePhase === 'available') {
    host.send('action', { type: 'interact', held: true });
    await delay(CONFIG.controller.interactionHoldMs + 650);
    host.send('action', { type: 'interact', held: false });
    await waitFor(() => state(host).cratePhase === 'closed', 2000);
  } else if (player(host, host.sessionId)!.points !== crateBuyerBefore) {
    throw new Error('Puppe did not refund the purchaser exactly.');
  }
  if (player(host, host.sessionId)!.crateRolls !== 1) throw new Error('Crate roll statistic did not synchronize.');

  const grenadesBefore = player(host, host.sessionId)!.grenades;
  host.send('action', { type: 'grenade', cookedMs: 0 });
  await waitFor(() => player(host, host.sessionId)!.grenades === grenadesBefore - 1, 2000);
  mark('grenade synchronized');

  console.log(JSON.stringify({
    ok: true,
    roomCode: host.roomId,
    simultaneousDoorBalances: doorBalances,
    arsenal,
    crateOutcome,
    crateExclusive: player(host, guest.sessionId)!.points === rivalBefore,
    grenadeCount: player(host, host.sessionId)!.grenades,
  }, null, 2));
} finally {
  await Promise.race([Promise.allSettled([host.leave(true), guest.leave(true)]), delay(1000)]);
}

function state(room: Room): GateState {
  return room.state as GateState;
}

function player(room: Room, id: string): GatePlayer | undefined {
  return state(room).players.get(id);
}

function weapons(value: GatePlayer): string[] {
  return Array.from({ length: value.weapons.length }, (_, index) => value.weapons[index]?.id ?? '');
}

function activeWeapon(value: GatePlayer): GateWeapon | undefined {
  return value.weapons[value.activeWeaponIndex];
}

function doors(room: Room): string[] {
  const collection = state(room).openDoors;
  return Array.from({ length: collection.length }, (_, index) => collection[index] ?? '');
}

function gate(room: Room, message: { type: 'grantPoints' | 'teleport' | 'grantWeapon'; x?: number; y?: number; z?: number; weaponId?: string }): void {
  room.send('gate', { version: CONFIG.debug.apiVersion, ...message });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for the P4 network gate.');
    await delay(20);
  }
}

function mark(message: string): void {
  process.stderr.write(`[p4-network] ${message}\n`);
}
