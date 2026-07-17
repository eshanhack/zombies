import { CONFIG } from '../config.js';

const UINT32_MAX_PLUS_ONE = 0x1_0000_0000;

function hashLabel(seed: number, label: string): number {
  let hash = seed >>> 0;
  for (const character of label) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export class SeededRng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || CONFIG.simulation.seedFallback;
  }

  next(): number {
    let value = (this.state += 0x6d2b79f5);
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / UINT32_MAX_PLUS_ONE;
  }

  int(minInclusive: number, maxInclusive: number): number {
    return Math.floor(this.next() * (maxInclusive - minInclusive + 1)) + minInclusive;
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error('Cannot pick from an empty collection.');
    return item;
  }

  weightedIndex(weights: readonly number[]): number {
    const total = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
    if (total <= 0) throw new Error('At least one weight must be positive.');
    let target = this.next() * total;
    for (let index = 0; index < weights.length; index += 1) {
      target -= Math.max(0, weights[index] ?? 0);
      if (target <= 0) return index;
    }
    return weights.length - 1;
  }
}

export interface RngStreams {
  spawn: SeededRng;
  speed: SeededRng;
  drops: SeededRng;
  crate: SeededRng;
  wolves: SeededRng;
  spread: SeededRng;
  cosmetic: SeededRng;
}

export function createRngStreams(seed: number): RngStreams {
  return {
    spawn: new SeededRng(hashLabel(seed, 'spawn')),
    speed: new SeededRng(hashLabel(seed, 'speed')),
    drops: new SeededRng(hashLabel(seed, 'drops')),
    crate: new SeededRng(hashLabel(seed, 'crate')),
    wolves: new SeededRng(hashLabel(seed, 'wolves')),
    spread: new SeededRng(hashLabel(seed, 'spread')),
    cosmetic: new SeededRng(hashLabel(seed, 'cosmetic')),
  };
}

export function parseSeed(search: string): number {
  const value = new URLSearchParams(search).get('seed');
  if (value === null) return CONFIG.simulation.seedFallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed >>> 0 : CONFIG.simulation.seedFallback;
}
