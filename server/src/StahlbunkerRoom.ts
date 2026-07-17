import { randomBytes, randomInt } from 'node:crypto';
import { Client, Room } from '@colyseus/core';
import { CONFIG, type PerkId, type PowerupId, type WeaponId } from '../../src/config.js';
import { DOORS, START_POSITIONS } from '../../src/map/blueprint.js';
import {
  createCollisionWorld,
  resolvePlayerSeparation,
  sanitizeMovementInput,
  simulatePlayerMovement,
  type MovementInput,
} from '../../src/shared/movement.js';
import {
  GameSimulation,
  type EnemyPositionSnapshot,
  type SimBarrier,
  type SimEnemy,
  type SimGrenade,
  type SimPowerup,
  type SimulationEvent,
} from '../../src/shared/GameSimulation.js';
import type { CombatPlayerState } from '../../src/shared/combat.js';
import { BunkerState, NetBarrier, NetEnemy, NetGrenade, NetPlayer, NetPowerup, NetWeapon } from './schema.js';

interface JoinOptions {
  name?: string;
  resumeToken?: string;
}

interface ActionMessage {
  type: 'melee' | 'repair' | 'interact' | 'fire' | 'reload' | 'switch' | 'grenade';
  sequence?: number;
  held?: boolean;
  ads?: boolean;
  index?: number;
  cookedMs?: number;
  simulationTimeMs?: number;
  yaw?: number;
  pitch?: number;
}

interface EnemyHistoryFrame {
  simulationTimeMs: number;
  positions: Map<number, EnemyPositionSnapshot>;
}

