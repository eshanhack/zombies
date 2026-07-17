import * as THREE from 'three';
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
}

export class EnemyRenderer {
  readonly group = new THREE.Group();
  private readonly torso: THREE.InstancedMesh;
  private readonly head: THREE.InstancedMesh;
  private readonly leftArm: THREE.InstancedMesh;
  private readonly rightArm: THREE.InstancedMesh;
  private readonly leftLeg: THREE.InstancedMesh;
  private readonly rightLeg: THREE.InstancedMesh;
  private readonly wolfBody: THREE.InstancedMesh;
  private readonly wolfHead: THREE.InstancedMesh;
  private readonly wolfFrontLeft: THREE.InstancedMesh;
  private readonly wolfFrontRight: THREE.InstancedMesh;
  private readonly wolfRearLeft: THREE.InstancedMesh;
  private readonly wolfRearRight: THREE.InstancedMesh;
  private readonly wolfEyes: THREE.InstancedMesh;
  private readonly dummy = new THREE.Object3D();

  constructor() {
    this.group.name = 'procedural-enemy-instancing';
    const uniform = { count: CONFIG.zombie.maxAlive, usage: THREE.DynamicDrawUsage };
    const coat = new THREE.MeshStandardMaterial({ color: 0x36403a, roughness: 0.92, metalness: 0.01 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x272d29, roughness: 0.96 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x676659, roughness: 0.9 });
    this.torso = createInstances(new THREE.BoxGeometry(0.48, 0.7, 0.26), coat, uniform.count, uniform.usage);
    this.head = createInstances(new THREE.IcosahedronGeometry(0.2, 1), skin, uniform.count, uniform.usage);
    this.leftArm = createInstances(new THREE.BoxGeometry(0.13, 0.64, 0.13), coat, uniform.count, uniform.usage);
    this.rightArm = createInstances(new THREE.BoxGeometry(0.13, 0.64, 0.13), coat, uniform.count, uniform.usage);
    this.leftLeg = createInstances(new THREE.BoxGeometry(0.16, 0.72, 0.18), cloth, uniform.count, uniform.usage);
    this.rightLeg = createInstances(new THREE.BoxGeometry(0.16, 0.72, 0.18), cloth, uniform.count, uniform.usage);
    const wolf = CONFIG.rendering.wolfVisual;
    const wolfCoat = new THREE.MeshStandardMaterial({ color: wolf.bodyColor, roughness: 0.96, metalness: 0.01 });
    const wolfHeadMaterial = new THREE.MeshStandardMaterial({ color: wolf.headColor, roughness: 0.92 });
    const wolfEyeMaterial = new THREE.MeshStandardMaterial({
      color: wolf.eyeColor,
      emissive: wolf.eyeColor,
      emissiveIntensity: 4,
      roughness: 0.3,
    });
    this.wolfBody = createInstances(
      new THREE.BoxGeometry(wolf.bodyWidthM, wolf.bodyHeightM, wolf.bodyLengthM),
      wolfCoat,
      uniform.count,
      uniform.usage,
    );
    this.wolfHead = createInstances(new THREE.IcosahedronGeometry(wolf.headRadiusM, 1), wolfHeadMaterial, uniform.count, uniform.usage);
    const legGeometry = new THREE.BoxGeometry(wolf.legWidthM, wolf.legLengthM, wolf.legWidthM);
    this.wolfFrontLeft = createInstances(legGeometry, wolfCoat, uniform.count, uniform.usage);
    this.wolfFrontRight = createInstances(legGeometry, wolfCoat, uniform.count, uniform.usage);
    this.wolfRearLeft = createInstances(legGeometry, wolfCoat, uniform.count, uniform.usage);
    this.wolfRearRight = createInstances(legGeometry, wolfCoat, uniform.count, uniform.usage);
    this.wolfEyes = createInstances(new THREE.SphereGeometry(0.045, 6, 4), wolfEyeMaterial, uniform.count, uniform.usage);
    this.group.add(
      this.torso,
      this.head,
      this.leftArm,
      this.rightArm,
      this.leftLeg,
      this.rightLeg,
      this.wolfBody,
      this.wolfHead,
      this.wolfFrontLeft,
      this.wolfFrontRight,
      this.wolfRearLeft,
      this.wolfRearRight,
      this.wolfEyes,
    );
  }

