import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';

interface GateWeapon { id: string; magazine: number; reserve: number }
interface GatePlayer {
  points: number;
  hp: number;
  maxHp: number;
  connected: boolean;
  downed: boolean;
  spectating: boolean;
  dead: boolean;
  reconnectPending: boolean;
  bleedoutRemainingMs: number;
  activeWeaponIndex: number;
  grenades: number;
  perks: { readonly [index: number]: string | undefined; length: number };
  weapons: { readonly [index: number]: GateWeapon | undefined; length: number };
}
interface GatePowerup { powerupType: string; guaranteed: boolean }
interface GateState {
  started: boolean;
  round: number;
  roundKind: string;
  nextWolfRound: number;
  spawned: number;
  alive: number;
  queued: number;
  powerOn: boolean;
  gameOver: boolean;
  players: { get(id: string): GatePlayer | undefined };
  powerups: { forEach(callback: (powerup: GatePowerup, key: string) => void): void };
}

type GateType = 'grantPoints' | 'teleport' | 'grantWeapon' | 'grantPerk' | 'setPower' | 'spawnPowerup' | 'damage' | 'startRound' | 'killAll';
interface GateRequest {
  type: GateType;
  x?: number;
  y?: number;
  z?: number;
  weaponId?: string;
  perkId?: string;
  powerupType?: string;
  damage?: number;
  round?: number;
}

const endpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const host = await new Client(endpoint).create('stahlbunker', { name: 'P5 Host' });
let guest = await new Client(endpoint).joinById(host.roomId, { name: 'P5 Guest' });
const guestId = guest.sessionId;
mark('clients connected');
installMessageHandlers(host);
installMessageHandlers(guest);

