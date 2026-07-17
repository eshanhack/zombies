import { describe, expect, it } from 'vitest';
import { CONFIG, type WeaponId } from '../src/config.js';
import { CRATE_LOCATIONS, DOORS, WALL_BUYS } from '../src/map/blueprint.js';
import { GameSimulation, type SimEnemy, type SimPlayer } from '../src/shared/GameSimulation.js';

const CONVENTIONAL_WEAPONS = [
  'melder',
  'jaeger',
  'kurier',
  'sturmvogel',
  'doppelhieb',
  'lasttraeger',
  'richter',
  'grabenfeger',
  'fernblick',
  'kettenhund',
] as const satisfies readonly WeaponId[];

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
    points: 100_000,
    connected: true,
    downed: false,
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

function holdInteract(simulation: GameSimulation, player: SimPlayer): void {
  simulation.setInteractionHeld(player.id, true);
  advance(simulation, CONFIG.controller.interactionHoldMs, [player]);
  simulation.setInteractionHeld(player.id, false);
}

function makeTarget(simulation: GameSimulation, player: SimPlayer, z = -2, hp = 1_000_000): SimEnemy {
  const enemy = simulation.forceSpawn([player]);
  if (enemy === null) throw new Error('Expected a target.');
  Object.assign(enemy, { x: 0, y: 0, z, hp, maxHp: hp, state: 'chase', spawnProgress: 1 });
  return enemy;
}

