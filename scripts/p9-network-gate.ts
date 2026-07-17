import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';
import { DOORS } from '../src/map/blueprint.js';
import { coopZombieCount, wolfCount } from '../src/shared/formulas.js';

interface GateWeapon { id: string; magazine: number; reserve: number }
interface GatePlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  points: number;
  hp: number;
  maxHp: number;
  connected: boolean;
  downed: boolean;
  dead: boolean;
  spectating: boolean;
  lastProcessedInput: number;
  activeWeaponIndex: number;
  weapons: { readonly [index: number]: GateWeapon | undefined; length: number };
}
interface GateState {
  protocolVersion: number;
  started: boolean;
  phase: string;
  round: number;
  roundKind: string;
  wolfAppearance: number;
  spawned: number;
  queued: number;
  alive: number;
  simulationTimeMs: number;
  gameOver: boolean;
  players: {
    size: number;
    get(id: string): GatePlayer | undefined;
    forEach(callback: (player: GatePlayer, key: string) => void): void;
  };
  openDoors: { forEach(callback: (doorId: string) => void): void };
}
interface CombatFeedback {
  accepted: boolean;
  hit: boolean;
  rewindAppliedMs?: number;
}
interface PopulationResult {
  round: number;
  kind: string;
  count: number;
  peakCap: number;
}

const endpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const twoPlayer = await runPopulationProgression(2);
const fourPlayer = await runPopulationProgression(4);
const adversarial = await runAdversarialSession();

console.log(JSON.stringify({
  ok: true,
  protocolVersion: CONFIG.coop.protocolVersion,
  twoPlayer,
  fourPlayer,
  adversarial,
}, null, 2));

async function runPopulationProgression(rosterSize: number): Promise<{ roomCode: string; rounds: PopulationResult[] }> {
  const rooms: Room[] = [];
  try {
    const host = await new Client(endpoint).create('stahlbunker', { name: `P9 ${rosterSize}P Host` });
    rooms.push(host);
    installHandlers(host);
    for (let index = 1; index < rosterSize; index += 1) {
      const room = await new Client(endpoint).joinById(host.roomId, { name: `P9 ${rosterSize}P ${index + 1}` });
      installHandlers(room);
      rooms.push(room);
    }
    await waitFor(() => state(host).players.size === rosterSize, 4000);
    if (state(host).protocolVersion !== CONFIG.coop.protocolVersion) throw new Error('Protocol version did not synchronize.');
    host.send('start');
    await waitFor(() => state(host).started, 4000);

    const rounds: PopulationResult[] = [];
    for (let round = 1; round <= 10; round += 1) {
      gate(host, { type: 'startRound', round });
      await waitFor(() => state(host).round === round && state(host).spawned + state(host).queued > 0, 3000);
      const view = state(host);
      const count = view.spawned + view.queued;
      const expected = view.roundKind === 'wolves'
        ? wolfCount(view.wolfAppearance, rosterSize)
        : coopZombieCount(round, rosterSize);
      if (count !== expected) throw new Error(`${rosterSize}P round ${round} expected ${expected}, received ${count}.`);
      const peakCap = view.roundKind === 'wolves'
        ? Math.min(CONFIG.zombie.maxAlive, CONFIG.wolves.maxActivePerPlayer * rosterSize)
        : CONFIG.zombie.maxAlive;
      if (view.alive > peakCap) throw new Error(`${rosterSize}P round ${round} exceeded active cap ${peakCap}.`);
      rounds.push({ round, kind: view.roundKind, count, peakCap });
    }
    return { roomCode: host.roomId, rounds };
  } finally {
    await Promise.race([Promise.allSettled(rooms.map((room) => room.leave(true))), delay(2000)]);
  }
}