  update(enemies: readonly EnemyVisualState[]): void {
    const visible = enemies.slice(0, CONFIG.zombie.maxAlive);
    const zombies = visible.filter((enemy) => enemy.kind !== 'wolf');
    const wolves = visible.filter((enemy) => enemy.kind === 'wolf');
    for (let index = 0; index < zombies.length; index += 1) {
      const enemy = zombies[index]!;
      const cycleHz = enemy.speedTier === 'sprint'
        ? CONFIG.rendering.zombieVisual.sprintCycleHz
        : enemy.speedTier === 'jog'
          ? CONFIG.rendering.zombieVisual.jogCycleHz
          : CONFIG.rendering.zombieVisual.walkCycleHz;
      const cycle = enemy.stateTimeMs / 1000 * cycleHz * Math.PI * 2 + enemy.id * 0.71;
      const moving = enemy.state === 'chase';
      const swing = moving ? Math.sin(cycle) * CONFIG.rendering.zombieVisual.limbSwingRad : 0;
      const spawnOffset = enemy.state === 'spawn' ? -(1 - enemy.spawnProgress) * CONFIG.rendering.zombieVisual.spawnDepthM : 0;
      const deathProgress = enemy.state === 'dead' ? Math.min(1, enemy.stateTimeMs / CONFIG.zombie.deathDissolveMs) : 0;
      const crawlerScale = enemy.kind === 'crawler' ? CONFIG.rendering.zombieVisual.crawlerHeightScale : 1;
      const baseY = enemy.y + spawnOffset;
      const deathTilt = deathProgress * CONFIG.rendering.zombieVisual.deathTiltRad;
      const dissolveScale = Math.max(0.001, 1 - deathProgress * 0.75);

      this.setPart(this.torso, index, enemy.x, baseY + 1.03 * crawlerScale, enemy.z, 0, enemy.yaw, deathTilt, 1, crawlerScale, dissolveScale);
      this.setPart(this.head, index, enemy.x, baseY + 1.52 * crawlerScale, enemy.z, 0, enemy.yaw, deathTilt, dissolveScale, dissolveScale, dissolveScale);
      const attackSwing = enemy.state === 'attack' ? -1.15 * Math.sin(Math.min(1, enemy.stateTimeMs / CONFIG.zombie.attackWindupMs) * Math.PI) : 0;
      this.setPart(this.leftArm, index, enemy.x - 0.32, baseY + 1.03 * crawlerScale, enemy.z, swing + attackSwing, enemy.yaw, deathTilt, 1, crawlerScale, dissolveScale);
      this.setPart(this.rightArm, index, enemy.x + 0.32, baseY + 1.03 * crawlerScale, enemy.z, -swing + attackSwing, enemy.yaw, deathTilt, 1, crawlerScale, dissolveScale);
      const legScaleY = enemy.kind === 'crawler' ? 0.02 : crawlerScale;
      this.setPart(this.leftLeg, index, enemy.x - 0.14, baseY + 0.37 * crawlerScale, enemy.z, -swing, enemy.yaw, deathTilt, 1, legScaleY, dissolveScale);
      this.setPart(this.rightLeg, index, enemy.x + 0.14, baseY + 0.37 * crawlerScale, enemy.z, swing, enemy.yaw, deathTilt, 1, legScaleY, dissolveScale);
    }
    for (const mesh of this.zombieMeshes) {
      mesh.count = zombies.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
    this.updateWolves(wolves);
  }

  dispose(): void {
    for (const mesh of this.meshes) {
      mesh.geometry.dispose();
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) material.dispose();
    }
  }

  private get zombieMeshes(): readonly THREE.InstancedMesh[] {
    return [this.torso, this.head, this.leftArm, this.rightArm, this.leftLeg, this.rightLeg];
  }

  private get wolfMeshes(): readonly THREE.InstancedMesh[] {
    return [this.wolfBody, this.wolfHead, this.wolfFrontLeft, this.wolfFrontRight, this.wolfRearLeft, this.wolfRearRight, this.wolfEyes];
  }

  private get meshes(): readonly THREE.InstancedMesh[] {
    return [...this.zombieMeshes, ...this.wolfMeshes];
  }

