import { CONFIG } from '../config';
import type { GameSnapshot } from '../shared/types';
import type { PreludeScene } from '../game/PreludeScene';
import type { LobbyView } from '../network/CoopClient';

type MenuAction = 'solo' | 'create' | 'join' | 'settings' | 'records';

export interface AppShellHandlers {
  onAction(action: MenuAction): void;
  onJoin(roomCode: string, name: string): Promise<void>;
  onReady(ready: boolean): void;
  onStart(): void;
  onLeave(): Promise<void>;
}

export class AppShell {
  readonly root: HTMLElement;
  private readonly overlay: HTMLElement;
  private readonly metricValue: HTMLElement;
  private readonly seedValue: HTMLElement;
  private readonly joinPanel: HTMLFormElement;
  private readonly settingsPanel: HTMLElement;
  private readonly recordsPanel: HTMLElement;
  private readonly lobbyPanel: HTMLElement;
  private readonly handlers: AppShellHandlers;
  private snapshotProvider: () => GameSnapshot | null = () => null;

  constructor(seed: number, scene: PreludeScene, handlers: AppShellHandlers) {
    this.handlers = handlers;
    this.root = document.createElement('main');
    this.root.className = 'app-shell';
    this.root.innerHTML = `
      <div class="grain" aria-hidden="true"></div>
      <div class="scanline" aria-hidden="true"></div>
      <section class="menu-panel" aria-labelledby="game-title">
        <div class="classification">OBJEKT 17 · NACHTPROTOKOLL</div>
        <h1 id="game-title"><span>STAHL</span><span>BUNKER</span></h1>
        <div class="year-mark"><i></i><b>1945</b><i></i></div>
        <p class="tagline">The dead remember every door you opened.</p>
        <nav class="menu-actions" aria-label="Main menu">
          <button type="button" data-action="solo"><span>Solo</span><small>Begin a local run</small></button>
          <button type="button" data-action="create"><span>Create Co-op</span><small>Private room · up to four</small></button>
          <button type="button" data-action="join"><span>Join Co-op</span><small>Enter an invite code</small></button>
          <button type="button" data-action="settings"><span>Settings</span></button>
          <button type="button" data-action="records"><span>Records</span></button>
        </nav>
        <div class="menu-footer"><kbd>F1</kbd> diagnostics <span>·</span> seed <b>${seed}</b></div>
      </section>
      <aside class="status-rail" aria-label="Bunker status">
        <div><span>POWER</span><strong class="status-off">OFFLINE</strong></div>
        <div><span>SECTOR</span><strong>START HALL</strong></div>
        <div><span>WEATHER</span><strong>FOG / −6°C</strong></div>
      </aside>
    `;

    this.overlay = document.createElement('section');
    this.overlay.id = 'debug-overlay';
    this.overlay.className = 'debug-overlay is-hidden';
    this.overlay.innerHTML = `
      <header><b>F1 · SYSTEM DIAGNOSTICS</b><span>P0 FOUNDATION</span></header>
      <dl>
        <div><dt>Seed lock</dt><dd data-debug="seed">${seed}</dd></div>
        <div><dt>Renderer</dt><dd data-debug="metrics">sampling…</dd></div>
        <div><dt>Offline cache</dt><dd data-debug="offline">registering…</dd></div>
        <div><dt>Phase</dt><dd data-debug="phase">menu</dd></div>
        <div><dt>Round</dt><dd data-debug="round">0</dd></div>
        <div><dt>Spawn / alive / queued</dt><dd data-debug="counts">0 / 0 / 0</dd></div>
      </dl>
      <div class="debug-actions">
        <button data-debug-action="points">Give 10,000 points</button>
        <button data-debug-action="skip">Skip round</button>
        <button data-debug-action="spawn">Spawn nearest</button>
        <button data-debug-action="kill">Kill all</button>
        <button data-debug-action="god">God mode</button>
        <button data-debug-action="noclip">Noclip</button>
        <button data-debug-action="nav">Navgraph</button>
        <button data-debug-action="hp">HP bars</button>
      </div>
    `;
    this.metricValue = this.overlay.querySelector('[data-debug="metrics"]') as HTMLElement;
    this.seedValue = this.overlay.querySelector('[data-debug="seed"]') as HTMLElement;
    this.root.append(this.overlay);

    this.joinPanel = document.createElement('form');
    this.joinPanel.className = 'modal-card is-hidden';
    this.joinPanel.innerHTML = `
      <button type="button" class="modal-close" aria-label="Close">×</button>
      <p class="eyebrow">Encrypted field channel</p>
      <h2>Join a private bunker</h2>
      <label>Invite code<input name="code" maxlength="6" autocomplete="off" placeholder="A7K9PX" pattern="[A-Za-z0-9]{6}" required /></label>
      <label>Callsign<input name="name" maxlength="${CONFIG.coop.maxDisplayNameLength}" autocomplete="nickname" value="Wanderer" required /></label>
      <button class="confirm-button" type="submit">Connect</button>
      <p class="form-status" aria-live="polite"></p>
    `;
    this.root.append(this.joinPanel);

    this.settingsPanel = document.createElement('section');
    this.settingsPanel.className = 'modal-card is-hidden';
    this.settingsPanel.innerHTML = `
      <button type="button" class="modal-close" aria-label="Close">×</button>
      <p class="eyebrow">Field adjustments</p><h2>Settings</h2>
      <label>Field of view <output>${CONFIG.player.fovDeg}°</output><input data-setting="fov" type="range" min="65" max="90" value="${CONFIG.player.fovDeg}" /></label>
      <label>Mouse sensitivity <output>1.00</output><input data-setting="sensitivity" type="range" min="0.5" max="2" step="0.05" value="1" /></label>
      <label>Master volume <output>72%</output><input data-setting="volume" type="range" min="0" max="1" step="0.01" value="${CONFIG.audio.masterGain}" /></label>
    `;
    this.root.append(this.settingsPanel);

    this.recordsPanel = document.createElement('section');
    this.recordsPanel.className = 'modal-card is-hidden';
    const record = this.loadBestRound();
    this.recordsPanel.innerHTML = `
      <button type="button" class="modal-close" aria-label="Close">×</button>
      <p class="eyebrow">Recovered field report</p><h2>Records</h2>
      <div class="record-number">${record}</div><p>Best round survived</p>
    `;
    this.root.append(this.recordsPanel);

    this.lobbyPanel = document.createElement('section');
    this.lobbyPanel.className = 'lobby-card is-hidden';
    this.lobbyPanel.dataset.testid = 'coop-lobby';
    this.root.append(this.lobbyPanel);

    this.root.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
      button.addEventListener('click', () => handlers.onAction(button.dataset.action as MenuAction));
    });
    this.root.querySelectorAll<HTMLButtonElement>('.modal-close').forEach((button) => {
      button.addEventListener('click', () => this.closeModals());
    });
    this.joinPanel.addEventListener('submit', (event) => {
      event.preventDefault();
      const fields = new FormData(this.joinPanel);
      const code = String(fields.get('code') ?? '');
      const name = String(fields.get('name') ?? 'Wanderer');
      this.setJoinStatus('Establishing encrypted field channel…');
      const button = this.joinPanel.querySelector<HTMLButtonElement>('.confirm-button');
      if (button !== null) button.disabled = true;
      void handlers.onJoin(code, name).catch((error: unknown) => {
        this.setJoinStatus(error instanceof Error ? error.message : 'Connection failed.', true);
      }).finally(() => {
        if (button !== null) button.disabled = false;
      });
    });
    this.bindSettings();

    window.addEventListener('keydown', (event) => {
      if (event.code === 'F1') {
        event.preventDefault();
        this.overlay.classList.toggle('is-hidden');
      }
    });

    window.setInterval(() => {
      const metrics = scene.getMetrics();
      this.metricValue.textContent = `${metrics.fps} FPS · ${metrics.drawCalls} calls`;
      const snapshot = this.snapshotProvider();
      if (snapshot !== null) this.renderSnapshot(snapshot);
    }, 250);
  }

  setSnapshotProvider(provider: () => GameSnapshot | null): void {
    this.snapshotProvider = provider;
  }

  openJoin(): void {
    this.closeModals();
    this.joinPanel.classList.remove('is-hidden');
    this.joinPanel.querySelector<HTMLInputElement>('input')?.focus();
  }

  openSettings(): void {
    this.closeModals();
    this.settingsPanel.classList.remove('is-hidden');
  }

  openRecords(): void {
    this.closeModals();
    this.recordsPanel.classList.remove('is-hidden');
  }

  setJoinStatus(message: string, isError = false): void {
    const status = this.joinPanel.querySelector<HTMLElement>('.form-status');
    if (status === null) return;
    status.textContent = message;
    status.classList.toggle('is-error', isError);
  }

  setOfflineStatus(status: string): void {
    const value = this.overlay.querySelector<HTMLElement>('[data-debug="offline"]');
    if (value !== null) value.textContent = status;
  }

  showLobby(view: LobbyView): void {
    this.closeModals();
    this.lobbyPanel.classList.remove('is-hidden');
    const self = view.players.find((player) => player.isSelf);
    this.lobbyPanel.innerHTML = `
      <p class="eyebrow">Private field channel</p>
      <div class="lobby-heading"><div><span>ROOM CODE</span><strong data-testid="room-code">${view.roomCode}</strong></div><div><span>LOCKED SEED</span><strong data-testid="lobby-seed">${view.seed}</strong></div></div>
      <div class="lobby-roster" aria-label="Player roster">
        ${view.players.map((player) => `<div class="lobby-player${player.isSelf ? ' is-self' : ''}" data-player-id="${player.id}"><i class="connection-dot${player.connected ? ' is-online' : ''}"></i><b>${this.escapeHtml(player.name)}</b>${player.isHost ? '<em>HOST</em>' : ''}<span>${player.ready ? 'READY' : 'STANDING BY'}</span></div>`).join('')}
      </div>
      <p class="lobby-state" data-testid="lobby-state">${view.started ? 'Roster locked · deployment beginning' : `${view.players.length} / ${CONFIG.coop.maxPlayers} operatives connected`}</p>
      <div class="lobby-actions">
        <button type="button" data-lobby-action="ready">${self?.ready ? 'Stand down' : 'Ready up'}</button>
        <button type="button" data-lobby-action="start"${view.isHost && !view.started ? '' : ' disabled'}>Begin operation</button>
        <button type="button" data-lobby-action="leave">Leave channel</button>
      </div>
    `;
    this.bindLobbyActions(Boolean(self?.ready));
  }

  hideLobby(): void {
    this.lobbyPanel.classList.add('is-hidden');
  }

  closeModals(): void {
    this.joinPanel.classList.add('is-hidden');
    this.settingsPanel.classList.add('is-hidden');
    this.recordsPanel.classList.add('is-hidden');
  }

  private renderSnapshot(snapshot: GameSnapshot): void {
    this.seedValue.textContent = String(snapshot.seed);
    (this.overlay.querySelector('[data-debug="phase"]') as HTMLElement).textContent = snapshot.phase;
    (this.overlay.querySelector('[data-debug="round"]') as HTMLElement).textContent = String(snapshot.round);
    (this.overlay.querySelector('[data-debug="counts"]') as HTMLElement).textContent = `${snapshot.spawned} / ${snapshot.enemies.length} / ${snapshot.queued}`;
  }

  private bindSettings(): void {
    this.settingsPanel.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
      input.addEventListener('input', () => {
        const output = input.parentElement?.querySelector('output');
        if (output === null || output === undefined) return;
        if (input.dataset.setting === 'fov') output.value = `${input.value}°`;
        if (input.dataset.setting === 'sensitivity') output.value = Number(input.value).toFixed(2);
        if (input.dataset.setting === 'volume') output.value = `${Math.round(Number(input.value) * 100)}%`;
      });
    });
  }

  private bindLobbyActions(selfReady: boolean): void {
    this.lobbyPanel.querySelector<HTMLButtonElement>('[data-lobby-action="ready"]')?.addEventListener('click', () => this.handlers.onReady(!selfReady));
    this.lobbyPanel.querySelector<HTMLButtonElement>('[data-lobby-action="start"]')?.addEventListener('click', () => this.handlers.onStart());
    this.lobbyPanel.querySelector<HTMLButtonElement>('[data-lobby-action="leave"]')?.addEventListener('click', () => {
      void this.handlers.onLeave().then(() => this.hideLobby());
    });
  }

  private escapeHtml(value: string): string {
    const element = document.createElement('span');
    element.textContent = value;
    return element.innerHTML;
  }

  private loadBestRound(): number {
    try {
      const stored = localStorage.getItem(CONFIG.storage.recordsKey);
      if (stored === null) return 0;
      return Number((JSON.parse(stored) as { bestRound?: number }).bestRound ?? 0);
    } catch {
      return 0;
    }
  }
}
