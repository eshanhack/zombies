import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

export interface OperativePose {
  speedMps: number;
  pitch: number;
  downed: boolean;
}

type RestTransform = { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };

const NAMES = [
  'root', 'pelvis', 'spine', 'chest', 'neck', 'head', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftForeArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightForeArm', 'rightHand',
  'leftThigh', 'leftShin', 'leftFoot', 'rightThigh', 'rightShin', 'rightFoot', 'gear',
] as const;

let sharedGeometry: THREE.BufferGeometry | null = null;

export class RemoteOperative {
  readonly group = new THREE.Group();
  private readonly mesh: THREE.SkinnedMesh;
  private readonly bones: Map<string, THREE.Bone>;
  private readonly rest: Map<THREE.Bone, RestTransform>;
  private readonly material: THREE.MeshStandardMaterial;
  private elapsed = 0;
  private fireRemainingMs = 0;
  private reloadRemainingMs = 0;
  private meleeRemainingMs = 0;

  constructor() {
    const skeleton = buildSkeleton();
    this.bones = skeleton.bones;
    this.rest = skeleton.rest;
    this.material = new THREE.MeshStandardMaterial({ color: 0xffffff, vertexColors: true, roughness: 0.82, metalness: 0.035 });
    sharedGeometry ??= buildGeometry();
    this.mesh = new THREE.SkinnedMesh(sharedGeometry, this.material);
    this.mesh.name = 'remote-operative-22-bone-rig';
    this.mesh.add(skeleton.root);
    this.mesh.bind(skeleton.skeleton);
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
    this.mesh.frustumCulled = false;
    this.group.add(this.mesh);
  }

  update(deltaSeconds: number, pose: OperativePose): void {
    this.elapsed += deltaSeconds;
    this.fireRemainingMs = Math.max(0, this.fireRemainingMs - deltaSeconds * 1000);
    this.reloadRemainingMs = Math.max(0, this.reloadRemainingMs - deltaSeconds * 1000);
    this.meleeRemainingMs = Math.max(0, this.meleeRemainingMs - deltaSeconds * 1000);
    this.reset();
    const moveRatio = Math.min(1, pose.speedMps / (CONFIG.player.walkSpeed * CONFIG.player.sprintMultiplier));
    const cycle = this.elapsed * CONFIG.rendering.characterVisual.remoteLocomotionHz * Math.PI * 2;
    const swing = Math.sin(cycle) * CONFIG.rendering.zombieVisual.limbSwingRad * 0.78 * moveRatio;
    this.rotateX('leftThigh', -swing);
    this.rotateX('rightThigh', swing);
    this.rotateX('leftShin', Math.max(0, swing) * 0.54);
    this.rotateX('rightShin', Math.max(0, -swing) * 0.54);
    this.rotateX('leftUpperArm', 0.72 + swing * 0.14);
    this.rotateX('rightUpperArm', 0.84 - swing * 0.12);
    this.rotateY('chest', Math.sin(cycle * 0.5) * 0.045 * moveRatio);
    const pelvis = this.bones.get('pelvis');
    if (pelvis !== undefined) pelvis.position.y += Math.abs(Math.sin(cycle)) * 0.028 * moveRatio;
    this.rotateX('chest', THREE.MathUtils.clamp(pose.pitch * CONFIG.rendering.characterVisual.remoteAimPitchScale, -0.68, 0.68));
    if (this.fireRemainingMs > 0) {
      const progress = 1 - this.fireRemainingMs / CONFIG.rendering.characterVisual.remoteFireMs;
      const kick = Math.sin(progress * Math.PI);
      this.rotateX('rightShoulder', -kick * 0.17);
      this.rotateX('chest', THREE.MathUtils.clamp(pose.pitch * CONFIG.rendering.characterVisual.remoteAimPitchScale - kick * 0.055, -0.72, 0.68));
    }
    if (this.reloadRemainingMs > 0) {
      const progress = 1 - this.reloadRemainingMs / CONFIG.rendering.characterVisual.remoteReloadMs;
      const arc = Math.sin(progress * Math.PI);
      this.rotateX('leftUpperArm', 1.2 - arc * 1.65);
      this.rotateZ('leftUpperArm', -arc * 0.65);
      this.rotateX('leftForeArm', -arc * 1.1);
      this.rotateZ('rightUpperArm', arc * 0.18);
    }
    if (this.meleeRemainingMs > 0) {
      const progress = 1 - this.meleeRemainingMs / CONFIG.rendering.characterVisual.remoteMeleeMs;
      const arc = Math.sin(progress * Math.PI);
      this.rotateX('rightUpperArm', -arc * 1.55);
      this.rotateZ('rightUpperArm', arc * 0.72);
      this.rotateY('chest', -arc * 0.48);
    }
    if (pose.downed) {
      const root = this.bones.get('root');
      const pelvisBone = this.bones.get('pelvis');
      if (root !== undefined) root.position.y = 0.06;
      if (pelvisBone !== undefined) pelvisBone.rotation.x = -1.08;
      this.rotateX('leftThigh', 0.86);
      this.rotateX('rightThigh', 1.14);
      this.rotateX('leftShin', -1.22);
      this.rotateX('rightShin', -0.86);
      this.rotateZ('leftUpperArm', -0.34);
      this.rotateZ('rightUpperArm', 0.34);
    }
    this.mesh.skeleton.update();
  }

