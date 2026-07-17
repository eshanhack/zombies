import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { DOORS, FORGE, WALL_BUYS } from '../src/map/blueprint.js';
import { GameSimulation, type SimEnemy, type SimPlayer } from '../src/shared/GameSimulation.js';
import { weaponMagazineCapacity } from '../src/shared/combat.js';
import { zombieHealth } from '../src/shared/formulas.js';

function survivor(id = 'player', overrides: Partial<SimPlayer> = {}): SimPlayer {
  return {
    id,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    hp: CONFIG.player.maxHp,
    maxHp: CONFIG.player.maxHp,
    points: 20_000,
    connected: true,
    downed: false,
    spectating: false,
    invulnerableUntilMs: 0,
    ...overrides,
  };
}

function advance(simulation: GameSimulation, milliseconds: number, players: readonly SimPlayer[]): void {
  let remaining = milliseconds;
  if (remaining === 0) simulation.update(0, players);
  while (remaining > 0) {
    const delta = Math.min(remaining, CONFIG.simulation.maxFrameDeltaMs);
    simulation.update(delta, players);
    remaining -= delta;
  }
}

function quiet(simulation: GameSimulation): void {
  simulation.phase = 'intermission';
  simulation.intermissionRemainingMs = Number.POSITIVE_INFINITY;
}

function openMap(simulation: GameSimulation): void {
  for (const door of DOORS) simulation.setDoorOpen(door.id, true);
}

function hold(simulation: GameSimulation, player: SimPlayer, players: readonly SimPlayer[], milliseconds: number): void {
  simulation.setInteractionHeld(player.id, true);
  advance(simulation, milliseconds, players);
  simulation.setInteractionHeld(player.id, false);
}

function spawnTarget(
  simulation: GameSimulation,
  players: readonly SimPlayer[],
  overrides: Partial<SimEnemy>,
): SimEnemy {
  const enemy = simulation.forceSpawn(players);
  if (enemy === null) throw new Error('Expected a target enemy.');
  Object.assign(enemy, { state: 'chase', spawnProgress: 1, stateTimeMs: 0, ...overrides });
  return enemy;
}

