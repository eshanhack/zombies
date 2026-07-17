import { describe, expect, it } from 'vitest';
import { createRngStreams, parseSeed, SeededRng } from '../src/shared/rng';

describe('seeded RNG', () => {
  it('repeats the same sequence', () => {
    const first = new SeededRng(12345);
    const second = new SeededRng(12345);
    expect(Array.from({ length: 20 }, () => first.next())).toEqual(Array.from({ length: 20 }, () => second.next()));
  });

  it('isolates named streams', () => {
    const streamsA = createRngStreams(42);
    const streamsB = createRngStreams(42);
    streamsA.cosmetic.next();
    expect(streamsA.spawn.next()).toBe(streamsB.spawn.next());
  });

  it('parses URL seeds', () => {
    expect(parseSeed('?seed=12345')).toBe(12345);
    expect(parseSeed('?seed=nope')).toBe(1945);
  });
});
