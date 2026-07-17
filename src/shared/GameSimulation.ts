import { CONFIG, type RoomId } from '../config.js';
import { DOORS, WINDOWS, type WindowBlueprint } from '../map/blueprint.js';
import { NAV_NODE_BY_ID } from '../map/navgraph.js';
import { coopZombieCount, soloZombieCount, spawnIntervalMs, zombieHealth } from './formulas.js';
import { findNavPath, nearestNavNode } from './navigation.js';
import { createRngStreams, type RngStreams } from './rng.js';

export type SimulationMode = 'solo' | 'coop';
export type EnemySpeedTier = 'walk' | 'jog' | 'sprint';
export type SimEnemyKind = 'zombie' | 'crawler';
export type SimEnemyState = 'spawn' | 'tear' | 'vault' | 'chase' | 'attack' | 'dead';
export type RoundPhase = 'active' | 'intermission';

export interface SimPlayer {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  points: number;
  connected: boolean;
  downed: boolean;
  invulnerableUntilMs: number;
}

export interface SimBarrier {
  id: string;
  room: RoomId;
  boards: number;
  repairProgressMs: number;
}

export interface SimEnemy {
  id: number;
  kind: SimEnemyKind;
  state: SimEnemyState;
  speedTier: EnemySpeedTier;
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  speed: number;
  barrierId: string;
  targetPlayerId: string;
  path: string[];
  pathIndex: number;
  stateTimeMs: number;
  repathInMs: number;
  attackApplied: boolean;
  crawlerUntouchedMs: number;
  spawnProgress: number;
  windowAttackInMs: number;
}

export interface MeleeResult {
  accepted: boolean;
  hit: boolean;
  killed: boolean;
  enemyId: number | null;
  damage: number;
  points: number;
}

export type SimulationEvent =
  | { type: 'enemySpawned'; enemyId: number; barrierId: string }
  | { type: 'boardTorn'; barrierId: string; boards: number }
  | { type: 'boardRepaired'; barrierId: string; boards: number; playerId: string; points: number }
  | { type: 'vaultStarted'; enemyId: number; barrierId: string }
  | { type: 'playerDamaged'; playerId: string; enemyId: number; damage: number }
  | { type: 'enemyKilled'; enemyId: number; playerId?: string; method: 'melee' | 'explosive' | 'debug' }
  | { type: 'roundStarted'; round: number; count: number }
  | { type: 'roundEnded'; round: number };

export interface GameSimulationOptions {
  seed: number;
  mode: SimulationMode;
  rosterSize: number;
}

export class GameSimulation {
  readonly barriers = new Map<string, SimBarrier>();
  readonly enemies = new Map<number, SimEnemy>();
  readonly openDoors = new Set<string>();
  readonly seed: number;
  readonly mode: SimulationMode;
  readonly rosterSize: number;
  round = 1;
  phase: RoundPhase = 'active';
  spawnedThisRound = 0;
  totalThisRound = 0;
  queued = 0;
  elapsedMs = 0;
  intermissionRemainingMs = 0;
  private readonly rng: RngStreams;
  private readonly events: SimulationEvent[] = [];
  private readonly repairHeld = new Set<string>();
  private readonly repairByPlayer = new Map<string, { barrierId: string; progressMs: number }>();
  private readonly meleeReadyAt = new Map<string, number>();
  private nextEnemyId = 1;
  private spawnInMs = 0;

  constructor(options: GameSimulationOptions) {
    this.seed = options.seed;
    this.mode = options.mode;
    this.rosterSize = Math.max(1, Math.min(CONFIG.coop.maxPlayers, options.rosterSize));
    this.rng = createRngStreams(options.seed);
    for (const window of WINDOWS) {
      this.barriers.set(window.id, { id: window.id, room: window.room, boards: CONFIG.barriers.boardSlots, repairProgressMs: 0 });
    }
    this.beginRound(1);
  }

