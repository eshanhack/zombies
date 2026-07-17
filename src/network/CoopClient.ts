import { Client, type Room } from '@colyseus/sdk';
import { CONFIG, type PerkId, type PowerupId, type WeaponId } from '../config.js';
import type { MovementInput } from '../shared/movement.js';
import type { AuthoritativePlayerState } from '../game/FirstPersonController.js';
import type { RemotePlayerPose } from '../game/PreludeScene.js';

interface WirePlayer {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  spectating: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  staminaMs: number;
  lastProcessedInput: number;
  grounded: boolean;
  hp: number;
  maxHp: number;
  points: number;
  weapons: { forEach(callback: (weapon: { id: string; magazine: number; reserve: number; upgraded: boolean }, index: number) => void): void };
  activeWeaponIndex: number;
  reloading: boolean;
  reloadRemainingMs: number;
  shots: number;
  hits: number;
  kills: number;
  headshots: number;
  pointsEarned: number;
  doorsOpened: number;
  crateRolls: number;
  grenades: number;
  perks: { forEach(callback: (perk: string, index: number) => void): void };
  pendingPerk: string;
  actionLockRemainingMs: number;
  selfRevivesRemaining: number;
  bleedoutRemainingMs: number;
  selfReviveRemainingMs: number;
  dead: boolean;
  reconnectPending: boolean;
  downed: boolean;
}

interface WireState {
  protocolVersion: number;
  seed: number;
  roomCode: string;
  hostId: string;
  phase: string;
  started: boolean;
  round: number;
  spawned: number;
  queued: number;
  alive: number;
  roundKind: string;
  nextWolfRound: number;
  wolfAppearance: number;
  powerOn: boolean;
  powerActivationElapsedMs: number;
  gameOver: boolean;
  instaKillRemainingMs: number;
  doublePointsRemainingMs: number;
  nukeRemainingMs: number;
  simulationTimeMs: number;
  serverTimeMs: number;
  openDoors: { forEach(callback: (doorId: string) => void): void };
  crateLocationId: string;
  cratePhase: string;
  cratePurchaserId: string;
  crateWeaponId: string;
  cratePendingPuppe: boolean;
  crateSpinRemainingMs: number;
  crateGrabRemainingMs: number;
  crateUsesAtLocation: number;
  forgePhase: string;
  forgePlayerId: string;
  forgeWeaponId: string;
  forgeRemainingMs: number;
  players: {
    forEach(callback: (player: WirePlayer, key: string) => void): void;
  };
  barriers: { forEach(callback: (barrier: NetworkBarrierView, key: string) => void): void };
  enemies: { forEach(callback: (enemy: NetworkEnemyView, key: string) => void): void };
  grenades: { forEach(callback: (grenade: NetworkGrenadeView, key: string) => void): void };
  powerups: { forEach(callback: (powerup: NetworkPowerupView, key: string) => void): void };
}

async function waitForProtocolVersion(room: Room): Promise<number> {
  const initialVersion = Number((room.state as Partial<WireState>).protocolVersion);
  if (Number.isFinite(initialVersion)) return initialVersion;

  return new Promise<number>((resolve, reject) => {
    let settled = false;

    const cleanup = (): void => {
      clearTimeout(timeoutId);
      room.onStateChange.remove(onStateChange);
      room.onLeave.remove(onLeave);
    };
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onStateChange = (state: unknown): void => {
      const version = Number((state as Partial<WireState>).protocolVersion);
      if (!Number.isFinite(version)) return;
      finish(() => resolve(version));
    };
    const onLeave = (): void => {
      finish(() => reject(new Error('Server connection closed before the protocol handshake completed.')));
    };
    const timeoutId = setTimeout(() => {
      finish(() => reject(new Error('Server protocol handshake timed out. Check the server connection and try again.')));
    }, CONFIG.coop.handshakeTimeoutMs);

    room.onStateChange(onStateChange);
    room.onLeave(onLeave);
  });
}

export interface NetworkBarrierView {
  id: string;
  room: string;
  boards: number;
  repairProgressMs: number;
}

export interface NetworkEnemyView {
  id: number;
  kind: 'zombie' | 'crawler' | 'wolf';
  state: 'spawn' | 'tear' | 'vault' | 'chase' | 'attack' | 'dead';
  speedTier: 'walk' | 'jog' | 'sprint';
  x: number;
  y: number;
  z: number;
  yaw: number;
  hp: number;
  maxHp: number;
  speed: number;
  barrierId: string;
  targetPlayerId: string;
  stateTimeMs: number;
  spawnProgress: number;
}

