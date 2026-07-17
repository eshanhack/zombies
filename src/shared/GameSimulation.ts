import { CONFIG, type PerkId, type PowerupId, type RoomId, type WeaponId } from '../config.js';
import {
  CRATE_LOCATIONS,
  DOORS,
  FOG_BANKS,
  FORGE,
  PERK_MACHINES,
  POWER_SWITCH,
  START_POSITIONS,
  WALL_BUYS,
  WINDOWS,
  type WindowBlueprint,
} from '../map/blueprint.js';
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
  weaponMagazineCapacity,
  type CombatPlayerState,
  type FireResult,
  type ReloadResult,
  type RuntimeWeaponState,
  type ShotVector,
} from './combat.js';

export type SimulationMode = 'solo' | 'coop';
export type EnemySpeedTier = 'walk' | 'jog' | 'sprint';
export type SimEnemyKind = 'zombie' | 'crawler' | 'wolf';
export type SimEnemyState = 'spawn' | 'tear' | 'vault' | 'chase' | 'attack' | 'dead';
export type RoundPhase = 'active' | 'intermission';
export type RoundKind = 'zombies' | 'wolves';

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
  spectating?: boolean;
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

export interface SimPowerup {
  id: number;
  type: PowerupId;
  x: number;
  y: number;
  z: number;
  remainingMs: number;
  guaranteed: boolean;
}

export interface SimLifeState {
  bleedoutRemainingMs: number;
  selfReviveRemainingMs: number;
  dead: boolean;
  reconnectPending: boolean;
  lastDamageAtMs: number;
}

export interface SimPowerupEffects {
  instaKillRemainingMs: number;
  doublePointsRemainingMs: number;
  nukeRemainingMs: number;
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

export type ForgePhase = 'idle' | 'upgrading';

export interface SimForgeState {
  phase: ForgePhase;
  playerId: string;
  weaponId: WeaponId | '';
  weaponIndex: number;
  remainingMs: number;
}

export type InteractionTarget =
  | { kind: 'revive'; id: string; prompt: string; cost: 0 }
  | { kind: 'barrier'; id: string; prompt: string; cost: 0 }
  | { kind: 'door'; id: string; prompt: string; cost: number }
  | { kind: 'wallWeapon'; id: string; weaponId: WeaponId; prompt: string; cost: number }
  | { kind: 'grenades'; id: string; prompt: string; cost: number }
  | { kind: 'crate'; id: string; prompt: string; cost: number }
  | { kind: 'power'; id: string; prompt: string; cost: 0 }
  | { kind: 'perk'; id: PerkId; prompt: string; cost: number }
  | { kind: 'forge'; id: string; prompt: string; cost: number }
  | { kind: 'inactive'; id: string; prompt: string; cost: 0 };

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
  | { type: 'powerActivated'; playerId: string }
  | { type: 'perkPurchaseStarted'; playerId: string; perkId: PerkId; cost: number }
  | { type: 'perkGranted'; playerId: string; perkId: PerkId }
  | { type: 'forgeStarted'; playerId: string; weaponId: WeaponId; cost: number }
  | { type: 'forgeCompleted'; playerId: string; weaponId: WeaponId; magazine: number; reserve: number }
  | { type: 'forgeCancelled'; playerId: string; weaponId: WeaponId }
  | { type: 'playerSelfDamaged'; playerId: string; damage: number }
  | { type: 'powerupSpawned'; powerupId: number; powerupType: PowerupId; guaranteed: boolean }
  | { type: 'powerupCollected'; powerupId: number; powerupType: PowerupId; playerId: string }
  | { type: 'playerDowned'; playerId: string; selfRevive: boolean }
  | { type: 'playerRevived'; playerId: string; reviverId?: string }
  | { type: 'playerBledOut'; playerId: string }
  | { type: 'playerReturned'; playerId: string; reason: 'bleedout' | 'reconnect' }
  | { type: 'gameOver' }
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
  readonly powerups = new Map<number, SimPowerup>();
  readonly openDoors = new Set<string>();
  readonly effects: SimPowerupEffects = { instaKillRemainingMs: 0, doublePointsRemainingMs: 0, nukeRemainingMs: 0 };
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
  readonly forge: SimForgeState = {
    phase: 'idle',
    playerId: '',
    weaponId: '',
    weaponIndex: -1,
    remainingMs: 0,
  };
  readonly seed: number;
  readonly mode: SimulationMode;
  readonly rosterSize: number;
  round = 1;
  roundKind: RoundKind = 'zombies';
  phase: RoundPhase = 'active';
  powerOn = false;
  powerActivationElapsedMs = 0;
  gameOver = false;
  nextWolfRound = 0;
  wolfAppearance = 0;
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
  private readonly lifeByPlayer = new Map<string, SimLifeState>();
  private readonly savedDownInventory = new Map<string, { weapons: RuntimeWeaponState[]; activeWeaponIndex: number }>();
  private nextEnemyId = 1;
  private nextGrenadeId = 1;
  private nextPowerupId = 1;
  private spawnInMs = 0;
  private dropsThisRound = 0;
  private wolfMaxAmmoSpawned = false;

  constructor(options: GameSimulationOptions) {
    this.seed = options.seed;
    this.mode = options.mode;
    this.rosterSize = Math.max(1, Math.min(CONFIG.coop.maxPlayers, options.rosterSize));
    this.rng = createRngStreams(options.seed);
    this.nextWolfRound = this.rng.wolves.int(CONFIG.wolves.firstRoundMin, CONFIG.wolves.firstRoundMax);
    for (const window of WINDOWS) {
      this.barriers.set(window.id, { id: window.id, room: window.room, boards: CONFIG.barriers.boardSlots, repairProgressMs: 0 });
    }
    this.beginRound(1);
  }

