import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONFIG, type RoomId, type WeaponId } from '../src/config.js';
import { AUDIO_EVENT_COVERAGE, computeSpatialMix, type AudioPoint } from '../src/audio/AudioSystem.js';

const listener = { x: 0, y: CONFIG.controller.eyeHeightM, z: 0, room: 'start' as RoomId, yaw: 0 };

describe('P7 production audio contract', () => {
  it('runs the complete signal graph at 48 kHz with conservative master headroom', () => {
    expect(CONFIG.audio.sampleRateHz).toBe(48000);
    expect(CONFIG.audio.compressor.thresholdDb).toBeLessThanOrEqual(-12);
    expect(CONFIG.audio.compressor.ratio).toBeGreaterThanOrEqual(8);
    expect(CONFIG.audio.masterGain * CONFIG.audio.effectsGain).toBeLessThan(0.6);
    expect(CONFIG.audio.maxTransientVoices).toBeLessThanOrEqual(64);
  });

  it('defines five genuinely distinct zombie vocal families and a separate wolf voice', () => {
    expect(CONFIG.audio.zombieVoiceFamilies).toHaveLength(5);
    const signatures = CONFIG.audio.zombieVoiceFamilies.map((family) => `${family.carrierHz}:${family.formantsHz.join(':')}`);
    expect(new Set(signatures).size).toBe(5);
    expect(CONFIG.audio.wolfVoice.carrierHz).not.toBe(CONFIG.audio.zombieVoiceFamilies[0]?.carrierHz);
    expect(CONFIG.audio.wolfVoice.intervalMs[1]).toBeLessThan(CONFIG.audio.zombieVoiceIntervalMs[1]);
  });

  it('gives every weapon a unique layered report and mechanical reload identity', () => {
    const weaponIds = Object.keys(CONFIG.weapons) as WeaponId[];
    expect(Object.keys(CONFIG.audio.weaponProfiles).sort()).toEqual([...weaponIds].sort());
    expect(Object.keys(CONFIG.audio.weaponMechanics).sort()).toEqual([...weaponIds].sort());
    const shotSignatures = weaponIds.map((id) => JSON.stringify(CONFIG.audio.weaponProfiles[id]));
    const reloadSignatures = weaponIds.map((id) => JSON.stringify(CONFIG.audio.weaponMechanics[id]));
    expect(new Set(shotSignatures).size).toBe(weaponIds.length);
    expect(new Set(reloadSignatures).size).toBe(weaponIds.length);
  });

  it('covers every authoritative simulation event with a production cue route', () => {
    expect(Object.keys(AUDIO_EVENT_COVERAGE).sort()).toEqual([
      'ammoPurchased', 'boardRepaired', 'boardTorn', 'crateCollected', 'cratePuppe', 'crateSettled', 'crateStarted',
      'doorOpened', 'enemyKilled', 'enemySpawned', 'forgeCancelled', 'forgeCompleted', 'forgeStarted', 'gameOver',
      'grenadeExploded', 'grenadeThrown', 'grenadesPurchased', 'perkGranted', 'perkPurchaseStarted', 'playerBledOut',
      'playerDamaged', 'playerDowned', 'playerReturned', 'playerRevived', 'playerSelfDamaged', 'pointTransaction',
      'powerActivated', 'powerupCollected', 'powerupSpawned', 'roundEnded', 'roundStarted', 'vaultStarted', 'weaponPurchased',
    ].sort());
    expect(Object.values(AUDIO_EVENT_COVERAGE)).not.toContain(undefined);
  });

  it('places breach cues on the correct listener-relative side at every yaw', () => {
    const left: AudioPoint = { x: -6, y: listener.y, z: -2, room: 'start' };
    const right: AudioPoint = { x: 6, y: listener.y, z: -2, room: 'start' };
    expect(computeSpatialMix(left, listener).pan).toBeLessThan(-0.9);
    expect(computeSpatialMix(right, listener).pan).toBeGreaterThan(0.9);

    const turned = { ...listener, yaw: Math.PI / 2 };
    const turnedRight: AudioPoint = { x: -2, y: listener.y, z: -6, room: 'start' };
    const turnedLeft: AudioPoint = { x: -2, y: listener.y, z: 6, room: 'start' };
    expect(computeSpatialMix(turnedRight, turned).pan).toBeGreaterThan(0.9);
    expect(computeSpatialMix(turnedLeft, turned).pan).toBeLessThan(-0.9);
  });

  it('applies distance rolloff, cross-room occlusion, and room-specific reverb', () => {
    const near: AudioPoint = { x: 1, y: listener.y, z: 0, room: 'start' };
    const far: AudioPoint = { x: 20, y: listener.y, z: 0, room: 'start' };
    const occluded: AudioPoint = { ...near, room: 'generator' };
    const nearMix = computeSpatialMix(near, listener);
    const farMix = computeSpatialMix(far, listener);
    const occludedMix = computeSpatialMix(occluded, listener);
    expect(nearMix.attenuation).toBe(1);
    expect(farMix.attenuation).toBeLessThan(nearMix.attenuation);
    expect(occludedMix.occluded).toBe(true);
    expect(occludedMix.lowpassHz).toBe(CONFIG.audio.occlusionCutoffHz);
    expect(occludedMix.dryGain).toBeLessThan(nearMix.dryGain);
    expect(occludedMix.reverbSend).toBe(CONFIG.audio.roomReverbSend.generator);
    expect(new Set(Object.values(CONFIG.audio.roomReverbSend)).size).toBe(4);
  });

  it('contains distinct original perk, round, wolf, Puppe, and power-up material', () => {
    const jingleSignatures = Object.values(CONFIG.audio.perkJingles).map((jingle) => `${jingle.bpm}:${jingle.notes.join(',')}:${jingle.waveform}`);
    expect(new Set(jingleSignatures).size).toBe(4);
    expect(CONFIG.audio.musicalCues.roundWolf.notes).not.toEqual(CONFIG.audio.musicalCues.roundZombie.notes);
    expect(CONFIG.audio.musicalCues.puppe.notes.length).toBeGreaterThanOrEqual(5);
    expect(Object.keys(CONFIG.audio.announcerPatterns).sort()).toEqual(['carpenter', 'doublePoints', 'instaKill', 'maxAmmo', 'nuke'].sort());
    expect(Object.keys(CONFIG.audio.announcerPhonemes).sort()).toEqual(['carpenter', 'doublePoints', 'instaKill', 'maxAmmo', 'nuke'].sort());
    for (const phrase of Object.values(CONFIG.audio.announcerPhonemes)) {
      expect(phrase.length).toBeGreaterThanOrEqual(3);
      expect(phrase.some((phoneme) => phoneme.noise > 0.6)).toBe(true);
    }
  });

  it('keeps procedural audio deterministic and free of runtime asset fetches', () => {
    const source = readFileSync(new URL('../src/audio/AudioSystem.ts', import.meta.url), 'utf8');
    expect(source).not.toContain('Math.random');
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/new Audio\s*\(/);
    expect(source).toContain('createConvolver');
    expect(source).toContain("panner.panningModel = 'HRTF'");
  });
});
