import { Client, type Room } from '@colyseus/sdk';
import { CONFIG } from '../src/config.js';

interface GateWeapon { id: string; magazine: number }
interface GatePlayer { weapons: { readonly [index: number]: GateWeapon | undefined }; activeWeaponIndex: number }
interface GateState {
  started: boolean;
  players: { get(id: string): GatePlayer | undefined };
}
interface GameEvent { type: string; playerId?: string; weaponId?: string; kind?: string; x?: number; y?: number; z?: number }

const endpoint = process.env.GAME_SERVER_URL ?? CONFIG.coop.localServerUrl;
const host = await new Client(endpoint).create('stahlbunker', { name: 'P7 Host' });
const guest = await new Client(endpoint).joinById(host.roomId, { name: 'P7 Listener' });
const hostEvents: GameEvent[] = [];
const guestEvents: GameEvent[] = [];
installHandlers(host, hostEvents);
installHandlers(guest, guestEvents);

try {
  await waitFor(() => state(host).players.get(guest.sessionId) !== undefined, 3_000);
  host.send('start');
  await waitFor(() => state(host).started, 3_000);
  mark('two-client audio event room started');

  host.send('action', { type: 'melee' });
  await waitFor(() => hasEvent(guestEvents, 'meleeSwung'), 2_000);
  host.send('action', { type: 'fire', ads: false });
  await waitFor(() => hasEvent(guestEvents, 'weaponFired'), 2_000);
  host.send('action', { type: 'reload' });
  await waitFor(() => hasEvent(guestEvents, 'weaponReloaded'), 2_000);
  const fire = guestEvents.find((event) => event.type === 'weaponFired');
  if (fire?.playerId !== host.sessionId || fire.weaponId !== 'melder') throw new Error('Remote weapon report lacks authoritative shooter or weapon identity.');
  mark('remote melee, fire, and weapon-specific reload events received');

  host.send('action', { type: 'grenade', cookedMs: CONFIG.combat.grenadeFuseMs - 120 });
  await waitFor(() => hasEvent(guestEvents, 'grenadeThrown'), 2_000);
  await waitFor(() => hasEvent(guestEvents, 'grenadeExploded'), 3_000);
  const thrown = guestEvents.find((event) => event.type === 'grenadeThrown');
  const exploded = guestEvents.find((event) => event.type === 'grenadeExploded');
  if (!hasCoordinates(thrown) || !hasCoordinates(exploded)) throw new Error('Grenade audio events did not preserve their exact world coordinates.');
  mark('throw and explosion source coordinates received after despawn');

  await waitFor(() => hasEvent(guestEvents, 'enemySpawned'), 4_000);
  const spawn = guestEvents.find((event) => event.type === 'enemySpawned');
  if (!hasCoordinates(spawn) || (spawn?.kind !== 'zombie' && spawn?.kind !== 'wolf')) throw new Error('Enemy voice event lacks source coordinates or species.');
  if (!hasEvent(hostEvents, 'enemySpawned')) throw new Error('Authoritative events were not multicast consistently.');
  mark('enemy vocal source and species synchronized');

  console.log(JSON.stringify({
    ok: true,
    roomCode: host.roomId,
    remoteWeapon: fire.weaponId,
    grenadeSource: { x: exploded.x, y: exploded.y, z: exploded.z },
    enemySpecies: spawn.kind,
    hostEventCount: hostEvents.length,
    guestEventCount: guestEvents.length,
  }, null, 2));
} finally {
  await Promise.race([Promise.allSettled([host.leave(true), guest.leave(true)]), delay(1_500)]);
}

function installHandlers(room: Room, events: GameEvent[]): void {
  room.onMessage('gameEvent', (event: GameEvent) => events.push(event));
  room.onMessage('combatFeedback', () => undefined);
  room.onMessage('pointTransaction', () => undefined);
  room.onMessage('damageFeedback', () => undefined);
  room.onMessage('reloadFeedback', () => undefined);
  room.onMessage('runStarted', () => undefined);
}

function state(room: Room): GateState {
  return room.state as GateState;
}

function hasEvent(events: readonly GameEvent[], type: string): boolean {
  return events.some((event) => event.type === type);
}

function hasCoordinates(event: GameEvent | undefined): event is GameEvent & { x: number; y: number; z: number } {
  return event !== undefined && Number.isFinite(event.x) && Number.isFinite(event.y) && Number.isFinite(event.z);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for the P7 network audio gate.');
    await delay(20);
  }
}

function mark(message: string): void {
  process.stderr.write(`[p7-network] ${message}\n`);
}
