import { CONFIG, type WeaponId } from '../config.js';
import type { SeededRng } from './rng.js';

export interface RuntimeWeaponState {
  id: WeaponId;
  magazine: number;
  reserve: number;
  upgraded: boolean;
  readyAtMs: number;
}

export interface CombatPlayerState {
  weapons: RuntimeWeaponState[];
  activeWeaponIndex: number;
  switchReadyAtMs: number;
  reloadFinishAtMs: number;
  reloadingWeaponIndex: number;
  shots: number;
  hits: number;
  kills: number;
  headshots: number;
  pointsEarned: number;
  doorsOpened: number;
  crateRolls: number;
  grenades: number;
}

export interface FireResult {
  accepted: boolean;
  reason: 'fired' | 'cooldown' | 'empty' | 'reloading' | 'unavailable';
  weaponId: WeaponId;
  magazine: number;
  reserve: number;
  hit: boolean;
  headshot: boolean;
  killed: boolean;
  enemyId: number | null;
  pelletHits: number;
  damage: number;
  points: number;
}

export interface ReloadResult {
  accepted: boolean;
  weaponId: WeaponId;
  magazine: number;
  reserve: number;
  finishAtMs: number;
}

export interface ShotVector {
  x: number;
  y: number;
  z: number;
}

export function createCombatPlayerState(): CombatPlayerState {
  return {
    weapons: [{
      id: 'melder',
      magazine: CONFIG.weapons.melder.magazine,
      reserve: CONFIG.weapons.melder.reserve,
      upgraded: false,
      readyAtMs: 0,
    }],
    activeWeaponIndex: 0,
    switchReadyAtMs: 0,
    reloadFinishAtMs: 0,
    reloadingWeaponIndex: -1,
    shots: 0,
    hits: 0,
    kills: 0,
    headshots: 0,
    pointsEarned: 0,
    doorsOpened: 0,
    crateRolls: 0,
    grenades: CONFIG.combat.maxGrenades,
  };
}

export function activeWeapon(state: CombatPlayerState): RuntimeWeaponState {
  return state.weapons[state.activeWeaponIndex] ?? state.weapons[0] ?? {
    id: 'melder',
    magazine: 0,
    reserve: 0,
    upgraded: false,
    readyAtMs: 0,
  };
}

export function shotDirection(yaw: number, pitch: number, spread: number, rng: SeededRng): ShotVector {
  const cosPitch = Math.cos(pitch);
  const forward = normalize({
    x: -Math.sin(yaw) * cosPitch,
    y: Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  });
  const right = { x: Math.cos(yaw), y: 0, z: -Math.sin(yaw) };
  const up = normalize(cross(right, forward));
  const radius = Math.sqrt(rng.next()) * spread;
  const angle = rng.next() * Math.PI * 2;
  return normalize({
    x: forward.x + right.x * Math.cos(angle) * radius + up.x * Math.sin(angle) * radius,
    y: forward.y + right.y * Math.cos(angle) * radius + up.y * Math.sin(angle) * radius,
    z: forward.z + right.z * Math.cos(angle) * radius + up.z * Math.sin(angle) * radius,
  });
}

export function raySphereDistance(origin: ShotVector, direction: ShotVector, center: ShotVector, radius: number): number | null {
  const ox = origin.x - center.x;
  const oy = origin.y - center.y;
  const oz = origin.z - center.z;
  const projection = ox * direction.x + oy * direction.y + oz * direction.z;
  const constant = ox * ox + oy * oy + oz * oz - radius * radius;
  const discriminant = projection * projection - constant;
  if (discriminant < 0) return null;
  const near = -projection - Math.sqrt(discriminant);
  if (near >= 0) return near;
  const far = -projection + Math.sqrt(discriminant);
  return far >= 0 ? far : null;
}

export function rayAabbDistance(
  origin: ShotVector,
  direction: ShotVector,
  minimum: ShotVector,
  maximum: ShotVector,
): number | null {
  let near: number = 0;
  let far: number = CONFIG.combat.hitscanRangeM;
  for (const axis of ['x', 'y', 'z'] as const) {
    if (Math.abs(direction[axis]) < Number.EPSILON) {
      if (origin[axis] < minimum[axis] || origin[axis] > maximum[axis]) return null;
      continue;
    }
    const inverse = 1 / direction[axis];
    let first = (minimum[axis] - origin[axis]) * inverse;
    let second = (maximum[axis] - origin[axis]) * inverse;
    if (first > second) [first, second] = [second, first];
    near = Math.max(near, first);
    far = Math.min(far, second);
    if (near > far) return null;
  }
  return near >= 0 ? near : far >= 0 ? far : null;
}

function cross(left: ShotVector, right: ShotVector): ShotVector {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function normalize(vector: ShotVector): ShotVector {
  const length = Math.max(Number.EPSILON, Math.hypot(vector.x, vector.y, vector.z));
  return { x: vector.x / length, y: vector.y / length, z: vector.z / length };
}
