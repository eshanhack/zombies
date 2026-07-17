import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG } from '../config.js';

export interface EnemyVisualState {
  id: number;
  kind: 'zombie' | 'crawler' | 'wolf';
  state: 'spawn' | 'tear' | 'vault' | 'chase' | 'attack' | 'dead';
  speedTier: 'walk' | 'jog' | 'sprint';
  x: number;
  y: number;
  z: number;
  yaw: number;
  stateTimeMs: number;
  spawnProgress: number;
  hp?: number;
  maxHp?: number;
}

export interface EnemyRendererDiagnostics {
  visible: number;
  zombieTriangles: number;
  wolfTriangles: number;
  zombieBones: number;
  wolfBones: number;
  silhouettes: number;
}

type RestTransform = { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 };

interface RigVisual {
  enemyId: number;
  kind: 'zombie' | 'wolf';
  group: THREE.Group;
  mesh: THREE.SkinnedMesh;
  bones: Map<string, THREE.Bone>;
  rest: Map<THREE.Bone, RestTransform>;
  dissolve: { value: number };
  lastHp: number;
  lastStateTimeMs: number;
  staggerRemainingMs: number;
}

interface SkeletonBuild {
  root: THREE.Bone;
  skeleton: THREE.Skeleton;
  bones: Map<string, THREE.Bone>;
  rest: Map<THREE.Bone, RestTransform>;
}

const ZOMBIE_BONE_NAMES = [
  'root', 'pelvis', 'spine', 'chest', 'neck', 'head', 'jaw',
  'leftShoulder', 'leftUpperArm', 'leftForeArm', 'leftHand',
  'rightShoulder', 'rightUpperArm', 'rightForeArm', 'rightHand',
  'leftThigh', 'leftShin', 'leftFoot', 'rightThigh', 'rightShin', 'rightFoot', 'coatTail',
] as const;

const WOLF_BONE_NAMES = [
  'root', 'spine', 'neck', 'head', 'jaw',
  'frontLeftUpper', 'frontLeftLower', 'frontRightUpper', 'frontRightLower',
  'rearLeftUpper', 'rearLeftLower', 'rearRightUpper', 'rearRightLower', 'tail',
] as const;

export class EnemyRenderer {
  readonly group = new THREE.Group();
  private readonly zombieGeometries: THREE.BufferGeometry[];
  private readonly wolfGeometry: THREE.BufferGeometry;
  private readonly zombiePool: RigVisual[];
  private readonly wolfPool: RigVisual[];
  private readonly assignments = new Map<number, RigVisual>();
  private readonly zombieEyeGeometry = pairedEyes(0.019, 0.073);
  private readonly wolfEyeGeometry = pairedEyes(0.041, 0.076);
  private readonly zombieEyeMaterial = new THREE.MeshStandardMaterial({
    color: CONFIG.rendering.characterVisual.eyeColor,
    emissive: CONFIG.rendering.characterVisual.eyeColor,
    emissiveIntensity: 0.52,
    roughness: 0.34,
  });
  private readonly wolfEyeMaterial = new THREE.MeshStandardMaterial({
    color: CONFIG.rendering.wolfVisual.eyeColor,
    emissive: CONFIG.rendering.wolfVisual.eyeColor,
    emissiveIntensity: 4.2,
    roughness: 0.22,
  });
  private readonly zombieEyes: THREE.InstancedMesh;
  private readonly wolfEyes: THREE.InstancedMesh;
  private readonly diagnostics: EnemyRendererDiagnostics;

  constructor() {
    this.group.name = 'shared-rigged-enemies';
    this.zombieGeometries = Array.from(
      { length: CONFIG.rendering.characterVisual.silhouetteVariants },
      (_, variant) => buildZombieGeometry(variant),
    );
    this.wolfGeometry = buildWolfGeometry();
    this.zombieEyes = new THREE.InstancedMesh(this.zombieEyeGeometry, this.zombieEyeMaterial, CONFIG.zombie.maxAlive);
    this.wolfEyes = new THREE.InstancedMesh(this.wolfEyeGeometry, this.wolfEyeMaterial, CONFIG.zombie.maxAlive);
    this.zombieEyes.count = 0;
    this.wolfEyes.count = 0;
    this.zombieEyes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.wolfEyes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.zombieEyes.frustumCulled = false;
    this.wolfEyes.frustumCulled = false;
    this.group.add(this.zombieEyes, this.wolfEyes);
    this.zombiePool = Array.from({ length: CONFIG.zombie.maxAlive }, (_, index) => this.createZombie(index));
    this.wolfPool = Array.from({ length: CONFIG.zombie.maxAlive }, () => this.createWolf());
    this.diagnostics = {
      visible: 0,
      zombieTriangles: triangleCount(this.zombieGeometries[0]!),
      wolfTriangles: triangleCount(this.wolfGeometry),
      zombieBones: ZOMBIE_BONE_NAMES.length,
      wolfBones: WOLF_BONE_NAMES.length,
      silhouettes: this.zombieGeometries.length,
    };
  }

  update(enemies: readonly EnemyVisualState[]): void {
    const visible = enemies.slice(0, CONFIG.zombie.maxAlive);
    const activeIds = new Set(visible.map((enemy) => enemy.id));
    for (const [id, rig] of this.assignments) {
      if (activeIds.has(id)) continue;
      rig.enemyId = -1;
      rig.group.visible = false;
      this.assignments.delete(id);
    }

    for (const enemy of visible) {
      const rigKind = enemy.kind === 'wolf' ? 'wolf' : 'zombie';
      let rig = this.assignments.get(enemy.id);
      if (rig !== undefined && rig.kind !== rigKind) {
        rig.enemyId = -1;
        rig.group.visible = false;
        this.assignments.delete(enemy.id);
        rig = undefined;
      }
      if (rig === undefined) {
        const pool = rigKind === 'wolf' ? this.wolfPool : this.zombiePool;
        rig = pool.find((candidate) => candidate.enemyId < 0);
        if (rig === undefined) continue;
        rig.enemyId = enemy.id;
        rig.lastHp = enemy.hp ?? enemy.maxHp ?? 1;
        rig.lastStateTimeMs = enemy.stateTimeMs;
        rig.staggerRemainingMs = 0;
        rig.group.visible = true;
        this.assignments.set(enemy.id, rig);
      }
      this.updateRig(rig, enemy);
    }
    this.updateEyes(visible);
    this.diagnostics.visible = this.assignments.size;
  }

