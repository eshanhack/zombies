import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';
import { coopZombieCount } from '../src/shared/formulas.js';

interface GateBarrier {
  id: string;
  boards: number;
}

interface GateEnemy {
  id: number;
  state: string;
  speedTier: string;
}

interface GateState {
  seed: number;
  phase: string;
  started: boolean;
  round: number;
  spawned: number;
  queued: number;
  alive: number;
  players: { size: number };
  barriers: {
    size: number;
    forEach(callback: (barrier: GateBarrier, key: string) => void): void;
  };
  enemies: {
    size: number;
    forEach(callback: (enemy: GateEnemy, key: string) => void): void;
  };
}

const endpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const results = [];

for (const rosterSize of [2, 4]) {
  const clients = Array.from({ length: rosterSize }, () => new Client(endpoint));
  const rooms: Room[] = [];
  try {
    const host = await clients[0]!.create('stahlbunker', { name: `P2 Host ${rosterSize}` });
    host.onMessage('runStarted', () => undefined);
    rooms.push(host);
    for (let index = 1; index < rosterSize; index += 1) {
      const room = await clients[index]!.joinById(host.roomId, { name: `P2 Client ${index + 1}` });
      room.onMessage('runStarted', () => undefined);
      rooms.push(room);
    }
    await Promise.all(rooms.map(waitForInitialState));
    host.send('start');
    await waitFor(() => (host.state as GateState).started && (host.state as GateState).round === 1, 3000);
    const initial = host.state as GateState;
    const expected = coopZombieCount(1, rosterSize);
    if (initial.players.size !== rosterSize) throw new Error(`Roster ${rosterSize} was not retained.`);
    if (initial.spawned + initial.queued !== expected) {
      throw new Error(`Roster ${rosterSize} expected ${expected} enemies, got ${initial.spawned + initial.queued}.`);
    }
    if (initial.barriers.size !== 9) throw new Error(`Expected nine synchronized barriers, got ${initial.barriers.size}.`);

    await waitFor(() => (host.state as GateState).alive >= 1, 3000);
    const spawned = host.state as GateState;
    const enemies: GateEnemy[] = [];
    spawned.enemies.forEach((enemy) => enemies.push(enemy));
    if (enemies.some((enemy) => enemy.speedTier !== 'walk')) throw new Error('Round-one co-op spawned a non-walker.');

    const remoteViews = rooms.map((room) => room.state as GateState);
    if (remoteViews.some((state) => state.seed !== spawned.seed || state.round !== spawned.round || state.alive !== spawned.alive)) {
      throw new Error(`Roster ${rosterSize} clients disagreed on synchronized simulation state.`);
    }
    results.push({
      rosterSize,
      roomCode: host.roomId,
      seed: spawned.seed,
      expectedPopulation: expected,
      synchronizedBarriers: spawned.barriers.size,
      synchronizedAlive: spawned.alive,
      round: spawned.round,
      phase: spawned.phase,
    });
  } finally {
    await Promise.allSettled(rooms.map((room) => room.leave(true)));
  }
}

console.log(JSON.stringify({ ok: true, results }, null, 2));

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for authoritative P2 state.');
    await delay(25);
  }
}

async function waitForInitialState(room: Room): Promise<void> {
  if ((room.state as Partial<GateState> | undefined)?.players !== undefined) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`Timed out waiting for state in ${room.roomId}.`)), 3000);
    room.onStateChange.once(() => {
      clearTimeout(timeout);
      resolve();
    });
  });
}