describe('P4 conventional arsenal', () => {
  it.each(CONVENTIONAL_WEAPONS)('%s applies exact close-range damage, ammo use, and cadence', (weaponId) => {
    const simulation = new GameSimulation({ seed: 4488, mode: 'solo', rosterSize: 1 });
    const player = survivor('gunner', { pitch: Math.atan2(0.82 - CONFIG.controller.eyeHeightM, 2) });
    makeTarget(simulation, player);
    if (weaponId !== 'melder') simulation.grantWeapon(player.id, weaponId);
    const definition = CONFIG.weapons[weaponId];

    const fired = simulation.fire(player, true);
    expect(fired.accepted).toBe(true);
    expect(fired.pelletHits).toBe(definition.pellets);
    expect(fired.damage).toBeCloseTo(definition.damage * definition.pellets, 5);
    expect(fired.magazine).toBe(definition.magazine - 1);
    expect(simulation.fire(player, true)).toMatchObject({ accepted: false, reason: 'cooldown', magazine: definition.magazine - 1 });
    advance(simulation, 60000 / definition.rpm, [player]);
    expect(simulation.fire(player, true).accepted).toBe(true);
  });

  it.each(CONVENTIONAL_WEAPONS.filter((weaponId) => CONFIG.weapons[weaponId].reloadStyle === 'mag'))('%s completes its magazine reload at the exact table time', (weaponId) => {
    const simulation = new GameSimulation({ seed: 61, mode: 'solo', rosterSize: 1 });
    const player = survivor('reloader');
    if (weaponId !== 'melder') simulation.grantWeapon(player.id, weaponId);
    const state = simulation.getCombatState(player.id);
    const weapon = state.weapons[state.activeWeaponIndex]!;
    const definition = CONFIG.weapons[weaponId];
    weapon.magazine = 0;
    expect(simulation.requestReload(player.id).accepted).toBe(true);
    advance(simulation, definition.reloadMs - 1, [player]);
    expect(weapon.magazine).toBe(0);
    advance(simulation, 1, [player]);
    expect(weapon).toMatchObject({ magazine: definition.magazine, reserve: definition.reserve - definition.magazine });
  });

  it.each(CONVENTIONAL_WEAPONS)('%s applies its exact head multiplier', (weaponId) => {
    const simulation = new GameSimulation({ seed: 4488, mode: 'solo', rosterSize: 1 });
    const player = survivor('headshot', { pitch: Math.atan2(CONFIG.combat.headCenterHeightM - CONFIG.controller.eyeHeightM, 2) });
    makeTarget(simulation, player);
    if (weaponId !== 'melder') simulation.grantWeapon(player.id, weaponId);
    const definition = CONFIG.weapons[weaponId];
    const result = simulation.fire(player, true);
    expect(result.pelletHits).toBe(definition.pellets);
    expect(result.headshot).toBe(true);
    expect(result.damage).toBeCloseTo(definition.damage * definition.pellets * definition.headMultiplier, 5);
  });

  it('applies shotgun falloff after 8m and enforces the 600ms switch lock', () => {
    const simulation = new GameSimulation({ seed: 4488, mode: 'solo', rosterSize: 1 });
    const player = survivor('falloff', { pitch: Math.atan2(0.82 - CONFIG.controller.eyeHeightM, 10) });
    makeTarget(simulation, player, -10);
    simulation.grantWeapon(player.id, 'doppelhieb');
    const result = simulation.fire(player, true);
    expect(result.pelletHits).toBeGreaterThan(0);
    expect(result.damage).toBeLessThan(CONFIG.weapons.doppelhieb.damage * result.pelletHits);
    expect(result.damage).toBeGreaterThan(CONFIG.weapons.doppelhieb.damage * result.pelletHits * CONFIG.combat.shotgunMinimumDamageMultiplier);

    const switchSimulation = new GameSimulation({ seed: 9, mode: 'solo', rosterSize: 1 });
    const switcher = survivor('switcher', { yaw: Math.PI });
    switchSimulation.grantWeapon(switcher.id, 'jaeger');
    expect(switchSimulation.fire(switcher, false).accepted).toBe(true);
    expect(switchSimulation.switchWeapon(switcher.id, 0)).toBe(true);
    expect(switchSimulation.fire(switcher, false)).toMatchObject({ accepted: false, reason: 'cooldown' });
    advance(switchSimulation, CONFIG.controller.weaponSwitchMs - 1, [switcher]);
    expect(switchSimulation.fire(switcher, false)).toMatchObject({ accepted: false, reason: 'cooldown' });
    advance(switchSimulation, 1, [switcher]);
    expect(switchSimulation.fire(switcher, false).accepted).toBe(true);
  });

  it('loads Grabenfeger shell-by-shell and permits a loaded-shell fire cancel', () => {
    const simulation = new GameSimulation({ seed: 91, mode: 'solo', rosterSize: 1 });
    const player = survivor('loader', { yaw: Math.PI });
    simulation.grantWeapon(player.id, 'grabenfeger');
    const state = simulation.getCombatState(player.id);
    const weapon = state.weapons[state.activeWeaponIndex]!;
    weapon.magazine = 0;
    expect(simulation.requestReload(player.id).accepted).toBe(true);
    advance(simulation, CONFIG.weapons.grabenfeger.reloadMs, [player]);
    expect(weapon).toMatchObject({ magazine: 1, reserve: CONFIG.weapons.grabenfeger.reserve - 1 });
    expect(state.reloadingWeaponIndex).toBe(state.activeWeaponIndex);
    expect(simulation.fire(player, false)).toMatchObject({ accepted: true, magazine: 0 });
    expect(state.reloadingWeaponIndex).toBe(-1);
  });

  it('enforces the two-slot limit and replaces only the active slot', () => {
    const simulation = new GameSimulation({ seed: 5, mode: 'solo', rosterSize: 1 });
    simulation.grantWeapon('collector', 'jaeger');
    expect(simulation.getCombatState('collector').weapons.map((weapon) => weapon.id)).toEqual(['melder', 'jaeger']);
    simulation.grantWeapon('collector', 'richter');
    expect(simulation.getCombatState('collector').weapons.map((weapon) => weapon.id)).toEqual(['melder', 'richter']);
  });
});