  update(deltaMs: number, players: readonly SimPlayer[]): void {
    const delta = Math.min(Math.max(deltaMs, 0), CONFIG.simulation.maxFrameDeltaMs);
    this.elapsedMs += delta;
    this.updatePowerActivation(delta);
    this.updatePlayerLifecycle(delta, players);
    this.updateCombat(players);
    this.updateForge(delta, players);
    this.updateCrate(delta, players);
    this.updateGrenades(delta, players);
    this.updatePowerups(delta, players);
    if (this.gameOver) {
      this.updateDead(delta);
      return;
    }
    if (this.phase === 'intermission') {
      this.intermissionRemainingMs = Math.max(0, this.intermissionRemainingMs - delta);
      if (this.intermissionRemainingMs === 0) this.beginRound(this.round + 1, players);
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

  getInteractionTarget(player: SimPlayer, players: readonly SimPlayer[] = []): InteractionTarget | null {
    const barrier = this.nearestRepairableBarrier(player);
    let nearest: { distance: number; target: InteractionTarget } | null = null;
    const consider = (distance: number, target: InteractionTarget): void => {
      if (distance > CONFIG.controller.interactionRangeM || (nearest !== null && distance >= nearest.distance)) return;
      nearest = { distance, target };
    };
    for (const targetPlayer of players) {
      if (targetPlayer.id === player.id || !targetPlayer.downed || targetPlayer.spectating === true) continue;
      consider(Math.hypot(player.x - targetPlayer.x, player.y - targetPlayer.y, player.z - targetPlayer.z), {
        kind: 'revive',
        id: targetPlayer.id,
        cost: 0,
        prompt: 'Hold F to revive teammate',
      });
    }
    if (barrier !== null) {
      const window = WINDOWS.find((candidate) => candidate.id === barrier.id);
      const distance = window === undefined ? 0 : Math.hypot(player.x - window.insideX, player.z - window.insideZ);
      consider(distance, { kind: 'barrier', id: barrier.id, prompt: 'Hold F to rebuild barrier', cost: 0 });
    }
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
      const cost = owned === undefined
        ? wallBuy.cost
        : owned.upgraded
          ? CONFIG.economy.upgradedWallAmmo
          : Math.round(wallBuy.cost * CONFIG.economy.wallAmmoFactor);
      const label = owned === undefined ? CONFIG.weapons[weaponId].name : `${CONFIG.weapons[weaponId].name} Ammo`;
      consider(distance, { kind: 'wallWeapon', id: wallBuy.id, weaponId, cost, prompt: `Hold F for ${label} [Cost: ${cost}]` });
    }
    if (!this.powerOn && this.isRoomUnlocked(POWER_SWITCH.room)) {
      const distance = Math.hypot(
        player.x - POWER_SWITCH.x,
        player.y + CONFIG.controller.eyeHeightM - POWER_SWITCH.y,
        player.z - POWER_SWITCH.z,
      );
      consider(distance, { kind: 'power', id: POWER_SWITCH.id, cost: 0, prompt: 'Hold F to activate Power' });
    }
    for (const machine of PERK_MACHINES) {
      if (!this.isRoomUnlocked(machine.room) || combat.perks.includes(machine.id) || combat.pendingPerk === machine.id) continue;
      const distance = Math.hypot(player.x - machine.x, player.y - machine.y, player.z - machine.z);
      const cost = machine.id === 'zweiterAtem' && this.mode === 'solo'
        ? CONFIG.perks.zweiterAtem.costSolo
        : CONFIG.perks[machine.id].cost;
      if (!this.powerOn) {
        consider(distance, { kind: 'inactive', id: machine.id, cost: 0, prompt: 'Power must be activated first' });
      } else if (combat.perks.length < CONFIG.perkRuntime.maxOwned
        && (machine.id !== 'zweiterAtem' || this.mode !== 'solo' || combat.selfRevivesRemaining > 0)) {
        consider(distance, {
          kind: 'perk',
          id: machine.id,
          cost,
          prompt: `Hold F for ${CONFIG.perkRuntime.displayNames[machine.id]} [Cost: ${cost}]`,
        });
      }
    }
    if (this.isRoomUnlocked(FORGE.room)) {
      const distance = Math.hypot(player.x - FORGE.x, player.y - FORGE.y, player.z - FORGE.z);
      const weapon = activeWeapon(combat);
      if (!this.powerOn) {
        consider(distance, { kind: 'inactive', id: FORGE.id, cost: 0, prompt: 'Power must be activated first' });
      } else if (this.forge.phase === 'upgrading') {
        const prompt = this.forge.playerId === player.id ? 'Die Schmiede is upgrading your weapon' : 'Die Schmiede is occupied';
        consider(distance, { kind: 'inactive', id: FORGE.id, cost: 0, prompt });
      } else if (weapon.upgraded) {
        consider(distance, { kind: 'inactive', id: FORGE.id, cost: 0, prompt: `${CONFIG.forge.namePrefix}${CONFIG.weapons[weapon.id].name} is already forged` });
      } else {
        consider(distance, {
          kind: 'forge',
          id: FORGE.id,
          cost: CONFIG.economy.forgeUpgrade,
          prompt: `Hold F to upgrade ${CONFIG.weapons[weapon.id].name} [Cost: ${CONFIG.economy.forgeUpgrade}]`,
        });
      }
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
    if (!player.connected || player.downed || player.spectating === true || combat.grenades <= 0 || this.elapsedMs < combat.actionLockedUntilMs) return null;
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

  getLifeState(playerId: string): SimLifeState {
    let state = this.lifeByPlayer.get(playerId);
    if (state === undefined) {
      state = {
        bleedoutRemainingMs: 0,
        selfReviveRemainingMs: 0,
        dead: false,
        reconnectPending: false,
        lastDamageAtMs: Number.NEGATIVE_INFINITY,
      };
      this.lifeByPlayer.set(playerId, state);
    }
    return state;
  }

  setPowerOn(powerOn: boolean): void {
    this.powerOn = powerOn;
    this.powerActivationElapsedMs = powerOn ? CONFIG.power.activationMs : 0;
  }

  grantPerk(player: SimPlayer, perkId: PerkId): void {
    const combat = this.getCombatState(player.id);
    if (!combat.perks.includes(perkId)) combat.perks.push(perkId);
    if (perkId === 'eisenbrau') {
      player.maxHp = CONFIG.perkRuntime.eisenbrauHp;
      player.hp = player.maxHp;
    }
  }

  markReconnectPending(player: SimPlayer): void {
    const life = this.getLifeState(player.id);
    life.reconnectPending = true;
    player.spectating = true;
    player.downed = false;
  }

  debugSpawnPowerup(type: PowerupId, x: number, y: number, z: number): SimPowerup {
    return this.spawnPowerup(type, x, y, z, true);
  }

  applyPlayerDamage(player: SimPlayer, damage: number): void {
    this.damagePlayerAmount(player, damage);
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
    if (this.elapsedMs < state.actionLockedUntilMs || !Number.isInteger(index) || index < 0 || index >= state.weapons.length || index === state.activeWeaponIndex) return false;
    state.activeWeaponIndex = index;
    this.cancelReload(state);
    state.switchReadyAtMs = this.elapsedMs + CONFIG.controller.weaponSwitchMs;
    return true;
  }

  requestReload(playerId: string): ReloadResult {
    const state = this.getCombatState(playerId);
    const weapon = activeWeapon(state);
    const definition = CONFIG.weapons[weapon.id];
    const accepted = this.elapsedMs >= state.actionLockedUntilMs && state.reloadingWeaponIndex < 0
      && weapon.magazine < weaponMagazineCapacity(weapon) && weapon.reserve > 0;
    if (accepted) {
      state.reloadingWeaponIndex = state.activeWeaponIndex;
      const reloadMultiplier = state.perks.includes('schnellwasser') ? CONFIG.perkRuntime.schnellwasserReloadMultiplier : 1;
      state.reloadFinishAtMs = this.elapsedMs + definition.reloadMs * reloadMultiplier;
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
      affectedEnemyIds: [],
      impact: null,
    });
    if (!player.connected || player.spectating === true || this.elapsedMs < state.actionLockedUntilMs) return rejected('unavailable');
    if (state.reloadingWeaponIndex >= 0) {
      if (definition.reloadStyle !== 'shell' || weapon.magazine <= 0) return rejected('reloading');
      this.cancelReload(state);
    }
    if (this.elapsedMs < Math.max(state.switchReadyAtMs, weapon.readyAtMs)) return rejected('cooldown');
    if (weapon.magazine <= 0) return rejected('empty');

    weapon.magazine -= 1;
    const fireRateMultiplier = state.perks.includes('doppelschuss') ? CONFIG.perkRuntime.doppelschussFireRateMultiplier : 1;
    weapon.readyAtMs = this.elapsedMs + 60000 / (definition.rpm * fireRateMultiplier);
    state.shots += 1;
    const origin = { x: player.x, y: player.y + CONFIG.controller.eyeHeightM, z: player.z };
    const damageMultiplier = weapon.upgraded ? CONFIG.forge.damageMultiplier : 1;
    const spreadMultiplier = weapon.upgraded ? CONFIG.forge.spreadMultiplier : 1;
    const direction = shotDirection(
      player.yaw,
      player.pitch,
      (ads ? definition.spreadAds : definition.spreadHip) * spreadMultiplier,
      this.rng.spread,
    );
    if (weapon.id === 'blitzwerfer') return this.fireBlitz(player, state, weapon, origin, direction);
    if (weapon.id === 'sonnenpistole') return this.fireSonnenpistole(player, state, weapon, origin, direction, damageMultiplier);

    let pelletHits = 0;
    let totalDamage = 0;
    let totalPoints = 0;
    let anyHeadshot = false;
    let anyKilled = false;
    let lastEnemyId: number | null = null;
    let impact: ShotVector | null = null;
    const affectedEnemyIds = new Set<number>();
    for (let pellet = 0; pellet < definition.pellets; pellet += 1) {
      const pelletDirection = pellet === 0
        ? direction
        : shotDirection(
          player.yaw,
          player.pitch,
          (ads ? definition.spreadAds : definition.spreadHip) * spreadMultiplier,
          this.rng.spread,
        );
      const target = this.nearestShotTarget(origin, pelletDirection);
      if (target === null) continue;
      let falloff = 1;
      if (definition.pellets > 1 && target.distance > CONFIG.combat.shotgunFalloffStartM) {
        const alpha = Math.min(1, (target.distance - CONFIG.combat.shotgunFalloffStartM)
          / (CONFIG.combat.shotgunFalloffEndM - CONFIG.combat.shotgunFalloffStartM));
        falloff = lerp(1, CONFIG.combat.shotgunMinimumDamageMultiplier, alpha);
      }
      const damage = this.effects.instaKillRemainingMs > 0
        ? target.enemy.hp
        : definition.damage * (target.headshot ? definition.headMultiplier : 1) * damageMultiplier * falloff;
      target.enemy.hp = Math.max(0, target.enemy.hp - damage);
      target.enemy.crawlerUntouchedMs = 0;
      const killed = target.enemy.hp === 0;
      let points = CONFIG.points.bulletHit;
      if (killed) points += target.headshot ? CONFIG.points.killBonusHead : CONFIG.points.killBonusBody;
      pelletHits += 1;
      totalDamage += damage;
      totalPoints += points;
      anyHeadshot ||= target.headshot;
      anyKilled ||= killed;
      lastEnemyId = target.enemy.id;
      affectedEnemyIds.add(target.enemy.id);
      impact = {
        x: origin.x + pelletDirection.x * target.distance,
        y: origin.y + pelletDirection.y * target.distance,
        z: origin.z + pelletDirection.z * target.distance,
      };
      if (killed) {
        state.kills += 1;
        if (target.headshot) state.headshots += 1;
        this.killEnemy(target.enemy, 'bullet', player.id);
      }
    }
    if (pelletHits > 0) state.hits += 1;
    totalPoints = this.awardPoints(player, totalPoints, anyHeadshot ? 'headshot bullet' : 'body bullet', false);
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
      affectedEnemyIds: [...affectedEnemyIds],
      impact,
    };
  }

  private fireBlitz(
    player: SimPlayer,
    state: CombatPlayerState,
    weapon: RuntimeWeaponState,
    origin: ShotVector,
    direction: ShotVector,
  ): FireResult {
    const first = this.nearestShotTarget(origin, direction);
    const affectedEnemyIds: number[] = [];
    let totalDamage = 0;
    if (first !== null) {
      const visited = new Set<number>();
      let current: SimEnemy | null = first.enemy;
      while (current !== null && affectedEnemyIds.length < CONFIG.wonder.blitzChainTargets) {
        visited.add(current.id);
        affectedEnemyIds.push(current.id);
        totalDamage += current.hp;
        current.crawlerUntouchedMs = 0;
        this.killEnemy(current, 'explosive', player.id);
        let next: SimEnemy | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of this.enemies.values()) {
          if (candidate.state === 'dead' || visited.has(candidate.id)) continue;
          const distance = Math.hypot(candidate.x - current.x, candidate.y - current.y, candidate.z - current.z);
          if (distance > CONFIG.wonder.blitzChainRangeM || distance > nearestDistance
            || (distance === nearestDistance && next !== null && candidate.id > next.id)) continue;
          next = candidate;
          nearestDistance = distance;
        }
        current = next;
      }
    }
    const kills = affectedEnemyIds.length;
    if (kills > 0) {
      state.hits += 1;
      state.kills += kills;
    }
    const points = kills > 0
      ? this.awardPoints(player, kills * CONFIG.points.killExplosive, 'Blitzwerfer kill', false)
      : 0;
    return {
      accepted: true,
      reason: 'fired',
      weaponId: weapon.id,
      magazine: weapon.magazine,
      reserve: weapon.reserve,
      hit: kills > 0,
      headshot: false,
      killed: kills > 0,
      enemyId: affectedEnemyIds[0] ?? null,
      pelletHits: kills,
      damage: totalDamage,
      points,
      affectedEnemyIds,
      impact: first === null ? null : { x: first.enemy.x, y: first.enemy.y, z: first.enemy.z },
    };
  }