  getDiagnostics(): EnemyRendererDiagnostics {
    return { ...this.diagnostics };
  }

  dispose(): void {
    for (const geometry of this.zombieGeometries) geometry.dispose();
    this.wolfGeometry.dispose();
    this.zombieEyeGeometry.dispose();
    this.wolfEyeGeometry.dispose();
    this.zombieEyeMaterial.dispose();
    this.wolfEyeMaterial.dispose();
    for (const rig of [...this.zombiePool, ...this.wolfPool]) {
      const materials = Array.isArray(rig.mesh.material) ? rig.mesh.material : [rig.mesh.material];
      for (const material of materials) material.dispose();
    }
  }

  private createZombie(index: number): RigVisual {
    const variant = index % this.zombieGeometries.length;
    const skeleton = buildZombieSkeleton();
    const material = makeDissolveMaterial(variant, false);
    const mesh = new THREE.SkinnedMesh(this.zombieGeometries[variant]!, material.material);
    mesh.name = `zombie-rig-${index}`;
    mesh.add(skeleton.root);
    mesh.bind(skeleton.skeleton);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const group = new THREE.Group();
    group.add(mesh);
    group.visible = false;
    this.group.add(group);
    return {
      enemyId: -1,
      kind: 'zombie',
      group,
      mesh,
      bones: skeleton.bones,
      rest: skeleton.rest,
      dissolve: material.dissolve,
      lastHp: 1,
      lastStateTimeMs: 0,
      staggerRemainingMs: 0,
    };
  }

  private createWolf(): RigVisual {
    const skeleton = buildWolfSkeleton();
    const material = makeDissolveMaterial(0, true);
    const mesh = new THREE.SkinnedMesh(this.wolfGeometry, material.material);
    mesh.name = 'wolf-rig';
    mesh.add(skeleton.root);
    mesh.bind(skeleton.skeleton);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.frustumCulled = false;
    const group = new THREE.Group();
    group.add(mesh);
    group.visible = false;
    this.group.add(group);
    return {
      enemyId: -1,
      kind: 'wolf',
      group,
      mesh,
      bones: skeleton.bones,
      rest: skeleton.rest,
      dissolve: material.dissolve,
      lastHp: 1,
      lastStateTimeMs: 0,
      staggerRemainingMs: 0,
    };
  }

  private updateRig(rig: RigVisual, enemy: EnemyVisualState): void {
    resetSkeleton(rig);
    const deltaMs = enemy.stateTimeMs >= rig.lastStateTimeMs
      ? Math.min(CONFIG.simulation.maxFrameDeltaMs, enemy.stateTimeMs - rig.lastStateTimeMs)
      : 1000 / CONFIG.simulation.hz;
    const hp = enemy.hp ?? rig.lastHp;
    if (hp < rig.lastHp && enemy.state !== 'dead') rig.staggerRemainingMs = CONFIG.rendering.characterVisual.staggerMs;
    rig.staggerRemainingMs = Math.max(0, rig.staggerRemainingMs - deltaMs);
    rig.lastHp = hp;
    rig.lastStateTimeMs = enemy.stateTimeMs;
    rig.group.position.set(enemy.x, enemy.y, enemy.z);
    rig.group.rotation.set(0, enemy.yaw, 0);
    rig.group.scale.set(1, 1, 1);
    rig.dissolve.value = 0;
    if (rig.kind === 'wolf') this.animateWolf(rig, enemy);
    else this.animateZombie(rig, enemy);
    rig.mesh.skeleton.update();
  }

  private updateEyes(enemies: readonly EnemyVisualState[]): void {
    const dummy = new THREE.Object3D();
    let zombieIndex = 0;
    let wolfIndex = 0;
    for (const enemy of enemies) {
      const spawnOffset = enemy.state === 'spawn' ? -(1 - enemy.spawnProgress) * CONFIG.rendering.zombieVisual.spawnDepthM : 0;
      const deathProgress = enemy.state === 'dead' ? Math.min(1, enemy.stateTimeMs / CONFIG.zombie.deathDissolveMs) : 0;
      const scale = Math.max(0.001, 1 - deathProgress);
      if (enemy.kind === 'wolf') {
        const faceOffset = 0.96;
        dummy.position.set(
          enemy.x - Math.sin(enemy.yaw) * faceOffset,
          enemy.y + 0.725 + spawnOffset - deathProgress * 0.28,
          enemy.z - Math.cos(enemy.yaw) * faceOffset,
        );
        dummy.rotation.set(0, enemy.yaw, (enemy.id % 2 === 0 ? 1 : -1) * deathProgress * CONFIG.rendering.wolfVisual.deathRollRad);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        this.wolfEyes.setMatrixAt(wolfIndex, dummy.matrix);
        wolfIndex += 1;
      } else {
        const crawlerScale = enemy.kind === 'crawler' ? CONFIG.rendering.zombieVisual.crawlerHeightScale : 1;
        const faceOffset = 0.205;
        dummy.position.set(
          enemy.x - Math.sin(enemy.yaw) * faceOffset,
          enemy.y + 1.765 * crawlerScale + spawnOffset - deathProgress * 0.34,
          enemy.z - Math.cos(enemy.yaw) * faceOffset,
        );
        dummy.rotation.set(0, enemy.yaw, (enemy.id % 2 === 0 ? 1 : -1) * deathProgress * CONFIG.rendering.zombieVisual.deathTiltRad);
        dummy.scale.setScalar(scale);
        dummy.updateMatrix();
        this.zombieEyes.setMatrixAt(zombieIndex, dummy.matrix);
        zombieIndex += 1;
      }
    }
    this.zombieEyes.count = zombieIndex;
    this.wolfEyes.count = wolfIndex;
    this.zombieEyes.instanceMatrix.needsUpdate = true;
    this.wolfEyes.instanceMatrix.needsUpdate = true;
  }

