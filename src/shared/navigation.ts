import { NAV_NODES, NAV_NODE_BY_ID, type NavNode } from '../map/navgraph.js';

const DOOR_EDGES = new Map<string, string>([
  [edgeKey('A01', 'A02'), 'doorA'],
  [edgeKey('B02', 'B03'), 'doorB'],
  [edgeKey('T03', 'T04'), 'doorC'],
]);

export function nearestNavNode(x: number, y: number, z: number, allowedNodeIds?: ReadonlySet<string>): NavNode {
  let nearest = NAV_NODES[0];
  if (nearest === undefined) throw new Error('Navigation graph is empty.');
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const node of NAV_NODES) {
    if (allowedNodeIds !== undefined && !allowedNodeIds.has(node.id)) continue;
    const vertical = (node.y - y) * 1.6;
    const distance = (node.x - x) ** 2 + vertical ** 2 + (node.z - z) ** 2;
    if (distance >= nearestDistance) continue;
    nearest = node;
    nearestDistance = distance;
  }
  return nearest;
}

export function findNavPath(startId: string, goalId: string, openDoors: ReadonlySet<string>): string[] {
  if (startId === goalId) return [startId];
  const open = new Set([startId]);
  const cameFrom = new Map<string, string>();
  const gScore = new Map<string, number>([[startId, 0]]);
  const fScore = new Map<string, number>([[startId, heuristic(startId, goalId)]]);

  while (open.size > 0) {
    let current = '';
    let best = Number.POSITIVE_INFINITY;
    for (const candidate of open) {
      const score = fScore.get(candidate) ?? Number.POSITIVE_INFINITY;
      if (score >= best) continue;
      best = score;
      current = candidate;
    }
    if (current === goalId) return reconstruct(cameFrom, current);
    open.delete(current);
    const node = NAV_NODE_BY_ID.get(current);
    if (node === undefined) break;
    for (const neighborId of node.links) {
      const requiredDoor = DOOR_EDGES.get(edgeKey(current, neighborId));
      if (requiredDoor !== undefined && !openDoors.has(requiredDoor)) continue;
      const tentative = (gScore.get(current) ?? Number.POSITIVE_INFINITY) + heuristic(current, neighborId);
      if (tentative >= (gScore.get(neighborId) ?? Number.POSITIVE_INFINITY)) continue;
      cameFrom.set(neighborId, current);
      gScore.set(neighborId, tentative);
      fScore.set(neighborId, tentative + heuristic(neighborId, goalId));
      open.add(neighborId);
    }
  }
  return [];
}

export function isDoorEdge(leftId: string, rightId: string): string | undefined {
  return DOOR_EDGES.get(edgeKey(leftId, rightId));
}

function reconstruct(cameFrom: Map<string, string>, goal: string): string[] {
  const path = [goal];
  let current = goal;
  while (cameFrom.has(current)) {
    current = cameFrom.get(current)!;
    path.push(current);
  }
  return path.reverse();
}

function heuristic(leftId: string, rightId: string): number {
  const left = NAV_NODE_BY_ID.get(leftId);
  const right = NAV_NODE_BY_ID.get(rightId);
  if (left === undefined || right === undefined) return Number.POSITIVE_INFINITY;
  return Math.hypot(right.x - left.x, right.y - left.y, right.z - left.z);
}

function edgeKey(leftId: string, rightId: string): string {
  return leftId < rightId ? `${leftId}:${rightId}` : `${rightId}:${leftId}`;
}
