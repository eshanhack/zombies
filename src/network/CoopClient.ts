import { Client, type Room } from '@colyseus/sdk';
import { CONFIG, type WeaponId } from '../config.js';
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
}

interface WireState {
  seed: number;
  roomCode: string;
  hostId: string;
  phase: string;
  started: boolean;
  round: number;
  spawned: number;
  queued: number;
  alive: number;
  simulationTimeMs: number;
  players: {
    forEach(callback: (player: WirePlayer, key: string) => void): void;
  };
  barriers: { forEach(callback: (barrier: NetworkBarrierView, key: string) => void): void };
  enemies: { forEach(callback: (enemy: NetworkEnemyView, key: string) => void): void };
}

export interface NetworkBarrierView {
  id: string;
  room: string;
  boards: number;
  repairProgressMs: number;
}

export interface NetworkEnemyView {
  id: number;
  kind: 'zombie' | 'crawler';
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
  round: number;
  elapsedMs: number;
  spawned: number;
  queued: number;
  alive: number;
  phase: string;
  barriers: NetworkBarrierView[];
  enemies: NetworkEnemyView[];
  localHp: number;
  localMaxHp: number;
  localPoints: number;
  localWeapons: NetworkWeaponView[];
  localActiveWeaponIndex: number;
  localReloading: boolean;
  localReloadRemainingMs: number;
  localStats: { shots: number; hits: number; kills: number; headshots: number; pointsEarned: number };
}

export interface NetworkWeaponView {
  id: WeaponId;
  magazine: number;
  reserve: number;
  upgraded: boolean;
}

export type ClientAction =
  | { type: 'melee' }
  | { type: 'repair'; held: boolean }
  | { type: 'fire'; ads: boolean }
  | { type: 'reload' }
  | { type: 'switch'; index: number };

export type NetworkFeedback =
  | { kind: 'combat'; source: 'fire' | 'melee'; accepted: boolean; hit: boolean; killed: boolean; headshot?: boolean; points: number; damage: number; enemyId: number | null }
  | { kind: 'points'; amount: number; reason: string }
  | { kind: 'damage'; amount: number; enemyId: number }
  | { kind: 'reload'; accepted: boolean; weaponId: WeaponId; finishAtMs: number };

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

  constructor(endpoint = import.meta.env.VITE_GAME_SERVER ?? CONFIG.coop.localServerUrl) {
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
    this.room?.send('action', action);
  }

  async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (room !== null) await room.leave(true);
  }

  private async connect(roomPromise: Promise<Room>): Promise<void> {
    if (this.room !== null) await this.leave();
    const room = await roomPromise;
    this.room = room;
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
    const poses: RemotePlayerPose[] = [];
    let local: AuthoritativePlayerState | null = null;
    let localHp: number = CONFIG.player.maxHp;
    let localMaxHp: number = CONFIG.player.maxHp;
    let localPoints: number = CONFIG.points.starting;
    let localWeapons: NetworkWeaponView[] = [{ id: 'melder', magazine: CONFIG.weapons.melder.magazine, reserve: CONFIG.weapons.melder.reserve, upgraded: false }];
    let localActiveWeaponIndex = 0;
    let localReloading = false;
    let localReloadRemainingMs = 0;
    let localStats = { shots: 0, hits: 0, kills: 0, headshots: 0, pointsEarned: 0 };
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
      poses.push({
        id: player.id,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw,
        connected: player.connected,
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
        }));
        localActiveWeaponIndex = player.activeWeaponIndex;
        localReloading = player.reloading;
        localReloadRemainingMs = player.reloadRemainingMs;
        localStats = { shots: player.shots, hits: player.hits, kills: player.kills, headshots: player.headshots, pointsEarned: player.pointsEarned };
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
    this.simulationListener({
      round: state.round,
      elapsedMs: state.simulationTimeMs,
      spawned: state.spawned,
      queued: state.queued,
      alive: state.alive,
      phase: state.phase,
      barriers,
      enemies,
      localHp,
      localMaxHp,
      localPoints,
      localWeapons,
      localActiveWeaponIndex,
      localReloading,
      localReloadRemainingMs,
      localStats,
    });
  }
}

function normalizeWeaponId(value: string): WeaponId {
  return Object.prototype.hasOwnProperty.call(CONFIG.weapons, value) ? value as WeaponId : 'melder';
}