export interface NetworkGameView {
  localPlayerId: string;
  serverTimeMs: number;
  round: number;
  elapsedMs: number;
  spawned: number;
  queued: number;
  alive: number;
  phase: string;
  roundKind: 'zombies' | 'wolves';
  nextWolfRound: number;
  wolfAppearance: number;
  powerOn: boolean;
  powerActivationElapsedMs: number;
  gameOver: boolean;
  instaKillRemainingMs: number;
  doublePointsRemainingMs: number;
  nukeRemainingMs: number;
  barriers: NetworkBarrierView[];
  players: NetworkPlayerView[];
  enemies: NetworkEnemyView[];
  grenades: NetworkGrenadeView[];
  powerups: NetworkPowerupView[];
  openDoors: string[];
  crate: NetworkCrateView;
  forge: NetworkForgeView;
  localHp: number;
  localMaxHp: number;
  localPoints: number;
  localWeapons: NetworkWeaponView[];
  localActiveWeaponIndex: number;
  localReloading: boolean;
  localReloadRemainingMs: number;
  localGrenades: number;
  localPerks: PerkId[];
  localPendingPerk: PerkId | '';
  localActionLockRemainingMs: number;
  localSelfRevivesRemaining: number;
  localBleedoutRemainingMs: number;
  localSelfReviveRemainingMs: number;
  localDowned: boolean;
  localDead: boolean;
  localSpectating: boolean;
  localReconnectPending: boolean;
  localStats: { shots: number; hits: number; kills: number; headshots: number; pointsEarned: number; doorsOpened: number; crateRolls: number };
}

export interface NetworkPlayerView {
  id: string;
  x: number;
  y: number;
  z: number;
  connected: boolean;
  downed: boolean;
  spectating: boolean;
  perks: PerkId[];
}

export interface NetworkPowerupView {
  id: number;
  powerupType: PowerupId;
  x: number;
  y: number;
  z: number;
  remainingMs: number;
  guaranteed: boolean;
}

export interface NetworkGrenadeView {
  id: number;
  ownerId: string;
  x: number;
  y: number;
  z: number;
  fuseRemainingMs: number;
}

export interface NetworkCrateView {
  activeLocationId: string;
  phase: 'closed' | 'spinning' | 'available';
  purchaserId: string;
  weaponId: WeaponId | '';
  pendingPuppe: boolean;
  spinRemainingMs: number;
  grabRemainingMs: number;
  usesAtLocation: number;
}

export interface NetworkForgeView {
  phase: 'idle' | 'upgrading';
  playerId: string;
  weaponId: WeaponId | '';
  remainingMs: number;
}

export interface NetworkWeaponView {
  id: WeaponId;
  magazine: number;
  reserve: number;
  upgraded: boolean;
  readyAtMs: number;
}

export type ClientAction =
  | { type: 'melee' }
  | { type: 'interact'; held: boolean }
  | { type: 'fire'; ads: boolean; simulationTimeMs: number; yaw: number; pitch: number }
  | { type: 'reload' }
  | { type: 'switch'; index: number }
  | { type: 'grenade'; cookedMs: number };

export type NetworkFeedback =
  | { kind: 'combat'; source: 'fire' | 'melee'; accepted: boolean; hit: boolean; killed: boolean; headshot?: boolean; points: number; damage: number; enemyId: number | null }
  | { kind: 'points'; amount: number; reason: string }
  | { kind: 'damage'; amount: number; enemyId: number }
  | { kind: 'reload'; accepted: boolean; weaponId: WeaponId; finishAtMs: number }
  | { kind: 'game'; event: { type: string; [key: string]: unknown } };

export interface LobbyPlayerView {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  spectating: boolean;
  isHost: boolean;
  isSelf: boolean;
}

export interface LobbyView {
  roomCode: string;
  seed: number;
  phase: string;
  started: boolean;
  isHost: boolean;
  players: LobbyPlayerView[];
}

type LobbyListener = (view: LobbyView) => void;
type MovementListener = (local: AuthoritativePlayerState | null, players: readonly RemotePlayerPose[]) => void;
type SimulationListener = (view: NetworkGameView) => void;
type FeedbackListener = (feedback: NetworkFeedback) => void;

export class CoopClient {
  private readonly client: Client;
  private room: Room | null = null;
  private listener: LobbyListener = () => undefined;
  private movementListener: MovementListener = () => undefined;
  private simulationListener: SimulationListener = () => undefined;
  private feedbackListener: FeedbackListener = () => undefined;
  private actionSequence = 0;

  constructor(endpoint = import.meta.env.VITE_GAME_SERVER_URL ?? CONFIG.coop.localServerUrl) {
    this.client = new Client(endpoint);
  }

