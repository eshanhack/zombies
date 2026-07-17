import { describe, expect, it } from 'vitest';
import { coopZombieCount, soloZombieCount, spawnIntervalMs, upgradedMagazine, wolfCount, wolfHealth, zombieHealth } from '../src/shared/formulas';

describe('canonical formulas', () => {
  it('matches zombie health breakpoints', () => {
    expect(zombieHealth(1)).toBe(150);
    expect(zombieHealth(9)).toBe(950);
    expect(zombieHealth(10)).toBe(1045);
  });

  it('matches solo round counts', () => {
    expect(Array.from({ length: 9 }, (_, index) => soloZombieCount(index + 1))).toEqual([6, 8, 13, 18, 24, 27, 28, 30, 33]);
    expect(soloZombieCount(10)).toBe(36);
    expect(soloZombieCount(25)).toBe(90);
  });

  it('matches historical multiplayer opening counts', () => {
    expect(coopZombieCount(1, 2)).toBe(7);
    expect(coopZombieCount(1, 4)).toBe(10);
  });

  it('lerps spawn intervals through round twenty', () => {
    expect(spawnIntervalMs(1)).toBe(2000);
    expect(spawnIntervalMs(20)).toBe(500);
    expect(spawnIntervalMs(50)).toBe(500);
  });

  it('applies the upgrade magazine rule', () => {
    expect(upgradedMagazine('doppelhieb')).toBe(4);
    expect(upgradedMagazine('sturmvogel')).toBe(48);
  });

  it('scales wolf rounds', () => {
    expect(wolfHealth(1)).toBe(400);
    expect(wolfHealth(5)).toBe(1600);
    expect(wolfCount(1, 4)).toBe(24);
    expect(wolfCount(3, 2)).toBe(16);
  });
});

