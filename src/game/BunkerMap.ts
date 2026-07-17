import * as THREE from 'three';
import { CONFIG } from '../config.js';
import { DOORS, FLOOR_ZONES, STATIC_COLLIDERS, WINDOWS, type AabbCollider } from '../map/blueprint.js';
import { NAV_NODES, NAV_NODE_BY_ID } from '../map/navgraph.js';
import type { CollisionWorld } from '../shared/movement.js';

export class BunkerMap {
  readonly group = new THREE.Group();
  readonly collisionWorld: CollisionWorld;
  private readonly openDoors = new Set<string>();
  private readonly doorMeshes = new Map<string, THREE.Mesh>();
  private readonly navDebug = new THREE.Group();
  private boardInstances: THREE.InstancedMesh | null = null;

  constructor() {
    this.group.name = 'stahlbunker-map';
    this.collisionWorld = { colliders: STATIC_COLLIDERS, floors: FLOOR_ZONES, openDoors: this.openDoors };
    this.buildGeometry();
    this.buildLighting();
    this.buildNavDebug();
    this.navDebug.visible = false;
    this.group.add(this.navDebug);
  }

  setDoorOpen(doorId: string, open: boolean): void {
    if (open) this.openDoors.add(doorId);
    else this.openDoors.delete(doorId);
    const mesh = this.doorMeshes.get(doorId);
    if (mesh !== undefined) {
      mesh.visible = !open;
      mesh.castShadow = !open;
    }
  }

  setAllDoorsOpen(open: boolean): void {
    for (const entry of DOORS) this.setDoorOpen(entry.id, open);
  }

  toggleNavDebug(): boolean {
    this.navDebug.visible = !this.navDebug.visible;
    return this.navDebug.visible;
  }

  updateBarriers(barriers: readonly { id: string; boards: number }[]): void {
    const instances = this.boardInstances;
    if (instances === null) return;
    const boardCounts = new Map(barriers.map((barrier) => [barrier.id, barrier.boards]));
    const dummy = new THREE.Object3D();
    let instanceIndex = 0;
    for (let windowIndex = 0; windowIndex < WINDOWS.length; windowIndex += 1) {
      const window = WINDOWS[windowIndex]!;
      const count = Math.max(0, Math.min(CONFIG.barriers.boardSlots, boardCounts.get(window.id) ?? CONFIG.barriers.boardSlots));
      const yaw = window.facing === 'west' ? Math.PI / 2 : window.facing === 'east' ? -Math.PI / 2 : window.facing === 'north' ? Math.PI : 0;
      for (let slot = 0; slot < count; slot += 1) {
        dummy.position.set(window.x, window.y - 0.64 + slot * 0.255, window.z);
        dummy.rotation.set(0, yaw, ((slot + windowIndex) % 3 - 1) * 0.045);
        dummy.updateMatrix();
        instances.setMatrixAt(instanceIndex, dummy.matrix);
        instanceIndex += 1;
      }
    }
    instances.count = instanceIndex;
    instances.instanceMatrix.needsUpdate = true;
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
  }

  private buildGeometry(): void {
    const concrete = new THREE.MeshStandardMaterial({ color: 0x414745, roughness: 0.94, metalness: 0.02 });
    const floorMaterial = new THREE.MeshStandardMaterial({ color: 0x252927, roughness: 0.97, metalness: 0.03 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x2f3837, roughness: 0.6, metalness: 0.66 });
    const doorMaterial = new THREE.MeshStandardMaterial({ color: 0x4d2622, roughness: 0.7, metalness: 0.48 });
    const debris = new THREE.MeshStandardMaterial({ color: 0x282c2b, roughness: 0.98 });

    for (const zone of FLOOR_ZONES) {
      if (zone.id === 'generator-floor' && zone.y === 0) {
        this.addFloor(zone.minX, zone.maxX, zone.minZ, zone.maxZ, zone.y, floorMaterial);
        continue;
      }
      if (zone.id.startsWith('stair-')) {
        const height = Math.max(0.08, zone.y);
        const mesh = new THREE.Mesh(
          new THREE.BoxGeometry(zone.maxX - zone.minX, height, zone.maxZ - zone.minZ),
          concrete,
        );
        mesh.position.set((zone.minX + zone.maxX) * 0.5, height * 0.5, (zone.minZ + zone.maxZ) * 0.5);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        this.group.add(mesh);
        continue;
      }
      this.addFloor(zone.minX, zone.maxX, zone.minZ, zone.maxZ, zone.y, floorMaterial);
    }

    for (const collider of STATIC_COLLIDERS) {
      const material = collider.kind === 'door'
        ? doorMaterial
        : collider.kind === 'railing'
          ? steel
          : collider.id.includes('debris') || collider.id.includes('core')
            ? debris
            : concrete;
      const mesh = this.meshForCollider(collider, material);
      if (collider.kind === 'door') this.doorMeshes.set(collider.id, mesh);
      this.group.add(mesh);
    }

    this.addCeiling(-7, 7, -5, 5, CONFIG.map.startHall.ceilingY, debris);
    this.addCeiling(-15, -5, 9, 17, CONFIG.map.armory.ceilingY, debris);
    this.addCeiling(1, 13, 8, 17, CONFIG.map.generator.ceilingY, debris);
    this.buildWindowRecesses(steel);
    this.buildDoorLabels();
  }

