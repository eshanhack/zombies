import { CONFIG } from '../config';
import type { GameSnapshot } from '../shared/types';
import type { PreludeScene } from '../game/PreludeScene';
import type { LobbyView } from '../network/CoopClient';

type MenuAction = 'solo' | 'create' | 'join' | 'resume' | 'settings' | 'records';

export interface AppShellHandlers {
  onAction(action: MenuAction): void;
  onJoin(roomCode: string, name: string): Promise<void>;
  onReady(ready: boolean): void;
  onStart(): void;
  onLeave(): Promise<void>;
  onSetting(setting: 'fov' | 'sensitivity' | 'volume', value: number): void;
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
  private readonly hud: HTMLElement;
  private readonly stamina: HTMLElement;
  private readonly interactionPrompt: HTMLElement;
  private readonly hitmarker: HTMLElement;
  private readonly damageVignette: HTMLElement;
  private readonly pointsValue: HTMLElement;
  private readonly pointLedger: HTMLElement;
  private readonly weaponName: HTMLElement;
  private readonly ammoValue: HTMLElement;
  private readonly grenadeValue: HTMLElement;
  private readonly reserveValue: HTMLElement;
  private readonly reloadStatus: HTMLElement;
  private readonly perkRow: HTMLElement;
  private readonly effectRow: HTMLElement;
  private readonly lifeOverlay: HTMLElement;
  private readonly powerStatus: HTMLElement;
  private readonly roundCanvas: HTMLCanvasElement;
  private readonly lockPrompt: HTMLButtonElement;
  private readonly controllerValue: HTMLElement;
  private readonly handlers: AppShellHandlers;
  private snapshotProvider: () => GameSnapshot | null = () => null;
  private displayedRound = -1;