describe('P4 economy and deterministic crate', () => {
  it.each(WALL_BUYS.filter((wall) => wall.kind === 'weapon'))('purchases $weaponId from its authored wall for the exact price', (wall) => {
    const simulation = new GameSimulation({ seed: 14, mode: 'solo', rosterSize: 1 });
    for (const door of DOORS) simulation.setDoorOpen(door.id, true);
    const playerY = wall.room === 'catwalk' ? CONFIG.map.catwalkY : 0;
    const player = survivor(`buyer-${wall.id}`, { x: wall.x, y: playerY, z: wall.z, points: wall.cost });
    holdInteract(simulation, player);
    expect(player.points).toBe(0);
    expect(simulation.getCombatState(player.id).weapons.some((weapon) => weapon.id === wall.weaponId)).toBe(true);
  });

  it('opens each door for the canonical price and charges only one simultaneous buyer', () => {
    const simulation = new GameSimulation({ seed: 17, mode: 'coop', rosterSize: 2 });
    const first = survivor('first', { x: -5.2, z: 5.5, points: DOORS[0]!.cost });
    const second = survivor('second', { x: -5.2, z: 5.5, points: DOORS[0]!.cost });
    simulation.setInteractionHeld(first.id, true);
    simulation.setInteractionHeld(second.id, true);
    advance(simulation, CONFIG.controller.interactionHoldMs, [first, second]);
    expect(simulation.openDoors.has('doorA')).toBe(true);
    expect([first.points, second.points].sort((left, right) => left - right)).toEqual([0, DOORS[0]!.cost]);

    first.x = -2.8;
    first.z = 12;
    first.points = DOORS[1]!.cost;
    simulation.setInteractionHeld(first.id, false);
    simulation.setInteractionHeld(first.id, true);
    advance(simulation, CONFIG.controller.interactionHoldMs, [first, second]);
    expect(simulation.openDoors.has('doorB')).toBe(true);
    expect(first.points).toBe(0);

    first.x = 10.6;
    first.y = CONFIG.map.catwalkY;
    first.z = 11.5;
    first.points = DOORS[2]!.cost;
    simulation.setInteractionHeld(first.id, false);
    simulation.setInteractionHeld(first.id, true);
    advance(simulation, CONFIG.controller.interactionHoldMs, [first, second]);
    expect(simulation.openDoors.has('doorC')).toBe(true);
    expect(first.points).toBe(0);
  });

  it('purchases a wall weapon, refills its reserve at half price, and resupplies grenades', () => {
    const simulation = new GameSimulation({ seed: 20, mode: 'solo', rosterSize: 1 });
    const jaegerWall = WALL_BUYS.find((wall) => wall.id === 'wall-jaeger')!;
    const player = survivor('buyer', { x: jaegerWall.x, y: 0, z: jaegerWall.z, points: 2_000 });
    holdInteract(simulation, player);
    expect(simulation.getCombatState(player.id).weapons.some((weapon) => weapon.id === 'jaeger')).toBe(true);
    expect(player.points).toBe(2_000 - CONFIG.weapons.jaeger.cost);

    const jaeger = simulation.getCombatState(player.id).weapons.find((weapon) => weapon.id === 'jaeger')!;
    jaeger.reserve = 1;
    holdInteract(simulation, player);
    expect(jaeger.reserve).toBe(CONFIG.weapons.jaeger.reserve);
    expect(player.points).toBe(2_000 - CONFIG.weapons.jaeger.cost - CONFIG.weapons.jaeger.cost * CONFIG.economy.wallAmmoFactor);

    const grenadeWall = WALL_BUYS.find((wall) => wall.id === 'wall-grenades')!;
    player.x = grenadeWall.x;
    player.z = grenadeWall.z;
    simulation.getCombatState(player.id).grenades = 0;
    holdInteract(simulation, player);
    expect(simulation.getCombatState(player.id).grenades).toBe(CONFIG.combat.maxGrenades);
    expect(player.points).toBe(2_000 - 200 - 100 - CONFIG.economy.grenadesX4);
  });

  it('reproduces all 200 seeded crate rolls and retains the specified 5% combined wonder weight', () => {
    const left = new GameSimulation({ seed: 12345, mode: 'solo', rosterSize: 1 });
    const right = new GameSimulation({ seed: 12345, mode: 'solo', rosterSize: 1 });
    const leftRolls = Array.from({ length: 200 }, () => left.debugRollCrate('roller', 0));
    const rightRolls = Array.from({ length: 200 }, () => right.debugRollCrate('roller', 0));
    expect(leftRolls).toEqual(rightRolls);
    expect(leftRolls).toHaveLength(200);
    const histogram = Object.fromEntries([...new Set(leftRolls)].map((result) => [result, leftRolls.filter((roll) => roll === result).length]));
    expect(histogram).toEqual({
      jaeger: 9,
      grabenfeger: 22,
      kurier: 23,
      sonnenpistole: 7,
      fernblick: 15,
      richter: 24,
      sturmvogel: 23,
      puppe: 31,
      doppelhieb: 19,
      lasttraeger: 10,
      kettenhund: 13,
      blitzwerfer: 4,
    });
    expect(CONFIG.mysteryCrate.weaponWeights.blitzwerfer + CONFIG.mysteryCrate.weaponWeights.sonnenpistole)
      .toBe(CONFIG.mysteryCrate.wonderWeaponWeightPct);
  });

  it('locks a spin to its purchaser, settles at five seconds, and expires ten seconds later', () => {
    const simulation = new GameSimulation({ seed: 1, mode: 'coop', rosterSize: 2 });
    simulation.setDoorOpen('doorA', true);
    const location = CRATE_LOCATIONS.find((candidate) => candidate.id === CONFIG.mysteryCrate.startingLocationId)!;
    const buyer = survivor('buyer', { x: location.x, y: location.y, z: location.z, points: 2_000 });
    const rival = survivor('rival', { x: location.x, y: location.y, z: location.z, points: 2_000 });
    holdInteract(simulation, buyer);
    expect(simulation.crate).toMatchObject({ phase: 'spinning', purchaserId: buyer.id, spinRemainingMs: CONFIG.mysteryCrate.spinMs });
    const rivalPoints = rival.points;
    holdInteract(simulation, rival);
    expect(rival.points).toBe(rivalPoints);
    advance(simulation, CONFIG.mysteryCrate.spinMs, [buyer, rival]);
    expect(simulation.crate.phase).toBe('available');
    expect(simulation.getInteractionTarget(rival)?.kind).not.toBe('crate');
    advance(simulation, CONFIG.mysteryCrate.grabWindowMs, [buyer, rival]);
    expect(simulation.crate.phase).toBe('closed');
  });

  it('down-weights held weapons by four and executes an exact Puppe refund plus relocation', () => {
    const unheld = new GameSimulation({ seed: 444, mode: 'solo', rosterSize: 1 });
    const held = new GameSimulation({ seed: 444, mode: 'solo', rosterSize: 1 });
    held.grantWeapon('roller', 'jaeger');
    const unheldJaegers = Array.from({ length: 1_000 }, () => unheld.debugRollCrate('roller', 0)).filter((roll) => roll === 'jaeger').length;
    const heldJaegers = Array.from({ length: 1_000 }, () => held.debugRollCrate('roller', 0)).filter((roll) => roll === 'jaeger').length;
    expect([unheldJaegers, heldJaegers]).toEqual([65, 19]);
    expect(CONFIG.mysteryCrate.heldWeaponWeightMultiplier).toBe(0.25);

    const puppeSimulation = new GameSimulation({ seed: 9, mode: 'solo', rosterSize: 1 });
    puppeSimulation.setDoorOpen('doorA', true);
    const location = CRATE_LOCATIONS.find((candidate) => candidate.id === CONFIG.mysteryCrate.startingLocationId)!;
    const player = survivor('puppe-buyer', { x: location.x, y: location.y, z: location.z, points: 2_000 });
    holdInteract(puppeSimulation, player);
    expect(player.points).toBe(2_000 - CONFIG.economy.mysteryCrate);
    advance(puppeSimulation, CONFIG.mysteryCrate.spinMs, [player]);
    expect(player.points).toBe(2_000);
    expect(puppeSimulation.crate).toMatchObject({ phase: 'closed', usesAtLocation: 0 });
    expect(puppeSimulation.crate.activeLocationId).not.toBe(CONFIG.mysteryCrate.startingLocationId);
    expect(puppeSimulation.drainEvents().some((event) => event.type === 'cratePuppe')).toBe(true);
  });
});

describe('P4 frag grenades', () => {
  it('awards a flat 50-point kill and turns nonlethal blast victims into crawlers', () => {
    const simulation = new GameSimulation({ seed: 7, mode: 'solo', rosterSize: 1 });
    const player = survivor('thrower', { points: 500 });
    const close = makeTarget(simulation, player, 0, CONFIG.zombie.baseHp);
    const far = makeTarget(simulation, player, -4, CONFIG.zombie.baseHp);
    const grenade = simulation.throwGrenade(player, CONFIG.combat.grenadeFuseMs);
    expect(grenade).not.toBeNull();
    advance(simulation, 0, [player]);
    expect(close.state).toBe('dead');
    expect(far).toMatchObject({ kind: 'crawler', state: 'chase', speed: CONFIG.zombie.crawlerSpeed });
    expect(far.hp).toBeGreaterThan(0);
    expect(player.points).toBe(500 + CONFIG.points.killExplosive);
  });
});
