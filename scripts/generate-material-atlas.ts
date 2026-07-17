import { deflateSync } from 'node:zlib';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SIZE = 2048;
const HALF = SIZE / 2;
const OUTPUT = join(process.cwd(), 'public', 'assets', 'materials');
const SEED = 0x1945b00b;
const VERSION = 4;
const CHANNELS = ['albedo', 'normal', 'roughness', 'ao', 'emissive'] as const;

type Channel = 'albedo' | 'normal' | 'roughness' | 'ao' | 'emissive';
type Pixel = readonly [number, number, number, number];
interface SurfaceData {
  coarse: Float32Array;
  fine: Float32Array;
  stain: Float32Array;
  height: Float32Array;
}

const CRACK_MASKS = buildCrackMasks();
const SURFACES = buildSurfaceData();

mkdirSync(OUTPUT, { recursive: true });
const manifestPath = join(OUTPUT, 'manifest.json');
if (existsSync(manifestPath)) {
  try {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version?: number };
    if (manifest.version === VERSION && CHANNELS.every((channel) => existsSync(join(OUTPUT, `bunker_${channel}.png`)))) {
      process.exit(0);
    }
  } catch {
    // Regenerate when a prior manifest is incomplete.
  }
}

for (const channel of CHANNELS) {
  const pixels = new Uint8Array(SIZE * SIZE * 4);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) {
      const quadrant = (x >= HALF ? 1 : 0) + (y >= HALF ? 2 : 0);
      const localX = x % HALF;
      const localY = y % HALF;
      const pixel = materialPixel(quadrant, localX, localY, channel);
      const offset = (y * SIZE + x) * 4;
      pixels[offset] = pixel[0];
      pixels[offset + 1] = pixel[1];
      pixels[offset + 2] = pixel[2];
      pixels[offset + 3] = pixel[3];
    }
  }
  writeFileSync(join(OUTPUT, `bunker_${channel}.png`), encodePng(SIZE, SIZE, pixels));
}
writeFileSync(manifestPath, `${JSON.stringify({ version: VERSION, size: SIZE, seed: SEED, channels: CHANNELS }, null, 2)}\n`);

function materialPixel(material: number, x: number, y: number, channel: Channel): Pixel {
  const surface = SURFACES[material]!;
  const index = y * HALF + x;
  const height = surface.height[index] ?? 0;
  const nextX = surface.height[y * HALF + (x + 2) % HALF] ?? height;
  const nextY = surface.height[((y + 2) % HALF) * HALF + x] ?? height;
  const coarse = surface.coarse[index] ?? 0.5;
  const fine = surface.fine[index] ?? 0.5;
  const stain = surface.stain[index] ?? 0;
  const crack = crackMask(x, y, material);

  if (channel === 'normal') {
    const strength = material === 3 ? 2.2 : material === 2 ? 4.1 : 5.6;
    const nx = (height - nextX) * strength;
    const ny = (height - nextY) * strength;
    const nz = 1;
    const length = Math.hypot(nx, ny, nz);
    return [
      quantizeByte(toByte(nx / length * 0.5 + 0.5), 8),
      quantizeByte(toByte(ny / length * 0.5 + 0.5), 8),
      quantizeByte(toByte(nz / length * 0.5 + 0.5), 8),
      255,
    ];
  }

  if (channel === 'roughness') {
    const base = [0.91, 0.86, 0.78, 0.58][material] ?? 0.8;
    const rustBoost = material === 3 ? stain * 0.27 : 0;
    const value = clamp01(base + (fine - 0.5) * 0.16 + rustBoost);
    const byte = toByte(value);
    return [byte, byte, byte, 255];
  }

  if (channel === 'ao') {
    const value = clamp01(0.82 + coarse * 0.17 - crack * 0.48 - stain * 0.1);
    const byte = toByte(value);
    return [byte, byte, byte, 255];
  }

  if (channel === 'emissive') {
    const rustGlow = material === 3 ? Math.max(0, stain - 0.76) * 0.025 : 0;
    return [toByte(rustGlow), toByte(rustGlow * 0.38), 0, 255];
  }

  if (material === 0) {
    const aggregate = Math.max(0, fine - 0.72) * 0.32;
    return rgb([72, 76, 72], (coarse - 0.5) * 29 + (fine - 0.5) * 13 - stain * 22 - crack * 43 + aggregate * 70);
  }
  if (material === 1) {
    const peelNoise = tileFbm(x, y, 811, 14);
    const peel = peelNoise > 0.72 ? -18 * smoothStep(0.72, 0.86, peelNoise) : 0;
    return rgb([116, 115, 105], (coarse - 0.5) * 25 + (fine - 0.5) * 8 - stain * 29 - crack * 43 + peel);
  }
  if (material === 2) {
    const tau = Math.PI * 2;
    const grain = Math.sin(x / HALF * tau * 17 + Math.sin(y / HALF * tau * 3) * 0.72) * 10;
    const grainFine = Math.sin(x / HALF * tau * 43 + Math.sin(y / HALF * tau * 7) * 0.34) * 3.5;
    const knotDistance = wrappedDistance(x, y, HALF * 0.37, HALF * 0.62);
    const knot = Math.max(0, 1 - knotDistance / 64) * -34;
    return rgb([82, 58, 38], grain + grainFine + (coarse - 0.5) * 22 + (fine - 0.5) * 8 + knot - stain * 14);
  }
  const rust = stain * 58;
  const scratches = (hash(x >> 1, y >> 4, 773) > 0.987 || hash(x >> 4, y >> 1, 337) > 0.991) ? 34 : 0;
  return [
    toByte((54 + (coarse - 0.5) * 18 + rust + scratches) / 255),
    toByte((61 + (coarse - 0.5) * 16 + rust * 0.46 + scratches) / 255),
    toByte((59 + (coarse - 0.5) * 14 + rust * 0.16 + scratches) / 255),
    255,
  ];
}

