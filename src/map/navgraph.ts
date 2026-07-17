import type { RoomId } from '../config.js';

export interface NavNode {
  id: string;
  room: RoomId;
  x: number;
  y: number;
  z: number;
  links: readonly string[];
}

export const NAV_NODES: readonly NavNode[] = [
  { id: 'S01', room: 'start', x: -5.2, y: 0, z: -3.2, links: ['S02', 'S05'] },
  { id: 'S02', room: 'start', x: -1.8, y: 0, z: -3.2, links: ['S01', 'S03', 'S06'] },
  { id: 'S03', room: 'start', x: 1.8, y: 0, z: -3.2, links: ['S02', 'S04', 'S07'] },
  { id: 'S04', room: 'start', x: 5.2, y: 0, z: -3.2, links: ['S03', 'S08'] },
  { id: 'S05', room: 'start', x: -5.2, y: 0, z: 0, links: ['S01', 'S06', 'S09'] },
  { id: 'S06', room: 'start', x: -2.4, y: 0, z: 0, links: ['S02', 'S05', 'S10'] },
  { id: 'S07', room: 'start', x: 2.5, y: 0, z: 0, links: ['S03', 'S08', 'S11'] },
  { id: 'S08', room: 'start', x: 5.2, y: 0, z: 0, links: ['S04', 'S07', 'S12'] },
  { id: 'S09', room: 'start', x: -5.25, y: 0, z: 3.7, links: ['S05', 'S10', 'A01'] },
  { id: 'S10', room: 'start', x: -2.5, y: 0, z: 3.7, links: ['S06', 'S09', 'S11'] },
  { id: 'S11', room: 'start', x: 1.8, y: 0, z: 3.7, links: ['S07', 'S10', 'S12'] },
  { id: 'S12', room: 'start', x: 5.2, y: 0, z: 3.7, links: ['S08', 'S11'] },
  { id: 'A01', room: 'start', x: -5.2, y: 0, z: 5.4, links: ['S09', 'A02'] },
  { id: 'A02', room: 'start', x: -5.2, y: 0, z: 6.9, links: ['A01', 'A03'] },
  { id: 'A03', room: 'armory', x: -5.2, y: 0, z: 8.5, links: ['A02', 'A04'] },
  { id: 'A04', room: 'armory', x: -5.8, y: 0, z: 10.2, links: ['A03', 'R05'] },
  { id: 'R01', room: 'armory', x: -13.5, y: 0, z: 10.5, links: ['R02', 'R06'] },
  { id: 'R02', room: 'armory', x: -11.6, y: 0, z: 10.5, links: ['R01', 'R03', 'R07'] },
  { id: 'R03', room: 'armory', x: -9.6, y: 0, z: 10.5, links: ['R02', 'R04', 'R08'] },
  { id: 'R04', room: 'armory', x: -7.6, y: 0, z: 10.5, links: ['R03', 'R05', 'R09'] },
  { id: 'R05', room: 'armory', x: -5.7, y: 0, z: 10.5, links: ['R04', 'R10', 'A04', 'B01'] },
  { id: 'R06', room: 'armory', x: -13.5, y: 0, z: 15.3, links: ['R01', 'R07'] },
  { id: 'R07', room: 'armory', x: -11.6, y: 0, z: 15.3, links: ['R02', 'R06', 'R08'] },
  { id: 'R08', room: 'armory', x: -9.6, y: 0, z: 15.3, links: ['R03', 'R07', 'R09'] },
  { id: 'R09', room: 'armory', x: -7.6, y: 0, z: 15.3, links: ['R04', 'R08', 'R10'] },
  { id: 'R10', room: 'armory', x: -5.7, y: 0, z: 15.3, links: ['R05', 'R09'] },
  { id: 'B01', room: 'armory', x: -4.4, y: 0, z: 12, links: ['R05', 'B02'] },
  { id: 'B02', room: 'armory', x: -2.8, y: 0, z: 12, links: ['B01', 'B03'] },
  { id: 'B03', room: 'generator', x: -1.1, y: 0, z: 12, links: ['B02', 'B04'] },
  { id: 'B04', room: 'generator', x: 0.65, y: 0, z: 12, links: ['B03', 'G08'] },
  { id: 'G01', room: 'generator', x: 2.4, y: 0, z: 9.4, links: ['G02', 'G08'] },
  { id: 'G02', room: 'generator', x: 4, y: 0, z: 9.4, links: ['G01', 'G03'] },
  { id: 'G03', room: 'generator', x: 5.6, y: 0, z: 9.4, links: ['G02', 'G04'] },
  { id: 'G04', room: 'generator', x: 7.2, y: 0, z: 9.4, links: ['G03', 'G05'] },
  { id: 'G05', room: 'generator', x: 8.8, y: 0, z: 9.4, links: ['G04', 'G06', 'G12'] },
  { id: 'G06', room: 'generator', x: 10.4, y: 0, z: 9.4, links: ['G05', 'G07', 'G13'] },
  { id: 'G07', room: 'generator', x: 12, y: 0, z: 9.4, links: ['G06', 'G14'] },
  { id: 'G08', room: 'generator', x: 2.4, y: 0, z: 15.6, links: ['G01', 'G09', 'B04'] },
  { id: 'G09', room: 'generator', x: 3.4, y: 0, z: 15.6, links: ['G08', 'G10'] },
  { id: 'G10', room: 'generator', x: 7.8, y: 0, z: 15.6, links: ['G09', 'G11'] },
  { id: 'G11', room: 'generator', x: 9.2, y: 0, z: 15.6, links: ['G10', 'G12', 'T01'] },
  { id: 'G12', room: 'generator', x: 8.8, y: 0, z: 12.1, links: ['G05', 'G11', 'G13'] },
  { id: 'G13', room: 'generator', x: 10.4, y: 0, z: 12.1, links: ['G06', 'G12', 'G14'] },
  { id: 'G14', room: 'generator', x: 12, y: 0, z: 12.1, links: ['G07', 'G13', 'T04'] },
  { id: 'T01', room: 'generator', x: 10.9, y: 0.4, z: 15.35, links: ['G11', 'T02'] },
  { id: 'T02', room: 'generator', x: 10.9, y: 1.2, z: 14.35, links: ['T01', 'T03'] },
  { id: 'T03', room: 'generator', x: 10.9, y: 2, z: 13.35, links: ['T02', 'T04'] },
  { id: 'T04', room: 'catwalk', x: 10.9, y: 2.8, z: 12.35, links: ['T03', 'G14', 'C06'] },
  { id: 'C01', room: 'catwalk', x: 2.3, y: 3.2, z: 9.3, links: ['C02'] },
  { id: 'C02', room: 'catwalk', x: 4.2, y: 3.2, z: 9.3, links: ['C01', 'C03'] },
  { id: 'C03', room: 'catwalk', x: 6.2, y: 3.2, z: 9.3, links: ['C02', 'C04'] },
  { id: 'C04', room: 'catwalk', x: 8.2, y: 3.2, z: 9.3, links: ['C03', 'C05'] },
  { id: 'C05', room: 'catwalk', x: 10.2, y: 3.2, z: 9.3, links: ['C04', 'C06'] },
  { id: 'C06', room: 'catwalk', x: 11.8, y: 3.2, z: 10.8, links: ['C05', 'T04'] },
] as const;

export const NAV_NODE_BY_ID = new Map(NAV_NODES.map((node) => [node.id, node]));
