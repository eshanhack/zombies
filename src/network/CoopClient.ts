import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../config.js';
import type { MovementInput } from '../shared/movement.js';
import type { AuthoritativePlayerState } from '../game/FirstPersonController.js';
import type { RemotePlayerPose } from '../game/PreludeScene.js';

interface WirePlayer {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  spectating: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  yaw: number;
  pitch: number;
  staminaMs: number;
  lastProcessedInput: number;
  grounded: boolean;
}

interface WireState {
  seed: number;
  roomCode: string;
  hostId: string;
  phase: string;
  started: boolean;
  players: {
    forEach(callback: (player: WirePlayer, key: string) => void): void;
  };
}

export interface LobbyPlayerView {
  id: string;
  name: string;
  ready: boolean;
  connected: boolean;
  spectating: boolean;
  isHost: boolean;
  isSelf: boolean;
}

export interface LobbyView {
  roomCode: string;
  seed: number;
  phase: string;
  started: boolean;
  isHost: boolean;
  players: LobbyPlayerView[];
}

type LobbyListener = (view: LobbyView) => void;
type MovementListener = (local: AuthoritativePlayerState | null, players: readonly RemotePlayerPose[]) => void;

export class CoopClient {
  private readonly client: Client;
  private room: Room | null = null;
  private listener: LobbyListener = () => undefined;
  private movementListener: MovementListener = () => undefined;

  constructor(endpoint = import.meta.env.VITE_GAME_SERVER ?? CONFIG.coop.localServerUrl) {
    this.client = new Client(endpoint);
  }

  onLobbyChange(listener: LobbyListener): void {
    this.listener = listener;
  }

  onMovement(listener: MovementListener): void {
    this.movementListener = listener;
  }

  async create(name: string): Promise<void> {
    await this.connect(this.client.create('stahlbunker', { name }));
  }

  async join(roomCode: string, name: string): Promise<void> {
    await this.connect(this.client.joinById(roomCode.trim().toUpperCase(), { name }));
  }

  setReady(ready: boolean): void {
    this.room?.send('ready', ready);
  }

  start(): void {
    this.room?.send('start');
  }

  sendInput(input: MovementInput): void {
    this.room?.send('input', input);
  }

  async leave(): Promise<void> {
    const room = this.room;
    this.room = null;
    if (room !== null) await room.leave(true);
  }

  private async connect(roomPromise: Promise<Room>): Promise<void> {
    if (this.room !== null) await this.leave();
    const room = await roomPromise;
    this.room = room;
    room.onMessage('runStarted', () => undefined);
    room.onStateChange(() => this.publish());
    room.onLeave(() => {
      if (this.room === room) this.room = null;
    });
    try {
      localStorage.setItem(CONFIG.storage.resumeKey, JSON.stringify({
        roomCode: room.roomId,
        reconnectionToken: room.reconnectionToken,
      }));
    } catch {
      // Private browsing may disallow persistence; the live session remains valid.
    }
    this.publish();
  }

  private publish(): void {
    const room = this.room;
    if (room === null) return;
    const state = room.state as WireState;
    if (state === null || state.players === undefined) return;
    const players: LobbyPlayerView[] = [];
    const poses: RemotePlayerPose[] = [];
    let local: AuthoritativePlayerState | null = null;
    state.players.forEach((player) => {
      players.push({
        id: player.id,
        name: player.name,
        ready: player.ready,
        connected: player.connected,
        spectating: player.spectating,
        isHost: player.id === state.hostId,
        isSelf: player.id === room.sessionId,
      });
      const isSelf = player.id === room.sessionId;
      poses.push({
        id: player.id,
        x: player.x,
        y: player.y,
        z: player.z,
        yaw: player.yaw,
        connected: player.connected,
        isSelf,
      });
      if (isSelf) {
        local = {
          x: player.x,
          y: player.y,
          z: player.z,
          vx: player.vx,
          vy: player.vy,
          vz: player.vz,
          yaw: player.yaw,
          pitch: player.pitch,
          staminaMs: player.staminaMs,
          lastProcessedInput: player.lastProcessedInput,
          grounded: player.grounded,
        };
      }
    });
    players.sort((left, right) => Number(right.isHost) - Number(left.isHost) || left.name.localeCompare(right.name));
    this.listener({
      roomCode: state.roomCode || room.roomId,
      seed: state.seed,
      phase: state.phase,
      started: state.started,
      isHost: state.hostId === room.sessionId,
      players,
    });
    this.movementListener(local, poses);
  }
}