interface GateMessage {
  version: number;
  type: 'grantPoints' | 'teleport' | 'grantWeapon' | 'grantPerk' | 'setPower' | 'spawnPowerup' | 'damage' | 'startRound' | 'killAll' | 'openDoors' | 'spawnWonderPack' | 'aimNearest';
  x?: number;
  y?: number;
  z?: number;
  weaponId?: string;
  perkId?: string;
  powerupType?: string;
  damage?: number;
  round?: number;
  hitbox?: 'body' | 'head';
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
  private readonly actionSequences = new Map<string, number>();
  private readonly latestInputs = new Map<string, MovementInput>();
  private readonly enemyHistory: EnemyHistoryFrame[] = [];
  private readonly collisionWorld = createCollisionWorld();
  private simulation: GameSimulation | null = null;
  private simulationAccumulatorMs = 0;
  private emptyRoomTimer: ReturnType<typeof setTimeout> | null = null;

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
      const allPlayers = [...this.state.players.values()];
      if (!allPlayers.some((player) => player.connected)) {
        this.state.phase = 'paused';
        return;
      }
      const players = allPlayers.filter((player) => player.connected && !player.spectating && !player.downed);
      const simulation = this.simulation;
      if (simulation === null) return;
      const fixedDeltaMs = 1000 / CONFIG.simulation.hz;
      this.simulationAccumulatorMs += Math.min(deltaMs, CONFIG.simulation.maxFrameDeltaMs);
      let subSteps = 0;
      while (this.simulationAccumulatorMs >= fixedDeltaMs && subSteps < CONFIG.simulation.maxSubSteps) {
        for (const player of players) {
          const input = this.latestInputs.get(player.id);
          if (input === undefined) continue;
          simulatePlayerMovement(player, input, 1 / CONFIG.simulation.hz, this.collisionWorld);
          player.yaw = input.yaw;
          player.pitch = input.pitch;
          player.lastProcessedInput = input.sequence;
        }
        resolvePlayerSeparation(players);
        simulation.update(fixedDeltaMs, allPlayers);
        this.recordEnemyHistory(simulation);
        this.publishSimulationEvents(simulation.drainEvents());
        this.simulationAccumulatorMs -= fixedDeltaMs;
        subSteps += 1;
      }
      if (subSteps === CONFIG.simulation.maxSubSteps) this.simulationAccumulatorMs = Math.min(this.simulationAccumulatorMs, fixedDeltaMs);
      this.syncSimulation(simulation);
    }, 1000 / CONFIG.simulation.hz);

    this.onMessage('ready', (client, ready: boolean) => {
      const player = this.state.players.get(client.sessionId);
      if (player !== undefined) player.ready = Boolean(ready);
    });
    this.onMessage('start', (client) => {
      if (this.state.started || client.sessionId !== this.state.hostId) return;
      this.state.started = true;
      this.autoDispose = false;
      this.state.phase = 'playing';
      this.simulation = new GameSimulation({ seed: this.state.seed, mode: 'coop', rosterSize: this.state.players.size });
      this.simulationAccumulatorMs = 0;
      this.enemyHistory.length = 0;
      this.recordEnemyHistory(this.simulation);
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
      if (simulation === null || player === undefined || player.spectating || simulation.gameOver || action === null || typeof action !== 'object') return;
      if (Number.isFinite(action.sequence)) {
        const sequence = Math.max(0, Math.floor(action.sequence ?? 0));
        const prior = this.actionSequences.get(client.sessionId) ?? -1;
        if (sequence <= prior) return;
        this.actionSequences.set(client.sessionId, sequence);
      }
      if (player.downed && action.type !== 'fire' && action.type !== 'reload') return;
      if (action.type === 'melee') {
        const result = simulation.melee(player);
        client.send('combatFeedback', { source: 'melee', ...result });
        this.broadcast('gameEvent', { type: 'meleeSwung', playerId: player.id });
        if (result.points > 0) this.logPointTransaction(player.id, result.points, 'melee kill');
      }
      if (action.type === 'repair' || action.type === 'interact') {
        simulation.setRepairHeld(client.sessionId, action.held === true);
        simulation.setInteractionHeld(client.sessionId, action.held === true);
      }
      if (action.type === 'fire') {
        if (Number.isFinite(action.yaw)) player.yaw = action.yaw ?? player.yaw;
        if (Number.isFinite(action.pitch)) {
          player.pitch = Math.max(-CONFIG.controller.pitchLimitRad, Math.min(CONFIG.controller.pitchLimitRad, action.pitch ?? player.pitch));
        }
        const requestedTimeMs = Number.isFinite(action.simulationTimeMs) ? action.simulationTimeMs ?? simulation.elapsedMs : simulation.elapsedMs;
        const rewindTimeMs = Math.max(
          simulation.elapsedMs - CONFIG.coop.rewindMs,
          Math.min(simulation.elapsedMs, requestedTimeMs),
        );
        const rewindPositions = this.enemyPositionsAt(rewindTimeMs);
        const result = rewindPositions.size > 0
          ? simulation.fireRewound(player, action.ads === true, rewindPositions)
          : simulation.fire(player, action.ads === true);
        const rewindAppliedMs = Math.round(simulation.elapsedMs - rewindTimeMs);
        client.send('combatFeedback', { source: 'fire', ...result, rewindAppliedMs });
        if (result.accepted) {
          this.broadcast('gameEvent', {
            type: 'weaponFired',
            playerId: player.id,
            weaponId: result.weaponId,
            impact: result.impact,
            hit: result.hit,
          });
        }
        if (result.accepted && (result.weaponId === 'blitzwerfer' || result.weaponId === 'sonnenpistole')) {
          this.broadcast('gameEvent', {
            type: 'wonderFired',
            playerId: player.id,
            weaponId: result.weaponId,
            affectedEnemyIds: result.affectedEnemyIds,
            impact: result.impact,
          });
        }
        if (result.points > 0) this.logPointTransaction(player.id, result.points, result.headshot ? 'headshot bullet' : 'body bullet');
      }
      if (action.type === 'reload') {
        const result = simulation.requestReload(player.id);
        client.send('reloadFeedback', result);
        if (result.accepted) this.broadcast('gameEvent', { type: 'weaponReloaded', playerId: player.id, weaponId: result.weaponId });
      }
      if (action.type === 'switch' && Number.isInteger(action.index)) simulation.switchWeapon(player.id, action.index ?? -1);
      if (action.type === 'grenade') simulation.throwGrenade(player, Number.isFinite(action.cookedMs) ? action.cookedMs ?? 0 : 0);
      this.syncSimulation(simulation);
    });
    this.onMessage('ping', (client, sentAt: number) => client.send('pong', sentAt));
    this.onMessage('gate', (client, message: GateMessage) => {
      if (process.env.NODE_ENV === 'production' || message?.version !== CONFIG.debug.apiVersion) {
        client.send('gateAck', { accepted: false });
        return;
      }
      const player = this.state.players.get(client.sessionId);
      const simulation = this.simulation;
      if (player === undefined || simulation === null) return;
      if (message.type === 'grantPoints') player.points += CONFIG.debug.gatePointGrant;
      if (message.type === 'teleport' && Number.isFinite(message.x) && Number.isFinite(message.y) && Number.isFinite(message.z)) {
        player.x = message.x ?? player.x;
        player.y = message.y ?? player.y;
        player.z = message.z ?? player.z;
        player.vx = 0;
        player.vy = 0;
        player.vz = 0;
      }
      if (message.type === 'grantWeapon' && typeof message.weaponId === 'string'
        && Object.prototype.hasOwnProperty.call(CONFIG.weapons, message.weaponId)) {
        const combat = simulation.grantWeapon(player.id, message.weaponId as WeaponId);
        combat.switchReadyAtMs = simulation.elapsedMs;
        const weapon = combat.weapons[combat.activeWeaponIndex];
        if (weapon !== undefined) weapon.readyAtMs = simulation.elapsedMs;
      }
      if (message.type === 'grantPerk' && typeof message.perkId === 'string'
        && Object.prototype.hasOwnProperty.call(CONFIG.perks, message.perkId)) {
        simulation.grantPerk(player, message.perkId as PerkId);
      }
      if (message.type === 'setPower') simulation.setPowerOn(true);
      if (message.type === 'openDoors') {
        for (const door of DOORS) simulation.setDoorOpen(door.id, true);
      }
      if (message.type === 'spawnPowerup' && isPowerupId(message.powerupType)) {
        simulation.debugSpawnPowerup(message.powerupType, player.x, player.y, player.z);
      }
      if (message.type === 'damage' && Number.isFinite(message.damage)) {
        simulation.applyPlayerDamage(player, Math.max(0, message.damage ?? 0));
      }
      if (message.type === 'startRound' && Number.isFinite(message.round)) {
        const round = Math.max(1, Math.floor(message.round ?? 1));
        simulation.debugStartRound(round, [...this.state.players.values()]);
        this.enemyHistory.length = 0;
        this.recordEnemyHistory(simulation);
      }
      if (message.type === 'killAll') simulation.killAll();
      if (message.type === 'spawnWonderPack') simulation.debugSpawnWonderPack(player, [...this.state.players.values()]);
      if (message.type === 'aimNearest') {
        const target = [...simulation.enemies.values()]
          .filter((enemy) => enemy.state !== 'dead')
          .sort((left, right) => Math.hypot(left.x - player.x, left.z - player.z) - Math.hypot(right.x - player.x, right.z - player.z))[0];
        if (target !== undefined) {
          const dx = target.x - player.x;
          const dz = target.z - player.z;
          const distance = Math.hypot(dx, dz);
          const targetHeight = message.hitbox === 'head'
            ? CONFIG.combat.headCenterHeightM
            : (CONFIG.combat.bodyBottomHeightM + CONFIG.combat.bodyTopHeightM) / 2;
          player.yaw = Math.atan2(-dx, -dz);
          player.pitch = Math.atan2(target.y + targetHeight - (player.y + CONFIG.controller.eyeHeightM), distance);
        }
      }
      this.syncSimulation(simulation);
      client.send('gateAck', { accepted: true, type: message.type });
    });
  }

  onJoin(client: Client, options: JoinOptions): void {
    this.clearEmptyRoomTimer();
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

  onDrop(client: Client): void {
    this.markDisconnected(client.sessionId);
    if (this.state.started) {
      void this.allowReconnection(client, CONFIG.coop.reconnectRoomRetentionMs / 1000);
    }
  }

  onReconnect(client: Client): void {
    this.clearEmptyRoomTimer();
    const player = this.state.players.get(client.sessionId);
    if (player === undefined) return;
    player.connected = true;
    player.ready = true;
    this.simulation?.markReconnectPending(player);
    if (this.simulation !== null) this.syncSimulation(this.simulation);
    this.broadcast('gameEvent', { type: 'playerReconnected', playerId: player.id });
  }

  onLeave(client: Client): void {
    this.markDisconnected(client.sessionId);
  }

  private markDisconnected(sessionId: string): void {
    this.latestInputs.delete(sessionId);
    this.inputSequences.delete(sessionId);
    this.actionSequences.delete(sessionId);
    this.simulation?.setRepairHeld(sessionId, false);
    this.simulation?.setInteractionHeld(sessionId, false);
    const player = this.state.players.get(sessionId);
    if (player !== undefined) player.connected = false;
    if (!this.state.started) {
      this.state.players.delete(sessionId);
      if (this.state.hostId === sessionId) {
        this.state.hostId = this.state.players.keys().next().value ?? '';
      }
      return;
    }
    if (![...this.state.players.values()].some((candidate) => candidate.connected)) this.scheduleEmptyRoomDisposal();
  }

  onDispose(): void {
    this.clearEmptyRoomTimer();
    this.inputSequences.clear();
    this.actionSequences.clear();
    this.latestInputs.clear();
    this.enemyHistory.length = 0;
    this.simulation = null;
    this.simulationAccumulatorMs = 0;
  }

  private scheduleEmptyRoomDisposal(): void {
    if (this.emptyRoomTimer !== null) return;
    this.state.phase = 'paused';
    this.emptyRoomTimer = setTimeout(() => {
      this.emptyRoomTimer = null;
      void this.disconnect(CONFIG.coop.consentedCloseCode);
    }, CONFIG.coop.reconnectRoomRetentionMs);
  }

  private clearEmptyRoomTimer(): void {
    if (this.emptyRoomTimer === null) return;
    clearTimeout(this.emptyRoomTimer);
    this.emptyRoomTimer = null;
  }

  private syncSimulation(simulation: GameSimulation): void {
    this.state.round = simulation.round;
    this.state.spawned = simulation.spawnedThisRound;
    this.state.queued = simulation.queued;
    this.state.alive = simulation.aliveCount;
    this.state.simulationTimeMs = simulation.elapsedMs;
    this.state.phase = simulation.gameOver ? 'gameover' : simulation.phase === 'active' ? 'playing' : 'intermission';
    this.state.roundKind = simulation.roundKind;
    this.state.nextWolfRound = simulation.nextWolfRound;
    this.state.wolfAppearance = simulation.wolfAppearance;
    this.state.powerOn = simulation.powerOn;
    this.state.powerActivationElapsedMs = simulation.powerActivationElapsedMs;
    this.state.gameOver = simulation.gameOver;
    this.state.instaKillRemainingMs = simulation.effects.instaKillRemainingMs;
    this.state.doublePointsRemainingMs = simulation.effects.doublePointsRemainingMs;
    this.state.nukeRemainingMs = simulation.effects.nukeRemainingMs;

    for (const barrier of simulation.barriers.values()) this.syncBarrier(barrier);
    const activeBarrierIds = new Set(simulation.barriers.keys());
    for (const id of this.state.barriers.keys()) if (!activeBarrierIds.has(id)) this.state.barriers.delete(id);

    for (const enemy of simulation.enemies.values()) this.syncEnemy(enemy);
    const activeEnemyIds = new Set([...simulation.enemies.keys()].map(String));
    for (const id of this.state.enemies.keys()) if (!activeEnemyIds.has(id)) this.state.enemies.delete(id);

    const doorIds = [...simulation.openDoors].sort();
    if (doorIds.length !== this.state.openDoors.length || doorIds.some((id, index) => this.state.openDoors[index] !== id)) {
      this.state.openDoors.splice(0, this.state.openDoors.length);
      for (const doorId of doorIds) this.state.openDoors.push(doorId);
    }
    const collisionDoors = this.collisionWorld.openDoors as Set<string>;
    collisionDoors.clear();
    for (const id of doorIds) collisionDoors.add(id);

    this.state.crateLocationId = simulation.crate.activeLocationId;
    this.state.cratePhase = simulation.crate.phase;
    this.state.cratePurchaserId = simulation.crate.purchaserId;
    this.state.crateWeaponId = simulation.crate.weaponId;
    this.state.cratePendingPuppe = simulation.crate.pendingPuppe;
    this.state.crateSpinRemainingMs = simulation.crate.spinRemainingMs;
    this.state.crateGrabRemainingMs = simulation.crate.grabRemainingMs;
    this.state.crateUsesAtLocation = simulation.crate.usesAtLocation;
    this.state.forgePhase = simulation.forge.phase;
    this.state.forgePlayerId = simulation.forge.playerId;
    this.state.forgeWeaponId = simulation.forge.weaponId;
    this.state.forgeRemainingMs = simulation.forge.remainingMs;

    for (const grenade of simulation.grenades.values()) this.syncGrenade(grenade);
    const activeGrenadeIds = new Set([...simulation.grenades.keys()].map(String));
    for (const id of this.state.grenades.keys()) if (!activeGrenadeIds.has(id)) this.state.grenades.delete(id);
    for (const powerup of simulation.powerups.values()) this.syncPowerup(powerup);
    const activePowerupIds = new Set([...simulation.powerups.keys()].map(String));
    for (const id of this.state.powerups.keys()) if (!activePowerupIds.has(id)) this.state.powerups.delete(id);
    for (const player of this.state.players.values()) {
      this.syncCombatPlayer(player, simulation.getCombatState(player.id), simulation.elapsedMs);
      const life = simulation.getLifeState(player.id);
      player.bleedoutRemainingMs = life.bleedoutRemainingMs;
      player.selfReviveRemainingMs = life.selfReviveRemainingMs;
      player.dead = life.dead;
      player.reconnectPending = life.reconnectPending;
    }
  }

  private recordEnemyHistory(simulation: GameSimulation): void {
    const positions = new Map<number, EnemyPositionSnapshot>();
    for (const enemy of simulation.enemies.values()) {
      if (enemy.state === 'dead') continue;
      positions.set(enemy.id, { x: enemy.x, y: enemy.y, z: enemy.z });
    }
    this.enemyHistory.push({ simulationTimeMs: simulation.elapsedMs, positions });
    const oldestAllowedMs = simulation.elapsedMs - CONFIG.coop.rewindMs - 1000 / CONFIG.simulation.hz;
    while (this.enemyHistory.length > 1 && this.enemyHistory[1]!.simulationTimeMs < oldestAllowedMs) this.enemyHistory.shift();
  }

  private enemyPositionsAt(simulationTimeMs: number): ReadonlyMap<number, EnemyPositionSnapshot> {
    let closest: EnemyHistoryFrame | undefined;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const frame of this.enemyHistory) {
      const distance = Math.abs(frame.simulationTimeMs - simulationTimeMs);
      if (distance >= closestDistance) continue;
      closest = frame;
      closestDistance = distance;
    }
    return closest?.positions ?? new Map<number, EnemyPositionSnapshot>();
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
    player.doorsOpened = source.doorsOpened;
    player.crateRolls = source.crateRolls;
    player.grenades = source.grenades;
    if (player.perks.length !== source.perks.length || source.perks.some((perk, index) => player.perks[index] !== perk)) {
      player.perks.splice(0, player.perks.length);
      for (const perk of source.perks) player.perks.push(perk);
    }
    player.pendingPerk = source.pendingPerk;
    player.actionLockRemainingMs = Math.max(0, source.actionLockedUntilMs - elapsedMs);
    player.selfRevivesRemaining = source.selfRevivesRemaining;
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
      if (event.type === 'playerSelfDamaged') {
        this.clientBySessionId(event.playerId)?.send('damageFeedback', { amount: event.damage, enemyId: 0 });
      }
      if (event.type === 'pointTransaction') {
        this.clientBySessionId(event.playerId)?.send('pointTransaction', { amount: event.amount, reason: event.reason });
        this.logPointTransaction(event.playerId, event.amount, event.reason);
      }
      this.broadcast('gameEvent', event);
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

  private syncGrenade(source: SimGrenade): void {
    const key = String(source.id);
    let target = this.state.grenades.get(key);
    if (target === undefined) {
      target = new NetGrenade();
      target.id = source.id;
      this.state.grenades.set(key, target);
    }
    target.ownerId = source.ownerId;
    target.x = source.x;
    target.y = source.y;
    target.z = source.z;
    target.fuseRemainingMs = source.fuseRemainingMs;
  }

  private syncPowerup(source: SimPowerup): void {
    const key = String(source.id);
    let target = this.state.powerups.get(key);
    if (target === undefined) {
      target = new NetPowerup();
      target.id = source.id;
      this.state.powerups.set(key, target);
    }
    target.powerupType = source.type;
    target.x = source.x;
    target.y = source.y;
    target.z = source.z;
    target.remainingMs = source.remainingMs;
    target.guaranteed = source.guaranteed;
  }
}

function isPowerupId(value: unknown): value is PowerupId {
  return value === 'instaKill' || value === 'doublePoints' || value === 'nuke' || value === 'maxAmmo' || value === 'carpenter';
}
