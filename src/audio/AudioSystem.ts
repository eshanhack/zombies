import { CONFIG, type PerkId, type PowerupId, type RoomId, type WeaponId } from '../config.js';
import type { SimulationEvent } from '../shared/GameSimulation.js';

export interface AudioPoint {
  x: number;
  y: number;
  z: number;
  room: RoomId;
}

export interface AudioEnemyEmitter extends AudioPoint {
  id: number;
  kind: 'zombie' | 'crawler' | 'wolf';
  state: 'spawn' | 'tear' | 'vault' | 'chase' | 'attack' | 'dead';
  speedTier: 'walk' | 'jog' | 'sprint';
}

export interface AudioPerkEmitter extends AudioPoint {
  id: PerkId;
}

export interface AudioFrame {
  elapsedMs: number;
  listener: AudioPoint & { yaw: number; pitch: number };
  healthRatio: number;
  movementSpeedMps: number;
  grounded: boolean;
  powerOn: boolean;
  roundKind: 'zombies' | 'wolves';
  enemies: readonly AudioEnemyEmitter[];
  perkMachines: readonly AudioPerkEmitter[];
}

export interface SpatialMix {
  distanceM: number;
  pan: number;
  attenuation: number;
  occluded: boolean;
  lowpassHz: number;
  dryGain: number;
  reverbSend: number;
}

export interface AudioDiagnostics {
  state: AudioContextState | 'uninitialized' | 'closed';
  sampleRateHz: number;
  mode: 'menu' | 'gameplay';
  activeVoices: number;
  cuesPlayed: number;
  cueCoverage: number;
  lastCue: string;
  listenerRoom: RoomId;
  occludedCues: number;
  reverberantCues: number;
  estimatedHeadroomDb: number;
  localizationGate: string;
}

export type AudioWorldCue =
  | 'enemySpawn'
  | 'boardTorn'
  | 'boardRepaired'
  | 'vault'
  | 'damage'
  | 'enemyDeath'
  | 'door'
  | 'purchase'
  | 'crateStart'
  | 'crateSettle'
  | 'cratePuppe'
  | 'crateCollect'
  | 'grenadeThrow'
  | 'explosion'
  | 'power'
  | 'perkDrink'
  | 'forgeStart'
  | 'forgeComplete'
  | 'forgeCancel'
  | 'powerupSpawn'
  | 'downed'
  | 'revived'
  | 'bledOut'
  | 'returned'
  | 'gameOver'
  | 'roundEnd';

export const AUDIO_EVENT_COVERAGE = {
  enemySpawned: 'enemySpawn',
  boardTorn: 'boardTorn',
  boardRepaired: 'boardRepaired',
  vaultStarted: 'vault',
  playerDamaged: 'damage',
  enemyKilled: 'enemyDeath',
  pointTransaction: 'purchase',
  doorOpened: 'door',
  weaponPurchased: 'purchase',
  ammoPurchased: 'purchase',
  grenadesPurchased: 'purchase',
  crateStarted: 'crateStart',
  crateSettled: 'crateSettle',
  cratePuppe: 'cratePuppe',
  crateCollected: 'crateCollect',
  grenadeThrown: 'grenadeThrow',
  grenadeExploded: 'explosion',
  powerActivated: 'power',
  perkPurchaseStarted: 'perkDrink',
  perkGranted: 'purchase',
  forgeStarted: 'forgeStart',
  forgeCompleted: 'forgeComplete',
  forgeCancelled: 'forgeCancel',
  playerSelfDamaged: 'damage',
  powerupSpawned: 'powerupSpawn',
  powerupCollected: 'purchase',
  playerDowned: 'downed',
  playerRevived: 'revived',
  playerBledOut: 'bledOut',
  playerReturned: 'returned',
  gameOver: 'gameOver',
  roundStarted: 'purchase',
  roundEnded: 'roundEnd',
} as const satisfies Record<SimulationEvent['type'], AudioWorldCue>;

interface AudioBuses {
  effects: GainNode;
  ambience: GainNode;
  music: GainNode;
  voice: GainNode;
  ui: GainNode;
}

interface MaterialCueProfile {
  durationMs: number;
  lowpassHz: number;
  gain: number;
  crackCount: number;
}

const MILLISECONDS_PER_SECOND = 1000;
const MIDI_A4_NOTE = 69;
const MIDI_A4_HZ = 440;
const SEMITONES_PER_OCTAVE = 12;

export function computeSpatialMix(source: AudioPoint, listener: AudioPoint & { yaw: number }): SpatialMix {
  const dx = source.x - listener.x;
  const dy = source.y - listener.y;
  const dz = source.z - listener.z;
  const horizontal = Math.hypot(dx, dz);
  const distanceM = Math.hypot(horizontal, dy);
  const rightX = Math.cos(listener.yaw);
  const rightZ = -Math.sin(listener.yaw);
  const pan = horizontal <= Number.EPSILON ? 0 : clamp((dx * rightX + dz * rightZ) / horizontal, -1, 1);
  const reference = CONFIG.audio.referenceDistanceM;
  const attenuation = distanceM <= reference
    ? 1
    : reference / (reference + CONFIG.audio.rolloffFactor * (distanceM - reference));
  const occluded = source.room !== listener.room;
  return {
    distanceM,
    pan,
    attenuation,
    occluded,
    lowpassHz: occluded ? CONFIG.audio.occlusionCutoffHz : CONFIG.audio.openCutoffHz,
    dryGain: attenuation * (occluded ? CONFIG.audio.occlusionGain : 1),
    reverbSend: CONFIG.audio.roomReverbSend[source.room],
  };
}

export class AudioSystem {
  private context: AudioContext | null = null;
  private masterOutput: GainNode | null = null;
  private buses: AudioBuses | null = null;
  private convolver: ConvolverNode | null = null;
  private reverbReturn: GainNode | null = null;
  private ambienceAirGain: GainNode | null = null;
  private ambienceFilter: BiquadFilterNode | null = null;
  private generatorHumGain: GainNode | null = null;
  private readonly bedSources: AudioScheduledSourceNode[] = [];
  private noiseBuffer: AudioBuffer | null = null;
  private noiseSeed: number = CONFIG.simulation.seedFallback;
  private mode: 'menu' | 'gameplay' = 'menu';
  private bedMode: 'menu' | 'gameplay' | null = null;
  private masterVolume: number = CONFIG.audio.masterGain;
  private activeVoices = 0;
  private cuesPlayed = 0;
  private lastCue = 'none';
  private listener: AudioPoint & { yaw: number; pitch: number } = { x: 0, y: 0, z: 0, room: 'start', yaw: 0, pitch: 0 };
  private occludedCues = 0;
  private reverberantCues = 0;
  private nextHeartbeatAtMs = 0;
  private nextPlayerStepAtMs = 0;
  private readonly nextEnemyVoiceAtMs = new Map<number, number>();
  private readonly nextEnemyStepAtMs = new Map<number, number>();
  private readonly nextMachineJingleAtMs = new Map<PerkId, number>();
  private readonly nextMachineHumAtMs = new Map<PerkId, number>();
  private localizationGate = 'not run';
  private lastPowerOn: boolean | null = null;
  private lastAcousticProfile = '';
  private disposed = false;

  constructor() {
    if (typeof document !== 'undefined') {
      document.addEventListener('pointerdown', this.unlock, { capture: true, once: true });
      document.addEventListener('keydown', this.unlock, { capture: true, once: true });
    }
  }

  setSeed(seed: number): void {
    this.noiseSeed = seed >>> 0 || CONFIG.simulation.seedFallback;
    this.noiseBuffer = null;
  }

  setMode(mode: 'menu' | 'gameplay'): void {
    this.mode = mode;
    if (this.context !== null) this.startAmbienceBed();
  }

  resume(): void {
    const context = this.ensureContext();
    if (context?.state === 'suspended') void context.resume();
  }

