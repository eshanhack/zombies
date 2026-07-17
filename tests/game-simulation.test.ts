import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { GameSimulation, type SimPlayer } from '../src/shared/GameSimulation.js';

function player(overrides: Partial<SimPlayer> = {}): SimPlayer {
  return {
    id: 'player-1',
    x: 0,
    y: 0,
    z: -1.5,
    yaw: 0,
    hp: CONFIG.player.maxHp,
    maxHp: CONFIG.player.maxHp,
    points: CONFIG.points.starting,
    connected: true,
    downed: false,
    invulnerableUntilMs: 0,
    ...overrides,
  };
}

function advance(simulation: GameSimulation, milliseconds: number, players: readonly SimPlayer[]): void {
  let remaining = milliseconds;
  while (remaining > 0) {
    const step = Math.min(CONFIG.simulation.maxFrameDeltaMs, remaining);
    simulation.update(step, players);
    remaining -= step;
  }
}

describe('P2 deterministic enemy simulation', () => {
  it('uses exact solo and historical multiplayer opening populations', () => {
    expect(new GameSimulation({ seed: 1, mode: 'solo', rosterSize: 1 }).totalThisRound).toBe(6);
    expect(new GameSimulation({ seed: 1, mode: 'coop', rosterSize: 2 }).totalThisRound).toBe(7);
    expect(new GameSimulation({ seed: 1, mode: 'coop', rosterSize: 4 }).totalThisRound).toBe(10);
  });

  it('spawns exactly six round-one walkers in solo', () => {
    const simulation = new GameSimulation({ seed: 12345, mode: 'solo', rosterSize: 1 });
    const survivor = player({ x: 0, z: 3.5 });
    while (simulation.queued > 0) advance(simulation, 100, [survivor]);
    expect(simulation.spawnedThisRound).toBe(6);
    expect([...simulation.enemies.values()]).toHaveLength(6);
    expect([...simulation.enemies.values()].every((enemy) => enemy.speedTier === 'walk')).toBe(true);
  });

  it('tears one board every 1500ms, then vaults for exactly 1200ms', () => {
    const simulation = new GameSimulation({ seed: 7, mode: 'solo', rosterSize: 1 });
    const survivor = player({ x: 0, z: 3.5 });
    const enemy = simulation.forceSpawn([survivor]);
    expect(enemy).not.toBeNull();
    advance(simulation, CONFIG.zombie.spawnRiseMs, [survivor]);
    expect(enemy?.state).toBe('tear');
    const barrier = simulation.barriers.get(enemy!.barrierId)!;
    advance(simulation, CONFIG.zombie.boardTearMs - 1, [survivor]);
    expect(barrier.boards).toBe(CONFIG.barriers.boardSlots);
    advance(simulation, 1, [survivor]);
    expect(barrier.boards).toBe(CONFIG.barriers.boardSlots - 1);

    barrier.boards = 0;
    advance(simulation, 1, [survivor]);
    expect(enemy?.state).toBe('vault');
    advance(simulation, CONFIG.zombie.windowVaultMs - 1, [survivor]);
    expect(enemy?.state).toBe('vault');
    advance(simulation, 1, [survivor]);
    expect(enemy?.state).toBe('chase');
  });

  it('repairs one board in 900ms and awards exactly ten points', () => {
    const simulation = new GameSimulation({ seed: 8, mode: 'solo', rosterSize: 1 });
    const survivor = player({ x: -4.8, z: -4.1 });
    const barrier = simulation.barriers.get('start-1')!;
    barrier.boards = 5;
    simulation.setRepairHeld(survivor.id, true);
    advance(simulation, CONFIG.barriers.repairMs - 1, [survivor]);
    expect(barrier.boards).toBe(5);
    expect(survivor.points).toBe(CONFIG.points.starting);
    advance(simulation, 1, [survivor]);
    expect(barrier.boards).toBe(6);
    expect(survivor.points).toBe(CONFIG.points.starting + CONFIG.points.boardRepair);
  });

  it('deals 150 melee damage, one-hits round one, and awards 130 points', () => {
    const simulation = new GameSimulation({ seed: 9, mode: 'solo', rosterSize: 1 });
    const survivor = player({ x: 0, z: 0, yaw: 0 });
    const enemy = simulation.forceSpawn([survivor])!;
    Object.assign(enemy, { x: 0, y: 0, z: -1.2, state: 'chase', stateTimeMs: 0 });
    const result = simulation.melee(survivor);
    expect(result).toMatchObject({ accepted: true, hit: true, killed: true, damage: 150, points: 130 });
    expect(enemy.state).toBe('dead');
    expect(survivor.points).toBe(CONFIG.points.starting + CONFIG.points.killMelee);
  });

  it('converts non-lethal explosive wounds into a crawler without changing the remaining HP afterward', () => {
    const simulation = new GameSimulation({ seed: 10, mode: 'solo', rosterSize: 1 });
    const survivor = player();
    const enemy = simulation.forceSpawn([survivor])!;
    expect(simulation.applyExplosiveDamage(enemy.id, 40, false)).toBe(false);
    expect(enemy.kind).toBe('crawler');
    expect(enemy.speed).toBe(CONFIG.zombie.crawlerSpeed);
    expect(enemy.hp).toBe(enemy.maxHp - 40);
  });

  it('reproduces barrier, spawn, and speed state for the same seed', () => {
    const left = new GameSimulation({ seed: 424242, mode: 'solo', rosterSize: 1 });
    const right = new GameSimulation({ seed: 424242, mode: 'solo', rosterSize: 1 });
    const leftPlayer = player();
    const rightPlayer = player();
    advance(left, 5000, [leftPlayer]);
    advance(right, 5000, [rightPlayer]);
    expect([...right.enemies.values()]).toEqual([...left.enemies.values()]);
    expect([...right.barriers.values()]).toEqual([...left.barriers.values()]);
  });
});
