import { CONFIG } from '../config.js';
import { GameSimulation, type RoundKind, type SimPlayer } from './GameSimulation.js';

export interface PacingRoundResult {
  round: number;
  kind: RoundKind;
  count: number;
  durationMs: number;
  peakAlive: number;
}

export interface PacingCampaignResult {
  seed: number;
  rosterSize: number;
  wolfRounds: number[];
  rounds: PacingRoundResult[];
}

export interface PacingBenchmarkResult extends PacingRoundResult {
  seed: number;
  minimumMs: number;
  maximumMs: number;
  insideEnvelope: boolean;
}

const FIXED_STEP_MS = 1000 / CONFIG.simulation.hz;

export function pacingKillCadenceMs(round: number): number {
  const keyframes = CONFIG.pacingVerification.killCadenceKeyframes;
  const first = keyframes[0]!;
  if (round <= first.round) return first.cadenceMs;
  for (let index = 1; index < keyframes.length; index += 1) {
    const upper = keyframes[index]!;
    const lower = keyframes[index - 1]!;
    if (round > upper.round) continue;
    const alpha = (round - lower.round) / (upper.round - lower.round);
    return lower.cadenceMs + (upper.cadenceMs - lower.cadenceMs) * alpha;
  }
  return keyframes[keyframes.length - 1]!.cadenceMs;
}

export function runPacingCampaign(
  seed: number,
  rosterSize = 1,
  throughRound = CONFIG.pacingVerification.campaignThroughRound,
): PacingCampaignResult {
  const mode = rosterSize === 1 ? 'solo' : 'coop';
  const simulation = new GameSimulation({ seed, mode, rosterSize });
  const players = Array.from({ length: rosterSize }, (_, index) => pacingPlayer(`pacing-${index + 1}`, index));
  const rounds: PacingRoundResult[] = [];
  let activeRound = simulation.round;
  let activeKind = simulation.roundKind;
  let activeCount = simulation.totalThisRound;
  let roundStartedAtMs = simulation.elapsedMs;
  let nextKillAtMs = roundStartedAtMs + CONFIG.pacingVerification.initialEngagementMs;
  let peakAlive = 0;
  let ticksThisRound = 0;

  while (rounds.length < throughRound) {
    for (const player of players) {
      player.hp = player.maxHp;
      player.downed = false;
      player.invulnerableUntilMs = Number.POSITIVE_INFINITY;
    }
    simulation.update(FIXED_STEP_MS, players);
    ticksThisRound += 1;
    peakAlive = Math.max(peakAlive, simulation.aliveCount);

    if (simulation.phase === 'active' && simulation.elapsedMs + FIXED_STEP_MS >= nextKillAtMs) {
      const target = [...simulation.enemies.values()]
        .filter((enemy) => enemy.state !== 'dead')
        .sort((left, right) => left.id - right.id)[0];
      if (target !== undefined) {
        simulation.applyExplosiveDamage(target.id, target.hp, true);
        const cadence = activeKind === 'wolves'
          ? CONFIG.pacingVerification.wolfKillCadenceMs
          : pacingKillCadenceMs(activeRound);
        nextKillAtMs += cadence;
      }
    }

    if (simulation.phase === 'intermission' && !rounds.some((entry) => entry.round === activeRound)) {
      rounds.push({
        round: activeRound,
        kind: activeKind,
        count: activeCount,
        durationMs: Math.round(simulation.elapsedMs - roundStartedAtMs),
        peakAlive,
      });
    }

    if (simulation.phase === 'active' && simulation.round !== activeRound) {
      activeRound = simulation.round;
      activeKind = simulation.roundKind;
      activeCount = simulation.totalThisRound;
      roundStartedAtMs = simulation.elapsedMs;
      nextKillAtMs = roundStartedAtMs + CONFIG.pacingVerification.initialEngagementMs;
      peakAlive = simulation.aliveCount;
      ticksThisRound = 0;
    }

    if (ticksThisRound > CONFIG.pacingVerification.maximumTicksPerRound) {
      throw new Error(`Pacing harness exceeded the tick budget on round ${activeRound}.`);
    }
  }

  return {
    seed,
    rosterSize,
    wolfRounds: rounds.filter((entry) => entry.kind === 'wolves').map((entry) => entry.round),
    rounds,
  };
}

export function runNormalRoundBenchmark(seed: number, round: number): PacingBenchmarkResult {
  const envelope = CONFIG.pacingVerification.envelopeMs[round as keyof typeof CONFIG.pacingVerification.envelopeMs];
  if (envelope === undefined) throw new Error(`No pacing envelope is configured for round ${round}.`);
  const simulation = new GameSimulation({ seed, mode: 'solo', rosterSize: 1 });
  const player = pacingPlayer('benchmark', 0);
  simulation.nextWolfRound = Number.POSITIVE_INFINITY;
  simulation.debugStartRound(round, [player]);
  const roundStartedAtMs = simulation.elapsedMs;
  let nextKillAtMs = roundStartedAtMs + CONFIG.pacingVerification.initialEngagementMs;
  let peakAlive = 0;
  let ticks = 0;

  while (simulation.phase === 'active') {
    player.hp = player.maxHp;
    player.downed = false;
    player.invulnerableUntilMs = Number.POSITIVE_INFINITY;
    simulation.update(FIXED_STEP_MS, [player]);
    peakAlive = Math.max(peakAlive, simulation.aliveCount);
    if (simulation.elapsedMs + FIXED_STEP_MS >= nextKillAtMs) {
      const target = [...simulation.enemies.values()]
        .filter((enemy) => enemy.state !== 'dead')
        .sort((left, right) => left.id - right.id)[0];
      if (target !== undefined) {
        simulation.applyExplosiveDamage(target.id, target.hp, true);
        nextKillAtMs += pacingKillCadenceMs(round);
      }
    }
    ticks += 1;
    if (ticks > CONFIG.pacingVerification.maximumTicksPerRound) {
      throw new Error(`Normal-round benchmark exceeded the tick budget on round ${round}.`);
    }
  }

  const durationMs = Math.round(simulation.elapsedMs - roundStartedAtMs);
  return {
    seed,
    round,
    kind: 'zombies',
    count: simulation.totalThisRound,
    durationMs,
    peakAlive,
    minimumMs: envelope[0],
    maximumMs: envelope[1],
    insideEnvelope: durationMs >= envelope[0] && durationMs <= envelope[1],
  };
}

function pacingPlayer(id: string, index: number): SimPlayer {
  return {
    id,
    x: CONFIG.map.startPosition.x + (index - 1.5) * CONFIG.coop.spawnSpacingM,
    y: CONFIG.map.startPosition.y,
    z: CONFIG.map.startPosition.z,
    yaw: 0,
    pitch: 0,
    hp: CONFIG.player.maxHp,
    maxHp: CONFIG.player.maxHp,
    points: CONFIG.points.starting,
    connected: true,
    downed: false,
    invulnerableUntilMs: Number.POSITIVE_INFINITY,
    spectating: false,
  };
}