  private animateZombie(rig: RigVisual, enemy: EnemyVisualState): void {
    const bone = (name: string): THREE.Bone | undefined => rig.bones.get(name);
    const cycleHz = enemy.speedTier === 'sprint'
      ? CONFIG.rendering.zombieVisual.sprintCycleHz
      : enemy.speedTier === 'jog'
        ? CONFIG.rendering.zombieVisual.jogCycleHz
        : CONFIG.rendering.zombieVisual.walkCycleHz;
    const cycle = enemy.stateTimeMs / 1000 * cycleHz * Math.PI * 2 + enemy.id * 0.71;
    const locomotion = enemy.state === 'chase' ? 1 : 0;
    const speedScale = enemy.speedTier === 'sprint' ? 1 : enemy.speedTier === 'jog' ? 0.78 : 0.56;
    const swing = Math.sin(cycle) * CONFIG.rendering.zombieVisual.limbSwingRad * speedScale * locomotion;
    const lateral = Math.sin(cycle * 0.5) * 0.045 * locomotion;
    const pelvis = bone('pelvis');
    const chest = bone('chest');
    const spine = bone('spine');
    if (pelvis !== undefined) {
      pelvis.position.y += Math.abs(Math.sin(cycle)) * 0.035 * locomotion;
      pelvis.rotation.y = lateral;
    }
    if (spine !== undefined) spine.rotation.z = -lateral * 0.72;
    if (chest !== undefined) {
      chest.rotation.x = enemy.speedTier === 'sprint' && locomotion ? 0.16 : 0.035;
      chest.rotation.y = -lateral;
    }
    setRotationX(bone('leftUpperArm'), swing + 0.08);
    setRotationX(bone('rightUpperArm'), -swing + 0.08);
    setRotationX(bone('leftForeArm'), Math.max(0, -swing) * 0.34 - 0.08);
    setRotationX(bone('rightForeArm'), Math.max(0, swing) * 0.34 - 0.08);
    setRotationX(bone('leftThigh'), -swing);
    setRotationX(bone('rightThigh'), swing);
    setRotationX(bone('leftShin'), Math.max(0, swing) * 0.62);
    setRotationX(bone('rightShin'), Math.max(0, -swing) * 0.62);
    setRotationX(bone('leftFoot'), Math.max(0, -swing) * 0.28);
    setRotationX(bone('rightFoot'), Math.max(0, swing) * 0.28);

    if (enemy.state === 'spawn') {
      rig.group.position.y -= (1 - enemy.spawnProgress) * CONFIG.rendering.zombieVisual.spawnDepthM;
      const strain = Math.sin(enemy.spawnProgress * Math.PI);
      setRotationX(bone('chest'), -0.42 * strain);
      setRotationZ(bone('leftUpperArm'), -0.82 * strain);
      setRotationZ(bone('rightUpperArm'), 0.82 * strain);
      setRotationX(bone('leftForeArm'), -1.1 * strain);
      setRotationX(bone('rightForeArm'), -1.1 * strain);
    }
    if (enemy.state === 'tear') {
      const strike = Math.sin(enemy.stateTimeMs / CONFIG.zombie.boardTearMs * Math.PI * 2);
      setRotationX(bone('leftUpperArm'), -1.55 + strike * 0.46);
      setRotationX(bone('rightUpperArm'), -1.42 - strike * 0.38);
      setRotationX(bone('leftForeArm'), -0.62);
      setRotationX(bone('rightForeArm'), -0.72);
      if (chest !== undefined) chest.rotation.x = -0.16 + Math.abs(strike) * 0.12;
    }
    if (enemy.state === 'vault') {
      const progress = Math.min(1, enemy.stateTimeMs / CONFIG.zombie.windowVaultMs);
      rig.group.position.y += Math.sin(progress * Math.PI) * 0.84;
      if (pelvis !== undefined) pelvis.rotation.x = -0.42 * Math.sin(progress * Math.PI);
      setRotationX(bone('leftThigh'), 0.85 * Math.sin(progress * Math.PI));
      setRotationX(bone('rightThigh'), 1.15 * Math.sin(progress * Math.PI));
      setRotationX(bone('leftShin'), -1.24 * Math.sin(progress * Math.PI));
      setRotationX(bone('rightShin'), -0.92 * Math.sin(progress * Math.PI));
      setRotationX(bone('leftUpperArm'), -1.1);
      setRotationX(bone('rightUpperArm'), -1.1);
    }
    if (enemy.state === 'attack') this.animateZombieAttack(rig, enemy);
    if (enemy.kind === 'crawler') {
      rig.group.position.y += 0.08;
      if (pelvis !== undefined) pelvis.rotation.x = -1.18;
      if (chest !== undefined) chest.rotation.x = 0.24;
      for (const name of ['leftThigh', 'rightThigh', 'leftShin', 'rightShin', 'leftFoot', 'rightFoot']) {
        const leg = bone(name);
        if (leg !== undefined) leg.scale.set(0.72, 0.035, 0.72);
      }
      const crawl = Math.sin(cycle) * 0.72;
      setRotationX(bone('leftUpperArm'), -0.8 + crawl);
      setRotationX(bone('rightUpperArm'), -0.8 - crawl);
      setRotationZ(bone('leftUpperArm'), -0.38);
      setRotationZ(bone('rightUpperArm'), 0.38);
    }
    if (rig.staggerRemainingMs > 0) {
      const stagger = Math.sin(rig.staggerRemainingMs / CONFIG.rendering.characterVisual.staggerMs * Math.PI);
      if (chest !== undefined) chest.rotation.z += (enemy.id % 2 === 0 ? 1 : -1) * stagger * 0.28;
      const head = bone('head');
      if (head !== undefined) head.rotation.y = -stagger * 0.34;
    }
    if (enemy.state === 'dead') {
      const progress = Math.min(1, enemy.stateTimeMs / CONFIG.zombie.deathDissolveMs);
      const crumple = THREE.MathUtils.smoothstep(progress, 0, CONFIG.rendering.characterVisual.dissolveStart);
      rig.group.rotation.z += (enemy.id % 2 === 0 ? 1 : -1) * crumple * CONFIG.rendering.zombieVisual.deathTiltRad;
      rig.group.position.y -= crumple * 0.38;
      if (pelvis !== undefined) pelvis.rotation.x = crumple * 0.52;
      if (chest !== undefined) chest.rotation.x = -crumple * 0.68;
      setRotationX(bone('leftThigh'), crumple * 0.92);
      setRotationX(bone('rightThigh'), crumple * 0.42);
      setRotationX(bone('leftShin'), -crumple * 1.18);
      setRotationX(bone('rightShin'), -crumple * 0.78);
      rig.dissolve.value = THREE.MathUtils.smoothstep(progress, CONFIG.rendering.characterVisual.dissolveStart, 1);
    }
  }

