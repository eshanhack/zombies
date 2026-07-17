import { readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG } from '../src/config.js';
import { EnemyRenderer } from '../src/game/EnemyRenderer.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const atlasRoot = resolve(root, 'public', 'assets', 'materials');
const channels = ['albedo', 'normal', 'roughness', 'ao', 'emissive'] as const;

describe('P8 production art assets', () => {
  it('ships every deterministic 2K PBR atlas channel', () => {
    const manifest = JSON.parse(readFileSync(resolve(atlasRoot, 'manifest.json'), 'utf8')) as {
      version: number;
      size: number;
      seed: number;
      channels: string[];
    };
    expect(manifest).toMatchObject({ version: 4, size: 2048, seed: 0x1945b00b });
    expect(manifest.channels).toEqual(channels);

    for (const channel of channels) {
      const path = resolve(atlasRoot, `bunker_${channel}.png`);
      const bytes = readFileSync(path);
      expect(bytes.subarray(1, 4).toString('ascii')).toBe('PNG');
      expect(bytes.readUInt32BE(16)).toBe(CONFIG.rendering.materials.atlasSizePx);
      expect(bytes.readUInt32BE(20)).toBe(CONFIG.rendering.materials.atlasSizePx);
      expect(statSync(path).size).toBeGreaterThan(1024);
    }
  });

  it('keeps the final shared rigs inside the production geometry contract', () => {
    const renderer = new EnemyRenderer();
    const diagnostics = renderer.getDiagnostics();
    expect(diagnostics.zombieTriangles).toBeGreaterThanOrEqual(8_000);
    expect(diagnostics.zombieTriangles).toBeLessThanOrEqual(12_000);
    expect(diagnostics.wolfTriangles).toBeGreaterThanOrEqual(7_000);
    expect(diagnostics.wolfTriangles).toBeLessThanOrEqual(9_000);
    expect(diagnostics.zombieBones).toBe(CONFIG.rendering.characterVisual.zombieBones);
    expect(diagnostics.wolfBones).toBe(CONFIG.rendering.characterVisual.wolfBones);
    expect(diagnostics.silhouettes).toBe(CONFIG.rendering.characterVisual.silhouetteVariants);
    renderer.dispose();
  });

  it('retains the release performance and post-processing budgets in CONFIG', () => {
    expect(CONFIG.rendering.drawCallBudget).toBe(150);
    expect(CONFIG.rendering.targetFps).toBe(60);
    expect(CONFIG.rendering.maxPixelRatio).toBeLessThanOrEqual(1.5);
    expect(CONFIG.rendering.post.grainStrength).toBeGreaterThan(0);
    expect(CONFIG.rendering.post.vignetteStrength).toBeGreaterThan(0);
    expect(CONFIG.rendering.environment.dustParticles).toBeGreaterThanOrEqual(500);
  });
});