function crackMask(x: number, y: number, material: number): number {
  return CRACK_MASKS[material]?.[Math.floor(y) * HALF + Math.floor(x)] ?? 0;
}

function tileFbm(x: number, y: number, salt: number, baseCells: number): number {
  let value = 0;
  let amplitude = 0.55;
  let norm = 0;
  for (let octave = 0; octave < 4; octave += 1) {
    value += tileNoise(x, y, baseCells * (1 << octave), salt + octave * 197) * amplitude;
    norm += amplitude;
    amplitude *= 0.48;
  }
  return value / norm;
}

function tileNoise(x: number, y: number, cells: number, salt: number): number {
  const gx = x / HALF * cells;
  const gy = y / HALF * cells;
  const ix = Math.floor(gx);
  const iy = Math.floor(gy);
  const fx = gx - ix;
  const fy = gy - iy;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const x0 = modulo(ix, cells);
  const y0 = modulo(iy, cells);
  const x1 = modulo(ix + 1, cells);
  const y1 = modulo(iy + 1, cells);
  const a = hash(x0, y0, salt);
  const b = hash(x1, y0, salt);
  const c = hash(x0, y1, salt);
  const d = hash(x1, y1, salt);
  return mix(mix(a, b, sx), mix(c, d, sx), sy);
}

function buildCrackMasks(): Float32Array[] {
  const masks: Float32Array[] = [];
  for (let material = 0; material < 4; material += 1) {
    const mask = new Float32Array(HALF * HALF);
    if (material < 2) {
      const random = makeRandom(SEED ^ (material + 1) * 0x45d9f3b);
      const roots = material === 0 ? 4 : 5;
      for (let root = 0; root < roots; root += 1) {
        drawCrack(
          mask,
          random() * HALF,
          random() * HALF,
          random() * Math.PI * 2,
          155 + random() * 250,
          random,
          material === 0 ? 1.45 : 1.2,
          0,
        );
      }
    }
    masks.push(mask);
  }
  return masks;
}

function buildSurfaceData(): SurfaceData[] {
  const surfaces: SurfaceData[] = [];
  const tau = Math.PI * 2;
  for (let material = 0; material < 4; material += 1) {
    const coarse = new Float32Array(HALF * HALF);
    const fine = new Float32Array(HALF * HALF);
    const stain = new Float32Array(HALF * HALF);
    const height = new Float32Array(HALF * HALF);
    for (let y = 0; y < HALF; y += 1) {
      for (let x = 0; x < HALF; x += 1) {
        const index = y * HALF + x;
        const coarseValue = tileFbm(x, y, material * 101, 5);
        const fineValue = tileFbm(x, y, material * 313, 54);
        const stainValue = Math.max(0, tileFbm(x, y, material * 701, 3) - 0.58) / 0.42;
        const crack = crackMask(x, y, material);
        coarse[index] = coarseValue;
        fine[index] = fineValue;
        stain[index] = stainValue;
        height[index] = material === 2
          ? coarseValue * 0.36 + fineValue * 0.13
            + Math.sin(x / HALF * tau * 17 + Math.sin(y / HALF * tau * 3) * 0.72) * 0.12
          : material === 3
            ? coarseValue * 0.2 + fineValue * 0.08 - crack * 0.12
            : coarseValue * 0.4 + fineValue * 0.17 - crack * 0.3;
      }
    }
    surfaces.push({ coarse, fine, stain, height });
  }
  return surfaces;
}

