import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { GameSimulation, type SimEnemy, type SimPlayer } from '../src/shared/GameSimulation.js';

function survivor(overrides: Partial<SimPlayer> = {}): SimPlayer {
  return {
    id: 'shooter',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    hp: CONFIG.player.maxHp,
    maxHp: CONFIG.player.maxHp,
    points: CONFIG.points.starting,
    connected: true,
    downed: false,
    invulnerableUntilMs: 0,
    ...overrides,
  };
}

function target(simulation: GameSimulation, player: SimPlayer, hp: number = CONFIG.zombie.baseHp): SimEnemy {
  const enemy = simulation.forceSpawn([player]);
  if (enemy === null) throw new Error('Expected a debug target.');
  Object.assign(enemy, {
    x: 0,
    y: 0,
    z: -3,
    hp,
    maxHp: CONFIG.zombie.baseHp,
    state: 'chase',
    stateTimeMs: 0,
    spawnProgress: 1,
  });
  return enemy;
}

function advance(simulation: GameSimulation, milliseconds: number, players: readonly SimPlayer[]): void {
  let remaining = milliseconds;
  while (remaining > 0) {
    const delta = Math.min(remaining, CONFIG.simulation.maxFrameDeltaMs);
    simulation.update(delta, players);
    remaining -= delta;
  }
}

describe('P3 authoritative gunplay', () => {
  it('awards 10 for a connecting bullet and 60 total for a body killing shot', () => {
    const simulation = new GameSimulation({ seed: 12345, mode: 'solo', rosterSize: 1 });
    const player = survivor({ pitch: Math.atan2(1 - CONFIG.controller.eyeHeightM, 3) });
    const enemy = target(simulation, player, 60);

    const first = simulation.fire(player, true);
    expect(first).toMatchObject({ accepted: true, hit: true, headshot: false, killed: false, damage: 30, points: 10 });
    expect(player.points).toBe(510);
    advance(simulation, 60000 / CONFIG.weapons.melder.rpm, [player]);
    const killing = simulation.fire(player, true);
    expect(killing).toMatchObject({ accepted: true, hit: true, headshot: false, killed: true, damage: 30, points: 60 });
    expect(enemy.state).toBe('dead');
    expect(player.points).toBe(570);
  });

  it('awards exactly 100 for a Jäger K-8 headshot kill', () => {
    const simulation = new GameSimulation({ seed: 12345, mode: 'solo', rosterSize: 1 });
    const headY = CONFIG.combat.headCenterHeightM;
    const player = survivor({ pitch: Math.atan2(headY - CONFIG.controller.eyeHeightM, 3) });
    const enemy = target(simulation, player);
    simulation.grantWeapon(player.id, 'jaeger');

    const result = simulation.fire(player, true);
    expect(result).toMatchObject({ accepted: true, weaponId: 'jaeger', hit: true, headshot: true, killed: true, damage: 380, points: 100 });
    expect(enemy.state).toBe('dead');
    expect(player.points).toBe(CONFIG.points.starting + CONFIG.points.bulletHit + CONFIG.points.killBonusHead);
  });

  it('enforces fire cadence and consumes one loaded round only for an accepted shot', () => {
    const simulation = new GameSimulation({ seed: 9, mode: 'solo', rosterSize: 1 });
    const player = survivor({ yaw: Math.PI });
    expect(simulation.fire(player, false)).toMatchObject({ accepted: true, magazine: 7 });
    expect(simulation.fire(player, false)).toMatchObject({ accepted: false, reason: 'cooldown', magazine: 7 });
    advance(simulation, 60000 / CONFIG.weapons.melder.rpm, [player]);
    expect(simulation.fire(player, false)).toMatchObject({ accepted: true, magazine: 6 });
  });

  it('completes the Melder reload at exactly 1600ms and transfers from reserve', () => {
    const simulation = new GameSimulation({ seed: 11, mode: 'solo', rosterSize: 1 });
    const player = survivor({ yaw: Math.PI });
    simulation.fire(player, false);
    const reload = simulation.requestReload(player.id);
    expect(reload).toMatchObject({ accepted: true, weaponId: 'melder', magazine: 7, reserve: 32 });
    advance(simulation, CONFIG.weapons.melder.reloadMs - 1, [player]);
    expect(simulation.getCombatState(player.id).weapons[0]).toMatchObject({ magazine: 7, reserve: 32 });
    advance(simulation, 1, [player]);
    expect(simulation.getCombatState(player.id).weapons[0]).toMatchObject({ magazine: 8, reserve: 31 });
  });
});