describe('P6 Die Schmiede', () => {
  it('is power-gated, globally exclusive, charges 5000, and returns the exact upgrade after 3 seconds', () => {
    const simulation = new GameSimulation({ seed: 61, mode: 'coop', rosterSize: 2 });
    quiet(simulation);
    openMap(simulation);
    const owner = survivor('owner', { x: FORGE.x, y: FORGE.y, z: FORGE.z });
    const observer = survivor('observer', { x: FORGE.x + 0.4, y: FORGE.y, z: FORGE.z });
    simulation.grantWeapon(owner.id, 'jaeger');
    const weapon = simulation.getCombatState(owner.id).weapons[1]!;
    weapon.magazine = 1;
    weapon.reserve = 0;

    expect(simulation.getInteractionTarget(owner)?.kind).toBe('inactive');
    simulation.setPowerOn(true);
    expect(simulation.getInteractionTarget(owner)).toMatchObject({ kind: 'forge', cost: CONFIG.economy.forgeUpgrade });
    const pointsBefore = owner.points;
    hold(simulation, owner, [owner, observer], CONFIG.controller.interactionHoldMs);
    expect(owner.points).toBe(pointsBefore - CONFIG.economy.forgeUpgrade);
    expect(simulation.forge).toMatchObject({ phase: 'upgrading', playerId: owner.id, weaponId: 'jaeger', remainingMs: CONFIG.forge.animationMs });
    expect(simulation.getInteractionTarget(observer)).toMatchObject({ kind: 'inactive', id: FORGE.id });
    expect(simulation.fire(owner, false)).toMatchObject({ accepted: false, reason: 'unavailable' });

    advance(simulation, CONFIG.forge.animationMs - 1, [owner, observer]);
    expect(weapon.upgraded).toBe(false);
    advance(simulation, 1, [owner, observer]);
    expect(simulation.forge.phase).toBe('idle');
    expect(weapon).toMatchObject({
      upgraded: true,
      magazine: CONFIG.weapons.jaeger.magazine * CONFIG.forge.smallMagazineMultiplier,
      reserve: CONFIG.weapons.jaeger.reserve,
    });
    expect(`${CONFIG.forge.namePrefix}${CONFIG.weapons.jaeger.name}`).toContain('Über-');
  });

  it('uses +100% small magazines, +50% large magazines, upgraded reload capacity, and exact doubled damage', () => {
    expect(weaponMagazineCapacity({ id: 'jaeger', upgraded: true })).toBe(10);
    expect(weaponMagazineCapacity({ id: 'sturmvogel', upgraded: true })).toBe(48);

    const simulation = new GameSimulation({ seed: 62, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    openMap(simulation);
    simulation.setPowerOn(true);
    const player = survivor('forged-gunner', { x: FORGE.x, y: FORGE.y, z: FORGE.z });
    simulation.grantWeapon(player.id, 'jaeger');
    hold(simulation, player, [player], CONFIG.controller.interactionHoldMs);
    advance(simulation, CONFIG.forge.animationMs, [player]);
    const weapon = simulation.getCombatState(player.id).weapons[1]!;
    weapon.magazine = 0;
    weapon.reserve = 20;
    expect(simulation.requestReload(player.id).accepted).toBe(true);
    advance(simulation, CONFIG.weapons.jaeger.reloadMs, [player]);
    expect([weapon.magazine, weapon.reserve]).toEqual([10, 10]);

    player.x = 0;
    player.y = 0;
    player.z = 0;
    player.yaw = 0;
    player.pitch = Math.atan2((CONFIG.combat.bodyBottomHeightM + CONFIG.combat.bodyTopHeightM) / 2 - CONFIG.controller.eyeHeightM, 3);
    const enemy = spawnTarget(simulation, [player], { x: 0, y: 0, z: -3, hp: 1_000, maxHp: 1_000 });
    const result = simulation.fire(player, true);
    expect(result).toMatchObject({ accepted: true, hit: true, headshot: false, damage: CONFIG.weapons.jaeger.damage * CONFIG.forge.damageMultiplier });
    expect(enemy.hp).toBe(1_000 - CONFIG.weapons.jaeger.damage * CONFIG.forge.damageMultiplier);
  });

  it('charges 4500 for upgraded wall ammunition, refills reserves, and never changes the loaded magazine', () => {
    const simulation = new GameSimulation({ seed: 63, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    const wall = WALL_BUYS.find((candidate) => candidate.weaponId === 'jaeger')!;
    const player = survivor('wall-ammo', { x: wall.x, y: 0, z: wall.z });
    simulation.grantWeapon(player.id, 'jaeger');
    const weapon = simulation.getCombatState(player.id).weapons[1]!;
    weapon.upgraded = true;
    weapon.magazine = 4;
    weapon.reserve = 0;
    const before = player.points;
    expect(simulation.getInteractionTarget(player)).toMatchObject({ kind: 'wallWeapon', cost: CONFIG.economy.upgradedWallAmmo });
    hold(simulation, player, [player], CONFIG.controller.interactionHoldMs);
    expect(player.points).toBe(before - CONFIG.economy.upgradedWallAmmo);
    expect([weapon.magazine, weapon.reserve]).toEqual([4, CONFIG.weapons.jaeger.reserve]);
  });
});

describe('P6 wonder weapons', () => {
  it('Blitzwerfer chains through exactly ten round-25 enemies in one shot and no more', () => {
    const simulation = new GameSimulation({ seed: 64, mode: 'solo', rosterSize: 1 });
    const player = survivor('lightning', { points: CONFIG.points.starting });
    simulation.grantWeapon(player.id, 'blitzwerfer');
    const pack = simulation.debugSpawnWonderPack(player, [player]);
    simulation.queued = 1;
    const eleventh = spawnTarget(simulation, [player], {
      x: player.x,
      y: player.y,
      z: player.z - CONFIG.debug.aimTargetDistanceM - CONFIG.debug.wonderPackSpacingM * 3,
      hp: zombieHealth(CONFIG.debug.wonderGateRound),
      maxHp: zombieHealth(CONFIG.debug.wonderGateRound),
    });
    simulation.queued = 0;
    player.pitch = Math.atan2(CONFIG.combat.headCenterHeightM - CONFIG.controller.eyeHeightM, CONFIG.debug.aimTargetDistanceM);
    const result = simulation.fire(player, true);
    expect(simulation.round).toBe(CONFIG.debug.wonderGateRound);
    expect(result).toMatchObject({ accepted: true, hit: true, killed: true, pelletHits: CONFIG.wonder.blitzChainTargets });
    expect(result.affectedEnemyIds).toHaveLength(CONFIG.wonder.blitzChainTargets);
    const allTargets = [...pack, eleventh];
    expect(allTargets.filter((enemy) => enemy.state === 'dead')).toHaveLength(CONFIG.wonder.blitzChainTargets);
    expect(allTargets.filter((enemy) => enemy.state !== 'dead')).toHaveLength(1);
    expect(player.points).toBe(CONFIG.points.starting + CONFIG.points.killExplosive * CONFIG.wonder.blitzChainTargets);
    expect(simulation.getCombatState(player.id).kills).toBe(CONFIG.wonder.blitzChainTargets);
  });

  it('Sonnenpistole applies direct plus splash, converts outer-blast survivors to crawlers, and damages its owner', () => {
    const simulation = new GameSimulation({ seed: 65, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    const player = survivor('sunner', { points: CONFIG.points.starting });
    simulation.grantWeapon(player.id, 'sonnenpistole');
    player.pitch = Math.atan2((CONFIG.combat.bodyBottomHeightM + CONFIG.combat.bodyTopHeightM) / 2 - CONFIG.controller.eyeHeightM, 3);
    const direct = spawnTarget(simulation, [player], { x: 0, y: 0, z: -3, hp: 1_500, maxHp: 1_500 });
    const inner = spawnTarget(simulation, [player], { x: 1, y: 0, z: -3, hp: 900, maxHp: 900 });
    const outer = spawnTarget(simulation, [player], { x: 4, y: 0, z: -3, hp: 500, maxHp: 500 });
    const result = simulation.fire(player, true);
    expect(result).toMatchObject({ accepted: true, hit: true, killed: true, headshot: false });
    expect(direct.state).toBe('dead');
    expect(inner.state).toBe('dead');
    expect(outer.state).not.toBe('dead');
    expect(outer.kind).toBe('crawler');
    expect(outer.hp).toBeGreaterThanOrEqual(1);
    expect(result.affectedEnemyIds).toEqual(expect.arrayContaining([direct.id, inner.id, outer.id]));
    expect(player.hp).toBeLessThan(CONFIG.player.maxHp);
    expect(player.downed).toBe(false);
    expect(player.points).toBe(CONFIG.points.starting + CONFIG.points.killExplosive * 2);
    expect(simulation.drainEvents()).toContainEqual(expect.objectContaining({ type: 'playerSelfDamaged', playerId: player.id }));
  });
});
