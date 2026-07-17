import { describe, expect, it } from 'vitest';
import { CONFIG, type PerkId } from '../src/config.js';
import { DOORS, PERK_MACHINES, POWER_SWITCH, WINDOWS } from '../src/map/blueprint.js';
import { GameSimulation, type SimEnemy, type SimPlayer } from '../src/shared/GameSimulation.js';

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

function hold(simulation: GameSimulation, player: SimPlayer, players: readonly SimPlayer[], milliseconds: number): void {
  simulation.setInteractionHeld(player.id, true);
  advance(simulation, milliseconds, players);
  simulation.setInteractionHeld(player.id, false);
}

function target(simulation: GameSimulation, player: SimPlayer, hp: number = CONFIG.zombie.baseHp, z: number = -2): SimEnemy {
  const enemy = simulation.forceSpawn([player]);
  if (enemy === null) throw new Error('Expected target.');
  Object.assign(enemy, { x: 0, y: 0, z, hp, maxHp: hp, state: 'chase', spawnProgress: 1 });
  return enemy;
}

function openMap(simulation: GameSimulation): void {
  for (const door of DOORS) simulation.setDoorOpen(door.id, true);
}

describe('P5 power and perks', () => {
  it('keeps machines inactive before power and stages the shared breaker exactly once', () => {
    const simulation = new GameSimulation({ seed: 12, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    openMap(simulation);
    const quickRevive = PERK_MACHINES.find((machine) => machine.id === 'zweiterAtem')!;
    const player = survivor('electrician', { x: quickRevive.x, y: quickRevive.y, z: quickRevive.z });
    expect(simulation.getInteractionTarget(player)?.kind).toBe('inactive');
    player.x = POWER_SWITCH.x;
    player.y = 0;
    player.z = POWER_SWITCH.z;
    expect(simulation.getInteractionTarget(player)?.kind).toBe('power');
    hold(simulation, player, [player], CONFIG.controller.interactionHoldMs);
    expect(simulation.powerOn).toBe(true);
    expect(simulation.powerActivationElapsedMs).toBe(0);
    advance(simulation, CONFIG.power.activationMs, [player]);
    expect(simulation.powerActivationElapsedMs).toBe(CONFIG.power.activationMs);
    expect(simulation.getInteractionTarget(player)?.kind).not.toBe('power');
  });

  it.each(PERK_MACHINES)('charges and grants $id only after the 3-second drink lock', (machine) => {
    const simulation = new GameSimulation({ seed: 22, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    openMap(simulation);
    simulation.setPowerOn(true);
    const player = survivor(`drinker-${machine.id}`, { x: machine.x, y: machine.y, z: machine.z });
    const cost = machine.id === 'zweiterAtem' ? CONFIG.perks.zweiterAtem.costSolo : CONFIG.perks[machine.id].cost;
    const before = player.points;
    hold(simulation, player, [player], CONFIG.controller.interactionHoldMs);
    const combat = simulation.getCombatState(player.id);
    expect(player.points).toBe(before - cost);
    expect(combat.pendingPerk).toBe(machine.id);
    expect(simulation.fire(player, false)).toMatchObject({ accepted: false, reason: 'unavailable' });
    advance(simulation, CONFIG.perkRuntime.purchaseAnimationMs - 1, [player]);
    expect(combat.perks).not.toContain(machine.id);
    advance(simulation, 1, [player]);
    expect(combat.perks).toContain(machine.id);
    expect(combat.pendingPerk).toBe('');
  });

  it('measures Eisenbräu at exactly five 50-damage hits and normal regeneration timing', () => {
    const simulation = new GameSimulation({ seed: 3, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    const player = survivor('tank');
    simulation.grantPerk(player, 'eisenbrau');
    expect([player.hp, player.maxHp]).toEqual([CONFIG.perkRuntime.eisenbrauHp, CONFIG.perkRuntime.eisenbrauHp]);
    for (let hit = 0; hit < 4; hit += 1) {
      simulation.applyPlayerDamage(player, CONFIG.zombie.hitDamage);
      expect(player.downed).toBe(false);
      advance(simulation, CONFIG.player.postHitInvulnMs, [player]);
    }
    expect(player.hp).toBe(50);
    simulation.applyPlayerDamage(player, CONFIG.zombie.hitDamage);
    expect(player.downed).toBe(true);
    expect(simulation.getCombatState(player.id).perks).toEqual([]);

    const regenSimulation = new GameSimulation({ seed: 4, mode: 'solo', rosterSize: 1 });
    quiet(regenSimulation);
    const regen = survivor('regen');
    regenSimulation.applyPlayerDamage(regen, 50);
    advance(regenSimulation, CONFIG.player.regenDelayMs - 1, [regen]);
    expect(regen.hp).toBe(50);
    advance(regenSimulation, 1 + CONFIG.player.regenDurationMs, [regen]);
    expect(regen.hp).toBe(CONFIG.player.maxHp);
  });

  it('halves reload duration and raises fire rate by exactly 33%', () => {
    const reloadSimulation = new GameSimulation({ seed: 5, mode: 'solo', rosterSize: 1 });
    quiet(reloadSimulation);
    const reloader = survivor('reloader');
    reloadSimulation.grantPerk(reloader, 'schnellwasser');
    const reloadWeapon = reloadSimulation.getCombatState(reloader.id).weapons[0]!;
    reloadWeapon.magazine = 0;
    reloadSimulation.requestReload(reloader.id);
    const reloadMs = CONFIG.weapons.melder.reloadMs * CONFIG.perkRuntime.schnellwasserReloadMultiplier;
    advance(reloadSimulation, reloadMs - 1, [reloader]);
    expect(reloadWeapon.magazine).toBe(0);
    advance(reloadSimulation, 1, [reloader]);
    expect(reloadWeapon.magazine).toBe(CONFIG.weapons.melder.magazine);

    const fireSimulation = new GameSimulation({ seed: 6, mode: 'solo', rosterSize: 1 });
    quiet(fireSimulation);
    const gunner = survivor('gunner', { yaw: Math.PI });
    fireSimulation.grantPerk(gunner, 'doppelschuss');
    expect(fireSimulation.fire(gunner, false).accepted).toBe(true);
    const cadence = 60000 / (CONFIG.weapons.melder.rpm * CONFIG.perkRuntime.doppelschussFireRateMultiplier);
    advance(fireSimulation, cadence - 1, [gunner]);
    expect(fireSimulation.fire(gunner, false)).toMatchObject({ accepted: false, reason: 'cooldown' });
    advance(fireSimulation, 1, [gunner]);
    expect(fireSimulation.fire(gunner, false).accepted).toBe(true);
  });

  it('consumes one of three solo self-revives, restores weapons after 3 seconds, and removes every perk', () => {
    const simulation = new GameSimulation({ seed: 8, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    const player = survivor('solo-revive');
    simulation.grantWeapon(player.id, 'jaeger');
    simulation.grantPerk(player, 'eisenbrau');
    simulation.grantPerk(player, 'zweiterAtem');
    simulation.applyPlayerDamage(player, CONFIG.perkRuntime.eisenbrauHp);
    const combat = simulation.getCombatState(player.id);
    expect(player.downed).toBe(true);
    expect(combat.selfRevivesRemaining).toBe(CONFIG.perkRuntime.soloSelfReviveStock - 1);
    expect(combat.weapons.map((weapon) => weapon.id)).toEqual(['melder']);
    expect(combat.perks).toEqual([]);
    advance(simulation, CONFIG.perkRuntime.soloSelfReviveMs - 1, [player]);
    expect(player.downed).toBe(true);
    advance(simulation, 1, [player]);
    expect(player.downed).toBe(false);
    expect(combat.weapons.map((weapon) => weapon.id)).toEqual(['melder', 'jaeger']);
    expect(player.hp).toBe(CONFIG.player.maxHp);
  });
});

describe('P5 power-ups', () => {
  it('preserves loaded magazines on Max Ammo while refilling every reserve and all grenades', () => {
    const simulation = new GameSimulation({ seed: 10, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    const player = survivor('max-ammo', { x: 2, z: 2 });
    simulation.grantWeapon(player.id, 'jaeger');
    const combat = simulation.getCombatState(player.id);
    combat.weapons[0]!.magazine = 3;
    combat.weapons[0]!.reserve = 0;
    combat.weapons[1]!.magazine = 2;
    combat.weapons[1]!.reserve = 0;
    combat.grenades = 0;
    simulation.debugSpawnPowerup('maxAmmo', player.x, player.y, player.z);
    advance(simulation, 0, [player]);
    expect(combat.weapons.map((weapon) => [weapon.magazine, weapon.reserve])).toEqual([
      [3, CONFIG.weapons.melder.reserve],
      [2, CONFIG.weapons.jaeger.reserve],
    ]);
    expect(combat.grenades).toBe(CONFIG.combat.maxGrenades);
  });

  it('doubles every earned point source, including melee and barrier repair', () => {
    const simulation = new GameSimulation({ seed: 11, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    const player = survivor('double', { points: 500 });
    simulation.debugSpawnPowerup('doublePoints', player.x, player.y, player.z);
    advance(simulation, 0, [player]);
    const enemy = target(simulation, player);
    expect(simulation.melee(player)).toMatchObject({ killed: true, points: CONFIG.points.killMelee * 2 });
    expect(enemy.state).toBe('dead');
    const window = WINDOWS[0]!;
    const barrier = simulation.barriers.get(window.id)!;
    barrier.boards = CONFIG.barriers.boardSlots - 1;
    player.x = window.insideX;
    player.z = window.insideZ;
    simulation.setRepairHeld(player.id, true);
    advance(simulation, CONFIG.barriers.repairMs, [player]);
    simulation.setRepairHeld(player.id, false);
    expect(player.points).toBe(500 + CONFIG.points.killMelee * 2 + CONFIG.points.boardRepair * 2);
  });

  it('makes all damage lethal for 30 seconds and expires on the exact timer', () => {
    const simulation = new GameSimulation({ seed: 12, mode: 'solo', rosterSize: 1 });
    quiet(simulation);
    const player = survivor('insta', { pitch: Math.atan2(0.8 - CONFIG.controller.eyeHeightM, 2) });
    const enemy = target(simulation, player, 10_000);
    simulation.debugSpawnPowerup('instaKill', player.x, player.y, player.z);
    advance(simulation, 0, [player]);
    expect(simulation.effects.instaKillRemainingMs).toBe(CONFIG.powerups.instaKillMs);
    expect(simulation.fire(player, true).killed).toBe(true);
    expect(enemy.state).toBe('dead');
    advance(simulation, CONFIG.powerups.instaKillMs, [player]);
    expect(simulation.effects.instaKillRemainingMs).toBe(0);
  });

  it('detonates Nuke after 500ms without consuming the spawn queue and awards 400 team-wide', () => {
    const simulation = new GameSimulation({ seed: 13, mode: 'coop', rosterSize: 2 });
    quiet(simulation);
    const first = survivor('first', { points: 500 });
    const second = survivor('second', { points: 500, x: 4 });
    for (let index = 0; index < 3; index += 1) target(simulation, first, 150, -3 - index);
    const queuedBefore = simulation.queued;
    simulation.debugSpawnPowerup('nuke', first.x, first.y, first.z);
    advance(simulation, 0, [first, second]);
    expect([first.points, second.points]).toEqual([900, 900]);
    advance(simulation, CONFIG.powerups.nukeDelayMs - 1, [first, second]);
    expect(simulation.aliveCount).toBe(3);
    advance(simulation, 1, [first, second]);
    expect(simulation.aliveCount).toBe(0);
    expect(simulation.queued).toBe(queuedBefore);
  });

  it('repairs every barrier, awards 200 team-wide, and despawns an untouched drop at 30 seconds', () => {
    const simulation = new GameSimulation({ seed: 14, mode: 'coop', rosterSize: 2 });
    quiet(simulation);
    const first = survivor('first', { points: 500 });
    const second = survivor('second', { points: 500, x: 5 });
    for (const barrier of simulation.barriers.values()) barrier.boards = 0;
    simulation.debugSpawnPowerup('carpenter', first.x, first.y, first.z);
    advance(simulation, 0, [first, second]);
    expect([...simulation.barriers.values()].every((barrier) => barrier.boards === CONFIG.barriers.boardSlots)).toBe(true);
    expect([first.points, second.points]).toEqual([700, 700]);
    const untouched = simulation.debugSpawnPowerup('maxAmmo', 100, 0, 100);
    advance(simulation, CONFIG.powerups.despawnMs - 1, [first, second]);
    expect(simulation.powerups.has(untouched.id)).toBe(true);
    advance(simulation, 1, [first, second]);
    expect(simulation.powerups.has(untouched.id)).toBe(false);
  });
});

describe('P5 co-op downs, revives, and return rules', () => {
  it.each([
    { perk: null, expectedMs: CONFIG.coop.reviveMs },
    { perk: 'zweiterAtem' as PerkId, expectedMs: CONFIG.coop.reviveMs * CONFIG.coop.quickReviveMultiplier },
  ])('revives in exactly $expectedMs ms and awards 50 to the reviver', ({ perk, expectedMs }) => {
    const simulation = new GameSimulation({ seed: 18, mode: 'coop', rosterSize: 2 });
    quiet(simulation);
    const reviver = survivor('reviver', { points: 500, x: 0 });
    const downed = survivor('downed', { points: 700, x: 0.8 });
    if (perk !== null) simulation.grantPerk(reviver, perk);
    simulation.grantPerk(downed, 'eisenbrau');
    simulation.applyPlayerDamage(downed, CONFIG.perkRuntime.eisenbrauHp);
    expect(downed.downed).toBe(true);
    expect(simulation.getCombatState(downed.id).perks).toEqual([]);
    simulation.setInteractionHeld(reviver.id, true);
    advance(simulation, expectedMs - 1, [reviver, downed]);
    expect(downed.downed).toBe(true);
    advance(simulation, 1, [reviver, downed]);
    simulation.setInteractionHeld(reviver.id, false);
    expect(downed.downed).toBe(false);
    expect(reviver.points).toBe(500 + CONFIG.coop.reviveAward);
  });

  it('bleeds out at 30 seconds, returns next round with Melder and preserved points, and preserves reconnect inventory', () => {
    const simulation = new GameSimulation({ seed: 19, mode: 'coop', rosterSize: 2 });
    quiet(simulation);
    const active = survivor('active', { invulnerableUntilMs: Number.POSITIVE_INFINITY });
    const casualty = survivor('casualty', { points: 1234, x: 2 });
    simulation.grantWeapon(casualty.id, 'richter');
    simulation.applyPlayerDamage(casualty, CONFIG.player.maxHp);
    advance(simulation, CONFIG.coop.bleedoutMs - 1, [active, casualty]);
    expect(casualty.downed).toBe(true);
    advance(simulation, 1, [active, casualty]);
    expect(casualty.spectating).toBe(true);
    expect(simulation.getLifeState(casualty.id).dead).toBe(true);
    simulation.debugStartRound(2, [active, casualty]);
    expect(casualty.spectating).toBe(false);
    expect(casualty.points).toBe(1234);
    expect(simulation.getCombatState(casualty.id).weapons.map((weapon) => weapon.id)).toEqual(['melder']);

    simulation.grantWeapon(casualty.id, 'kettenhund');
    simulation.grantPerk(casualty, 'schnellwasser');
    casualty.points = 4321;
    simulation.markReconnectPending(casualty);
    simulation.debugStartRound(3, [active, casualty]);
    expect(casualty.spectating).toBe(false);
    expect(casualty.points).toBe(4321);
    expect(simulation.getCombatState(casualty.id).weapons.map((weapon) => weapon.id)).toEqual(['melder', 'kettenhund']);
    expect(simulation.getCombatState(casualty.id).perks).toContain('schnellwasser');
  });

  it('ends the run only when every connected active player is down or dead', () => {
    const simulation = new GameSimulation({ seed: 20, mode: 'coop', rosterSize: 2 });
    quiet(simulation);
    const first = survivor('first');
    const second = survivor('second', { x: 3 });
    simulation.applyPlayerDamage(first, CONFIG.player.maxHp);
    advance(simulation, 0, [first, second]);
    expect(simulation.gameOver).toBe(false);
    simulation.applyPlayerDamage(second, CONFIG.player.maxHp);
    advance(simulation, 0, [first, second]);
    expect(simulation.gameOver).toBe(true);
  });
});

describe('P5 Höllenwölfe rounds', () => {
  it('schedules deterministically from rounds 5–7 and uses exact roster counts and active caps', () => {
    const left = new GameSimulation({ seed: 12345, mode: 'solo', rosterSize: 1 });
    const right = new GameSimulation({ seed: 12345, mode: 'solo', rosterSize: 1 });
    expect(left.nextWolfRound).toBe(right.nextWolfRound);
    expect(left.nextWolfRound).toBeGreaterThanOrEqual(CONFIG.wolves.firstRoundMin);
    expect(left.nextWolfRound).toBeLessThanOrEqual(CONFIG.wolves.firstRoundMax);

    const solo = survivor('solo', { invulnerableUntilMs: Number.POSITIVE_INFINITY });
    left.debugStartRound(left.nextWolfRound, [solo]);
    expect(left).toMatchObject({ roundKind: 'wolves', totalThisRound: CONFIG.wolves.firstTwoCountPerPlayer });
    advance(left, 5_000, [solo]);
    expect(left.aliveCount).toBe(CONFIG.wolves.maxActivePerPlayer);
    expect([...left.enemies.values()].filter((enemy) => enemy.state !== 'dead').every((enemy) => enemy.kind === 'wolf'
      && enemy.maxHp === CONFIG.wolves.healthByAppearance[0] && enemy.speed === CONFIG.wolves.speedMps)).toBe(true);

    const two = new GameSimulation({ seed: 1, mode: 'coop', rosterSize: 2 });
    two.nextWolfRound = 5;
    two.debugStartRound(5, [survivor('a'), survivor('b')]);
    expect(two.totalThisRound).toBe(CONFIG.wolves.firstTwoCountPerPlayer * 2);
    const four = new GameSimulation({ seed: 1, mode: 'coop', rosterSize: 4 });
    four.nextWolfRound = 5;
    four.debugStartRound(5, [survivor('a'), survivor('b'), survivor('c'), survivor('d')]);
    expect(four.totalThisRound).toBe(CONFIG.wolves.firstTwoCountPerPlayer * 4);
  });

  it('progresses health 400/900/1300/1600 capped and guarantees final-wolf Max Ammo', () => {
    const simulation = new GameSimulation({ seed: 21, mode: 'solo', rosterSize: 1 });
    const player = survivor('hunter', { x: 40, invulnerableUntilMs: Number.POSITIVE_INFINITY });
    const health: number[] = [];
    for (let appearance = 0; appearance < 5; appearance += 1) {
      const round = 5 + appearance * 6;
      simulation.nextWolfRound = round;
      simulation.debugStartRound(round, [player]);
      const wolf = simulation.forceSpawn([player]);
      if (wolf === null) throw new Error('Expected wolf.');
      health.push(wolf.maxHp);
    }
    expect(health).toEqual([400, 900, 1300, 1600, 1600]);

    simulation.nextWolfRound = 40;
    simulation.debugStartRound(40, [player]);
    let guard = 0;
    while ((simulation.queued > 0 || simulation.aliveCount > 0) && guard < 100) {
      advance(simulation, CONFIG.wolves.spawnIntervalMs, [player]);
      simulation.killAll();
      guard += 1;
    }
    expect(guard).toBeLessThan(100);
    const guaranteed = [...simulation.powerups.values()].find((powerup) => powerup.type === 'maxAmmo' && powerup.guaranteed);
    expect(guaranteed).toBeDefined();
  });

  it('deals exactly 40 damage with a 700ms attack cooldown', () => {
    const simulation = new GameSimulation({ seed: 30, mode: 'solo', rosterSize: 1 });
    simulation.nextWolfRound = 5;
    const player = survivor('victim');
    simulation.debugStartRound(5, [player]);
    const wolf = simulation.forceSpawn([player])!;
    Object.assign(wolf, { state: 'chase', spawnProgress: 1, x: 0, y: 0, z: -1 });
    advance(simulation, 1, [player]);
    advance(simulation, CONFIG.wolves.attackWindupMs - 1, [player]);
    expect(player.hp).toBe(CONFIG.player.maxHp);
    advance(simulation, 1, [player]);
    expect(player.hp).toBe(CONFIG.player.maxHp - CONFIG.wolves.damage);
    advance(simulation, CONFIG.wolves.attackCooldownMs - 1, [player]);
    expect(player.hp).toBe(CONFIG.player.maxHp - CONFIG.wolves.damage);
    advance(simulation, 1, [player]);
    expect(player.hp).toBe(CONFIG.player.maxHp - CONFIG.wolves.damage * 2);
  });
});
