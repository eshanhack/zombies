import type { PerkId, PowerupId, RoomId, WeaponId } from '../config.js';

export type GameMode = 'solo' | 'coop';
export type GamePhase = 'menu' | 'lobby' | 'intermission' | 'playing' | 'downed' | 'spectating' | 'gameOver';
export type EnemyKind = 'zombie' | 'crawler' | 'wolf';
export type ZombieState = 'spawn' | 'path' | 'tear' | 'vault' | 'chase' | 'attack' | 'dead';

export interface Vec3Data { x: number; y: number; z: number }

export interface WeaponState {
  id: WeaponId;
  magazine: number;
  reserve: number;
  upgraded: boolean;
}

export interface PlayerStats {
  kills: number;
  headshots: number;
  shots: number;
  hits: number;
  pointsEarned: number;
  doorsOpened: number;
  crateRolls: number;
  revives: number;
  downs: number;
}

export interface PlayerState {
  id: string;
  name: string;
  position: Vec3Data;
  velocity: Vec3Data;
  yaw: number;
  pitch: number;
  hp: number;
  maxHp: number;
  points: number;
  staminaMs: number;
  weapons: WeaponState[];
  activeWeaponIndex: number;
  grenades: number;
  perks: PerkId[];
  downed: boolean;
  spectating: boolean;
  connected: boolean;
  stats: PlayerStats;
}

export interface EnemyState {
  id: number;
  kind: EnemyKind;
  state: ZombieState;
  position: Vec3Data;
  velocity: Vec3Data;
  yaw: number;
  hp: number;
  maxHp: number;
  speed: number;
  room: RoomId;
  targetPlayerId: string;
  headless: boolean;
  spawnProgress: number;
  stateTimeMs: number;
}

export interface BarrierState {
  id: string;
  room: RoomId;
  boards: number;
}

export interface ActivePowerup {
  id: number;
  type: PowerupId;
  position: Vec3Data;
  spawnedAtMs: number;
}

export interface GameSnapshot {
  seed: number;
  mode: GameMode;
  phase: GamePhase;
  round: number;
  roundIsWolves: boolean;
  spawned: number;
  queued: number;
  elapsedMs: number;
  powerOn: boolean;
  doorsOpen: boolean[];
  players: PlayerState[];
  enemies: EnemyState[];
  barriers: BarrierState[];
  powerups: ActivePowerup[];
  drawCalls: number;
  fps: number;
}
