import { ArraySchema, MapSchema, Schema, type } from '@colyseus/schema';
import { CONFIG } from '../../src/config.js';

export class NetWeapon extends Schema {
  @type('string') id: string = 'melder';
  @type('uint16') magazine: number = CONFIG.weapons.melder.magazine;
  @type('uint16') reserve: number = CONFIG.weapons.melder.reserve;
  @type('boolean') upgraded: boolean = false;
}

export class NetPlayer extends Schema {
  @type('string') id: string = '';
  @type('string') name: string = 'Wanderer';
  @type('float32') x: number = 0;
  @type('float32') y: number = CONFIG.controller.eyeHeightM;
  @type('float32') z: number = 0;
  @type('float32') vx: number = 0;
  @type('float32') vy: number = 0;
  @type('float32') vz: number = 0;
  @type('float32') yaw: number = 0;
  @type('float32') pitch: number = 0;
  @type('uint16') staminaMs: number = CONFIG.player.sprintMaxMs;
  @type('uint32') lastProcessedInput: number = 0;
  @type('boolean') grounded: boolean = true;
  @type('uint16') hp: number = CONFIG.player.maxHp;
  @type('uint16') maxHp: number = CONFIG.player.maxHp;
  @type('uint32') points: number = CONFIG.points.starting;
  @type('float64') invulnerableUntilMs: number = 0;
  @type('boolean') ready: boolean = false;
  @type('boolean') connected: boolean = true;
  @type('boolean') spectating: boolean = false;
  @type('boolean') downed: boolean = false;
  @type([NetWeapon]) weapons: ArraySchema<NetWeapon> = new ArraySchema<NetWeapon>();
  @type('uint8') activeWeaponIndex: number = 0;
  @type('boolean') reloading: boolean = false;
  @type('float32') reloadRemainingMs: number = 0;
  @type('uint32') shots: number = 0;
  @type('uint32') hits: number = 0;
  @type('uint32') kills: number = 0;
  @type('uint32') headshots: number = 0;
  @type('uint32') pointsEarned: number = 0;
  @type('uint16') doorsOpened: number = 0;
  @type('uint16') crateRolls: number = 0;
  @type('uint8') grenades: number = CONFIG.combat.maxGrenades;
}

export class NetBarrier extends Schema {
  @type('string') id: string = '';
  @type('string') room: string = 'start';
  @type('uint8') boards: number = CONFIG.barriers.boardSlots;
  @type('float32') repairProgressMs: number = 0;
}

export class NetEnemy extends Schema {
  @type('uint32') id: number = 0;
  @type('string') kind: string = 'zombie';
  @type('string') state: string = 'spawn';
  @type('string') speedTier: string = 'walk';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') z: number = 0;
  @type('float32') yaw: number = 0;
  @type('uint32') hp: number = CONFIG.zombie.baseHp;
  @type('uint32') maxHp: number = CONFIG.zombie.baseHp;
  @type('float32') speed: number = CONFIG.zombie.speeds.walk;
  @type('string') barrierId: string = '';
  @type('string') targetPlayerId: string = '';
  @type('float32') stateTimeMs: number = 0;
  @type('float32') spawnProgress: number = 0;
}

export class NetGrenade extends Schema {
  @type('uint32') id: number = 0;
  @type('string') ownerId: string = '';
  @type('float32') x: number = 0;
  @type('float32') y: number = 0;
  @type('float32') z: number = 0;
  @type('float32') fuseRemainingMs: number = 0;
}

export class BunkerState extends Schema {
  @type('uint32') seed: number = CONFIG.simulation.seedFallback;
  @type('string') roomCode: string = '';
  @type('string') hostId: string = '';
  @type('string') phase: string = 'lobby';
  @type('uint16') round: number = 0;
  @type('uint16') spawned: number = 0;
  @type('uint16') queued: number = 0;
  @type('uint16') alive: number = 0;
  @type('boolean') started: boolean = false;
  @type('boolean') powerOn: boolean = false;
  @type('float64') serverTimeMs: number = 0;
  @type('float64') simulationTimeMs: number = 0;
  @type(['string']) openDoors: ArraySchema<string> = new ArraySchema<string>();
  @type('string') crateLocationId: string = CONFIG.mysteryCrate.startingLocationId;
  @type('string') cratePhase: string = 'closed';
  @type('string') cratePurchaserId: string = '';
  @type('string') crateWeaponId: string = '';
  @type('boolean') cratePendingPuppe: boolean = false;
  @type('float32') crateSpinRemainingMs: number = 0;
  @type('float32') crateGrabRemainingMs: number = 0;
  @type('uint16') crateUsesAtLocation: number = 0;
  @type({ map: NetPlayer }) players: MapSchema<NetPlayer> = new MapSchema<NetPlayer>();
  @type({ map: NetBarrier }) barriers: MapSchema<NetBarrier> = new MapSchema<NetBarrier>();
  @type({ map: NetEnemy }) enemies: MapSchema<NetEnemy> = new MapSchema<NetEnemy>();
  @type({ map: NetGrenade }) grenades: MapSchema<NetGrenade> = new MapSchema<NetGrenade>();
}