  private updateWolves(wolves: readonly EnemyVisualState[]): void {
    const visual = CONFIG.rendering.wolfVisual;
    for (let index = 0; index < wolves.length; index += 1) {
      const wolf = wolves[index]!;
      const cycle = wolf.stateTimeMs / 1000 * visual.cycleHz * Math.PI * 2 + wolf.id * 0.61;
      const stride = wolf.state === 'chase' ? Math.sin(cycle) * visual.strideRad : 0;
      const spawnOffset = wolf.state === 'spawn' ? -(1 - wolf.spawnProgress) * CONFIG.rendering.zombieVisual.spawnDepthM : 0;
      const deathProgress = wolf.state === 'dead' ? Math.min(1, wolf.stateTimeMs / CONFIG.zombie.deathDissolveMs) : 0;
      const deathRoll = deathProgress * visual.deathRollRad;
      const scale = Math.max(0.001, 1 - deathProgress * 0.78);
      const attackLunge = wolf.state === 'attack'
        ? Math.sin(Math.min(1, wolf.stateTimeMs / CONFIG.wolves.attackWindupMs) * Math.PI) * 0.34
        : 0;
      this.setWolfPart(this.wolfBody, index, wolf, 0, spawnOffset + visual.shoulderHeightM, attackLunge, 0, deathRoll, scale, scale, scale);
      this.setWolfPart(this.wolfHead, index, wolf, 0, spawnOffset + visual.shoulderHeightM + 0.12, -visual.bodyLengthM * 0.55 + attackLunge, -0.12, deathRoll, scale, scale, scale);
      const side = visual.bodyWidthM * 0.42;
      const front = -visual.bodyLengthM * 0.34 + attackLunge;
      const rear = visual.bodyLengthM * 0.34;
      const legY = visual.legLengthM * 0.47;
      this.setWolfPart(this.wolfFrontLeft, index, wolf, -side, spawnOffset + legY, front, stride, deathRoll, scale, scale, scale);
      this.setWolfPart(this.wolfFrontRight, index, wolf, side, spawnOffset + legY, front, -stride, deathRoll, scale, scale, scale);
      this.setWolfPart(this.wolfRearLeft, index, wolf, -side, spawnOffset + legY, rear, -stride, deathRoll, scale, scale, scale);
      this.setWolfPart(this.wolfRearRight, index, wolf, side, spawnOffset + legY, rear, stride, deathRoll, scale, scale, scale);
      this.setWolfPart(this.wolfEyes, index, wolf, 0, spawnOffset + visual.shoulderHeightM + 0.17, -visual.bodyLengthM * 0.75 + attackLunge, 0, deathRoll, 1.65 * scale, 0.72 * scale, 0.72 * scale);
    }
    for (const mesh of this.wolfMeshes) {
      mesh.count = wolves.length;
      mesh.instanceMatrix.needsUpdate = true;
    }
  }

  private setWolfPart(
    mesh: THREE.InstancedMesh,
    index: number,
    wolf: EnemyVisualState,
    localX: number,
    localY: number,
    localZ: number,
    rotationX: number,
    rotationZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ): void {
    const sin = Math.sin(wolf.yaw);
    const cos = Math.cos(wolf.yaw);
    const x = wolf.x + localX * cos + localZ * sin;
    const z = wolf.z - localX * sin + localZ * cos;
    this.setPart(mesh, index, x, wolf.y + localY, z, rotationX, wolf.yaw, rotationZ, scaleX, scaleY, scaleZ);
  }

  private setPart(
    mesh: THREE.InstancedMesh,
    index: number,
    x: number,
    y: number,
    z: number,
    rotationX: number,
    rotationY: number,
    rotationZ: number,
    scaleX: number,
    scaleY: number,
    scaleZ: number,
  ): void {
    this.dummy.position.set(x, y, z);
    this.dummy.rotation.set(rotationX, rotationY, rotationZ, 'YXZ');
    this.dummy.scale.set(scaleX, scaleY, scaleZ);
    this.dummy.updateMatrix();
    mesh.setMatrixAt(index, this.dummy.matrix);
  }
}

function createInstances(geometry: THREE.BufferGeometry, material: THREE.Material, count: number, usage: THREE.Usage): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(geometry, material, count);
  mesh.count = 0;
  mesh.instanceMatrix.setUsage(usage);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.frustumCulled = false;
  return mesh;
}