  update(deltaMs: number, players: readonly SimPlayer[]): void {
    const delta = Math.min(Math.max(deltaMs, 0), CONFIG.simulation.maxFrameDeltaMs);
    this.elapsedMs += delta;
    if (this.phase === 'intermission') {
      this.intermissionRemainingMs = Math.max(0, this.intermissionRemainingMs - delta);
      if (this.intermissionRemainingMs === 0) this.beginRound(this.round + 1);
      this.updateRepair(delta, players);
      this.updateDead(delta);
      return;
    }

    this.updateSpawning(delta, players);
    for (const enemy of this.enemies.values()) this.updateEnemy(enemy, delta, players);
    this.applyEnemySeparation();
    this.updateRepair(delta, players);
    this.updateDead(delta);

    if (this.queued === 0 && this.aliveCount === 0 && this.spawnedThisRound >= this.totalThisRound) {
      this.phase = 'intermission';
      this.intermissionRemainingMs = CONFIG.rounds.intermissionMs;
      this.events.push({ type: 'roundEnded', round: this.round });
    }
  }

  setRepairHeld(playerId: string, held: boolean): void {
    if (held) this.repairHeld.add(playerId);
    else {
      this.repairHeld.delete(playerId);
      this.repairByPlayer.delete(playerId);
    }
  }

  getRepairTarget(player: SimPlayer): SimBarrier | null {
    return this.nearestRepairableBarrier(player);
  }

  melee(player: SimPlayer): MeleeResult {
    const readyAt = this.meleeReadyAt.get(player.id) ?? 0;
    if (this.elapsedMs < readyAt || player.downed || !player.connected) {
      return { accepted: false, hit: false, killed: false, enemyId: null, damage: 0, points: 0 };
    }
    this.meleeReadyAt.set(player.id, this.elapsedMs + CONFIG.melee.cooldownMs);
    let target: SimEnemy | null = null;
    let targetDistance = Number.POSITIVE_INFINITY;
    const forwardX = -Math.sin(player.yaw);
    const forwardZ = -Math.cos(player.yaw);
    for (const enemy of this.enemies.values()) {
      if (enemy.state === 'dead') continue;
      const dx = enemy.x - player.x;
      const dz = enemy.z - player.z;
      const distance = Math.hypot(dx, enemy.y - player.y, dz);
      if (distance > CONFIG.melee.lungeRangeM || distance >= targetDistance) continue;
      const planar = Math.max(0.001, Math.hypot(dx, dz));
      const facing = (dx / planar) * forwardX + (dz / planar) * forwardZ;
      if (facing < 0.45) continue;
      target = enemy;
      targetDistance = distance;
    }
    if (target === null) return { accepted: true, hit: false, killed: false, enemyId: null, damage: 0, points: 0 };
    target.crawlerUntouchedMs = 0;
    target.hp = Math.max(0, target.hp - CONFIG.melee.damage);
    const killed = target.hp === 0;
    let points = 0;
    if (killed) {
      points = CONFIG.points.killMelee;
      player.points += points;
      this.killEnemy(target, 'melee', player.id);
    }
    return { accepted: true, hit: true, killed, enemyId: target.id, damage: CONFIG.melee.damage, points };
  }

  applyExplosiveDamage(enemyId: number, damage: number, lethal: boolean): boolean {
    const enemy = this.enemies.get(enemyId);
    if (enemy === undefined || enemy.state === 'dead') return false;
    enemy.crawlerUntouchedMs = 0;
    if (lethal) {
      this.killEnemy(enemy, 'explosive');
      return true;
    }
    enemy.hp = Math.max(1, enemy.hp - damage);
    enemy.kind = 'crawler';
    enemy.speed = CONFIG.zombie.crawlerSpeed;
    return false;
  }

  setDoorOpen(doorId: string, open: boolean): void {
    if (!DOORS.some((door) => door.id === doorId)) return;
    if (open) this.openDoors.add(doorId);
    else this.openDoors.delete(doorId);
  }

