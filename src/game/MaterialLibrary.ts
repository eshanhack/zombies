import * as THREE from 'three';
import { CONFIG } from '../config.js';

export type BunkerMaterialKind = 'concrete' | 'plaster' | 'wood' | 'steel';
type AtlasChannel = 'albedo' | 'normal' | 'roughness' | 'ao' | 'emissive';

const KINDS: readonly BunkerMaterialKind[] = ['concrete', 'plaster', 'wood', 'steel'];
const CHANNELS: readonly AtlasChannel[] = ['albedo', 'normal', 'roughness', 'ao', 'emissive'];

export class MaterialLibrary {
  readonly concrete: THREE.MeshStandardMaterial;
  readonly plaster: THREE.MeshStandardMaterial;
  readonly wood: THREE.MeshStandardMaterial;
  readonly steel: THREE.MeshStandardMaterial;
  private readonly textures = new Map<string, THREE.CanvasTexture>();
  private disposed = false;

  constructor() {
    for (const kind of KINDS) {
      for (const channel of CHANNELS) this.textures.set(`${kind}:${channel}`, this.makeTexture(channel));
    }
    for (const channel of CHANNELS) this.loadAtlas(channel);
    this.concrete = this.makeMaterial('concrete');
    this.plaster = this.makeMaterial('plaster');
    this.wood = this.makeMaterial('wood');
    this.steel = this.makeMaterial('steel');
  }

  get(kind: BunkerMaterialKind): THREE.MeshStandardMaterial {
    return this[kind];
  }

  clone(kind: BunkerMaterialKind, options: Partial<THREE.MeshStandardMaterialParameters> = {}): THREE.MeshStandardMaterial {
    const material = this[kind].clone();
    material.setValues(options);
    return material;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const texture of this.textures.values()) texture.dispose();
    for (const material of [this.concrete, this.plaster, this.wood, this.steel]) material.dispose();
  }

  private makeMaterial(kind: BunkerMaterialKind): THREE.MeshStandardMaterial {
    const settings = CONFIG.rendering.materials[kind];
    const material = new THREE.MeshStandardMaterial({
      color: settings.color,
      map: this.texture(kind, 'albedo'),
      normalMap: this.texture(kind, 'normal'),
      normalScale: new THREE.Vector2(CONFIG.rendering.materials.normalScale, CONFIG.rendering.materials.normalScale),
      roughness: settings.roughness,
      roughnessMap: this.texture(kind, 'roughness'),
      metalness: settings.metalness,
      aoMap: this.texture(kind, 'ao'),
      aoMapIntensity: CONFIG.rendering.materials.aoIntensity,
      emissive: 0xffffff,
      emissiveMap: this.texture(kind, 'emissive'),
      emissiveIntensity: CONFIG.rendering.materials.emissiveIntensity,
    });
    material.name = `pbr-${kind}`;
    return material;
  }

  private texture(kind: BunkerMaterialKind, channel: AtlasChannel): THREE.CanvasTexture {
    const texture = this.textures.get(`${kind}:${channel}`);
    if (texture === undefined) throw new Error(`Missing ${kind} ${channel} texture.`);
    return texture;
  }

  private makeTexture(channel: AtlasChannel): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 2;
    canvas.height = 2;
    const context = canvas.getContext('2d');
    if (context !== null) {
      context.fillStyle = channel === 'normal' ? '#8080ff' : channel === 'emissive' ? '#000000' : '#808080';
      context.fillRect(0, 0, 2, 2);
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.anisotropy = CONFIG.rendering.materials.anisotropy;
    texture.colorSpace = channel === 'albedo' || channel === 'emissive' ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    texture.channel = 0;
    return texture;
  }

  private loadAtlas(channel: AtlasChannel): void {
    const image = new Image();
    image.decoding = 'async';
    image.src = `/assets/materials/bunker_${channel}.png`;
    image.addEventListener('load', () => {
      if (this.disposed) return;
      for (let index = 0; index < KINDS.length; index += 1) {
        const kind = KINDS[index]!;
        const texture = this.texture(kind, channel);
        const canvas = document.createElement('canvas');
        canvas.width = CONFIG.rendering.materials.quadrantSizePx;
        canvas.height = CONFIG.rendering.materials.quadrantSizePx;
        const context = canvas.getContext('2d', { alpha: false });
        if (context === null) continue;
        const sourceX = (index % 2) * CONFIG.rendering.materials.quadrantSizePx;
        const sourceY = Math.floor(index / 2) * CONFIG.rendering.materials.quadrantSizePx;
        context.drawImage(
          image,
          sourceX,
          sourceY,
          CONFIG.rendering.materials.quadrantSizePx,
          CONFIG.rendering.materials.quadrantSizePx,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        texture.image = canvas;
        texture.needsUpdate = true;
      }
    }, { once: true });
  }
}

export function applyTiledUvs(geometry: THREE.BufferGeometry, metersPerTile = CONFIG.rendering.materials.metersPerTile): THREE.BufferGeometry {
  const positions = geometry.getAttribute('position');
  const normals = geometry.getAttribute('normal');
  if (positions === undefined || normals === undefined) return geometry;
  const uv = new Float32Array(positions.count * 2);
  for (let index = 0; index < positions.count; index += 1) {
    const x = positions.getX(index);
    const y = positions.getY(index);
    const z = positions.getZ(index);
    const nx = Math.abs(normals.getX(index));
    const ny = Math.abs(normals.getY(index));
    const nz = Math.abs(normals.getZ(index));
    let u = x;
    let v = y;
    if (nx >= ny && nx >= nz) {
      u = z;
      v = y;
    } else if (ny >= nx && ny >= nz) {
      u = x;
      v = z;
    }
    uv[index * 2] = u / metersPerTile;
    uv[index * 2 + 1] = v / metersPerTile;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return geometry;
}