  onLobbyChange(listener: LobbyListener): void {
    this.listener = listener;
  }

  onMovement(listener: MovementListener): void {
    this.movementListener = listener;
  }

  onSimulation(listener: SimulationListener): void {
    this.simulationListener = listener;
  }

  onFeedback(listener: FeedbackListener): void {
    this.feedbackListener = listener;
  }

  async create(name: string): Promise<void> {
    await this.connect(this.client.create('stahlbunker', { name }));
  }

  async join(roomCode: string, name: string): Promise<void> {
    await this.connect(this.client.joinById(roomCode.trim().toUpperCase(), { name }));
  }

  hasResumeToken(): boolean {
    return this.readResumeToken() !== null;
  }

  async resume(): Promise<boolean> {
    const saved = this.readResumeToken();
    if (saved === null) return false;
    await this.connect(this.client.reconnect(saved.reconnectionToken));
    return true;
  }

  setReady(ready: boolean): void {
    this.room?.send('ready', ready);
  }

  start(): void {
    this.room?.send('start');
  }

  sendInput(input: MovementInput): void {
    this.room?.send('input', input);
  }

  sendAction(action: ClientAction): void {
    this.actionSequence += 1;
    this.room?.send('action', { ...action, sequence: this.actionSequence });
  }

  async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (room !== null) await room.leave(true);
    try {
      localStorage.removeItem(CONFIG.storage.resumeKey);
    } catch {
      // Storage may be unavailable; the server still closes the seat explicitly.
    }
  }

  private async connect(roomPromise: Promise<Room>): Promise<void> {
    if (this.room !== null) await this.leave();
    const room = await roomPromise;
    let serverProtocolVersion: number;
    try {
      serverProtocolVersion = await waitForProtocolVersion(room);
    } catch (error) {
      await room.leave(true);
      throw error;
    }
    if (serverProtocolVersion !== CONFIG.coop.protocolVersion) {
      await room.leave(true);
      throw new Error(
        `Server version mismatch · client ${CONFIG.coop.protocolVersion} / server ${serverProtocolVersion}. Refresh after the deployment completes.`,
      );
    }
    this.room = room;
    this.actionSequence = 0;
    room.onMessage('runStarted', () => undefined);
    room.onMessage('combatFeedback', (message: Omit<Extract<NetworkFeedback, { kind: 'combat' }>, 'kind'>) => {
      this.feedbackListener({ kind: 'combat', ...message });
    });
    room.onMessage('pointTransaction', (message: { amount: number; reason: string }) => {
      this.feedbackListener({ kind: 'points', amount: message.amount, reason: message.reason });
    });
    room.onMessage('damageFeedback', (message: { amount: number; enemyId: number }) => {
      this.feedbackListener({ kind: 'damage', amount: message.amount, enemyId: message.enemyId });
    });
    room.onMessage('reloadFeedback', (message: { accepted: boolean; weaponId: string; finishAtMs: number }) => {
      this.feedbackListener({ kind: 'reload', accepted: message.accepted, weaponId: normalizeWeaponId(message.weaponId), finishAtMs: message.finishAtMs });
    });
    room.onMessage('gameEvent', (event: { type: string; [key: string]: unknown }) => {
      this.feedbackListener({ kind: 'game', event });
    });
    room.onStateChange(() => this.publish());
    room.onLeave(() => {
      if (this.room === room) this.room = null;
    });
    try {
      localStorage.setItem(CONFIG.storage.resumeKey, JSON.stringify({
        roomCode: room.roomId,
        reconnectionToken: room.reconnectionToken,
      }));
    } catch {
      // Private browsing may disallow persistence; the live session remains valid.
    }
    this.publish();
  }

  private publish(): void {
    const room = this.room;
    if (room === null) return;
    const state = room.state as WireState;
    if (state === null || state.players === undefined) return;
    const players: LobbyPlayerView[] = [];
    const simulationPlayers: NetworkPlayerView[] = [];
    const poses: RemotePlayerPose[] = [];
    let local: AuthoritativePlayerState | null = null;
    let localHp: number = CONFIG.player.maxHp;
    let localMaxHp: number = CONFIG.player.maxHp;
    let localPoints: number = CONFIG.points.starting;
    let localWeapons: NetworkWeaponView[] = [{ id: 'melder', magazine: CONFIG.weapons.melder.magazine, reserve: CONFIG.weapons.melder.reserve, upgraded: false, readyAtMs: 0 }];
    let localActiveWeaponIndex = 0;
    let localReloading = false;
    let localReloadRemainingMs = 0;
    let localGrenades: number = CONFIG.combat.maxGrenades;
    let localPerks: PerkId[] = [];
    let localPendingPerk: PerkId | '' = '';
    let localActionLockRemainingMs = 0;
    let localSelfRevivesRemaining: number = CONFIG.perkRuntime.soloSelfReviveStock;
    let localBleedoutRemainingMs = 0;
    let localSelfReviveRemainingMs = 0;
    let localDowned = false;
    let localDead = false;
    let localSpectating = false;
    let localReconnectPending = false;
    let localStats = { shots: 0, hits: 0, kills: 0, headshots: 0, pointsEarned: 0, doorsOpened: 0, crateRolls: 0 };
    state.players.forEach((player) => {
      players.push({
        id: player.id,
        name: player.name,
        ready: player.ready,
        connected: player.connected,
        spectating: player.spectating,
        isHost: player.id === state.hostId,
        isSelf: player.id === room.sessionId,
      });
      const isSelf = player.id === room.sessionId;
      const playerPerks: PerkId[] = [];
      player.perks?.forEach((perk) => {
        const normalized = normalizePerkId(perk);
        if (normalized !== '') playerPerks.push(normalized);
      });
      simulationPlayers.push({
        id: player.id,
        x: player.x,
        y: player.y,
        z: player.z,
        connected: player.connected,
        downed: player.downed,
        spectating: player.spectating,
        perks: playerPerks,
      });
      poses.push({
        id: player.id,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw,
        pitch: player.pitch,
        vx: player.vx,
        vz: player.vz,
        connected: player.connected,
        downed: player.downed,
        spectating: player.spectating,
        isSelf,
      });
      if (isSelf) {
        localHp = player.hp;
        localMaxHp = player.maxHp;
        localPoints = player.points;
        localWeapons = [];
        player.weapons?.forEach((weapon) => localWeapons.push({
          id: normalizeWeaponId(weapon.id),
          magazine: weapon.magazine,
          reserve: weapon.reserve,
          upgraded: weapon.upgraded,
          readyAtMs: 0,
        }));
        localActiveWeaponIndex = player.activeWeaponIndex;
        localReloading = player.reloading;
        localReloadRemainingMs = player.reloadRemainingMs;
        localGrenades = player.grenades;
        localPerks = [];
        player.perks?.forEach((perk) => {
          const normalized = normalizePerkId(perk);
          if (normalized !== '') localPerks.push(normalized);
        });
        localPendingPerk = normalizePerkId(player.pendingPerk);
        localActionLockRemainingMs = player.actionLockRemainingMs;
        localSelfRevivesRemaining = player.selfRevivesRemaining;
        localBleedoutRemainingMs = player.bleedoutRemainingMs;
        localSelfReviveRemainingMs = player.selfReviveRemainingMs;
        localDowned = player.downed;
        localDead = player.dead;
        localSpectating = player.spectating;
        localReconnectPending = player.reconnectPending;
        localStats = {
          shots: player.shots,
          hits: player.hits,
          kills: player.kills,
          headshots: player.headshots,
          pointsEarned: player.pointsEarned,
          doorsOpened: player.doorsOpened,
          crateRolls: player.crateRolls,
        };
        local = {
          x: player.x,
          y: player.y,
          z: player.z,
          vx: player.vx,
          vy: player.vy,
          vz: player.vz,
          yaw: player.yaw,
          pitch: player.pitch,
          staminaMs: player.staminaMs,
          lastProcessedInput: player.lastProcessedInput,
          grounded: player.grounded,
        };
      }
    });
    players.sort((left, right) => Number(right.isHost) - Number(left.isHost) || left.name.localeCompare(right.name));
    this.listener({
      roomCode: state.roomCode || room.roomId,
      seed: state.seed,
      phase: state.phase,
      started: state.started,
      isHost: state.hostId === room.sessionId,
      players,
    });
    this.movementListener(local, poses);
    const barriers: NetworkBarrierView[] = [];
    state.barriers?.forEach((barrier) => barriers.push({
      id: barrier.id,
      room: barrier.room,
      boards: barrier.boards,
      repairProgressMs: barrier.repairProgressMs,
    }));
    const enemies: NetworkEnemyView[] = [];
    state.enemies?.forEach((enemy) => enemies.push({
      id: enemy.id,
      kind: enemy.kind,
      state: enemy.state,
      speedTier: enemy.speedTier,
      x: enemy.x,
      y: enemy.y,
      z: enemy.z,
      yaw: enemy.yaw,
      hp: enemy.hp,
      maxHp: enemy.maxHp,
      speed: enemy.speed,
      barrierId: enemy.barrierId,
      targetPlayerId: enemy.targetPlayerId,
      stateTimeMs: enemy.stateTimeMs,
      spawnProgress: enemy.spawnProgress,
    }));
    const grenades: NetworkGrenadeView[] = [];
    state.grenades?.forEach((grenade) => grenades.push({
      id: grenade.id,
      ownerId: grenade.ownerId,
      x: grenade.x,
      y: grenade.y,
      z: grenade.z,
      fuseRemainingMs: grenade.fuseRemainingMs,
    }));
    const powerups: NetworkPowerupView[] = [];
    state.powerups?.forEach((powerup) => powerups.push({
      id: powerup.id,
      powerupType: normalizePowerupId(powerup.powerupType),
      x: powerup.x,
      y: powerup.y,
      z: powerup.z,
      remainingMs: powerup.remainingMs,
      guaranteed: powerup.guaranteed,
    }));
    const openDoors: string[] = [];
    state.openDoors?.forEach((doorId) => openDoors.push(doorId));
    this.simulationListener({
      localPlayerId: room.sessionId,
      serverTimeMs: state.serverTimeMs,
      round: state.round,
      elapsedMs: state.simulationTimeMs,
      spawned: state.spawned,
      queued: state.queued,
      alive: state.alive,
      phase: state.phase,
      roundKind: state.roundKind === 'wolves' ? 'wolves' : 'zombies',
      nextWolfRound: state.nextWolfRound,
      wolfAppearance: state.wolfAppearance,
      powerOn: state.powerOn,
      powerActivationElapsedMs: state.powerActivationElapsedMs,
      gameOver: state.gameOver,
      instaKillRemainingMs: state.instaKillRemainingMs,
      doublePointsRemainingMs: state.doublePointsRemainingMs,
      nukeRemainingMs: state.nukeRemainingMs,
      barriers,
      players: simulationPlayers,
      enemies,
      grenades,
      powerups,
      openDoors,
      crate: {
        activeLocationId: state.crateLocationId,
        phase: normalizeCratePhase(state.cratePhase),
        purchaserId: state.cratePurchaserId,
        weaponId: state.crateWeaponId === '' ? '' : normalizeWeaponId(state.crateWeaponId),
        pendingPuppe: state.cratePendingPuppe,
        spinRemainingMs: state.crateSpinRemainingMs,
        grabRemainingMs: state.crateGrabRemainingMs,
        usesAtLocation: state.crateUsesAtLocation,
      },
      forge: {
        phase: state.forgePhase === 'upgrading' ? 'upgrading' : 'idle',
        playerId: state.forgePlayerId,
        weaponId: state.forgeWeaponId === '' ? '' : normalizeWeaponId(state.forgeWeaponId),
        remainingMs: state.forgeRemainingMs,
      },
      localHp,
      localMaxHp,
      localPoints,
      localWeapons,
      localActiveWeaponIndex,
      localReloading,
      localReloadRemainingMs,
      localGrenades,
      localPerks,
      localPendingPerk,
      localActionLockRemainingMs,
      localSelfRevivesRemaining,
      localBleedoutRemainingMs,
      localSelfReviveRemainingMs,
      localDowned,
      localDead,
      localSpectating,
      localReconnectPending,
      localStats,
    });
  }

  private readResumeToken(): { roomCode: string; reconnectionToken: string } | null {
    try {
      const raw = localStorage.getItem(CONFIG.storage.resumeKey);
      if (raw === null) return null;
      const value = JSON.parse(raw) as { roomCode?: unknown; reconnectionToken?: unknown };
      if (typeof value.roomCode !== 'string' || typeof value.reconnectionToken !== 'string' || value.reconnectionToken.length === 0) return null;
      return { roomCode: value.roomCode, reconnectionToken: value.reconnectionToken };
    } catch {
      return null;
    }
  }
}

function normalizeWeaponId(value: string): WeaponId {
  return Object.prototype.hasOwnProperty.call(CONFIG.weapons, value) ? value as WeaponId : 'melder';
}

function normalizeCratePhase(value: string): NetworkCrateView['phase'] {
  return value === 'spinning' || value === 'available' ? value : 'closed';
}

function normalizePerkId(value: string): PerkId | '' {
  return Object.prototype.hasOwnProperty.call(CONFIG.perks, value) ? value as PerkId : '';
}

function normalizePowerupId(value: string): PowerupId {
  return value === 'instaKill' || value === 'doublePoints' || value === 'nuke' || value === 'carpenter' ? value : 'maxAmmo';
}