  private fireSonnenpistole(
    player: SimPlayer,
    state: CombatPlayerState,
    weapon: RuntimeWeaponState,
    origin: ShotVector,
    direction: ShotVector,
    damageMultiplier: number,
  ): FireResult {
    const definition = CONFIG.weapons.sonnenpistole;
    const direct = this.nearestShotTarget(origin, direction);
    const impact: ShotVector = direct === null
      ? {
        x: origin.x + direction.x * CONFIG.combat.hitscanRangeM,
        y: origin.y + direction.y * CONFIG.combat.hitscanRangeM,
        z: origin.z + direction.z * CONFIG.combat.hitscanRangeM,
      }
      : {
        x: origin.x + direction.x * direct.distance,
        y: origin.y + direction.y * direct.distance,
        z: origin.z + direction.z * direct.distance,
      };
    const affected = new Set<number>();
    const killed = new Set<number>();
    let totalDamage = 0;
    if (direct !== null) {
      const enemy = direct.enemy;
      const before = enemy.hp;
      const damage = this.effects.instaKillRemainingMs > 0
        ? before
        : definition.damage * (direct.headshot ? definition.headMultiplier : 1) * damageMultiplier;
      enemy.hp = Math.max(0, before - damage);
      enemy.crawlerUntouchedMs = 0;
      totalDamage += before - enemy.hp;
      affected.add(enemy.id);
      if (enemy.hp === 0) {
        killed.add(enemy.id);
        this.killEnemy(enemy, 'explosive', player.id);
      }
    }
    for (const enemy of this.enemies.values()) {
      if (enemy.state === 'dead') continue;
      const heightScale = enemy.kind === 'crawler' ? CONFIG.combat.crawlerHitboxHeightScale : 1;
      const centerY = enemy.y + (CONFIG.combat.bodyBottomHeightM + CONFIG.combat.bodyTopHeightM) / 2 * heightScale;
      const distance = Math.hypot(enemy.x - impact.x, centerY - impact.y, enemy.z - impact.z);
      if (distance > CONFIG.wonder.sunSplashRadiusM) continue;
      const before = enemy.hp;
      const damage = definition.damage * damageMultiplier * this.sunSplashMultiplier(distance);
      const canKill = this.effects.instaKillRemainingMs > 0 || distance <= CONFIG.wonder.sunSplashFullRadiusM;
      if (canKill && (this.effects.instaKillRemainingMs > 0 || damage >= before)) {
        totalDamage += before;
        affected.add(enemy.id);
        killed.add(enemy.id);
        this.killEnemy(enemy, 'explosive', player.id);
        continue;
      }
      enemy.hp = Math.max(1, before - damage);
      totalDamage += before - enemy.hp;
      affected.add(enemy.id);
      enemy.crawlerUntouchedMs = 0;
      if (enemy.kind !== 'wolf') {
        enemy.kind = 'crawler';
        enemy.speed = CONFIG.zombie.crawlerSpeed;
      }
    }
    const selfDistance = Math.hypot(player.x - impact.x, player.z - impact.z);
    if (selfDistance <= CONFIG.wonder.sunSplashRadiusM) {
      const selfDamage = Math.round(
        definition.damage * damageMultiplier * this.sunSplashMultiplier(selfDistance) * CONFIG.wonder.sunSelfDamageMultiplier,
      );
      if (selfDamage > 0 && this.damagePlayerAmount(player, selfDamage)) {
        this.events.push({ type: 'playerSelfDamaged', playerId: player.id, damage: selfDamage });
      }
    }
    if (affected.size > 0) state.hits += 1;
    if (killed.size > 0) state.kills += killed.size;
    const points = killed.size > 0
      ? this.awardPoints(player, killed.size * CONFIG.points.killExplosive, 'Sonnenpistole kill', false)
      : 0;
    return {
      accepted: true,
      reason: 'fired',
      weaponId: weapon.id,
      magazine: weapon.magazine,
      reserve: weapon.reserve,
      hit: affected.size > 0,
      headshot: direct?.headshot ?? false,
      killed: killed.size > 0,
      enemyId: direct?.enemy.id ?? null,
      pelletHits: affected.size,
      damage: totalDamage,
      points,
      affectedEnemyIds: [...affected],
      impact,
    };
  }

