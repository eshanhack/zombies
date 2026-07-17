import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { CONFIG, type PerkId, type PowerupId, type WeaponId } from '../config.js';
import { AudioSystem, type AudioDiagnostics, type AudioEnemyEmitter, type AudioPoint } from '../audio/AudioSystem.js';
import { CRATE_LOCATIONS, DOORS, FOG_BANKS, FORGE, PERK_MACHINES, POWER_SWITCH, START_POSITIONS, WALL_BUYS, WINDOWS, roomAt } from '../map/blueprint.js';
import { SeededRng } from '../shared/rng.js';
import type { MovementInput } from '../shared/movement.js';
import { GameSimulation, type SimCrateState, type SimGrenade, type SimPlayer } from '../shared/GameSimulation.js';
import { activeWeapon, type CombatPlayerState, type FireResult, type RuntimeWeaponState, weaponMagazineCapacity } from '../shared/combat.js';
import { BunkerMap } from './BunkerMap.js';
import { EnemyRenderer, type EnemyRendererDiagnostics, type EnemyVisualState } from './EnemyRenderer.js';
import { FirstPersonController, type AuthoritativePlayerState, type ControllerReadout } from './FirstPersonController.js';
import { ProductionPost } from './ProductionPost.js';
import { RemoteOperative } from './RemoteOperative.js';
import { applyTiledUvs, MaterialLibrary } from './MaterialLibrary.js';
import type { ClientAction, NetworkFeedback, NetworkGameView } from '../network/CoopClient.js';

export interface SceneMetrics {
  fps: number;
  drawCalls: number;
  triangles: number;
  medianFrameMs: number;
  p95FrameMs: number;
}

export interface CharacterDiagnostics extends EnemyRendererDiagnostics {
  remoteVisible: number;
}

export interface RemotePlayerPose {
  id: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  vx: number;
  vz: number;
  connected: boolean;
  downed: boolean;
  spectating: boolean;
  isSelf: boolean;
}

export interface GameplayOptions {
  mode: 'solo' | 'coop';
  seed: number;
  sendInput?: (input: MovementInput) => void;
  sendAction?: (action: ClientAction) => void;
}

export interface SceneSimulationReadout {
  round: number;
  elapsedMs: number;
  spawned: number;
  queued: number;
  alive: number;
  phase: 'playing' | 'intermission' | 'downed' | 'spectating' | 'gameOver';
  roundKind: 'zombies' | 'wolves';
  nextWolfRound: number;
  wolfAppearance: number;
  powerOn: boolean;
  powerActivationElapsedMs: number;
  gameOver: boolean;
  instaKillRemainingMs: number;
  doublePointsRemainingMs: number;
  nukeRemainingMs: number;
  hp: number;
  maxHp: number;
  points: number;
  weapons: readonly RuntimeWeaponState[];
  activeWeaponIndex: number;
  reloading: boolean;
  reloadRemainingMs: number;
  stats: { shots: number; hits: number; kills: number; headshots: number; pointsEarned: number; doorsOpened: number; crateRolls: number };
  grenades: number;
  perks: readonly PerkId[];
  pendingPerk: PerkId | '';
  actionLockRemainingMs: number;
  selfRevivesRemaining: number;
  bleedoutRemainingMs: number;
  selfReviveRemainingMs: number;
  downed: boolean;
  dead: boolean;
  spectating: boolean;
  reconnectPending: boolean;
  thrownGrenades: readonly Pick<SimGrenade, 'id' | 'ownerId' | 'x' | 'y' | 'z' | 'fuseRemainingMs'>[];
  openDoors: readonly string[];
  crate: Readonly<SimCrateState>;
  forge: { phase: 'idle' | 'upgrading'; playerId: string; weaponId: WeaponId | ''; remainingMs: number };
  localPlayerId: string;
  barriers: readonly { id: string; room: string; boards: number; repairProgressMs: number }[];
  enemies: readonly SceneEnemyReadout[];
  powerups: readonly { id: number; powerupType: PowerupId; x: number; y: number; z: number; remainingMs: number; guaranteed: boolean }[];
  players: readonly { id: string; x: number; y: number; z: number; connected: boolean; downed: boolean; spectating: boolean; perks: readonly PerkId[] }[];
}

export interface SceneEnemyReadout extends EnemyVisualState {
  hp: number;
  maxHp: number;
  speed: number;
  barrierId: string;
  targetPlayerId: string;
}

export type HudEvent =
  | { id: number; type: 'points'; amount: number; reason: string }
  | { id: number; type: 'hit'; headshot: boolean; killed: boolean }
  | { id: number; type: 'damage'; amount: number; directionDeg: number }
  | { id: number; type: 'shot' };

type HudEventInput =
  | { type: 'points'; amount: number; reason: string }
  | { type: 'hit'; headshot: boolean; killed: boolean }
  | { type: 'damage'; amount: number; directionDeg: number }
  | { type: 'shot' };

interface RemoteVisual {
  group: THREE.Group;
  rig: RemoteOperative;
  targetPosition: THREE.Vector3;
  targetYaw: number;
  targetPitch: number;
  targetSpeedMps: number;
  targetDowned: boolean;
}

interface TransientWonderEffect {
  group: THREE.Group;
  materials: (THREE.LineBasicMaterial | THREE.MeshBasicMaterial | THREE.PointsMaterial)[];
  durationMs: number;
  remainingMs: number;
  expands: boolean;
}

export class PreludeScene {
  readonly canvas: HTMLCanvasElement;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera: THREE.PerspectiveCamera;
  private readonly post: ProductionPost;
  private readonly viewmodelFill = new THREE.PointLight(
    CONFIG.rendering.viewmodel.fillColor,
    CONFIG.rendering.viewmodel.fillIntensity,
    CONFIG.rendering.viewmodel.fillDistanceM,
    2,
  );
  private readonly timer = new THREE.Timer();
  private readonly menuRoot = new THREE.Group();
  private readonly remoteRoot = new THREE.Group();
  private readonly remotePlayers = new Map<string, RemoteVisual>();
  private readonly audio = new AudioSystem();
  private cosmeticRng: SeededRng;
  private fogParticles: THREE.Points | null = null;
  private lamp: THREE.PointLight | null = null;
  private menuMaterials: MaterialLibrary | null = null;
  private bunkerMap: BunkerMap | null = null;
  private enemyRenderer: EnemyRenderer | null = null;
  private galleryInspectionLight: THREE.PointLight | null = null;
  private controller: FirstPersonController | null = null;
  private simulation: GameSimulation | null = null;
  private soloPlayer: SimPlayer | null = null;
  private networkSimulation: NetworkGameView | null = null;
  private sendAction: GameplayOptions['sendAction'];
  private viewmodel: THREE.Group | null = null;
  private muzzleLight: THREE.PointLight | null = null;
  private viewmodelWeaponId: WeaponId = 'melder';
  private viewmodelUpgraded = false;
  private readonly wonderEffects: TransientWonderEffect[] = [];
  private mode: 'menu' | 'gameplay' = 'menu';
  private gameMode: 'solo' | 'coop' = 'solo';
  private frameHandle = 0;
  private fixedAccumulator = 0;
  private elapsedSample = 0;
  private sampledFrames = 0;
  private gameplayElapsed = 0;
  private meleeAnimationRemainingMs = 0;
  private reloadAnimationRemainingMs = 0;
  private shotAnimationRemainingMs = 0;
  private drawAnimationRemainingMs = 0;
  private viewmodelRecoilM = 0;
  private muzzleRemainingMs = 0;
  private nextCosmeticFireAtMs = 0;
  private fireHeld = false;
  private grenadeCookStartedAtMs = -1;
  private hudEventSequence = 0;
  private debugWeaponIndex = 0;
  private debugPerkIndex = 0;
  private debugPowerupIndex = 0;
  private debugWonderIndex = 0;
  private debugTourIndex = 0;
  private readonly hudEvents: HudEvent[] = [];
  private godMode = false;
  private visualGate = false;
  private fieldOfView: number = CONFIG.player.fovDeg;
  private sensitivityMultiplier: number = 1;
  private metrics: SceneMetrics = {
    fps: CONFIG.rendering.targetFps,
    drawCalls: 0,
    triangles: 0,
    medianFrameMs: 1000 / CONFIG.rendering.targetFps,
    p95FrameMs: 1000 / CONFIG.rendering.targetFps,
  };
  private readonly frameSamplesMs: number[] = [];

