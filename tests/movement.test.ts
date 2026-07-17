import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { createCollisionWorld, floorHeightAt, simulatePlayerMovement, type KinematicState, type MovementInput } from '../src/shared/movement.js';

const world = createCollisionWorld();
const forwardSprint: MovementInput = {
  sequence: 1,
  forward: 1,
  right: 0,
  yaw: 0,
  pitch: 0,
  sprint: true,
  ads: false,
  ascend: false,
  descend: false,
};

function player(): KinematicState {
  return { x: 0, y: 0, z: -1.5, vx: 0, vy: 0, vz: 0, staminaMs: CONFIG.player.sprintMaxMs, grounded: true };
}

describe('fixed-step player movement', () => {
  it('drains sprint in exactly four seconds and refills in three seconds', () => {
    const state = player();
    for (let tick = 0; tick < CONFIG.simulation.hz * 4; tick += 1) {
      simulatePlayerMovement(state, forwardSprint, 1 / CONFIG.simulation.hz, world);
    }
    expect(state.staminaMs).toBeCloseTo(0, 5);

    const resting = { ...forwardSprint, forward: 0, sprint: false };
    for (let tick = 0; tick < CONFIG.simulation.hz * 3; tick += 1) {
      simulatePlayerMovement(state, resting, 1 / CONFIG.simulation.hz, world);
    }
    expect(state.staminaMs).toBeCloseTo(CONFIG.player.sprintMaxMs, 5);
  });

  it('prevents the capsule from crossing the start hall south wall', () => {
    const state = player();
    for (let tick = 0; tick < CONFIG.simulation.hz * 2; tick += 1) {
      simulatePlayerMovement(state, forwardSprint, 1 / CONFIG.simulation.hz, world);
    }
    expect(state.z).toBeGreaterThanOrEqual(-5 + CONFIG.controller.capsuleRadiusM);
  });

  it('allows the solo noclip diagnostic to traverse static walls', () => {
    const state = player();
    for (let tick = 0; tick < CONFIG.simulation.hz; tick += 1) {
      simulatePlayerMovement(state, forwardSprint, 1 / CONFIG.simulation.hz, world, true);
    }
    expect(state.z).toBeLessThan(-5 - CONFIG.controller.capsuleRadiusM);
  });

  it('exposes the authored stair and Catwalk floor heights', () => {
    expect(floorHeightAt(world, 10.5, 15.5, 0)).toBeCloseTo(0.4);
    expect(floorHeightAt(world, 10.5, 9.5, CONFIG.map.catwalkY)).toBe(CONFIG.map.catwalkY);
  });

  it('is deterministic for an identical input stream', () => {
    const first = player();
    const second = player();
    for (let tick = 0; tick < 180; tick += 1) {
      const input = { ...forwardSprint, sequence: Math.floor(tick / 2), right: tick % 40 < 20 ? 0.6 : -0.4 };
      simulatePlayerMovement(first, input, 1 / CONFIG.simulation.hz, world);
      simulatePlayerMovement(second, input, 1 / CONFIG.simulation.hz, world);
    }
    expect(second).toEqual(first);
  });
});