async function runAdversarialSession(): Promise<Record<string, unknown>> {
  const rooms: Room[] = [];
  const feedback: CombatFeedback[] = [];
  try {
    const host = await new Client(endpoint).create('stahlbunker', { name: 'P9 Adversarial Host' });
    rooms.push(host);
    installHandlers(host, feedback);
    for (let index = 1; index < CONFIG.coop.maxPlayers; index += 1) {
      const room = await new Client(endpoint).joinById(host.roomId, { name: `P9 Adversarial ${index + 1}` });
      installHandlers(room);
      rooms.push(room);
    }
    await waitFor(() => state(host).players.size === CONFIG.coop.maxPlayers, 4000);
    host.send('start');
    await waitFor(() => state(host).started, 4000);

    const initial = requiredPlayer(host, host.sessionId);
    const initialX = initial.x;
    const initialZ = initial.z;
    sendInput(host, 1, 1, 0);
    await delay(72);
    sendInput(host, 2, 1, 0);
    await delay(118);
    sendInput(host, 4, 1, 0);
    sendInput(host, 4, -1, 1);
    await delay(164);
    sendInput(host, 5, 0, 0);
    await waitFor(() => requiredPlayer(host, host.sessionId).lastProcessedInput === 5, 3000);
    await delay(180);
    const moved = requiredPlayer(host, host.sessionId);
    const traveledM = initialZ - moved.z;
    const lateralDriftM = Math.abs(moved.x - initialX);
    if (traveledM <= 0.1 || traveledM > CONFIG.player.walkSpeed * CONFIG.player.sprintMultiplier * 1.2) {
      throw new Error(`Jittered movement traveled an invalid ${traveledM.toFixed(3)}m.`);
    }
    if (lateralDriftM > 0.08) throw new Error(`Duplicate input produced ${lateralDriftM.toFixed(3)}m lateral drift.`);

    gate(host, { type: 'spawnWonderPack' });
    await waitFor(() => state(host).alive === CONFIG.debug.wonderPackCount, 3000);
    gate(host, { type: 'aimNearest', hitbox: 'body' });
    await delay(80);
    const shooter = requiredPlayer(host, host.sessionId);
    const magazineBefore = activeWeapon(shooter)?.magazine ?? 0;
    const duplicatedAction = {
      type: 'fire',
      sequence: 1,
      ads: true,
      simulationTimeMs: state(host).simulationTimeMs,
      yaw: shooter.yaw,
      pitch: shooter.pitch,
    };
    host.send('action', duplicatedAction);
    host.send('action', duplicatedAction);
    await waitFor(() => feedback.length === 1, 3000);
    await delay(120);
    if (feedback.length !== 1) throw new Error(`Duplicate action produced ${feedback.length} feedback messages.`);
    if ((activeWeapon(requiredPlayer(host, host.sessionId))?.magazine ?? 0) !== magazineBefore - 1) {
      throw new Error('Duplicate fire action consumed more than one loaded round.');
    }

    await delay(60000 / CONFIG.weapons.melder.rpm + 80);
    gate(host, { type: 'aimNearest', hitbox: 'body' });
    await delay(80);
    const rewoundShooter = requiredPlayer(host, host.sessionId);
    host.send('action', {
      type: 'fire',
      sequence: 2,
      ads: true,
      simulationTimeMs: state(host).simulationTimeMs - 150,
      yaw: rewoundShooter.yaw,
      pitch: rewoundShooter.pitch,
    });
    await waitFor(() => feedback.length === 2, 3000);
    const rewindAppliedMs = feedback[1]?.rewindAppliedMs ?? -1;
    if (rewindAppliedMs < 100 || rewindAppliedMs > CONFIG.coop.rewindMs) {
      throw new Error(`Server rewind was outside the 200ms window: ${rewindAppliedMs}ms.`);
    }

    gate(host, { type: 'killAll' });
    const door = DOORS[0]!;
    const doorX = (door.collider.minX + door.collider.maxX) * 0.5;
    const doorZ = (door.collider.minZ + door.collider.maxZ) * 0.5;
    for (const room of rooms.slice(0, 2)) {
      gate(room, { type: 'grantPoints' });
      gate(room, { type: 'teleport', x: doorX, y: 0, z: doorZ });
    }
    await delay(100);
    const pointsBeforeDoor = rooms.slice(0, 2).map((room) => requiredPlayer(host, room.sessionId).points);
    host.send('action', { type: 'interact', sequence: 3, held: true });
    rooms[1]!.send('action', { type: 'interact', sequence: 1, held: true });
    await delay(CONFIG.controller.interactionHoldMs + 650);
    host.send('action', { type: 'interact', sequence: 4, held: false });
    rooms[1]!.send('action', { type: 'interact', sequence: 2, held: false });
    await waitFor(() => openDoors(host).includes(door.id), 3000);
    const pointsAfterDoor = rooms.slice(0, 2).map((room) => requiredPlayer(host, room.sessionId).points);
    if (pointsAfterDoor[0]! + pointsAfterDoor[1]! !== pointsBeforeDoor[0]! + pointsBeforeDoor[1]! - door.cost) {
      throw new Error('Simultaneous door interaction did not resolve to one authoritative spend.');
    }

    for (const room of rooms) gate(room, { type: 'damage', damage: CONFIG.zombie.hitDamage });
    await delay(CONFIG.player.postHitInvulnMs + 60);
    for (const room of rooms) gate(room, { type: 'damage', damage: CONFIG.zombie.hitDamage });
    await waitFor(() => state(host).gameOver, 3000);
    const lifeStates = rooms.map((room) => {
      const value = requiredPlayer(host, room.sessionId);
      return { downed: value.downed, dead: value.dead };
    });
    if (!lifeStates.every((life) => life.downed || life.dead)) throw new Error('Full-team down left an active player.');

    return {
      roomCode: host.roomId,
      traveledM: Number(traveledM.toFixed(3)),
      lateralDriftM: Number(lateralDriftM.toFixed(3)),
      duplicateInputRejected: true,
      duplicateActionFeedbackCount: feedback.length - 1,
      rewindAppliedMs,
      simultaneousDoorBalances: pointsAfterDoor,
      fullTeamGameOver: state(host).gameOver,
    };
  } finally {
    await Promise.race([Promise.allSettled(rooms.map((room) => room.leave(true))), delay(2000)]);
  }
}