function drawCrack(
  mask: Float32Array,
  startX: number,
  startY: number,
  startAngle: number,
  length: number,
  random: () => number,
  width: number,
  depth: number,
): void {
  let x = startX;
  let y = startY;
  let angle = startAngle;
  const steps = Math.floor(length / 1.8);
  const driftPhase = random() * Math.PI * 2;
  const branchStep = Math.floor(steps * (0.34 + random() * 0.34));
  for (let step = 0; step < steps; step += 1) {
    angle += (random() - 0.5) * 0.095 + Math.sin(step * 0.053 + driftPhase) * 0.011;
    x = modulo(x + Math.cos(angle) * 1.8, HALF);
    y = modulo(y + Math.sin(angle) * 1.8, HALF);
    stampCrack(mask, x, y, width);
    if (depth === 0 && step === branchStep) {
      const direction = random() > 0.5 ? 1 : -1;
      drawCrack(mask, x, y, angle + direction * (0.42 + random() * 0.38), length * (0.28 + random() * 0.18), random, width * 0.72, 1);
    }
  }
}

function stampCrack(mask: Float32Array, x: number, y: number, width: number): void {
  const radius = Math.ceil(width + 1);
  for (let oy = -radius; oy <= radius; oy += 1) {
    for (let ox = -radius; ox <= radius; ox += 1) {
      const distance = Math.hypot(ox, oy);
      const value = clamp01(width + 0.75 - distance);
      if (value <= 0) continue;
      const px = modulo(Math.round(x) + ox, HALF);
      const py = modulo(Math.round(y) + oy, HALF);
      const index = py * HALF + px;
      mask[index] = Math.max(mask[index] ?? 0, value);
    }
  }
}

function makeRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function wrappedDistance(x: number, y: number, centerX: number, centerY: number): number {
  const dx = Math.min(Math.abs(x - centerX), HALF - Math.abs(x - centerX));
  const dy = Math.min(Math.abs(y - centerY), HALF - Math.abs(y - centerY));
  return Math.hypot(dx, dy);
}

function hash(x: number, y: number, salt: number): number {
  let value = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(salt ^ SEED, 2147483647)) | 0;
  value = Math.imul(value ^ (value >>> 13), 1274126177);
  return ((value ^ (value >>> 16)) >>> 0) / 4294967295;
}

function rgb(base: readonly [number, number, number], delta: number): Pixel {
  return [clampByte(base[0] + delta), clampByte(base[1] + delta), clampByte(base[2] + delta), 255];
}

function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (stride + 1);
    scanlines[row] = 1;
    for (let x = 0; x < stride; x += 1) {
      const current = rgba[y * stride + x] ?? 0;
      const left = x >= 4 ? rgba[y * stride + x - 4] ?? 0 : 0;
      scanlines[row + x + 1] = (current - left + 256) & 255;
    }
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(scanlines, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type);
  const output = Buffer.alloc(data.length + 12);
  output.writeUInt32BE(data.length, 0);
  typeBytes.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), data.length + 8);
  return output;
}

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function mix(a: number, b: number, amount: number): number { return a + (b - a) * amount; }
function smoothStep(edge0: number, edge1: number, value: number): number {
  const amount = clamp01((value - edge0) / (edge1 - edge0));
  return amount * amount * (3 - 2 * amount);
}
function modulo(value: number, divisor: number): number { return ((value % divisor) + divisor) % divisor; }
function clamp01(value: number): number { return Math.max(0, Math.min(1, value)); }
function toByte(value: number): number { return Math.round(clamp01(value) * 255); }
function clampByte(value: number): number { return Math.round(Math.max(0, Math.min(255, value))); }
function quantizeByte(value: number, step: number): number { return Math.min(255, Math.round(value / step) * step); }
