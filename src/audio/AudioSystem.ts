import { CONFIG, type WeaponId } from '../config.js';

export class AudioSystem {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private noiseSeed: number = CONFIG.simulation.seedFallback;

  setSeed(seed: number): void {
    this.noiseSeed = seed >>> 0 || CONFIG.simulation.seedFallback;
  }

  playShot(weaponId: WeaponId): void {
    const context = this.ensureContext();
    const master = this.master;
    if (context === null || master === null) return;
    const profile = weaponId === 'jaeger' ? CONFIG.audio.weaponProfiles.jaeger : CONFIG.audio.weaponProfiles.melder;
    const now = context.currentTime;
    const duration = profile.noiseMs / 1000;

    const crack = context.createOscillator();
    const crackGain = context.createGain();
    crack.type = weaponId === 'jaeger' ? 'square' : 'triangle';
    crack.frequency.setValueAtTime(profile.crackHz * 2.3, now);
    crack.frequency.exponentialRampToValueAtTime(profile.crackHz, now + duration);
    crackGain.gain.setValueAtTime(profile.gain, now);
    crackGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    crack.connect(crackGain).connect(master);
    crack.start(now);
    crack.stop(now + duration);

    const sampleCount = Math.max(1, Math.floor(context.sampleRate * duration));
    const buffer = context.createBuffer(1, sampleCount, context.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < channel.length; index += 1) channel[index] = this.nextNoise() * 2 - 1;
    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(profile.filterHz, now);
    noiseGain.gain.setValueAtTime(profile.gain * 0.72, now);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    noise.buffer = buffer;
    noise.connect(filter).connect(noiseGain).connect(master);
    noise.start(now);
  }

  playHitmarker(): void {
    this.playClick(CONFIG.audio.hitmarkerFrequencyHz, CONFIG.audio.hitmarkerDurationMs, 0.1);
  }

  playEmpty(): void {
    this.playClick(CONFIG.audio.emptyClickFrequencyHz, CONFIG.audio.reloadClickMs, 0.13);
  }

  playReload(weaponId: WeaponId): void {
    const context = this.ensureContext();
    const master = this.master;
    if (context === null || master === null) return;
    const definition = CONFIG.weapons[weaponId];
    this.scheduleClick(context.currentTime, CONFIG.audio.reloadClickFrequencyHz, master, 0.11);
    this.scheduleClick(context.currentTime + definition.reloadMs / 2000, CONFIG.audio.reloadClickFrequencyHz * 0.74, master, 0.09);
    this.scheduleClick(context.currentTime + definition.reloadMs / 1000 * 0.88, CONFIG.audio.reloadClickFrequencyHz * 1.18, master, 0.12);
  }

  dispose(): void {
    const context = this.context;
    this.context = null;
    this.master = null;
    if (context !== null) void context.close();
  }

  private ensureContext(): AudioContext | null {
    if (typeof AudioContext === 'undefined') return null;
    if (this.context === null) {
      this.context = new AudioContext({ sampleRate: 48000 });
      this.master = this.context.createGain();
      this.master.gain.value = CONFIG.audio.masterGain * CONFIG.audio.effectsGain;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') void this.context.resume();
    return this.context;
  }

  private playClick(frequency: number, durationMs: number, gain: number): void {
    const context = this.ensureContext();
    const master = this.master;
    if (context === null || master === null) return;
    this.scheduleClick(context.currentTime, frequency, master, gain, durationMs);
  }

  private scheduleClick(at: number, frequency: number, destination: AudioNode, gainValue: number, durationMs: number = CONFIG.audio.reloadClickMs): void {
    const context = this.context;
    if (context === null) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'square';
    oscillator.frequency.setValueAtTime(frequency, at);
    gain.gain.setValueAtTime(gainValue, at);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + durationMs / 1000);
    oscillator.connect(gain).connect(destination);
    oscillator.start(at);
    oscillator.stop(at + durationMs / 1000);
  }

  private nextNoise(): number {
    this.noiseSeed = (Math.imul(this.noiseSeed, 1664525) + 1013904223) >>> 0;
    return this.noiseSeed / 0x1_0000_0000;
  }
}
