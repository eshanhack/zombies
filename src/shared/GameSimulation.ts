import { CONFIG, type RoomId, type WeaponId } from '../config.js';
import { CRATE_LOCATIONS, DOORS, WALL_BUYS, WINDOWS, type WindowBlueprint } from '../map/blueprint.js';
import { NAV_NODE_BY_ID } from '../map/navgraph.js';
import { coopZombieCount, soloZombieCount, spawnIntervalMs, zombieHealth } from './formulas.js';
import { findNavPath, nearestNavNode } from './navigation.js';
import { createRngStreams, type RngStreams } from './rng.js';
import {
  activeWeapon,
  createCombatPlayerState,
  rayAabbDistance,
  raySphereDistance,
  shotDirection,
  type CombatPlayerState,
  type FireResult,
  type ReloadResult,
} from './combat.js';

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
  pitch: number;
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

export interface SimGrenade {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  fuseRemainingMs: number;
}

export type CratePhase = 'closed' | 'spinning' | 'available';

export interface SimCrateState {
  activeLocationId: string;
  phase: CratePhase;
  purchaserId: string;
  weaponId: WeaponId | '';
  pendingPuppe: boolean;
  spinRemainingMs: number;
  grabRemainingMs: number;
  usesAtLocation: number;
}

export type InteractionTarget =
  | { kind: 'barrier'; id: string; prompt: string; cost: 0 }
  | { kind: 'door'; id: string; prompt: string; cost: number }
  | { kind: 'wallWeapon'; id: string; weaponId: WeaponId; prompt: string; cost: number }
  | { kind: 'grenades'; id: string; prompt: string; cost: number }
  | { kind: 'crate'; id: string; prompt: string; cost: number };

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
  | { type: 'enemyKilled'; enemyId: number; playerId?: string; method: 'melee' | 'explosive' | 'bullet' | 'debug' }
  | { type: 'pointTransaction'; playerId: string; amount: number; reason: string }
  | { type: 'doorOpened'; doorId: string; playerId: string }
  | { type: 'weaponPurchased'; wallBuyId: string; playerId: string; weaponId: WeaponId; cost: number }
  | { type: 'ammoPurchased'; wallBuyId: string; playerId: string; weaponId: WeaponId; cost: number }
  | { type: 'grenadesPurchased'; wallBuyId: string; playerId: string; cost: number }
  | { type: 'crateStarted'; locationId: string; playerId: string }
  | { type: 'crateSettled'; locationId: string; playerId: string; weaponId: WeaponId }
  | { type: 'cratePuppe'; locationId: string; playerId: string; relocatedTo: string }
  | { type: 'crateCollected'; locationId: string; playerId: string; weaponId: WeaponId }
  | { type: 'grenadeThrown'; grenadeId: number; playerId: string }
  | { type: 'grenadeExploded'; grenadeId: number; playerId: string; kills: number }
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
  readonly grenades = new Map<number, SimGrenade>();
  readonly openDoors = new Set<string>();
  readonly crate: SimCrateState = {
    activeLocationId: CONFIG.mysteryCrate.startingLocationId,
    phase: 'closed',
    purchaserId: '',
    weaponId: '',
    pendingPuppe: false,
    spinRemainingMs: 0,
    grabRemainingMs: 0,
    usesAtLocation: 0,
  };
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
  private readonly interactionHeld = new Set<string>();
  private readonly interactionByPlayer = new Map<string, { key: string; progressMs: number; completed: boolean }>();
  private readonly repairByPlayer = new Map<string, { barrierId: string; progressMs: number }>();
  private readonly meleeReadyAt = new Map<string, number>();
  private readonly combatByPlayer = new Map<string, CombatPlayerState>();
  private nextEnemyId = 1;
  private nextGrenadeId = 1;
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
    this.updateCombat(players);
    this.updateCrate(delta, players);
    this.updateGrenades(delta, players);
    if (this.phase === 'intermission') {
      this.intermissionRemainingMs = Math.max(0, this.intermissionRemainingMs - delta);
      if (this.intermissionRemainingMs === 0) this.beginRound(this.round + 1);
      this.updateRepair(delta, players);
      this.updateInteraction(delta, players);
      this.updateDead(delta);
      return;
    }

    this.updateSpawning(delta, players);
    for (const enemy of this.enemies.values()) this.updateEnemy(enemy, delta, players);
    this.applyEnemySeparation();
    this.updateRepair(delta, players);
    this.updateInteraction(delta, players);
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

  setInteractionHeld(playerId: string, held: boolean): void {
    if (held) this.interactionHeld.add(playerId);
    else {
      this.interactionHeld.delete(playerId);
      this.interactionByPlayer.delete(playerId);
    }
  }

  getInteractionTarget(player: SimPlayer): InteractionTarget | null {
    const barrier = this.nearestRepairableBarrier(player);
    if (barrier !== null) return { kind: 'barrier', id: barrier.id, prompt: 'Hold F to rebuild barrier', cost: 0 };
    let nearest: { distance: number; target: InteractionTarget } | null = null;
    const consider = (distance: number, target: InteractionTarget): void => {
      if (distance > CONFIG.controller.interactionRangeM || (nearest !== null && distance >= nearest.distance)) return;
      nearest = { distance, target };
    };
    for (const door of DOORS) {
      if (this.openDoors.has(door.id)) continue;
      const centerX = (door.collider.minX + door.collider.maxX) * 0.5;
      const centerZ = (door.collider.minZ + door.collider.maxZ) * 0.5;
      const distance = Math.hypot(player.x - centerX, player.z - centerZ);
      consider(distance, { kind: 'door', id: door.id, cost: door.cost, prompt: `Hold F to buy Door [Cost: ${door.cost}]` });
    }
    const combat = this.getCombatState(player.id);
    for (const wallBuy of WALL_BUYS) {
      if (!this.isRoomUnlocked(wallBuy.room)) continue;
      const distance = Math.hypot(player.x - wallBuy.x, player.y + CONFIG.controller.eyeHeightM - wallBuy.y, player.z - wallBuy.z);
      if (wallBuy.kind === 'grenades') {
        consider(distance, { kind: 'grenades', id: wallBuy.id, cost: wallBuy.cost, prompt: `Hold F for Frag Grenades ×4 [Cost: ${wallBuy.cost}]` });
        continue;
      }
      const weaponId = wallBuy.weaponId;
      if (weaponId === undefined) continue;
      const owned = combat.weapons.find((weapon) => weapon.id === weaponId);
      const cost = owned === undefined ? wallBuy.cost : Math.round(wallBuy.cost * CONFIG.economy.wallAmmoFactor);
      const label = owned === undefined ? CONFIG.weapons[weaponId].name : `${CONFIG.weapons[weaponId].name} Ammo`;
      consider(distance, { kind: 'wallWeapon', id: wallBuy.id, weaponId, cost, prompt: `Hold F for ${label} [Cost: ${cost}]` });
    }
    const crateLocation = CRATE_LOCATIONS.find((location) => location.id === this.crate.activeLocationId);
    if (crateLocation !== undefined && this.isRoomUnlocked(crateLocation.room) && this.crate.phase !== 'spinning') {
      const distance = Math.hypot(player.x - crateLocation.x, player.y - crateLocation.y, player.z - crateLocation.z);
      if (this.crate.phase === 'available' && this.crate.purchaserId === player.id && this.crate.weaponId !== '') {
        consider(distance, { kind: 'crate', id: crateLocation.id, cost: 0, prompt: `Hold F to take ${CONFIG.weapons[this.crate.weaponId].name}` });
      } else if (this.crate.phase === 'closed') {
        consider(distance, { kind: 'crate', id: crateLocation.id, cost: CONFIG.economy.mysteryCrate, prompt: `Hold F for Mystery Crate [Cost: ${CONFIG.economy.mysteryCrate}]` });
      }
    }
    const selected = nearest as { distance: number; target: InteractionTarget } | null;
    return selected === null ? null : selected.target;
  }

  debugRollCrate(playerId: string, uses: number): WeaponId | 'puppe' {
    return this.rollCrate(playerId, uses);
  }

  throwGrenade(player: SimPlayer, cookedMs: number): SimGrenade | null {
    const combat = this.getCombatState(player.id);
    if (!player.connected || player.downed || combat.grenades <= 0) return null;
    combat.grenades -= 1;
    const cosPitch = Math.cos(player.pitch);
    const directionX = -Math.sin(player.yaw) * cosPitch;
    const directionY = Math.sin(player.pitch);
    const directionZ = -Math.cos(player.yaw) * cosPitch;
    const grenade: SimGrenade = {
      id: this.nextGrenadeId,
      ownerId: player.id,
      x: player.x,
      y: player.y + CONFIG.combat.grenadePlayerReleaseHeightM,
      z: player.z,
      vx: directionX * CONFIG.combat.grenadeThrowSpeedMps,
      vy: directionY * CONFIG.combat.grenadeThrowSpeedMps,
      vz: directionZ * CONFIG.combat.grenadeThrowSpeedMps,
      fuseRemainingMs: Math.max(0, CONFIG.combat.grenadeFuseMs - Math.max(0, Math.min(CONFIG.combat.grenadeFuseMs, cookedMs))),
    };
    this.nextGrenadeId += 1;
    this.grenades.set(grenade.id, grenade);
    this.events.push({ type: 'grenadeThrown', grenadeId: grenade.id, playerId: player.id });
    return grenade;
  }

  getCombatState(playerId: string): CombatPlayerState {
    let state = this.combatByPlayer.get(playerId);
    if (state === undefined) {
      state = createCombatPlayerState();
      this.combatByPlayer.set(playerId, state);
    }
    return state;
  }

  grantWeapon(playerId: string, weaponId: WeaponId): CombatPlayerState {
    const state = this.getCombatState(playerId);
    const existingIndex = state.weapons.findIndex((weapon) => weapon.id === weaponId);
    if (existingIndex >= 0) {
      state.activeWeaponIndex = existingIndex;
      return state;
    }
    const definition = CONFIG.weapons[weaponId];
    const weapon = { id: weaponId, magazine: definition.magazine, reserve: definition.reserve, upgraded: false, readyAtMs: 0 };
    if (state.weapons.length < CONFIG.combat.maxWeapons) {
      state.weapons.push(weapon);
      state.activeWeaponIndex = state.weapons.length - 1;
    } else {
      state.weapons[state.activeWeaponIndex] = weapon;
    }
    this.cancelReload(state);
    return state;
  }

  switchWeapon(playerId: string, index: number): boolean {
    const state = this.getCombatState(playerId);
    if (!Number.isInteger(index) || index < 0 || index >= state.weapons.length || index === state.activeWeaponIndex) return false;
    state.activeWeaponIndex = index;
    this.cancelReload(state);
    state.switchReadyAtMs = this.elapsedMs + CONFIG.controller.weaponSwitchMs;
    return true;
  }

  requestReload(playerId: string): ReloadResult {
    const state = this.getCombatState(playerId);
    const weapon = activeWeapon(state);
    const definition = CONFIG.weapons[weapon.id];
    const accepted = state.reloadingWeaponIndex < 0 && weapon.magazine < definition.magazine && weapon.reserve > 0;
    if (accepted) {
      state.reloadingWeaponIndex = state.activeWeaponIndex;
      state.reloadFinishAtMs = this.elapsedMs + definition.reloadMs;
    }
    return {
      accepted,
      weaponId: weapon.id,
      magazine: weapon.magazine,
      reserve: weapon.reserve,
      finishAtMs: accepted ? state.reloadFinishAtMs : 0,
    };
  }

  fire(player: SimPlayer, ads: boolean): FireResult {
    const state = this.getCombatState(player.id);
    const weapon = activeWeapon(state);
    const definition = CONFIG.weapons[weapon.id];
    const rejected = (reason: FireResult['reason']): FireResult => ({
      accepted: false,
      reason,
      weaponId: weapon.id,
      magazine: weapon.magazine,
      reserve: weapon.reserve,
      hit: false,
      headshot: false,
      killed: false,
      enemyId: null,
      pelletHits: 0,
      damage: 0,
      points: 0,
    });
    if (!player.connected || player.downed) return rejected('unavailable');
    if (state.reloadingWeaponIndex >= 0) {
      if (definition.reloadStyle !== 'shell' || weapon.magazine <= 0) return rejected('reloading');
      this.cancelReload(state);
    }
    if (this.elapsedMs < Math.max(state.switchReadyAtMs, weapon.readyAtMs)) return rejected('cooldown');
    if (weapon.magazine <= 0) return rejected('empty');

    weapon.magazine -= 1;
    weapon.readyAtMs = this.elapsedMs + 60000 / definition.rpm;
    state.shots += 1;
    const origin = { x: player.x, y: player.y + CONFIG.controller.eyeHeightM, z: player.z };
    const damageMultiplier = weapon.upgraded ? CONFIG.forge.damageMultiplier : 1;
    let pelletHits = 0;
    let totalDamage = 0;
    let totalPoints = 0;
    let anyHeadshot = false;
    let anyKilled = false;
    let lastEnemyId: number | null = null;
    for (let pellet = 0; pellet < definition.pellets; pellet += 1) {
      const direction = shotDirection(player.yaw, player.pitch, ads ? definition.spreadAds : definition.spreadHip, this.rng.spread);
      const target = this.nearestShotTarget(origin, direction);
      if (target === null) continue;
      let falloff = 1;
      if (definition.pellets > 1 && target.distance > CONFIG.combat.shotgunFalloffStartM) {
        const alpha = Math.min(1, (target.distance - CONFIG.combat.shotgunFalloffStartM)
          / (CONFIG.combat.shotgunFalloffEndM - CONFIG.combat.shotgunFalloffStartM));
        falloff = lerp(1, CONFIG.combat.shotgunMinimumDamageMultiplier, alpha);
      }
      const damage = definition.damage * (target.headshot ? definition.headMultiplier : 1) * damageMultiplier * falloff;
      target.enemy.hp = Math.max(0, target.enemy.hp - damage);
      target.enemy.crawlerUntouchedMs = 0;
      const killed = target.enemy.hp === 0;
      let points = CONFIG.points.bulletHit;
      if (killed) points += target.headshot ? CONFIG.points.killBonusHead : CONFIG.points.killBonusBody;
      player.points += points;
      state.pointsEarned += points;
      pelletHits += 1;
      totalDamage += damage;
      totalPoints += points;
      anyHeadshot ||= target.headshot;
      anyKilled ||= killed;
      lastEnemyId = target.enemy.id;
      if (killed) {
        state.kills += 1;
        if (target.headshot) state.headshots += 1;
        this.killEnemy(target.enemy, 'bullet', player.id);
      }
    }
    if (pelletHits > 0) state.hits += 1;
    return {
      accepted: true,
      reason: 'fired',
      weaponId: weapon.id,
      magazine: weapon.magazine,
      reserve: weapon.reserve,
      hit: pelletHits > 0,
      headshot: anyHeadshot,
      killed: anyKilled,
      enemyId: lastEnemyId,
      pelletHits,
      damage: totalDamage,
      points: totalPoints,
    };
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
      const combat = this.getCombatState(player.id);
      combat.pointsEarned += points;
      combat.kills += 1;
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

  private updateInteraction(deltaMs: number, players: readonly SimPlayer[]): void {
    for (const playerId of this.interactionHeld) {
      const player = players.find((candidate) => candidate.id === playerId && candidate.connected && !candidate.downed);
      if (player === undefined) {
        this.interactionByPlayer.delete(playerId);
        continue;
      }
      const target = this.getInteractionTarget(player);
      if (target === null || target.kind === 'barrier') {
        this.interactionByPlayer.delete(playerId);
        continue;
      }
      const key = `${target.kind}:${target.id}`;
      let interaction = this.interactionByPlayer.get(playerId);
      if (interaction === undefined || interaction.key !== key) {
        interaction = { key, progressMs: 0, completed: false };
        this.interactionByPlayer.set(playerId, interaction);
      }
      if (interaction.completed) continue;
      interaction.progressMs += deltaMs;
      if (interaction.progressMs < CONFIG.controller.interactionHoldMs) continue;
      interaction.completed = true;
      this.executeInteraction(player, target);
    }
  }

  private executeInteraction(player: SimPlayer, target: InteractionTarget): void {
    if (target.kind === 'door') {
      const door = DOORS.find((candidate) => candidate.id === target.id);
      if (door === undefined || this.openDoors.has(door.id) || !this.spendPoints(player, door.cost, 'door purchase')) return;
      this.openDoors.add(door.id);
      this.getCombatState(player.id).doorsOpened += 1;
      this.events.push({ type: 'doorOpened', doorId: door.id, playerId: player.id });
      return;
    }

    if (target.kind === 'grenades') {
      const wallBuy = WALL_BUYS.find((candidate) => candidate.id === target.id && candidate.kind === 'grenades');
      const combat = this.getCombatState(player.id);
      if (wallBuy === undefined || combat.grenades >= CONFIG.combat.maxGrenades || !this.spendPoints(player, wallBuy.cost, 'grenade resupply')) return;
      combat.grenades = CONFIG.combat.maxGrenades;
      this.events.push({ type: 'grenadesPurchased', wallBuyId: wallBuy.id, playerId: player.id, cost: wallBuy.cost });
      return;
    }

    if (target.kind === 'wallWeapon') {
      const wallBuy = WALL_BUYS.find((candidate) => candidate.id === target.id && candidate.weaponId === target.weaponId);
      if (wallBuy === undefined) return;
      const combat = this.getCombatState(player.id);
      const owned = combat.weapons.find((weapon) => weapon.id === target.weaponId);
      if (owned !== undefined) {
        const cost = Math.round(wallBuy.cost * CONFIG.economy.wallAmmoFactor);
        const reserveCapacity = CONFIG.weapons[owned.id].reserve;
        if (owned.reserve >= reserveCapacity || !this.spendPoints(player, cost, 'wall ammo')) return;
        owned.reserve = reserveCapacity;
        this.events.push({ type: 'ammoPurchased', wallBuyId: wallBuy.id, playerId: player.id, weaponId: owned.id, cost });
        return;
      }
      if (!this.spendPoints(player, wallBuy.cost, 'wall weapon')) return;
      this.grantWeapon(player.id, target.weaponId);
      this.events.push({ type: 'weaponPurchased', wallBuyId: wallBuy.id, playerId: player.id, weaponId: target.weaponId, cost: wallBuy.cost });
      return;
    }

    if (target.kind !== 'crate') return;
    if (this.crate.phase === 'available' && this.crate.purchaserId === player.id && this.crate.weaponId !== '') {
      const weaponId = this.crate.weaponId;
      this.grantWeapon(player.id, weaponId);
      this.events.push({ type: 'crateCollected', locationId: this.crate.activeLocationId, playerId: player.id, weaponId });
      this.closeCrate();
      return;
    }
    if (this.crate.phase !== 'closed' || !this.spendPoints(player, CONFIG.economy.mysteryCrate, 'mystery crate')) return;
    const combat = this.getCombatState(player.id);
    const result = this.rollCrate(player.id, this.crate.usesAtLocation);
    combat.crateRolls += 1;
    this.crate.phase = 'spinning';
    this.crate.purchaserId = player.id;
    this.crate.weaponId = result === 'puppe' ? '' : result;
    this.crate.pendingPuppe = result === 'puppe';
    this.crate.spinRemainingMs = CONFIG.mysteryCrate.spinMs;
    this.crate.grabRemainingMs = 0;
    this.crate.usesAtLocation += 1;
    this.events.push({ type: 'crateStarted', locationId: this.crate.activeLocationId, playerId: player.id });
  }

  private updateCrate(deltaMs: number, players: readonly SimPlayer[]): void {
    if (this.crate.phase === 'spinning') {
      this.crate.spinRemainingMs = Math.max(0, this.crate.spinRemainingMs - deltaMs);
      if (this.crate.spinRemainingMs > 0) return;
      if (this.crate.pendingPuppe) {
        const previousLocation = this.crate.activeLocationId;
        const purchaserId = this.crate.purchaserId;
        const purchaser = players.find((candidate) => candidate.id === purchaserId);
        if (purchaser !== undefined) this.addPoints(purchaser, CONFIG.economy.mysteryCrate, 'Puppe refund', false);
        const relocatedTo = this.relocateCrate();
        this.events.push({ type: 'cratePuppe', locationId: previousLocation, playerId: purchaserId, relocatedTo });
        return;
      }
      if (this.crate.weaponId === '') {
        this.closeCrate();
        return;
      }
      this.crate.phase = 'available';
      this.crate.grabRemainingMs = CONFIG.mysteryCrate.grabWindowMs;
      this.events.push({
        type: 'crateSettled',
        locationId: this.crate.activeLocationId,
        playerId: this.crate.purchaserId,
        weaponId: this.crate.weaponId,
      });
      return;
    }
    if (this.crate.phase !== 'available') return;
    this.crate.grabRemainingMs = Math.max(0, this.crate.grabRemainingMs - deltaMs);
    if (this.crate.grabRemainingMs === 0) this.closeCrate();
  }

  private rollCrate(playerId: string, uses: number): WeaponId | 'puppe' {
    if (this.rng.crate.next() < CONFIG.mysteryCrate.dollChance(uses)) return 'puppe';
    const weaponIds = Object.keys(CONFIG.mysteryCrate.weaponWeights) as (keyof typeof CONFIG.mysteryCrate.weaponWeights)[];
    const held = new Set(this.getCombatState(playerId).weapons.map((weapon) => weapon.id));
    const weights = weaponIds.map((weaponId) => CONFIG.mysteryCrate.weaponWeights[weaponId]
      * (held.has(weaponId) ? CONFIG.mysteryCrate.heldWeaponWeightMultiplier : 1));
    return weaponIds[this.rng.crate.weightedIndex(weights)] ?? 'richter';
  }

  private relocateCrate(): string {
    const alternatives = CRATE_LOCATIONS.filter((location) => location.id !== this.crate.activeLocationId);
    const next = this.rng.crate.pick(alternatives);
    this.crate.activeLocationId = next.id;
    this.crate.usesAtLocation = 0;
    this.closeCrate();
    return next.id;
  }

  private closeCrate(): void {
    this.crate.phase = 'closed';
    this.crate.purchaserId = '';
    this.crate.weaponId = '';
    this.crate.pendingPuppe = false;
    this.crate.spinRemainingMs = 0;
    this.crate.grabRemainingMs = 0;
  }

  private updateGrenades(deltaMs: number, players: readonly SimPlayer[]): void {
    const seconds = deltaMs / 1000;
    for (const grenade of [...this.grenades.values()]) {
      grenade.fuseRemainingMs = Math.max(0, grenade.fuseRemainingMs - deltaMs);
      grenade.vy -= CONFIG.controller.gravityMps2 * seconds;
      grenade.x += grenade.vx * seconds;
      grenade.y += grenade.vy * seconds;
      grenade.z += grenade.vz * seconds;
      if (grenade.y < CONFIG.combat.grenadeCollisionRadiusM) {
        grenade.y = CONFIG.combat.grenadeCollisionRadiusM;
        if (Math.abs(grenade.vy) > CONFIG.combat.grenadeRestSpeedMps) grenade.vy = Math.abs(grenade.vy) * CONFIG.combat.grenadeBounce;
        else grenade.vy = 0;
        grenade.vx *= CONFIG.combat.grenadeGroundFriction;
        grenade.vz *= CONFIG.combat.grenadeGroundFriction;
      }
      if (grenade.fuseRemainingMs === 0) this.explodeGrenade(grenade, players);
    }
  }

  private explodeGrenade(grenade: SimGrenade, players: readonly SimPlayer[]): void {
    let kills = 0;
    for (const enemy of this.enemies.values()) {
      if (enemy.state === 'dead') continue;
      const distance = Math.hypot(enemy.x - grenade.x, enemy.y - grenade.y, enemy.z - grenade.z);
      if (distance > CONFIG.combat.grenadeRadiusM) continue;
      const alpha = distance <= CONFIG.combat.grenadeKillRadiusM
        ? 0
        : (distance - CONFIG.combat.grenadeKillRadiusM) / (CONFIG.combat.grenadeRadiusM - CONFIG.combat.grenadeKillRadiusM);
      const damage = CONFIG.combat.grenadeDamage * Math.max(0, 1 - alpha);
      const canKill = distance <= CONFIG.combat.grenadeKillRadiusM;
      if (canKill && damage >= enemy.hp) {
        kills += 1;
        this.killEnemy(enemy, 'explosive', grenade.ownerId);
        continue;
      }
      enemy.hp = Math.max(1, enemy.hp - damage);
      enemy.kind = 'crawler';
      enemy.speed = CONFIG.zombie.crawlerSpeed;
      enemy.crawlerUntouchedMs = 0;
    }
    const owner = players.find((candidate) => candidate.id === grenade.ownerId);
    if (owner !== undefined && kills > 0) {
      const points = kills * CONFIG.points.killExplosive;
      this.addPoints(owner, points, 'explosive kill');
      const combat = this.getCombatState(owner.id);
      combat.kills += kills;
    }
    this.grenades.delete(grenade.id);
    this.events.push({ type: 'grenadeExploded', grenadeId: grenade.id, playerId: grenade.ownerId, kills });
  }

  private spendPoints(player: SimPlayer, amount: number, reason: string): boolean {
    if (player.points < amount) return false;
    player.points -= amount;
    this.events.push({ type: 'pointTransaction', playerId: player.id, amount: -amount, reason });
    return true;
  }

  private addPoints(player: SimPlayer, amount: number, reason: string, earned: boolean = true): void {
    player.points += amount;
    if (earned) this.getCombatState(player.id).pointsEarned += amount;
    this.events.push({ type: 'pointTransaction', playerId: player.id, amount, reason });
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
        this.getCombatState(player.id).pointsEarned += CONFIG.points.boardRepair;
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

  private updateCombat(players: readonly SimPlayer[]): void {
    for (const player of players) {
      const state = this.getCombatState(player.id);
      if (state.reloadingWeaponIndex < 0 || this.elapsedMs < state.reloadFinishAtMs) continue;
      const weapon = state.weapons[state.reloadingWeaponIndex];
      if (weapon !== undefined) {
        const definition = CONFIG.weapons[weapon.id];
        const capacity = definition.magazine;
        const transfer = definition.reloadStyle === 'shell'
          ? Math.min(1, capacity - weapon.magazine, weapon.reserve)
          : Math.min(capacity - weapon.magazine, weapon.reserve);
        weapon.magazine += transfer;
        weapon.reserve -= transfer;
        if (definition.reloadStyle === 'shell' && weapon.magazine < capacity && weapon.reserve > 0) {
          state.reloadFinishAtMs = this.elapsedMs + definition.reloadMs;
          continue;
        }
      }
      this.cancelReload(state);
    }
  }

  private cancelReload(state: CombatPlayerState): void {
    state.reloadingWeaponIndex = -1;
    state.reloadFinishAtMs = 0;
  }

  private nearestShotTarget(
    origin: { x: number; y: number; z: number },
    direction: { x: number; y: number; z: number },
  ): { enemy: SimEnemy; headshot: boolean; distance: number } | null {
    let nearest: { enemy: SimEnemy; headshot: boolean; distance: number } | null = null;
    for (const enemy of this.enemies.values()) {
      if (enemy.state === 'dead') continue;
      const heightScale = enemy.kind === 'crawler' ? CONFIG.combat.crawlerHitboxHeightScale : 1;
      const spawnOffset = enemy.state === 'spawn'
        ? -(1 - enemy.spawnProgress) * CONFIG.rendering.zombieVisual.spawnDepthM
        : 0;
      const baseY = enemy.y + spawnOffset;
      const headDistance = raySphereDistance(origin, direction, {
        x: enemy.x,
        y: baseY + CONFIG.combat.headCenterHeightM * heightScale,
        z: enemy.z,
      }, CONFIG.combat.headRadiusM);
      const bodyDistance = rayAabbDistance(origin, direction, {
        x: enemy.x - CONFIG.combat.bodyHalfWidthM,
        y: baseY + CONFIG.combat.bodyBottomHeightM * heightScale,
        z: enemy.z - CONFIG.combat.bodyHalfWidthM,
      }, {
        x: enemy.x + CONFIG.combat.bodyHalfWidthM,
        y: baseY + CONFIG.combat.bodyTopHeightM * heightScale,
        z: enemy.z + CONFIG.combat.bodyHalfWidthM,
      });
      const headshot = headDistance !== null && (bodyDistance === null || headDistance <= bodyDistance);
      const distance = headshot ? headDistance : bodyDistance;
      if (distance === null || distance > CONFIG.combat.hitscanRangeM || (nearest !== null && distance >= nearest.distance)) continue;
      nearest = { enemy, headshot, distance };
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

  private killEnemy(enemy: SimEnemy, method: 'melee' | 'explosive' | 'debug' | 'bullet', playerId?: string): void {
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
