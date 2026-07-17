import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { START_POSITIONS } from '../map/blueprint.js';
import { SeededRng } from '../shared/rng.js';
import type { MovementInput } from '../shared/movement.js';
import { BunkerMap } from './BunkerMap.js';
import { FirstPersonController, type AuthoritativePlayerState, type ControllerReadout } from './FirstPersonController.js';

export interface SceneMetrics {
  fps: number;
  drawCalls: number;
}

export interface RemotePlayerPose {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  connected: boolean;
  isSelf: boolean;
}

export interface GameplayOptions {
  mode: 'solo' | 'coop';
  sendInput?: (input: MovementInput) => void;
}

interface RemoteVisual {
  group: THREE.Group;
  targetPosition: THREE.Vector3;
  targetYaw: number;
}

export class PreludeScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly timer = new THREE.Timer();
  private readonly menuRoot = new THREE.Group();
  private readonly remoteRoot = new THREE.Group();
  private readonly remotePlayers = new Map<string, RemoteVisual>();
  private fogParticles: THREE.Points | null = null;
  private lamp: THREE.PointLight | null = null;
  private bunkerMap: BunkerMap | null = null;
  private controller: FirstPersonController | null = null;
  private viewmodel: THREE.Group | null = null;
  private mode: 'menu' | 'gameplay' = 'menu';
  private gameMode: 'solo' | 'coop' = 'solo';
  private frameHandle = 0;
  private fixedAccumulator = 0;
  private elapsedSample = 0;
  private sampledFrames = 0;
  private gameplayElapsed = 0;
  private metrics: SceneMetrics = { fps: CONFIG.rendering.targetFps, drawCalls: 0 };

  constructor(seed: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    this.canvas.setAttribute('aria-label', 'Stahlbunker first-person viewport');

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.rendering.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.player.fovDeg,
      window.innerWidth / window.innerHeight,
      CONFIG.rendering.cameraNearM,
      CONFIG.rendering.cameraFarM,
    );
    this.scene.background = new THREE.Color(CONFIG.rendering.clearColor);
    this.scene.fog = new THREE.FogExp2(CONFIG.rendering.fogColor, 0.047);
    this.buildMenu(seed);
    this.timer.connect(document);
    window.addEventListener('resize', this.onResize);
  }

  start(): void {
    if (this.frameHandle !== 0) return;
    this.timer.reset();
    this.frameHandle = requestAnimationFrame(this.render);
  }

  enterGameplay(options: GameplayOptions): void {
    if (this.mode === 'gameplay') return;
    this.mode = 'gameplay';
    this.gameMode = options.mode;
    this.disposeObject(this.menuRoot);
    this.scene.clear();
    this.fogParticles = null;
    this.lamp = null;
    this.bunkerMap = new BunkerMap();
    this.scene.add(this.bunkerMap.group);
    this.scene.add(this.remoteRoot);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x080b0b);
    this.scene.fog = new THREE.Fog(CONFIG.rendering.fogColor, CONFIG.rendering.fogNearM, CONFIG.rendering.fogFarM);
    this.camera.fov = CONFIG.player.fovDeg;
    this.camera.near = CONFIG.rendering.cameraNearM;
    this.camera.far = CONFIG.rendering.cameraFarM;
    this.camera.updateProjectionMatrix();
    this.controller = new FirstPersonController({
      canvas: this.canvas,
      collisionWorld: this.bunkerMap.collisionWorld,
      startPosition: options.mode === 'solo' ? CONFIG.map.startPosition : (START_POSITIONS[0] ?? CONFIG.map.startPosition),
      networked: options.mode === 'coop',
      sendInput: options.sendInput,
    });
    this.viewmodel = this.buildViewmodel();
    this.camera.add(this.viewmodel);
    this.gameplayElapsed = 0;
    this.fixedAccumulator = 0;
    this.controller.requestLock();
  }

  reconcileLocalPlayer(state: AuthoritativePlayerState): void {
    this.controller?.reconcile(state);
  }

  updateRemotePlayers(poses: readonly RemotePlayerPose[]): void {
    const activeIds = new Set<string>();
    for (const pose of poses) {
      if (pose.isSelf || !pose.connected) continue;
      activeIds.add(pose.id);
      let visual = this.remotePlayers.get(pose.id);
      if (visual === undefined) {
        visual = this.createRemoteVisual();
        visual.group.position.set(pose.x, pose.y, pose.z);
        this.remoteRoot.add(visual.group);
        this.remotePlayers.set(pose.id, visual);
      }
      visual.targetPosition.set(pose.x, pose.y, pose.z);
      visual.targetYaw = pose.yaw;
    }
    for (const [id, visual] of this.remotePlayers) {
      if (activeIds.has(id)) continue;
      this.remoteRoot.remove(visual.group);
      this.disposeObject(visual.group);
      this.remotePlayers.delete(id);
    }
  }

  command(name: string): boolean {
    if (name === 'noclip') return this.controller?.toggleNoclip() ?? false;
    if (name === 'nav') return this.bunkerMap?.toggleNavDebug() ?? false;
    if (name === 'doors' && this.gameMode === 'solo') {
      this.bunkerMap?.setAllDoorsOpen(true);
      return true;
    }
    return false;
  }

  getControllerReadout(): ControllerReadout | null {
    return this.controller?.getReadout() ?? null;
  }

  isGameplay(): boolean {
    return this.mode === 'gameplay';
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    window.removeEventListener('resize', this.onResize);
    this.controller?.dispose();
    this.bunkerMap?.dispose();
    this.timer.dispose();
    this.renderer.dispose();
  }

  getMetrics(): SceneMetrics {
    return { ...this.metrics };
  }

  private buildMenu(seed: number): void {
    this.menuRoot.name = 'menu-prelude';
    const rng = new SeededRng(seed);
    const concrete = new THREE.MeshStandardMaterial({ color: 0x292d2c, roughness: 0.93, metalness: 0.03 });
    const concreteDark = new THREE.MeshStandardMaterial({ color: 0x151918, roughness: 0.98 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x262b29, roughness: 0.57, metalness: 0.72 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x493827, roughness: 0.86 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 32), concreteDark);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.menuRoot.add(floor);
    const rear = new THREE.Mesh(new THREE.BoxGeometry(16, 5.5, 0.6), concrete);
    rear.position.set(0, 2.7, -3.8);
    rear.castShadow = true;
    rear.receiveShadow = true;
    this.menuRoot.add(rear);
    const sideLeft = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5.5, 15), concrete);
    sideLeft.position.set(-7.7, 2.7, 2.8);
    sideLeft.castShadow = true;
    sideLeft.receiveShadow = true;
    this.menuRoot.add(sideLeft);
    const sideRight = sideLeft.clone();
    sideRight.position.x = 7.7;
    this.menuRoot.add(sideRight);
    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(16, 0.45, 15), concreteDark);
    ceiling.position.set(0, 5.45, 2.8);
    this.menuRoot.add(ceiling);
    const doorway = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.8, 0.85), steel);
    doorway.position.set(0, 1.9, -3.35);
    this.menuRoot.add(doorway);
    const voidPanel = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 3.1), new THREE.MeshBasicMaterial({ color: 0x020303 }));
    voidPanel.position.set(0, 1.55, -2.9);
    this.menuRoot.add(voidPanel);
    for (let index = 0; index < 6; index += 1) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.18, 0.12), wood);
      board.position.set(rng.next() * 0.25 - 0.125, 0.55 + index * 0.45, -2.82);
      board.rotation.z = (rng.next() - 0.5) * 0.16;
      board.castShadow = true;
      this.menuRoot.add(board);
    }
    for (let index = 0; index < 14; index += 1) {
      const chunk = new THREE.Mesh(new THREE.DodecahedronGeometry(0.18 + rng.next() * 0.33, 0), index % 3 === 0 ? steel : concreteDark);
      chunk.scale.y = 0.35 + rng.next() * 0.55;
      chunk.position.set((rng.next() - 0.5) * 7.5, chunk.scale.y * 0.25, 1.5 + rng.next() * 5.8);
      chunk.rotation.set(rng.next() * 3, rng.next() * 3, rng.next() * 3);
      chunk.castShadow = true;
      this.menuRoot.add(chunk);
    }
    const moon = new THREE.DirectionalLight(0x88a8ba, 1.8);
    moon.position.set(-8, 11, 7);
    moon.castShadow = true;
    moon.shadow.mapSize.set(CONFIG.rendering.shadowMapSize, CONFIG.rendering.shadowMapSize);
    this.menuRoot.add(moon);
    this.lamp = new THREE.PointLight(0xffb45d, 17, 11, 2);
    this.lamp.position.set(1.5, 4.4, 0.5);
    this.lamp.castShadow = true;
    this.menuRoot.add(this.lamp);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd39a }));
    bulb.position.copy(this.lamp.position);
    this.menuRoot.add(bulb);
    this.menuRoot.add(new THREE.HemisphereLight(0x344b57, 0x090a08, 0.55));
    this.fogParticles = this.buildFog(seed);
    this.menuRoot.add(this.fogParticles);
    this.camera.position.set(0, 2.15, 9.5);
    this.scene.add(this.menuRoot);
  }

  private buildFog(seed: number): THREE.Points {
    const rng = new SeededRng(seed ^ 0xa341316c);
    const count = 420;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const offset = index * 3;
      positions[offset] = (rng.next() - 0.5) * 20;
      positions[offset + 1] = rng.next() * 5;
      positions[offset + 2] = (rng.next() - 0.5) * 22;
      const shade = 0.25 + rng.next() * 0.22;
      colors[offset] = shade * 0.55;
      colors[offset + 1] = shade * 0.8;
      colors[offset + 2] = shade;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    return new THREE.Points(geometry, new THREE.PointsMaterial({ size: 0.045, transparent: true, opacity: 0.4, vertexColors: true, depthWrite: false }));
  }

  private buildViewmodel(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'melder-viewmodel-foundation';
    const metal = new THREE.MeshStandardMaterial({ color: 0x242827, roughness: 0.46, metalness: 0.74 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x111413, roughness: 0.58, metalness: 0.66 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x4a3728, roughness: 0.82 });
    const slide = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.1, 0.47), metal);
    slide.position.z = -0.09;
    group.add(slide);
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.03, 0.32, 12), darkMetal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.005, -0.34);
    group.add(barrel);
    const handle = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.24, 0.13), grip);
    handle.position.set(0, -0.14, 0.08);
    handle.rotation.x = -0.2;
    group.add(handle);
    const sight = new THREE.Mesh(new THREE.BoxGeometry(0.018, 0.035, 0.035), darkMetal);
    sight.position.set(0, 0.067, -0.25);
    group.add(sight);
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = false;
        object.renderOrder = 10;
      }
    });
    const hip = CONFIG.rendering.viewmodel.hip;
    group.position.set(hip[0], hip[1], hip[2]);
    return group;
  }

  private createRemoteVisual(): RemoteVisual {
    const group = new THREE.Group();
    const coat = new THREE.MeshStandardMaterial({ color: 0x3c4640, roughness: 0.9 });
    const skin = new THREE.MeshStandardMaterial({ color: 0x766858, roughness: 0.86 });
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.31, 0.9, 4, 8), coat);
    body.position.y = 0.82;
    body.castShadow = true;
    group.add(body);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.19, 10, 8), skin);
    head.position.y = 1.56;
    head.castShadow = true;
    group.add(head);
    return { group, targetPosition: new THREE.Vector3(), targetYaw: 0 };
  }

  private updateGameplay(delta: number): void {
    const controller = this.controller;
    if (controller === null) return;
    this.fixedAccumulator += delta;
    const fixedDelta = 1 / CONFIG.simulation.hz;
    let subSteps = 0;
    while (this.fixedAccumulator >= fixedDelta && subSteps < CONFIG.simulation.maxSubSteps) {
      controller.fixedUpdate();
      this.fixedAccumulator -= fixedDelta;
      subSteps += 1;
    }
    controller.applyCamera(this.camera);
    this.gameplayElapsed += delta;
    this.updateViewmodel(controller.getReadout(), delta);
    const interpolationAlpha = Math.min(1, delta / (CONFIG.coop.interpolationMs / 1000));
    for (const visual of this.remotePlayers.values()) {
      visual.group.position.lerp(visual.targetPosition, interpolationAlpha);
      visual.group.rotation.y = lerpAngle(visual.group.rotation.y, visual.targetYaw, interpolationAlpha);
    }
  }

  private updateViewmodel(readout: ControllerReadout, delta: number): void {
    const viewmodel = this.viewmodel;
    if (viewmodel === null) return;
    const speed = Math.hypot(readout.vx, readout.vz);
    const moveRatio = Math.min(1, speed / (CONFIG.player.walkSpeed * CONFIG.player.sprintMultiplier));
    const bob = Math.sin(this.gameplayElapsed * CONFIG.controller.bobFrequency) * CONFIG.controller.bobAmountM * moveRatio;
    const target = readout.ads
      ? CONFIG.rendering.viewmodel.ads
      : readout.sprinting
        ? CONFIG.rendering.viewmodel.sprint
        : CONFIG.rendering.viewmodel.hip;
    const positionAlpha = 1 - Math.exp(-CONFIG.rendering.viewmodel.positionLerpPerSecond * delta);
    viewmodel.position.x = THREE.MathUtils.lerp(viewmodel.position.x, target[0], positionAlpha);
    viewmodel.position.y = THREE.MathUtils.lerp(viewmodel.position.y, target[1] + bob, positionAlpha);
    viewmodel.position.z = THREE.MathUtils.lerp(viewmodel.position.z, target[2], positionAlpha);
    const targetRoll = readout.sprinting ? CONFIG.rendering.viewmodel.sprintRollRad : Math.sin(this.gameplayElapsed * CONFIG.controller.bobFrequency * 0.5) * 0.018 * moveRatio;
    const rotationAlpha = 1 - Math.exp(-CONFIG.rendering.viewmodel.rotationLerpPerSecond * delta);
    viewmodel.rotation.z = THREE.MathUtils.lerp(viewmodel.rotation.z, targetRoll, rotationAlpha);
  }

  private readonly render = (timestamp: number): void => {
    this.timer.update(timestamp);
    const delta = Math.min(this.timer.getDelta(), CONFIG.simulation.maxFrameDeltaMs / 1000);
    const elapsed = this.timer.getElapsed();
    if (this.mode === 'menu') {
      this.camera.position.x = Math.sin(elapsed * 0.075) * 1.15;
      this.camera.position.y = 2.12 + Math.sin(elapsed * 0.12) * 0.08;
      this.camera.lookAt(Math.sin(elapsed * 0.05) * 0.7, 1.7, -2.3);
      if (this.fogParticles !== null) {
        this.fogParticles.rotation.y += delta * 0.008;
        this.fogParticles.position.x = Math.sin(elapsed * 0.035) * 0.4;
      }
      if (this.lamp !== null) {
        const flicker = Math.sin(elapsed * 31) > 0.965 ? 0.42 : 1;
        this.lamp.intensity = 17 * flicker * (0.96 + Math.sin(elapsed * 7.1) * 0.04);
      }
    } else {
      this.updateGameplay(delta);
    }
    this.renderer.render(this.scene, this.camera);
    this.elapsedSample += delta;
    this.sampledFrames += 1;
    if (this.elapsedSample >= 0.5) {
      this.metrics = { fps: Math.round(this.sampledFrames / this.elapsedSample), drawCalls: this.renderer.info.render.calls };
      this.elapsedSample = 0;
      this.sampledFrames = 0;
    }
    this.frameHandle = requestAnimationFrame(this.render);
  };

  private readonly onResize = (): void => {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.rendering.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
  };

  private disposeObject(root: THREE.Object3D): void {
    root.traverse((object) => {
      if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points) && !(object instanceof THREE.LineSegments)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      for (const material of materials) material.dispose();
    });
  }
}

function lerpAngle(from: number, to: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * alpha;
}