  forceSpawn(players: readonly SimPlayer[]): SimEnemy | null {
    if (this.aliveCount >= CONFIG.zombie.maxAlive || this.queued <= 0) return null;
    return this.spawnEnemy(players);
  }

  killAll(): void {
    for (const enemy of this.enemies.values()) {
      if (enemy.state !== 'dead') this.killEnemy(enemy, 'debug');
    }
  }

  skipRound(players: readonly SimPlayer[]): void {
    this.killAll();
    this.spawnedThisRound = this.totalThisRound;
    this.queued = 0;
    this.update(0, players);
  }

  drainEvents(): SimulationEvent[] {
    return this.events.splice(0, this.events.length);
  }

  get aliveCount(): number {
    let alive = 0;
    for (const enemy of this.enemies.values()) if (enemy.state !== 'dead') alive += 1;
    return alive;
  }

  private beginRound(round: number): void {
    this.round = round;
    this.phase = 'active';
    this.spawnedThisRound = 0;
    this.totalThisRound = this.mode === 'solo' ? soloZombieCount(round) : coopZombieCount(round, this.rosterSize);
    this.queued = this.totalThisRound;
    this.spawnInMs = 0;
    this.events.push({ type: 'roundStarted', round, count: this.totalThisRound });
  }

  private updateSpawning(deltaMs: number, players: readonly SimPlayer[]): void {
    this.spawnInMs -= deltaMs;
    if (this.spawnInMs > 0 || this.queued <= 0 || this.aliveCount >= CONFIG.zombie.maxAlive) return;
    const spawned = this.spawnEnemy(players);
    if (spawned !== null) this.spawnInMs = spawnIntervalMs(this.round);
  }

  private spawnEnemy(players: readonly SimPlayer[]): SimEnemy | null {
    const activePlayers = players.filter((player) => player.connected && !player.downed);
    if (activePlayers.length === 0) return null;
    const candidates = WINDOWS.filter((window) => this.isRoomUnlocked(window.room));
    if (candidates.length === 0) return null;
    const weights = candidates.map((window) => {
      const nearest = Math.min(...activePlayers.map((player) => Math.hypot(player.x - window.insideX, player.z - window.insideZ)));
      return 1 / (nearest + CONFIG.navigation.windowDistanceWeightOffsetM);
    });
    const window = candidates[this.rng.spawn.weightedIndex(weights)];
    if (window === undefined) return null;
    const speedTier = this.rollSpeedTier();
    const maxHp = zombieHealth(this.round);
    const node = NAV_NODE_BY_ID.get(window.navNodeId);
    const enemy: SimEnemy = {
      id: this.nextEnemyId,
      kind: 'zombie',
      state: 'spawn',
      speedTier,
      x: window.outsideX,
      y: node?.y ?? 0,
      z: window.outsideZ,
      yaw: 0,
      hp: maxHp,
      maxHp,
      speed: CONFIG.zombie.speeds[speedTier],
      barrierId: window.id,
      targetPlayerId: '',
      path: [],
      pathIndex: 0,
      stateTimeMs: 0,
      repathInMs: 0,
      attackApplied: false,
      crawlerUntouchedMs: 0,
      spawnProgress: 0,
      windowAttackInMs: 0,
    };
    this.nextEnemyId += 1;
    this.enemies.set(enemy.id, enemy);
    this.spawnedThisRound += 1;
    this.queued = Math.max(0, this.totalThisRound - this.spawnedThisRound);
    this.events.push({ type: 'enemySpawned', enemyId: enemy.id, barrierId: enemy.barrierId });
    return enemy;
  }

