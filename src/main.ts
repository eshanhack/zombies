import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { CONFIG } from './config';
import { PreludeScene } from './game/PreludeScene';
import { parseSeed } from './shared/rng';
import type { GameSnapshot } from './shared/types';
import { AppShell } from './ui/AppShell';
import { CoopClient, type LobbyView } from './network/CoopClient';
import { WINDOWS } from './map/blueprint';
import type { RoomId } from './config';

declare global {
  interface Window {
    __consoleErrors: string[];
    __STAHLBUNKER_DEBUG__: {
      version: 1;
      seed: number;
      snapshot: () => GameSnapshot | null;
      command: (name: string) => boolean;
    };
  }
}

window.__consoleErrors = [];
window.addEventListener('error', (event) => window.__consoleErrors.push(event.message));
window.addEventListener('unhandledrejection', (event) => window.__consoleErrors.push(String(event.reason)));

const seed = parseSeed(window.location.search);
const savedSettings = loadSettings();
const app = document.querySelector<HTMLElement>('#app');
if (app === null) throw new Error('Application mount point is missing.');

const scene = new PreludeScene(seed);
scene.setFieldOfView(savedSettings.fov);
scene.setSensitivityMultiplier(savedSettings.sensitivity);
scene.setMasterVolume(savedSettings.volume);
app.append(scene.canvas);

let activeSeed = seed;
let activeMode: GameSnapshot['mode'] = 'solo';
let activePhase: GameSnapshot['phase'] = 'menu';
let gameplayStarted = false;
const coop = new CoopClient();
const getSnapshot = (): GameSnapshot => {
  const metrics = scene.getMetrics();
  const controller = scene.getControllerReadout();
  const simulation = scene.getSimulationReadout();
  const players: GameSnapshot['players'] = controller === null ? [] : [{
    id: 'local',
    name: 'Wanderer',
    position: { x: controller.x, y: controller.y, z: controller.z },
    velocity: { x: controller.vx, y: controller.vy, z: controller.vz },
    yaw: controller.yaw,
    pitch: controller.pitch,
    hp: simulation?.hp ?? CONFIG.player.maxHp,
    maxHp: simulation?.maxHp ?? CONFIG.player.maxHp,
    points: simulation?.points ?? CONFIG.points.starting,
    staminaMs: controller.staminaMs,
    weapons: simulation?.weapons.map((weapon) => ({ ...weapon })) ?? [{ id: 'melder', magazine: CONFIG.weapons.melder.magazine, reserve: CONFIG.weapons.melder.reserve, upgraded: false }],
    activeWeaponIndex: simulation?.activeWeaponIndex ?? 0,
    grenades: simulation?.grenades ?? CONFIG.combat.maxGrenades,
    perks: simulation?.perks.slice() ?? [],
    downed: simulation?.downed ?? false,
    spectating: simulation?.spectating ?? false,
    connected: true,
    stats: {
      kills: simulation?.stats.kills ?? 0,
      headshots: simulation?.stats.headshots ?? 0,
      shots: simulation?.stats.shots ?? 0,
      hits: simulation?.stats.hits ?? 0,
      pointsEarned: simulation?.stats.pointsEarned ?? 0,
      doorsOpened: simulation?.stats.doorsOpened ?? 0,
      crateRolls: simulation?.stats.crateRolls ?? 0,
      revives: 0,
      downs: 0,
    },
  }];
  return {
    seed: activeSeed,
    mode: activeMode,
    phase: simulation?.phase ?? activePhase,
    round: simulation?.round ?? 0,
    roundIsWolves: simulation?.roundKind === 'wolves',
    spawned: simulation?.spawned ?? 0,
    queued: simulation?.queued ?? 0,
    elapsedMs: simulation?.elapsedMs ?? 0,
    powerOn: simulation?.powerOn ?? false,
    forge: simulation?.forge ?? { phase: 'idle', playerId: '', weaponId: '', remainingMs: 0 },
    doorsOpen: ['doorA', 'doorB', 'doorC'].map((doorId) => simulation?.openDoors.includes(doorId) ?? false),
    players,
    enemies: simulation?.enemies.map((enemy) => ({
      id: enemy.id,
      kind: enemy.kind,
      state: enemy.state,
      position: { x: enemy.x, y: enemy.y, z: enemy.z },
      velocity: { x: 0, y: 0, z: 0 },
      yaw: enemy.yaw,
      hp: enemy.hp,
      maxHp: enemy.maxHp,
      speed: enemy.speed,
      room: WINDOWS.find((window) => window.id === enemy.barrierId)?.room ?? 'start',
      targetPlayerId: enemy.targetPlayerId,
      headless: false,
      spawnProgress: enemy.spawnProgress,
      stateTimeMs: enemy.stateTimeMs,
    })) ?? [],
    barriers: simulation?.barriers.map((barrier) => ({
      id: barrier.id,
      room: normalizeRoom(barrier.room),
      boards: barrier.boards,
    })) ?? [],
    powerups: simulation?.powerups.map((powerup) => ({
      id: powerup.id,
      type: powerup.powerupType,
      position: { x: powerup.x, y: powerup.y, z: powerup.z },
      spawnedAtMs: simulation.elapsedMs - (CONFIG.powerups.despawnMs - powerup.remainingMs),
    })) ?? [],
    drawCalls: metrics.drawCalls,
    fps: metrics.fps,
    medianFrameMs: metrics.medianFrameMs,
    p95FrameMs: metrics.p95FrameMs,
  };
};