  private animateZombieAttack(rig: RigVisual, enemy: EnemyVisualState): void {
    const progress = Math.min(1, enemy.stateTimeMs / CONFIG.zombie.attackWindupMs);
    const strike = Math.sin(progress * Math.PI);
    const variant = enemy.id % CONFIG.rendering.characterVisual.attackVariants;
    const leftUpper = rig.bones.get('leftUpperArm');
    const rightUpper = rig.bones.get('rightUpperArm');
    const leftFore = rig.bones.get('leftForeArm');
    const rightFore = rig.bones.get('rightForeArm');
    if (variant === 0) {
      setRotationX(leftUpper, -1.48 * strike);
      setRotationZ(leftUpper, -0.28 * strike);
      setRotationX(leftFore, -0.58 * strike);
    } else if (variant === 1) {
      setRotationX(rightUpper, -1.48 * strike);
      setRotationZ(rightUpper, 0.28 * strike);
      setRotationX(rightFore, -0.58 * strike);
    } else {
      setRotationX(leftUpper, -1.28 * strike);
      setRotationX(rightUpper, -1.28 * strike);
      setRotationZ(leftUpper, -0.19 * strike);
      setRotationZ(rightUpper, 0.19 * strike);
    }
    const chest = rig.bones.get('chest');
    if (chest !== undefined) chest.rotation.x = -0.24 * strike;
  }

  private animateWolf(rig: RigVisual, enemy: EnemyVisualState): void {
    const bone = (name: string): THREE.Bone | undefined => rig.bones.get(name);
    const visual = CONFIG.rendering.wolfVisual;
    const cycle = enemy.stateTimeMs / 1000 * visual.cycleHz * Math.PI * 2 + enemy.id * 0.61;
    const running = enemy.state === 'chase' ? 1 : 0;
    const stride = Math.sin(cycle) * visual.strideRad * running;
    const spine = bone('spine');
    const root = bone('root');
    if (root !== undefined) root.position.y += Math.abs(Math.sin(cycle)) * 0.07 * running;
    if (spine !== undefined) {
      spine.rotation.y = Math.sin(cycle * 0.5) * 0.08 * running;
      spine.rotation.x = Math.sin(cycle * 2) * 0.035 * running;
    }
    setRotationX(bone('frontLeftUpper'), stride);
    setRotationX(bone('frontRightUpper'), -stride);
    setRotationX(bone('rearLeftUpper'), -stride);
    setRotationX(bone('rearRightUpper'), stride);
    setRotationX(bone('frontLeftLower'), Math.max(0, -stride) * 0.86);
    setRotationX(bone('frontRightLower'), Math.max(0, stride) * 0.86);
    setRotationX(bone('rearLeftLower'), Math.max(0, stride) * 0.72);
    setRotationX(bone('rearRightLower'), Math.max(0, -stride) * 0.72);
    const tail = bone('tail');
    if (tail !== undefined) tail.rotation.y = Math.sin(cycle * 0.65) * 0.36;
    if (enemy.state === 'spawn') {
      rig.group.position.y -= (1 - enemy.spawnProgress) * CONFIG.rendering.zombieVisual.spawnDepthM;
      if (spine !== undefined) spine.rotation.x = -0.24 * Math.sin(enemy.spawnProgress * Math.PI);
    }
    if (enemy.state === 'attack') {
      const progress = Math.min(1, enemy.stateTimeMs / CONFIG.wolves.attackWindupMs);
      const lunge = Math.sin(progress * Math.PI);
      rig.group.translateZ(-lunge * 0.34);
      const neck = bone('neck');
      const jaw = bone('jaw');
      if (neck !== undefined) neck.rotation.x = -0.36 * lunge;
      if (jaw !== undefined) jaw.rotation.x = 0.68 * lunge;
      setRotationX(bone('frontLeftUpper'), -0.72 * lunge);
      setRotationX(bone('frontRightUpper'), -0.72 * lunge);
    }
    if (rig.staggerRemainingMs > 0 && spine !== undefined) {
      const stagger = Math.sin(rig.staggerRemainingMs / CONFIG.rendering.characterVisual.staggerMs * Math.PI);
      spine.rotation.z = (enemy.id % 2 === 0 ? 1 : -1) * stagger * 0.22;
    }
    if (enemy.state === 'dead') {
      const progress = Math.min(1, enemy.stateTimeMs / CONFIG.zombie.deathDissolveMs);
      const crumple = THREE.MathUtils.smoothstep(progress, 0, CONFIG.rendering.characterVisual.dissolveStart);
      rig.group.rotation.z += (enemy.id % 2 === 0 ? 1 : -1) * crumple * visual.deathRollRad;
      rig.group.position.y -= crumple * 0.31;
      if (spine !== undefined) spine.rotation.x = crumple * 0.31;
      rig.dissolve.value = THREE.MathUtils.smoothstep(progress, CONFIG.rendering.characterVisual.dissolveStart, 1);
    }
  }
}