  private updateEnemy(enemy: SimEnemy, deltaMs: number, players: readonly SimPlayer[]): void {
    if (enemy.state === 'dead') return;
    enemy.stateTimeMs += deltaMs;
    if (enemy.kind === 'crawler') {
      enemy.crawlerUntouchedMs += deltaMs;
      if (enemy.crawlerUntouchedMs >= CONFIG.combat.crawlerBleedoutMs) {
        this.killEnemy(enemy, 'debug');
        return;
      }
    }
    const window = WINDOWS.find((candidate) => candidate.id === enemy.barrierId);
    if (window === undefined) return;
    const target = this.nearestPlayer(enemy, players);
    if (target !== null) enemy.targetPlayerId = target.id;

    if (enemy.state === 'spawn') {
      enemy.spawnProgress = Math.min(1, enemy.stateTimeMs / CONFIG.zombie.spawnRiseMs);
      if (enemy.stateTimeMs >= CONFIG.zombie.spawnRiseMs) this.changeState(enemy, 'tear');
      return;
    }
    if (enemy.state === 'tear') {
      const barrier = this.barriers.get(enemy.barrierId);
      if (target !== null && Math.hypot(target.x - window.insideX, target.z - window.insideZ) <= CONFIG.zombie.attackRangeM) {
        enemy.windowAttackInMs -= deltaMs;
        if (enemy.windowAttackInMs <= 0) {
          enemy.windowAttackInMs = CONFIG.zombie.attackCooldownMs;
          this.damagePlayer(enemy, target);
        }
      }
      if (barrier === undefined || barrier.boards === 0) {
        this.changeState(enemy, 'vault');
        this.events.push({ type: 'vaultStarted', enemyId: enemy.id, barrierId: enemy.barrierId });
        return;
      }
      if (enemy.stateTimeMs >= CONFIG.zombie.boardTearMs) {
        barrier.boards = Math.max(0, barrier.boards - 1);
        enemy.stateTimeMs -= CONFIG.zombie.boardTearMs;
        this.events.push({ type: 'boardTorn', barrierId: barrier.id, boards: barrier.boards });
      }
      return;
    }
    if (enemy.state === 'vault') {
      const progress = Math.min(1, enemy.stateTimeMs / CONFIG.zombie.windowVaultMs);
      enemy.x = lerp(window.outsideX, window.insideX, progress);
      enemy.z = lerp(window.outsideZ, window.insideZ, progress);
      enemy.y = (NAV_NODE_BY_ID.get(window.navNodeId)?.y ?? 0) + Math.sin(progress * Math.PI) * 0.45;
      if (progress >= 1) {
        enemy.y = NAV_NODE_BY_ID.get(window.navNodeId)?.y ?? 0;
        this.changeState(enemy, 'chase');
      }
      return;
    }
    if (target === null) return;
    const distanceToTarget = Math.hypot(target.x - enemy.x, target.y - enemy.y, target.z - enemy.z);
    if (enemy.state === 'attack') {
      if (!enemy.attackApplied && enemy.stateTimeMs >= CONFIG.zombie.attackWindupMs) {
        enemy.attackApplied = true;
        this.damagePlayer(enemy, target);
      }
      if (enemy.stateTimeMs >= CONFIG.zombie.attackCooldownMs) this.changeState(enemy, 'chase');
      return;
    }
    if (distanceToTarget <= CONFIG.zombie.attackRangeM) {
      this.changeState(enemy, 'attack');
      return;
    }
    this.chase(enemy, target, deltaMs);
  }

