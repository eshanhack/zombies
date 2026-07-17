import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';

interface GatePlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  staminaMs: number;
  lastProcessedInput: number;
}

interface GateState {
  seed: number;
  started: boolean;
  players: {
    size: number;
    get(id: string): GatePlayer | undefined;
  };
}

const endpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const clients = Array.from({ length: CONFIG.coop.maxPlayers }, () => new Client(endpoint));
const rooms: Room[] = [];

try {
  const host = await clients[0]!.create('stahlbunker', { name: 'Gate Host' });
  rooms.push(host);
  host.onMessage('runStarted', () => undefined);
  for (let index = 1; index < clients.length; index += 1) {
    const room = await clients[index]!.joinById(host.roomId, { name: `Gate Client ${index + 1}` });
    room.onMessage('runStarted', () => undefined);
    rooms.push(room);
  }
  await Promise.all(rooms.map(waitForInitialState));

  const initial = rooms.map((room) => {
    const player = (room.state as GateState).players.get(room.sessionId);
    if (player === undefined) throw new Error(`Missing initial state for ${room.sessionId}`);
    return { x: player.x, z: player.z };
  });
  host.send('start');
  await delay(100);

  for (let sequence = 1; sequence <= CONFIG.coop.inputHz; sequence += 1) {
    for (const room of rooms) {
      room.send('input', {
        sequence,
        forward: 1,
        right: 0,
        yaw: 0,
        pitch: 0,
        sprint: true,
        ads: false,
        ascend: false,
        descend: false,
      });
    }
    await delay(1000 / CONFIG.coop.inputHz);
  }
  for (const room of rooms) {
    room.send('input', {
      sequence: CONFIG.coop.inputHz + 1,
      forward: 0,
      right: 0,
      yaw: 0,
      pitch: 0,
      sprint: false,
      ads: false,
      ascend: false,
      descend: false,
    });
  }
  await delay(250);

  const hostState = host.state as GateState;
  if (!hostState.started || hostState.players.size !== CONFIG.coop.maxPlayers) throw new Error('Authoritative roster did not lock at four players.');
  const results = rooms.map((room, index) => {
    const local = (room.state as GateState).players.get(room.sessionId);
    const hostView = hostState.players.get(room.sessionId);
    if (local === undefined || hostView === undefined) throw new Error(`Missing final state for client ${index + 1}.`);
    const traveled = initial[index]!.z - local.z;
    const divergence = Math.hypot(local.x - hostView.x, local.y - hostView.y, local.z - hostView.z);
    if (traveled < 1) throw new Error(`Client ${index + 1} moved only ${traveled.toFixed(3)}m.`);
    if (divergence > 0.001) throw new Error(`Client ${index + 1} diverged by ${divergence.toFixed(6)}m.`);
    if (local.lastProcessedInput !== CONFIG.coop.inputHz + 1) throw new Error(`Client ${index + 1} input acknowledgement stalled.`);
    return {
      client: index + 1,
      traveledM: Number(traveled.toFixed(3)),
      divergenceM: Number(divergence.toFixed(6)),
      staminaMs: Number(local.staminaMs.toFixed(1)),
      lastProcessedInput: local.lastProcessedInput,
    };
  });

  console.log(JSON.stringify({ ok: true, roomCode: host.roomId, seed: hostState.seed, roster: hostState.players.size, results }, null, 2));
} finally {
  await Promise.allSettled(rooms.map((room) => room.leave(true)));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