function installHandlers(room: Room, feedback?: CombatFeedback[]): void {
  room.onMessage('combatFeedback', (message: CombatFeedback) => feedback?.push(message));
  room.onMessage('pointTransaction', () => undefined);
  room.onMessage('damageFeedback', () => undefined);
  room.onMessage('reloadFeedback', () => undefined);
  room.onMessage('gateAck', () => undefined);
  room.onMessage('runStarted', () => undefined);
  room.onMessage('gameEvent', () => undefined);
}

function sendInput(room: Room, sequence: number, forward: number, right: number): void {
  room.send('input', {
    sequence,
    forward,
    right,
    yaw: 0,
    pitch: 0,
    sprint: false,
    ads: false,
    ascend: false,
    descend: false,
  });
}

function gate(room: Room, request: Record<string, unknown>): void {
  room.send('gate', { version: CONFIG.debug.apiVersion, ...request });
}

function state(room: Room): GateState {
  return room.state as GateState;
}

function requiredPlayer(room: Room, id: string): GatePlayer {
  const value = state(room).players.get(id);
  if (value === undefined) throw new Error(`Missing player ${id}.`);
  return value;
}

function activeWeapon(player: GatePlayer): GateWeapon | undefined {
  return player.weapons[player.activeWeaponIndex];
}

function openDoors(room: Room): string[] {
  const values: string[] = [];
  state(room).openDoors.forEach((doorId) => values.push(doorId));
  return values;
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out after ${timeoutMs}ms.`);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