const startGameplay = (mode: GameSnapshot['mode']): void => {
  if (gameplayStarted) return;
  gameplayStarted = true;
  activeMode = mode;
  activePhase = mode === 'solo' ? 'playing' : 'intermission';
  shell.startGameplay();
  scene.enterGameplay({
    mode,
    seed: activeSeed,
    sendInput: mode === 'coop' ? (input) => coop.sendInput(input) : undefined,
    sendAction: mode === 'coop' ? (action) => coop.sendAction(action) : undefined,
  });
};

const renderLobby = (view: LobbyView): void => {
  activeSeed = view.seed;
  activeMode = 'coop';
  activePhase = view.started ? 'intermission' : 'lobby';
  if (view.started) startGameplay('coop');
  else shell.showLobby(view);
};

const shell = new AppShell(seed, scene, {
  onAction(action) {
    if (action === 'join') shell.openJoin();
    if (action === 'settings') shell.openSettings();
    if (action === 'records') shell.openRecords();
    if (action === 'solo') startGameplay('solo');
    if (action === 'resume') {
      void coop.resume().then((resumed) => {
        if (!resumed) throw new Error('No resumable operation was found.');
      }).catch((error: unknown) => {
        shell.openJoin();
        shell.setJoinStatus(error instanceof Error ? error.message : 'The prior operation has expired.', true);
      });
    }
    if (action === 'create') {
      void coop.create('Wanderer').catch((error: unknown) => {
        shell.openJoin();
        shell.setJoinStatus(error instanceof Error ? error.message : 'Unable to create room.', true);
      });
    }
  },
  async onJoin(roomCode, name) {
    await coop.join(roomCode, name);
  },
  onReady(ready) {
    coop.setReady(ready);
  },
  onStart() {
    coop.start();
  },
  async onLeave() {
    await coop.leave();
    activeSeed = seed;
    activeMode = 'solo';
    activePhase = 'menu';
  },
  onSetting(setting, value) {
    if (setting === 'volume') scene.setMasterVolume(value);
    if (setting === 'fov') scene.setFieldOfView(value);
    if (setting === 'sensitivity') scene.setSensitivityMultiplier(value);
  },
  onRestart() {
    if (activeMode === 'solo') {
      activePhase = 'playing';
      scene.restartSolo(activeSeed);
      shell.resetForRestart();
      return;
    }
    window.location.reload();
  },
}, coop.hasResumeToken());
app.append(shell.root);
shell.setSnapshotProvider(getSnapshot);
const syncNetworkAvailability = (): void => shell.setNetworkAvailability(navigator.onLine);
syncNetworkAvailability();
window.addEventListener('online', syncNetworkAvailability);
window.addEventListener('offline', syncNetworkAvailability);
coop.onLobbyChange(renderLobby);
coop.onMovement((local, players) => {
  if (local !== null) scene.reconcileLocalPlayer(local);
  scene.updateRemotePlayers(players);
});
coop.onSimulation((view) => scene.applyNetworkSimulation(view));
coop.onFeedback((feedback) => scene.applyNetworkFeedback(feedback));

window.__STAHLBUNKER_DEBUG__ = {
  version: 1,
  seed,
  snapshot: getSnapshot,
  command: (name) => scene.command(name),
};

scene.start();
const bootScreen = document.querySelector<HTMLElement>('#boot-screen');
if (bootScreen !== null) {
  document.documentElement.style.setProperty('--boot-fade-ms', `${CONFIG.presentation.bootFadeMs}ms`);
  requestAnimationFrame(() => {
    bootScreen.classList.add('is-ready');
    window.setTimeout(() => bootScreen.remove(), CONFIG.presentation.bootFadeMs);
  });
}
if (import.meta.env.DEV) {
  shell.setOfflineStatus('dev bypass');
} else {
  const controlledAtBoot = 'serviceWorker' in navigator && navigator.serviceWorker.controller !== null;
  let refreshedForServiceWorkerUpdate = false;
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (!controlledAtBoot || refreshedForServiceWorkerUpdate) return;
      refreshedForServiceWorkerUpdate = true;
      if (scene.isGameplay()) {
        shell.setOfflineStatus('update ready · reload after run');
        return;
      }
      window.location.reload();
    });
  }
  registerSW({
    immediate: true,
    onRegisteredSW() {
      shell.setOfflineStatus('ready');
    },
    onRegisterError(error) {
      shell.setOfflineStatus('failed');
      window.__consoleErrors.push(`Service worker: ${String(error)}`);
    },
  });
  if (!('serviceWorker' in navigator)) shell.setOfflineStatus('unsupported');
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  scene.start();
});

void CONFIG;

function normalizeRoom(value: string): RoomId {
  return value === 'armory' || value === 'generator' || value === 'catwalk' ? value : 'start';
}

function loadSettings(): { fov: number; sensitivity: number; volume: number } {
  try {
    const raw = localStorage.getItem(CONFIG.storage.settingsKey);
    const value = raw === null ? {} : JSON.parse(raw) as { fov?: number; sensitivity?: number; volume?: number };
    return {
      fov: Math.max(65, Math.min(90, Number(value.fov ?? CONFIG.player.fovDeg))),
      sensitivity: Math.max(0.5, Math.min(2, Number(value.sensitivity ?? 1))),
      volume: Math.max(0, Math.min(1, Number(value.volume ?? CONFIG.audio.masterGain))),
    };
  } catch {
    return { fov: CONFIG.player.fovDeg, sensitivity: 1, volume: CONFIG.audio.masterGain };
  }
}