  playFire(): void { this.fireRemainingMs = CONFIG.rendering.characterVisual.remoteFireMs; }
  playReload(): void { this.reloadRemainingMs = CONFIG.rendering.characterVisual.remoteReloadMs; }
  playMelee(): void { this.meleeRemainingMs = CONFIG.rendering.characterVisual.remoteMeleeMs; }

  dispose(): void {
    this.material.dispose();
  }

  private reset(): void {
    for (const [bone, rest] of this.rest) {
      bone.position.copy(rest.position);
      bone.quaternion.copy(rest.quaternion);
      bone.scale.copy(rest.scale);
    }
  }

  private rotateX(name: string, value: number): void {
    const bone = this.bones.get(name);
    if (bone !== undefined) bone.rotation.x = value;
  }

  private rotateY(name: string, value: number): void {
    const bone = this.bones.get(name);
    if (bone !== undefined) bone.rotation.y = value;
  }

  private rotateZ(name: string, value: number): void {
    const bone = this.bones.get(name);
    if (bone !== undefined) bone.rotation.z = value;
  }
}

function buildSkeleton(): { root: THREE.Bone; skeleton: THREE.Skeleton; bones: Map<string, THREE.Bone>; rest: Map<THREE.Bone, RestTransform> } {
  const bones = new Map<string, THREE.Bone>();
  const add = (name: string, parent: string | null, position: readonly [number, number, number]): THREE.Bone => {
    const bone = new THREE.Bone();
    bone.name = name;
    bone.position.set(...position);
    bones.set(name, bone);
    if (parent !== null) bones.get(parent)?.add(bone);
    return bone;
  };
  const root = add('root', null, [0, 0, 0]);
  add('pelvis', 'root', [0, 0.86, 0]);
  add('spine', 'pelvis', [0, 0.18, 0]);
  add('chest', 'spine', [0, 0.25, 0]);
  add('neck', 'chest', [0, 0.28, 0]);
  add('head', 'neck', [0, 0.16, 0]);
  add('jaw', 'head', [0, -0.07, -0.13]);
  add('leftShoulder', 'chest', [-0.28, 0.14, 0]);
  add('leftUpperArm', 'leftShoulder', [-0.07, -0.05, 0]);
  add('leftForeArm', 'leftUpperArm', [0, -0.36, 0]);
  add('leftHand', 'leftForeArm', [0, -0.32, 0]);
  add('rightShoulder', 'chest', [0.28, 0.14, 0]);
  add('rightUpperArm', 'rightShoulder', [0.07, -0.05, 0]);
  add('rightForeArm', 'rightUpperArm', [0, -0.36, 0]);
  add('rightHand', 'rightForeArm', [0, -0.32, 0]);
  add('leftThigh', 'pelvis', [-0.15, -0.04, 0]);
  add('leftShin', 'leftThigh', [0, -0.42, 0]);
  add('leftFoot', 'leftShin', [0, -0.37, -0.07]);
  add('rightThigh', 'pelvis', [0.15, -0.04, 0]);
  add('rightShin', 'rightThigh', [0, -0.42, 0]);
  add('rightFoot', 'rightShin', [0, -0.37, -0.07]);
  add('gear', 'chest', [0, 0.08, 0.12]);
  root.updateMatrixWorld(true);
  const ordered = NAMES.map((name) => bones.get(name)!);
  const rest = new Map(ordered.map((bone) => [bone, {
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
    scale: bone.scale.clone(),
  }]));
  return { root, skeleton: new THREE.Skeleton(ordered), bones, rest };
}

