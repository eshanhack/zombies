import { CONFIG, type RoomId } from '../config.js';

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

export const STATIC_COLLIDERS: readonly AabbCollider[] = [
  wall('start-south', -7, 7, -5 - thickness, -5),
  wall('start-west', -7 - thickness, -7, -5, 5),
  wall('start-east', 7, 7 + thickness, -5, 5),
  wall('start-north-left', -7, -6.25, 5, 5 + thickness),
  wall('start-north-right', -4.15, 7, 5, 5 + thickness),
  wall('corridor-a-west', -6.25 - thickness, -6.25, 5, 9),
  wall('corridor-a-east', -4.15, -4.15 + thickness, 5, 9),
  wall('armory-south-west', -15, -6.25, 9 - thickness, 9),
  wall('armory-west', -15 - thickness, -15, 9, 17),
  wall('armory-north', -15, -5, 17, 17 + thickness),
  wall('armory-east-south', -5, -5 + thickness, 9, 11),
  wall('armory-east-north', -5, -5 + thickness, 13, 17),
  wall('corridor-b-south', -5, 1, 11 - thickness, 11),
  wall('corridor-b-north', -5, 1, 13, 13 + thickness),
  wall('generator-west-south', 1 - thickness, 1, 8, 11),
  wall('generator-west-north', 1 - thickness, 1, 13, 17),
  wall('generator-south', 1, 13, 8 - thickness, 8),
  wall('generator-east', 13, 13 + thickness, 8, 17, 6.8),
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
