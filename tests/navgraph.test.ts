import { describe, expect, it } from 'vitest';
import { NAV_NODES, NAV_NODE_BY_ID } from '../src/map/navgraph.js';

describe('hand-authored navigation graph', () => {
  it('contains exactly 54 uniquely named nodes', () => {
    expect(NAV_NODES).toHaveLength(54);
    expect(new Set(NAV_NODES.map((node) => node.id)).size).toBe(54);
  });

  it('has only reciprocal, resolvable links', () => {
    for (const node of NAV_NODES) {
      expect(node.links.length).toBeGreaterThan(0);
      for (const link of node.links) {
        const neighbor = NAV_NODE_BY_ID.get(link);
        expect(neighbor, `${node.id} -> ${link}`).toBeDefined();
        expect(neighbor?.links, `${link} -> ${node.id}`).toContain(node.id);
      }
    }
  });

  it('connects all four rooms as one traversable graph', () => {
    const visited = new Set<string>();
    const queue = [NAV_NODES[0]?.id ?? ''];
    while (queue.length > 0) {
      const id = queue.shift();
      if (id === undefined || visited.has(id)) continue;
      visited.add(id);
      const node = NAV_NODE_BY_ID.get(id);
      if (node !== undefined) queue.push(...node.links);
    }
    expect(visited.size).toBe(NAV_NODES.length);
    expect(new Set(NAV_NODES.map((node) => node.room))).toEqual(new Set(['start', 'armory', 'generator', 'catwalk']));
  });
});