  constructor(seed: number) {
    this.cosmeticRng = new SeededRng(seed ^ 0x5f356495);
    this.audio.setSeed(seed);
    this.audio.setMode('menu');
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'game-canvas';
    this.canvas.setAttribute('aria-label', 'Stahlbunker first-person viewport');

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, CONFIG.rendering.maxPixelRatio));
    this.renderer.setSize(window.innerWidth, window.innerHeight, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = CONFIG.rendering.toneMappingExposure;
    this.renderer.info.autoReset = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;

    this.camera = new THREE.PerspectiveCamera(
      CONFIG.player.fovDeg,
      window.innerWidth / window.innerHeight,
      CONFIG.rendering.cameraNearM,
      CONFIG.rendering.cameraFarM,
    );
    this.viewmodelFill.position.set(0.2, -0.05, -0.45);
    this.camera.add(this.viewmodelFill);
    this.post = new ProductionPost(this.renderer, this.scene, this.camera);
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
    this.menuMaterials?.dispose();
    this.menuMaterials = null;
    this.scene.clear();
    this.galleryInspectionLight = null;
    this.fogParticles = null;
    this.lamp = null;
    this.bunkerMap = new BunkerMap();
    this.scene.add(this.bunkerMap.group);
    this.enemyRenderer = new EnemyRenderer();
    this.scene.add(this.enemyRenderer.group);
    this.scene.add(this.remoteRoot);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x080b0b);
    this.scene.fog = new THREE.Fog(CONFIG.rendering.fogColor, CONFIG.rendering.fogNearM, CONFIG.rendering.fogFarM);
    this.camera.fov = this.fieldOfView;
    this.camera.near = CONFIG.rendering.cameraNearM;
    this.camera.far = CONFIG.rendering.cameraFarM;
    this.camera.updateProjectionMatrix();
    this.sendAction = options.sendAction;
    this.cosmeticRng = new SeededRng(options.seed ^ 0x5f356495);
    this.audio.setSeed(options.seed);
    this.audio.setMode('gameplay');
    this.audio.resume();
    if (options.mode === 'solo') {
      this.simulation = new GameSimulation({ seed: options.seed, mode: 'solo', rosterSize: 1 });
      this.soloPlayer = {
        id: 'local',
        x: CONFIG.map.startPosition.x,
        y: CONFIG.map.startPosition.y,
        z: CONFIG.map.startPosition.z,
        yaw: 0,
        pitch: 0,
        hp: CONFIG.player.maxHp,
        maxHp: CONFIG.player.maxHp,
        points: CONFIG.points.starting,
        connected: true,
        downed: false,
        invulnerableUntilMs: 0,
      };
      this.networkSimulation = null;
      this.simulation.getCombatState(this.soloPlayer.id);
    } else {
      this.simulation = null;
      this.soloPlayer = null;
    }
    this.controller = new FirstPersonController({
      canvas: this.canvas,
      collisionWorld: this.bunkerMap.collisionWorld,
      startPosition: options.mode === 'solo' ? CONFIG.map.startPosition : (START_POSITIONS[0] ?? CONFIG.map.startPosition),
      networked: options.mode === 'coop',
      sendInput: options.sendInput,
      onMelee: this.handleMelee,
      onInteractChange: this.handleInteractChange,
      onFireChange: this.handleFireChange,
      onGrenadeChange: this.handleGrenadeChange,
      onReload: this.handleReload,
      onSwitchWeapon: this.handleSwitchWeapon,
    });
    this.controller.setSensitivityMultiplier(this.sensitivityMultiplier);
    this.viewmodel = this.buildViewmodel('melder', false);
    this.viewmodelWeaponId = 'melder';
    this.viewmodelUpgraded = false;
    this.camera.add(this.viewmodel);
    this.drawAnimationRemainingMs = CONFIG.controller.weaponSwitchMs;
    this.gameplayElapsed = 0;
    this.fixedAccumulator = 0;
    this.controller.requestLock();
  }

  reconcileLocalPlayer(state: AuthoritativePlayerState): void {
    this.controller?.reconcile(state);
  }

  applyNetworkSimulation(view: NetworkGameView): void {
    this.networkSimulation = view;
  }

  applyNetworkFeedback(feedback: NetworkFeedback): void {
    if (feedback.kind === 'combat') {
      if (feedback.hit) this.recordHit(feedback.headshot === true, feedback.killed);
      if (feedback.points !== 0) this.recordPoints(feedback.points, feedback.source === 'melee' ? 'melee kill' : feedback.headshot ? 'headshot' : 'bullet hit');
    }
    if (feedback.kind === 'points') this.recordPoints(feedback.amount, feedback.reason);
    if (feedback.kind === 'damage') this.recordDamage(feedback.amount, feedback.enemyId);
    if (feedback.kind === 'reload' && !feedback.accepted) this.reloadAnimationRemainingMs = 0;
    if (feedback.kind === 'game') this.processGameEvent(feedback.event);
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
      visual.targetPitch = pose.pitch;
      visual.targetSpeedMps = Math.hypot(pose.vx, pose.vz);
      visual.targetDowned = pose.downed;
      visual.group.visible = !pose.spectating;
    }
    for (const [id, visual] of this.remotePlayers) {
      if (activeIds.has(id)) continue;
      this.remoteRoot.remove(visual.group);
      visual.rig.dispose();
      this.remotePlayers.delete(id);
    }
  }

  command(name: string): boolean {
    if (name !== 'gallery' && this.galleryInspectionLight !== null) this.galleryInspectionLight.visible = false;
    if (name !== 'gallery' && this.viewmodel !== null) this.viewmodel.visible = true;
    if (name === 'audio') return this.audio.runLocalizationGate();
    if (name === 'noclip') return this.controller?.toggleNoclip() ?? false;
    if (name === 'nav') return this.bunkerMap?.toggleNavDebug() ?? false;
    if (name === 'doors' && this.gameMode === 'solo') {
      this.bunkerMap?.setAllDoorsOpen(true);
      for (const door of DOORS) this.simulation?.setDoorOpen(door.id, true);
      return true;
    }
    if (this.gameMode !== 'solo' || this.simulation === null || this.soloPlayer === null) return false;
    if (name === 'points') {
      this.soloPlayer.points += 10000;
      return true;
    }
    if (name === 'spawn') return this.simulation.forceSpawn([this.soloPlayer]) !== null;
    if (name === 'kill') {
      this.simulation.killAll();
      return true;
    }
    if (name === 'skip') {
      this.simulation.skipRound([this.soloPlayer]);
      return true;
    }
    if (name === 'god') {
      this.godMode = !this.godMode;
      this.soloPlayer.hp = this.soloPlayer.maxHp;
      return this.godMode;
    }
    if (name === 'jager') {
      this.simulation.grantWeapon(this.soloPlayer.id, 'jaeger');
      this.ensureViewmodelWeapon('jaeger', false);
      return true;
    }
    if (name === 'arsenal') {
      this.visualGate = true;
      this.godMode = true;
      this.simulation.enemies.clear();
      this.soloPlayer.hp = this.soloPlayer.maxHp;
      this.soloPlayer.invulnerableUntilMs = Number.POSITIVE_INFINITY;
      const weapons = ['melder', 'jaeger', 'kurier', 'sturmvogel', 'doppelhieb', 'lasttraeger', 'richter', 'grabenfeger', 'fernblick', 'kettenhund'] as const;
      this.debugWeaponIndex = (this.debugWeaponIndex + 1) % weapons.length;
      const weaponId = weapons[this.debugWeaponIndex] ?? 'melder';
      this.simulation.grantWeapon(this.soloPlayer.id, weaponId);
      this.ensureViewmodelWeapon(weaponId, false);
      return true;
    }
    if (name === 'target') {
      const enemy = this.simulation.forceSpawn([this.soloPlayer])
        ?? [...this.simulation.enemies.values()]
          .filter((candidate) => candidate.state !== 'dead')
          .sort((left, right) => left.hp - right.hp || left.id - right.id)[0]
        ?? null;
      if (enemy === null) return false;
      enemy.x = this.soloPlayer.x - Math.sin(this.soloPlayer.yaw) * CONFIG.debug.aimTargetDistanceM;
      enemy.y = this.soloPlayer.y;
      enemy.z = this.soloPlayer.z - Math.cos(this.soloPlayer.yaw) * CONFIG.debug.aimTargetDistanceM;
      enemy.state = 'chase';
      enemy.stateTimeMs = 0;
      enemy.spawnProgress = 1;
      return true;
    }
    if (name === 'power') {
      this.simulation.setPowerOn(true);
      return true;
    }
    if (name === 'perk') {
      const perks = Object.keys(CONFIG.perks) as PerkId[];
      const perk = perks[this.debugPerkIndex % perks.length];
      this.debugPerkIndex += 1;
      if (perk === undefined) return false;
      this.simulation.grantPerk(this.soloPlayer, perk);
      return true;
    }
    if (name === 'powerup') {
      const types: PowerupId[] = ['instaKill', 'doublePoints', 'nuke', 'maxAmmo', 'carpenter'];
      const type = types[this.debugPowerupIndex % types.length];
      this.debugPowerupIndex += 1;
      if (type === undefined) return false;
      this.simulation.debugSpawnPowerup(type, this.soloPlayer.x, this.soloPlayer.y, this.soloPlayer.z);
      this.simulation.update(0, [this.soloPlayer]);
      return true;
    }
    if (name === 'wolves') {
      this.simulation.nextWolfRound = this.simulation.round;
      this.simulation.debugStartRound(this.simulation.round, [this.soloPlayer]);
      return true;
    }
    if (name === 'wonder') {
      this.visualGate = true;
      this.godMode = true;
      this.simulation.enemies.clear();
      this.soloPlayer.hp = this.soloPlayer.maxHp;
      this.soloPlayer.invulnerableUntilMs = Number.POSITIVE_INFINITY;
      const wonders = ['blitzwerfer', 'sonnenpistole'] as const;
      const weaponId = wonders[this.debugWonderIndex % wonders.length] ?? 'blitzwerfer';
      this.debugWonderIndex += 1;
      this.simulation.grantWeapon(this.soloPlayer.id, weaponId);
      this.ensureViewmodelWeapon(weaponId, false);
      return true;
    }
    if (name === 'forge') {
      const weapon = this.simulation.debugUpgradeActiveWeapon(this.soloPlayer.id);
      this.ensureViewmodelWeapon(weapon.id, true);
      return true;
    }
    if (name === 'pack') {
      this.godMode = true;
      this.simulation.gameOver = false;
      this.soloPlayer.downed = false;
      this.soloPlayer.spectating = false;
      this.soloPlayer.hp = this.soloPlayer.maxHp;
      this.soloPlayer.invulnerableUntilMs = Number.POSITIVE_INFINITY;
      const life = this.simulation.getLifeState(this.soloPlayer.id);
      life.dead = false;
      life.bleedoutRemainingMs = 0;
      life.selfReviveRemainingMs = 0;
      this.simulation.debugSpawnWonderPack(this.soloPlayer, [this.soloPlayer]);
      return true;
    }
    if (name === 'fire') {
      const controller = this.controller?.getReadout();
      if (controller === undefined) return false;
      this.syncSoloPose(controller);
      const result = this.simulation.fire(this.soloPlayer, controller.ads);
      if (!result.accepted) return false;
      this.playLocalShot(result.weaponId);
      this.processFireResult(result);
      return true;
    }
    if (name === 'forgeview') {
      for (const door of DOORS) {
        this.simulation.setDoorOpen(door.id, true);
        this.bunkerMap?.setDoorOpen(door.id, true);
      }
      this.simulation.setPowerOn(true);
      this.soloPlayer.points = Math.max(this.soloPlayer.points, CONFIG.economy.forgeUpgrade);
      this.soloPlayer.invulnerableUntilMs = Number.POSITIVE_INFINITY;
      this.godMode = true;
      const combat = this.simulation.grantWeapon(this.soloPlayer.id, 'jaeger');
      const stagedWeapon = activeWeapon(combat);
      stagedWeapon.upgraded = false;
      stagedWeapon.magazine = CONFIG.weapons.jaeger.magazine;
      stagedWeapon.reserve = CONFIG.weapons.jaeger.reserve;
      this.ensureViewmodelWeapon('jaeger', false);
      this.controller?.debugSetPose(FORGE.x, FORGE.y, FORGE.z + CONFIG.controller.interactionRangeM * 0.94, 0, -0.16);
      const pose = this.controller?.getReadout();
      if (pose !== undefined) this.syncSoloPose(pose);
      this.simulation.setInteractionHeld(this.soloPlayer.id, true);
      let remainingMs = CONFIG.controller.interactionHoldMs;
      while (remainingMs > 0) {
        const deltaMs = Math.min(remainingMs, CONFIG.simulation.maxFrameDeltaMs);
        this.simulation.update(deltaMs, [this.soloPlayer]);
        remainingMs -= deltaMs;
      }
      this.simulation.setInteractionHeld(this.soloPlayer.id, false);
      this.controller?.debugSetPose(FORGE.x, FORGE.y, FORGE.z + CONFIG.controller.interactionRangeM * 1.35, 0, -0.12);
      const viewingPose = this.controller?.getReadout();
      if (viewingPose !== undefined) this.syncSoloPose(viewingPose);
      this.processSoloEvents(this.simulation.drainEvents());
      return this.simulation.forge.phase === 'upgrading';
    }
    if (name === 'gallery') {
      this.visualGate = true;
      this.godMode = true;
      this.soloPlayer.hp = this.soloPlayer.maxHp;
      this.soloPlayer.invulnerableUntilMs = Number.POSITIVE_INFINITY;
      this.simulation.enemies.clear();
      this.simulation.debugStartRound(4, [this.soloPlayer]);
      this.simulation.setPowerOn(true);
      this.bunkerMap?.updatePower(true, CONFIG.power.activationMs);
      if (this.galleryInspectionLight === null) {
        const visual = CONFIG.rendering.characterVisual;
        this.galleryInspectionLight = new THREE.PointLight(
          visual.galleryLightColor,
          visual.galleryLightIntensity,
          visual.galleryLightDistanceM,
          2,
        );
        this.galleryInspectionLight.position.fromArray(visual.galleryLightPosition);
        this.scene.add(this.galleryInspectionLight);
      }
      this.galleryInspectionLight.visible = true;
      if (this.viewmodel !== null) this.viewmodel.visible = false;
      const poses = [
        { x: -2.25, z: -4.7, kind: 'zombie' as const },
        { x: -0.85, z: -4.45, kind: 'zombie' as const },
        { x: 0.65, z: -4.5, kind: 'zombie' as const },
        { x: 2.15, z: -4.75, kind: 'crawler' as const },
        { x: 3.35, z: -4.42, kind: 'wolf' as const },
      ];
      for (const pose of poses) {
        const enemy = this.simulation.forceSpawn([this.soloPlayer]);
        if (enemy === null) continue;
        enemy.kind = pose.kind;
        enemy.x = pose.x;
        enemy.y = 0;
        enemy.z = pose.z;
        enemy.yaw = Math.PI;
        enemy.state = 'chase';
        enemy.stateTimeMs = enemy.id * 170;
        enemy.spawnProgress = 1;
        enemy.speed = 0;
      }
      this.controller?.debugSetPose(0, 0, -0.35, 0, -0.04);
      return true;
    }
    if (name === 'stress') {
      this.visualGate = true;
      this.godMode = true;
      this.soloPlayer.invulnerableUntilMs = Number.POSITIVE_INFINITY;
      this.simulation.enemies.clear();
      this.simulation.debugStartRound(CONFIG.debug.wonderGateRound, [this.soloPlayer]);
      while (this.simulation.enemies.size < CONFIG.zombie.maxAlive) {
        const enemy = this.simulation.forceSpawn([this.soloPlayer]);
        if (enemy === null) break;
        const index = this.simulation.enemies.size - 1;
        const angle = index / CONFIG.zombie.maxAlive * Math.PI * 2;
        const ring = 3.2 + (index % 3) * 0.72;
        enemy.x = Math.sin(angle) * ring;
        enemy.y = 0;
        enemy.z = -1.5 - Math.cos(angle) * ring;
        enemy.yaw = angle + Math.PI;
        enemy.state = 'chase';
        enemy.stateTimeMs = index * 83;
        enemy.spawnProgress = 1;
        enemy.speed = 0;
      }
      this.controller?.debugSetPose(
        CONFIG.map.startPosition.x,
        CONFIG.map.startPosition.y,
        CONFIG.map.startPosition.z,
        0,
        0,
      );
      for (const [id, visual] of this.remotePlayers) {
        this.remoteRoot.remove(visual.group);
        visual.rig.dispose();
        this.remotePlayers.delete(id);
      }
      CONFIG.debug.stressRemotePoses.forEach((pose, index) => {
        const visual = this.createRemoteVisual();
        visual.group.position.set(pose.x, pose.y, pose.z);
        visual.group.rotation.y = pose.yaw;
        visual.targetPosition.copy(visual.group.position);
        visual.targetYaw = pose.yaw;
        visual.targetPitch = pose.pitch;
        visual.targetSpeedMps = pose.speedMps;
        visual.targetDowned = false;
        visual.rig.update(0, { speedMps: pose.speedMps, pitch: pose.pitch, downed: false });
        this.remoteRoot.add(visual.group);
        this.remotePlayers.set(`stress-remote-${index + 1}`, visual);
      });
      this.frameSamplesMs.length = 0;
      this.elapsedSample = 0;
      this.sampledFrames = 0;
      return this.simulation.enemies.size === CONFIG.zombie.maxAlive
        && this.remotePlayers.size === CONFIG.debug.stressRemotePoses.length;
    }
    if (name === 'tour') {
      this.visualGate = true;
      this.godMode = true;
      this.simulation.enemies.clear();
      this.soloPlayer.hp = this.soloPlayer.maxHp;
      this.soloPlayer.invulnerableUntilMs = Number.POSITIVE_INFINITY;
      const poses = [
        { x: 0, y: 0, z: -2.55, yaw: Math.PI, pitch: -0.04 },
        { x: -7.2, y: 0, z: 12.2, yaw: 1.85, pitch: -0.045 },
        { x: 10.3, y: 0, z: 9.55, yaw: 2.22, pitch: -0.055 },
        { x: 3, y: CONFIG.map.catwalkY, z: 11, yaw: -1.24, pitch: -0.045 },
      ];
      const pose = poses[this.debugTourIndex % poses.length]!;
      this.debugTourIndex += 1;
      for (const door of DOORS) {
        this.simulation.setDoorOpen(door.id, true);
        this.bunkerMap?.setDoorOpen(door.id, true);
      }
      this.simulation.setPowerOn(true);
      this.bunkerMap?.updatePower(true, CONFIG.power.activationMs);
      this.controller?.debugSetPose(pose.x, pose.y, pose.z, pose.yaw, pose.pitch);
      return true;
    }
    if (name === 'gameover') {
      const combat = this.simulation.getCombatState(this.soloPlayer.id);
      combat.kills = Math.max(combat.kills, 73);
      combat.headshots = Math.max(combat.headshots, 29);
      combat.shots = Math.max(combat.shots, 268);
      combat.hits = Math.max(combat.hits, 177);
      combat.pointsEarned = Math.max(combat.pointsEarned, 18470);
      combat.doorsOpened = Math.max(combat.doorsOpened, 3);
      combat.crateRolls = Math.max(combat.crateRolls, 7);
      this.simulation.gameOver = true;
      this.soloPlayer.downed = true;
      return true;
    }
    return false;
  }

  getControllerReadout(): ControllerReadout | null {
    return this.controller?.getReadout() ?? null;
  }

  drainHudEvents(): HudEvent[] {
    return this.hudEvents.splice(0, this.hudEvents.length);
  }

  getSimulationReadout(): SceneSimulationReadout | null {
    if (this.gameMode === 'solo' && this.simulation !== null && this.soloPlayer !== null) {
      const combat = this.simulation.getCombatState(this.soloPlayer.id);
      const life = this.simulation.getLifeState(this.soloPlayer.id);
      const phase = this.simulation.gameOver
        ? 'gameOver'
        : this.soloPlayer.downed
          ? 'downed'
          : this.soloPlayer.spectating === true
            ? 'spectating'
            : this.simulation.phase === 'active' ? 'playing' : 'intermission';
      return {
        round: this.simulation.round,
        elapsedMs: this.simulation.elapsedMs,
        spawned: this.simulation.spawnedThisRound,
        queued: this.simulation.queued,
        alive: this.simulation.aliveCount,
        phase,
        roundKind: this.simulation.roundKind,
        nextWolfRound: this.simulation.nextWolfRound,
        wolfAppearance: this.simulation.wolfAppearance,
        powerOn: this.simulation.powerOn,
        powerActivationElapsedMs: this.simulation.powerActivationElapsedMs,
        gameOver: this.simulation.gameOver,
        instaKillRemainingMs: this.simulation.effects.instaKillRemainingMs,
        doublePointsRemainingMs: this.simulation.effects.doublePointsRemainingMs,
        nukeRemainingMs: this.simulation.effects.nukeRemainingMs,
        hp: this.soloPlayer.hp,
        maxHp: this.soloPlayer.maxHp,
        points: this.soloPlayer.points,
        weapons: combat.weapons,
        activeWeaponIndex: combat.activeWeaponIndex,
        reloading: combat.reloadingWeaponIndex >= 0,
        reloadRemainingMs: combat.reloadingWeaponIndex >= 0 ? Math.max(0, combat.reloadFinishAtMs - this.simulation.elapsedMs) : 0,
        stats: combatStats(combat),
        grenades: combat.grenades,
        perks: combat.perks,
        pendingPerk: combat.pendingPerk,
        actionLockRemainingMs: Math.max(0, combat.actionLockedUntilMs - this.simulation.elapsedMs),
        selfRevivesRemaining: combat.selfRevivesRemaining,
        bleedoutRemainingMs: life.bleedoutRemainingMs,
        selfReviveRemainingMs: life.selfReviveRemainingMs,
        downed: this.soloPlayer.downed,
        dead: life.dead,
        spectating: this.soloPlayer.spectating === true,
        reconnectPending: life.reconnectPending,
        thrownGrenades: [...this.simulation.grenades.values()],
        openDoors: [...this.simulation.openDoors],
        crate: this.simulation.crate,
        forge: this.simulation.forge,
        localPlayerId: this.soloPlayer.id,
        barriers: [...this.simulation.barriers.values()],
        enemies: [...this.simulation.enemies.values()].map(toEnemyVisual),
        powerups: [...this.simulation.powerups.values()].map((powerup) => ({ ...powerup, powerupType: powerup.type })),
        players: [{
          id: this.soloPlayer.id,
          x: this.soloPlayer.x,
          y: this.soloPlayer.y,
          z: this.soloPlayer.z,
          connected: this.soloPlayer.connected,
          downed: this.soloPlayer.downed,
          spectating: this.soloPlayer.spectating === true,
          perks: combat.perks,
        }],
      };
    }
    const network = this.networkSimulation;
    if (this.gameMode === 'coop' && network !== null) {
      return {
        round: network.round,
        elapsedMs: network.elapsedMs,
        spawned: network.spawned,
        queued: network.queued,
        alive: network.alive,
        phase: network.gameOver ? 'gameOver' : network.localDowned ? 'downed' : network.localSpectating ? 'spectating' : network.phase === 'intermission' ? 'intermission' : 'playing',
        roundKind: network.roundKind,
        nextWolfRound: network.nextWolfRound,
        wolfAppearance: network.wolfAppearance,
        powerOn: network.powerOn,
        powerActivationElapsedMs: network.powerActivationElapsedMs,
        gameOver: network.gameOver,
        instaKillRemainingMs: network.instaKillRemainingMs,
        doublePointsRemainingMs: network.doublePointsRemainingMs,
        nukeRemainingMs: network.nukeRemainingMs,
        hp: network.localHp,
        maxHp: network.localMaxHp,
        points: network.localPoints,
        weapons: network.localWeapons,
        activeWeaponIndex: network.localActiveWeaponIndex,
        reloading: network.localReloading,
        reloadRemainingMs: network.localReloadRemainingMs,
        stats: network.localStats,
        grenades: network.localGrenades,
        perks: network.localPerks,
        pendingPerk: network.localPendingPerk,
        actionLockRemainingMs: network.localActionLockRemainingMs,
        selfRevivesRemaining: network.localSelfRevivesRemaining,
        bleedoutRemainingMs: network.localBleedoutRemainingMs,
        selfReviveRemainingMs: network.localSelfReviveRemainingMs,
        downed: network.localDowned,
        dead: network.localDead,
        spectating: network.localSpectating,
        reconnectPending: network.localReconnectPending,
        thrownGrenades: network.grenades,
        openDoors: network.openDoors,
        crate: network.crate,
        forge: network.forge,
        localPlayerId: network.localPlayerId,
        barriers: network.barriers,
        enemies: network.enemies.map(toEnemyVisual),
        powerups: network.powerups,
        players: network.players,
      };
    }
    return null;
  }

  getInteractionPrompt(): string | null {
    const controller = this.controller?.getReadout();
    const readout = this.getSimulationReadout();
    if (controller === undefined || controller === null || readout === null) return null;
    if (this.simulation !== null && this.soloPlayer !== null) {
      this.syncSoloPose(controller);
      return this.simulation.getInteractionTarget(this.soloPlayer)?.prompt ?? null;
    }
    const candidates: { distance: number; prompt: string }[] = [];
    const add = (distance: number, prompt: string): void => {
      if (distance <= CONFIG.controller.interactionRangeM) candidates.push({ distance, prompt });
    };
    if (readout.downed || readout.spectating || readout.gameOver) return null;
    for (const player of readout.players) {
      if (player.id === readout.localPlayerId || !player.connected || !player.downed) continue;
      add(Math.hypot(controller.x - player.x, controller.y - player.y, controller.z - player.z), 'Hold F to revive teammate');
    }
    for (const barrier of readout.barriers) {
      if (barrier.boards >= CONFIG.barriers.boardSlots) continue;
      const window = WINDOWS.find((candidate) => candidate.id === barrier.id);
      if (window !== undefined) add(Math.hypot(controller.x - window.insideX, controller.z - window.insideZ), 'Hold F to rebuild barrier');
    }
    for (const door of DOORS) {
      if (readout.openDoors.includes(door.id)) continue;
      add(Math.hypot(
        controller.x - (door.collider.minX + door.collider.maxX) * 0.5,
        controller.z - (door.collider.minZ + door.collider.maxZ) * 0.5,
      ), `Hold F to buy Door [Cost: ${door.cost}]`);
    }
    for (const wall of WALL_BUYS) {
      const distance = Math.hypot(controller.x - wall.x, controller.y + CONFIG.controller.eyeHeightM - wall.y, controller.z - wall.z);
      if (wall.kind === 'grenades') add(distance, `Hold F for Frag Grenades ×4 [Cost: ${wall.cost}]`);
      else if (wall.weaponId !== undefined) {
        const owned = readout.weapons.find((weapon) => weapon.id === wall.weaponId);
        const cost = owned === undefined
          ? wall.cost
          : owned.upgraded ? CONFIG.economy.upgradedWallAmmo : Math.round(wall.cost * CONFIG.economy.wallAmmoFactor);
        add(distance, `Hold F for ${CONFIG.weapons[wall.weaponId].name}${owned ? ' Ammo' : ''} [Cost: ${cost}]`);
      }
    }
    const crate = CRATE_LOCATIONS.find((location) => location.id === readout.crate.activeLocationId);
    if (crate !== undefined) {
      const distance = Math.hypot(controller.x - crate.x, controller.y - crate.y, controller.z - crate.z);
      if (readout.crate.phase === 'closed') add(distance, `Hold F for Mystery Crate [Cost: ${CONFIG.economy.mysteryCrate}]`);
      if (readout.crate.phase === 'available' && readout.crate.purchaserId === readout.localPlayerId && readout.crate.weaponId !== '') {
        add(distance, `Hold F to take ${CONFIG.weapons[readout.crate.weaponId].name}`);
      }
    }
    const switchDistance = Math.hypot(controller.x - POWER_SWITCH.x, controller.y + CONFIG.controller.eyeHeightM - POWER_SWITCH.y, controller.z - POWER_SWITCH.z);
    if (!readout.powerOn) add(switchDistance, 'Hold F to turn on the Power');
    for (const machine of PERK_MACHINES) {
      const distance = Math.hypot(controller.x - machine.x, controller.y - machine.y, controller.z - machine.z);
      if (!readout.powerOn) add(distance, 'Power must be activated first');
      else if (!readout.perks.includes(machine.id)) {
        const cost = machine.id === 'zweiterAtem' && this.gameMode === 'solo' ? CONFIG.perks.zweiterAtem.costSolo : CONFIG.perks[machine.id].cost;
        add(distance, `Hold F for ${CONFIG.perkRuntime.displayNames[machine.id]} [Cost: ${cost}]`);
      }
    }
    const forgeDistance = Math.hypot(controller.x - FORGE.x, controller.y - FORGE.y, controller.z - FORGE.z);
    const currentWeapon = readout.weapons[readout.activeWeaponIndex];
    if (!readout.powerOn) add(forgeDistance, 'Power must be activated first');
    else if (readout.forge.phase === 'upgrading') {
      add(forgeDistance, readout.forge.playerId === readout.localPlayerId ? 'Die Schmiede is upgrading your weapon' : 'Die Schmiede is occupied');
    } else if (currentWeapon?.upgraded) {
      add(forgeDistance, `${CONFIG.forge.namePrefix}${CONFIG.weapons[currentWeapon.id].name} is already forged`);
    } else if (currentWeapon !== undefined) {
      add(forgeDistance, `Hold F to upgrade ${CONFIG.weapons[currentWeapon.id].name} [Cost: ${CONFIG.economy.forgeUpgrade}]`);
    }
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0]?.prompt ?? null;
  }

  isGameplay(): boolean {
    return this.mode === 'gameplay';
  }

  isDebugVisualGate(): boolean {
    return this.visualGate;
  }

  restartSolo(seed: number): void {
    this.controller?.dispose();
    this.controller = null;
    this.enemyRenderer?.dispose();
    this.enemyRenderer = null;
    this.bunkerMap?.dispose();
    this.menuMaterials?.dispose();
    this.bunkerMap = null;
    for (const visual of this.remotePlayers.values()) visual.rig.dispose();
    this.remotePlayers.clear();
    this.remoteRoot.clear();
    if (this.viewmodel !== null) {
      this.camera.remove(this.viewmodel);
      this.disposeObject(this.viewmodel);
      this.viewmodel = null;
    }
    for (const effect of this.wonderEffects.splice(0)) {
      this.scene.remove(effect.group);
      this.disposeObject(effect.group);
    }
    this.scene.clear();
    this.galleryInspectionLight = null;
    this.simulation = null;
    this.soloPlayer = null;
    this.networkSimulation = null;
    this.mode = 'menu';
    this.godMode = false;
    this.visualGate = false;
    this.debugTourIndex = 0;
    this.fireHeld = false;
    this.grenadeCookStartedAtMs = -1;
    this.hudEvents.length = 0;
    this.enterGameplay({ mode: 'solo', seed });
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    window.removeEventListener('resize', this.onResize);
    this.controller?.dispose();
    for (const visual of this.remotePlayers.values()) visual.rig.dispose();
    this.remotePlayers.clear();
    this.enemyRenderer?.dispose();
    this.bunkerMap?.dispose();
    this.menuMaterials?.dispose();
    this.audio.dispose();
    this.timer.dispose();
    this.post.dispose();
    this.renderer.dispose();
  }

  getMetrics(): SceneMetrics {
    return { ...this.metrics };
  }

  getAudioDiagnostics(): AudioDiagnostics {
    return this.audio.getDiagnostics();
  }

  getCharacterDiagnostics(): CharacterDiagnostics | null {
    const diagnostics = this.enemyRenderer?.getDiagnostics();
    if (diagnostics === undefined) return null;
    return {
      ...diagnostics,
      remoteVisible: [...this.remotePlayers.values()].filter((visual) => visual.group.visible).length,
    };
  }

  setMasterVolume(value: number): void {
    this.audio.setMasterVolume(value);
  }

  setFieldOfView(value: number): void {
    this.fieldOfView = THREE.MathUtils.clamp(value, 65, 90);
    this.camera.fov = this.fieldOfView;
    this.camera.updateProjectionMatrix();
  }

  setSensitivityMultiplier(value: number): void {
    this.sensitivityMultiplier = THREE.MathUtils.clamp(value, 0.5, 2);
    this.controller?.setSensitivityMultiplier(this.sensitivityMultiplier);
  }

  private buildMenu(seed: number): void {
    this.menuRoot.name = 'menu-prelude';
    const rng = new SeededRng(seed);
    this.menuMaterials = new MaterialLibrary();
    const concrete = this.menuMaterials.clone('plaster', { color: 0xbcb7a7, roughness: 0.94 });
    const concreteDark = this.menuMaterials.clone('concrete', { color: 0x5c625e, roughness: 0.98 });
    const steel = this.menuMaterials.clone('steel', { color: 0x737d79, roughness: 0.57, metalness: 0.72 });
    const wood = this.menuMaterials.clone('wood', { color: 0x9a7651, roughness: 0.88 });

    const floor = new THREE.Mesh(applyTiledUvs(new THREE.PlaneGeometry(30, 32)), concreteDark);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.menuRoot.add(floor);
    const rear = new THREE.Mesh(applyTiledUvs(new THREE.BoxGeometry(16, 5.5, 0.6)), concrete);
    rear.position.set(0, 2.7, -3.8);
    rear.castShadow = true;
    rear.receiveShadow = true;
    this.menuRoot.add(rear);
    const sideLeft = new THREE.Mesh(applyTiledUvs(new THREE.BoxGeometry(0.6, 5.5, 15)), concrete);
    sideLeft.position.set(-7.7, 2.7, 2.8);
    sideLeft.castShadow = true;
    sideLeft.receiveShadow = true;
    this.menuRoot.add(sideLeft);
    const sideRight = sideLeft.clone();
    sideRight.position.x = 7.7;
    this.menuRoot.add(sideRight);
    const ceiling = new THREE.Mesh(applyTiledUvs(new THREE.BoxGeometry(16, 0.45, 15)), concreteDark);
    ceiling.position.set(0, 5.45, 2.8);
    this.menuRoot.add(ceiling);
    const doorway = new THREE.Mesh(applyTiledUvs(new THREE.BoxGeometry(3.8, 3.8, 0.85)), steel);
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
    for (const x of [-6.6, -3.3, 0, 3.3, 6.6]) {
      const rib = new THREE.Mesh(applyTiledUvs(new THREE.BoxGeometry(0.18, 0.22, 14.2)), steel);
      rib.position.set(x, 5.08, 2.8);
      rib.castShadow = true;
      this.menuRoot.add(rib);
    }
    for (const y of [3.7, 4.05]) {
      const pipe = new THREE.Mesh(new THREE.CylinderGeometry(0.065, 0.065, 13.8, 10), steel);
      pipe.rotation.x = Math.PI / 2;
      pipe.position.set(-6.95, y, 2.8);
      this.menuRoot.add(pipe);
    }
    const moon = new THREE.DirectionalLight(0x88a8ba, CONFIG.rendering.environment.menuMoonIntensity);
    moon.position.set(-8, 11, 7);
    moon.castShadow = true;
    moon.shadow.mapSize.set(CONFIG.rendering.shadowMapSize, CONFIG.rendering.shadowMapSize);
    this.menuRoot.add(moon);
    this.lamp = new THREE.PointLight(0xffb45d, CONFIG.rendering.environment.menuLampIntensity, 11, 2);
    this.lamp.position.set(1.5, 4.4, 0.5);
    this.lamp.castShadow = true;
    this.menuRoot.add(this.lamp);
    const bulb = new THREE.Mesh(new THREE.SphereGeometry(0.09, 12, 8), new THREE.MeshBasicMaterial({ color: 0xffd39a }));
    bulb.position.copy(this.lamp.position);
    this.menuRoot.add(bulb);
    this.menuRoot.add(new THREE.HemisphereLight(
      0x344b57,
      0x090a08,
      CONFIG.rendering.environment.menuHemisphereIntensity,
    ));
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

  private buildViewmodel(weaponId: WeaponId, upgraded: boolean): THREE.Group {
    const group = new THREE.Group();
    group.name = `${weaponId}-viewmodel`;
    const compactWeapon = weaponId === 'melder' || weaponId === 'richter' || weaponId === 'sonnenpistole';
    const viewmodelVisual = CONFIG.rendering.viewmodel;
    const metal = new THREE.MeshStandardMaterial({ color: viewmodelVisual.metalColor, emissive: 0x090b0a, emissiveIntensity: 0.055, roughness: 0.3, metalness: 0.88 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: viewmodelVisual.darkMetalColor, emissive: 0x050706, emissiveIntensity: 0.045, roughness: 0.48, metalness: 0.8 });
    const grip = new THREE.MeshStandardMaterial({ color: viewmodelVisual.walnutColor, roughness: 0.82, metalness: 0.02 });
    const addBox = (size: [number, number, number], position: [number, number, number], material: THREE.Material = metal): THREE.Mesh => {
      const bevel = Math.min(0.024, Math.min(...size) * 0.14);
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(size[0], size[1], size[2], 2, bevel), material);
      mesh.position.set(...position);
      group.add(mesh);
      return mesh;
    };
    const addBarrel = (radius: number, length: number, position: [number, number, number], material: THREE.Material = darkMetal): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.CylinderGeometry(radius * 0.78, radius, length, 12), material);
      mesh.rotation.x = Math.PI / 2;
      mesh.position.set(...position);
      group.add(mesh);
      return mesh;
    };
    const addScope = (position: [number, number, number], length: number): void => {
      addBarrel(0.055, length, position, darkMetal);
      addBox([0.018, 0.08, 0.018], [-0.065, position[1] - 0.045, position[2] + 0.07], metal);
      addBox([0.018, 0.08, 0.018], [0.065, position[1] - 0.045, position[2] + 0.07], metal);
    };
    const addBand = (radius: number, z: number, material: THREE.Material = metal): void => {
      const band = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.009, 6, 16), material);
      band.position.set(0, 0.04, z);
      group.add(band);
    };
    const addWoodStock = (stockLength: number): void => {
      const rearLength = stockLength * 0.46;
      const wristLength = stockLength * 0.38;
      const rear = addBox([0.19, 0.205, rearLength], [0, -0.075, 0.08 + stockLength * 0.27], grip);
      rear.rotation.x = -0.055;
      const wrist = addBox([0.115, 0.145, wristLength], [0, -0.035, 0.08 - stockLength * 0.18], grip);
      wrist.rotation.x = -0.055;
      addBox([0.198, 0.215, 0.035], [0, -0.088, 0.08 + stockLength * 0.51], darkMetal).rotation.x = -0.055;
      for (const side of [-1, 1]) {
        addBox([0.008, 0.012, rearLength * 0.72], [side * 0.098, -0.025, 0.08 + stockLength * 0.27], darkMetal);
      }
    };
    const addLongGun = (barrelLength: number, stockLength: number, magazine: 'box' | 'drum' | 'none' = 'box'): void => {
      addWoodStock(stockLength);
      addBox([0.16, 0.15, 0.38], [0, 0.025, -0.34], metal);
      const cover = addBox([0.135, 0.072, 0.32], [0, 0.105, -0.35], darkMetal);
      cover.name = 'vm-cover';
      addBox([0.142, 0.105, Math.min(0.32, barrelLength * 0.46)], [0, 0.015, -0.62], grip);
      addBarrel(0.026, barrelLength, [0, 0.04, -0.55 - barrelLength * 0.5]);
      if (magazine === 'box') {
        const boxMagazine = addBox([0.13, 0.25, 0.15], [0, -0.17, -0.31], darkMetal);
        boxMagazine.rotation.x = 0.12;
        boxMagazine.name = 'vm-magazine';
      }
      if (magazine === 'drum') {
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 16), darkMetal);
        drum.name = 'vm-magazine';
        drum.rotation.z = Math.PI / 2;
        drum.position.set(0, -0.1, -0.3);
        group.add(drum);
      }
      addBand(0.06, -0.54);
      addBand(0.053, -0.77);
      const action = addBox([0.055, 0.035, 0.12], [0.1, 0.085, -0.34], darkMetal);
      action.name = 'vm-bolt';
      addBox([0.018, 0.065, 0.025], [0, 0.12, -0.52 - barrelLength]);
      addBox([0.075, 0.026, 0.02], [0, 0.145, -0.23], darkMetal);
    };

    if (weaponId === 'melder') {
      const slide = addBox([0.11, 0.1, 0.47], [0, 0, -0.09]);
      slide.name = 'vm-bolt';
      addBox([0.102, 0.075, 0.31], [0, -0.072, -0.005], darkMetal);
      addBarrel(0.03, 0.32, [0, 0.005, -0.34]);
      addBox([0.1, 0.24, 0.13], [0, -0.14, 0.08], grip).rotation.x = -0.2;
      addBox([0.018, 0.035, 0.035], [0, 0.067, -0.28], darkMetal);
      for (const x of [-0.035, 0.035]) addBox([0.014, 0.03, 0.025], [x, 0.065, 0.105], darkMetal);
      for (const z of [0.045, 0.085, 0.125, 0.165]) {
        for (const x of [-0.057, 0.057]) addBox([0.006, 0.075, 0.018], [x, 0.004, z], darkMetal);
      }
      for (const x of [-0.052, 0.052]) addBox([0.012, 0.15, 0.09], [x, -0.145, 0.08], darkMetal);
      const muzzleRing = new THREE.Mesh(new THREE.TorusGeometry(0.028, 0.006, 7, 18), darkMetal);
      muzzleRing.position.set(0, 0.005, -0.505);
      group.add(muzzleRing);
    } else if (weaponId === 'jaeger') {
      addLongGun(0.72, 0.72, 'none');
      const bolt = addBarrel(0.018, 0.18, [0.14, 0.095, -0.29], metal);
      bolt.name = 'vm-bolt';
      bolt.rotation.set(0, 0, Math.PI / 2);
      addBox([0.08, 0.055, 0.035], [0, 0.12, -0.25], darkMetal);
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.jaeger);
    } else if (weaponId === 'kurier') {
      addLongGun(0.54, 0.58, 'box');
      addBox([0.1, 0.06, 0.26], [0, 0.11, -0.18], grip);
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.kurier);
    } else if (weaponId === 'sturmvogel') {
      addBox([0.18, 0.18, 0.52], [0, 0, -0.23]);
      addBarrel(0.034, 0.38, [0, 0.02, -0.68]);
      const magazine = addBox([0.13, 0.34, 0.14], [0, -0.22, -0.24], darkMetal);
      magazine.rotation.x = -0.08;
      magazine.name = 'vm-magazine';
      addBox([0.12, 0.28, 0.12], [0, -0.17, 0.08], grip).rotation.x = -0.24;
      const topAction = addBox([0.17, 0.055, 0.34], [0, 0.115, -0.26], darkMetal);
      topAction.name = 'vm-bolt';
      addBand(0.052, -0.52);
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.sturmvogel);
    } else if (weaponId === 'doppelhieb') {
      addWoodStock(0.72);
      addBox([0.2, 0.135, 0.32], [0, -0.01, -0.42], grip);
      const leftBarrel = addBarrel(0.037, 0.82, [-0.044, 0.055, -0.72]);
      leftBarrel.name = 'vm-break-barrel';
      const rightBarrel = addBarrel(0.037, 0.82, [0.044, 0.055, -0.72]);
      rightBarrel.name = 'vm-break-barrel';
      addBox([0.17, 0.18, 0.2], [0, 0.015, -0.32], metal);
      for (const x of [-0.044, 0.044]) {
        const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.037, 0.006, 6, 14), darkMetal);
        muzzle.position.set(x, 0.055, -1.13);
        group.add(muzzle);
      }
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.doppelhieb);
    } else if (weaponId === 'lasttraeger') {
      addLongGun(0.64, 0.58, 'drum');
      const lmgCover = addBox([0.2, 0.08, 0.4], [0, 0.15, -0.31], darkMetal);
      lmgCover.name = 'vm-heavy-cover';
      addBarrel(0.012, 0.48, [-0.12, -0.11, -0.73], metal).rotation.z = -0.22;
      addBarrel(0.012, 0.48, [0.12, -0.11, -0.73], metal).rotation.z = 0.22;
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.lasttraeger);
    } else if (weaponId === 'richter') {
      addBox([0.13, 0.12, 0.31], [0, 0.01, -0.17]);
      addBarrel(0.037, 0.48, [0, 0.025, -0.54]);
      const cylinder = addBarrel(0.095, 0.15, [0, -0.005, -0.15], metal);
      cylinder.name = 'vm-cylinder';
      cylinder.rotation.set(0, 0, Math.PI / 2);
      addBox([0.12, 0.3, 0.14], [0, -0.18, 0.04], grip).rotation.x = -0.24;
    } else if (weaponId === 'grabenfeger') {
      addWoodStock(0.66);
      addBarrel(0.038, 0.83, [0, 0.06, -0.76]);
      addBarrel(0.026, 0.7, [0, -0.025, -0.72], metal);
      const pump = addBox([0.21, 0.18, 0.31], [0, -0.02, -0.63], grip);
      pump.name = 'vm-pump';
      for (const x of [-0.075, -0.025, 0.025, 0.075]) addBox([0.012, 0.19, 0.24], [x, -0.02, -0.63], darkMetal);
      addBand(0.059, -1.16);
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.grabenfeger);
    } else if (weaponId === 'fernblick') {
      addLongGun(0.78, 0.7, 'none');
      addScope([0, 0.19, -0.46], 0.56);
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.fernblick);
    } else if (weaponId === 'kettenhund') {
      addLongGun(0.7, 0.52, 'box');
      const ammunitionBox = addBox([0.24, 0.24, 0.5], [0.25, -0.12, -0.28], darkMetal);
      ammunitionBox.name = 'vm-magazine';
      const heavyCover = addBox([0.22, 0.1, 0.45], [0, 0.17, -0.31], metal);
      heavyCover.name = 'vm-heavy-cover';
      addBarrel(0.012, 0.52, [-0.13, -0.11, -0.8], metal).rotation.z = -0.2;
      addBarrel(0.012, 0.52, [0.13, -0.11, -0.8], metal).rotation.z = 0.2;
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.kettenhund);
    } else if (weaponId === 'blitzwerfer') {
      const ceramic = new THREE.MeshStandardMaterial({ color: 0x253f50, emissive: CONFIG.rendering.wonderEffect.blitzColor, emissiveIntensity: 0.32, roughness: 0.3, metalness: 0.38 });
      const conductor = new THREE.MeshStandardMaterial({ color: 0x8eb9c6, emissive: CONFIG.rendering.wonderEffect.blitzCoreColor, emissiveIntensity: 0.78, roughness: 0.2, metalness: 0.86 });
      addBox([0.23, 0.2, 0.54], [0, -0.01, -0.23], ceramic);
      addBox([0.14, 0.3, 0.16], [0, -0.2, 0.02], grip).rotation.x = -0.18;
      for (const x of [-0.075, 0.075]) addBarrel(0.027, 0.62, [x, 0.035, -0.78], conductor);
      for (const z of [-0.38, -0.53, -0.68]) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.135, 0.014, 6, 18), conductor);
        coil.position.set(0, 0.035, z);
        group.add(coil);
      }
      for (const x of [-0.11, 0.11]) {
        const tine = addBarrel(0.014, 0.22, [x, 0.035, -1.17], conductor);
        tine.rotation.z = x < 0 ? -0.12 : 0.12;
      }
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.blitzwerfer);
    } else if (weaponId === 'sonnenpistole') {
      const solar = new THREE.MeshStandardMaterial({ color: 0x51261b, emissive: CONFIG.rendering.wonderEffect.sunColor, emissiveIntensity: 0.34, roughness: 0.38, metalness: 0.62 });
      const brass = new THREE.MeshStandardMaterial({ color: 0x99703c, emissive: CONFIG.rendering.wonderEffect.sunCoreColor, emissiveIntensity: 0.42, roughness: 0.28, metalness: 0.82 });
      addBox([0.17, 0.15, 0.48], [0, 0, -0.18], solar);
      addBox([0.12, 0.29, 0.14], [0, -0.18, 0.03], grip).rotation.x = -0.2;
      addBarrel(0.04, 0.48, [0, 0.025, -0.62], brass);
      const chamber = new THREE.Mesh(new THREE.SphereGeometry(0.13, 16, 10), solar);
      chamber.scale.set(1, 0.78, 1.3);
      chamber.position.set(0, 0.035, -0.35);
      group.add(chamber);
      for (const z of [-0.2, -0.3, -0.4, -0.5]) {
        const fin = new THREE.Mesh(new THREE.BoxGeometry(0.27, 0.018, 0.035), brass);
        fin.position.set(0, 0.08, z);
        group.add(fin);
      }
      const muzzle = new THREE.Mesh(new THREE.TorusGeometry(0.075, 0.016, 8, 20), brass);
      muzzle.position.set(0, 0.025, -0.88);
      group.add(muzzle);
      group.scale.setScalar(viewmodelVisual.scaleByWeapon.sonnenpistole);
    }
    const ejectionPort = compactWeapon
      ? addBox([0.012, 0.032, 0.13], [0.057, 0.048, -0.12], darkMetal)
      : addBox([0.075, 0.032, 0.16], [0.09, 0.075, -0.25], darkMetal);
    ejectionPort.rotation.z = 0.04;
    const triggerGuard = new THREE.Mesh(new THREE.TorusGeometry(0.052, 0.006, 6, 18, Math.PI * 1.45), darkMetal);
    triggerGuard.rotation.z = Math.PI / 2;
    triggerGuard.position.set(0, -0.105, -0.075);
    group.add(triggerGuard);
    const rivetX = compactWeapon ? 0.046 : 0.085;
    for (const z of [-0.12, -0.31]) {
      for (const x of [-rivetX, rivetX]) {
        const rivet = new THREE.Mesh(new THREE.SphereGeometry(0.012, 7, 5), darkMetal);
        rivet.position.set(x, 0.078, z);
        group.add(rivet);
      }
    }
    if (upgraded) {
      group.traverse((object) => {
        if (!(object instanceof THREE.Mesh) || !(object.material instanceof THREE.MeshStandardMaterial)) return;
        const material = object.material.clone();
        material.color.multiplyScalar(0.58);
        material.emissive.setHex(CONFIG.rendering.viewmodel.upgradedEtchColor);
        material.emissiveIntensity = CONFIG.rendering.viewmodel.upgradedGlowIntensity * 0.24;
        object.material = material;
      });
      const etchMaterial = new THREE.MeshStandardMaterial({
        color: CONFIG.rendering.viewmodel.upgradedEtchColor,
        emissive: CONFIG.rendering.viewmodel.upgradedEtchColor,
        emissiveIntensity: CONFIG.rendering.viewmodel.upgradedGlowIntensity,
        roughness: 0.28,
        metalness: 0.52,
      });
      for (const z of [-0.2, -0.42, -0.64]) {
        const rune = new THREE.Mesh(new THREE.TorusGeometry(0.105, 0.006, 5, 12, Math.PI * 1.35), etchMaterial);
        rune.position.set(0, 0.105, z);
        rune.rotation.z = z * 2.1;
        group.add(rune);
      }
    }
    if (group.scale.x === 1) group.scale.setScalar(viewmodelVisual.scaleByWeapon[weaponId]);
    const sleeve = new THREE.MeshStandardMaterial({ color: viewmodelVisual.sleeveColor, roughness: 0.94 });
    const glove = new THREE.MeshStandardMaterial({ color: viewmodelVisual.gloveColor, roughness: 0.9 });
    const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.34, 8, 16), sleeve);
    leftArm.name = 'vm-left-arm';
    leftArm.rotation.x = Math.PI / 2.7;
    leftArm.rotation.z = -0.28;
    leftArm.position.set(-0.16, -0.25, 0.13);
    group.add(leftArm);
    const rightArm = leftArm.clone();
    rightArm.name = 'vm-right-arm';
    rightArm.position.x = 0.18;
    rightArm.rotation.z = 0.32;
    group.add(rightArm);
    const leftHand = new THREE.Mesh(new THREE.CapsuleGeometry(0.052, 0.085, 7, 14), glove);
    leftHand.name = 'vm-left-hand';
    leftHand.scale.set(0.86, 1, 0.74);
    leftHand.position.set(-0.105, -0.155, compactWeapon ? -0.08 : -0.38);
    leftHand.rotation.z = compactWeapon ? -0.34 : Math.PI / 2;
    group.add(leftHand);
    const rightHand = leftHand.clone();
    rightHand.name = 'vm-right-hand';
    rightHand.position.set(0.105, -0.16, 0.035);
    rightHand.rotation.z = 0.28;
    group.add(rightHand);
    for (let finger = 0; finger < 4; finger += 1) {
      const segment = new THREE.Mesh(new THREE.CapsuleGeometry(0.011, 0.046, 3, 7), glove);
      segment.position.set(0.062, -0.11 - finger * 0.028, 0.005 + finger * 0.01);
      segment.rotation.z = 0.18;
      segment.rotation.x = -0.18;
      group.add(segment);
    }
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = false;
        object.renderOrder = 10;
      }
      if (object.name.startsWith('vm-')) {
        object.userData.restPosition = object.position.clone();
        object.userData.restRotation = object.rotation.clone();
      }
    });
    const hip = CONFIG.rendering.viewmodel.hip;
    group.position.set(hip[0], hip[1], hip[2]);
    const muzzleOffset = CONFIG.rendering.viewmodel.muzzleOffset;
    this.muzzleLight = new THREE.PointLight(0xffb15a, 0, CONFIG.rendering.muzzleLightDistanceM, 2);
    const bounds = new THREE.Box3().setFromObject(group);
    this.muzzleLight.position.set(muzzleOffset[0], muzzleOffset[1], Math.min(muzzleOffset[2], bounds.min.z));
    group.add(this.muzzleLight);
    return group;
  }

  private ensureViewmodelWeapon(weaponId: WeaponId, upgraded: boolean): void {
    if (weaponId === this.viewmodelWeaponId && upgraded === this.viewmodelUpgraded && this.viewmodel !== null) return;
    const prior = this.viewmodel;
    if (prior !== null) {
      this.camera.remove(prior);
      this.disposeObject(prior);
    }
    this.viewmodel = this.buildViewmodel(weaponId, upgraded);
    this.viewmodelWeaponId = weaponId;
    this.viewmodelUpgraded = upgraded;
    this.camera.add(this.viewmodel);
  }

  private createRemoteVisual(): RemoteVisual {
    const rig = new RemoteOperative();
    return {
      group: rig.group,
      rig,
      targetPosition: new THREE.Vector3(),
      targetYaw: 0,
      targetPitch: 0,
      targetSpeedMps: 0,
      targetDowned: false,
    };
  }

  private updateGameplay(delta: number): void {
    const controller = this.controller;
    if (controller === null) return;
    this.fixedAccumulator += delta;
    const fixedDelta = 1 / CONFIG.simulation.hz;
    let subSteps = 0;
    while (this.fixedAccumulator >= fixedDelta && subSteps < CONFIG.simulation.maxSubSteps) {
      controller.fixedUpdate();
      if (this.simulation !== null && this.soloPlayer !== null) {
        const readout = controller.getReadout();
        this.soloPlayer.x = readout.x;
        this.soloPlayer.y = readout.y;
        this.soloPlayer.z = readout.z;
        this.soloPlayer.yaw = readout.yaw;
        this.soloPlayer.pitch = readout.pitch;
        if (!this.visualGate) {
          this.simulation.update(1000 / CONFIG.simulation.hz, [this.soloPlayer]);
          this.processSoloEvents(this.simulation.drainEvents());
        }
        if (this.godMode) {
          this.soloPlayer.hp = this.soloPlayer.maxHp;
          this.soloPlayer.downed = false;
        }
      }
      this.fixedAccumulator -= fixedDelta;
      subSteps += 1;
    }
    controller.applyCamera(this.camera);
    this.gameplayElapsed += delta;
    if (this.fireHeld) {
      const simulation = this.getSimulationReadout();
      const weapon = simulation?.weapons[simulation.activeWeaponIndex];
      if (weapon !== undefined && CONFIG.weapons[weapon.id].automatic) this.fireWeapon(false);
    }
    if (this.grenadeCookStartedAtMs >= 0
      && this.gameplayElapsed * 1000 - this.grenadeCookStartedAtMs >= CONFIG.combat.grenadeFuseMs) {
      this.releaseGrenade(CONFIG.combat.grenadeFuseMs);
    }
    this.meleeAnimationRemainingMs = Math.max(0, this.meleeAnimationRemainingMs - delta * 1000);
    this.reloadAnimationRemainingMs = Math.max(0, this.reloadAnimationRemainingMs - delta * 1000);
    this.shotAnimationRemainingMs = Math.max(0, this.shotAnimationRemainingMs - delta * 1000);
    this.drawAnimationRemainingMs = Math.max(0, this.drawAnimationRemainingMs - delta * 1000);
    this.muzzleRemainingMs = Math.max(0, this.muzzleRemainingMs - delta * 1000);
    this.viewmodelRecoilM = THREE.MathUtils.lerp(this.viewmodelRecoilM, 0, Math.min(1, delta * 1000 / CONFIG.controller.recoilRecoveryMs));
    if (this.muzzleLight !== null) this.muzzleLight.intensity = this.muzzleRemainingMs > 0 ? CONFIG.rendering.muzzleLightIntensity : 0;
    this.updateViewmodel(controller.getReadout(), delta);
    this.updateWonderEffects(delta * 1000);
    const enemyInterpolationAlpha = this.gameMode === 'coop'
      ? Math.min(1, delta / (CONFIG.coop.interpolationMs / 1000))
      : 1;
    this.refreshSimulationVisuals(enemyInterpolationAlpha);
    const controllerReadout = controller.getReadout();
    const simulationReadout = this.getSimulationReadout();
    if (simulationReadout !== null) {
      const listenerRoom = roomAt(controllerReadout.x, controllerReadout.y, controllerReadout.z);
      this.audio.update({
        elapsedMs: this.gameplayElapsed * 1000,
        listener: {
          x: controllerReadout.x,
          y: controllerReadout.y + CONFIG.controller.eyeHeightM,
          z: controllerReadout.z,
          yaw: controllerReadout.yaw,
          pitch: controllerReadout.pitch,
          room: listenerRoom,
        },
        healthRatio: simulationReadout.hp / Math.max(1, simulationReadout.maxHp),
        movementSpeedMps: Math.hypot(controllerReadout.vx, controllerReadout.vz),
        grounded: controllerReadout.grounded,
        powerOn: simulationReadout.powerOn,
        roundKind: simulationReadout.roundKind,
        enemies: simulationReadout.enemies.map((enemy) => ({
          id: enemy.id,
          kind: enemy.kind,
          state: enemy.state,
          speedTier: enemy.speedTier,
          x: enemy.x,
          y: enemy.y,
          z: enemy.z,
          room: WINDOWS.find((window) => window.id === enemy.barrierId)?.room
            ?? FOG_BANKS.find((bank) => bank.id === enemy.barrierId)?.room
            ?? roomAt(enemy.x, enemy.y, enemy.z),
        } satisfies AudioEnemyEmitter)),
        perkMachines: PERK_MACHINES,
      });
    }
    const interpolationAlpha = Math.min(1, delta / (CONFIG.coop.interpolationMs / 1000));
    for (const visual of this.remotePlayers.values()) {
      visual.group.position.lerp(visual.targetPosition, interpolationAlpha);
      visual.group.rotation.y = lerpAngle(visual.group.rotation.y, visual.targetYaw, interpolationAlpha);
      visual.rig.update(delta, { speedMps: visual.targetSpeedMps, pitch: visual.targetPitch, downed: visual.targetDowned });
    }
  }

  private updateViewmodel(readout: ControllerReadout, delta: number): void {
    const simulation = this.getSimulationReadout();
    const weapon = simulation?.weapons[simulation.activeWeaponIndex];
    if (weapon !== undefined) this.ensureViewmodelWeapon(weapon.id, weapon.upgraded);
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
    viewmodel.position.z = THREE.MathUtils.lerp(viewmodel.position.z, target[2] + this.viewmodelRecoilM, positionAlpha);
    const targetRoll = readout.sprinting ? CONFIG.rendering.viewmodel.sprintRollRad : Math.sin(this.gameplayElapsed * CONFIG.controller.bobFrequency * 0.5) * 0.018 * moveRatio;
    const rotationAlpha = 1 - Math.exp(-CONFIG.rendering.viewmodel.rotationLerpPerSecond * delta);
    viewmodel.rotation.x = THREE.MathUtils.lerp(viewmodel.rotation.x, 0, rotationAlpha);
    viewmodel.rotation.z = THREE.MathUtils.lerp(viewmodel.rotation.z, targetRoll, rotationAlpha);
    const meleeProgress = this.meleeAnimationRemainingMs > 0
      ? 1 - this.meleeAnimationRemainingMs / CONFIG.melee.cooldownMs
      : 0;
    const meleeArc = this.meleeAnimationRemainingMs > 0 ? Math.sin(meleeProgress * Math.PI) : 0;
    viewmodel.position.y -= meleeArc * CONFIG.rendering.viewmodel.meleeDropM;
    viewmodel.rotation.y = THREE.MathUtils.lerp(
      viewmodel.rotation.y,
      meleeArc * CONFIG.rendering.viewmodel.meleeYawRad,
      rotationAlpha,
    );
    const reloadDuration = weapon === undefined
      ? 1
      : CONFIG.weapons[weapon.id].reloadMs * (simulation?.perks.includes('schnellwasser') ? CONFIG.perkRuntime.schnellwasserReloadMultiplier : 1);
    const reloadProgress = this.reloadAnimationRemainingMs > 0 ? 1 - this.reloadAnimationRemainingMs / reloadDuration : 0;
    const reloadArc = this.reloadAnimationRemainingMs > 0 ? Math.sin(reloadProgress * Math.PI) : 0;
    viewmodel.position.y -= reloadArc * CONFIG.rendering.viewmodel.reloadDropM;
    viewmodel.rotation.z += reloadArc * CONFIG.rendering.viewmodel.reloadRollRad;
    const weaponId = weapon?.id ?? this.viewmodelWeaponId;
    this.updateViewmodelParts(viewmodel, weaponId, reloadArc);
    if (this.drawAnimationRemainingMs > 0) {
      const drawProgress = 1 - this.drawAnimationRemainingMs / CONFIG.controller.weaponSwitchMs;
      const drawOffset = 1 - THREE.MathUtils.smoothstep(drawProgress, 0, 1);
      viewmodel.position.y -= drawOffset * CONFIG.rendering.viewmodel.animation.drawDropM;
      viewmodel.rotation.z += drawOffset * CONFIG.rendering.viewmodel.animation.drawRollRad;
    }
    const forgeActive = simulation?.forge.phase === 'upgrading' && simulation.forge.playerId === simulation.localPlayerId;
    const forgeProgress = forgeActive ? 1 - simulation.forge.remainingMs / CONFIG.forge.animationMs : 0;
    const forgeArc = forgeActive ? Math.sin(forgeProgress * Math.PI) : 0;
    viewmodel.position.y -= forgeArc * CONFIG.rendering.viewmodel.forgeDropM;
    viewmodel.rotation.x += forgeArc * CONFIG.rendering.viewmodel.forgePitchRad;
  }

  private updateViewmodelParts(viewmodel: THREE.Group, weaponId: WeaponId, reloadArc: number): void {
    const visual = CONFIG.rendering.viewmodel.animation;
    const actionDuration = visual.actionMs[weaponId];
    const actionProgress = this.shotAnimationRemainingMs > 0
      ? 1 - this.shotAnimationRemainingMs / actionDuration
      : 1;
    const actionArc = this.shotAnimationRemainingMs > 0 ? Math.sin(actionProgress * Math.PI) : 0;
    const boltWeapons: readonly WeaponId[] = ['melder', 'jaeger', 'kurier', 'sturmvogel', 'fernblick', 'lasttraeger', 'kettenhund'];
    const magazineReload = this.reloadAnimationRemainingMs > 0
      && weaponId !== 'doppelhieb'
      && weaponId !== 'grabenfeger'
      && weaponId !== 'jaeger'
      && weaponId !== 'fernblick'
      && weaponId !== 'richter';

    viewmodel.traverse((object) => {
      const restPosition = object.userData.restPosition as THREE.Vector3 | undefined;
      const restRotation = object.userData.restRotation as THREE.Euler | undefined;
      if (restPosition !== undefined) object.position.copy(restPosition);
      if (restRotation !== undefined) object.rotation.copy(restRotation);
      if (object.name === 'vm-bolt' && boltWeapons.includes(weaponId)) {
        const reloadBoltArc = (weaponId === 'jaeger' || weaponId === 'fernblick') ? reloadArc : 0;
        object.position.z += visual.boltTravelM * Math.max(actionArc, reloadBoltArc);
      }
      if (object.name === 'vm-pump' && weaponId === 'grabenfeger') {
        object.position.z += visual.pumpTravelM * actionArc;
      }
      if (object.name === 'vm-magazine' && magazineReload) {
        object.position.y -= visual.magazineDropM * reloadArc;
        object.rotation.z += visual.magazineRollRad * reloadArc;
      }
      if (object.name === 'vm-break-barrel' && weaponId === 'doppelhieb') {
        object.rotation.x += visual.breakActionAngleRad * reloadArc;
        object.position.y -= visual.boltTravelM * reloadArc;
      }
      if (object.name === 'vm-cylinder' && weaponId === 'richter') {
        object.position.x -= visual.cylinderSwingM * reloadArc;
        object.rotation.z += visual.magazineRollRad * reloadArc + actionArc * Math.PI / 3;
      }
      if (object.name === 'vm-heavy-cover' && (weaponId === 'lasttraeger' || weaponId === 'kettenhund')) {
        object.rotation.x -= visual.coverOpenAngleRad * reloadArc;
        object.position.y += visual.boltTravelM * reloadArc;
      }
      if (object.name === 'vm-left-hand') {
        if (weaponId === 'grabenfeger') object.position.z += visual.pumpTravelM * actionArc;
        if (this.reloadAnimationRemainingMs > 0) {
          object.position.y -= visual.supportHandTravelM * reloadArc;
          object.position.x -= visual.supportHandTravelM * 0.35 * reloadArc;
        }
      }
    });
  }

  private refreshSimulationVisuals(enemyInterpolationAlpha = 1): void {
    const readout = this.getSimulationReadout();
    if (readout === null) return;
    this.controller?.setMovementEnabled(!readout.downed && !readout.spectating && !readout.gameOver);
    this.enemyRenderer?.update(readout.enemies, enemyInterpolationAlpha);
    this.bunkerMap?.updateBarriers(readout.barriers);
    for (const door of DOORS) this.bunkerMap?.setDoorOpen(door.id, readout.openDoors.includes(door.id));
    this.bunkerMap?.updateCrate(readout.crate, readout.elapsedMs);
    this.bunkerMap?.updateGrenades(readout.thrownGrenades);
    this.bunkerMap?.updatePower(readout.powerOn, readout.powerActivationElapsedMs);
    this.bunkerMap?.updatePowerups(readout.powerups, readout.elapsedMs);
    this.bunkerMap?.updateForge(readout.forge, readout.powerOn, readout.elapsedMs);
    const fog = this.scene.fog;
    if (fog instanceof THREE.Fog) {
      fog.color.setHex(readout.roundKind === 'wolves' ? CONFIG.rendering.wolfFog.color : CONFIG.rendering.fogColor);
      fog.near = readout.roundKind === 'wolves' ? CONFIG.rendering.wolfFog.nearM : CONFIG.rendering.fogNearM;
      fog.far = readout.roundKind === 'wolves' ? CONFIG.rendering.wolfFog.farM : CONFIG.rendering.fogFarM;
    }
  }

  private readonly handleFireChange = (held: boolean): void => {
    this.fireHeld = held;
    if (held) this.fireWeapon(true);
  };

  private fireWeapon(playEmpty: boolean): void {
    const controllerReadout = this.controller?.getReadout();
    const simulationReadout = this.getSimulationReadout();
    if (controllerReadout === undefined || controllerReadout === null || simulationReadout === null
      || simulationReadout.spectating || simulationReadout.gameOver) return;
    const weapon = simulationReadout.weapons[simulationReadout.activeWeaponIndex];
    if (weapon === undefined) return;
    if (simulationReadout.reloading || weapon.magazine <= 0) {
      if (playEmpty) this.audio.playEmpty();
      return;
    }

    if (this.gameMode === 'coop') {
      const nowMs = this.gameplayElapsed * 1000;
      if (nowMs < this.nextCosmeticFireAtMs) return;
      const fireRateMultiplier = simulationReadout.perks.includes('doppelschuss') ? CONFIG.perkRuntime.doppelschussFireRateMultiplier : 1;
      this.nextCosmeticFireAtMs = nowMs + 60000 / (CONFIG.weapons[weapon.id].rpm * fireRateMultiplier);
      this.sendAction?.({
        type: 'fire',
        ads: controllerReadout.ads,
        simulationTimeMs: simulationReadout.elapsedMs,
        yaw: controllerReadout.yaw,
        pitch: controllerReadout.pitch,
      });
      this.playLocalShot(weapon.id);
      return;
    }
    if (this.simulation === null || this.soloPlayer === null) return;
    this.syncSoloPose(controllerReadout);
    const result = this.simulation.fire(this.soloPlayer, controllerReadout.ads);
    if (!result.accepted) {
      if (result.reason === 'empty' && playEmpty) this.audio.playEmpty();
      return;
    }
    this.playLocalShot(result.weaponId);
    this.processFireResult(result);
  }

  private readonly handleReload = (): void => {
    const readout = this.getSimulationReadout();
    if (readout === null || readout.spectating || readout.gameOver) return;
    const weapon = readout.weapons[readout.activeWeaponIndex];
    if (weapon === undefined || readout.reloading || weapon.reserve <= 0 || weapon.magazine >= weaponMagazineCapacity(weapon)) return;
    if (this.gameMode === 'coop') {
      this.sendAction?.({ type: 'reload' });
    } else if (this.simulation !== null && this.soloPlayer !== null) {
      const result = this.simulation.requestReload(this.soloPlayer.id);
      if (!result.accepted) return;
    }
    const reloadMultiplier = readout.perks.includes('schnellwasser') ? CONFIG.perkRuntime.schnellwasserReloadMultiplier : 1;
    this.reloadAnimationRemainingMs = CONFIG.weapons[weapon.id].reloadMs * reloadMultiplier;
    this.nextCosmeticFireAtMs = 0;
    this.audio.playReload(weapon.id);
  };

  private readonly handleSwitchWeapon = (index: number): void => {
    const readout = this.getSimulationReadout();
    if (readout === null || index < 0 || index >= readout.weapons.length || index === readout.activeWeaponIndex) return;
    if (this.gameMode === 'coop') this.sendAction?.({ type: 'switch', index });
    else if (this.soloPlayer !== null && !this.simulation?.switchWeapon(this.soloPlayer.id, index)) return;
    this.reloadAnimationRemainingMs = 0;
    this.shotAnimationRemainingMs = 0;
    this.drawAnimationRemainingMs = CONFIG.controller.weaponSwitchMs;
    this.nextCosmeticFireAtMs = this.gameplayElapsed * 1000 + CONFIG.controller.weaponSwitchMs;
    this.ensureViewmodelWeapon(readout.weapons[index]!.id, readout.weapons[index]!.upgraded);
  };

  private playLocalShot(weaponId: WeaponId): void {
    const definition = CONFIG.weapons[weaponId];
    const horizontal = (this.cosmeticRng.next() * 2 - 1) * definition.recoilHorizontal;
    this.controller?.applyRecoil(definition.recoilVertical, horizontal);
    this.viewmodelRecoilM = CONFIG.rendering.viewmodel.recoilPositionM;
    this.muzzleRemainingMs = CONFIG.rendering.muzzleLightMs;
    this.shotAnimationRemainingMs = CONFIG.rendering.viewmodel.animation.actionMs[weaponId];
    this.audio.playShot(weaponId);
    this.pushHudEvent({ type: 'shot' });
  }

  private processFireResult(result: FireResult): void {
    if (result.hit) this.recordHit(result.headshot, result.killed);
    if (result.points !== 0) this.recordPoints(result.points, result.headshot ? 'headshot' : result.killed ? 'body kill' : 'bullet hit');
    if ((result.weaponId === 'blitzwerfer' || result.weaponId === 'sonnenpistole') && result.impact !== null) {
      this.playWonderEffect(result.weaponId, result.affectedEnemyIds, result.impact, this.getSimulationReadout()?.localPlayerId ?? '');
    }
  }

  private processSoloEvents(events: ReturnType<GameSimulation['drainEvents']>): void {
    for (const event of events) {
      if (event.type === 'boardRepaired') this.recordPoints(event.points, 'barrier repair');
      if (event.type === 'pointTransaction') this.recordPoints(event.amount, event.reason);
      if (event.type === 'playerDamaged') this.recordDamage(event.damage, event.enemyId);
      this.processGameEvent(event as { type: string; [key: string]: unknown });
    }
  }

  private processGameEvent(event: { type: string; [key: string]: unknown }): void {
    const readout = this.getSimulationReadout();
    const localPlayerId = readout?.localPlayerId ?? '';
    const sourcePlayerId = typeof event.playerId === 'string' ? event.playerId : '';
    if (event.type === 'weaponFired' && sourcePlayerId !== localPlayerId && isWeaponId(event.weaponId)) {
      this.audio.playShot(event.weaponId, this.playerAudioPoint(sourcePlayerId), true);
      this.remotePlayers.get(sourcePlayerId)?.rig.playFire();
    }
    if (event.type === 'weaponReloaded' && sourcePlayerId !== localPlayerId && isWeaponId(event.weaponId)) {
      this.audio.playReload(event.weaponId, this.playerAudioPoint(sourcePlayerId));
      this.remotePlayers.get(sourcePlayerId)?.rig.playReload();
    }
    if (event.type === 'meleeSwung' && sourcePlayerId !== localPlayerId) {
      this.audio.playMelee(this.playerAudioPoint(sourcePlayerId));
      this.remotePlayers.get(sourcePlayerId)?.rig.playMelee();
    }
    if (event.type === 'powerupCollected' && typeof event.powerupType === 'string') {
      this.pushHudEvent({ type: 'points', amount: 0, reason: event.powerupType });
    }
    if (event.type === 'wonderFired' && (event.weaponId === 'blitzwerfer' || event.weaponId === 'sonnenpistole')
      && Array.isArray(event.affectedEnemyIds) && event.impact !== null && typeof event.impact === 'object') {
      const impact = event.impact as { x?: unknown; y?: unknown; z?: unknown };
      if (typeof impact.x === 'number' && typeof impact.y === 'number' && typeof impact.z === 'number') {
        const affected = event.affectedEnemyIds.filter((value): value is number => typeof value === 'number');
        this.playWonderEffect(event.weaponId, affected, { x: impact.x, y: impact.y, z: impact.z }, typeof event.playerId === 'string' ? event.playerId : '');
      }
    }

    const point = this.eventAudioPoint(event);
    const enemyKind = isEnemyKind(event.kind) ? event.kind : isEnemyKind(event.enemyKind) ? event.enemyKind : 'zombie';
    const enemyId = typeof event.enemyId === 'number' ? event.enemyId : 0;
    if (event.type === 'enemySpawned') this.audio.playWorldCue('enemySpawn', point, enemyKind, enemyId);
    if (event.type === 'boardTorn') this.audio.playWorldCue('boardTorn', point);
    if (event.type === 'boardRepaired') this.audio.playWorldCue('boardRepaired', point);
    if (event.type === 'vaultStarted') this.audio.playWorldCue('vault', point);
    if (event.type === 'playerDamaged') this.audio.playWorldCue('damage', point, enemyKind);
    if (event.type === 'enemyKilled') this.audio.playWorldCue('enemyDeath', point, enemyKind, enemyId);
    if (event.type === 'pointTransaction' && typeof event.amount === 'number' && event.amount > 0) this.audio.playWorldCue('purchase', point);
    if (event.type === 'doorOpened') this.audio.playWorldCue('door', point);
    if (event.type === 'weaponPurchased' || event.type === 'ammoPurchased' || event.type === 'grenadesPurchased') {
      this.audio.playWorldCue('purchase', point);
    }
    if (event.type === 'crateStarted') this.audio.playWorldCue('crateStart', point);
    if (event.type === 'crateSettled') this.audio.playWorldCue('crateSettle', point);
    if (event.type === 'cratePuppe') this.audio.playWorldCue('cratePuppe', point);
    if (event.type === 'crateCollected') this.audio.playWorldCue('crateCollect', point);
    if (event.type === 'grenadeThrown' && sourcePlayerId !== localPlayerId) this.audio.playWorldCue('grenadeThrow', point);
    if (event.type === 'grenadeExploded') this.audio.playWorldCue('explosion', point);
    if (event.type === 'powerActivated') this.audio.playWorldCue('power', point);
    if (event.type === 'perkPurchaseStarted') this.audio.playWorldCue('perkDrink', point);
    if (event.type === 'perkGranted' && isPerkId(event.perkId)) this.audio.playPerkJingle(event.perkId, point);
    if (event.type === 'forgeStarted') this.audio.playWorldCue('forgeStart', point);
    if (event.type === 'forgeCompleted') this.audio.playWorldCue('forgeComplete', point);
    if (event.type === 'forgeCancelled') this.audio.playWorldCue('forgeCancel', point);
    if (event.type === 'playerSelfDamaged') this.audio.playWorldCue('damage', point);
    if (event.type === 'powerupSpawned') this.audio.playWorldCue('powerupSpawn', point);
    if (event.type === 'powerupCollected' && isPowerupId(event.powerupType)) this.audio.playPowerupCall(event.powerupType);
    if (event.type === 'playerDowned') this.audio.playWorldCue('downed', point);
    if (event.type === 'playerRevived') this.audio.playWorldCue('revived', point);
    if (event.type === 'playerBledOut') this.audio.playWorldCue('bledOut', point);
    if (event.type === 'playerReturned') this.audio.playWorldCue('returned', point);
    if (event.type === 'gameOver') this.audio.playWorldCue('gameOver');
    if (event.type === 'roundStarted' && typeof event.round === 'number') {
      this.audio.playRoundSting(event.round, readout?.roundKind === 'wolves');
    }
    if (event.type === 'roundEnded') this.audio.playWorldCue('roundEnd');
  }

  private eventAudioPoint(event: { type: string; [key: string]: unknown }): AudioPoint | undefined {
    if (typeof event.x === 'number' && typeof event.y === 'number' && typeof event.z === 'number') {
      const authoredRoom = typeof event.barrierId === 'string'
        ? WINDOWS.find((candidate) => candidate.id === event.barrierId)?.room ?? FOG_BANKS.find((candidate) => candidate.id === event.barrierId)?.room
        : undefined;
      return { x: event.x, y: event.y, z: event.z, room: authoredRoom ?? roomAt(event.x, event.y, event.z) };
    }
    if (typeof event.barrierId === 'string') {
      const window = WINDOWS.find((candidate) => candidate.id === event.barrierId);
      if (window !== undefined) return { x: window.x, y: window.y, z: window.z, room: window.room };
    }
    if (typeof event.doorId === 'string') {
      const door = DOORS.find((candidate) => candidate.id === event.doorId);
      if (door !== undefined) {
        const x = (door.collider.minX + door.collider.maxX) * 0.5;
        const y = (door.collider.minY + door.collider.maxY) * 0.5;
        const z = (door.collider.minZ + door.collider.maxZ) * 0.5;
        return { x, y, z, room: roomAt(x, y, z) };
      }
    }
    if (typeof event.wallBuyId === 'string') {
      const wall = WALL_BUYS.find((candidate) => candidate.id === event.wallBuyId);
      if (wall !== undefined) return { x: wall.x, y: wall.y, z: wall.z, room: wall.room };
    }
    if (typeof event.locationId === 'string') {
      const location = CRATE_LOCATIONS.find((candidate) => candidate.id === event.locationId);
      if (location !== undefined) return { x: location.x, y: location.y, z: location.z, room: location.room };
    }
    if (isPerkId(event.perkId)) {
      const machine = PERK_MACHINES.find((candidate) => candidate.id === event.perkId);
      if (machine !== undefined) return { x: machine.x, y: machine.y, z: machine.z, room: machine.room };
    }
    if (event.type === 'powerActivated') {
      return { x: POWER_SWITCH.x, y: POWER_SWITCH.y, z: POWER_SWITCH.z, room: POWER_SWITCH.room };
    }
    if (event.type.startsWith('forge')) return { x: FORGE.x, y: FORGE.y, z: FORGE.z, room: FORGE.room };
    if (typeof event.playerId === 'string') return this.playerAudioPoint(event.playerId);
    return undefined;
  }

  private playerAudioPoint(playerId: string): AudioPoint | undefined {
    const player = this.getSimulationReadout()?.players.find((candidate) => candidate.id === playerId);
    if (player === undefined) return undefined;
    return { x: player.x, y: player.y + CONFIG.controller.eyeHeightM, z: player.z, room: roomAt(player.x, player.y, player.z) };
  }

  private playWonderEffect(
    weaponId: 'blitzwerfer' | 'sonnenpistole',
    affectedEnemyIds: readonly number[],
    impact: { x: number; y: number; z: number },
    playerId: string,
  ): void {
    const readout = this.getSimulationReadout();
    if (readout === null) return;
    const group = new THREE.Group();
    const materials: TransientWonderEffect['materials'] = [];
    if (weaponId === 'blitzwerfer') {
      const controller = this.controller?.getReadout();
      const shooter = readout.players.find((player) => player.id === playerId);
      const origin = shooter === undefined || playerId === readout.localPlayerId
        ? { x: controller?.x ?? 0, y: (controller?.y ?? 0) + CONFIG.controller.eyeHeightM, z: controller?.z ?? 0 }
        : { x: shooter.x, y: shooter.y + CONFIG.controller.eyeHeightM, z: shooter.z };
      const targets = affectedEnemyIds
        .map((id) => readout.enemies.find((enemy) => enemy.id === id))
        .filter((enemy): enemy is SceneEnemyReadout => enemy !== undefined)
        .map((enemy) => ({ x: enemy.x, y: enemy.y + CONFIG.combat.bodyTopHeightM * 0.62, z: enemy.z }));
      const nodes = [origin, ...targets];
      for (let linkIndex = 0; linkIndex < nodes.length - 1; linkIndex += 1) {
        const from = nodes[linkIndex]!;
        const to = nodes[linkIndex + 1]!;
        const positions: number[] = [];
        let prior = from;
        for (let segment = 1; segment <= CONFIG.rendering.wonderEffect.blitzSegments; segment += 1) {
          const alpha = segment / CONFIG.rendering.wonderEffect.blitzSegments;
          const endpoint = segment === CONFIG.rendering.wonderEffect.blitzSegments;
          const current = {
            x: THREE.MathUtils.lerp(from.x, to.x, alpha) + (endpoint ? 0 : (this.cosmeticRng.next() * 2 - 1) * CONFIG.rendering.wonderEffect.blitzJitterM),
            y: THREE.MathUtils.lerp(from.y, to.y, alpha) + (endpoint ? 0 : (this.cosmeticRng.next() * 2 - 1) * CONFIG.rendering.wonderEffect.blitzJitterM),
            z: THREE.MathUtils.lerp(from.z, to.z, alpha) + (endpoint ? 0 : (this.cosmeticRng.next() * 2 - 1) * CONFIG.rendering.wonderEffect.blitzJitterM),
          };
          positions.push(prior.x, prior.y, prior.z, current.x, current.y, current.z);
          prior = current;
        }
        const material = new THREE.LineBasicMaterial({
          color: linkIndex % 2 === 0 ? CONFIG.rendering.wonderEffect.blitzColor : CONFIG.rendering.wonderEffect.blitzCoreColor,
          transparent: true,
          opacity: 1,
          depthTest: false,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          toneMapped: false,
        });
        materials.push(material);
        group.add(new THREE.LineSegments(
          new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)),
          material,
        ));
      }
      const nodeMaterial = new THREE.MeshBasicMaterial({
        color: CONFIG.rendering.wonderEffect.blitzCoreColor,
        transparent: true,
        opacity: 1,
        depthTest: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      materials.push(nodeMaterial);
      for (const node of nodes.slice(1)) {
        const pulse = new THREE.Mesh(new THREE.SphereGeometry(CONFIG.rendering.wonderEffect.blitzNodeRadiusM, 8, 6), nodeMaterial);
        pulse.position.set(node.x, node.y, node.z);
        group.add(pulse);
      }
      this.wonderEffects.push({ group, materials, durationMs: CONFIG.rendering.wonderEffect.blitzDurationMs, remainingMs: CONFIG.rendering.wonderEffect.blitzDurationMs, expands: false });
    } else {
      group.position.set(impact.x, impact.y, impact.z);
      const coreMaterial = new THREE.MeshBasicMaterial({ color: CONFIG.rendering.wonderEffect.sunCoreColor, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      const ringMaterial = new THREE.MeshBasicMaterial({ color: CONFIG.rendering.wonderEffect.sunColor, transparent: true, opacity: 0.9, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, toneMapped: false });
      materials.push(coreMaterial, ringMaterial);
      group.add(new THREE.Mesh(new THREE.SphereGeometry(CONFIG.rendering.wonderEffect.sunCoreRadiusM, 16, 10), coreMaterial));
      const ring = new THREE.Mesh(new THREE.TorusGeometry(CONFIG.rendering.wonderEffect.sunRingRadiusM, CONFIG.rendering.wonderEffect.sunParticleSizeM, 8, CONFIG.rendering.wonderEffect.sunRingSegments), ringMaterial);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
      const particles = new Float32Array(CONFIG.rendering.wonderEffect.sunParticleCount * 3);
      for (let index = 0; index < CONFIG.rendering.wonderEffect.sunParticleCount; index += 1) {
        const theta = index / CONFIG.rendering.wonderEffect.sunParticleCount * Math.PI * 2;
        const phi = Math.acos(1 - 2 * ((index + 0.5) / CONFIG.rendering.wonderEffect.sunParticleCount));
        particles[index * 3] = Math.sin(phi) * Math.cos(theta);
        particles[index * 3 + 1] = Math.cos(phi);
        particles[index * 3 + 2] = Math.sin(phi) * Math.sin(theta);
      }
      const particleMaterial = new THREE.PointsMaterial({ color: CONFIG.rendering.wonderEffect.sunColor, size: CONFIG.rendering.wonderEffect.sunParticleSizeM, transparent: true, opacity: 1, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false });
      materials.push(particleMaterial);
      group.add(new THREE.Points(new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(particles, 3)), particleMaterial));
      this.wonderEffects.push({ group, materials, durationMs: CONFIG.rendering.wonderEffect.sunDurationMs, remainingMs: CONFIG.rendering.wonderEffect.sunDurationMs, expands: true });
    }
    this.scene.add(group);
  }

  private updateWonderEffects(deltaMs: number): void {
    for (let index = this.wonderEffects.length - 1; index >= 0; index -= 1) {
      const effect = this.wonderEffects[index]!;
      effect.remainingMs = Math.max(0, effect.remainingMs - deltaMs);
      const life = effect.remainingMs / effect.durationMs;
      for (const material of effect.materials) material.opacity = life;
      if (effect.expands) {
        const scale = 1 + (1 - life) * CONFIG.wonder.sunSplashRadiusM;
        effect.group.scale.setScalar(scale);
      }
      if (effect.remainingMs > 0) continue;
      this.scene.remove(effect.group);
      this.disposeObject(effect.group);
      this.wonderEffects.splice(index, 1);
    }
  }

  private recordHit(headshot: boolean, killed: boolean): void {
    this.audio.playHitmarker();
    this.audio.playWorldCue('damage');
    this.pushHudEvent({ type: 'hit', headshot, killed });
  }

  private recordPoints(amount: number, reason: string): void {
    this.pushHudEvent({ type: 'points', amount, reason });
    if (import.meta.env.DEV) console.debug(`[points] local ${amount >= 0 ? '+' : ''}${amount} ${reason}`);
  }

  private recordDamage(amount: number, enemyId: number): void {
    const player = this.controller?.getReadout();
    const enemy = this.getSimulationReadout()?.enemies.find((candidate) => candidate.id === enemyId);
    let directionDeg = 0;
    if (player !== undefined && player !== null && enemy !== undefined) {
      const targetYaw = Math.atan2(-(enemy.x - player.x), -(enemy.z - player.z));
      const relative = Math.atan2(Math.sin(targetYaw - player.yaw), Math.cos(targetYaw - player.yaw));
      directionDeg = THREE.MathUtils.radToDeg(relative);
    }
    this.pushHudEvent({ type: 'damage', amount, directionDeg });
  }

  private pushHudEvent(event: HudEventInput): void {
    this.hudEventSequence += 1;
    this.hudEvents.push({ id: this.hudEventSequence, ...event } as HudEvent);
  }

  private syncSoloPose(readout: ControllerReadout): void {
    if (this.soloPlayer === null) return;
    this.soloPlayer.x = readout.x;
    this.soloPlayer.y = readout.y;
    this.soloPlayer.z = readout.z;
    this.soloPlayer.yaw = readout.yaw;
    this.soloPlayer.pitch = readout.pitch;
  }

  private readonly handleMelee = (): void => {
    this.meleeAnimationRemainingMs = CONFIG.melee.cooldownMs;
    this.audio.playMelee();
    if (this.gameMode === 'coop') {
      this.sendAction?.({ type: 'melee' });
      return;
    }
    if (this.simulation === null || this.soloPlayer === null) return;
    const readout = this.controller?.getReadout();
    if (readout !== undefined) {
      this.soloPlayer.x = readout.x;
      this.soloPlayer.y = readout.y;
      this.soloPlayer.z = readout.z;
      this.soloPlayer.yaw = readout.yaw;
      this.soloPlayer.pitch = readout.pitch;
    }
    const result = this.simulation.melee(this.soloPlayer);
    if (result.hit) this.recordHit(false, result.killed);
    if (result.points !== 0) this.recordPoints(result.points, 'melee kill');
  };

  private readonly handleInteractChange = (held: boolean): void => {
    if (this.gameMode === 'coop') {
      this.sendAction?.({ type: 'interact', held });
      return;
    }
    if (this.soloPlayer !== null) {
      this.simulation?.setRepairHeld(this.soloPlayer.id, held);
      this.simulation?.setInteractionHeld(this.soloPlayer.id, held);
    }
  };

  private readonly handleGrenadeChange = (held: boolean): void => {
    if (held) {
      if (this.grenadeCookStartedAtMs < 0 && (this.getSimulationReadout()?.grenades ?? 0) > 0) {
        this.grenadeCookStartedAtMs = this.gameplayElapsed * 1000;
      }
      return;
    }
    if (this.grenadeCookStartedAtMs < 0) return;
    this.releaseGrenade(this.gameplayElapsed * 1000 - this.grenadeCookStartedAtMs);
  };

  private releaseGrenade(cookedMs: number): void {
    this.grenadeCookStartedAtMs = -1;
    this.audio.playWorldCue('grenadeThrow');
    if (this.gameMode === 'coop') {
      this.sendAction?.({ type: 'grenade', cookedMs: Math.min(CONFIG.combat.grenadeFuseMs, Math.max(0, cookedMs)) });
      return;
    }
    const readout = this.controller?.getReadout();
    if (readout === undefined || this.soloPlayer === null || this.simulation === null) return;
    this.syncSoloPose(readout);
    this.simulation.throwGrenade(this.soloPlayer, cookedMs);
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
        this.lamp.intensity = CONFIG.rendering.environment.menuLampIntensity * flicker * (0.96 + Math.sin(elapsed * 7.1) * 0.04);
      }
    } else {
      this.updateGameplay(delta);
    }
    this.renderer.info.reset();
    const readout = this.getSimulationReadout();
    this.post.render(elapsed, readout === null ? 1 : readout.hp / Math.max(1, readout.maxHp));
    this.elapsedSample += delta;
    this.sampledFrames += 1;
    this.frameSamplesMs.push(delta * 1000);
    if (this.frameSamplesMs.length > CONFIG.rendering.frameSampleWindow) this.frameSamplesMs.shift();
    if (this.elapsedSample >= 0.5) {
      const sortedFrameSamples = [...this.frameSamplesMs].sort((left, right) => left - right);
      this.metrics = {
        fps: Math.round(this.sampledFrames / this.elapsedSample),
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        medianFrameMs: percentile(sortedFrameSamples, 0.5),
        p95FrameMs: percentile(sortedFrameSamples, 0.95),
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
    this.post.resize(window.innerWidth, window.innerHeight, Math.min(window.devicePixelRatio, CONFIG.rendering.maxPixelRatio));
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

function percentile(sortedValues: readonly number[], quantile: number): number {
  if (sortedValues.length === 0) return 0;
  const index = Math.min(sortedValues.length - 1, Math.max(0, Math.ceil(sortedValues.length * quantile) - 1));
  return sortedValues[index] ?? 0;
}

function toEnemyVisual(enemy: {
  id: number;
  kind: 'zombie' | 'crawler' | 'wolf';
  state: EnemyVisualState['state'];
  speedTier: EnemyVisualState['speedTier'];
  x: number;
  y: number;
  z: number;
  yaw: number;
  stateTimeMs: number;
  spawnProgress: number;
  hp: number;
  maxHp: number;
  speed: number;
  barrierId: string;
  targetPlayerId: string;
}): SceneEnemyReadout {
  return {
    id: enemy.id,
    kind: enemy.kind,
    state: enemy.state,
    speedTier: enemy.speedTier,
    x: enemy.x,
    y: enemy.y,
    z: enemy.z,
    yaw: enemy.yaw,
    stateTimeMs: enemy.stateTimeMs,
    spawnProgress: enemy.spawnProgress,
    hp: enemy.hp,
    maxHp: enemy.maxHp,
    speed: enemy.speed,
    barrierId: enemy.barrierId,
    targetPlayerId: enemy.targetPlayerId,
  };
}

function combatStats(state: CombatPlayerState): SceneSimulationReadout['stats'] {
  return {
    shots: state.shots,
    hits: state.hits,
    kills: state.kills,
    headshots: state.headshots,
    pointsEarned: state.pointsEarned,
    doorsOpened: state.doorsOpened,
    crateRolls: state.crateRolls,
  };
}

function isWeaponId(value: unknown): value is WeaponId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONFIG.weapons, value);
}

function isPerkId(value: unknown): value is PerkId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONFIG.perks, value);
}

function isPowerupId(value: unknown): value is PowerupId {
  return value === 'instaKill' || value === 'doublePoints' || value === 'nuke' || value === 'maxAmmo' || value === 'carpenter';
}

function isEnemyKind(value: unknown): value is AudioEnemyEmitter['kind'] {
  return value === 'zombie' || value === 'crawler' || value === 'wolf';
}
