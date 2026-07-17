import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG, type WeaponId } from '../src/config.js';
import { GameSimulation, type SimEnemy, type SimPlayer } from '../src/shared/GameSimulation.js';
import { coopZombieCount, soloZombieCount, wolfCount } from '../src/shared/formulas.js';
import { runNormalRoundBenchmark, runPacingCampaign } from '../src/shared/PacingHarness.js';

function survivor(): SimPlayer {
  return {
    id: 'hardening-player',
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: Math.atan2(1 - CONFIG.controller.eyeHeightM, 3),
    hp: CONFIG.player.maxHp,
    maxHp: CONFIG.player.maxHp,
    points: CONFIG.points.starting,
    connected: true,
    downed: false,
    invulnerableUntilMs: Number.POSITIVE_INFINITY,
    spectating: false,
  };
}

function target(simulation: GameSimulation, player: SimPlayer): SimEnemy {
  const enemy = simulation.forceSpawn([player]);
  if (enemy === null) throw new Error('Expected a hardening target.');
  Object.assign(enemy, { x: 0, y: 0, z: -3, state: 'chase', stateTimeMs: 0, spawnProgress: 1 });
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

describe('P9 fidelity, pacing, and hardening', () => {
  it('lands every required seed inside the normal-round pacing envelope', () => {
    for (const seed of CONFIG.pacingVerification.seeds) {
      for (const round of CONFIG.pacingVerification.benchmarkRounds) {
        const result = runNormalRoundBenchmark(seed, round);
        expect(result.count).toBe(soloZombieCount(round));
        expect(result.insideEnvelope, `seed ${seed}, round ${round}, ${result.durationMs}ms`).toBe(true);
        expect(result.peakAlive).toBeLessThanOrEqual(CONFIG.zombie.maxAlive);
      }
    }
  });

  it('reproduces three consecutive full campaigns for every required seed', () => {
    for (const seed of CONFIG.pacingVerification.seeds) {
      const campaigns = Array.from(
        { length: CONFIG.pacingVerification.consecutiveRuns },
        () => runPacingCampaign(seed),
      );
      expect(campaigns[1]).toEqual(campaigns[0]);
      expect(campaigns[2]).toEqual(campaigns[0]);
      const campaign = campaigns[0]!;
      expect(campaign.rounds).toHaveLength(CONFIG.pacingVerification.campaignThroughRound);
      expect(campaign.wolfRounds[0]).toBeGreaterThanOrEqual(CONFIG.wolves.firstRoundMin);
      expect(campaign.wolfRounds[0]).toBeLessThanOrEqual(CONFIG.wolves.firstRoundMax);
      for (let index = 1; index < campaign.wolfRounds.length; index += 1) {
        const gap = campaign.wolfRounds[index]! - campaign.wolfRounds[index - 1]!;
        expect(gap).toBeGreaterThanOrEqual(CONFIG.wolves.intervalMin);
        expect(gap).toBeLessThanOrEqual(CONFIG.wolves.intervalMax);
      }
      let wolfAppearance = 0;
      for (const round of campaign.rounds) {
        if (round.kind === 'wolves') {
          wolfAppearance += 1;
          expect(round.count).toBe(wolfCount(wolfAppearance, 1));
          expect(round.peakAlive).toBeLessThanOrEqual(CONFIG.wolves.maxActivePerPlayer);
        } else {
          expect(round.count).toBe(soloZombieCount(round.round));
          expect(round.peakAlive).toBeLessThanOrEqual(CONFIG.zombie.maxAlive);
        }
      }
    }
  }, 120000);

  it('keeps two- and four-player populations exact through round ten', () => {
    for (const roster of [2, 4]) {
      for (let round = 1; round <= 10; round += 1) {
        expect(coopZombieCount(round, roster)).toBe(Math.floor(
          (24 + (roster - 1) * 6 * Math.max(1, round / 5))
          * (CONFIG.coop.earlyRoundFactors[round - 1] ?? 1),
        ));
      }
    }
  });

  it('rewinds hits without leaving authoritative enemy positions displaced', () => {
    const currentSimulation = new GameSimulation({ seed: 777, mode: 'solo', rosterSize: 1 });
    const currentPlayer = survivor();
    const currentEnemy = target(currentSimulation, currentPlayer);
    currentEnemy.x = 2;
    expect(currentSimulation.fire(currentPlayer, true).hit).toBe(false);

    const rewindSimulation = new GameSimulation({ seed: 777, mode: 'solo', rosterSize: 1 });
    const rewindPlayer = survivor();
    const rewindEnemy = target(rewindSimulation, rewindPlayer);
    rewindEnemy.x = 2;
    const result = rewindSimulation.fireRewound(
      rewindPlayer,
      true,
      new Map([[rewindEnemy.id, { x: 0, y: 0, z: -3 }]]),
    );
    expect(result.hit).toBe(true);
    expect(rewindEnemy.x).toBe(2);
    expect(rewindEnemy.z).toBe(-3);
  });

  it('keeps a crawler alive through Carpenter and bleeds it out only at five minutes', () => {
    const simulation = new GameSimulation({ seed: 91, mode: 'solo', rosterSize: 1 });
    const player = survivor();
    const enemy = target(simulation, player);
    simulation.applyExplosiveDamage(enemy.id, 40, false);
    for (const barrier of simulation.barriers.values()) barrier.boards = 0;
    advance(simulation, CONFIG.combat.crawlerBleedoutMs - 1000, [player]);
    expect(enemy.kind).toBe('crawler');
    expect(enemy.state).not.toBe('dead');

    simulation.debugSpawnPowerup('carpenter', player.x, player.y, player.z);
    advance(simulation, 100, [player]);
    expect([...simulation.barriers.values()].every((barrier) => barrier.boards === CONFIG.barriers.boardSlots)).toBe(true);
    expect(enemy.state).not.toBe('dead');
    advance(simulation, 900, [player]);
    expect(enemy.state).toBe('dead');
  });

  it('retains distinct gun-feel, animation, rendering, and network contracts', () => {
    const weaponIds = Object.keys(CONFIG.weapons) as WeaponId[];
    const feelSignatures = weaponIds.map((id) => {
      const weapon = CONFIG.weapons[id];
      return [weapon.rpm, weapon.spreadHip, weapon.spreadAds, weapon.recoilVertical, weapon.recoilHorizontal, weapon.reloadMs].join(':');
    });
    expect(new Set(feelSignatures).size).toBe(weaponIds.length);
    expect(Object.keys(CONFIG.rendering.viewmodel.animation.actionMs).sort()).toEqual([...weaponIds].sort());
    expect(new Set(Object.values(CONFIG.rendering.viewmodel.animation.actionMs)).size).toBe(weaponIds.length);
    expect(CONFIG.rendering.frameSampleWindow).toBe(CONFIG.rendering.targetFps * 30);
    expect(CONFIG.rendering.drawCallBudget).toBeLessThanOrEqual(150);
    expect(CONFIG.debug.stressRemotePoses).toHaveLength(3);

    const sceneSource = readFileSync(new URL('../src/game/PreludeScene.ts', import.meta.url), 'utf8');
    const enemySource = readFileSync(new URL('../src/game/EnemyRenderer.ts', import.meta.url), 'utf8');
    const roomSource = readFileSync(new URL('../server/src/StahlbunkerRoom.ts', import.meta.url), 'utf8');
    const materialSource = readFileSync(new URL('../scripts/generate-material-atlas.ts', import.meta.url), 'utf8');
    for (const movingPart of ['vm-magazine', 'vm-bolt', 'vm-pump', 'vm-break-barrel', 'vm-cylinder', 'vm-heavy-cover']) {
      expect(sceneSource).toContain(movingPart);
    }
    for (const state of ["enemy.state === 'spawn'", "enemy.state === 'tear'", "enemy.state === 'vault'", "enemy.state === 'attack'", "enemy.state === 'dead'"]) {
      expect(enemySource).toContain(state);
    }
    expect(roomSource).toContain('actionSequences');
    expect(roomSource).toContain('enemyHistory');
    expect(roomSource).toContain('CONFIG.coop.rewindMs');
    expect(sceneSource).toContain('CONFIG.debug.stressRemotePoses');
    expect(materialSource).toContain('modulo');
    expect(materialSource).toContain('wrappedDistance');
  });
});
