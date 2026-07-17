import { MapSchema, Schema, type } from '@colyseus/schema';
import { CONFIG } from '../../src/config.js';

export class NetPlayer extends Schema {
  @type('string') id: string = '';
  @type('string') name: string = 'Wanderer';
  @type('float32') x: number = 0;
  @type('float32') y: number = CONFIG.controller.eyeHeightM;
  @type('float32') z: number = 0;
  @type('float32') yaw: number = 0;
  @type('float32') pitch: number = 0;
  @type('uint16') hp: number = CONFIG.player.maxHp;
  @type('uint32') points: number = CONFIG.points.starting;
  @type('boolean') ready: boolean = false;
  @type('boolean') connected: boolean = true;
  @type('boolean') spectating: boolean = false;
  @type('boolean') downed: boolean = false;
}

export class BunkerState extends Schema {
  @type('uint32') seed: number = CONFIG.simulation.seedFallback;
  @type('string') roomCode: string = '';
  @type('string') hostId: string = '';
  @type('string') phase: string = 'lobby';
  @type('uint16') round: number = 0;
  @type('boolean') started: boolean = false;
  @type('boolean') powerOn: boolean = false;
  @type('float64') serverTimeMs: number = 0;
  @type({ map: NetPlayer }) players: MapSchema<NetPlayer> = new MapSchema<NetPlayer>();
}
