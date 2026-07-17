import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';

interface GateWeapon { id: string; magazine: number; reserve: number }
interface GatePlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  points: number;
  lastProcessedInput: number;
  reloading: boolean;
  weapons: { readonly [index: number]: GateWeapon | undefined };
}
interface GateEnemy { id: number; x: number; y: number; z: number; hp: number; state: string }
interface GateState {
  started: boolean;
  round: number;
  simulationTimeMs: number;
  players: { get(id: string): GatePlayer | undefined };
  enemies: { forEach(callback: (enemy: GateEnemy, key: string) => void): void };
}
interface CombatFeedback {
  source: 'fire' | 'melee';
  accepted: boolean;
  hit: boolean;
  killed: boolean;
  headshot?: boolean;
  points: number;
  damage: number;
  enemyId: number | null;
}

const endpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const body = await runBulletGate('body');
const head = await runBulletGate('head');
const melee = await runMeleeGate();
console.log(JSON.stringify({ ok: true, body, head, melee }, null, 2));

async function runBulletGate(hitbox: 'body' | 'head'): Promise<object> {
  const gate = await createGateRoom(`P3 ${hitbox}`);
  try {
    const enemy = await waitForEnemy(gate.room, (candidate) => candidate.state === 'tear');
    const aimHeight = hitbox === 'head' ? CONFIG.combat.headCenterHeightM : 1;
    let sequence = 1;
    await aimAt(gate.room, enemy, aimHeight, sequence);
    const expectedShots = hitbox === 'head' ? 2 : 5;
    for (let shot = 0; shot < expectedShots; shot += 1) {
      const before = gate.feedback.length;
      gate.room.send('action', { type: 'fire', ads: true });
      await waitFor(() => gate.feedback.length === before + 1, 2000);
      if (shot + 1 < expectedShots) {
        const firedAt = (gate.room.state as GateState).simulationTimeMs;
        await waitFor(() => (gate.room.state as GateState).simulationTimeMs >= firedAt + 60000 / CONFIG.weapons.melder.rpm + 20, 2000);
      }
    }
    const points = gate.feedback.map((entry) => entry.points);
    const expectedPoints = hitbox === 'head' ? [10, 100] : [10, 10, 10, 10, 60];
    if (JSON.stringify(points) !== JSON.stringify(expectedPoints)) throw new Error(`${hitbox} point sequence ${JSON.stringify(points)} did not equal ${JSON.stringify(expectedPoints)}: ${JSON.stringify(gate.feedback)}.`);
    if (gate.feedback.some((entry) => !entry.accepted || !entry.hit)) throw new Error(`${hitbox} gate contained a rejected or missed shot.`);
    const expectedTotal = CONFIG.points.starting + expectedPoints.reduce((sum, amount) => sum + amount, 0);
    await waitFor(() => playerFor(gate.room).points === expectedTotal, 2000);
    const final = playerFor(gate.room);
    if (final.points !== expectedTotal) throw new Error(`${hitbox} authoritative points were ${final.points}, expected ${expectedTotal}.`);
    const weapon = final.weapons[0];
    if (weapon?.magazine !== CONFIG.weapons.melder.magazine - expectedShots) throw new Error(`${hitbox} magazine did not synchronize.`);

    if (hitbox === 'body') {
      const reloadBefore = gate.reloads.length;
      gate.room.send('action', { type: 'reload' });
      await waitFor(() => gate.reloads.length === reloadBefore + 1 && playerFor(gate.room).reloading, 2000);
      await waitFor(() => !playerFor(gate.room).reloading, CONFIG.weapons.melder.reloadMs + 1000);
      const loaded = playerFor(gate.room).weapons[0];
      if (loaded?.magazine !== CONFIG.weapons.melder.magazine || loaded.reserve !== CONFIG.weapons.melder.reserve - expectedShots) {
        throw new Error(`Reload state was ${loaded?.magazine}/${loaded?.reserve}.`);
      }
    }
    return {
      roomCode: gate.room.roomId,
      hitbox,
      transactions: points,
      finalPoints: final.points,
      headshotKill: gate.feedback.at(-1)?.headshot === true,
      finalDamage: gate.feedback.at(-1)?.damage,
    };
  } finally {
    await gate.room.leave(true);
  }
}