  private sunSplashMultiplier(distance: number): number {
    if (distance <= CONFIG.wonder.sunSplashFullRadiusM) return 1;
    const alpha = Math.min(1, (distance - CONFIG.wonder.sunSplashFullRadiusM)
      / (CONFIG.wonder.sunSplashRadiusM - CONFIG.wonder.sunSplashFullRadiusM));
    return lerp(1, CONFIG.wonder.sunSplashMinimumDamageMultiplier, alpha);
  }

  melee(player: SimPlayer): MeleeResult {
    const readyAt = this.meleeReadyAt.get(player.id) ?? 0;
    const combatState = this.getCombatState(player.id);
    if (this.elapsedMs < readyAt || player.downed || !player.connected || player.spectating === true || this.elapsedMs < combatState.actionLockedUntilMs) {
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
    target.hp = Math.max(0, target.hp - (this.effects.instaKillRemainingMs > 0 ? target.hp : CONFIG.melee.damage));
    const killed = target.hp === 0;
    let points = 0;
    if (killed) {
      points = CONFIG.points.killMelee;
      points = this.awardPoints(player, points, 'melee kill', false);
      combatState.kills += 1;
      this.killEnemy(target, 'melee', player.id);
    }
    return { accepted: true, hit: true, killed, enemyId: target.id, damage: CONFIG.melee.damage, points };
  }

  applyExplosiveDamage(enemyId: number, damage: number, lethal: boolean): boolean {
    const enemy = this.enemies.get(enemyId);
    if (enemy === undefined || enemy.state === 'dead') return false;
    enemy.crawlerUntouchedMs = 0;
    if (lethal || this.effects.instaKillRemainingMs > 0) {
      this.killEnemy(enemy, 'explosive');
      return true;
    }
    enemy.hp = Math.max(1, enemy.hp - damage);
    if (enemy.kind !== 'wolf') {
      enemy.kind = 'crawler';
      enemy.speed = CONFIG.zombie.crawlerSpeed;
    }
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

  debugStartRound(round: number, players: readonly SimPlayer[] = []): void {
    this.enemies.clear();
    this.beginRound(Math.max(1, Math.floor(round)), players);
  }

  debugSpawnWonderPack(player: SimPlayer, players: readonly SimPlayer[] = [player]): SimEnemy[] {
    this.debugStartRound(CONFIG.debug.wonderGateRound, players);
    const pack: SimEnemy[] = [];
    for (let index = 0; index < CONFIG.debug.wonderPackCount; index += 1) {
      const enemy = this.forceSpawn(players);
      if (enemy === null) break;
      const rowIndex = index === 0 ? 0 : Math.floor((index - 1) / CONFIG.debug.wonderPackColumns) + 1;
      const columnIndex = index === 0 ? Math.floor(CONFIG.debug.wonderPackColumns / 2) : (index - 1) % CONFIG.debug.wonderPackColumns;
      const centeredColumn = columnIndex - Math.floor(CONFIG.debug.wonderPackColumns / 2);
      enemy.x = player.x + centeredColumn * CONFIG.debug.wonderPackSpacingM;
      enemy.y = player.y;
      enemy.z = player.z - CONFIG.debug.aimTargetDistanceM - rowIndex * CONFIG.debug.wonderPackSpacingM;
      enemy.state = 'chase';
      enemy.stateTimeMs = 0;
      enemy.spawnProgress = 1;
      enemy.hp = zombieHealth(CONFIG.debug.wonderGateRound);
      enemy.maxHp = enemy.hp;
      pack.push(enemy);
    }
    this.totalThisRound = pack.length;
    this.spawnedThisRound = pack.length;
    this.queued = 0;
    this.spawnInMs = 0;
    return pack;
  }

  debugUpgradeActiveWeapon(playerId: string): RuntimeWeaponState {
    const combat = this.getCombatState(playerId);
    const weapon = activeWeapon(combat);
    weapon.upgraded = true;
    weapon.magazine = weaponMagazineCapacity(weapon);
    weapon.reserve = CONFIG.weapons[weapon.id].reserve;
    weapon.readyAtMs = this.elapsedMs;
    return weapon;
  }

  drainEvents(): SimulationEvent[] {
    return this.events.splice(0, this.events.length);
  }

  get aliveCount(): number {
    let alive = 0;
    for (const enemy of this.enemies.values()) if (enemy.state !== 'dead') alive += 1;
    return alive;
  }

  private beginRound(round: number, players: readonly SimPlayer[] = []): void {
    this.round = round;
    this.phase = 'active';
    this.returnPlayersAtRoundStart(players);
    this.spawnedThisRound = 0;
    this.roundKind = round === this.nextWolfRound ? 'wolves' : 'zombies';
    if (this.roundKind === 'wolves') {
      this.wolfAppearance += 1;
      const perPlayer = this.wolfAppearance <= 2 ? CONFIG.wolves.firstTwoCountPerPlayer : CONFIG.wolves.laterCountPerPlayer;
      this.totalThisRound = perPlayer * this.rosterSize;
      this.nextWolfRound = round + this.rng.wolves.int(CONFIG.wolves.intervalMin, CONFIG.wolves.intervalMax);
    } else {
      this.totalThisRound = this.mode === 'solo' ? soloZombieCount(round) : coopZombieCount(round, this.rosterSize);
    }
    this.queued = this.totalThisRound;
    this.spawnInMs = 0;
    this.dropsThisRound = 0;
    this.wolfMaxAmmoSpawned = false;
    this.events.push({ type: 'roundStarted', round, count: this.totalThisRound });
  }

  private updateSpawning(deltaMs: number, players: readonly SimPlayer[]): void {
    this.spawnInMs -= deltaMs;
    const activeCap = this.roundKind === 'wolves'
      ? Math.min(CONFIG.zombie.maxAlive, CONFIG.wolves.maxActivePerPlayer * this.rosterSize)
      : CONFIG.zombie.maxAlive;
    if (this.spawnInMs > 0 || this.queued <= 0 || this.aliveCount >= activeCap) return;
    const spawned = this.spawnEnemy(players);
    if (spawned !== null) this.spawnInMs = this.roundKind === 'wolves' ? CONFIG.wolves.spawnIntervalMs : spawnIntervalMs(this.round);
  }

  private spawnEnemy(players: readonly SimPlayer[]): SimEnemy | null {
    if (this.roundKind === 'wolves') return this.spawnWolf(players);
    const activePlayers = players.filter((player) => player.connected && !player.downed && player.spectating !== true);
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

  private spawnWolf(players: readonly SimPlayer[]): SimEnemy | null {
    const activePlayers = players.filter((player) => player.connected && !player.downed && player.spectating !== true);
    if (activePlayers.length === 0) return null;
    const banks = FOG_BANKS.filter((bank) => this.isRoomUnlocked(bank.room));
    if (banks.length === 0) return null;
    const weights = banks.map((bank) => {
      const nearest = Math.min(...activePlayers.map((player) => Math.hypot(player.x - bank.x, player.z - bank.z)));
      return 1 / (nearest + CONFIG.navigation.windowDistanceWeightOffsetM);
    });
    const bank = banks[this.rng.wolves.weightedIndex(weights)];
    if (bank === undefined) return null;
    const healthIndex = Math.min(Math.max(0, this.wolfAppearance - 1), CONFIG.wolves.healthByAppearance.length - 1);
    const maxHp = CONFIG.wolves.healthByAppearance[healthIndex] ?? CONFIG.wolves.healthByAppearance[0];
    const enemy: SimEnemy = {
      id: this.nextEnemyId,
      kind: 'wolf',
      state: 'spawn',
      speedTier: 'sprint',
      x: bank.x,
      y: bank.y,
      z: bank.z,
      yaw: 0,
      hp: maxHp,
      maxHp,
      speed: CONFIG.wolves.speedMps,
      barrierId: bank.id,
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
    if (enemy.kind === 'wolf') {
      this.updateWolf(enemy, deltaMs, players);
      return;
    }
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
      if (enemy.stateTimeMs >= CONFIG.zombie.attackCooldownMs) {
        if (distanceToTarget <= CONFIG.zombie.attackRangeM) {
          enemy.stateTimeMs -= CONFIG.zombie.attackCooldownMs;
          enemy.attackApplied = false;
        } else this.changeState(enemy, 'chase');
      }
      return;
    }
    if (distanceToTarget <= CONFIG.zombie.attackRangeM) {
      this.changeState(enemy, 'attack');
      return;
    }
    this.chase(enemy, target, deltaMs);
  }

  private updateWolf(enemy: SimEnemy, deltaMs: number, players: readonly SimPlayer[]): void {
    const target = this.nearestPlayer(enemy, players);
    if (target !== null) enemy.targetPlayerId = target.id;
    if (enemy.state === 'spawn') {
      enemy.spawnProgress = Math.min(1, enemy.stateTimeMs / CONFIG.wolves.fogSpawnMs);
      if (enemy.spawnProgress >= 1) this.changeState(enemy, 'chase');
      return;
    }
    if (target === null) return;
    if (enemy.state === 'attack') {
      if (!enemy.attackApplied && enemy.stateTimeMs >= CONFIG.wolves.attackWindupMs) {
        enemy.attackApplied = true;
        this.damagePlayer(enemy, target, CONFIG.wolves.damage);
      }
      if (enemy.stateTimeMs >= CONFIG.wolves.attackCooldownMs) {
        if (Math.hypot(target.x - enemy.x, target.y - enemy.y, target.z - enemy.z) <= CONFIG.zombie.attackRangeM) {
          enemy.stateTimeMs -= CONFIG.wolves.attackCooldownMs;
          enemy.attackApplied = false;
        } else this.changeState(enemy, 'chase');
      }
      return;
    }
    if (Math.hypot(target.x - enemy.x, target.y - enemy.y, target.z - enemy.z) <= CONFIG.zombie.attackRangeM) {
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
      const player = players.find((candidate) => candidate.id === playerId && candidate.connected && !candidate.downed && candidate.spectating !== true);
      if (player === undefined) {
        this.interactionByPlayer.delete(playerId);
        continue;
      }
      const target = this.getInteractionTarget(player, players);
      if (target === null || target.kind === 'barrier' || target.kind === 'inactive') {
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
      const requiredMs = target.kind === 'revive'
        ? CONFIG.coop.reviveMs * (this.getCombatState(player.id).perks.includes('zweiterAtem') ? CONFIG.coop.quickReviveMultiplier : 1)
        : CONFIG.controller.interactionHoldMs;
      if (interaction.progressMs < requiredMs) continue;
      interaction.completed = true;
      this.executeInteraction(player, target, players);
    }
  }

  private executeInteraction(player: SimPlayer, target: InteractionTarget, players: readonly SimPlayer[]): void {
    if (target.kind === 'revive') {
      const teammate = players.find((candidate) => candidate.id === target.id && candidate.downed);
      if (teammate !== undefined) this.revivePlayer(teammate, player);
      return;
    }
    if (target.kind === 'power') {
      if (this.powerOn) return;
      this.powerOn = true;
      this.powerActivationElapsedMs = 0;
      this.events.push({ type: 'powerActivated', playerId: player.id });
      return;
    }
    if (target.kind === 'perk') {
      const combat = this.getCombatState(player.id);
      if (!this.powerOn || combat.perks.includes(target.id) || combat.pendingPerk !== ''
        || combat.perks.length >= CONFIG.perkRuntime.maxOwned || !this.spendPoints(player, target.cost, 'perk purchase')) return;
      combat.pendingPerk = target.id;
      combat.actionLockedUntilMs = this.elapsedMs + CONFIG.perkRuntime.purchaseAnimationMs;
      this.cancelReload(combat);
      this.events.push({ type: 'perkPurchaseStarted', playerId: player.id, perkId: target.id, cost: target.cost });
      return;
    }
    if (target.kind === 'forge') {
      const combat = this.getCombatState(player.id);
      const weapon = activeWeapon(combat);
      if (!this.powerOn || this.forge.phase !== 'idle' || weapon.upgraded
        || !this.spendPoints(player, CONFIG.economy.forgeUpgrade, 'Forge upgrade')) return;
      this.cancelReload(combat);
      combat.actionLockedUntilMs = this.elapsedMs + CONFIG.forge.animationMs;
      this.forge.phase = 'upgrading';
      this.forge.playerId = player.id;
      this.forge.weaponId = weapon.id;
      this.forge.weaponIndex = combat.activeWeaponIndex;
      this.forge.remainingMs = CONFIG.forge.animationMs;
      this.events.push({ type: 'forgeStarted', playerId: player.id, weaponId: weapon.id, cost: CONFIG.economy.forgeUpgrade });
      return;
    }
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
        const cost = owned.upgraded
          ? CONFIG.economy.upgradedWallAmmo
          : Math.round(wallBuy.cost * CONFIG.economy.wallAmmoFactor);
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
        if (purchaser !== undefined) this.awardPoints(purchaser, CONFIG.economy.mysteryCrate, 'Puppe refund', true, false);
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
      const canKill = this.effects.instaKillRemainingMs > 0 || distance <= CONFIG.combat.grenadeKillRadiusM;
      if (canKill && (this.effects.instaKillRemainingMs > 0 || damage >= enemy.hp)) {
        kills += 1;
        this.killEnemy(enemy, 'explosive', grenade.ownerId);
        continue;
      }
      enemy.hp = Math.max(1, enemy.hp - damage);
      if (enemy.kind !== 'wolf') {
        enemy.kind = 'crawler';
        enemy.speed = CONFIG.zombie.crawlerSpeed;
      }
      enemy.crawlerUntouchedMs = 0;
    }
    const owner = players.find((candidate) => candidate.id === grenade.ownerId);
    if (owner !== undefined && kills > 0) {
      const points = kills * CONFIG.points.killExplosive;
      this.awardPoints(owner, points, 'explosive kill');
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

  private awardPoints(player: SimPlayer, baseAmount: number, reason: string, emitTransaction: boolean = true, earned: boolean = true): number {
    const amount = earned && this.effects.doublePointsRemainingMs > 0 ? baseAmount * 2 : baseAmount;
    player.points += amount;
    if (earned) this.getCombatState(player.id).pointsEarned += amount;
    if (emitTransaction) this.events.push({ type: 'pointTransaction', playerId: player.id, amount, reason });
    return amount;
  }

  private updatePowerActivation(deltaMs: number): void {
    if (!this.powerOn || this.powerActivationElapsedMs >= CONFIG.power.activationMs) return;
    this.powerActivationElapsedMs = Math.min(CONFIG.power.activationMs, this.powerActivationElapsedMs + deltaMs);
  }

  private updateForge(deltaMs: number, players: readonly SimPlayer[]): void {
    if (this.forge.phase !== 'upgrading') return;
    this.forge.remainingMs = Math.max(0, this.forge.remainingMs - deltaMs);
    if (this.forge.remainingMs > 0) return;
    const playerId = this.forge.playerId;
    const weaponId = this.forge.weaponId;
    const player = players.find((candidate) => candidate.id === playerId);
    const combat = this.combatByPlayer.get(playerId);
    const weapon = combat?.weapons[this.forge.weaponIndex];
    if (player === undefined || combat === undefined || weapon === undefined || weapon.id !== weaponId) {
      if (weaponId !== '') this.events.push({ type: 'forgeCancelled', playerId, weaponId });
      this.resetForge();
      return;
    }
    weapon.upgraded = true;
    weapon.magazine = weaponMagazineCapacity(weapon);
    weapon.reserve = CONFIG.weapons[weapon.id].reserve;
    weapon.readyAtMs = this.elapsedMs;
    combat.activeWeaponIndex = this.forge.weaponIndex;
    this.events.push({
      type: 'forgeCompleted',
      playerId,
      weaponId: weapon.id,
      magazine: weapon.magazine,
      reserve: weapon.reserve,
    });
    this.resetForge();
  }

  private resetForge(): void {
    this.forge.phase = 'idle';
    this.forge.playerId = '';
    this.forge.weaponId = '';
    this.forge.weaponIndex = -1;
    this.forge.remainingMs = 0;
  }

  private updatePlayerLifecycle(deltaMs: number, players: readonly SimPlayer[]): void {
    for (const player of players) {
      const life = this.getLifeState(player.id);
      if (player.downed) {
        if (this.mode === 'solo' && life.selfReviveRemainingMs > 0) {
          life.selfReviveRemainingMs = Math.max(0, life.selfReviveRemainingMs - deltaMs);
          if (life.selfReviveRemainingMs === 0) this.revivePlayer(player);
        } else if (this.mode === 'coop') {
          life.bleedoutRemainingMs = Math.max(0, life.bleedoutRemainingMs - deltaMs);
          if (life.bleedoutRemainingMs === 0) {
            player.downed = false;
            player.spectating = true;
            life.dead = true;
            this.savedDownInventory.delete(player.id);
            this.events.push({ type: 'playerBledOut', playerId: player.id });
          }
        }
        continue;
      }
      if (life.dead || player.spectating === true || player.hp >= player.maxHp) continue;
      if (this.elapsedMs - life.lastDamageAtMs < CONFIG.player.regenDelayMs) continue;
      player.hp = Math.min(player.maxHp, player.hp + player.maxHp * deltaMs / CONFIG.player.regenDurationMs);
    }

    if (this.mode === 'coop' && !this.gameOver) {
      const connected = players.filter((player) => player.connected);
      if (connected.length > 0 && connected.every((player) => player.downed || this.getLifeState(player.id).dead)) {
        this.gameOver = true;
        this.events.push({ type: 'gameOver' });
      }
    }
  }

  private downPlayer(player: SimPlayer): void {
    if (player.downed || player.spectating === true) return;
    const combat = this.getCombatState(player.id);
    const hadSoloRevive = this.mode === 'solo' && combat.perks.includes('zweiterAtem') && combat.selfRevivesRemaining > 0;
    this.savedDownInventory.set(player.id, {
      weapons: combat.weapons.map((weapon) => ({ ...weapon })),
      activeWeaponIndex: combat.activeWeaponIndex,
    });
    combat.weapons.splice(0, combat.weapons.length, {
      id: 'melder',
      magazine: CONFIG.weapons.melder.magazine,
      reserve: CONFIG.weapons.melder.reserve,
      upgraded: false,
      readyAtMs: this.elapsedMs,
    });
    combat.activeWeaponIndex = 0;
    combat.perks.splice(0, combat.perks.length);
    combat.pendingPerk = '';
    combat.actionLockedUntilMs = 0;
    this.cancelReload(combat);
    player.maxHp = CONFIG.player.maxHp;
    player.hp = 0;
    player.downed = true;
    const life = this.getLifeState(player.id);
    life.lastDamageAtMs = this.elapsedMs;
    life.bleedoutRemainingMs = this.mode === 'coop' ? CONFIG.coop.bleedoutMs : 0;
    life.selfReviveRemainingMs = hadSoloRevive ? CONFIG.perkRuntime.soloSelfReviveMs : 0;
    if (hadSoloRevive) combat.selfRevivesRemaining -= 1;
    this.events.push({ type: 'playerDowned', playerId: player.id, selfRevive: hadSoloRevive });
    if (this.mode === 'solo' && !hadSoloRevive) {
      this.gameOver = true;
      this.events.push({ type: 'gameOver' });
    }
  }

  private revivePlayer(player: SimPlayer, reviver?: SimPlayer): void {
    const life = this.getLifeState(player.id);
    const combat = this.getCombatState(player.id);
    const saved = this.savedDownInventory.get(player.id);
    if (saved !== undefined) {
      combat.weapons.splice(0, combat.weapons.length, ...saved.weapons.map((weapon) => ({ ...weapon })));
      combat.activeWeaponIndex = Math.min(saved.activeWeaponIndex, combat.weapons.length - 1);
      this.savedDownInventory.delete(player.id);
    }
    player.downed = false;
    player.spectating = false;
    player.maxHp = CONFIG.player.maxHp;
    player.hp = CONFIG.player.maxHp;
    player.invulnerableUntilMs = this.elapsedMs + CONFIG.player.postHitInvulnMs;
    life.bleedoutRemainingMs = 0;
    life.selfReviveRemainingMs = 0;
    life.dead = false;
    life.lastDamageAtMs = this.elapsedMs;
    if (reviver !== undefined) this.awardPoints(reviver, CONFIG.coop.reviveAward, 'revive');
    this.events.push({ type: 'playerRevived', playerId: player.id, ...(reviver === undefined ? {} : { reviverId: reviver.id }) });
  }

  private returnPlayersAtRoundStart(players: readonly SimPlayer[]): void {
    players.forEach((player, index) => {
      const life = this.getLifeState(player.id);
      if (!life.dead && !life.reconnectPending) return;
      const reason = life.dead ? 'bleedout' : 'reconnect';
      const combat = this.getCombatState(player.id);
      if (life.dead) {
        combat.weapons.splice(0, combat.weapons.length, {
          id: 'melder',
          magazine: CONFIG.weapons.melder.magazine,
          reserve: CONFIG.weapons.melder.reserve,
          upgraded: false,
          readyAtMs: this.elapsedMs,
        });
        combat.activeWeaponIndex = 0;
        combat.perks.splice(0, combat.perks.length);
        combat.pendingPerk = '';
        combat.grenades = CONFIG.combat.maxGrenades;
      }
      if (player.connected) {
        const spawn = START_POSITIONS[index % START_POSITIONS.length] ?? CONFIG.map.startPosition;
        player.x = spawn.x;
        player.y = spawn.y;
        player.z = spawn.z;
        player.spectating = false;
        player.downed = false;
        player.maxHp = combat.perks.includes('eisenbrau') ? CONFIG.perkRuntime.eisenbrauHp : CONFIG.player.maxHp;
        player.hp = player.maxHp;
        player.invulnerableUntilMs = this.elapsedMs + CONFIG.player.postHitInvulnMs;
        life.dead = false;
        life.reconnectPending = false;
        life.bleedoutRemainingMs = 0;
        life.selfReviveRemainingMs = 0;
        this.events.push({ type: 'playerReturned', playerId: player.id, reason });
      }
    });
  }

  private updatePowerups(deltaMs: number, players: readonly SimPlayer[]): void {
    this.effects.instaKillRemainingMs = Math.max(0, this.effects.instaKillRemainingMs - deltaMs);
    this.effects.doublePointsRemainingMs = Math.max(0, this.effects.doublePointsRemainingMs - deltaMs);
    if (this.effects.nukeRemainingMs > 0) {
      this.effects.nukeRemainingMs = Math.max(0, this.effects.nukeRemainingMs - deltaMs);
      if (this.effects.nukeRemainingMs === 0) {
        for (const enemy of this.enemies.values()) {
          if (enemy.state !== 'dead') this.killEnemy(enemy, 'explosive', undefined, false);
        }
      }
    }
    for (const powerup of [...this.powerups.values()]) {
      powerup.remainingMs = Math.max(0, powerup.remainingMs - deltaMs);
      if (powerup.remainingMs === 0) {
        this.powerups.delete(powerup.id);
        continue;
      }
      const collector = players.find((player) => player.connected && !player.downed && player.spectating !== true
        && Math.hypot(player.x - powerup.x, player.y - powerup.y, player.z - powerup.z) <= CONFIG.powerups.pickupRadiusM);
      if (collector === undefined) continue;
      this.powerups.delete(powerup.id);
      this.applyPowerup(powerup.type, collector, players);
      this.events.push({ type: 'powerupCollected', powerupId: powerup.id, powerupType: powerup.type, playerId: collector.id });
    }
  }

  private applyPowerup(type: PowerupId, collector: SimPlayer, players: readonly SimPlayer[]): void {
    if (type === 'instaKill') this.effects.instaKillRemainingMs = CONFIG.powerups.instaKillMs;
    if (type === 'doublePoints') this.effects.doublePointsRemainingMs = CONFIG.powerups.doublePointsMs;
    if (type === 'nuke') {
      this.effects.nukeRemainingMs = CONFIG.powerups.nukeDelayMs;
      for (const player of players) this.awardPoints(player, CONFIG.points.nukeAward, 'nuke');
    }
    if (type === 'maxAmmo') {
      for (const player of players) {
        const combat = this.getCombatState(player.id);
        for (const weapon of combat.weapons) weapon.reserve = CONFIG.weapons[weapon.id].reserve;
        combat.grenades = CONFIG.combat.maxGrenades;
      }
    }
    if (type === 'carpenter') {
      for (const barrier of this.barriers.values()) barrier.boards = CONFIG.barriers.boardSlots;
      for (const player of players) this.awardPoints(player, CONFIG.points.carpenterAward, 'carpenter');
    }
    void collector;
  }

  private spawnPowerup(type: PowerupId, x: number, y: number, z: number, guaranteed: boolean): SimPowerup {
    const powerup: SimPowerup = {
      id: this.nextPowerupId,
      type,
      x,
      y,
      z,
      remainingMs: CONFIG.powerups.despawnMs,
      guaranteed,
    };
    this.nextPowerupId += 1;
    this.powerups.set(powerup.id, powerup);
    this.events.push({ type: 'powerupSpawned', powerupId: powerup.id, powerupType: type, guaranteed });
    return powerup;
  }

  private rollPowerupType(): PowerupId {
    const types = Object.keys(CONFIG.powerups.weights) as PowerupId[];
    const weights = types.map((type) => CONFIG.powerups.weights[type]);
    return types[this.rng.drops.weightedIndex(weights)] ?? 'maxAmmo';
  }

  private updateRepair(deltaMs: number, players: readonly SimPlayer[]): void {
    for (const barrier of this.barriers.values()) barrier.repairProgressMs = 0;
    for (const playerId of this.repairHeld) {
      const player = players.find((candidate) => candidate.id === playerId && candidate.connected && !candidate.downed && candidate.spectating !== true);
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
        const points = this.awardPoints(player, CONFIG.points.boardRepair, 'barrier repair', false);
        this.events.push({ type: 'boardRepaired', barrierId: barrier.id, boards: barrier.boards, playerId: player.id, points });
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
      if (state.pendingPerk !== '' && this.elapsedMs >= state.actionLockedUntilMs) {
        const perkId = state.pendingPerk;
        state.pendingPerk = '';
        state.actionLockedUntilMs = 0;
        this.grantPerk(player, perkId);
        this.events.push({ type: 'perkGranted', playerId: player.id, perkId });
      }
      if (state.reloadingWeaponIndex < 0 || this.elapsedMs < state.reloadFinishAtMs) continue;
      const weapon = state.weapons[state.reloadingWeaponIndex];
      if (weapon !== undefined) {
        const definition = CONFIG.weapons[weapon.id];
        const capacity = weaponMagazineCapacity(weapon);
        const transfer = definition.reloadStyle === 'shell'
          ? Math.min(1, capacity - weapon.magazine, weapon.reserve)
          : Math.min(capacity - weapon.magazine, weapon.reserve);
        weapon.magazine += transfer;
        weapon.reserve -= transfer;
        if (definition.reloadStyle === 'shell' && weapon.magazine < capacity && weapon.reserve > 0) {
          const reloadMultiplier = state.perks.includes('schnellwasser') ? CONFIG.perkRuntime.schnellwasserReloadMultiplier : 1;
          state.reloadFinishAtMs = this.elapsedMs + definition.reloadMs * reloadMultiplier;
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
      if (!player.connected || player.downed || player.spectating === true) continue;
      const candidate = Math.hypot(player.x - enemy.x, player.y - enemy.y, player.z - enemy.z);
      if (candidate >= distance) continue;
      nearest = player;
      distance = candidate;
    }
    return nearest;
  }

  private damagePlayer(enemy: SimEnemy, player: SimPlayer, amount: number = CONFIG.zombie.hitDamage): void {
    if (!this.damagePlayerAmount(player, amount)) return;
    this.events.push({ type: 'playerDamaged', playerId: player.id, enemyId: enemy.id, damage: amount });
  }

  private damagePlayerAmount(player: SimPlayer, amount: number): boolean {
    if (this.elapsedMs < player.invulnerableUntilMs || player.downed || player.spectating === true) return false;
    player.hp = Math.max(0, player.hp - Math.max(0, amount));
    player.invulnerableUntilMs = this.elapsedMs + CONFIG.player.postHitInvulnMs;
    this.getLifeState(player.id).lastDamageAtMs = this.elapsedMs;
    if (player.hp === 0) this.downPlayer(player);
    return true;
  }

  private killEnemy(
    enemy: SimEnemy,
    method: 'melee' | 'explosive' | 'debug' | 'bullet',
    playerId?: string,
    allowDrop: boolean = true,
  ): void {
    enemy.hp = 0;
    this.changeState(enemy, 'dead');
    this.events.push({ type: 'enemyKilled', enemyId: enemy.id, playerId, method });
    if (allowDrop && method !== 'debug' && this.dropsThisRound < CONFIG.powerups.maxDropsPerRound
      && this.rng.drops.next() < CONFIG.powerups.dropChancePerKill) {
      this.dropsThisRound += 1;
      this.spawnPowerup(this.rollPowerupType(), enemy.x, enemy.y + CONFIG.powerups.spawnHeightM, enemy.z, false);
    }
    if (enemy.kind === 'wolf' && this.roundKind === 'wolves' && this.queued === 0 && this.aliveCount === 0 && !this.wolfMaxAmmoSpawned) {
      this.wolfMaxAmmoSpawned = true;
      this.spawnPowerup('maxAmmo', enemy.x, enemy.y + CONFIG.powerups.spawnHeightM, enemy.z, true);
    }
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
