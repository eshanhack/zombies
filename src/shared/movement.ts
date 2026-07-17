import { CONFIG } from '../config.js';
import { FLOOR_ZONES, STATIC_COLLIDERS, type AabbCollider, type FloorZone } from '../map/blueprint.js';

export interface MovementInput {
  sequence: number;
  forward: number;
  right: number;
  yaw: number;
  pitch: number;
  sprint: boolean;
  ads: boolean;
  ascend: boolean;
  descend: boolean;
}

export interface KinematicState {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  staminaMs: number;
  grounded: boolean;
}

export interface MovementResult {
  sprinting: boolean;
  collided: boolean;
}

export interface CollisionWorld {
  colliders: readonly AabbCollider[];
  floors: readonly FloorZone[];
  openDoors: ReadonlySet<string>;
}

export function createCollisionWorld(openDoors: readonly string[] = []): CollisionWorld {
  return { colliders: STATIC_COLLIDERS, floors: FLOOR_ZONES, openDoors: new Set(openDoors) };
}

export function sanitizeMovementInput(input: MovementInput): MovementInput {
  return {
    sequence: Number.isInteger(input.sequence) ? Math.max(0, input.sequence) : 0,
    forward: clampFinite(input.forward, -1, 1),
    right: clampFinite(input.right, -1, 1),
    yaw: Number.isFinite(input.yaw) ? input.yaw : 0,
    pitch: clampFinite(input.pitch, -CONFIG.controller.pitchLimitRad, CONFIG.controller.pitchLimitRad),
    sprint: input.sprint === true,
    ads: input.ads === true,
    ascend: input.ascend === true,
    descend: input.descend === true,
  };
}

export function simulatePlayerMovement(
  state: KinematicState,
  unsafeInput: MovementInput,
  deltaSeconds: number,
  world: CollisionWorld,
  noclip = false,
): MovementResult {
  const input = sanitizeMovementInput(unsafeInput);
  const delta = Math.min(Math.max(deltaSeconds, 0), CONFIG.simulation.maxFrameDeltaMs / 1000);
  const inputLength = Math.hypot(input.forward, input.right);
  const normalizedForward = inputLength > 1 ? input.forward / inputLength : input.forward;
  const normalizedRight = inputLength > 1 ? input.right / inputLength : input.right;
  const forwardX = -Math.sin(input.yaw);
  const forwardZ = -Math.cos(input.yaw);
  const rightX = Math.cos(input.yaw);
  const rightZ = -Math.sin(input.yaw);

  if (noclip) {
    const vertical = Number(input.ascend) - Number(input.descend);
    state.vx = (forwardX * normalizedForward + rightX * normalizedRight) * CONFIG.controller.noclipSpeedMps;
    state.vz = (forwardZ * normalizedForward + rightZ * normalizedRight) * CONFIG.controller.noclipSpeedMps;
    state.vy = vertical * CONFIG.controller.noclipSpeedMps;
    state.x += state.vx * delta;
    state.y = Math.max(0, state.y + state.vy * delta);
    state.z += state.vz * delta;
    state.grounded = false;
    return { sprinting: false, collided: false };
  }

  const hasPlanarInput = inputLength > 0.001;
  const sprinting = input.sprint && normalizedForward > 0.05 && !input.ads && hasPlanarInput && state.staminaMs > 0;
  const sprintScale = sprinting ? CONFIG.player.sprintMultiplier : 1;
  const backpedalScale = normalizedForward < 0 ? CONFIG.player.backpedalMultiplier : 1;
  const adsScale = input.ads ? CONFIG.player.adsMoveMultiplier : 1;
  const maxSpeed = CONFIG.player.walkSpeed * sprintScale * backpedalScale * adsScale;
  const targetVx = hasPlanarInput ? (forwardX * normalizedForward + rightX * normalizedRight) * maxSpeed : 0;
  const targetVz = hasPlanarInput ? (forwardZ * normalizedForward + rightZ * normalizedRight) * maxSpeed : 0;
  const acceleration = hasPlanarInput
    ? (state.grounded ? CONFIG.controller.groundAccelerationMps2 : CONFIG.controller.airAccelerationMps2)
    : CONFIG.controller.groundDecelerationMps2;

  state.vx = moveToward(state.vx, targetVx, acceleration * delta);
  state.vz = moveToward(state.vz, targetVz, acceleration * delta);

  if (sprinting) {
    state.staminaMs = Math.max(0, state.staminaMs - delta * 1000);
  } else {
    const refillPerSecond = CONFIG.player.sprintMaxMs / (CONFIG.controller.staminaRefillMs / 1000);
    state.staminaMs = Math.min(CONFIG.player.sprintMaxMs, state.staminaMs + refillPerSecond * delta);
  }

  const priorX = state.x;
  const priorZ = state.z;
  moveCapsulePlanar(state, state.vx * delta, state.vz * delta, world);
  const collided = Math.abs(state.x - priorX - state.vx * delta) > 0.0001 || Math.abs(state.z - priorZ - state.vz * delta) > 0.0001;
  if (collided) {
    if (Math.abs(state.x - priorX) < Math.abs(state.vx * delta) * 0.5) state.vx = 0;
    if (Math.abs(state.z - priorZ) < Math.abs(state.vz * delta) * 0.5) state.vz = 0;
  }

  const floorBeforeFall = floorHeightAt(world, state.x, state.z, state.y);
  if (state.grounded && floorBeforeFall !== null && floorBeforeFall > state.y && floorBeforeFall - state.y <= CONFIG.controller.maxStepHeightM) {
    state.y = floorBeforeFall;
  }
  state.vy -= CONFIG.controller.gravityMps2 * delta;
  state.y += state.vy * delta;

  const floor = floorHeightAt(world, state.x, state.z, state.y + CONFIG.controller.floorSnapM);
  if (floor !== null && state.vy <= 0 && state.y <= floor + CONFIG.controller.floorSnapM) {
    state.y = floor;
    state.vy = 0;
    state.grounded = true;
  } else {
    state.grounded = false;
  }

  return { sprinting, collided };
}

