import { CONFIG, type RoomId, type WeaponId } from '../config.js';

export type ColliderKind = 'wall' | 'door' | 'obstacle' | 'railing';

export interface AabbCollider {
  id: string;
  kind: ColliderKind;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

export interface FloorZone {
  id: string;
  room: RoomId;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  y: number;
}

export interface DoorBlueprint {
  id: 'doorA' | 'doorB' | 'doorC';
  cost: number;
  collider: AabbCollider;
}

export interface WallBuyBlueprint {
  id: string;
  kind: 'weapon' | 'grenades';
  weaponId?: WeaponId;
  room: RoomId;
  cost: number;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export interface CrateLocationBlueprint {
  id: string;
  room: RoomId;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

export type WindowFacing = 'north' | 'south' | 'east' | 'west';

export interface WindowBlueprint {
  id: string;
  room: RoomId;
  facing: WindowFacing;
  x: number;
  y: number;
  z: number;
  outsideX: number;
  outsideZ: number;
  insideX: number;
  insideZ: number;
  navNodeId: string;
}

const thickness = CONFIG.map.wallThicknessM;
const wallHeight = CONFIG.map.wallHeightM;

function wall(id: string, minX: number, maxX: number, minZ: number, maxZ: number, height: number = wallHeight, minY: number = 0): AabbCollider {
  return { id, kind: 'wall', minX, maxX, minY, maxY: minY + height, minZ, maxZ };
}

function door(id: string, minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number): AabbCollider {
  return { id, kind: 'door', minX, maxX, minY, maxY, minZ, maxZ };
}

export const DOORS: readonly DoorBlueprint[] = [
  { id: 'doorA', cost: CONFIG.economy.doorCosts[0], collider: door('doorA', -6.25, -4.15, 0, CONFIG.map.doorHeightM, 6.08, 6.08 + CONFIG.map.wallThicknessM) },
  { id: 'doorB', cost: CONFIG.economy.doorCosts[1], collider: door('doorB', -2.15, -2.15 + CONFIG.map.wallThicknessM, 0, CONFIG.map.doorHeightM, 11, 13) },
  { id: 'doorC', cost: CONFIG.economy.doorCosts[2], collider: door('doorC', 9.45, 12.55, 2.78, 2.78 + CONFIG.map.doorHeightM, 11.82, 11.82 + CONFIG.map.wallThicknessM) },
] as const;

export const WALL_BUYS: readonly WallBuyBlueprint[] = [
  { id: 'wall-jaeger', kind: 'weapon', weaponId: 'jaeger', room: 'start', cost: CONFIG.weapons.jaeger.cost, x: -6.72, y: 1.35, z: 0.7, yaw: Math.PI / 2 },
  { id: 'wall-grenades', kind: 'grenades', room: 'start', cost: CONFIG.economy.grenadesX4, x: 6.72, y: 1.25, z: 0.7, yaw: -Math.PI / 2 },
  { id: 'wall-kurier', kind: 'weapon', weaponId: 'kurier', room: 'armory', cost: CONFIG.weapons.kurier.cost, x: -11.8, y: 1.35, z: 16.72, yaw: Math.PI },
  { id: 'wall-sturmvogel', kind: 'weapon', weaponId: 'sturmvogel', room: 'armory', cost: CONFIG.weapons.sturmvogel.cost, x: -5.28, y: 1.35, z: 15.1, yaw: -Math.PI / 2 },
  { id: 'wall-doppelhieb', kind: 'weapon', weaponId: 'doppelhieb', room: 'generator', cost: CONFIG.weapons.doppelhieb.cost, x: 12.72, y: 1.35, z: 13.1, yaw: -Math.PI / 2 },
  { id: 'wall-lasttraeger', kind: 'weapon', weaponId: 'lasttraeger', room: 'catwalk', cost: CONFIG.weapons.lasttraeger.cost, x: 4.2, y: 4.58, z: 8.28, yaw: 0 },
] as const;

export const CRATE_LOCATIONS: readonly CrateLocationBlueprint[] = [
  { id: 'crate-armory', room: 'armory', x: -10.5, y: 0, z: 12.3, yaw: 0.18 },
  { id: 'crate-generator', room: 'generator', x: 9.6, y: 0, z: 14.7, yaw: -0.35 },
  { id: 'crate-start', room: 'start', x: 4.3, y: 0, z: 1.8, yaw: Math.PI },
] as const;

export const WINDOWS: readonly WindowBlueprint[] = [
  { id: 'start-1', room: 'start', facing: 'south', x: -4.8, y: 1.55, z: -5, outsideX: -4.8, outsideZ: -6.1, insideX: -4.8, insideZ: -4.35, navNodeId: 'S01' },
  { id: 'start-2', room: 'start', facing: 'south', x: -1.6, y: 1.55, z: -5, outsideX: -1.6, outsideZ: -6.1, insideX: -1.6, insideZ: -4.35, navNodeId: 'S02' },
  { id: 'start-3', room: 'start', facing: 'south', x: 1.6, y: 1.55, z: -5, outsideX: 1.6, outsideZ: -6.1, insideX: 1.6, insideZ: -4.35, navNodeId: 'S03' },
  { id: 'start-4', room: 'start', facing: 'south', x: 4.8, y: 1.55, z: -5, outsideX: 4.8, outsideZ: -6.1, insideX: 4.8, insideZ: -4.35, navNodeId: 'S04' },
  { id: 'armory-1', room: 'armory', facing: 'west', x: -15, y: 1.55, z: 11.2, outsideX: -16.1, outsideZ: 11.2, insideX: -14.35, insideZ: 11.2, navNodeId: 'R01' },
  { id: 'armory-2', room: 'armory', facing: 'west', x: -15, y: 1.55, z: 14.8, outsideX: -16.1, outsideZ: 14.8, insideX: -14.35, insideZ: 14.8, navNodeId: 'R06' },
  { id: 'generator-1', room: 'generator', facing: 'east', x: 13, y: 1.55, z: 10.2, outsideX: 14.1, outsideZ: 10.2, insideX: 12.35, insideZ: 10.2, navNodeId: 'G07' },
  { id: 'generator-2', room: 'generator', facing: 'east', x: 13, y: 1.55, z: 15, outsideX: 14.1, outsideZ: 15, insideX: 12.35, insideZ: 15, navNodeId: 'G11' },
  { id: 'catwalk-1', room: 'catwalk', facing: 'south', x: 6.2, y: 4.7, z: 8, outsideX: 6.2, outsideZ: 7, insideX: 6.2, insideZ: 8.65, navNodeId: 'C03' },
] as const;

function horizontalWindowWall(
  id: string,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  windows: readonly WindowBlueprint[],
  minY: number = 0,
  height: number = wallHeight,
): AabbCollider[] {
  const openingBottom = Math.min(...windows.map((window) => window.y - CONFIG.barriers.openingHeightM * 0.5));
  const openingTop = Math.max(...windows.map((window) => window.y + CONFIG.barriers.openingHeightM * 0.5));
  const colliders: AabbCollider[] = [];
  if (openingBottom > minY) colliders.push(wall(`${id}-sill`, minX, maxX, minZ, maxZ, openingBottom - minY, minY));
  if (openingTop < minY + height) colliders.push(wall(`${id}-lintel`, minX, maxX, minZ, maxZ, minY + height - openingTop, openingTop));
  let cursor = minX;
  for (const window of [...windows].sort((left, right) => left.x - right.x)) {
    const openingLeft = window.x - CONFIG.barriers.openingWidthM * 0.5;
    if (openingLeft > cursor) colliders.push(wall(`${id}-pier-${colliders.length}`, cursor, openingLeft, minZ, maxZ, height, minY));
    cursor = window.x + CONFIG.barriers.openingWidthM * 0.5;
  }
  if (cursor < maxX) colliders.push(wall(`${id}-pier-${colliders.length}`, cursor, maxX, minZ, maxZ, height, minY));
  return colliders;
}

function verticalWindowWall(
  id: string,
  minX: number,
  maxX: number,
  minZ: number,
  maxZ: number,
  windows: readonly WindowBlueprint[],
  minY: number = 0,
  height: number = wallHeight,
): AabbCollider[] {
  const openingBottom = Math.min(...windows.map((window) => window.y - CONFIG.barriers.openingHeightM * 0.5));
  const openingTop = Math.max(...windows.map((window) => window.y + CONFIG.barriers.openingHeightM * 0.5));
  const colliders: AabbCollider[] = [];
  if (openingBottom > minY) colliders.push(wall(`${id}-sill`, minX, maxX, minZ, maxZ, openingBottom - minY, minY));
  if (openingTop < minY + height) colliders.push(wall(`${id}-lintel`, minX, maxX, minZ, maxZ, minY + height - openingTop, openingTop));
  let cursor = minZ;
  for (const window of [...windows].sort((left, right) => left.z - right.z)) {
    const openingNear = window.z - CONFIG.barriers.openingWidthM * 0.5;
    if (openingNear > cursor) colliders.push(wall(`${id}-pier-${colliders.length}`, minX, maxX, cursor, openingNear, height, minY));
    cursor = window.z + CONFIG.barriers.openingWidthM * 0.5;
  }
  if (cursor < maxZ) colliders.push(wall(`${id}-pier-${colliders.length}`, minX, maxX, cursor, maxZ, height, minY));
  return colliders;
}

export const STATIC_COLLIDERS: readonly AabbCollider[] = [
  ...horizontalWindowWall('start-south', -7, 7, -5 - thickness, -5, WINDOWS.filter((window) => window.room === 'start')),
  wall('start-west', -7 - thickness, -7, -5, 5),
  wall('start-east', 7, 7 + thickness, -5, 5),
  wall('start-north-left', -7, -6.25, 5, 5 + thickness),
  wall('start-north-right', -4.15, 7, 5, 5 + thickness),
  wall('corridor-a-west', -6.25 - thickness, -6.25, 5, 9),
  wall('corridor-a-east', -4.15, -4.15 + thickness, 5, 9),
  wall('armory-south-west', -15, -6.25, 9 - thickness, 9),
  ...verticalWindowWall('armory-west', -15 - thickness, -15, 9, 17, WINDOWS.filter((window) => window.room === 'armory')),
  wall('armory-north', -15, -5, 17, 17 + thickness),
  wall('armory-east-south', -5, -5 + thickness, 9, 11),
  wall('armory-east-north', -5, -5 + thickness, 13, 17),
  wall('corridor-b-south', -5, 1, 11 - thickness, 11),
  wall('corridor-b-north', -5, 1, 13, 13 + thickness),
  wall('generator-west-south', 1 - thickness, 1, 8, 11),
  wall('generator-west-north', 1 - thickness, 1, 13, 17),
  wall('generator-south-lower', 1, 13, 8 - thickness, 8),
  ...horizontalWindowWall('catwalk-south', 1, 13, 8 - thickness, 8, WINDOWS.filter((window) => window.room === 'catwalk'), CONFIG.map.catwalkY, CONFIG.map.generator.ceilingY - CONFIG.map.catwalkY),
  ...verticalWindowWall('generator-east', 13, 13 + thickness, 8, 17, WINDOWS.filter((window) => window.room === 'generator'), 0, CONFIG.map.generator.ceilingY),
  wall('generator-north', 1, 13, 17, 17 + thickness, 6.8),
  wall('start-debris', -1.25, 1.2, -0.75, 1.15, 1.1),
  wall('generator-core', 3.8, 7.2, 11.15, 14.9, 2.65),
  { id: 'catwalk-rail-south-a', kind: 'railing', minX: 1.25, maxX: 6.4, minY: 3.2, maxY: 4.2, minZ: 11.55, maxZ: 11.67 },
  { id: 'catwalk-rail-south-b', kind: 'railing', minX: 8.2, maxX: 9.45, minY: 3.2, maxY: 4.2, minZ: 11.55, maxZ: 11.67 },
  { id: 'catwalk-rail-west', kind: 'railing', minX: 1.25, maxX: 1.37, minY: 3.2, maxY: 4.2, minZ: 8.25, maxZ: 11.67 },
  ...DOORS.map((entry) => entry.collider),
] as const;

const baseFloors: FloorZone[] = [
  { id: 'start-floor', room: 'start', minX: -7, maxX: 7, minZ: -5, maxZ: 5, y: 0 },
  { id: 'corridor-a-floor', room: 'start', minX: -6.25, maxX: -4.15, minZ: 5, maxZ: 10, y: 0 },
  { id: 'armory-floor', room: 'armory', minX: -15, maxX: -5, minZ: 9, maxZ: 17, y: 0 },
  { id: 'corridor-b-floor', room: 'armory', minX: -5, maxX: 1, minZ: 11, maxZ: 13, y: 0 },
  { id: 'generator-floor', room: 'generator', minX: 1, maxX: 13, minZ: 8, maxZ: 17, y: 0 },
  { id: 'catwalk-floor', room: 'catwalk', minX: 1.25, maxX: 12.75, minZ: 8.25, maxZ: 11.65, y: CONFIG.map.catwalkY },
];

const stairFloors: FloorZone[] = Array.from({ length: 8 }, (_, index) => {
  const highEdge = 15.8 - index * 0.5;
  return {
    id: `stair-${index + 1}`,
    room: index >= 6 ? 'catwalk' : 'generator',
    minX: 9.45,
    maxX: 12.55,
    minZ: highEdge - 0.5,
    maxZ: highEdge,
    y: (index + 1) * 0.4,
  } satisfies FloorZone;
});

export const FLOOR_ZONES: readonly FloorZone[] = [...baseFloors, ...stairFloors] as const;

export const START_POSITIONS = Array.from({ length: CONFIG.coop.maxPlayers }, (_, index) => ({
  x: CONFIG.map.startPosition.x + (index - 1.5) * CONFIG.coop.spawnSpacingM,
  y: CONFIG.map.startPosition.y,
  z: CONFIG.map.startPosition.z,
})) as readonly { x: number; y: number; z: number }[];

export function roomAt(x: number, y: number, z: number): RoomId {
  if (y > CONFIG.map.catwalkY - CONFIG.controller.maxStepHeightM && x >= 1.1 && z >= 8) return 'catwalk';
  if (x >= 1 && z >= 8) return 'generator';
  if (x <= -5 && z >= 8.8) return 'armory';
  return 'start';
}
