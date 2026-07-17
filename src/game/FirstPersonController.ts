import * as THREE from 'three';
import { CONFIG } from '../config.js';
import type { CollisionWorld, KinematicState, MovementInput } from '../shared/movement.js';
import { sanitizeMovementInput, simulatePlayerMovement } from '../shared/movement.js';

export interface AuthoritativePlayerState extends KinematicState {
  yaw: number;
  pitch: number;
  lastProcessedInput: number;
}

export interface ControllerOptions {
  canvas: HTMLCanvasElement;
  collisionWorld: CollisionWorld;
  startPosition: { x: number; y: number; z: number };
  networked: boolean;
  sendInput?: (input: MovementInput) => void;
}

export interface ControllerReadout extends KinematicState {
  yaw: number;
  pitch: number;
  ads: boolean;
  sprinting: boolean;
  noclip: boolean;
  locked: boolean;
}

interface PredictedStep {
  sequence: number;
  input: MovementInput;
}

const FIXED_DELTA_SECONDS = 1 / CONFIG.simulation.hz;

export class FirstPersonController {
  private readonly canvas: HTMLCanvasElement;
  private readonly collisionWorld: CollisionWorld;
  private readonly networked: boolean;
  private readonly sendInput?: (input: MovementInput) => void;
  private readonly pressed = new Set<string>();
  private readonly predictedSteps: PredictedStep[] = [];
  private state: KinematicState;
  private yaw = 0;
  private pitch = 0;
  private ads = false;
  private sprinting = false;
  private noclip = false;
  private sequence = 0;
  private fixedTick = 0;
  private disposed = false;

  constructor(options: ControllerOptions) {
    this.canvas = options.canvas;
    this.collisionWorld = options.collisionWorld;
    this.networked = options.networked;
    this.sendInput = options.sendInput;
    this.state = {
      ...options.startPosition,
      vx: 0,
      vy: 0,
      vz: 0,
      staminaMs: CONFIG.player.sprintMaxMs,
      grounded: true,
    };
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mouseup', this.onMouseUp);
    window.addEventListener('contextmenu', this.onContextMenu);
    this.canvas.addEventListener('click', this.requestPointerLock);
  }

  requestLock(): void {
    this.requestPointerLock();
  }

  fixedUpdate(): void {
    const input = this.buildInput();
    const result = simulatePlayerMovement(this.state, input, FIXED_DELTA_SECONDS, this.collisionWorld, this.noclip);
    this.sprinting = result.sprinting;
    this.fixedTick += 1;
    if (this.networked) {
      this.predictedSteps.push({ sequence: input.sequence, input });
      if (this.predictedSteps.length > CONFIG.controller.maxPredictionHistory) this.predictedSteps.shift();
      if (this.fixedTick % (CONFIG.simulation.hz / CONFIG.coop.inputHz) === 0) this.sendInput?.(input);
    }
  }

  reconcile(authoritative: AuthoritativePlayerState): void {
    if (!this.networked || this.noclip) return;
    const predicted: KinematicState = {
      x: authoritative.x,
      y: authoritative.y,
      z: authoritative.z,
      vx: authoritative.vx,
      vy: authoritative.vy,
      vz: authoritative.vz,
      staminaMs: authoritative.staminaMs,
      grounded: authoritative.grounded,
    };
    const unacknowledged = this.predictedSteps.filter((step) => step.sequence > authoritative.lastProcessedInput);
    this.predictedSteps.splice(0, this.predictedSteps.length, ...unacknowledged);
    for (const step of unacknowledged) simulatePlayerMovement(predicted, step.input, FIXED_DELTA_SECONDS, this.collisionWorld);

    const distance = Math.hypot(predicted.x - this.state.x, predicted.y - this.state.y, predicted.z - this.state.z);
    if (distance >= CONFIG.controller.reconcileSnapDistanceM) {
      this.state = predicted;
    } else if (distance >= CONFIG.controller.reconcileSoftDistanceM) {
      this.state.x = THREE.MathUtils.lerp(this.state.x, predicted.x, CONFIG.controller.reconcileBlend);
      this.state.y = THREE.MathUtils.lerp(this.state.y, predicted.y, CONFIG.controller.reconcileBlend);
      this.state.z = THREE.MathUtils.lerp(this.state.z, predicted.z, CONFIG.controller.reconcileBlend);
      this.state.vx = predicted.vx;
      this.state.vy = predicted.vy;
      this.state.vz = predicted.vz;
      this.state.staminaMs = predicted.staminaMs;
      this.state.grounded = predicted.grounded;
    }
  }

  setNoclip(enabled: boolean): boolean {
    if (this.networked) return false;
    this.noclip = enabled;
    if (enabled) this.state.vy = 0;
    return true;
  }

  toggleNoclip(): boolean {
    return this.setNoclip(!this.noclip);
  }

  getReadout(): ControllerReadout {
    return {
      ...this.state,
      yaw: this.yaw,
      pitch: this.pitch,
      ads: this.ads,
      sprinting: this.sprinting,
      noclip: this.noclip,
      locked: document.pointerLockElement === this.canvas,
    };
  }

  applyCamera(camera: THREE.PerspectiveCamera): void {
    camera.position.set(this.state.x, this.state.y + CONFIG.controller.eyeHeightM, this.state.z);
    camera.rotation.order = 'YXZ';
    camera.rotation.set(this.pitch, this.yaw, 0);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mouseup', this.onMouseUp);
    window.removeEventListener('contextmenu', this.onContextMenu);
    this.canvas.removeEventListener('click', this.requestPointerLock);
  }

  private buildInput(): MovementInput {
    if (this.fixedTick % (CONFIG.simulation.hz / CONFIG.coop.inputHz) === 0) this.sequence += 1;
    return sanitizeMovementInput({
      sequence: this.sequence,
      forward: Number(this.pressed.has('KeyW')) - Number(this.pressed.has('KeyS')),
      right: Number(this.pressed.has('KeyD')) - Number(this.pressed.has('KeyA')),
      yaw: this.yaw,
      pitch: this.pitch,
      sprint: this.pressed.has('ShiftLeft') || this.pressed.has('ShiftRight'),
      ads: this.ads,
      ascend: this.pressed.has('Space'),
      descend: this.pressed.has('ControlLeft') || this.pressed.has('ControlRight'),
    });
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    this.pressed.add(event.code);
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (document.pointerLockElement !== this.canvas) return;
    this.yaw -= event.movementX * CONFIG.controller.mouseSensitivity;
    this.pitch = THREE.MathUtils.clamp(
      this.pitch - event.movementY * CONFIG.controller.mouseSensitivity,
      -CONFIG.controller.pitchLimitRad,
      CONFIG.controller.pitchLimitRad,
    );
  };

  private readonly onMouseDown = (event: MouseEvent): void => {
    if (event.button === 2) this.ads = true;
  };

  private readonly onMouseUp = (event: MouseEvent): void => {
    if (event.button === 2) this.ads = false;
  };

  private readonly onContextMenu = (event: MouseEvent): void => {
    if (document.pointerLockElement === this.canvas) event.preventDefault();
  };

  private readonly requestPointerLock = (): void => {
    if (document.pointerLockElement === this.canvas) return;
    try {
      void this.canvas.requestPointerLock().catch(() => undefined);
    } catch {
      // Embedded verification browsers may reject pointer lock; the click prompt remains available.
    }
  };
}