export function floorHeightAt(world: CollisionWorld, x: number, z: number, referenceY: number): number | null {
  let floor: number | null = null;
  const maxReachableY = referenceY + CONFIG.controller.maxStepHeightM;
  for (const zone of world.floors) {
    if (x < zone.minX || x > zone.maxX || z < zone.minZ || z > zone.maxZ || zone.y > maxReachableY) continue;
    if (floor === null || zone.y > floor) floor = zone.y;
  }
  return floor;
}

export function resolvePlayerSeparation(states: readonly KinematicState[]): void {
  const minimumDistance = CONFIG.coop.playerCollisionRadiusM * 2;
  for (let leftIndex = 0; leftIndex < states.length; leftIndex += 1) {
    const left = states[leftIndex];
    if (left === undefined) continue;
    for (let rightIndex = leftIndex + 1; rightIndex < states.length; rightIndex += 1) {
      const right = states[rightIndex];
      if (right === undefined || Math.abs(left.y - right.y) > CONFIG.controller.capsuleHeightM) continue;
      const dx = right.x - left.x;
      const dz = right.z - left.z;
      const distance = Math.hypot(dx, dz);
      if (distance >= minimumDistance || distance < 0.0001) continue;
      const correction = (minimumDistance - distance) * 0.5;
      const normalX = dx / distance;
      const normalZ = dz / distance;
      left.x -= normalX * correction;
      left.z -= normalZ * correction;
      right.x += normalX * correction;
      right.z += normalZ * correction;
    }
  }
}

function moveCapsulePlanar(state: KinematicState, deltaX: number, deltaZ: number, world: CollisionWorld): void {
  state.x += deltaX;
  for (const collider of world.colliders) {
    if (!isColliderActive(collider, world) || !verticalOverlap(state, collider)) continue;
    const expandedMinX = collider.minX - CONFIG.controller.capsuleRadiusM;
    const expandedMaxX = collider.maxX + CONFIG.controller.capsuleRadiusM;
    const expandedMinZ = collider.minZ - CONFIG.controller.capsuleRadiusM;
    const expandedMaxZ = collider.maxZ + CONFIG.controller.capsuleRadiusM;
    if (state.z <= expandedMinZ || state.z >= expandedMaxZ || state.x <= expandedMinX || state.x >= expandedMaxX) continue;
    state.x = deltaX > 0 ? expandedMinX : expandedMaxX;
  }

  state.z += deltaZ;
  for (const collider of world.colliders) {
    if (!isColliderActive(collider, world) || !verticalOverlap(state, collider)) continue;
    const expandedMinX = collider.minX - CONFIG.controller.capsuleRadiusM;
    const expandedMaxX = collider.maxX + CONFIG.controller.capsuleRadiusM;
    const expandedMinZ = collider.minZ - CONFIG.controller.capsuleRadiusM;
    const expandedMaxZ = collider.maxZ + CONFIG.controller.capsuleRadiusM;
    if (state.x <= expandedMinX || state.x >= expandedMaxX || state.z <= expandedMinZ || state.z >= expandedMaxZ) continue;
    state.z = deltaZ > 0 ? expandedMinZ : expandedMaxZ;
  }
}

function verticalOverlap(state: KinematicState, collider: AabbCollider): boolean {
  return state.y + CONFIG.controller.capsuleHeightM > collider.minY && state.y < collider.maxY;
}

function isColliderActive(collider: AabbCollider, world: CollisionWorld): boolean {
  return collider.kind !== 'door' || !world.openDoors.has(collider.id);
}

function moveToward(current: number, target: number, amount: number): number {
  if (current < target) return Math.min(current + amount, target);
  return Math.max(current - amount, target);
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(maximum, Math.max(minimum, value));
}