try {
  await waitFor(() => player(host, guestId) !== undefined, 3000);
  if (state(host).powerOn) throw new Error('Power was active before the breaker gate.');
  host.send('start');
  await waitFor(() => state(host).started, 3000);
  mark('room started and roster locked');

  let rosterRejected = false;
  try {
    const intruder = await new Client(endpoint).joinById(host.roomId, { name: 'Late Intruder' });
    await intruder.leave(true);
  } catch {
    rosterRejected = true;
  }
  if (!rosterRejected) throw new Error('A new player entered after roster lock.');

  gate(host, { type: 'setPower' });
  await waitFor(() => state(host).powerOn, 2000);
  mark('shared power synchronized');

  gate(guest, { type: 'grantPerk', perkId: 'eisenbrau' });
  await waitFor(() => player(host, guestId)?.maxHp === CONFIG.perkRuntime.eisenbrauHp, 2000);
  for (let hit = 0; hit < 5; hit += 1) {
    gate(guest, { type: 'damage', damage: CONFIG.zombie.hitDamage });
    await delay(CONFIG.player.postHitInvulnMs + 35);
  }
  await waitFor(() => player(host, guestId)?.downed === true, 2000);
  const observedBleedout = player(host, guestId)?.bleedoutRemainingMs ?? 0;
  if (observedBleedout <= CONFIG.coop.bleedoutMs - 1000 || observedBleedout > CONFIG.coop.bleedoutMs) {
    throw new Error(`Co-op bleedout timer was outside its 30-second start window: ${observedBleedout}.`);
  }
  mark('Eisenbrau five-hit down synchronized');

  gate(host, { type: 'grantPerk', perkId: 'zweiterAtem' });
  gate(host, { type: 'teleport', x: 0, y: 0, z: -1.5 });
  gate(guest, { type: 'teleport', x: 0, y: 0, z: -1.5 });
  await delay(100);
  const quickReviverPoints = player(host, host.sessionId)!.points;
  host.send('action', { type: 'interact', held: true });
  await delay(CONFIG.coop.reviveMs * CONFIG.coop.quickReviveMultiplier - 180);
  if (!player(host, guestId)?.downed) throw new Error('Accelerated revive completed early.');
  await delay(300);
  host.send('action', { type: 'interact', held: false });
  await waitFor(() => player(host, guestId)?.downed === false, 2000);
  if (player(host, host.sessionId)!.points !== quickReviverPoints + CONFIG.coop.reviveAward) throw new Error('Reviver did not receive exactly 50 points.');
  mark('2.25-second accelerated revive synchronized');

  for (let hit = 0; hit < 2; hit += 1) {
    gate(host, { type: 'damage', damage: CONFIG.zombie.hitDamage });
    await delay(CONFIG.player.postHitInvulnMs + 35);
  }
  await waitFor(() => player(host, host.sessionId)?.downed === true, 2000);
  guest.send('action', { type: 'interact', held: true });
  await delay(CONFIG.coop.reviveMs - 180);
  if (!player(host, host.sessionId)?.downed) throw new Error('Normal revive completed early.');
  await delay(300);
  guest.send('action', { type: 'interact', held: false });
  await waitFor(() => player(host, host.sessionId)?.downed === false, 2000);
  mark('4.5-second normal revive synchronized');

  gate(guest, { type: 'grantPerk', perkId: 'schnellwasser' });
  gate(guest, { type: 'grantPerk', perkId: 'doppelschuss' });
  await waitFor(() => perks(player(host, guestId)!).includes('doppelschuss'), 2000);
  guest.send('action', { type: 'fire', ads: false });
  await waitFor(() => activeWeapon(player(host, guestId)!)?.magazine === CONFIG.weapons.melder.magazine - 1, 2000);
  guest.send('action', { type: 'reload' });
  await waitFor(() => {
    const value = player(host, guestId)!;
    return value.weapons[value.activeWeaponIndex]?.magazine === CONFIG.weapons.melder.magazine;
  }, CONFIG.weapons.melder.reloadMs + 1000);
  if (activeWeapon(player(host, guestId)!)?.reserve !== CONFIG.weapons.melder.reserve - 1) throw new Error('Reload did not debit reserve before Max Ammo.');
  await delay(60000 / (CONFIG.weapons.melder.rpm * CONFIG.perkRuntime.doppelschussFireRateMultiplier) + 20);
  guest.send('action', { type: 'fire', ads: false });
  await waitFor(() => activeWeapon(player(host, guestId)!)?.magazine === CONFIG.weapons.melder.magazine - 1, 2000);
  const magazineBeforeMaxAmmo = activeWeapon(player(host, guestId)!)!.magazine;
  gate(guest, { type: 'spawnPowerup', powerupType: 'maxAmmo' });
  await waitFor(() => activeWeapon(player(host, guestId)!)?.reserve === CONFIG.weapons.melder.reserve, 2000);
  if (activeWeapon(player(host, guestId)!)?.magazine !== magazineBeforeMaxAmmo) throw new Error('Max Ammo changed a loaded magazine.');
  if (player(host, host.sessionId)!.grenades !== CONFIG.combat.maxGrenades || player(host, guestId)!.grenades !== CONFIG.combat.maxGrenades) {
    throw new Error('Max Ammo did not restore team grenades.');
  }
  mark('Schnellwasser, Doppelschuss, and reserve-only Max Ammo synchronized');

  const preservedPoints = player(host, guestId)!.points;
  const preservedPerks = perks(player(host, guestId)!);
  const preservedWeapons = weapons(player(host, guestId)!);
  const reconnectionToken = guest.reconnectionToken;
  guest.reconnection.enabled = false;
  await guest.leave(false);
  await waitFor(() => player(host, guestId)?.connected === false, 3000);
  guest = await new Client(endpoint).reconnect(reconnectionToken);
  installMessageHandlers(guest);
  await waitFor(() => player(host, guestId)?.connected === true && player(host, guestId)?.reconnectPending === true, 3000);
  if (!player(host, guestId)?.spectating) throw new Error('Reconnected player did not enter spectator state.');
  gate(host, { type: 'startRound', round: state(host).round + 1 });
  await waitFor(() => player(host, guestId)?.spectating === false && player(host, guestId)?.reconnectPending === false, 3000);
  if (player(host, guestId)!.points !== preservedPoints
    || JSON.stringify(perks(player(host, guestId)!)) !== JSON.stringify(preservedPerks)
    || JSON.stringify(weapons(player(host, guestId)!)) !== JSON.stringify(preservedWeapons)) {
    throw new Error('Reconnect did not preserve personal state.');
  }
  mark('reconnect spectator boundary preserved inventory, perks, points, and roster slot');

  const wolfRound = state(host).nextWolfRound;
  gate(host, { type: 'startRound', round: wolfRound });
  await waitFor(() => state(host).roundKind === 'wolves', 3000);
  const wolfTotal = state(host).spawned + state(host).queued;
  if (wolfTotal !== CONFIG.wolves.firstTwoCountPerPlayer * 2) throw new Error(`Expected 12 wolves, received ${wolfTotal}.`);
  let peakAlive = 0;
  const wolfDeadline = Date.now() + 25000;
  while ((state(host).queued > 0 || state(host).alive > 0) && Date.now() < wolfDeadline) {
    peakAlive = Math.max(peakAlive, state(host).alive);
    if (state(host).alive > 0) gate(host, { type: 'killAll' });
    await delay(80);
  }
  if (state(host).queued > 0 || state(host).alive > 0) throw new Error('Wolf round did not drain during the deterministic kill gate.');
  if (peakAlive > CONFIG.wolves.maxActivePerPlayer * 2) throw new Error(`Wolf active cap exceeded: ${peakAlive}.`);
  await waitFor(() => powerups(host).some((powerup) => powerup.powerupType === 'maxAmmo' && powerup.guaranteed), 2000);
  mark('wolf roster count, active cap, and guaranteed Max Ammo synchronized');

  console.log(JSON.stringify({
    ok: true,
    roomCode: host.roomId,
    rosterRejected,
    quickReviveMs: CONFIG.coop.reviveMs * CONFIG.coop.quickReviveMultiplier,
    normalReviveMs: CONFIG.coop.reviveMs,
    maxAmmoMagazinePreserved: magazineBeforeMaxAmmo,
    reconnectPreserved: true,
    wolfRound,
    wolfTotal,
    peakAlive,
    guaranteedMaxAmmo: true,
  }, null, 2));
} finally {
  await Promise.race([Promise.allSettled([host.leave(true), guest.leave(true)]), delay(1500)]);
}

