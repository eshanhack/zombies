import { registerSW } from 'virtual:pwa-register';
import './styles.css';
import { CONFIG } from './config';
import { PreludeScene } from './game/PreludeScene';
import { parseSeed } from './shared/rng';
import type { GameSnapshot } from './shared/types';
import { AppShell } from './ui/AppShell';
import { CoopClient, type LobbyView } from './network/CoopClient';

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
const app = document.querySelector<HTMLElement>('#app');
if (app === null) throw new Error('Application mount point is missing.');

const scene = new PreludeScene(seed);
app.append(scene.canvas);

let activeSeed = seed;
let activeMode: GameSnapshot['mode'] = 'solo';
let activePhase: GameSnapshot['phase'] = 'menu';
let gameplayStarted = false;
const coop = new CoopClient();
const getSnapshot = (): GameSnapshot => {
  const metrics = scene.getMetrics();
  const controller = scene.getControllerReadout();
  const players: GameSnapshot['players'] = controller === null ? [] : [{
    id: 'local',
    name: 'Wanderer',
    position: { x: controller.x, y: controller.y, z: controller.z },
    velocity: { x: controller.vx, y: controller.vy, z: controller.vz },
    yaw: controller.yaw,
    pitch: controller.pitch,
    hp: CONFIG.player.maxHp,
    maxHp: CONFIG.player.maxHp,
    points: CONFIG.points.starting,
    staminaMs: controller.staminaMs,
    weapons: [{ id: 'melder', magazine: CONFIG.weapons.melder.magazine, reserve: CONFIG.weapons.melder.reserve, upgraded: false }],
    activeWeaponIndex: 0,
    grenades: CONFIG.combat.maxGrenades,
    perks: [],
    downed: false,
    spectating: false,
    connected: true,
    stats: { kills: 0, headshots: 0, shots: 0, hits: 0, pointsEarned: 0, doorsOpened: 0, crateRolls: 0, revives: 0, downs: 0 },
  }];
  return {
    seed: activeSeed,
    mode: activeMode,
    phase: activePhase,
    round: 0,
    roundIsWolves: false,
    spawned: 0,
    queued: 0,
    elapsedMs: 0,
    powerOn: false,
    doorsOpen: [false, false, false],
    players,
    enemies: [],
    barriers: [],
    powerups: [],
    drawCalls: metrics.drawCalls,
    fps: metrics.fps,
  };
};

const startGameplay = (mode: GameSnapshot['mode']): void => {
  if (gameplayStarted) return;
  gameplayStarted = true;
  activeMode = mode;
  activePhase = mode === 'solo' ? 'playing' : 'intermission';
  shell.startGameplay();
  scene.enterGameplay({ mode, sendInput: mode === 'coop' ? (input) => coop.sendInput(input) : undefined });
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
});
app.append(shell.root);
shell.setSnapshotProvider(getSnapshot);
coop.onLobbyChange(renderLobby);
coop.onMovement((local, players) => {
  if (local !== null) scene.reconcileLocalPlayer(local);
  scene.updateRemotePlayers(players);
});

window.__STAHLBUNKER_DEBUG__ = {
  version: 1,
  seed,
  snapshot: getSnapshot,
  command: (name) => scene.command(name),
};

scene.start();
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
if (!('serviceWorker' in navigator)) shell.setOfflineStatus(import.meta.env.DEV ? 'dev bypass' : 'unsupported');

document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  scene.start();
});

void CONFIG;