  setMasterVolume(value: number): void {
    this.masterVolume = clamp(value, 0, 1);
    const context = this.ensureContext();
    const output = this.masterOutput;
    if (context === null || output === null) return;
    output.gain.cancelScheduledValues(context.currentTime);
    output.gain.linearRampToValueAtTime(this.masterVolume, context.currentTime + seconds(CONFIG.audio.listenerRampMs));
  }

  getDiagnostics(): AudioDiagnostics {
    const strongestBus = Math.max(CONFIG.audio.effectsGain, CONFIG.audio.ambienceGain, CONFIG.audio.musicGain, CONFIG.audio.voiceGain, CONFIG.audio.uiGain);
    const peak = Math.max(CONFIG.audio.envelopeFloor, this.masterVolume * strongestBus);
    return {
      state: this.context?.state ?? (this.disposed ? 'closed' : 'uninitialized'),
      sampleRateHz: this.context?.sampleRate ?? CONFIG.audio.sampleRateHz,
      mode: this.mode,
      activeVoices: this.activeVoices,
      cuesPlayed: this.cuesPlayed,
      cueCoverage: Object.keys(AUDIO_EVENT_COVERAGE).length,
      lastCue: this.lastCue,
      listenerRoom: this.listener.room,
      occludedCues: this.occludedCues,
      reverberantCues: this.reverberantCues,
      estimatedHeadroomDb: Math.max(0, -20 * Math.log10(peak)),
      localizationGate: this.localizationGate,
    };
  }

  update(frame: AudioFrame): void {
    this.listener = frame.listener;
    const context = this.context;
    if (context === null || this.buses === null) return;
    this.updateListener(context, frame.listener);
    const acousticProfile = `${frame.listener.room}:${frame.roundKind}`;
    if (acousticProfile !== this.lastAcousticProfile) {
      this.lastAcousticProfile = acousticProfile;
      const wolfMultiplier = frame.roundKind === 'wolves' ? CONFIG.audio.ambience.wolfRoomFilterMultiplier : 1;
      this.rampParameter(this.ambienceFilter?.frequency, CONFIG.audio.ambience.roomFilterHz[frame.listener.room] * wolfMultiplier, CONFIG.audio.ambience.acousticTransitionMs);
      this.rampParameter(
        this.ambienceAirGain?.gain,
        CONFIG.audio.ambience.bunkerAirGain * (frame.roundKind === 'wolves' ? CONFIG.audio.ambience.wolfAirGainMultiplier : 1),
        CONFIG.audio.ambience.acousticTransitionMs,
      );
    }
    if (frame.powerOn !== this.lastPowerOn) {
      this.lastPowerOn = frame.powerOn;
      this.rampParameter(
        this.generatorHumGain?.gain,
        frame.powerOn ? CONFIG.audio.ambience.generatorHumGainOn : CONFIG.audio.ambience.generatorHumGainOff,
        CONFIG.audio.ambience.powerRampMs,
      );
    }

    if (frame.healthRatio <= CONFIG.audio.heartbeat.thresholdRatio && frame.elapsedMs >= this.nextHeartbeatAtMs) {
      this.playHeartbeat();
      this.nextHeartbeatAtMs = frame.elapsedMs + CONFIG.audio.heartbeat.intervalMs;
    }
    if (frame.grounded && frame.movementSpeedMps >= CONFIG.audio.footsteps.movementThresholdMps && frame.elapsedMs >= this.nextPlayerStepAtMs) {
      this.playMaterial('playerStep', undefined, CONFIG.audio.materialCues.concreteStep, 0);
      this.nextPlayerStepAtMs = frame.elapsedMs + (frame.movementSpeedMps > CONFIG.player.walkSpeed
        ? CONFIG.audio.footsteps.playerSprintIntervalMs
        : CONFIG.audio.footsteps.playerWalkIntervalMs);
    }

    const activeEnemyIds = new Set<number>();
    for (const enemy of frame.enemies) {
      if (enemy.state === 'dead') continue;
      activeEnemyIds.add(enemy.id);
      const distance = Math.hypot(enemy.x - frame.listener.x, enemy.y - frame.listener.y, enemy.z - frame.listener.z);
      if (distance > CONFIG.audio.footsteps.audibleEnemyRangeM) continue;
      const voiceDue = this.nextEnemyVoiceAtMs.get(enemy.id);
      if (voiceDue === undefined) {
        this.nextEnemyVoiceAtMs.set(enemy.id, frame.elapsedMs + this.enemyVoiceInterval(enemy));
      } else if (frame.elapsedMs >= voiceDue) {
        this.playEnemyVoice(enemy);
        this.nextEnemyVoiceAtMs.set(enemy.id, frame.elapsedMs + this.enemyVoiceInterval(enemy));
      }
      const stepDue = this.nextEnemyStepAtMs.get(enemy.id);
      if (stepDue === undefined) {
        this.nextEnemyStepAtMs.set(enemy.id, frame.elapsedMs + this.enemyStepInterval(enemy));
      } else if (frame.elapsedMs >= stepDue && (enemy.state === 'chase' || enemy.state === 'attack')) {
        this.playEnemyStep(enemy);
        this.nextEnemyStepAtMs.set(enemy.id, frame.elapsedMs + this.enemyStepInterval(enemy));
      }
    }
    for (const id of this.nextEnemyVoiceAtMs.keys()) if (!activeEnemyIds.has(id)) this.nextEnemyVoiceAtMs.delete(id);
    for (const id of this.nextEnemyStepAtMs.keys()) if (!activeEnemyIds.has(id)) this.nextEnemyStepAtMs.delete(id);

    for (const machine of frame.perkMachines) {
      const distance = Math.hypot(machine.x - frame.listener.x, machine.y - frame.listener.y, machine.z - frame.listener.z);
      if (distance > CONFIG.audio.ambience.machineAudibleRangeM) continue;
      const humDue = this.nextMachineHumAtMs.get(machine.id);
      if (humDue === undefined) {
        this.nextMachineHumAtMs.set(machine.id, frame.elapsedMs + CONFIG.audio.ambience.machineHumIntervalMs);
      } else if (frame.elapsedMs >= humDue) {
        this.playMachineHum(machine, frame.powerOn);
        this.nextMachineHumAtMs.set(machine.id, frame.elapsedMs + CONFIG.audio.ambience.machineHumIntervalMs);
      }
      if (frame.powerOn) {
        const due = this.nextMachineJingleAtMs.get(machine.id);
        if (due === undefined) {
          this.nextMachineJingleAtMs.set(machine.id, frame.elapsedMs + CONFIG.audio.ambience.machineJingleIntervalMs);
        } else if (frame.elapsedMs >= due) {
          this.playPerkJingle(machine.id, machine);
          this.nextMachineJingleAtMs.set(machine.id, frame.elapsedMs + CONFIG.audio.ambience.machineJingleIntervalMs);
        }
      }
    }
  }

  playShot(weaponId: WeaponId, point?: AudioPoint, remote = false): void {
    const context = this.ensureContext();
    if (context === null || !this.canStartCue()) return;
    const profile = CONFIG.audio.weaponProfiles[weaponId];
    const definition = CONFIG.weapons[weaponId];
    const layer = CONFIG.audio.shotLayers;
    const now = context.currentTime;
    const duration = seconds(profile.noiseMs);
    const destination = this.createRoutedInput('effects', point, remote ? CONFIG.audio.remoteShotRoomSend : CONFIG.audio.localShotRoomSend);
    const remoteGain = remote ? layer.remoteGain : 1;

    const crack = context.createOscillator();
    const crackGain = context.createGain();
    crack.type = definition.pellets > 1 ? 'sawtooth' : definition.rpm < CONFIG.weapons.melder.rpm ? 'square' : 'triangle';
    crack.frequency.setValueAtTime(profile.crackHz * layer.transientPitchMultiplier, now);
    crack.frequency.exponentialRampToValueAtTime(profile.crackHz, now + duration);
    crackGain.gain.setValueAtTime(profile.gain * layer.transientGainMultiplier * remoteGain, now);
    crackGain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, now + duration);
    crack.connect(crackGain).connect(destination);
    crack.start(now);
    crack.stop(now + duration);
    this.trackSource(crack);