async function runMeleeGate(): Promise<object> {
  const gate = await createGateRoom('P3 melee');
  try {
    let enemy = await waitForEnemy(gate.room, () => true);
    let sequence = 1;
    for (; sequence <= 75; sequence += 1) {
      const player = playerFor(gate.room);
      enemy = firstAliveEnemy(gate.room) ?? enemy;
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      const distance = Math.hypot(dx, enemy.y - player.y, dz);
      const yaw = Math.atan2(-dx, -dz);
      gate.room.send('input', movement(sequence, yaw, 0, distance > CONFIG.melee.rangeM ? 1 : 0));
      await delay(1000 / CONFIG.coop.inputHz);
      if (distance <= CONFIG.melee.lungeRangeM) break;
    }
    const player = playerFor(gate.room);
    const dx = enemy.x - player.x;
    const dz = enemy.z - player.z;
    const yaw = Math.atan2(-dx, -dz);
    sequence += 1;
    gate.room.send('input', movement(sequence, yaw, 0, 0));
    await waitFor(() => playerFor(gate.room).lastProcessedInput >= sequence, 2000);
    gate.room.send('action', { type: 'melee' });
    await waitFor(() => gate.feedback.length >= 1, 2000);
    const result = gate.feedback[0]!;
    if (!result.accepted || !result.hit || !result.killed || result.damage !== CONFIG.melee.damage || result.points !== CONFIG.points.killMelee) {
      throw new Error(`Authoritative melee failed: ${JSON.stringify(result)}.`);
    }
    await waitFor(() => playerFor(gate.room).points === CONFIG.points.starting + CONFIG.points.killMelee, 2000);
    return { roomCode: gate.room.roomId, transaction: result.points, damage: result.damage, killed: result.killed };
  } finally {
    await gate.room.leave(true);
  }
}

async function createGateRoom(name: string): Promise<{ room: Room; feedback: CombatFeedback[]; reloads: Array<{ accepted: boolean }> }> {
  const room = await new Client(endpoint).create('stahlbunker', { name });
  const feedback: CombatFeedback[] = [];
  const reloads: Array<{ accepted: boolean }> = [];
  room.onMessage('runStarted', () => undefined);
  room.onMessage('combatFeedback', (message: CombatFeedback) => feedback.push(message));
  room.onMessage('reloadFeedback', (message: { accepted: boolean }) => reloads.push(message));
  room.onMessage('pointTransaction', () => undefined);
  room.onMessage('damageFeedback', () => undefined);
  await waitFor(() => (room.state as Partial<GateState>).players !== undefined, 3000);
  room.send('start');
  await waitFor(() => (room.state as GateState).started && (room.state as GateState).round === 1, 3000);
  return { room, feedback, reloads };
}

async function waitForEnemy(room: Room, predicate: (enemy: GateEnemy) => boolean): Promise<GateEnemy> {
  let selected: GateEnemy | undefined;
  await waitFor(() => {
    selected = firstAliveEnemy(room, predicate);
    return selected !== undefined;
  }, 5000);
  return selected!;
}

function firstAliveEnemy(room: Room, predicate: (enemy: GateEnemy) => boolean = () => true): GateEnemy | undefined {
  let selected: GateEnemy | undefined;
  (room.state as GateState).enemies.forEach((enemy) => {
    if (selected === undefined && enemy.state !== 'dead' && predicate(enemy)) selected = enemy;
  });
  return selected;
}

async function aimAt(room: Room, enemy: GateEnemy, targetHeight: number, sequence: number): Promise<void> {
  const player = playerFor(room);
  const dx = enemy.x - player.x;
  const dz = enemy.z - player.z;
  const distance = Math.hypot(dx, dz);
  const yaw = Math.atan2(-dx, -dz);
  const pitch = Math.atan2(enemy.y + targetHeight - (player.y + CONFIG.controller.eyeHeightM), distance);
  room.send('input', movement(sequence, yaw, pitch, 0, true));
  await waitFor(() => playerFor(room).lastProcessedInput >= sequence, 2000);
}

function movement(sequence: number, yaw: number, pitch: number, forward: number, ads = false): object {
  return { sequence, forward, right: 0, yaw, pitch, sprint: forward > 0, ads, ascend: false, descend: false };
}

function playerFor(room: Room): GatePlayer {
  const player = (room.state as GateState).players.get(room.sessionId);
  if (player === undefined) throw new Error('Local authoritative player is missing.');
  return player;
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start >= timeoutMs) throw new Error('Timed out waiting for P3 authoritative state.');
    await delay(20);
  }
}