  private addFloor(minX: number, maxX: number, minZ: number, maxZ: number, y: number, material: THREE.Material): void {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((minX + maxX) * 0.5, y + 0.002, (minZ + maxZ) * 0.5);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private addCeiling(minX: number, maxX: number, minZ: number, maxZ: number, y: number, material: THREE.Material): void {
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set((minX + maxX) * 0.5, y, (minZ + maxZ) * 0.5);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private meshForCollider(collider: AabbCollider, material: THREE.Material): THREE.Mesh {
    const width = collider.maxX - collider.minX;
    const height = collider.maxY - collider.minY;
    const depth = collider.maxZ - collider.minZ;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(width, height, depth), material);
    mesh.name = collider.id;
    mesh.position.set(
      (collider.minX + collider.maxX) * 0.5,
      (collider.minY + collider.maxY) * 0.5,
      (collider.minZ + collider.maxZ) * 0.5,
    );
    mesh.castShadow = collider.kind !== 'railing';
    mesh.receiveShadow = true;
    return mesh;
  }

  private buildWindowRecesses(frameMaterial: THREE.Material): void {
    const moonMaterial = new THREE.MeshBasicMaterial({ color: 0x718da0, transparent: true, opacity: 0.2 });
    for (const window of WINDOWS) {
      const frame = new THREE.Group();
      frame.position.set(window.x, window.y, window.z);
      frame.rotation.y = window.facing === 'west' ? Math.PI / 2 : window.facing === 'east' ? -Math.PI / 2 : window.facing === 'north' ? Math.PI : 0;
      const panel = new THREE.Mesh(new THREE.PlaneGeometry(1.55, 1.45), moonMaterial);
      panel.position.z = 0.012;
      frame.add(panel);
      for (const x of [-0.82, 0.82]) {
        const side = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.65, 0.12), frameMaterial);
        side.position.x = x;
        frame.add(side);
      }
      for (const y of [-0.78, 0.78]) {
        const edge = new THREE.Mesh(new THREE.BoxGeometry(1.75, 0.1, 0.12), frameMaterial);
        edge.position.y = y;
        frame.add(edge);
      }
      this.group.add(frame);
    }
    const boardMaterial = new THREE.MeshStandardMaterial({ color: 0x4c3625, roughness: 0.88, metalness: 0.01 });
    this.boardInstances = new THREE.InstancedMesh(
      new THREE.BoxGeometry(CONFIG.barriers.boardWidthM, CONFIG.barriers.boardHeightM, CONFIG.barriers.boardDepthM),
      boardMaterial,
      WINDOWS.length * CONFIG.barriers.boardSlots,
    );
    this.boardInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.boardInstances.castShadow = true;
    this.boardInstances.receiveShadow = true;
    this.boardInstances.frustumCulled = false;
    this.group.add(this.boardInstances);
    this.updateBarriers(WINDOWS.map((window) => ({ id: window.id, boards: CONFIG.barriers.boardSlots })));
  }

  private buildDoorLabels(): void {
    for (const entry of DOORS) {
      const marker = new THREE.PointLight(0xa3412c, 0.65, 3.2, 2);
      const collider = entry.collider;
      marker.position.set((collider.minX + collider.maxX) * 0.5, Math.max(1.4, collider.minY + 0.7), (collider.minZ + collider.maxZ) * 0.5);
      this.group.add(marker);
    }
  }

  private buildLighting(): void {
    this.group.add(new THREE.HemisphereLight(0x4d6570, 0x10100d, 0.44));
    const roomLights = [
      { x: 0, y: 3.1, z: -1, color: 0xffa54b, intensity: 7.5, distance: 10 },
      { x: -10, y: 3.1, z: 13, color: 0xe3a465, intensity: 6.5, distance: 9 },
      { x: 7, y: 5.9, z: 12, color: 0x8ca9b5, intensity: 8, distance: 13 },
    ];
    for (const light of roomLights) {
      const point = new THREE.PointLight(light.color, light.intensity, light.distance, 2);
      point.position.set(light.x, light.y, light.z);
      point.castShadow = false;
      this.group.add(point);
    }
  }

  private buildNavDebug(): void {
    const positions: number[] = [];
    const handled = new Set<string>();
    for (const node of NAV_NODES) {
      for (const linkedId of node.links) {
        const key = [node.id, linkedId].sort().join(':');
        if (handled.has(key)) continue;
        handled.add(key);
        const linked = NAV_NODE_BY_ID.get(linkedId);
        if (linked === undefined) continue;
        positions.push(node.x, node.y + 0.18, node.z, linked.x, linked.y + 0.18, linked.z);
      }
    }
    const lines = new THREE.LineSegments(
      new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(positions, 3)),
      new THREE.LineBasicMaterial({ color: 0x4cf0cd, transparent: true, opacity: 0.78, depthTest: false }),
    );
    lines.renderOrder = 20;
    this.navDebug.add(lines);

    const points = new Float32Array(NAV_NODES.flatMap((node) => [node.x, node.y + 0.2, node.z]));
    const pointCloud = new THREE.Points(
      new THREE.BufferGeometry().setAttribute('position', new THREE.BufferAttribute(points, 3)),
      new THREE.PointsMaterial({ color: 0xf6e267, size: 0.13, sizeAttenuation: true, depthTest: false }),
    );
    pointCloud.renderOrder = 21;
    this.navDebug.add(pointCloud);
  }
}
