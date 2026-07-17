import { randomBytes, randomInt } from 'node:crypto';
import { Client, Room } from 'colyseus';
import { CONFIG } from '../../src/config.js';
import { START_POSITIONS } from '../../src/map/blueprint.js';
import {
  createCollisionWorld,
  resolvePlayerSeparation,
  sanitizeMovementInput,
  simulatePlayerMovement,
  type MovementInput,
} from '../../src/shared/movement.js';
import { GameSimulation, type SimBarrier, type SimEnemy } from '../../src/shared/GameSimulation.js';
import { BunkerState, NetBarrier, NetEnemy, NetPlayer } from './schema.js';

interface JoinOptions {
  name?: string;
  resumeToken?: string;
}

interface ActionMessage {
  type: 'melee' | 'repair';
  held?: boolean;
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
  private readonly latestInputs = new Map<string, MovementInput>();
  private readonly collisionWorld = createCollisionWorld();
  private simulation: GameSimulation | null = null;

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
      if (!this.state.started) return;
      const players = [...this.state.players.values()].filter((player) => player.connected && !player.spectating && !player.downed);
      for (const player of players) {
        const input = this.latestInputs.get(player.id);
        if (input === undefined) continue;
        simulatePlayerMovement(player, input, 1 / CONFIG.simulation.hz, this.collisionWorld);
        player.yaw = input.yaw;
        player.pitch = input.pitch;
        player.lastProcessedInput = input.sequence;
      }
      resolvePlayerSeparation(players);
      const simulation = this.simulation;
      if (simulation !== null) {
        simulation.update(1000 / CONFIG.simulation.hz, players);
        this.syncSimulation(simulation);
      }
    }, 1000 / CONFIG.simulation.hz);

    this.onMessage('ready', (client, ready: boolean) => {
      const player = this.state.players.get(client.sessionId);
      if (player !== undefined) player.ready = Boolean(ready);
    });
    this.onMessage('start', (client) => {
      if (this.state.started || client.sessionId !== this.state.hostId) return;
      this.state.started = true;
      this.state.phase = 'playing';
      this.simulation = new GameSimulation({ seed: this.state.seed, mode: 'coop', rosterSize: this.state.players.size });
      this.syncSimulation(this.simulation);
      this.lock();
      this.broadcast('runStarted', { seed: this.state.seed, roster: this.state.players.size });
    });
    this.onMessage('input', (client, unsafeInput: MovementInput) => {
      if (!this.state.started || !Number.isFinite(unsafeInput.sequence)) return;
      const input = sanitizeMovementInput(unsafeInput);
      const prior = this.inputSequences.get(client.sessionId) ?? -1;
      if (input.sequence <= prior) return;
      this.inputSequences.set(client.sessionId, input.sequence);
      const player = this.state.players.get(client.sessionId);
      if (player === undefined || player.spectating || player.downed) return;
      this.latestInputs.set(client.sessionId, input);
    });
    this.onMessage('action', (client, action: ActionMessage) => {
      const simulation = this.simulation;
      const player = this.state.players.get(client.sessionId);
      if (simulation === null || player === undefined || player.spectating || player.downed) return;
      if (action.type === 'melee') simulation.melee(player);
      if (action.type === 'repair') simulation.setRepairHeld(client.sessionId, action.held === true);
    });
    this.onMessage('ping', (client, sentAt: number) => client.send('pong', sentAt));
  }

  onJoin(client: Client, options: JoinOptions): void {
    const player = new NetPlayer();
    player.id = client.sessionId;
    player.name = cleanName(options.name);
    const spawn = START_POSITIONS[this.state.players.size] ?? CONFIG.map.startPosition;
    player.x = spawn.x;
    player.y = spawn.y;
    player.z = spawn.z;
    this.state.players.set(client.sessionId, player);
    if (this.state.hostId === '') this.state.hostId = client.sessionId;

  }

  onLeave(client: Client): void {
    this.latestInputs.delete(client.sessionId);
    this.inputSequences.delete(client.sessionId);
    this.simulation?.setRepairHeld(client.sessionId, false);
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
    this.latestInputs.clear();
    this.simulation = null;
  }

  private syncSimulation(simulation: GameSimulation): void {
    this.state.round = simulation.round;
    this.state.spawned = simulation.spawnedThisRound;
    this.state.queued = simulation.queued;
    this.state.alive = simulation.aliveCount;
    this.state.phase = simulation.phase === 'active' ? 'playing' : 'intermission';

    for (const barrier of simulation.barriers.values()) this.syncBarrier(barrier);
    const activeBarrierIds = new Set(simulation.barriers.keys());
    for (const id of this.state.barriers.keys()) if (!activeBarrierIds.has(id)) this.state.barriers.delete(id);

    for (const enemy of simulation.enemies.values()) this.syncEnemy(enemy);
    const activeEnemyIds = new Set([...simulation.enemies.keys()].map(String));
    for (const id of this.state.enemies.keys()) if (!activeEnemyIds.has(id)) this.state.enemies.delete(id);
  }

  private syncBarrier(source: SimBarrier): void {
    let target = this.state.barriers.get(source.id);
    if (target === undefined) {
      target = new NetBarrier();
      target.id = source.id;
      this.state.barriers.set(source.id, target);
    }
    target.room = source.room;
    target.boards = source.boards;
    target.repairProgressMs = source.repairProgressMs;
  }

  private syncEnemy(source: SimEnemy): void {
    const key = String(source.id);
    let target = this.state.enemies.get(key);
    if (target === undefined) {
      target = new NetEnemy();
      target.id = source.id;
      this.state.enemies.set(key, target);
    }
    target.kind = source.kind;
    target.state = source.state;
    target.speedTier = source.speedTier;
    target.x = source.x;
    target.y = source.y;
    target.z = source.z;
    target.yaw = source.yaw;
    target.hp = source.hp;
    target.maxHp = source.maxHp;
    target.speed = source.speed;
    target.barrierId = source.barrierId;
    target.targetPlayerId = source.targetPlayerId;
    target.stateTimeMs = source.stateTimeMs;
    target.spawnProgress = source.spawnProgress;
  }
}
