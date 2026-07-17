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
const coop = new CoopClient();
const getSnapshot = (): GameSnapshot => {
  const metrics = scene.getMetrics();
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
    players: [],
    enemies: [],
    barriers: [],
    powerups: [],
    drawCalls: metrics.drawCalls,
    fps: metrics.fps,
  };
};

const renderLobby = (view: LobbyView): void => {
  activeSeed = view.seed;
  activeMode = 'coop';
  activePhase = view.started ? 'intermission' : 'lobby';
  shell.showLobby(view);
};

const shell = new AppShell(seed, scene, {
  onAction(action) {
    if (action === 'join') shell.openJoin();
    if (action === 'settings') shell.openSettings();
    if (action === 'records') shell.openRecords();
    if (action === 'solo') document.body.dispatchEvent(new CustomEvent('stahlbunker:start-solo'));
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

window.__STAHLBUNKER_DEBUG__ = {
  version: 1,
  seed,
  snapshot: getSnapshot,
  command: () => false,
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