    const body = context.createOscillator();
    const bodyGain = context.createGain();
    body.type = 'sine';
    body.frequency.setValueAtTime(profile.crackHz * layer.bodyPitchMultiplier, now);
    body.frequency.exponentialRampToValueAtTime(profile.crackHz * layer.bodyPitchMultiplier * CONFIG.audio.synthesis.bodyEndPitchMultiplier, now + duration);
    bodyGain.gain.setValueAtTime(profile.gain * layer.bodyGainMultiplier * remoteGain, now);
    bodyGain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, now + duration);
    body.connect(bodyGain).connect(destination);
    body.start(now);
    body.stop(now + duration);
    this.trackSource(body);

    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(profile.filterHz, now);
    noiseGain.gain.setValueAtTime(profile.gain * layer.noiseGainMultiplier * remoteGain, now);
    noiseGain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, now + duration);
    noise.buffer = this.getNoiseBuffer(context);
    noise.connect(filter).connect(noiseGain).connect(destination);
    this.startNoiseSlice(noise, now, duration);
    this.trackSource(noise);

    this.scheduleClick(now + duration * layer.mechanicalDelayMultiplier, CONFIG.audio.weaponMechanics[weaponId].frequenciesHz[0], destination, layer.mechanicalGain * remoteGain);
    this.noteCue(`${remote ? 'remote-' : ''}weapon:${weaponId}`);
  }

  playHitmarker(): void {
    this.playClick('hitmarker', CONFIG.audio.hitmarkerFrequencyHz, CONFIG.audio.hitmarkerDurationMs, 0.1);
  }

  playEmpty(): void {
    this.playClick('empty', CONFIG.audio.emptyClickFrequencyHz, CONFIG.audio.reloadClickMs, 0.13);
  }

  playReload(weaponId: WeaponId, point?: AudioPoint): void {
    const context = this.ensureContext();
    if (context === null || !this.canStartCue()) return;
    const destination = this.createRoutedInput('effects', point);
    const definition = CONFIG.weapons[weaponId];
    const mechanics = CONFIG.audio.weaponMechanics[weaponId];
    for (let index = 0; index < mechanics.frequenciesHz.length; index += 1) {
      const frequency = mechanics.frequenciesHz[index];
      const timing = mechanics.timing[index];
      if (frequency === undefined || timing === undefined) continue;
      this.scheduleClick(context.currentTime + seconds(definition.reloadMs * timing), frequency, destination, mechanics.gain);
    }
    this.noteCue(`reload:${weaponId}`);
  }

  playMelee(point?: AudioPoint): void {
    const context = this.ensureContext();
    if (context === null || !this.canStartCue()) return;
    const destination = this.createRoutedInput('effects', point);
    const duration = seconds(CONFIG.audio.mechanisms.meleeWhooshMs);
    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    filter.type = 'bandpass';
    filter.frequency.setValueAtTime(CONFIG.audio.materialCues.vault.lowpassHz, context.currentTime);
    filter.frequency.exponentialRampToValueAtTime(CONFIG.audio.materialCues.bodyImpact.lowpassHz, context.currentTime + duration);
    gain.gain.setValueAtTime(CONFIG.audio.mechanisms.meleeWhooshGain, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, context.currentTime + duration);
    noise.buffer = this.getNoiseBuffer(context);
    noise.connect(filter).connect(gain).connect(destination);
    this.startNoiseSlice(noise, context.currentTime, duration);
    this.trackSource(noise);
    this.noteCue('melee');
  }

  playWorldCue(cue: AudioWorldCue, point?: AudioPoint, enemyKind: AudioEnemyEmitter['kind'] = 'zombie', enemyId = 0): void {
    if (cue === 'enemySpawn') {
      if (point !== undefined) this.playEnemyVoice({ ...point, id: enemyId, kind: enemyKind, state: 'spawn', speedTier: 'walk' });
      this.noteCue(cue);
      return;
    }
    if (cue === 'boardTorn') this.playMaterial(cue, point, CONFIG.audio.materialCues.woodTear);
    else if (cue === 'boardRepaired') this.playMaterial(cue, point, CONFIG.audio.materialCues.woodRepair);
    else if (cue === 'vault') this.playMaterial(cue, point, CONFIG.audio.materialCues.vault);
    else if (cue === 'damage') this.playMaterial(cue, point, enemyKind === 'wolf' ? CONFIG.audio.materialCues.wolfImpact : CONFIG.audio.materialCues.bodyImpact, CONFIG.audio.cueGains.damageImpact);
    else if (cue === 'enemyDeath') this.playDeath(point, enemyKind, enemyId);
    else if (cue === 'door') this.playDoor(point);
    else if (cue === 'purchase') this.playClick(cue, CONFIG.audio.mechanisms.purchaseHz, CONFIG.audio.reloadClickMs, CONFIG.audio.cueGains.purchase);
    else if (cue === 'crateStart' || cue === 'crateSettle' || cue === 'crateCollect') this.playCrate(cue, point);
    else if (cue === 'cratePuppe') this.playSequence('cratePuppe', CONFIG.audio.musicalCues.puppe, point, true);
    else if (cue === 'grenadeThrow') this.playClick(cue, CONFIG.audio.mechanisms.grenadeThrowHz, CONFIG.audio.reloadClickMs, CONFIG.audio.cueGains.grenadeThrow);
    else if (cue === 'explosion') this.playMaterial(cue, point, CONFIG.audio.materialCues.explosion, CONFIG.audio.cueGains.explosion);
    else if (cue === 'power') this.playPowerSurge(point);
    else if (cue === 'perkDrink') this.playMaterial(cue, point, CONFIG.audio.materialCues.crate, CONFIG.audio.cueGains.perkDrink);
    else if (cue === 'forgeStart') this.playForge(point, false);
    else if (cue === 'forgeComplete') this.playForge(point, true);
    else if (cue === 'forgeCancel') this.playClick(cue, CONFIG.audio.emptyClickFrequencyHz, CONFIG.audio.reloadClickMs, CONFIG.audio.cueGains.forgeCancel);
    else if (cue === 'powerupSpawn') this.playClick(cue, CONFIG.audio.mechanisms.crateSpinToneHz, CONFIG.audio.reloadClickMs, CONFIG.audio.cueGains.powerupSpawn);
    else if (cue === 'downed') this.playLowPulse(cue, CONFIG.audio.heartbeat.frequencyHz * CONFIG.audio.cueGains.lowHealthDownPitch, CONFIG.audio.heartbeat.gain);
    else if (cue === 'revived' || cue === 'returned') this.playLowPulse(cue, CONFIG.audio.mechanisms.reviveToneHz, CONFIG.audio.cueGains.revive);
    else if (cue === 'bledOut') this.playLowPulse(cue, CONFIG.audio.heartbeat.frequencyHz * CONFIG.audio.cueGains.bledOutPitch, CONFIG.audio.cueGains.bledOut);
    else if (cue === 'gameOver') this.playSequence(cue, CONFIG.audio.musicalCues.gameOver, undefined, false);
    else if (cue === 'roundEnd') this.playLowPulse(cue, CONFIG.audio.musicalCues.roundZombie.notes[3] ?? 34, CONFIG.audio.cueGains.roundEnd);
  }

  playPerkJingle(perkId: PerkId, point?: AudioPoint): void {
    this.playSequence(`jingle:${perkId}`, CONFIG.audio.perkJingles[perkId], point, false);
  }

  playRoundSting(round: number, wolves: boolean): void {
    this.playSequence(`round:${round}:${wolves ? 'wolves' : 'zombies'}`, wolves ? CONFIG.audio.musicalCues.roundWolf : CONFIG.audio.musicalCues.roundZombie, undefined, false);
  }

  playPowerupCall(powerupId: PowerupId): void {
    const context = this.ensureContext();
    const bus = this.buses?.voice;
    if (context === null || bus === undefined || !this.canStartCue()) return;
    const pattern = CONFIG.audio.announcerPatterns[powerupId];
    const phonemes = CONFIG.audio.announcerPhonemes[powerupId];
    let cursorMs = 0;
    for (let index = 0; index < phonemes.length; index += 1) {
      const phoneme = phonemes[index];
      const note = pattern[index % pattern.length];
      if (phoneme === undefined || note === undefined) continue;
      const at = context.currentTime + seconds(cursorMs);
      const noteDuration = seconds(phoneme.durationMs);
      const oscillator = context.createOscillator();
      const voiceEnvelope = context.createGain();
      oscillator.type = 'sawtooth';
      oscillator.frequency.setValueAtTime(midiToHz(note), at);
      oscillator.detune.setValueAtTime(CONFIG.audio.announcer.detuneCents, at);
      const voicedGain = CONFIG.audio.announcer.gain * (1 - phoneme.noise * 0.55);
      voiceEnvelope.gain.setValueAtTime(CONFIG.audio.envelopeFloor, at);
      voiceEnvelope.gain.exponentialRampToValueAtTime(voicedGain, at + noteDuration * CONFIG.audio.synthesis.announcerAttackRatio);
      voiceEnvelope.gain.setValueAtTime(voicedGain, at + noteDuration * (1 - CONFIG.audio.synthesis.announcerReleaseRatio));
      voiceEnvelope.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + noteDuration);
      voiceEnvelope.connect(bus);
      for (const formantHz of phoneme.formantsHz) {
        const filter = context.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(formantHz, at);
        filter.Q.setValueAtTime(CONFIG.audio.synthesis.announcerFormantQ, at);
        oscillator.connect(filter).connect(voiceEnvelope);
      }
      oscillator.start(at);
      oscillator.stop(at + noteDuration);
      this.trackSource(oscillator);

      if (phoneme.noise > 0) {
        const noise = context.createBufferSource();
        const noiseEnvelope = context.createGain();
        noise.buffer = this.getNoiseBuffer(context);
        noiseEnvelope.gain.setValueAtTime(CONFIG.audio.envelopeFloor, at);
        noiseEnvelope.gain.exponentialRampToValueAtTime(CONFIG.audio.synthesis.announcerNoiseGain * phoneme.noise, at + noteDuration * CONFIG.audio.synthesis.announcerAttackRatio);
        noiseEnvelope.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + noteDuration);
        noiseEnvelope.connect(bus);
        for (const formantHz of phoneme.formantsHz) {
          const filter = context.createBiquadFilter();
          filter.type = 'bandpass';
          filter.frequency.setValueAtTime(formantHz, at);
          filter.Q.setValueAtTime(CONFIG.audio.synthesis.announcerFormantQ, at);
          noise.connect(filter).connect(noiseEnvelope);
        }
        this.startNoiseSlice(noise, at, noteDuration);
        this.trackSource(noise);
      }
      cursorMs += phoneme.durationMs + CONFIG.audio.announcer.gapMs;
    }
    this.noteCue(`announcer:${powerupId}`);
  }

  runLocalizationGate(): boolean {
    this.resume();
    const rightX = Math.cos(this.listener.yaw);
    const rightZ = -Math.sin(this.listener.yaw);
    const forwardX = -Math.sin(this.listener.yaw);
    const forwardZ = -Math.cos(this.listener.yaw);
    const offset = CONFIG.audio.localizationGate.lateralOffsetM;
    const forward = CONFIG.audio.localizationGate.forwardOffsetM;
    const left: AudioPoint = {
      x: this.listener.x - rightX * offset + forwardX * forward,
      y: this.listener.y,
      z: this.listener.z - rightZ * offset + forwardZ * forward,
      room: this.listener.room,
    };
    const right: AudioPoint = {
      x: this.listener.x + rightX * offset + forwardX * forward,
      y: this.listener.y,
      z: this.listener.z + rightZ * offset + forwardZ * forward,
      room: this.listener.room,
    };
    const leftMix = computeSpatialMix(left, this.listener);
    const rightMix = computeSpatialMix(right, this.listener);
    const passed = leftMix.pan < -0.5 && rightMix.pan > 0.5;
    this.playMaterial('localization-left', left, CONFIG.audio.materialCues.woodTear, CONFIG.audio.localizationGate.cueGain, 0);
    this.playMaterial('localization-right', right, CONFIG.audio.materialCues.woodTear, CONFIG.audio.localizationGate.cueGain, CONFIG.audio.localizationGate.cueDelayMs);
    this.localizationGate = `${passed ? 'PASS' : 'FAIL'} L ${leftMix.pan.toFixed(2)} / R ${rightMix.pan.toFixed(2)} / ${CONFIG.audio.localizationGate.cueDelayMs}ms`;
    this.noteCue('localization:left→right');
    void this.renderLocalizationGate();
    return passed;
  }

  private async renderLocalizationGate(): Promise<void> {
    if (typeof OfflineAudioContext === 'undefined') {
      this.localizationGate = `${this.localizationGate} · render unavailable`;
      return;
    }
    try {
      const gate = CONFIG.audio.localizationGate;
      const cueDurationMs = CONFIG.audio.materialCues.woodTear.durationMs;
      const totalDurationMs = gate.renderLeadMs + gate.cueDelayMs + cueDurationMs + gate.renderTailMs;
      const frameCount = Math.ceil(CONFIG.audio.sampleRateHz * seconds(totalDurationMs));
      const context = new OfflineAudioContext(2, frameCount, CONFIG.audio.sampleRateHz);
      const compressor = context.createDynamicsCompressor();
      const output = context.createGain();
      compressor.threshold.value = CONFIG.audio.compressor.thresholdDb;
      compressor.knee.value = CONFIG.audio.compressor.kneeDb;
      compressor.ratio.value = CONFIG.audio.compressor.ratio;
      compressor.attack.value = CONFIG.audio.compressor.attackSeconds;
      compressor.release.value = CONFIG.audio.compressor.releaseSeconds;
      output.gain.value = this.masterVolume * CONFIG.audio.effectsGain;
      compressor.connect(output).connect(context.destination);

      let renderSeed = CONFIG.simulation.seedFallback;
      const noiseBuffer = context.createBuffer(1, Math.ceil(CONFIG.audio.sampleRateHz * seconds(cueDurationMs)), CONFIG.audio.sampleRateHz);
      const noiseData = noiseBuffer.getChannelData(0);
      for (let index = 0; index < noiseData.length; index += 1) {
        renderSeed = (Math.imul(renderSeed, 1664525) + 1013904223) >>> 0;
        noiseData[index] = renderSeed / 0x1_0000_0000 * 2 - 1;
      }
      const schedule = (x: number, startMs: number): void => {
        const source = context.createBufferSource();
        const filter = context.createBiquadFilter();
        const gain = context.createGain();
        const panner = context.createPanner();
        const at = seconds(startMs);
        const duration = seconds(cueDurationMs);
        source.buffer = noiseBuffer;
        filter.type = 'lowpass';
        filter.frequency.value = CONFIG.audio.materialCues.woodTear.lowpassHz;
        gain.gain.setValueAtTime(gate.cueGain, at);
        gain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + duration);
        panner.panningModel = 'HRTF';
        panner.distanceModel = 'inverse';
        panner.refDistance = CONFIG.audio.referenceDistanceM;
        panner.maxDistance = CONFIG.audio.maxDistanceM;
        panner.rolloffFactor = CONFIG.audio.rolloffFactor;
        panner.positionX.value = x;
        panner.positionY.value = 0;
        panner.positionZ.value = -gate.forwardOffsetM;
        source.connect(filter).connect(gain).connect(panner).connect(compressor);
        source.start(at);
      };
      schedule(-gate.lateralOffsetM, gate.renderLeadMs);
      schedule(gate.lateralOffsetM, gate.renderLeadMs + gate.cueDelayMs);
      const rendered = await context.startRendering();
      const leftChannel = rendered.getChannelData(0);
      const rightChannel = rendered.getChannelData(1);
      const leftStart = millisecondsToFrames(gate.renderLeadMs, rendered.sampleRate);
      const leftEnd = millisecondsToFrames(gate.renderLeadMs + Math.min(cueDurationMs, gate.cueDelayMs), rendered.sampleRate);
      const rightStart = millisecondsToFrames(gate.renderLeadMs + gate.cueDelayMs, rendered.sampleRate);
      const rightEnd = millisecondsToFrames(gate.renderLeadMs + gate.cueDelayMs + cueDurationMs, rendered.sampleRate);
      const leftDominance = rms(leftChannel, leftStart, leftEnd) / Math.max(gate.rmsFloor, rms(rightChannel, leftStart, leftEnd));
      const rightDominance = rms(rightChannel, rightStart, rightEnd) / Math.max(gate.rmsFloor, rms(leftChannel, rightStart, rightEnd));
      const peak = Math.max(peakMagnitude(leftChannel), peakMagnitude(rightChannel));
      const passed = leftDominance >= gate.stereoDominanceRatio && rightDominance >= gate.stereoDominanceRatio
        && peak > gate.rmsFloor && peak <= gate.peakCeiling;
      this.localizationGate = `RENDER ${passed ? 'PASS' : 'FAIL'} · L ${leftDominance.toFixed(2)}× · R ${rightDominance.toFixed(2)}× · peak ${peak.toFixed(3)}`;
    } catch {
      this.localizationGate = `${this.localizationGate} · render unavailable`;
    }
  }

  dispose(): void {
    this.disposed = true;
    if (typeof document !== 'undefined') {
      document.removeEventListener('pointerdown', this.unlock, { capture: true });
      document.removeEventListener('keydown', this.unlock, { capture: true });
    }
    this.stopAmbienceBed();
    const context = this.context;
    this.context = null;
    this.masterOutput = null;
    this.buses = null;
    this.convolver = null;
    this.reverbReturn = null;
    if (context !== null) void context.close();
  }

  private readonly unlock = (): void => {
    this.resume();
  };

  private ensureContext(): AudioContext | null {
    if (this.disposed || typeof AudioContext === 'undefined') return null;
    if (this.context !== null) return this.context;
    const context = new AudioContext({ sampleRate: CONFIG.audio.sampleRateHz, latencyHint: CONFIG.audio.latencyHint });
    const masterInput = context.createGain();
    const compressor = context.createDynamicsCompressor();
    const masterOutput = context.createGain();
    compressor.threshold.value = CONFIG.audio.compressor.thresholdDb;
    compressor.knee.value = CONFIG.audio.compressor.kneeDb;
    compressor.ratio.value = CONFIG.audio.compressor.ratio;
    compressor.attack.value = CONFIG.audio.compressor.attackSeconds;
    compressor.release.value = CONFIG.audio.compressor.releaseSeconds;
    masterOutput.gain.value = this.masterVolume;
    masterInput.connect(compressor).connect(masterOutput).connect(context.destination);

    this.context = context;
    this.masterOutput = masterOutput;
    this.buses = {
      effects: this.createBus(context, masterInput, CONFIG.audio.effectsGain),
      ambience: this.createBus(context, masterInput, CONFIG.audio.ambienceGain),
      music: this.createBus(context, masterInput, CONFIG.audio.musicGain),
      voice: this.createBus(context, masterInput, CONFIG.audio.voiceGain),
      ui: this.createBus(context, masterInput, CONFIG.audio.uiGain),
    };
    this.convolver = context.createConvolver();
    this.convolver.buffer = this.createImpulse(context);
    this.reverbReturn = context.createGain();
    this.reverbReturn.gain.value = CONFIG.audio.reverbGain;
    this.convolver.connect(this.reverbReturn).connect(masterInput);
    this.startAmbienceBed();
    return context;
  }

  private createBus(context: AudioContext, destination: AudioNode, gainValue: number): GainNode {
    const bus = context.createGain();
    bus.gain.value = gainValue;
    bus.connect(destination);
    return bus;
  }

  private createImpulse(context: AudioContext): AudioBuffer {
    const length = Math.max(1, Math.floor(context.sampleRate * CONFIG.audio.reverbSeconds));
    const buffer = context.createBuffer(2, length, context.sampleRate);
    for (let channelIndex = 0; channelIndex < buffer.numberOfChannels; channelIndex += 1) {
      const channel = buffer.getChannelData(channelIndex);
      for (let index = 0; index < length; index += 1) {
        const life = 1 - index / length;
        channel[index] = (this.nextNoise() * 2 - 1) * Math.pow(life, CONFIG.audio.reverbDecay);
      }
    }
    return buffer;
  }

  private getNoiseBuffer(context: AudioContext): AudioBuffer {
    if (this.noiseBuffer !== null && this.noiseBuffer.sampleRate === context.sampleRate) return this.noiseBuffer;
    const length = Math.max(1, Math.floor(context.sampleRate * CONFIG.audio.noiseBufferSeconds));
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) channel[index] = this.nextNoise() * 2 - 1;
    this.noiseBuffer = buffer;
    return buffer;
  }

  private startAmbienceBed(): void {
    const context = this.context;
    const bus = this.buses?.ambience;
    if (context === null || bus === undefined || this.bedMode === this.mode) return;
    this.stopAmbienceBed();
    this.bedMode = this.mode;
    this.lastPowerOn = null;
    this.lastAcousticProfile = '';
    const noise = context.createBufferSource();
    const highpass = context.createBiquadFilter();
    const lowpass = context.createBiquadFilter();
    const airGain = context.createGain();
    noise.buffer = this.getNoiseBuffer(context);
    noise.loop = true;
    highpass.type = 'highpass';
    highpass.frequency.value = CONFIG.audio.ambience.airHighpassHz;
    lowpass.type = 'lowpass';
    lowpass.frequency.value = this.mode === 'menu' ? CONFIG.audio.ambience.airLowpassHz : CONFIG.audio.ambience.roomFilterHz.start;
    airGain.gain.value = this.mode === 'menu' ? CONFIG.audio.ambience.menuAirGain : CONFIG.audio.ambience.bunkerAirGain;
    noise.connect(highpass).connect(lowpass).connect(airGain).connect(bus);
    noise.start();
    this.bedSources.push(noise);
    this.ambienceAirGain = airGain;
    this.ambienceFilter = lowpass;

    for (const frequency of CONFIG.audio.ambience.droneFrequenciesHz) {
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      gain.gain.value = CONFIG.audio.ambience.droneGain;
      oscillator.connect(gain).connect(bus);
      oscillator.start();
      this.bedSources.push(oscillator);
    }

    const humGain = context.createGain();
    humGain.gain.value = CONFIG.audio.ambience.generatorHumGainOff;
    for (let index = 0; index < CONFIG.audio.ambience.generatorHumFrequenciesHz.length; index += 1) {
      const frequency = CONFIG.audio.ambience.generatorHumFrequenciesHz[index];
      if (frequency === undefined) continue;
      const oscillator = context.createOscillator();
      const harmonicGain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = frequency;
      harmonicGain.gain.value = 1 / (index + 1);
      oscillator.connect(harmonicGain).connect(humGain);
      oscillator.start();
      this.bedSources.push(oscillator);
    }
    humGain.connect(bus);
    this.generatorHumGain = humGain;
  }

  private stopAmbienceBed(): void {
    for (const source of this.bedSources.splice(0, this.bedSources.length)) {
      try {
        source.stop();
      } catch {
        // A source that ended naturally needs no additional teardown.
      }
    }
    this.bedMode = null;
    this.ambienceAirGain = null;
    this.ambienceFilter = null;
    this.generatorHumGain = null;
  }

  private updateListener(context: AudioContext, listener: AudioFrame['listener']): void {
    const audioListener = context.listener;
    this.rampParameter(audioListener.positionX, listener.x, CONFIG.audio.listenerRampMs);
    this.rampParameter(audioListener.positionY, listener.y, CONFIG.audio.listenerRampMs);
    this.rampParameter(audioListener.positionZ, listener.z, CONFIG.audio.listenerRampMs);
    const cosPitch = Math.cos(listener.pitch);
    this.rampParameter(audioListener.forwardX, -Math.sin(listener.yaw) * cosPitch, CONFIG.audio.listenerRampMs);
    this.rampParameter(audioListener.forwardY, Math.sin(listener.pitch), CONFIG.audio.listenerRampMs);
    this.rampParameter(audioListener.forwardZ, -Math.cos(listener.yaw) * cosPitch, CONFIG.audio.listenerRampMs);
    this.rampParameter(audioListener.upX, 0, CONFIG.audio.listenerRampMs);
    this.rampParameter(audioListener.upY, 1, CONFIG.audio.listenerRampMs);
    this.rampParameter(audioListener.upZ, 0, CONFIG.audio.listenerRampMs);
  }

  private rampParameter(parameter: AudioParam | undefined, target: number, durationMs: number): void {
    const context = this.context;
    if (context === null || parameter === undefined) return;
    const now = context.currentTime;
    parameter.cancelScheduledValues(now);
    parameter.setValueAtTime(parameter.value, now);
    parameter.linearRampToValueAtTime(target, now + seconds(durationMs));
  }

  private createRoutedInput(busName: keyof AudioBuses, point?: AudioPoint, explicitSend?: number): GainNode {
    const context = this.context;
    const buses = this.buses;
    if (context === null || buses === null) throw new Error('Audio graph is not initialized.');
    const input = context.createGain();
    const bus = buses[busName];
    const roomSend = explicitSend ?? (point === undefined ? CONFIG.audio.roomReverbSend[this.listener.room] : CONFIG.audio.roomReverbSend[point.room]);
    if (point === undefined) {
      input.connect(bus);
      this.connectReverb(input, roomSend);
      return input;
    }
    const spatial = computeSpatialMix(point, this.listener);
    const filter = context.createBiquadFilter();
    const occlusionGain = context.createGain();
    const panner = context.createPanner();
    filter.type = 'lowpass';
    filter.frequency.value = spatial.lowpassHz;
    occlusionGain.gain.value = spatial.occluded ? CONFIG.audio.occlusionGain : 1;
    panner.panningModel = 'HRTF';
    panner.distanceModel = 'inverse';
    panner.refDistance = CONFIG.audio.referenceDistanceM;
    panner.maxDistance = CONFIG.audio.maxDistanceM;
    panner.rolloffFactor = CONFIG.audio.rolloffFactor;
    panner.coneInnerAngle = CONFIG.audio.coneInnerAngleDeg;
    panner.coneOuterAngle = CONFIG.audio.coneOuterAngleDeg;
    panner.coneOuterGain = CONFIG.audio.coneOuterGain;
    panner.positionX.value = point.x;
    panner.positionY.value = point.y;
    panner.positionZ.value = point.z;
    input.connect(filter).connect(occlusionGain).connect(panner).connect(bus);
    this.connectReverb(panner, roomSend);
    if (spatial.occluded) this.occludedCues += 1;
    return input;
  }

  private connectReverb(source: AudioNode, sendValue: number): void {
    const context = this.context;
    const convolver = this.convolver;
    if (context === null || convolver === null || sendValue <= 0) return;
    const send = context.createGain();
    send.gain.value = sendValue;
    source.connect(send).connect(convolver);
    this.reverberantCues += 1;
  }

  private playMaterial(cue: string, point: AudioPoint | undefined, profile: MaterialCueProfile, gainOverride?: number, delayMs = 0): void {
    const context = this.ensureContext();
    if (context === null || !this.canStartCue()) return;
    const at = context.currentTime + seconds(delayMs);
    const duration = seconds(profile.durationMs);
    const destination = this.createRoutedInput('effects', point);
    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const gain = context.createGain();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(profile.lowpassHz, at);
    gain.gain.setValueAtTime(gainOverride ?? profile.gain, at);
    gain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + duration);
    noise.buffer = this.getNoiseBuffer(context);
    noise.connect(filter).connect(gain).connect(destination);
    this.startNoiseSlice(noise, at, duration);
    this.trackSource(noise);
    for (let index = 0; index < profile.crackCount; index += 1) {
      const crackAt = at + duration * ((index + 1) / (profile.crackCount + 1));
      const frequency = profile.lowpassHz * (CONFIG.audio.synthesis.materialCrackBasePitchMultiplier + this.nextNoise() * CONFIG.audio.synthesis.materialCrackPitchVariance);
      this.scheduleClick(crackAt, frequency, destination, (gainOverride ?? profile.gain) * CONFIG.audio.synthesis.materialCrackGainMultiplier, CONFIG.audio.reloadClickMs);
    }
    this.noteCue(cue);
  }

  private playDeath(point: AudioPoint | undefined, kind: AudioEnemyEmitter['kind'], enemyId: number): void {
    const profile = kind === 'wolf' ? CONFIG.audio.materialCues.wolfImpact : CONFIG.audio.materialCues.bodyImpact;
    this.playMaterial(`death:${kind}`, point, profile);
    if (point !== undefined) this.playEnemyVoice({ ...point, id: enemyId, kind, state: 'dead', speedTier: 'walk' }, CONFIG.audio.synthesis.deathVoiceGainMultiplier);
  }

  private playDoor(point?: AudioPoint): void {
    this.playMaterial('door', point, CONFIG.audio.materialCues.metalDoor);
    const context = this.context;
    if (context !== null) {
      const destination = this.createRoutedInput('effects', point);
      this.scheduleClick(context.currentTime, CONFIG.audio.mechanisms.doorThudHz, destination, CONFIG.audio.synthesis.doorThudGain, CONFIG.audio.materialCues.metalDoor.durationMs);
    }
  }

  private playCrate(cue: string, point?: AudioPoint): void {
    this.playMaterial(cue, point, CONFIG.audio.materialCues.crate);
    const context = this.context;
    if (context === null) return;
    const destination = this.createRoutedInput('music', point);
    const cycles = Math.max(1, Math.floor(CONFIG.mysteryCrate.spinMs / CONFIG.audio.mechanisms.crateCycleIntervalMs));
    const audibleCycles = cue === 'crateStart' ? Math.min(cycles, CONFIG.audio.synthesis.crateStartCycles) : CONFIG.audio.synthesis.crateEndCycles;
    for (let index = 0; index < audibleCycles; index += 1) {
      this.scheduleClick(
        context.currentTime + seconds(index * CONFIG.audio.mechanisms.crateCycleIntervalMs),
        CONFIG.audio.mechanisms.crateSpinToneHz * (1 + index / Math.max(1, audibleCycles) * CONFIG.audio.synthesis.cratePitchRise),
        destination,
        CONFIG.audio.synthesis.crateToneGain,
        CONFIG.audio.reloadClickMs,
      );
    }
  }

  private playPowerSurge(point?: AudioPoint): void {
    this.playMaterial('power', point, CONFIG.audio.materialCues.metalDoor, 0.52);
    const context = this.context;
    if (context === null) return;
    const destination = this.createRoutedInput('effects', point, 0.7);
    const duration = seconds(CONFIG.audio.mechanisms.powerSurgeMs);
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(CONFIG.audio.mechanisms.powerThunkHz, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(CONFIG.audio.ambience.generatorHumFrequenciesHz[2] ?? 150, context.currentTime + duration);
    gain.gain.setValueAtTime(CONFIG.audio.synthesis.powerSurgeGain, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, context.currentTime + duration);
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    oscillator.stop(context.currentTime + duration);
    this.trackSource(oscillator);
  }

  private playForge(point: AudioPoint | undefined, complete: boolean): void {
    const context = this.ensureContext();
    if (context === null || !this.canStartCue()) return;
    const destination = this.createRoutedInput('effects', point, CONFIG.audio.cueGains.forgeRoomSend);
    const durationMs = complete ? CONFIG.forge.animationMs * 0.42 : CONFIG.forge.animationMs;
    const sparkCount = Math.floor(durationMs / CONFIG.audio.mechanisms.forgeSparkIntervalMs);
    for (let index = 0; index < sparkCount; index += 1) {
      this.scheduleClick(
        context.currentTime + seconds(index * CONFIG.audio.mechanisms.forgeSparkIntervalMs),
        CONFIG.audio.mechanisms.forgeToneHz * (CONFIG.audio.synthesis.forgeFrequencyMinMultiplier + this.nextNoise() * CONFIG.audio.synthesis.forgeFrequencyRangeMultiplier),
        destination,
        CONFIG.audio.synthesis.forgeSparkGain + this.nextNoise() * CONFIG.audio.synthesis.forgeSparkGainVariance,
        CONFIG.audio.reloadClickMs,
      );
    }
    if (complete) this.playSequence('forgeComplete', CONFIG.audio.musicalCues.forge, point, false);
    this.noteCue(complete ? 'forgeComplete' : 'forgeStart');
  }

  private playMachineHum(machine: AudioPerkEmitter, powered: boolean): void {
    const context = this.context;
    if (context === null || !this.canStartCue()) return;
    const destination = this.createRoutedInput('ambience', machine, CONFIG.audio.roomReverbSend[machine.room] * 0.28);
    const duration = seconds(CONFIG.audio.ambience.machineHumDurationMs);
    const at = context.currentTime;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = powered ? 'triangle' : 'sine';
    oscillator.frequency.setValueAtTime(
      CONFIG.audio.ambience.machineHumFrequenciesHz[machine.id] * (powered ? 1 : CONFIG.audio.ambience.machineHumOffPitchMultiplier),
      at,
    );
    const gainValue = powered ? CONFIG.audio.ambience.machineHumGainOn : CONFIG.audio.ambience.machineHumGainOff;
    gain.gain.setValueAtTime(CONFIG.audio.envelopeFloor, at);
    gain.gain.exponentialRampToValueAtTime(gainValue, at + duration * CONFIG.audio.ambience.machineHumFadeRatio);
    gain.gain.setValueAtTime(gainValue, at + duration * (1 - CONFIG.audio.ambience.machineHumFadeRatio));
    gain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + duration);
    oscillator.connect(gain).connect(destination);
    oscillator.start(at);
    oscillator.stop(at + duration);
    this.trackSource(oscillator);
  }

  private playHeartbeat(): void {
    const context = this.context;
    const bus = this.buses?.ui;
    if (context === null || bus === undefined || !this.canStartCue()) return;
    this.schedulePulse(context.currentTime, CONFIG.audio.heartbeat.frequencyHz, bus, CONFIG.audio.heartbeat.gain, CONFIG.audio.heartbeat.durationMs);
    this.schedulePulse(
      context.currentTime + seconds(CONFIG.audio.heartbeat.secondBeatDelayMs),
      CONFIG.audio.heartbeat.frequencyHz * 0.9,
      bus,
      CONFIG.audio.heartbeat.gain * CONFIG.audio.synthesis.heartbeatSecondGainMultiplier,
      CONFIG.audio.heartbeat.durationMs,
    );
    this.noteCue('heartbeat');
  }

  private playLowPulse(cue: string, frequency: number, gain: number): void {
    const context = this.ensureContext();
    const bus = this.buses?.music;
    if (context === null || bus === undefined || !this.canStartCue()) return;
    this.schedulePulse(context.currentTime, frequency, bus, gain, CONFIG.audio.heartbeat.durationMs * 2.4);
    this.noteCue(cue);
  }

  private schedulePulse(at: number, frequency: number, destination: AudioNode, gainValue: number, durationMs: number): void {
    const context = this.context;
    if (context === null) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(CONFIG.audio.envelopeFloor, at);
    gain.gain.exponentialRampToValueAtTime(gainValue, at + seconds(durationMs * CONFIG.audio.synthesis.pulseAttackRatio));
    gain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + seconds(durationMs));
    oscillator.connect(gain).connect(destination);
    oscillator.start(at);
    oscillator.stop(at + seconds(durationMs));
    this.trackSource(oscillator);
  }

  private playEnemyVoice(enemy: AudioEnemyEmitter, gainScale = 1): void {
    const context = this.ensureContext();
    if (context === null || !this.canStartCue()) return;
    const point: AudioPoint = enemy;
    const destination = this.createRoutedInput('voice', point, CONFIG.audio.roomReverbSend[enemy.room] * CONFIG.audio.synthesis.voiceReverbMultiplier);
    if (enemy.kind === 'wolf') {
      const profile = CONFIG.audio.wolfVoice;
      this.synthesizeVoice(destination, profile.carrierHz, profile.formantsHz, profile.durationMs, profile.pitchRange, profile.gain * gainScale, profile.modulationHz);
      this.noteCue(`voice:wolf:${enemy.id}`);
      return;
    }
    const familyIndex = Math.abs(enemy.id) % CONFIG.audio.zombieVoiceFamilies.length;
    const profile = CONFIG.audio.zombieVoiceFamilies[familyIndex] ?? CONFIG.audio.zombieVoiceFamilies[0];
    this.synthesizeVoice(destination, profile.carrierHz, profile.formantsHz, profile.durationMs, profile.pitchRange, profile.gain * gainScale, CONFIG.audio.zombieVoiceModulationHz);
    this.noteCue(`voice:zombie-family-${familyIndex + 1}:${enemy.id}`);
  }

  private synthesizeVoice(
    destination: AudioNode,
    carrierHz: number,
    formantsHz: readonly number[],
    durationRangeMs: readonly number[],
    pitchRange: readonly number[],
    gainValue: number,
    modulationHz: number,
  ): void {
    const context = this.context;
    if (context === null) return;
    const minDuration = durationRangeMs[0] ?? 600;
    const maxDuration = durationRangeMs[1] ?? minDuration;
    const duration = seconds(minDuration + this.nextNoise() * (maxDuration - minDuration));
    const minPitch = pitchRange[0] ?? 1;
    const maxPitch = pitchRange[1] ?? minPitch;
    const pitch = minPitch + this.nextNoise() * (maxPitch - minPitch);
    const at = context.currentTime;
    const carrier = context.createOscillator();
    const carrierGain = context.createGain();
    const modulator = context.createOscillator();
    const modulation = context.createGain();
    carrier.type = 'sawtooth';
    carrier.frequency.setValueAtTime(carrierHz * pitch, at);
    carrier.frequency.exponentialRampToValueAtTime(carrierHz * pitch * CONFIG.audio.synthesis.voicePitchDecay, at + duration);
    modulator.type = 'sine';
    modulator.frequency.value = modulationHz;
    modulation.gain.value = carrierHz * CONFIG.audio.synthesis.voiceModulationDepth;
    modulator.connect(modulation).connect(carrier.frequency);
    carrierGain.gain.setValueAtTime(CONFIG.audio.envelopeFloor, at);
    carrierGain.gain.exponentialRampToValueAtTime(gainValue, at + seconds(CONFIG.audio.zombieVoiceAttackMs));
    carrierGain.gain.setValueAtTime(gainValue, Math.max(at + seconds(CONFIG.audio.zombieVoiceAttackMs), at + duration - seconds(CONFIG.audio.zombieVoiceReleaseMs)));
    carrierGain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + duration);
    carrier.connect(carrierGain).connect(destination);
    carrier.start(at);
    modulator.start(at);
    carrier.stop(at + duration);
    modulator.stop(at + duration);
    this.trackSource(carrier);
    this.trackSource(modulator);

    const noise = context.createBufferSource();
    const noiseGain = context.createGain();
    noise.buffer = this.getNoiseBuffer(context);
    noiseGain.gain.setValueAtTime(CONFIG.audio.envelopeFloor, at);
    noiseGain.gain.exponentialRampToValueAtTime(CONFIG.audio.zombieVoiceNoiseGain * gainValue, at + seconds(CONFIG.audio.zombieVoiceAttackMs));
    noiseGain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + duration);
    noise.connect(noiseGain);
    for (const formantHz of formantsHz) {
      const filter = context.createBiquadFilter();
      const formantGain = context.createGain();
      filter.type = 'bandpass';
      filter.frequency.value = formantHz * pitch;
      filter.Q.value = CONFIG.audio.synthesis.voiceFormantQ;
      formantGain.gain.value = CONFIG.audio.synthesis.voiceFormantGain;
      noiseGain.connect(filter).connect(formantGain).connect(destination);
    }
    this.startNoiseSlice(noise, at, duration);
    this.trackSource(noise);
  }

  private playEnemyStep(enemy: AudioEnemyEmitter): void {
    const profile = enemy.kind === 'crawler' ? CONFIG.audio.materialCues.crawlerDrag : CONFIG.audio.materialCues.concreteStep;
    this.playMaterial(`step:${enemy.kind}`, enemy, profile, enemy.kind === 'wolf' ? profile.gain * CONFIG.audio.synthesis.wolfStepGainMultiplier : undefined);
  }

  private enemyVoiceInterval(enemy: AudioEnemyEmitter): number {
    const range = enemy.kind === 'wolf' ? CONFIG.audio.wolfVoice.intervalMs : CONFIG.audio.zombieVoiceIntervalMs;
    const minimum = range[0] ?? 3000;
    const maximum = range[1] ?? minimum;
    return minimum + this.nextNoise() * (maximum - minimum);
  }

  private enemyStepInterval(enemy: AudioEnemyEmitter): number {
    if (enemy.kind === 'wolf') return CONFIG.audio.footsteps.wolfIntervalMs;
    if (enemy.kind === 'crawler') return CONFIG.audio.footsteps.crawlerIntervalMs;
    if (enemy.speedTier === 'sprint') return CONFIG.audio.footsteps.zombieSprintIntervalMs;
    if (enemy.speedTier === 'jog') return CONFIG.audio.footsteps.zombieJogIntervalMs;
    return CONFIG.audio.footsteps.zombieWalkIntervalMs;
  }

  private playSequence(
    cue: string,
    sequence: { bpm: number; notes: readonly number[]; beats: readonly number[]; gain: number; waveform?: string },
    point: AudioPoint | undefined,
    reverse: boolean,
  ): void {
    const context = this.ensureContext();
    if (context === null || !this.canStartCue()) return;
    const destination = this.createRoutedInput('music', point);
    const beatSeconds = 60 / sequence.bpm;
    for (let index = 0; index < sequence.notes.length; index += 1) {
      const sourceIndex = reverse ? sequence.notes.length - 1 - index : index;
      const note = sequence.notes[sourceIndex];
      const beat = sequence.beats[index];
      if (note === undefined || beat === undefined) continue;
      const at = context.currentTime + beat * beatSeconds;
      const duration = beatSeconds * CONFIG.audio.synthesis.sequenceNoteLengthBeats;
      const oscillator = context.createOscillator();
      const filter = context.createBiquadFilter();
      const gain = context.createGain();
      oscillator.type = isOscillatorType(sequence.waveform) ? sequence.waveform : 'sawtooth';
      oscillator.frequency.setValueAtTime(midiToHz(note), at);
      filter.type = 'lowpass';
      filter.frequency.setValueAtTime(midiToHz(note) * CONFIG.audio.synthesis.sequenceFilterMultiplier, at);
      gain.gain.setValueAtTime(CONFIG.audio.envelopeFloor, at);
      gain.gain.exponentialRampToValueAtTime(sequence.gain, at + duration * CONFIG.audio.synthesis.sequenceAttackRatio);
      gain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + duration);
      oscillator.connect(filter).connect(gain).connect(destination);
      oscillator.start(at);
      oscillator.stop(at + duration);
      this.trackSource(oscillator);
    }
    this.noteCue(cue);
  }

  private playClick(cue: string, frequency: number, durationMs: number, gain: number): void {
    const context = this.ensureContext();
    const bus = this.buses?.ui;
    if (context === null || bus === undefined || !this.canStartCue()) return;
    this.scheduleClick(context.currentTime, frequency, bus, gain, durationMs);
    this.noteCue(cue);
  }

  private scheduleClick(at: number, frequency: number, destination: AudioNode, gainValue: number, durationMs: number = CONFIG.audio.reloadClickMs): void {
    const context = this.context;
    if (context === null) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(Math.max(1, frequency), at);
    gain.gain.setValueAtTime(Math.max(CONFIG.audio.envelopeFloor, gainValue), at);
    gain.gain.exponentialRampToValueAtTime(CONFIG.audio.envelopeFloor, at + seconds(durationMs));
    oscillator.connect(gain).connect(destination);
    oscillator.start(at);
    oscillator.stop(at + seconds(durationMs));
    this.trackSource(oscillator);
  }

  private startNoiseSlice(source: AudioBufferSourceNode, at: number, duration: number): void {
    const bufferDuration = source.buffer?.duration ?? CONFIG.audio.noiseBufferSeconds;
    const maxOffset = Math.max(0, bufferDuration - duration);
    source.start(at, this.nextNoise() * maxOffset, Math.min(duration, bufferDuration));
  }

  private canStartCue(): boolean {
    return this.activeVoices < CONFIG.audio.maxTransientVoices;
  }

  private trackSource(source: AudioScheduledSourceNode): void {
    if (this.activeVoices >= CONFIG.audio.maxTransientVoices) {
      try {
        source.stop();
      } catch {
        // A source may have already completed between scheduling and admission.
      }
      return;
    }
    this.activeVoices += 1;
    source.addEventListener('ended', () => {
      this.activeVoices = Math.max(0, this.activeVoices - 1);
    }, { once: true });
  }

  private noteCue(cue: string): void {
    this.cuesPlayed += 1;
    this.lastCue = cue;
  }

  private nextNoise(): number {
    this.noiseSeed = (Math.imul(this.noiseSeed, 1664525) + 1013904223) >>> 0;
    return this.noiseSeed / 0x1_0000_0000;
  }
}

function seconds(milliseconds: number): number {
  return milliseconds / MILLISECONDS_PER_SECOND;
}

function midiToHz(note: number): number {
  return MIDI_A4_HZ * Math.pow(2, (note - MIDI_A4_NOTE) / SEMITONES_PER_OCTAVE);
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function isOscillatorType(value: string | undefined): value is OscillatorType {
  return value === 'sine' || value === 'square' || value === 'sawtooth' || value === 'triangle' || value === 'custom';
}

function millisecondsToFrames(milliseconds: number, sampleRate: number): number {
  return Math.max(0, Math.floor(sampleRate * seconds(milliseconds)));
}

function rms(channel: Float32Array, start: number, end: number): number {
  const safeEnd = Math.min(channel.length, Math.max(start + 1, end));
  let sum = 0;
  for (let index = start; index < safeEnd; index += 1) {
    const sample = channel[index] ?? 0;
    sum += sample * sample;
  }
  return Math.sqrt(sum / Math.max(1, safeEnd - start));
}

function peakMagnitude(channel: Float32Array): number {
  let peak = 0;
  for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  return peak;
}
