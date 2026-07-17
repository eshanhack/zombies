import { randomBytes, randomInt } from 'node:crypto';
import { Client, Room } from 'colyseus';
import { CONFIG } from '../../src/config.js';
import { BunkerState, NetPlayer } from './schema.js';

interface JoinOptions {
  name?: string;
  resumeToken?: string;
}

interface InputMessage {
  sequence: number;
  forward: number;
  right: number;
  yaw: number;
  pitch: number;
  sprint: boolean;
}

const ROOM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function roomCode(): string {
  let value = '';
  for (let index = 0; index < CONFIG.coop.roomCodeLength; index += 1) {
    value += ROOM_ALPHABET[randomInt(ROOM_ALPHABET.length)];
  }
  return value;
}

function cleanName(value: unknown): string {
  const normalized = typeof value === 'string' ? value.trim().replace(/[^a-zA-Z0-9 _-]/g, '') : '';
  return normalized.slice(0, CONFIG.coop.maxDisplayNameLength) || 'Wanderer';
}

export class StahlbunkerRoom extends Room<{ state: BunkerState }> {
  maxClients = CONFIG.coop.maxPlayers;
  patchRate = CONFIG.coop.patchRateMs;
  maxMessagesPerSecond = CONFIG.coop.maxMessagesPerSecond;
  private readonly inputSequences = new Map<string, number>();

  onCreate(): void {
    const seed = randomBytes(4).readUInt32LE(0);
    const code = roomCode();
    this.roomId = code;
    this.setState(new BunkerState());
    this.state.seed = seed;
    this.state.roomCode = code;
    this.setPrivate(true);
    this.setSimulationInterval((deltaMs) => {
      this.state.serverTimeMs += deltaMs;
    }, 1000 / CONFIG.simulation.hz);

    this.onMessage('ready', (client, ready: boolean) => {
      const player = this.state.players.get(client.sessionId);
      if (player !== undefined) player.ready = Boolean(ready);
    });
    this.onMessage('start', (client) => {
      if (this.state.started || client.sessionId !== this.state.hostId) return;
      this.state.started = true;
      this.state.phase = 'intermission';
      this.lock();
      this.broadcast('runStarted', { seed: this.state.seed, roster: this.state.players.size });
    });
    this.onMessage('input', (client, input: InputMessage) => {
      if (!this.state.started || !Number.isFinite(input.sequence)) return;
      const prior = this.inputSequences.get(client.sessionId) ?? -1;
      if (input.sequence <= prior) return;
      this.inputSequences.set(client.sessionId, input.sequence);
      const player = this.state.players.get(client.sessionId);
      if (player === undefined || player.spectating || player.downed) return;
      player.yaw = Number.isFinite(input.yaw) ? input.yaw : player.yaw;
      player.pitch = Number.isFinite(input.pitch) ? input.pitch : player.pitch;
      client.send('inputAck', { sequence: input.sequence, x: player.x, y: player.y, z: player.z });
    });
    this.onMessage('ping', (client, sentAt: number) => client.send('pong', sentAt));
  }

  onJoin(client: Client, options: JoinOptions): void {
    const player = new NetPlayer();
    player.id = client.sessionId;
    player.name = cleanName(options.name);
    this.state.players.set(client.sessionId, player);
    if (this.state.hostId === '') this.state.hostId = client.sessionId;

  }

  onLeave(client: Client): void {
    const player = this.state.players.get(client.sessionId);
    if (player !== undefined) player.connected = false;
    if (!this.state.started) {
      this.state.players.delete(client.sessionId);
      if (this.state.hostId === client.sessionId) {
        this.state.hostId = this.state.players.keys().next().value ?? '';
      }
    }
  }

  onDispose(): void {
    this.inputSequences.clear();
  }
}