function buildZombieSkeleton(): SkeletonBuild {
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
  add('jaw', 'head', [0, -0.06, -0.14]);
  add('leftShoulder', 'chest', [-0.28, 0.15, 0]);
  add('leftUpperArm', 'leftShoulder', [-0.07, -0.05, 0]);
  add('leftForeArm', 'leftUpperArm', [0, -0.36, 0]);
  add('leftHand', 'leftForeArm', [0, -0.32, 0]);
  add('rightShoulder', 'chest', [0.28, 0.15, 0]);
  add('rightUpperArm', 'rightShoulder', [0.07, -0.05, 0]);
  add('rightForeArm', 'rightUpperArm', [0, -0.36, 0]);
  add('rightHand', 'rightForeArm', [0, -0.32, 0]);
  add('leftThigh', 'pelvis', [-0.15, -0.04, 0]);
  add('leftShin', 'leftThigh', [0, -0.42, 0]);
  add('leftFoot', 'leftShin', [0, -0.37, -0.07]);
  add('rightThigh', 'pelvis', [0.15, -0.04, 0]);
  add('rightShin', 'rightThigh', [0, -0.42, 0]);
  add('rightFoot', 'rightShin', [0, -0.37, -0.07]);
  add('coatTail', 'pelvis', [0, 0.08, 0.05]);
  root.updateMatrixWorld(true);
  const ordered = ZOMBIE_BONE_NAMES.map((name) => bones.get(name)!);
  const skeleton = new THREE.Skeleton(ordered);
  const rest = captureRest(ordered);
  return { root, skeleton, bones, rest };
}

function buildWolfSkeleton(): SkeletonBuild {
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
  add('spine', 'root', [0, 0.58, 0.12]);
  add('neck', 'spine', [0, 0.04, -0.47]);
  add('head', 'neck', [0, 0.08, -0.27]);
  add('jaw', 'head', [0, -0.08, -0.18]);
  add('frontLeftUpper', 'spine', [-0.16, -0.02, -0.37]);
  add('frontLeftLower', 'frontLeftUpper', [0, -0.31, 0.02]);
  add('frontRightUpper', 'spine', [0.16, -0.02, -0.37]);
  add('frontRightLower', 'frontRightUpper', [0, -0.31, 0.02]);
  add('rearLeftUpper', 'spine', [-0.17, -0.04, 0.39]);
  add('rearLeftLower', 'rearLeftUpper', [0, -0.3, -0.02]);
  add('rearRightUpper', 'spine', [0.17, -0.04, 0.39]);
  add('rearRightLower', 'rearRightUpper', [0, -0.3, -0.02]);
  add('tail', 'spine', [0, 0.06, 0.5]);
  root.updateMatrixWorld(true);
  const ordered = WOLF_BONE_NAMES.map((name) => bones.get(name)!);
  const skeleton = new THREE.Skeleton(ordered);
  const rest = captureRest(ordered);
  return { root, skeleton, bones, rest };
}

function captureRest(bones: readonly THREE.Bone[]): Map<THREE.Bone, RestTransform> {
  return new Map(bones.map((bone) => [bone, {
    position: bone.position.clone(),
    quaternion: bone.quaternion.clone(),
    scale: bone.scale.clone(),
  }]));
}

function resetSkeleton(rig: RigVisual): void {
  for (const [bone, rest] of rig.rest) {
    bone.position.copy(rest.position);
    bone.quaternion.copy(rest.quaternion);
    bone.scale.copy(rest.scale);
  }
}