function installMessageHandlers(room: Room): void {
  room.onMessage('combatFeedback', () => undefined);
  room.onMessage('pointTransaction', () => undefined);
  room.onMessage('damageFeedback', () => undefined);
  room.onMessage('reloadFeedback', () => undefined);
  room.onMessage('gateAck', () => undefined);
  room.onMessage('runStarted', () => undefined);
  room.onMessage('gameEvent', () => undefined);
}

function state(room: Room): GateState {
  return room.state as GateState;
}

function player(room: Room, id: string): GatePlayer | undefined {
  return state(room).players.get(id);
}

function activeWeapon(value: GatePlayer): GateWeapon | undefined {
  return value.weapons[value.activeWeaponIndex];
}

function weapons(value: GatePlayer): string[] {
  return Array.from({ length: value.weapons.length }, (_, index) => value.weapons[index]?.id ?? '');
}

function perks(value: GatePlayer): string[] {
  return Array.from({ length: value.perks.length }, (_, index) => value.perks[index] ?? '');
}

function powerups(room: Room): GatePowerup[] {
  const values: GatePowerup[] = [];
  state(room).powerups.forEach((powerup) => values.push(powerup));
  return values;
}

function gate(room: Room, request: GateRequest): void {
  room.send('gate', { version: CONFIG.debug.apiVersion, ...request });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for the P5 network gate.');
    await delay(20);
  }
}

function mark(message: string): void {
  process.stderr.write(`[p5-network] ${message}\n`);
}
