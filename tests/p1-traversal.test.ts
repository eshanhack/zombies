import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { DOORS, START_POSITIONS, roomAt } from '../src/map/blueprint.js';
import { createCollisionWorld, simulatePlayerMovement, type KinematicState, type MovementInput } from '../src/shared/movement.js';

const traversalWorld = createCollisionWorld(DOORS.map((door) => door.id));
const route = [
  { x: -3.2, z: -2.5 },
  { x: -5.2, z: 3.7 },
  { x: -5.2, z: 8.2 },
  { x: -7.5, z: 10.5 },
  { x: -5.7, z: 12 },
  { x: 0.4, z: 12 },
  { x: 2.4, z: 15.6 },
  { x: 9, z: 15.6 },
  { x: 10.9, z: 15.35 },
  { x: 10.9, z: 14.35 },
  { x: 10.9, z: 13.35 },
  { x: 10.9, z: 12.35 },
  { x: 11.7, z: 10.8 },
  { x: 8.2, z: 9.3 },
];

function stateAt(index: number): KinematicState {
  const spawn = START_POSITIONS[index] ?? CONFIG.map.startPosition;
  return { ...spawn, vx: 0, vy: 0, vz: 0, staminaMs: CONFIG.player.sprintMaxMs, grounded: true };
}

function inputToward(state: KinematicState, target: { x: number; z: number }, sequence: number): MovementInput {
  const dx = target.x - state.x;
  const dz = target.z - state.z;
  return {
    sequence,
    forward: 1,
    right: 0,
    yaw: Math.atan2(-dx, -dz),
    pitch: 0,
    sprint: false,
    ads: false,
    ascend: false,
    descend: false,
  };
}

function followRoute(state: KinematicState): void {
  let sequence = 0;
  for (const target of route) {
    let ticks = 0;
    while (Math.hypot(target.x - state.x, target.z - state.z) > 0.18 && ticks < CONFIG.simulation.hz * 12) {
      simulatePlayerMovement(state, inputToward(state, target, sequence), 1 / CONFIG.simulation.hz, traversalWorld);
      ticks += 1;
      if (ticks % 2 === 0) sequence += 1;
    }
    expect(ticks, `stalled near ${target.x},${target.z}`).toBeLessThan(CONFIG.simulation.hz * 12);
  }
}

describe('P1 authoritative traversal gate', () => {
  it('moves four independently predicted players through every room to the Catwalk without divergence', () => {
    for (let playerIndex = 0; playerIndex < CONFIG.coop.maxPlayers; playerIndex += 1) {
      const authoritative = stateAt(playerIndex);
      const predicted = stateAt(playerIndex);
      let sequence = 0;
      for (const target of route) {
        let ticks = 0;
        while (Math.hypot(target.x - authoritative.x, target.z - authoritative.z) > 0.18 && ticks < CONFIG.simulation.hz * 12) {
          const input = inputToward(authoritative, target, sequence);
          simulatePlayerMovement(authoritative, input, 1 / CONFIG.simulation.hz, traversalWorld);
          simulatePlayerMovement(predicted, input, 1 / CONFIG.simulation.hz, traversalWorld);
          ticks += 1;
          if (ticks % 2 === 0) sequence += 1;
        }
        expect(ticks, `player ${playerIndex + 1} stalled near ${target.x},${target.z}`).toBeLessThan(CONFIG.simulation.hz * 12);
      }
      expect(predicted).toEqual(authoritative);
      expect(roomAt(authoritative.x, authoritative.y, authoritative.z)).toBe('catwalk');
      expect(authoritative.y).toBeCloseTo(CONFIG.map.catwalkY, 5);
    }
  });

  it('the authored solo route reaches the same final platform', () => {
    const solo = stateAt(0);
    followRoute(solo);
    expect(roomAt(solo.x, solo.y, solo.z)).toBe('catwalk');
  });
});
