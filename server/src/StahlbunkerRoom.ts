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
import { GameSimulation, type SimBarrier, type SimEnemy, type SimulationEvent } from '../../src/shared/GameSimulation.js';
import type { CombatPlayerState } from '../../src/shared/combat.js';
import { BunkerState, NetBarrier, NetEnemy, NetPlayer, NetWeapon } from './schema.js';

interface JoinOptions {
  name?: string;
  resumeToken?: string;
}

interface ActionMessage {
  type: 'melee' | 'repair' | 'fire' | 'reload' | 'switch';
  held?: boolean;
  ads?: boolean;
  index?: number;
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
        this.publishSimulationEvents(simulation.drainEvents());
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
      if (simulation === null || player === undefined || player.spectating || player.downed || action === null || typeof action !== 'object') return;
      if (action.type === 'melee') {
        const result = simulation.melee(player);
        client.send('combatFeedback', { source: 'melee', ...result });
        if (result.points > 0) this.logPointTransaction(player.id, result.points, 'melee kill');
      }
      if (action.type === 'repair') simulation.setRepairHeld(client.sessionId, action.held === true);
      if (action.type === 'fire') {
        const result = simulation.fire(player, action.ads === true);
        client.send('combatFeedback', { source: 'fire', ...result });
        if (result.points > 0) this.logPointTransaction(player.id, result.points, result.headshot ? 'headshot bullet' : 'body bullet');
      }
      if (action.type === 'reload') client.send('reloadFeedback', simulation.requestReload(player.id));
      if (action.type === 'switch' && Number.isInteger(action.index)) simulation.switchWeapon(player.id, action.index ?? -1);
      this.syncSimulation(simulation);
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
    const starter = new NetWeapon();
    player.weapons.push(starter);
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
    this.state.simulationTimeMs = simulation.elapsedMs;
    this.state.phase = simulation.phase === 'active' ? 'playing' : 'intermission';

    for (const barrier of simulation.barriers.values()) this.syncBarrier(barrier);
    const activeBarrierIds = new Set(simulation.barriers.keys());
    for (const id of this.state.barriers.keys()) if (!activeBarrierIds.has(id)) this.state.barriers.delete(id);

    for (const enemy of simulation.enemies.values()) this.syncEnemy(enemy);
    const activeEnemyIds = new Set([...simulation.enemies.keys()].map(String));
    for (const id of this.state.enemies.keys()) if (!activeEnemyIds.has(id)) this.state.enemies.delete(id);
    for (const player of this.state.players.values()) this.syncCombatPlayer(player, simulation.getCombatState(player.id), simulation.elapsedMs);
  }

  private syncCombatPlayer(player: NetPlayer, source: CombatPlayerState, elapsedMs: number): void {
    if (player.weapons.length !== source.weapons.length || source.weapons.some((weapon, index) => player.weapons[index]?.id !== weapon.id)) {
      player.weapons.splice(0, player.weapons.length);
      for (const sourceWeapon of source.weapons) {
        const weapon = new NetWeapon();
        weapon.id = sourceWeapon.id;
        player.weapons.push(weapon);
      }
    }
    for (let index = 0; index < source.weapons.length; index += 1) {
      const sourceWeapon = source.weapons[index];
      const targetWeapon = player.weapons[index];
      if (sourceWeapon === undefined || targetWeapon === undefined) continue;
      targetWeapon.id = sourceWeapon.id;
      targetWeapon.magazine = sourceWeapon.magazine;
      targetWeapon.reserve = sourceWeapon.reserve;
      targetWeapon.upgraded = sourceWeapon.upgraded;
    }
    player.activeWeaponIndex = source.activeWeaponIndex;
    player.reloading = source.reloadingWeaponIndex >= 0;
    player.reloadRemainingMs = player.reloading ? Math.max(0, source.reloadFinishAtMs - elapsedMs) : 0;
    player.shots = source.shots;
    player.hits = source.hits;
    player.kills = source.kills;
    player.headshots = source.headshots;
    player.pointsEarned = source.pointsEarned;
  }

  private publishSimulationEvents(events: readonly SimulationEvent[]): void {
    for (const event of events) {
      if (event.type === 'boardRepaired') {
        this.clientBySessionId(event.playerId)?.send('pointTransaction', { amount: event.points, reason: 'barrier repair' });
        this.logPointTransaction(event.playerId, event.points, 'barrier repair');
      }
      if (event.type === 'playerDamaged') {
        this.clientBySessionId(event.playerId)?.send('damageFeedback', { amount: event.damage, enemyId: event.enemyId });
      }
    }
  }

  private clientBySessionId(sessionId: string): Client | undefined {
    return this.clients.find((client) => client.sessionId === sessionId);
  }

  private logPointTransaction(playerId: string, amount: number, reason: string): void {
    if (process.env.NODE_ENV === 'production') return;
    console.log(`[points] ${playerId} ${amount >= 0 ? '+' : ''}${amount} ${reason}`);
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