  private chase(enemy: SimEnemy, target: SimPlayer, deltaMs: number): void {
    enemy.repathInMs -= deltaMs;
    const directDistance = Math.hypot(target.x - enemy.x, target.z - enemy.z);
    if (enemy.repathInMs <= 0) {
      const start = nearestNavNode(enemy.x, enemy.y, enemy.z);
      const goal = nearestNavNode(target.x, target.y, target.z);
      enemy.path = findNavPath(start.id, goal.id, this.openDoors);
      enemy.pathIndex = Math.min(1, Math.max(0, enemy.path.length - 1));
      enemy.repathInMs = CONFIG.navigation.repathMs;
    }
    let targetX = target.x;
    let targetY = target.y;
    let targetZ = target.z;
    if (directDistance > CONFIG.navigation.directChaseDistanceM && enemy.path.length > 0) {
      const nodeId = enemy.path[Math.min(enemy.pathIndex, enemy.path.length - 1)];
      const node = nodeId === undefined ? undefined : NAV_NODE_BY_ID.get(nodeId);
      if (node !== undefined) {
        targetX = node.x;
        targetY = node.y;
        targetZ = node.z;
        if (Math.hypot(node.x - enemy.x, node.y - enemy.y, node.z - enemy.z) <= CONFIG.navigation.waypointReachM) {
          enemy.pathIndex = Math.min(enemy.path.length - 1, enemy.pathIndex + 1);
        }
      }
    }
    const dx = targetX - enemy.x;
    const dz = targetZ - enemy.z;
    const distance = Math.max(0.001, Math.hypot(dx, dz));
    const travel = Math.min(distance, enemy.speed * (deltaMs / 1000));
    enemy.x += (dx / distance) * travel;
    enemy.z += (dz / distance) * travel;
    enemy.y = lerp(enemy.y, targetY, Math.min(1, deltaMs / CONFIG.navigation.repathMs));
    enemy.yaw = Math.atan2(dx, dz);
  }

  private updateRepair(deltaMs: number, players: readonly SimPlayer[]): void {
    for (const barrier of this.barriers.values()) barrier.repairProgressMs = 0;
    for (const playerId of this.repairHeld) {
      const player = players.find((candidate) => candidate.id === playerId && candidate.connected && !candidate.downed);
      if (player === undefined) {
        this.repairByPlayer.delete(playerId);
        continue;
      }
      const barrier = this.nearestRepairableBarrier(player);
      if (barrier === null) {
        this.repairByPlayer.delete(playerId);
        continue;
      }
      let repair = this.repairByPlayer.get(playerId);
      if (repair === undefined || repair.barrierId !== barrier.id) {
        repair = { barrierId: barrier.id, progressMs: 0 };
        this.repairByPlayer.set(playerId, repair);
      }
      repair.progressMs += deltaMs;
      while (repair.progressMs >= CONFIG.barriers.repairMs && barrier.boards < CONFIG.barriers.boardSlots) {
        repair.progressMs -= CONFIG.barriers.repairMs;
        barrier.boards += 1;
        player.points += CONFIG.points.boardRepair;
        this.events.push({ type: 'boardRepaired', barrierId: barrier.id, boards: barrier.boards, playerId: player.id, points: CONFIG.points.boardRepair });
      }
      if (barrier.boards >= CONFIG.barriers.boardSlots) {
        repair.progressMs = 0;
        this.repairByPlayer.delete(playerId);
      } else {
        barrier.repairProgressMs = Math.max(barrier.repairProgressMs, repair.progressMs);
      }
    }
  }