function buildZombieGeometry(variant: number): THREE.BufferGeometry {
  const skin = new THREE.Color(CONFIG.rendering.characterVisual.skinColors[variant % CONFIG.rendering.characterVisual.skinColors.length]!);
  const coat = new THREE.Color(CONFIG.rendering.characterVisual.coatColors[variant % CONFIG.rendering.characterVisual.coatColors.length]!);
  const trousers = new THREE.Color(CONFIG.rendering.characterVisual.trouserColors[variant % CONFIG.rendering.characterVisual.trouserColors.length]!);
  const leather = new THREE.Color(0x30271e);
  const darkSkin = skin.clone().multiplyScalar(0.48);
  const metal = new THREE.Color(0x414743);
  const parts: THREE.BufferGeometry[] = [];
  const add = (
    geometry: THREE.BufferGeometry,
    bone: number,
    color: THREE.Color,
    position: readonly [number, number, number],
    scale: readonly [number, number, number] = [1, 1, 1],
    rotation: readonly [number, number, number] = [0, 0, 0],
  ): void => {
    geometry.scale(scale[0], scale[1], scale[2]);
    geometry.rotateX(rotation[0]);
    geometry.rotateY(rotation[1]);
    geometry.rotateZ(rotation[2]);
    geometry.translate(position[0], position[1], position[2]);
    addRigidSkinning(geometry, bone, color);
    parts.push(geometry);
  };
  const capsule = (radius: number, length: number): THREE.CapsuleGeometry => new THREE.CapsuleGeometry(radius, length, 6, 16);
  add(capsule(0.255, 0.18), 1, trousers, [0, 0.9, 0]);
  add(capsule(0.25, 0.2), 2, coat, [0, 1.08, 0]);
  add(capsule(0.29, 0.35), 3, coat, [0, 1.32, 0], [1, 1, 0.8]);
  add(new THREE.CylinderGeometry(0.105, 0.12, 0.16, 16, 2), 4, darkSkin, [0, 1.56, 0]);
  add(new THREE.SphereGeometry(0.205, 22, 14), 5, skin, [0, 1.75, 0], [0.94, 1.1, 0.96]);
  add(new THREE.SphereGeometry(0.13, 18, 10), 6, darkSkin, [0, 1.66, -0.13], [0.88, 0.55, 0.82]);
  add(new THREE.SphereGeometry(0.043, 10, 7), 5, skin, [-0.205, 1.75, 0]);
  add(new THREE.SphereGeometry(0.043, 10, 7), 5, skin, [0.205, 1.75, 0]);
  add(capsule(0.092, 0.27), 8, coat, [-0.35, 1.24, 0], [1, 1.12, 1]);
  add(capsule(0.078, 0.25), 9, coat.clone().multiplyScalar(0.88), [-0.35, 0.91, 0]);
  add(new THREE.SphereGeometry(0.083, 16, 11), 10, darkSkin, [-0.35, 0.68, -0.01], [0.82, 1.25, 0.82]);
  add(capsule(0.092, 0.27), 12, coat, [0.35, 1.24, 0], [1, 1.12, 1]);
  add(capsule(0.078, 0.25), 13, coat.clone().multiplyScalar(0.88), [0.35, 0.91, 0]);
  add(new THREE.SphereGeometry(0.083, 16, 11), 14, darkSkin, [0.35, 0.68, -0.01], [0.82, 1.25, 0.82]);
  add(capsule(0.112, 0.31), 15, trousers, [-0.15, 0.61, 0]);
  add(capsule(0.096, 0.28), 16, trousers.clone().multiplyScalar(0.83), [-0.15, 0.23, 0]);
  add(new THREE.BoxGeometry(0.19, 0.13, 0.34, 3, 2, 4), 17, leather, [-0.15, 0.075, -0.1]);
  add(capsule(0.112, 0.31), 18, trousers, [0.15, 0.61, 0]);
  add(capsule(0.096, 0.28), 19, trousers.clone().multiplyScalar(0.83), [0.15, 0.23, 0]);
  add(new THREE.BoxGeometry(0.19, 0.13, 0.34, 3, 2, 4), 20, leather, [0.15, 0.075, -0.1]);
  add(new THREE.CylinderGeometry(0.33, 0.26, 0.52, 24, 5, true), 21, coat.clone().multiplyScalar(0.82), [0, 0.79, 0.05]);
  add(new THREE.TorusGeometry(0.255, 0.025, 8, 28), 1, leather, [0, 0.92, 0], [1, 0.8, 1], [Math.PI / 2, 0, 0]);
  add(new THREE.BoxGeometry(0.09, 0.16, 0.035, 2, 3, 1), 3, leather, [-0.15, 1.32, -0.255], [1, 1, 1], [0, 0, -0.16]);
  add(new THREE.BoxGeometry(0.09, 0.16, 0.035, 2, 3, 1), 3, leather, [0.15, 1.32, -0.255], [1, 1, 1], [0, 0, 0.16]);

  // Facial planes keep the shared head inexpensive while reading as a damaged,
  // original human face rather than a glowing-eyed mannequin.
  add(new THREE.SphereGeometry(0.06, 10, 7), 5, darkSkin, [-0.078, 1.79, -0.183], [1.1, 0.58, 0.28]);
  add(new THREE.SphereGeometry(0.06, 10, 7), 5, darkSkin, [0.078, 1.79, -0.183], [1.1, 0.58, 0.28]);
  add(new THREE.BoxGeometry(0.09, 0.025, 0.03, 2, 1, 1), 5, darkSkin, [-0.068, 1.825, -0.18], [1, 1, 1], [0, 0, -0.11]);
  add(new THREE.BoxGeometry(0.09, 0.025, 0.03, 2, 1, 1), 5, darkSkin, [0.068, 1.825, -0.18], [1, 1, 1], [0, 0, 0.11]);
  add(new THREE.ConeGeometry(0.038, 0.11, 8), 5, skin.clone().multiplyScalar(0.78), [0, 1.75, -0.205], [1, 1, 0.82], [-Math.PI / 2, 0, 0]);
  add(new THREE.SphereGeometry(0.055, 10, 7), 5, skin.clone().multiplyScalar(0.78), [-0.108, 1.72, -0.17], [1.2, 0.7, 0.38]);
  add(new THREE.SphereGeometry(0.055, 10, 7), 5, skin.clone().multiplyScalar(0.78), [0.108, 1.72, -0.17], [1.2, 0.7, 0.38]);
  add(new THREE.BoxGeometry(0.13, 0.018, 0.018, 3, 1, 1), 6, darkSkin, [0, 1.655, -0.205], [1, 1, 1], [0, 0, variant % 2 === 0 ? -0.05 : 0.07]);
  for (const x of [-0.045, -0.015, 0.015, 0.045]) {
    add(new THREE.BoxGeometry(0.018, 0.025, 0.012), 6, new THREE.Color(0xb6ad93), [x, 1.665, -0.216]);
  }

  // Layered uniform construction: collar, lapels, webbing, pockets, fasteners,
  // cuffs, knee patches and boot soles all deform with their owning bones.
  const coatDark = coat.clone().multiplyScalar(0.62);
  add(new THREE.BoxGeometry(0.14, 0.085, 0.035, 3, 2, 1), 3, coatDark, [-0.085, 1.51, -0.24], [1, 1, 1], [0, 0, -0.34]);
  add(new THREE.BoxGeometry(0.14, 0.085, 0.035, 3, 2, 1), 3, coatDark, [0.085, 1.51, -0.24], [1, 1, 1], [0, 0, 0.34]);
  add(new THREE.BoxGeometry(0.105, 0.34, 0.028, 2, 4, 1), 3, coatDark, [-0.075, 1.38, -0.272], [1, 1, 1], [0, 0, -0.24]);
  add(new THREE.BoxGeometry(0.105, 0.34, 0.028, 2, 4, 1), 3, coatDark, [0.075, 1.38, -0.272], [1, 1, 1], [0, 0, 0.24]);
  add(new THREE.BoxGeometry(0.055, 0.58, 0.035, 2, 5, 1), 3, leather, [0.035, 1.34, -0.292], [1, 1, 1], [0, 0, -0.46]);
  for (const x of [-0.15, 0.15]) {
    add(new THREE.BoxGeometry(0.14, 0.12, 0.045, 3, 2, 1), 3, coatDark, [x, 1.18, -0.275]);
    add(new THREE.BoxGeometry(0.16, 0.05, 0.035, 2, 1, 1), 3, leather, [x, 1.24, -0.302]);
  }
  for (const y of [1.18, 1.29, 1.4, 1.51]) {
    add(new THREE.SphereGeometry(0.018, 7, 5), 3, metal, [0, y, -0.298]);
  }
  add(new THREE.BoxGeometry(0.115, 0.09, 0.045, 2, 2, 1), 1, metal, [0, 0.91, -0.278]);
  for (const x of [-0.35, 0.35]) {
    add(new THREE.CylinderGeometry(0.088, 0.088, 0.06, 12), x < 0 ? 9 : 13, leather, [x, 0.76, 0]);
  }
  for (const x of [-0.15, 0.15]) {
    add(new THREE.BoxGeometry(0.17, 0.15, 0.035, 3, 3, 1), x < 0 ? 16 : 19, coatDark, [x, 0.31, -0.105]);
    add(new THREE.BoxGeometry(0.205, 0.045, 0.37, 3, 1, 4), x < 0 ? 17 : 20, leather.clone().multiplyScalar(0.72), [x, 0.025, -0.115]);
  }
  for (const side of [-1, 1]) {
    const handBone = side < 0 ? 10 : 14;
    for (let finger = 0; finger < 3; finger += 1) {
      add(
        new THREE.ConeGeometry(0.012, 0.075, 6),
        handBone,
        darkSkin,
        [side * (0.33 + finger * 0.018), 0.59, -0.025 - finger * 0.018],
        [1, 1, 1],
        [Math.PI, 0, side * 0.08],
      );
    }
  }

  if (variant === 0) {
    add(new THREE.SphereGeometry(0.225, 24, 12, 0, Math.PI * 2, 0, Math.PI * 0.54), 5, metal, [0, 1.79, 0], [1.08, 0.72, 1.08]);
    add(new THREE.CylinderGeometry(0.245, 0.245, 0.025, 24), 5, metal, [0, 1.77, -0.035]);
  } else if (variant === 1) {
    add(new THREE.CylinderGeometry(0.215, 0.225, 0.18, 22, 3), 5, coat.clone().multiplyScalar(0.72), [0, 1.88, 0.02], [1, 0.72, 1]);
    add(new THREE.BoxGeometry(0.27, 0.035, 0.17, 4, 1, 3), 5, coat, [-0.08, 1.82, -0.16], [1, 1, 1], [0, 0.14, 0]);
  } else if (variant === 2) {
    add(new THREE.BoxGeometry(0.25, 0.28, 0.08, 4, 5, 2), 3, leather, [-0.28, 1.36, 0.08], [1, 1, 1], [0.08, 0, -0.12]);
    add(new THREE.BoxGeometry(0.12, 0.2, 0.09, 3, 4, 2), 1, leather, [0.24, 0.93, -0.18]);
  } else {
    add(new THREE.CylinderGeometry(0.21, 0.17, 0.22, 20, 3), 5, trousers, [0, 1.88, 0.02], [1, 0.75, 1]);
    add(new THREE.BoxGeometry(0.18, 0.12, 0.06, 3, 2, 2), 3, metal, [0, 1.43, -0.26]);
  }
  // Layered facial wounds and torn cloth break the shared silhouette without realistic gore.
  add(new THREE.SphereGeometry(0.066, 14, 8), 5, darkSkin.clone().multiplyScalar(0.42), [variant % 2 === 0 ? -0.13 : 0.13, 1.77, -0.16], [1.25, 0.68, 0.32]);
  add(new THREE.BoxGeometry(0.14, 0.19, 0.025, 3, 4, 1), 3, coat.clone().multiplyScalar(0.42), [variant % 2 === 0 ? 0.2 : -0.2, 1.26, -0.272], [1, 1, 1], [0, 0, variant % 2 === 0 ? 0.18 : -0.18]);

  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (merged === null) throw new Error('Unable to merge zombie rig geometry.');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function buildWolfGeometry(): THREE.BufferGeometry {
  const coat = new THREE.Color(CONFIG.rendering.wolfVisual.bodyColor);
  const dark = new THREE.Color(CONFIG.rendering.wolfVisual.headColor);
  const teeth = new THREE.Color(0xc8c0a6);
  const parts: THREE.BufferGeometry[] = [];
  const add = (
    geometry: THREE.BufferGeometry,
    bone: number,
    color: THREE.Color,
    position: readonly [number, number, number],
    scale: readonly [number, number, number] = [1, 1, 1],
    rotation: readonly [number, number, number] = [0, 0, 0],
  ): void => {
    geometry.scale(scale[0], scale[1], scale[2]);
    geometry.rotateX(rotation[0]);
    geometry.rotateY(rotation[1]);
    geometry.rotateZ(rotation[2]);
    geometry.translate(position[0], position[1], position[2]);
    addRigidSkinning(geometry, bone, color);
    parts.push(geometry);
  };
  add(new THREE.CapsuleGeometry(0.31, 0.74, 10, 22), 1, coat, [0, 0.58, 0.1], [1, 1, 0.94], [Math.PI / 2, 0, 0]);
  add(new THREE.CapsuleGeometry(0.23, 0.25, 8, 20), 2, dark, [0, 0.65, -0.46], [1, 1, 0.85], [Math.PI / 2, 0, 0]);
  add(new THREE.SphereGeometry(0.25, 24, 16), 3, dark, [0, 0.68, -0.72], [0.82, 0.88, 1.12]);
  add(new THREE.CapsuleGeometry(0.115, 0.23, 7, 18), 4, dark.clone().multiplyScalar(0.78), [0, 0.56, -0.91], [1, 0.75, 1], [Math.PI / 2, 0, 0]);
  for (const side of [-1, 1]) {
    add(new THREE.ConeGeometry(0.105, 0.3, 14, 4), 3, dark, [side * 0.135, 0.91, -0.7], [1, 1, 0.5], [0.08, 0, side * -0.16]);
  }
  const legs = [
    { x: -0.17, z: -0.29, upper: 5, lower: 6 },
    { x: 0.17, z: -0.29, upper: 7, lower: 8 },
    { x: -0.18, z: 0.48, upper: 9, lower: 10 },
    { x: 0.18, z: 0.48, upper: 11, lower: 12 },
  ];
  for (const leg of legs) {
    add(new THREE.CapsuleGeometry(0.074, 0.21, 6, 16), leg.upper, coat, [leg.x, 0.37, leg.z]);
    add(new THREE.CapsuleGeometry(0.058, 0.2, 6, 16), leg.lower, dark, [leg.x, 0.13, leg.z]);
    add(new THREE.SphereGeometry(0.075, 14, 9), leg.lower, dark, [leg.x, 0.045, leg.z - 0.055], [1.1, 0.54, 1.45]);
  }
  add(new THREE.CapsuleGeometry(0.07, 0.5, 7, 18), 13, dark, [0, 0.67, 0.78], [1, 1, 0.86], [Math.PI / 2.7, 0, 0]);
  for (const side of [-1, 1]) {
    add(new THREE.ConeGeometry(0.018, 0.11, 8), 4, teeth, [side * 0.055, 0.51, -1.04], [1, 1, 1], [Math.PI, 0, 0]);
  }
  const merged = mergeGeometries(parts, false);
  for (const part of parts) part.dispose();
  if (merged === null) throw new Error('Unable to merge wolf rig geometry.');
  merged.computeBoundingBox();
  merged.computeBoundingSphere();
  return merged;
}

function addRigidSkinning(geometry: THREE.BufferGeometry, boneIndex: number, color: THREE.Color): void {
  const count = geometry.getAttribute('position').count;
  const skinIndices = new Uint16Array(count * 4);
  const skinWeights = new Float32Array(count * 4);
  const colors = new Float32Array(count * 3);
  for (let index = 0; index < count; index += 1) {
    skinIndices[index * 4] = boneIndex;
    skinWeights[index * 4] = 1;
    const shade = 0.91 + pseudo(index * 13 + boneIndex * 97) * 0.16;
    colors[index * 3] = color.r * shade;
    colors[index * 3 + 1] = color.g * shade;
    colors[index * 3 + 2] = color.b * shade;
  }
  geometry.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(skinIndices, 4));
  geometry.setAttribute('skinWeight', new THREE.Float32BufferAttribute(skinWeights, 4));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
}

