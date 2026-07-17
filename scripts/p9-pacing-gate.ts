import { CONFIG } from '../src/config.js';
import { runNormalRoundBenchmark, runPacingCampaign } from '../src/shared/PacingHarness.js';

const seeds = CONFIG.pacingVerification.seeds.map((seed) => {
  const campaigns = Array.from(
    { length: CONFIG.pacingVerification.consecutiveRuns },
    () => runPacingCampaign(seed),
  );
  const canonical = JSON.stringify(campaigns[0]);
  if (!campaigns.every((campaign) => JSON.stringify(campaign) === canonical)) {
    throw new Error(`Seed ${seed} diverged across consecutive campaigns.`);
  }
  const benchmarks = CONFIG.pacingVerification.benchmarkRounds.map((round) => runNormalRoundBenchmark(seed, round));
  const outside = benchmarks.filter((benchmark) => !benchmark.insideEnvelope);
  if (outside.length > 0) {
    throw new Error(`Seed ${seed} missed pacing rounds: ${outside.map((entry) => entry.round).join(', ')}.`);
  }
  return {
    seed,
    consecutiveCampaigns: campaigns.length,
    wolfRounds: campaigns[0]!.wolfRounds,
    benchmarks: benchmarks.map((entry) => ({
      round: entry.round,
      zombies: entry.count,
      durationMs: entry.durationMs,
      envelopeMs: [entry.minimumMs, entry.maximumMs],
      peakAlive: entry.peakAlive,
    })),
  };
});

console.log(JSON.stringify({
  ok: true,
  fixedHz: CONFIG.simulation.hz,
  deviationsFromCanonicalConfig: [],
  seeds,
}, null, 2));