  constructor(seed: number, scene: PreludeScene, handlers: AppShellHandlers, resumeAvailable = false) {
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
          ${resumeAvailable ? '<button type="button" data-action="resume"><span>Resume Co-op</span><small>Return to your locked roster</small></button>' : ''}
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
    this.powerStatus = this.root.querySelector('.status-rail strong') as HTMLElement;

    this.overlay = document.createElement('section');
    this.overlay.id = 'debug-overlay';
    this.overlay.className = 'debug-overlay is-hidden';
    this.overlay.innerHTML = `
      <header><b>F1 · SYSTEM DIAGNOSTICS</b><span>P7 PRODUCTION AUDIO</span></header>
      <dl>
        <div><dt>Seed lock</dt><dd data-debug="seed">${seed}</dd></div>
        <div><dt>Renderer</dt><dd data-debug="metrics">sampling…</dd></div>
        <div><dt>Offline cache</dt><dd data-debug="offline">registering…</dd></div>
        <div><dt>Phase</dt><dd data-debug="phase">menu</dd></div>
        <div><dt>Round</dt><dd data-debug="round">0</dd></div>
        <div><dt>Spawn / alive / queued</dt><dd data-debug="counts">0 / 0 / 0</dd></div>
        <div><dt>HP / points</dt><dd data-debug="vitals">100 / 500</dd></div>
        <div><dt>Weapon</dt><dd data-debug="weapon">Melder · 8 / 32</dd></div>
        <div><dt>Barrier boards</dt><dd data-debug="barriers">0 / 0</dd></div>
        <div><dt>Enemy states</dt><dd data-debug="enemy-states">none</dd></div>
        <div><dt>Doors / crate / grenades</dt><dd data-debug="economy">0 · closed · 4</dd></div>
        <div><dt>Power / perks / effects</dt><dd data-debug="systems">OFF · 0 · none</dd></div>
        <div><dt>Round species</dt><dd data-debug="species">zombies</dd></div>
        <div><dt>Audio graph</dt><dd data-debug="audio">48 kHz · uninitialized</dd></div>
        <div><dt>Audio localization</dt><dd data-debug="localization">not run</dd></div>
        <div><dt>Console errors</dt><dd data-debug="errors">0</dd></div>
        <div><dt>Controller</dt><dd data-debug="controller">menu</dd></div>
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
        <button data-debug-action="jager">Grant Jäger K-8</button>
        <button data-debug-action="arsenal">Cycle conventional weapon</button>
        <button data-debug-action="target">Spawn aim target</button>
        <button data-debug-action="power">Activate power</button>
        <button data-debug-action="perk">Cycle perk</button>
        <button data-debug-action="powerup">Cycle power-up</button>
        <button data-debug-action="wolves">Start wolf round</button>
        <button data-debug-action="wonder">Cycle wonder weapon</button>
        <button data-debug-action="forge">Upgrade active weapon</button>
        <button data-debug-action="pack">Spawn round-25 ten-pack</button>
        <button data-debug-action="fire">Fire active weapon</button>
        <button data-debug-action="forgeview">Stage Forge visual gate</button>
        <button data-debug-action="audio">Run left/right breach cue</button>
      </div>
    `;
    this.metricValue = this.overlay.querySelector('[data-debug="metrics"]') as HTMLElement;
    this.seedValue = this.overlay.querySelector('[data-debug="seed"]') as HTMLElement;
    this.controllerValue = this.overlay.querySelector('[data-debug="controller"]') as HTMLElement;
    this.root.append(this.overlay);

    this.hud = document.createElement('section');
    this.hud.className = 'game-hud is-hidden';
    this.hud.style.setProperty('--hitmarker-ms', `${CONFIG.combat.hitmarkerMs}ms`);
    this.hud.style.setProperty('--damage-ms', `${CONFIG.combat.damageVignetteMs}ms`);
    this.hud.setAttribute('aria-label', 'Player status');
    this.hud.innerHTML = `
      <div class="crosshair" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="hitmarker" aria-hidden="true"><i></i><i></i><i></i><i></i></div>
      <div class="damage-vignette" aria-hidden="true"></div>
      <div class="interaction-prompt is-hidden" aria-live="polite"></div>
      <div class="stamina-meter" aria-label="Sprint stamina"><span></span></div>
      <div class="round-hud" aria-label="Current round"><canvas width="180" height="96"></canvas></div>
      <div class="points-hud"><div class="point-ledger" aria-live="polite"></div><strong>500</strong></div>
      <div class="perk-row" aria-label="Owned perks"></div>
      <div class="effect-row" aria-live="polite"></div>
      <div class="life-state-overlay is-hidden" aria-live="assertive"></div>
      <div class="weapon-hud"><span class="weapon-name">Melder</span><div><strong class="ammo-value">8</strong><i>/</i><b>32</b></div><small class="reload-status"></small><em>◆ × 4</em></div>
    `;
    this.stamina = this.hud.querySelector('.stamina-meter') as HTMLElement;
    this.interactionPrompt = this.hud.querySelector('.interaction-prompt') as HTMLElement;
    this.hitmarker = this.hud.querySelector('.hitmarker') as HTMLElement;
    this.damageVignette = this.hud.querySelector('.damage-vignette') as HTMLElement;
    this.pointsValue = this.hud.querySelector('.points-hud strong') as HTMLElement;
    this.pointLedger = this.hud.querySelector('.point-ledger') as HTMLElement;
    this.weaponName = this.hud.querySelector('.weapon-name') as HTMLElement;
    this.ammoValue = this.hud.querySelector('.ammo-value') as HTMLElement;
    this.grenadeValue = this.hud.querySelector('.weapon-hud em') as HTMLElement;
    this.reserveValue = this.hud.querySelector('.weapon-hud b') as HTMLElement;
    this.reloadStatus = this.hud.querySelector('.reload-status') as HTMLElement;
    this.perkRow = this.hud.querySelector('.perk-row') as HTMLElement;
    this.effectRow = this.hud.querySelector('.effect-row') as HTMLElement;
    this.lifeOverlay = this.hud.querySelector('.life-state-overlay') as HTMLElement;
    this.roundCanvas = this.hud.querySelector('.round-hud canvas') as HTMLCanvasElement;
    this.drawRound(0, false);
    this.root.append(this.hud);

    this.lockPrompt = document.createElement('button');
    this.lockPrompt.type = 'button';
    this.lockPrompt.className = 'pointer-lock-prompt is-hidden';
    this.lockPrompt.textContent = 'Click to enter the bunker';
    this.lockPrompt.addEventListener('click', () => {
      if (scene.getControllerReadout()?.locked) return;
      try {
        void scene.canvas.requestPointerLock().catch(() => undefined);
      } catch {
        // The embedded verification browser can reject pointer lock without affecting gameplay state.
      }
    });
    this.root.append(this.lockPrompt);

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
    this.overlay.querySelectorAll<HTMLButtonElement>('[data-debug-action]').forEach((button) => {
      button.addEventListener('click', () => window.__STAHLBUNKER_DEBUG__?.command(button.dataset.debugAction ?? ''));
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
      if (snapshot !== null) {
        this.renderSnapshot(snapshot);
        const combat = scene.getSimulationReadout();
        const weapon = combat?.weapons[combat.activeWeaponIndex];
        const economy = this.overlay.querySelector<HTMLElement>('[data-debug="economy"]');
        if (economy !== null && combat !== null) economy.textContent = `${combat.openDoors.length} · ${combat.crate.phase} @ ${combat.crate.activeLocationId} · ${combat.grenades}`;
        const systems = this.overlay.querySelector<HTMLElement>('[data-debug="systems"]');
        if (systems !== null && combat !== null) {
          const activeEffects = [
            combat.instaKillRemainingMs > 0 ? `IK ${(combat.instaKillRemainingMs / 1000).toFixed(1)}` : '',
            combat.doublePointsRemainingMs > 0 ? `2X ${(combat.doublePointsRemainingMs / 1000).toFixed(1)}` : '',
          ].filter(Boolean).join(' / ') || 'none';
          systems.textContent = `${combat.powerOn ? 'ON' : 'OFF'} · ${combat.perks.length} · ${activeEffects} · Forge ${combat.forge.phase}`;
        }
        const species = this.overlay.querySelector<HTMLElement>('[data-debug="species"]');
        if (species !== null && combat !== null) species.textContent = `${combat.roundKind} · next wolves ${combat.nextWolfRound}`;
        const audioDiagnostics = scene.getAudioDiagnostics();
        const audioValue = this.overlay.querySelector<HTMLElement>('[data-debug="audio"]');
        if (audioValue !== null) {
          audioValue.textContent = `${Math.round(audioDiagnostics.sampleRateHz / 1000)} kHz · ${audioDiagnostics.state} · ${audioDiagnostics.activeVoices} voices · ${audioDiagnostics.estimatedHeadroomDb.toFixed(1)} dB · ${audioDiagnostics.lastCue}`;
        }
        const localization = this.overlay.querySelector<HTMLElement>('[data-debug="localization"]');
        if (localization !== null) localization.textContent = audioDiagnostics.localizationGate;
        const errors = this.overlay.querySelector<HTMLElement>('[data-debug="errors"]');
        if (errors !== null) errors.textContent = String(window.__consoleErrors.length);
        this.pointsValue.textContent = String(combat?.points ?? snapshot.players[0]?.points ?? 0);
        if (weapon !== undefined) {
          this.weaponName.textContent = `${weapon.upgraded ? 'Über-' : ''}${CONFIG.weapons[weapon.id].name}`;
          this.ammoValue.textContent = String(weapon.magazine);
          this.reserveValue.textContent = String(weapon.reserve);
          this.reloadStatus.textContent = combat?.reloading ? `RELOADING · ${(combat.reloadRemainingMs / 1000).toFixed(1)}s` : '';
        }
        this.grenadeValue.textContent = `◆ × ${combat?.grenades ?? CONFIG.combat.maxGrenades}`;
        this.hud.classList.toggle('is-low-health', (combat?.hp ?? CONFIG.player.maxHp) < CONFIG.player.maxHp * 0.3);
        this.powerStatus.textContent = combat?.powerOn ? 'ONLINE' : 'OFFLINE';
        this.powerStatus.classList.toggle('status-off', !combat?.powerOn);
        const perkMarkup = (combat?.perks ?? []).map((perk) => {
          const short = perk === 'eisenbrau' ? 'EI' : perk === 'schnellwasser' ? 'SW' : perk === 'doppelschuss' ? 'DS' : 'ZA';
          return `<i data-perk="${perk}" title="${CONFIG.perkRuntime.displayNames[perk]}">${short}</i>`;
        }).join('');
        if (this.perkRow.innerHTML !== perkMarkup) this.perkRow.innerHTML = perkMarkup;
        const effectMarkup = combat === null || combat === undefined ? '' : [
          combat.instaKillRemainingMs > 0 ? `<b>INSTA-KILL <span>${Math.ceil(combat.instaKillRemainingMs / 1000)}</span></b>` : '',
          combat.doublePointsRemainingMs > 0 ? `<b>DOUBLE POINTS <span>${Math.ceil(combat.doublePointsRemainingMs / 1000)}</span></b>` : '',
        ].filter(Boolean).join('');
        if (this.effectRow.innerHTML !== effectMarkup) this.effectRow.innerHTML = effectMarkup;
        let lifeMessage = '';
        if (combat?.gameOver) lifeMessage = 'GAME OVER';
        else if (combat?.downed && combat.selfReviveRemainingMs > 0) lifeMessage = `ZWEITER ATEM · ${Math.ceil(combat.selfReviveRemainingMs / 1000)}`;
        else if (combat?.downed) lifeMessage = `DOWNED · BLEEDOUT ${Math.ceil(combat.bleedoutRemainingMs / 1000)}`;
        else if (combat?.reconnectPending) lifeMessage = 'SPECTATING · RETURNING NEXT ROUND';
        else if (combat?.spectating) lifeMessage = 'SPECTATING';
        this.lifeOverlay.textContent = lifeMessage;
        this.lifeOverlay.classList.toggle('is-hidden', lifeMessage === '');
      }
      for (const event of scene.drainHudEvents()) this.renderHudEvent(event);
      const controller = scene.getControllerReadout();
      if (controller !== null) {
        const staminaPercent = controller.staminaMs / CONFIG.player.sprintMaxMs;
        this.stamina.style.setProperty('--stamina', `${Math.round(staminaPercent * 100)}%`);
        this.stamina.classList.toggle('is-active', controller.sprinting || controller.staminaMs < CONFIG.player.sprintMaxMs - CONFIG.controller.staminaDisplayEpsilonMs);
        this.lockPrompt.classList.toggle('is-hidden', controller.locked);
        this.controllerValue.textContent = `${controller.x.toFixed(2)}, ${controller.y.toFixed(2)}, ${controller.z.toFixed(2)}${controller.noclip ? ' · NOCLIP' : ''}`;
      }
      const interaction = scene.getInteractionPrompt();
      this.interactionPrompt.textContent = interaction ?? '';
      this.interactionPrompt.classList.toggle('is-hidden', interaction === null);
    }, 50);
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

  startGameplay(): void {
    this.closeModals();
    this.hideLobby();
    this.root.classList.add('is-gameplay');
    this.hud.classList.remove('is-hidden');
    this.lockPrompt.classList.remove('is-hidden');
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
    const alive = snapshot.enemies.filter((enemy) => enemy.state !== 'dead').length;
    (this.overlay.querySelector('[data-debug="counts"]') as HTMLElement).textContent = `${snapshot.spawned} / ${alive} / ${snapshot.queued}`;
    const player = snapshot.players[0];
    (this.overlay.querySelector('[data-debug="vitals"]') as HTMLElement).textContent = `${player?.hp ?? 0} / ${player?.points ?? 0}`;
    const weapon = player?.weapons[player.activeWeaponIndex];
    (this.overlay.querySelector('[data-debug="weapon"]') as HTMLElement).textContent = weapon === undefined
      ? 'none'
      : `${weapon.upgraded ? 'Über-' : ''}${CONFIG.weapons[weapon.id].name} · ${weapon.magazine} / ${weapon.reserve}`;
    const boardCount = snapshot.barriers.reduce((total, barrier) => total + barrier.boards, 0);
    (this.overlay.querySelector('[data-debug="barriers"]') as HTMLElement).textContent = `${boardCount} / ${snapshot.barriers.length * CONFIG.barriers.boardSlots}`;
    const stateCounts = new Map<string, number>();
    for (const enemy of snapshot.enemies) stateCounts.set(enemy.state, (stateCounts.get(enemy.state) ?? 0) + 1);
    (this.overlay.querySelector('[data-debug="enemy-states"]') as HTMLElement).textContent = [...stateCounts].map(([state, count]) => `${state}:${count}`).join(' · ') || 'none';
    if (snapshot.round !== this.displayedRound) {
      this.displayedRound = snapshot.round;
      this.drawRound(snapshot.round, snapshot.round > 0);
    }
  }

  private renderHudEvent(event: ReturnType<PreludeScene['drainHudEvents']>[number]): void {
    if (event.type === 'hit') {
      this.hitmarker.classList.toggle('is-headshot', event.headshot);
      this.restartAnimation(this.hitmarker, 'is-active');
    }
    if (event.type === 'shot') this.restartAnimation(this.hud.querySelector('.crosshair') as HTMLElement, 'is-firing');
    if (event.type === 'damage') {
      this.damageVignette.style.setProperty('--damage-angle', `${event.directionDeg}deg`);
      this.restartAnimation(this.damageVignette, 'is-active');
    }
    if (event.type === 'points') {
      const entry = document.createElement('span');
      entry.textContent = `${event.amount >= 0 ? '+' : ''}${event.amount}`;
      entry.title = event.reason;
      entry.className = event.amount >= 0 ? 'is-gain' : 'is-spend';
      entry.style.animationDuration = `${CONFIG.combat.pointLedgerMs}ms`;
      this.pointLedger.append(entry);
      window.setTimeout(() => entry.remove(), CONFIG.combat.pointLedgerMs);
    }
  }

  private restartAnimation(element: HTMLElement, className: string): void {
    element.classList.remove(className);
    void element.offsetWidth;
    element.classList.add(className);
  }

  private drawRound(round: number, flare: boolean): void {
    const context = this.roundCanvas.getContext('2d');
    if (context === null) return;
    context.clearRect(0, 0, this.roundCanvas.width, this.roundCanvas.height);
    if (round <= 0) return;
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.strokeStyle = '#8d171c';
    context.fillStyle = '#8d171c';
    context.shadowColor = '#2a0204';
    context.shadowBlur = 4;
    if (round <= 5) {
      context.lineWidth = 6;
      const baseX = 45;
      for (let index = 0; index < Math.min(round, 4); index += 1) {
        const jitter = distressedNoise(round * 31 + index * 7) * 3;
        context.beginPath();
        context.moveTo(baseX + index * 22 + jitter, 18 + distressedNoise(index + 3) * 3);
        context.lineTo(baseX + index * 22 - jitter, 78 + distressedNoise(index + 11) * 3);
        context.stroke();
      }
      if (round === 5) {
        context.beginPath();
        context.moveTo(34, 69);
        context.lineTo(125, 25);
        context.stroke();
      }
    } else {
      context.font = '78px Impact, Haettenschweiler, sans-serif';
      context.textAlign = 'center';
      context.textBaseline = 'middle';
      for (const offset of [-2, 0, 2]) context.fillText(String(round), 90 + offset, 51 + distressedNoise(round + offset) * 2);
      context.globalCompositeOperation = 'destination-out';
      for (let index = 0; index < 18; index += 1) {
        const x = 48 + distressedNoise(round * 97 + index) * 84;
        const y = 14 + distressedNoise(round * 53 + index * 3) * 68;
        context.fillRect(x, y, 1 + index % 3, 2 + index % 4);
      }
      context.globalCompositeOperation = 'source-over';
    }
    if (flare) this.restartAnimation(this.roundCanvas, 'is-flaring');
  }

  private bindSettings(): void {
    this.settingsPanel.querySelectorAll<HTMLInputElement>('input[type="range"]').forEach((input) => {
      input.addEventListener('input', () => {
        const output = input.parentElement?.querySelector('output');
        if (output === null || output === undefined) return;
        if (input.dataset.setting === 'fov') output.value = `${input.value}°`;
        if (input.dataset.setting === 'sensitivity') output.value = Number(input.value).toFixed(2);
        if (input.dataset.setting === 'volume') output.value = `${Math.round(Number(input.value) * 100)}%`;
        const setting = input.dataset.setting;
        if (setting === 'fov' || setting === 'sensitivity' || setting === 'volume') this.handlers.onSetting(setting, Number(input.value));
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

function distressedNoise(seed: number): number {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}
