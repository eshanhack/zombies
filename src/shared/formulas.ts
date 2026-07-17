import { CONFIG, type WeaponId } from '../config.js';

export function zombieHealth(round: number): number {
  if (round <= 1) return CONFIG.zombie.baseHp;
  if (round <= 9) return CONFIG.zombie.baseHp + (round - 1) * CONFIG.zombie.hpAddPerRoundThrough9;
  const roundNineHealth = CONFIG.zombie.baseHp + 8 * CONFIG.zombie.hpAddPerRoundThrough9;
  return Math.round(roundNineHealth * CONFIG.zombie.hpMultiplierFrom10 ** (round - 9));
}

export function soloZombieCount(round: number): number {
  const handTuned = CONFIG.rounds.soloCounts[round - 1];
  return handTuned ?? CONFIG.rounds.countFrom10(round);
}

export function coopZombieCount(round: number, players: number): number {
  if (players <= 1) return soloZombieCount(round);
  const factor = CONFIG.coop.earlyRoundFactors[round - 1] ?? 1;
  const base = 24 + (players - 1) * 6 * Math.max(1, round / 5);
  return Math.floor(base * factor);
}

export function spawnIntervalMs(round: number): number {
  const progress = Math.min(1, Math.max(0, (round - 1) / 19));
  const [early, late] = CONFIG.rounds.spawnTrickleMs;
  return early + (late - early) * progress;
}

export function upgradedMagazine(weaponId: WeaponId): number {
  const base = CONFIG.weapons[weaponId].magazine;
  const multiplier = base <= CONFIG.forge.smallMagazineThreshold
    ? CONFIG.forge.smallMagazineMultiplier
    : CONFIG.forge.largeMagazineMultiplier;
  return Math.ceil(base * multiplier);
}

export function wolfHealth(appearance: number): number {
  return CONFIG.wolves.healthByAppearance[Math.min(appearance - 1, CONFIG.wolves.healthByAppearance.length - 1)] ?? CONFIG.wolves.healthByAppearance[0];
}

export function wolfCount(appearance: number, players: number): number {
  const perPlayer = appearance <= 2 ? CONFIG.wolves.firstTwoCountPerPlayer : CONFIG.wolves.laterCountPerPlayer;
  return perPlayer * players;
}
