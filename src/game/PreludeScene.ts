import * as THREE from 'three';
import { CONFIG, type PerkId, type PowerupId, type WeaponId } from '../config.js';
import { AudioSystem } from '../audio/AudioSystem.js';
import { CRATE_LOCATIONS, DOORS, PERK_MACHINES, POWER_SWITCH, START_POSITIONS, WALL_BUYS, WINDOWS } from '../map/blueprint.js';
import { SeededRng } from '../shared/rng.js';
import type { MovementInput } from '../shared/movement.js';
import { GameSimulation, type SimCrateState, type SimGrenade, type SimPlayer } from '../shared/GameSimulation.js';
import { type CombatPlayerState, type FireResult, type RuntimeWeaponState } from '../shared/combat.js';
import { BunkerMap } from './BunkerMap.js';
import { EnemyRenderer, type EnemyVisualState } from './EnemyRenderer.js';
import { FirstPersonController, type AuthoritativePlayerState, type ControllerReadout } from './FirstPersonController.js';
import type { ClientAction, NetworkFeedback, NetworkGameView } from '../network/CoopClient.js';

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
  stats: { shots: number; hits: number; kills: number; headshots: number; pointsEarned: number };
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
  targetPosition: THREE.Vector3;
  targetYaw: number;
  targetDowned: boolean;
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
  private readonly audio = new AudioSystem();
  private cosmeticRng: SeededRng;
  private fogParticles: THREE.Points | null = null;
  private lamp: THREE.PointLight | null = null;
  private bunkerMap: BunkerMap | null = null;
  private enemyRenderer: EnemyRenderer | null = null;
  private controller: FirstPersonController | null = null;
  private simulation: GameSimulation | null = null;
  private soloPlayer: SimPlayer | null = null;
  private networkSimulation: NetworkGameView | null = null;
  private sendAction: GameplayOptions['sendAction'];
  private viewmodel: THREE.Group | null = null;
  private muzzleLight: THREE.PointLight | null = null;
  private viewmodelWeaponId: WeaponId = 'melder';
  private mode: 'menu' | 'gameplay' = 'menu';
  private gameMode: 'solo' | 'coop' = 'solo';
  private frameHandle = 0;
  private fixedAccumulator = 0;
  private elapsedSample = 0;
  private sampledFrames = 0;
  private gameplayElapsed = 0;
  private meleeAnimationRemainingMs = 0;
  private reloadAnimationRemainingMs = 0;
  private viewmodelRecoilM = 0;
  private muzzleRemainingMs = 0;
  private nextCosmeticFireAtMs = 0;
  private fireHeld = false;
  private grenadeCookStartedAtMs = -1;
  private hudEventSequence = 0;
  private debugWeaponIndex = 0;
  private debugPerkIndex = 0;
  private debugPowerupIndex = 0;
  private readonly hudEvents: HudEvent[] = [];
  private godMode = false;
  private metrics: SceneMetrics = { fps: CONFIG.rendering.targetFps, drawCalls: 0 };

  constructor(seed: number) {
    this.cosmeticRng = new SeededRng(seed ^ 0x5f356495);
    this.audio.setSeed(seed);
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
    this.enemyRenderer = new EnemyRenderer();
    this.scene.add(this.enemyRenderer.group);
    this.scene.add(this.remoteRoot);
    this.scene.add(this.camera);
    this.scene.background = new THREE.Color(0x080b0b);
    this.scene.fog = new THREE.Fog(CONFIG.rendering.fogColor, CONFIG.rendering.fogNearM, CONFIG.rendering.fogFarM);
    this.camera.fov = CONFIG.player.fovDeg;
    this.camera.near = CONFIG.rendering.cameraNearM;
    this.camera.far = CONFIG.rendering.cameraFarM;
    this.camera.updateProjectionMatrix();
    this.sendAction = options.sendAction;
    this.cosmeticRng = new SeededRng(options.seed ^ 0x5f356495);
    this.audio.setSeed(options.seed);
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
    this.viewmodel = this.buildViewmodel('melder');
    this.viewmodelWeaponId = 'melder';
    this.camera.add(this.viewmodel);
    this.gameplayElapsed = 0;
    this.fixedAccumulator = 0;
    this.controller.requestLock();
  }

  reconcileLocalPlayer(state: AuthoritativePlayerState): void {
    this.controller?.reconcile(state);
  }

  applyNetworkSimulation(view: NetworkGameView): void {
    this.networkSimulation = view;
    if (this.gameMode !== 'coop') return;
    this.refreshSimulationVisuals();
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
      visual.targetDowned = pose.downed;
      visual.group.visible = !pose.spectating;
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
      this.ensureViewmodelWeapon('jaeger');
      return true;
    }
    if (name === 'arsenal') {
      const weapons = ['melder', 'jaeger', 'kurier', 'sturmvogel', 'doppelhieb', 'lasttraeger', 'richter', 'grabenfeger', 'fernblick', 'kettenhund'] as const;
      this.debugWeaponIndex = (this.debugWeaponIndex + 1) % weapons.length;
      const weaponId = weapons[this.debugWeaponIndex] ?? 'melder';
      this.simulation.grantWeapon(this.soloPlayer.id, weaponId);
      this.ensureViewmodelWeapon(weaponId);
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
        const owned = readout.weapons.some((weapon) => weapon.id === wall.weaponId);
        const cost = owned ? Math.round(wall.cost * CONFIG.economy.wallAmmoFactor) : wall.cost;
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
    candidates.sort((left, right) => left.distance - right.distance);
    return candidates[0]?.prompt ?? null;
  }

  isGameplay(): boolean {
    return this.mode === 'gameplay';
  }

  stop(): void {
    cancelAnimationFrame(this.frameHandle);
    this.frameHandle = 0;
    window.removeEventListener('resize', this.onResize);
    this.controller?.dispose();
    this.enemyRenderer?.dispose();
    this.bunkerMap?.dispose();
    this.audio.dispose();
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

  private buildViewmodel(weaponId: WeaponId): THREE.Group {
    const group = new THREE.Group();
    group.name = `${weaponId}-viewmodel`;
    const metal = new THREE.MeshStandardMaterial({ color: 0x242827, roughness: 0.46, metalness: 0.74 });
    const darkMetal = new THREE.MeshStandardMaterial({ color: 0x111413, roughness: 0.58, metalness: 0.66 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x4a3728, roughness: 0.82 });
    const addBox = (size: [number, number, number], position: [number, number, number], material: THREE.Material = metal): THREE.Mesh => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
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
    const addLongGun = (barrelLength: number, stockLength: number, magazine: 'box' | 'drum' | 'none' = 'box'): void => {
      addBox([0.18, 0.16, stockLength], [0, -0.06, 0.08], grip).rotation.x = -0.04;
      addBox([0.16, 0.15, 0.38], [0, 0.025, -0.34]);
      addBarrel(0.026, barrelLength, [0, 0.04, -0.55 - barrelLength * 0.5]);
      if (magazine === 'box') addBox([0.13, 0.25, 0.15], [0, -0.17, -0.31], darkMetal).rotation.x = 0.12;
      if (magazine === 'drum') {
        const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 0.1, 16), darkMetal);
        drum.rotation.z = Math.PI / 2;
        drum.position.set(0, -0.1, -0.3);
        group.add(drum);
      }
      addBox([0.018, 0.065, 0.025], [0, 0.12, -0.52 - barrelLength]);
    };

    if (weaponId === 'melder') {
      addBox([0.11, 0.1, 0.47], [0, 0, -0.09]);
      addBarrel(0.03, 0.32, [0, 0.005, -0.34]);
      addBox([0.1, 0.24, 0.13], [0, -0.14, 0.08], grip).rotation.x = -0.2;
      addBox([0.018, 0.035, 0.035], [0, 0.067, -0.25], darkMetal);
    } else if (weaponId === 'jaeger') {
      addLongGun(0.72, 0.72, 'none');
      const bolt = addBarrel(0.018, 0.18, [0.14, 0.095, -0.29], metal);
      bolt.rotation.set(0, 0, Math.PI / 2);
      addBox([0.08, 0.055, 0.035], [0, 0.12, -0.25], darkMetal);
      group.scale.setScalar(CONFIG.rendering.viewmodel.jagerScale);
    } else if (weaponId === 'kurier') {
      addLongGun(0.54, 0.58, 'box');
      addBox([0.1, 0.06, 0.26], [0, 0.11, -0.18], grip);
      group.scale.setScalar(1.05);
    } else if (weaponId === 'sturmvogel') {
      addBox([0.18, 0.18, 0.52], [0, 0, -0.23]);
      addBarrel(0.034, 0.38, [0, 0.02, -0.68]);
      addBox([0.13, 0.34, 0.14], [0, -0.22, -0.24], darkMetal).rotation.x = -0.08;
      addBox([0.12, 0.28, 0.12], [0, -0.17, 0.08], grip).rotation.x = -0.24;
    } else if (weaponId === 'doppelhieb') {
      addBox([0.22, 0.18, 0.78], [0, -0.07, 0.02], grip);
      addBarrel(0.037, 0.82, [-0.044, 0.055, -0.72]);
      addBarrel(0.037, 0.82, [0.044, 0.055, -0.72]);
      addBox([0.17, 0.18, 0.2], [0, 0.015, -0.32], metal);
      group.scale.setScalar(1.08);
    } else if (weaponId === 'lasttraeger') {
      addLongGun(0.64, 0.58, 'drum');
      addBox([0.2, 0.08, 0.4], [0, 0.15, -0.31], darkMetal);
      addBarrel(0.012, 0.48, [-0.12, -0.11, -0.73], metal).rotation.z = -0.22;
      addBarrel(0.012, 0.48, [0.12, -0.11, -0.73], metal).rotation.z = 0.22;
    } else if (weaponId === 'richter') {
      addBox([0.13, 0.12, 0.31], [0, 0.01, -0.17]);
      addBarrel(0.037, 0.48, [0, 0.025, -0.54]);
      const cylinder = addBarrel(0.095, 0.15, [0, -0.005, -0.15], metal);
      cylinder.rotation.set(0, 0, Math.PI / 2);
      addBox([0.12, 0.3, 0.14], [0, -0.18, 0.04], grip).rotation.x = -0.24;
    } else if (weaponId === 'grabenfeger') {
      addBox([0.19, 0.17, 0.7], [0, -0.07, 0.05], grip);
      addBarrel(0.038, 0.83, [0, 0.06, -0.76]);
      addBarrel(0.026, 0.7, [0, -0.025, -0.72], metal);
      addBox([0.21, 0.18, 0.31], [0, -0.02, -0.63], grip);
    } else if (weaponId === 'fernblick') {
      addLongGun(0.78, 0.7, 'none');
      addScope([0, 0.19, -0.46], 0.56);
      group.scale.setScalar(1.12);
    } else if (weaponId === 'kettenhund') {
      addLongGun(0.7, 0.52, 'box');
      addBox([0.24, 0.24, 0.5], [0.25, -0.12, -0.28], darkMetal);
      addBox([0.22, 0.1, 0.45], [0, 0.17, -0.31], metal);
      addBarrel(0.012, 0.52, [-0.13, -0.11, -0.8], metal).rotation.z = -0.2;
      addBarrel(0.012, 0.52, [0.13, -0.11, -0.8], metal).rotation.z = 0.2;
      group.scale.setScalar(1.08);
    } else {
      addBox([0.2, 0.18, 0.62], [0, 0, -0.3], new THREE.MeshStandardMaterial({ color: CONFIG.weapons[weaponId].color, emissive: CONFIG.weapons[weaponId].color, emissiveIntensity: 0.24 }));
      addBarrel(0.035, 0.55, [0, 0.02, -0.85]);
    }
    const sleeve = new THREE.MeshStandardMaterial({ color: 0x343b36, roughness: 0.94 });
    const leftArm = new THREE.Mesh(new THREE.CapsuleGeometry(0.055, 0.34, 4, 8), sleeve);
    leftArm.rotation.x = Math.PI / 2.7;
    leftArm.rotation.z = -0.28;
    leftArm.position.set(-0.16, -0.25, 0.13);
    group.add(leftArm);
    const rightArm = leftArm.clone();
    rightArm.position.x = 0.18;
    rightArm.rotation.z = 0.32;
    group.add(rightArm);
    group.traverse((object) => {
      if (object instanceof THREE.Mesh) {
        object.castShadow = false;
        object.renderOrder = 10;
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

  private ensureViewmodelWeapon(weaponId: WeaponId): void {
    if (weaponId === this.viewmodelWeaponId && this.viewmodel !== null) return;
    const prior = this.viewmodel;
    if (prior !== null) {
      this.camera.remove(prior);
      this.disposeObject(prior);
    }
    this.viewmodel = this.buildViewmodel(weaponId);
    this.viewmodelWeaponId = weaponId;
    this.camera.add(this.viewmodel);
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
    return { group, targetPosition: new THREE.Vector3(), targetYaw: 0, targetDowned: false };
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
        this.simulation.update(1000 / CONFIG.simulation.hz, [this.soloPlayer]);
        this.processSoloEvents(this.simulation.drainEvents());
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
    this.muzzleRemainingMs = Math.max(0, this.muzzleRemainingMs - delta * 1000);
    this.viewmodelRecoilM = THREE.MathUtils.lerp(this.viewmodelRecoilM, 0, Math.min(1, delta * 1000 / CONFIG.controller.recoilRecoveryMs));
    if (this.muzzleLight !== null) this.muzzleLight.intensity = this.muzzleRemainingMs > 0 ? CONFIG.rendering.muzzleLightIntensity : 0;
    this.updateViewmodel(controller.getReadout(), delta);
    this.refreshSimulationVisuals();
    const interpolationAlpha = Math.min(1, delta / (CONFIG.coop.interpolationMs / 1000));
    for (const visual of this.remotePlayers.values()) {
      visual.group.position.lerp(visual.targetPosition, interpolationAlpha);
      visual.group.rotation.y = lerpAngle(visual.group.rotation.y, visual.targetYaw, interpolationAlpha);
      visual.group.rotation.z = THREE.MathUtils.lerp(visual.group.rotation.z, visual.targetDowned ? -1.2 : 0, interpolationAlpha);
    }
  }

  private updateViewmodel(readout: ControllerReadout, delta: number): void {
    const simulation = this.getSimulationReadout();
    const weapon = simulation?.weapons[simulation.activeWeaponIndex];
    if (weapon !== undefined) this.ensureViewmodelWeapon(weapon.id);
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
  }

  private refreshSimulationVisuals(): void {
    const readout = this.getSimulationReadout();
    if (readout === null) return;
    this.controller?.setMovementEnabled(!readout.downed && !readout.spectating && !readout.gameOver);
    this.enemyRenderer?.update(readout.enemies);
    this.bunkerMap?.updateBarriers(readout.barriers);
    for (const door of DOORS) this.bunkerMap?.setDoorOpen(door.id, readout.openDoors.includes(door.id));
    this.bunkerMap?.updateCrate(readout.crate, readout.elapsedMs);
    this.bunkerMap?.updateGrenades(readout.thrownGrenades);
    this.bunkerMap?.updatePower(readout.powerOn, readout.powerActivationElapsedMs);
    this.bunkerMap?.updatePowerups(readout.powerups, readout.elapsedMs);
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
      this.sendAction?.({ type: 'fire', ads: controllerReadout.ads });
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
    if (weapon === undefined || readout.reloading || weapon.reserve <= 0 || weapon.magazine >= CONFIG.weapons[weapon.id].magazine) return;
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
    this.nextCosmeticFireAtMs = this.gameplayElapsed * 1000 + CONFIG.controller.weaponSwitchMs;
    this.ensureViewmodelWeapon(readout.weapons[index]!.id);
  };

  private playLocalShot(weaponId: WeaponId): void {
    const definition = CONFIG.weapons[weaponId];
    const horizontal = (this.cosmeticRng.next() * 2 - 1) * definition.recoilHorizontal;
    this.controller?.applyRecoil(definition.recoilVertical, horizontal);
    this.viewmodelRecoilM = CONFIG.rendering.viewmodel.recoilPositionM;
    this.muzzleRemainingMs = CONFIG.rendering.muzzleLightMs;
    this.audio.playShot(weaponId);
    this.pushHudEvent({ type: 'shot' });
  }

  private processFireResult(result: FireResult): void {
    if (result.hit) this.recordHit(result.headshot, result.killed);
    if (result.points !== 0) this.recordPoints(result.points, result.headshot ? 'headshot' : result.killed ? 'body kill' : 'bullet hit');
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
    if (event.type === 'powerupCollected' && typeof event.powerupType === 'string') {
      this.pushHudEvent({ type: 'points', amount: 0, reason: event.powerupType });
    }
  }

  private recordHit(headshot: boolean, killed: boolean): void {
    this.audio.playHitmarker();
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
  };
}
