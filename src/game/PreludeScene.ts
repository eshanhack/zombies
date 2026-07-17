import * as THREE from 'three';
import { CONFIG } from '../config';
import { SeededRng } from '../shared/rng';

export interface SceneMetrics {
  fps: number;
  drawCalls: number;
}

export class PreludeScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly timer = new THREE.Timer();
  private readonly fogParticles: THREE.Points;
  private readonly lamp: THREE.PointLight;
  private frameHandle = 0;
  private elapsedSample = 0;
  private sampledFrames = 0;
  private metrics: SceneMetrics = { fps: CONFIG.rendering.targetFps, drawCalls: 0 };

  constructor(seed: number) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    this.canvas.setAttribute('aria-hidden', 'true');

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.rendering.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.82;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(CONFIG.player.fovDeg, window.innerWidth / window.innerHeight, 0.1, 120);
    this.camera.position.set(0, 2.15, 9.5);

    this.scene.background = new THREE.Color(CONFIG.rendering.clearColor);
    this.scene.fog = new THREE.FogExp2(CONFIG.rendering.fogColor, 0.047);
    this.buildBunker(seed);
    this.fogParticles = this.buildFog(seed);
    this.lamp = this.scene.getObjectByName('menuLamp') as THREE.PointLight;
    this.scene.add(this.fogParticles);
    this.timer.connect(document);

    window.addEventListener('resize', this.onResize);
  }

  start(): void {
    if (this.frameHandle !== 0) return;
    this.timer.reset();
    this.frameHandle = requestAnimationFrame(this.render);
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    window.removeEventListener('resize', this.onResize);
    this.timer.dispose();
    this.renderer.dispose();
  }

  getMetrics(): SceneMetrics {
    return { ...this.metrics };
  }

  private buildBunker(seed: number): void {
    const rng = new SeededRng(seed);
    const concrete = new THREE.MeshStandardMaterial({ color: 0x292d2c, roughness: 0.93, metalness: 0.03 });
    const concreteDark = new THREE.MeshStandardMaterial({ color: 0x151918, roughness: 0.98 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x262b29, roughness: 0.57, metalness: 0.72 });
    const wood = new THREE.MeshStandardMaterial({ color: 0x493827, roughness: 0.86 });

    const floor = new THREE.Mesh(new THREE.PlaneGeometry(30, 32), concreteDark);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    const rear = new THREE.Mesh(new THREE.BoxGeometry(16, 5.5, 0.6), concrete);
    rear.position.set(0, 2.7, -3.8);
    rear.castShadow = true;
    rear.receiveShadow = true;
    this.scene.add(rear);

    const sideLeft = new THREE.Mesh(new THREE.BoxGeometry(0.6, 5.5, 15), concrete);
    sideLeft.position.set(-7.7, 2.7, 2.8);
    sideLeft.castShadow = true;
    sideLeft.receiveShadow = true;
    this.scene.add(sideLeft);

    const sideRight = sideLeft.clone();
    sideRight.position.x = 7.7;
    this.scene.add(sideRight);

    const ceiling = new THREE.Mesh(new THREE.BoxGeometry(16, 0.45, 15), concreteDark);
    ceiling.position.set(0, 5.45, 2.8);
    ceiling.receiveShadow = true;
    this.scene.add(ceiling);

    const doorway = new THREE.Mesh(new THREE.BoxGeometry(3.8, 3.8, 0.85), steel);
    doorway.position.set(0, 1.9, -3.35);
    this.scene.add(doorway);
    const voidPanel = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 3.1), new THREE.MeshBasicMaterial({ color: 0x020303 }));
    voidPanel.position.set(0, 1.55, -2.9);
    this.scene.add(voidPanel);

    for (let index = 0; index < 6; index += 1) {
      const board = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.18, 0.12), wood);
      board.position.set(rng.next() * 0.25 - 0.125, 0.55 + index * 0.45, -2.82);
      board.rotation.z = (rng.next() - 0.5) * 0.16;
      board.castShadow = true;
      this.scene.add(board);
    }

    for (let index = 0; index < 14; index += 1) {
      const chunk = new THREE.Mesh(
        new THREE.DodecahedronGeometry(0.18 + rng.next() * 0.33, 0),
        index % 3 === 0 ? steel : concreteDark,
      );
      chunk.scale.y = 0.35 + rng.next() * 0.55;
      chunk.position.set((rng.next() - 0.5) * 7.5, chunk.scale.y * 0.25, 1.5 + rng.next() * 5.8);
      chunk.rotation.set(rng.next() * 3, rng.next() * 3, rng.next() * 3);
      chunk.castShadow = true;
      this.scene.add(chunk);
    }

    const moon = new THREE.DirectionalLight(0x88a8ba, 1.8);
    moon.position.set(-8, 11, 7);
    moon.castShadow = true;
    moon.shadow.mapSize.set(CONFIG.rendering.shadowMapSize, CONFIG.rendering.shadowMapSize);
    this.scene.add(moon);

    const lamp = new THREE.PointLight(0xffb45d, 17, 11, 2);
    lamp.name = 'menuLamp';
    lamp.position.set(1.5, 4.4, 0.5);
    lamp.castShadow = true;
    lamp.shadow.mapSize.set(512, 512);
    this.scene.add(lamp);

    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd39a }));
    bulb.position.copy(lamp.position);
    this.scene.add(bulb);

    this.scene.add(new THREE.HemisphereLight(0x344b57, 0x090a08, 0.55));
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

  private readonly render = (timestamp: number): void => {
    this.timer.update(timestamp);
    const delta = Math.min(this.timer.getDelta(), CONFIG.simulation.maxFrameDeltaMs / 1000);
    const elapsed = this.timer.getElapsed();
    this.camera.position.x = Math.sin(elapsed * 0.075) * 1.15;
    this.camera.position.y = 2.12 + Math.sin(elapsed * 0.12) * 0.08;
    this.camera.lookAt(Math.sin(elapsed * 0.05) * 0.7, 1.7, -2.3);
    this.fogParticles.rotation.y += delta * 0.008;
    this.fogParticles.position.x = Math.sin(elapsed * 0.035) * 0.4;
    const flicker = Math.sin(elapsed * 31) > 0.965 ? 0.42 : 1;
    this.lamp.intensity = 17 * flicker * (0.96 + Math.sin(elapsed * 7.1) * 0.04);

    this.renderer.render(this.scene, this.camera);
    this.elapsedSample += delta;
    this.sampledFrames += 1;
    if (this.elapsedSample >= 0.5) {
      this.metrics = {
        fps: Math.round(this.sampledFrames / this.elapsedSample),
        drawCalls: this.renderer.info.render.calls,
      };
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
}