function makeDissolveMaterial(variant: number, wolf: boolean): { material: THREE.MeshStandardMaterial; dissolve: { value: number } } {
  const dissolve = { value: 0 };
  const material = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    vertexColors: true,
    emissive: wolf ? CONFIG.rendering.wolfVisual.bodyColor : 0x131613,
    emissiveIntensity: wolf ? 0.14 : 0.16,
    roughness: wolf ? 0.91 : 0.87,
    metalness: wolf ? 0.01 : 0.03,
  });
  material.name = wolf ? 'wolf-rig-material' : `zombie-rig-material-${variant}`;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uDissolve = dissolve;
    shader.vertexShader = `varying vec3 vDissolvePosition;\n${shader.vertexShader}`.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\nvDissolvePosition = position;',
    );
    shader.fragmentShader = `uniform float uDissolve;\nvarying vec3 vDissolvePosition;\n${shader.fragmentShader}`.replace(
      '#include <dithering_fragment>',
      `
        float dissolveNoise = fract(sin(dot(floor(vDissolvePosition * 37.0).xy, vec2(12.9898, 78.233))) * 43758.5453);
        if (uDissolve > 0.0 && dissolveNoise < uDissolve) discard;
        #include <dithering_fragment>
      `,
    );
  };
  material.customProgramCacheKey = () => 'stahlbunker-rig-dissolve-v1';
  return { material, dissolve };
}

function pairedEyes(radius: number, spacing: number): THREE.BufferGeometry {
  const left = new THREE.SphereGeometry(radius, 10, 7);
  const right = left.clone();
  left.translate(-spacing, 0, 0);
  right.translate(spacing, 0, 0);
  const merged = mergeGeometries([left, right], false);
  left.dispose();
  right.dispose();
  if (merged === null) throw new Error('Unable to merge eye geometry.');
  return merged;
}

function setRotationX(bone: THREE.Bone | undefined, value: number): void {
  if (bone !== undefined) bone.rotation.x = value;
}

function setRotationZ(bone: THREE.Bone | undefined, value: number): void {
  if (bone !== undefined) bone.rotation.z = value;
}

function triangleCount(geometry: THREE.BufferGeometry): number {
  return geometry.index === null ? geometry.getAttribute('position').count / 3 : geometry.index.count / 3;
}

function pseudo(value: number): number {
  const random = Math.sin(value * 12.9898 + 78.233) * 43758.5453;
  return random - Math.floor(random);
}