function buildGeometry(): THREE.BufferGeometry {
  const uniform = new THREE.Color(0x445047);
  const trousers = new THREE.Color(0x303630);
  const skin = new THREE.Color(0x806d59);
  const leather = new THREE.Color(0x3b2d21);
  const metal = new THREE.Color(0x555e58);
  const parts: THREE.BufferGeometry[] = [];
  const add = (geometry: THREE.BufferGeometry, bone: number, color: THREE.Color, position: readonly [number, number, number], scale: readonly [number, number, number] = [1, 1, 1], rotation: readonly [number, number, number] = [0, 0, 0]): void => {
    geometry.scale(...scale);
    geometry.rotateX(rotation[0]);
    geometry.rotateY(rotation[1]);
    geometry.rotateZ(rotation[2]);
    geometry.translate(...position);
    addSkinning(geometry, bone, color);
    parts.push(geometry);
  };
  const capsule = (radius: number, length: number): THREE.CapsuleGeometry => new THREE.CapsuleGeometry(radius, length, 7, 18);
  add(capsule(0.25, 0.18), 1, trousers, [0, 0.9, 0]);
  add(capsule(0.245, 0.2), 2, uniform, [0, 1.08, 0]);
  add(capsule(0.285, 0.34), 3, uniform, [0, 1.32, 0], [1, 1, 0.82]);
  add(new THREE.CylinderGeometry(0.1, 0.11, 0.16, 16), 4, skin, [0, 1.56, 0]);
  add(new THREE.SphereGeometry(0.2, 22, 14), 5, skin, [0, 1.75, 0], [0.95, 1.08, 0.96]);
  add(new THREE.SphereGeometry(0.12, 16, 9), 6, skin.clone().multiplyScalar(0.85), [0, 1.66, -0.13], [0.9, 0.55, 0.8]);
  for (const side of [-1, 1]) {
    const upperBone = side < 0 ? 8 : 12;
    const foreBone = side < 0 ? 9 : 13;
    const handBone = side < 0 ? 10 : 14;
    const x = side * 0.35;
    add(capsule(0.09, 0.27), upperBone, uniform, [x, 1.24, 0]);
    add(capsule(0.076, 0.25), foreBone, uniform.clone().multiplyScalar(0.9), [x, 0.91, 0]);
    add(new THREE.SphereGeometry(0.08, 14, 9), handBone, skin, [x, 0.68, -0.01], [0.82, 1.2, 0.82]);
    const thighBone = side < 0 ? 15 : 18;
    const shinBone = side < 0 ? 16 : 19;
    const footBone = side < 0 ? 17 : 20;
    add(capsule(0.11, 0.31), thighBone, trousers, [side * 0.15, 0.61, 0]);
    add(capsule(0.095, 0.28), shinBone, trousers.clone().multiplyScalar(0.86), [side * 0.15, 0.23, 0]);
    add(new THREE.BoxGeometry(0.19, 0.13, 0.34, 3, 2, 4), footBone, leather, [side * 0.15, 0.075, -0.1]);
  }
  add(new THREE.SphereGeometry(0.22, 22, 11, 0, Math.PI * 2, 0, Math.PI * 0.54), 5, metal, [0, 1.79, 0], [1.06, 0.7, 1.06]);
  add(new THREE.BoxGeometry(0.3, 0.36, 0.11, 4, 5, 2), 21, leather, [0, 1.27, 0.25]);
  add(new THREE.BoxGeometry(0.13, 0.24, 0.08, 3, 4, 2), 1, leather, [0.25, 0.92, -0.17]);
  add(new THREE.CylinderGeometry(0.028, 0.033, 0.78, 10), 14, metal, [0.16, 1.16, -0.39], [1, 1, 1], [Math.PI / 2, 0, 0]);
  add(new THREE.BoxGeometry(0.15, 0.13, 0.4, 3, 3, 6), 14, metal, [0.12, 1.18, -0.08]);
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (merged === null) throw new Error('Unable to merge remote operative geometry.');
  merged.computeBoundingSphere();
  return merged;
}

function addSkinning(geometry: THREE.BufferGeometry, bone: number, color: THREE.Color): void {
  const count = geometry.getAttribute('position').count;
  const indices = new Uint16Array(count * 4);
  const weights = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    indices[index * 4] = bone;
    weights[index * 4] = 1;
    colors[index * 3] = color.r;
    colors[index * 3 + 1] = color.g;
    colors[index * 3 + 2] = color.b;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(indices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(weights, 4));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}