  private nearestRepairableBarrier(player: SimPlayer): SimBarrier | null {
    let nearest: SimBarrier | null = null;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const window of WINDOWS) {
      const barrier = this.barriers.get(window.id);
      if (barrier === undefined || barrier.boards >= CONFIG.barriers.boardSlots || !this.isRoomUnlocked(window.room)) continue;
      const distance = Math.hypot(player.x - window.insideX, player.y - (NAV_NODE_BY_ID.get(window.navNodeId)?.y ?? 0), player.z - window.insideZ);
      if (distance > CONFIG.controller.interactionRangeM || distance >= nearestDistance) continue;
      nearest = barrier;
      nearestDistance = distance;
    }
    return nearest;
  }

  private updateDead(deltaMs: number): void {
    for (const [id, enemy] of this.enemies) {
      if (enemy.state !== 'dead') continue;
      enemy.stateTimeMs += deltaMs;
      if (enemy.stateTimeMs >= CONFIG.zombie.deathDissolveMs) this.enemies.delete(id);
    }
  }

  private nearestPlayer(enemy: SimEnemy, players: readonly SimPlayer[]): SimPlayer | null {
    let nearest: SimPlayer | null = null;
    let distance = Number.POSITIVE_INFINITY;
    for (const player of players) {
      if (!player.connected || player.downed) continue;
      const candidate = Math.hypot(player.x - enemy.x, player.y - enemy.y, player.z - enemy.z);
      if (candidate >= distance) continue;
      nearest = player;
      distance = candidate;
    }
    return nearest;
  }

  private damagePlayer(enemy: SimEnemy, player: SimPlayer): void {
    if (this.elapsedMs < player.invulnerableUntilMs || player.downed) return;
    player.hp = Math.max(0, player.hp - CONFIG.zombie.hitDamage);
    player.invulnerableUntilMs = this.elapsedMs + CONFIG.player.postHitInvulnMs;
    if (player.hp === 0) player.downed = true;
    this.events.push({ type: 'playerDamaged', playerId: player.id, enemyId: enemy.id, damage: CONFIG.zombie.hitDamage });
  }

  private killEnemy(enemy: SimEnemy, method: 'melee' | 'explosive' | 'debug', playerId?: string): void {
    enemy.hp = 0;
    this.changeState(enemy, 'dead');
    this.events.push({ type: 'enemyKilled', enemyId: enemy.id, playerId, method });
  }

  private changeState(enemy: SimEnemy, state: SimEnemyState): void {
    enemy.state = state;
    enemy.stateTimeMs = 0;
    enemy.attackApplied = false;
  }

  private applyEnemySeparation(): void {
    const alive = [...this.enemies.values()].filter((enemy) => enemy.state === 'chase' || enemy.state === 'attack');
    for (let leftIndex = 0; leftIndex < alive.length; leftIndex += 1) {
      const left = alive[leftIndex];
      if (left === undefined) continue;
      for (let rightIndex = leftIndex + 1; rightIndex < alive.length; rightIndex += 1) {
        const right = alive[rightIndex];
        if (right === undefined) continue;
        const dx = right.x - left.x;
        const dz = right.z - left.z;
        const distance = Math.hypot(dx, dz);
        if (distance >= CONFIG.navigation.separationRadiusM || distance < 0.001) continue;
        const push = (CONFIG.navigation.separationRadiusM - distance) * 0.5 * CONFIG.navigation.separationStrength;
        const nx = dx / distance;
        const nz = dz / distance;
        left.x -= nx * push;
        left.z -= nz * push;
        right.x += nx * push;
        right.z += nz * push;
      }
    }
  }

  private rollSpeedTier(): EnemySpeedTier {
    const entry = CONFIG.zombie.speedMixByRound.find((candidate) => this.round <= candidate.throughRound)
      ?? CONFIG.zombie.speedMixByRound[CONFIG.zombie.speedMixByRound.length - 1];
    const roll = this.rng.speed.next();
    const mix = entry?.mix ?? [1, 0, 0];
    if (roll < mix[0]) return 'walk';
    if (roll < mix[0] + mix[1]) return 'jog';
    return 'sprint';
  }

  private isRoomUnlocked(room: RoomId): boolean {
    if (room === 'start') return true;
    if (room === 'armory') return this.openDoors.has('doorA');
    if (room === 'generator') return this.openDoors.has('doorA') && this.openDoors.has('doorB');
    return this.openDoors.has('doorA') && this.openDoors.has('doorB') && this.openDoors.has('doorC');
  }
}

export function windowById(id: string): WindowBlueprint | undefined {
  return WINDOWS.find((window) => window.id === id);
}

function lerp(from: number, to: number, alpha: number): number {
  return from + (to - from) * alpha;
}
