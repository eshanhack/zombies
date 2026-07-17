import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CONFIG, type PerkId, type PowerupId } from '../config.js';
import {
  CRATE_LOCATIONS,
  DOORS,
  FLOOR_ZONES,
  FORGE,
  PERK_MACHINES,
  POWER_SWITCH,
  STATIC_COLLIDERS,
  WALL_BUYS,
  WINDOWS,
  type AabbCollider,
} from '../map/blueprint.js';
import { NAV_NODES, NAV_NODE_BY_ID } from '../map/navgraph.js';
import type { CollisionWorld } from '../shared/movement.js';
import { SeededRng } from '../shared/rng.js';
import { applyTiledUvs, MaterialLibrary, type BunkerMaterialKind } from './MaterialLibrary.js';

export class BunkerMap {
  readonly group = new THREE.Group();
  readonly collisionWorld: CollisionWorld;
  private readonly materials = new MaterialLibrary();
  private readonly openDoors = new Set<string>();
  private readonly doorMeshes = new Map<string, THREE.Mesh>();
  private readonly navDebug = new THREE.Group();
  private readonly crateVisuals = new Map<string, {
    group: THREE.Group;
    lid: THREE.Mesh;
    shaft: THREE.Mesh;
    weaponRoot: THREE.Group;
    weaponModels: Map<keyof typeof CONFIG.weapons, THREE.Group>;
    doll: THREE.Group;
  }>();
  private readonly perkVisuals = new Map<PerkId, { material: THREE.MeshStandardMaterial; light: THREE.PointLight; sign: THREE.MeshStandardMaterial }>();
  private readonly powerupVisuals: {
    group: THREE.Group;
    icons: Map<PowerupId, THREE.Mesh>;
    core: THREE.MeshStandardMaterial;
    ring: THREE.MeshStandardMaterial;
    light: THREE.PointLight;
  }[] = [];
  private forgeVisual: {
    core: THREE.MeshStandardMaterial;
    etch: THREE.MeshStandardMaterial;
    light: THREE.PointLight;
    sparks: THREE.Points;
    weapon: THREE.Group;
  } | null = null;
  private powerLever: THREE.Mesh | null = null;
  private boardInstances: THREE.InstancedMesh | null = null;
  private grenadeInstances: THREE.InstancedMesh | null = null;
  private readonly practicalLights: { light: THREE.PointLight; order: number; baseIntensity: number }[] = [];

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

  updateCrate(
    crate: { activeLocationId: string; phase: 'closed' | 'spinning' | 'available'; weaponId: string; pendingPuppe: boolean },
    elapsedMs: number,
  ): void {
    const weaponIds = Object.keys(CONFIG.weapons) as (keyof typeof CONFIG.weapons)[];
    for (const [locationId, visual] of this.crateVisuals) {
      const active = locationId === crate.activeLocationId;
      visual.group.visible = active;
      if (!active) continue;
      visual.lid.rotation.x = THREE.MathUtils.lerp(visual.lid.rotation.x, crate.phase === 'closed' ? 0 : -1.12, 0.16);
      visual.shaft.visible = true;
      (visual.shaft.material as THREE.MeshBasicMaterial).opacity = crate.phase === 'closed'
        ? CONFIG.rendering.economyVisual.crateShaftClosedOpacity
        : CONFIG.rendering.economyVisual.crateShaftOpenOpacity;
      const showRoll = crate.phase !== 'closed';
      visual.weaponRoot.visible = showRoll;
      if (!showRoll) continue;
      const cycleIndex = Math.floor(elapsedMs / (1000 / CONFIG.rendering.economyVisual.crateCycleHz)) % weaponIds.length;
      const weaponId = crate.weaponId !== '' && crate.phase === 'available' ? crate.weaponId as keyof typeof CONFIG.weapons : weaponIds[cycleIndex] ?? 'richter';
      for (const [candidateId, model] of visual.weaponModels) model.visible = !crate.pendingPuppe && candidateId === weaponId;
      visual.doll.visible = crate.pendingPuppe;
      visual.weaponRoot.position.y = 1.18 + Math.sin(elapsedMs * 0.0035) * 0.08;
      visual.weaponRoot.rotation.y = elapsedMs * 0.0017;
    }
  }

  updateGrenades(grenades: readonly { x: number; y: number; z: number }[]): void {
    const instances = this.grenadeInstances;
    if (instances === null) return;
    const dummy = new THREE.Object3D();
    const count = Math.min(grenades.length, instances.instanceMatrix.count);
    for (let index = 0; index < count; index += 1) {
      const grenade = grenades[index]!;
      dummy.position.set(grenade.x, grenade.y, grenade.z);
      dummy.rotation.set(index * 0.7, index * 1.1, index * 0.4);
      dummy.updateMatrix();
      instances.setMatrixAt(index, dummy.matrix);
    }
    instances.count = count;
    instances.instanceMatrix.needsUpdate = true;
  }

  updatePower(powerOn: boolean, activationElapsedMs: number): void {
    const progress = powerOn ? Math.min(1, activationElapsedMs / CONFIG.power.activationMs) : 0;
    if (this.powerLever !== null) {
      this.powerLever.rotation.x = THREE.MathUtils.lerp(
        CONFIG.rendering.powerVisual.offAngleRad,
        CONFIG.rendering.powerVisual.onAngleRad,
        powerOn ? 1 : 0,
      );
    }
    for (const [perkId, visual] of this.perkVisuals) {
      const machineIndex = PERK_MACHINES.findIndex((machine) => machine.id === perkId);
      const roomDelay = CONFIG.power.roomSurgeDelayMs[Math.max(0, machineIndex)] ?? 0;
      const live = powerOn && activationElapsedMs >= roomDelay;
      const surge = live && progress < 1 ? 0.65 + Math.sin(activationElapsedMs * 0.035 + machineIndex) * 0.35 : 1;
      visual.material.emissiveIntensity = live ? CONFIG.rendering.perkVisual.poweredBodyEmissive * surge : CONFIG.rendering.perkVisual.unpoweredEmissive;
      visual.sign.emissiveIntensity = live ? CONFIG.rendering.perkVisual.poweredEmissive * 1.35 * surge : 0;
      visual.light.intensity = live ? CONFIG.rendering.perkVisual.lightIntensity * surge : 0;
    }
    for (const practical of this.practicalLights) {
      const delay = CONFIG.power.roomSurgeDelayMs[practical.order] ?? 0;
      const live = powerOn && activationElapsedMs >= delay;
      const flicker = live && activationElapsedMs < CONFIG.power.activationMs
        ? 0.68 + Math.sin(activationElapsedMs * 0.041 + practical.order * 1.7) * 0.32
        : 1;
      practical.light.intensity = live
        ? practical.baseIntensity * flicker
        : CONFIG.rendering.environment.unpoweredLightIntensity;
    }
  }

  updatePowerups(
    powerups: readonly { powerupType: PowerupId; x: number; y: number; z: number; remainingMs: number }[],
    elapsedMs: number,
  ): void {
    for (let index = 0; index < this.powerupVisuals.length; index += 1) {
      const visual = this.powerupVisuals[index]!;
      const powerup = powerups[index];
      visual.group.visible = powerup !== undefined;
      if (powerup === undefined) continue;
      const ageMs = CONFIG.powerups.despawnMs - powerup.remainingMs;
      const slowBlink = ageMs >= CONFIG.powerups.blinkAtMs[0];
      const fastBlink = ageMs >= CONFIG.powerups.blinkAtMs[1];
      const blinkHz = fastBlink ? 8 : slowBlink ? 3 : 0;
      const shown = blinkHz === 0 || Math.sin(elapsedMs / 1000 * Math.PI * 2 * blinkHz) > -0.25;
      visual.group.visible = shown;
      const color = CONFIG.rendering.powerupVisual.colors[powerup.powerupType];
      visual.core.color.setHex(color);
      visual.core.emissive.setHex(color);
      visual.ring.color.setHex(color);
      visual.ring.emissive.setHex(color);
      visual.light.color.setHex(color);
      for (const [type, icon] of visual.icons) icon.visible = type === powerup.powerupType;
      visual.group.position.set(
        powerup.x,
        powerup.y + Math.sin(elapsedMs * 0.0017 + index) * CONFIG.powerups.visualHoverM,
        powerup.z,
      );
      visual.group.rotation.y = elapsedMs / 1000 * CONFIG.powerups.visualSpinRadPerSecond;
    }
  }

  updateForge(
    forge: { phase: 'idle' | 'upgrading'; remainingMs: number },
    powerOn: boolean,
    elapsedMs: number,
  ): void {
    const visual = this.forgeVisual;
    if (visual === null) return;
    const upgrading = forge.phase === 'upgrading';
    const progress = upgrading ? 1 - forge.remainingMs / CONFIG.forge.animationMs : 0;
    visual.core.emissiveIntensity = powerOn
      ? upgrading ? CONFIG.rendering.forgeVisual.upgradingEmissive : CONFIG.rendering.forgeVisual.poweredEmissive
      : CONFIG.rendering.forgeVisual.unpoweredEmissive;
    visual.etch.emissiveIntensity = powerOn
      ? upgrading ? CONFIG.rendering.forgeVisual.upgradingEmissive : CONFIG.rendering.forgeVisual.poweredEmissive
      : CONFIG.rendering.forgeVisual.unpoweredEmissive;
    visual.light.intensity = powerOn
      ? CONFIG.rendering.forgeVisual.lightIntensity * (upgrading ? 0.72 + Math.sin(elapsedMs * 0.045) * 0.28 : 0.2)
      : 0;
    visual.sparks.visible = upgrading;
    visual.sparks.rotation.y = elapsedMs * 0.004;
    (visual.sparks.material as THREE.PointsMaterial).opacity = upgrading ? 0.45 + Math.sin(elapsedMs * 0.028) * 0.35 : 0;
    visual.weapon.visible = upgrading;
    if (upgrading) {
      visual.weapon.position.y = CONFIG.rendering.forgeVisual.bodyHeightM * (0.82 - Math.sin(progress * Math.PI) * 0.36);
      visual.weapon.rotation.y = elapsedMs * 0.0024;
      visual.weapon.scale.setScalar(0.78 + Math.sin(progress * Math.PI) * 0.08);
    }
  }

  dispose(): void {
    this.group.traverse((object) => {
      if (object instanceof THREE.Mesh || object instanceof THREE.LineSegments || object instanceof THREE.Points) {
        object.geometry.dispose();
        const materials = Array.isArray(object.material) ? object.material : [object.material];
        for (const material of materials) material.dispose();
      }
    });
    this.materials.dispose();
  }

  private buildGeometry(): void {
    const concrete = this.materials.concrete;
    const plaster = this.materials.plaster;
    const floorMaterial = this.materials.clone('concrete', { color: 0x686c66, roughness: 0.98 });
    const steel = this.materials.steel;
    const doorMaterial = this.materials.clone('steel', { color: 0x5b302b, roughness: 0.71 });
    const debris = this.materials.clone('concrete', { color: 0x555956, roughness: 0.99 });

    for (const zone of FLOOR_ZONES) {
      if (zone.id === 'generator-floor' && zone.y === 0) {
        this.addFloor(zone.minX, zone.maxX, zone.minZ, zone.maxZ, zone.y, floorMaterial);
        continue;
      }
      if (zone.id.startsWith('stair-')) {
        const height = Math.max(0.08, zone.y);
        const mesh = new THREE.Mesh(applyTiledUvs(new THREE.BoxGeometry(zone.maxX - zone.minX, height, zone.maxZ - zone.minZ)), concrete);
        mesh.position.set((zone.minX + zone.maxX) * 0.5, height * 0.5, (zone.minZ + zone.maxZ) * 0.5);
        mesh.receiveShadow = true;
        mesh.castShadow = true;
        this.group.add(mesh);
        continue;
      }
      this.addFloor(zone.minX, zone.maxX, zone.minZ, zone.maxZ, zone.y, floorMaterial);
    }

    const geometryBuckets = new Map<BunkerMaterialKind | 'debris', THREE.BufferGeometry[]>([
      ['concrete', []],
      ['plaster', []],
      ['steel', []],
      ['debris', []],
    ]);
    for (const collider of STATIC_COLLIDERS) {
      if (collider.kind === 'door') {
        const mesh = this.meshForCollider(collider, doorMaterial);
        this.doorMeshes.set(collider.id, mesh);
        this.group.add(mesh);
        this.decorateDoor(collider, mesh, steel);
        continue;
      }
      const kind: BunkerMaterialKind | 'debris' = collider.kind === 'railing'
        ? 'steel'
        : collider.id.includes('debris') || collider.id.includes('core')
          ? 'debris'
          : collider.id.startsWith('generator') || collider.id.startsWith('catwalk')
            ? 'concrete'
            : 'plaster';
      if (collider.id === 'start-debris') continue;
      geometryBuckets.get(kind)?.push(this.geometryForCollider(collider));
    }
    for (const [kind, geometries] of geometryBuckets) {
      if (geometries.length === 0) continue;
      const merged = mergeGeometries(geometries, false);
      for (const geometry of geometries) geometry.dispose();
      if (merged === null) throw new Error(`Unable to merge ${kind} bunker geometry.`);
      const material = kind === 'debris' ? debris : kind === 'plaster' ? plaster : kind === 'steel' ? steel : concrete;
      const mesh = new THREE.Mesh(merged, material);
      mesh.name = `merged-static-${kind}`;
      mesh.castShadow = kind !== 'steel';
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }

    this.addCeiling(-7, 7, -5, 5, CONFIG.map.startHall.ceilingY, debris);
    this.addCeiling(-15, -5, 9, 17, CONFIG.map.armory.ceilingY, debris);
    this.addCeiling(1, 13, 8, 17, CONFIG.map.generator.ceilingY, debris);
    this.buildWindowRecesses(steel);
    this.buildDoorLabels();
    this.buildEconomyGeometry(steel);
    this.buildArchitecturalDetail();
    this.buildExterior();
  }

  private addFloor(minX: number, maxX: number, minZ: number, maxZ: number, y: number, material: THREE.Material): void {
    const mesh = new THREE.Mesh(applyTiledUvs(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ)), material);
    mesh.rotation.x = -Math.PI / 2;
    mesh.position.set((minX + maxX) * 0.5, y + 0.002, (minZ + maxZ) * 0.5);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private addCeiling(minX: number, maxX: number, minZ: number, maxZ: number, y: number, material: THREE.Material): void {
    const mesh = new THREE.Mesh(applyTiledUvs(new THREE.PlaneGeometry(maxX - minX, maxZ - minZ)), material);
    mesh.rotation.x = Math.PI / 2;
    mesh.position.set((minX + maxX) * 0.5, y, (minZ + maxZ) * 0.5);
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private meshForCollider(collider: AabbCollider, material: THREE.Material): THREE.Mesh {
    const width = collider.maxX - collider.minX;
    const height = collider.maxY - collider.minY;
    const depth = collider.maxZ - collider.minZ;
    const mesh = new THREE.Mesh(applyTiledUvs(new THREE.BoxGeometry(width, height, depth)), material);
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

  private geometryForCollider(collider: AabbCollider): THREE.BufferGeometry {
    const geometry = new THREE.BoxGeometry(
      collider.maxX - collider.minX,
      collider.maxY - collider.minY,
      collider.maxZ - collider.minZ,
    );
    geometry.translate(
      (collider.minX + collider.maxX) * 0.5,
      (collider.minY + collider.maxY) * 0.5,
      (collider.minZ + collider.maxZ) * 0.5,
    );
    return applyTiledUvs(geometry);
  }

  private decorateDoor(collider: AabbCollider, door: THREE.Mesh, steel: THREE.Material): void {
    const width = collider.maxX - collider.minX;
    const height = collider.maxY - collider.minY;
    const depth = collider.maxZ - collider.minZ;
    const alongX = width > depth;
    const detailGeometry: THREE.BufferGeometry[] = [];
    for (const offset of [-0.32, 0, 0.32]) {
      const rib = new THREE.BoxGeometry(
          alongX ? width * 0.82 : Math.min(0.12, width * 0.35),
          0.075,
          alongX ? Math.min(0.12, depth * 0.35) : depth * 0.82,
      );
      rib.translate(0, offset * height, 0);
      detailGeometry.push(rib);
    }
    const handle = new THREE.TorusGeometry(0.13, 0.025, 6, 16, Math.PI * 1.5);
    if (!alongX) handle.rotateY(Math.PI / 2);
    handle.translate(alongX ? width * 0.28 : 0, 0, alongX ? -depth * 0.65 : -depth * 0.28);
    detailGeometry.push(handle);
    const merged = mergeGeometries(detailGeometry, false);
    for (const geometry of detailGeometry) geometry.dispose();
    if (merged !== null) door.add(new THREE.Mesh(merged, steel));
  }

  private buildArchitecturalDetail(): void {
    const steelGeometry: THREE.BufferGeometry[] = [];
    const woodGeometry: THREE.BufferGeometry[] = [];
    const concreteGeometry: THREE.BufferGeometry[] = [];
    const collapseGeometry: THREE.BufferGeometry[] = [];
    const addBox = (
      target: THREE.BufferGeometry[],
      size: readonly [number, number, number],
      position: readonly [number, number, number],
      rotation: readonly [number, number, number] = [0, 0, 0],
    ): void => {
      const geometry = applyTiledUvs(new THREE.BoxGeometry(size[0], size[1], size[2]));
      geometry.rotateX(rotation[0]);
      geometry.rotateY(rotation[1]);
      geometry.rotateZ(rotation[2]);
      geometry.translate(position[0], position[1], position[2]);
      target.push(geometry);
    };
    const addCylinder = (
      target: THREE.BufferGeometry[],
      from: readonly [number, number, number],
      to: readonly [number, number, number],
      radius: number,
      radialSegments = 10,
    ): void => {
      target.push(this.cylinderBetween(from, to, radius, radialSegments));
    };

    const beam = CONFIG.rendering.environment.beamWidthM;
    for (const x of [-5.8, -2.9, 0, 2.9, 5.8]) {
      addBox(concreteGeometry, [beam, 0.28, 10], [x, 3.24, 0]);
    }
    for (const x of [-13.6, -10.2, -6.8]) {
      addBox(steelGeometry, [beam, 0.18, 7.7], [x, 3.17, 13]);
    }
    for (const x of [2.4, 6.2, 10, 12.2]) {
      addBox(steelGeometry, [beam, 0.24, 8.7], [x, 6.56, 12.5]);
    }

    // Reinforced sill bands cover the seams where window-wall collider sections
    // meet and give every breach a readable structural datum.
    const lowerSillY = WINDOWS[0]!.y - CONFIG.barriers.openingHeightM * 0.5;
    const upperSillY = WINDOWS.find((window) => window.room === 'catwalk')!.y
      - CONFIG.barriers.openingHeightM * 0.5;
    addBox(steelGeometry, [13.9, 0.075, 0.07], [0, lowerSillY, -4.94]);
    addBox(steelGeometry, [0.07, 0.075, 7.9], [-14.94, lowerSillY, 13]);
    addBox(steelGeometry, [0.07, 0.075, 8.9], [12.94, lowerSillY, 12.5]);
    addBox(steelGeometry, [11.9, 0.075, 0.07], [7, upperSillY, 8.06]);

    const pipe = CONFIG.rendering.environment.pipeRadiusM;
    addCylinder(steelGeometry, [-6.78, 2.72, -4.5], [-6.78, 2.72, 4.4], pipe);
    addCylinder(steelGeometry, [-6.78, 2.72, 4.4], [-5.3, 2.72, 6.2], pipe);
    addCylinder(steelGeometry, [-14.74, 2.58, 9.5], [-14.74, 2.58, 16.4], pipe * 1.18);
    addCylinder(steelGeometry, [1.22, 5.55, 8.5], [1.22, 5.55, 16.5], pipe * 1.45);
    addCylinder(steelGeometry, [1.22, 5.55, 16.5], [12.5, 5.55, 16.5], pipe * 1.45);
    addCylinder(steelGeometry, [12.5, 5.55, 16.5], [12.5, 1.25, 16.5], pipe * 1.45);
    for (const z of [9.2, 10.8, 15.7]) {
      addCylinder(steelGeometry, [1.18, 1.05, z], [1.18, 5.1, z], pipe * 0.82, 8);
    }

    const conduit = CONFIG.rendering.environment.conduitRadiusM;
    for (const y of [0.82, 1.14, 1.46]) {
      addCylinder(steelGeometry, [-6.79, y, -4.4], [-6.79, y, 3.5], conduit, 6);
      addCylinder(steelGeometry, [-14.78, y + 0.25, 9.5], [-14.78, y + 0.25, 16.4], conduit, 6);
    }

    // Armory storage and room-specific silhouettes.
    for (const z of [10.1, 12.7, 15.3]) {
      addBox(steelGeometry, [0.08, 2.15, 1.85], [-6.05, 1.08, z]);
      for (const y of [0.38, 1.05, 1.72]) addBox(steelGeometry, [0.82, 0.045, 1.82], [-6.45, y, z]);
    }
    for (const position of [[-13.3, 0.37, 10.1], [-8.6, 0.31, 15.8], [4.6, 0.35, 3.9]] as const) {
      addBox(woodGeometry, [1.05, 0.62, 0.72], position);
      addBox(steelGeometry, [1.08, 0.06, 0.75], [position[0], position[1] + 0.09, position[2]]);
    }

    // Hide the Start Hall collision core beneath a deterministic broken-concrete
    // collapse so no collision-shaped box survives the production art pass.
    const collapseRng = new SeededRng(CONFIG.rendering.environment.detailSeed ^ 0xc011a95e);
    for (let index = 0; index < CONFIG.rendering.environment.collapseChunkCount; index += 1) {
      const angle = collapseRng.next() * Math.PI * 2;
      const distance = Math.sqrt(collapseRng.next()) * CONFIG.rendering.environment.collapseSpreadM;
      const radius = THREE.MathUtils.lerp(
        CONFIG.rendering.environment.collapseChunkRadiusMinM,
        CONFIG.rendering.environment.collapseChunkRadiusMaxM,
        collapseRng.next(),
      );
      const shard = applyTiledUvs(new THREE.TetrahedronGeometry(0.5, 0));
      shard.scale(
        radius * (0.85 + collapseRng.next() * 0.65),
        radius * (0.38 + collapseRng.next() * 0.34),
        radius * (0.8 + collapseRng.next() * 0.62),
      );
      shard.rotateX(collapseRng.next() * Math.PI);
      shard.rotateY(collapseRng.next() * Math.PI);
      shard.rotateZ(collapseRng.next() * Math.PI);
      shard.translate(
        Math.cos(angle) * distance,
        THREE.MathUtils.lerp(
          CONFIG.rendering.environment.collapseChunkMinY,
          CONFIG.rendering.environment.collapseChunkMaxY,
          collapseRng.next(),
        ),
        0.2 + Math.sin(angle) * distance,
      );
      collapseGeometry.push(shard);
    }
    // PolyhedronGeometry is non-indexed, so keep the buried collapse footing
    // non-indexed as well; BufferGeometryUtils rejects mixed index layouts.
    const collapseFooting = applyTiledUvs(new THREE.BoxGeometry(2.25, 0.3, 1.55)).toNonIndexed();
    collapseFooting.rotateX(0.04);
    collapseFooting.rotateY(-0.12);
    collapseFooting.rotateZ(0.03);
    collapseFooting.translate(-0.04, 0.14, 0.18);
    collapseGeometry.push(collapseFooting);
    addBox(woodGeometry, [0.18, 0.16, 3.1], [-0.55, 0.63, 0.18], [0.16, -0.48, 0.08]);
    addBox(woodGeometry, [0.16, 0.14, 2.65], [0.62, 0.52, 0.04], [-0.12, 0.62, -0.1]);

    // Generator machinery: flywheels, exhaust stacks, transformer ribs, and cable trunking.
    for (const x of [4.25, 6.75]) {
      addCylinder(steelGeometry, [x, 0.3, 11.3], [x, 2.35, 11.3], 0.18, 14);
      const wheel = new THREE.TorusGeometry(0.56, 0.07, 8, 24);
      wheel.rotateY(Math.PI / 2);
      wheel.translate(x, 1.08, 11.02);
      steelGeometry.push(wheel);
    }
    for (let index = 0; index < 7; index += 1) {
      addBox(steelGeometry, [0.1, 1.58, 3.2], [4.15 + index * 0.49, 1.15, 13.05]);
    }
    for (const z of [11.55, 12.35, 13.15, 13.95, 14.65]) {
      addBox(steelGeometry, [0.075, 2.32, 0.07], [7.24, 1.28, z]);
    }
    for (const y of [0.34, 1.12, 2.2]) addBox(steelGeometry, [0.075, 0.07, 3.55], [7.245, y, 13.05]);
    for (let index = 0; index < 6; index += 1) {
      addBox(steelGeometry, [1.82, 0.045, 0.075], [5.42, 0.48 + index * 0.19, 11.09]);
    }
    for (const x of [4.48, 6.32]) {
      const gauge = new THREE.TorusGeometry(0.19, 0.026, 7, 20);
      gauge.translate(x, 1.92, 11.075);
      steelGeometry.push(gauge);
    }
    addCylinder(steelGeometry, [3.95, 2.22, 14.42], [3.95, 5.72, 14.42], pipe * 2.1, 12);
    addCylinder(steelGeometry, [7.05, 2.22, 14.42], [7.05, 5.72, 14.42], pipe * 2.1, 12);

    // Exposed rebar and broken ceiling reinforcement near the central collapse.
    for (let index = 0; index < 11; index += 1) {
      const angle = -0.7 + index * 0.14;
      addCylinder(
        steelGeometry,
        [-1.05 + index * 0.2, 2.72, 0.42],
        [-0.95 + index * 0.2 + Math.sin(angle) * 0.36, 3.48, 0.42 + Math.cos(angle) * 0.34],
        conduit * 0.82,
        6,
      );
    }

    this.addMergedDetail('steel-detail', steelGeometry, this.materials.steel, true);
    this.addMergedDetail('wood-detail', woodGeometry, this.materials.wood, true);
    this.addMergedDetail('concrete-detail', concreteGeometry, this.materials.concrete, true);
    this.addMergedDetail(
      'collapse-detail',
      collapseGeometry,
      this.materials.clone('concrete', { color: CONFIG.rendering.environment.collapseMaterialColor, roughness: 0.99 }),
      true,
    );
    this.buildRubble();
    this.buildLamps();
    this.buildDecals();
    this.buildDust();
  }

  private addMergedDetail(name: string, geometries: THREE.BufferGeometry[], material: THREE.Material, castShadow: boolean): void {
    if (geometries.length === 0) return;
    const merged = mergeGeometries(geometries, false);
    for (const geometry of geometries) geometry.dispose();
    if (merged === null) throw new Error(`Unable to merge ${name}.`);
    const mesh = new THREE.Mesh(merged, material);
    mesh.name = name;
    mesh.castShadow = castShadow;
    mesh.receiveShadow = true;
    this.group.add(mesh);
  }

  private cylinderBetween(
    from: readonly [number, number, number],
    to: readonly [number, number, number],
    radius: number,
    radialSegments: number,
  ): THREE.BufferGeometry {
    const start = new THREE.Vector3(...from);
    const end = new THREE.Vector3(...to);
    const direction = end.clone().sub(start);
    const geometry = applyTiledUvs(new THREE.CylinderGeometry(radius, radius, direction.length(), radialSegments, 1));
    const quaternion = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), direction.normalize());
    geometry.applyQuaternion(quaternion);
    geometry.translate((start.x + end.x) * 0.5, (start.y + end.y) * 0.5, (start.z + end.z) * 0.5);
    return geometry;
  }

  private buildRubble(): void {
    const count = CONFIG.rendering.environment.rubbleInstances;
    const material = this.materials.clone('concrete', { vertexColors: true, roughness: 0.99 });
    const rubble = new THREE.InstancedMesh(new THREE.DodecahedronGeometry(0.22, 0), material, count);
    rubble.name = 'instanced-structural-rubble';
    const rng = new SeededRng(CONFIG.rendering.environment.detailSeed);
    const anchors = [
      { x: 0, z: 0.25, radius: 2.4, y: 0 },
      { x: -6.4, z: 4.35, radius: 1.35, y: 0 },
      { x: -13.8, z: 16.1, radius: 1.1, y: 0 },
      { x: 2.1, z: 8.8, radius: 1.15, y: 0 },
      { x: 11.7, z: 16.1, radius: 1.05, y: 0 },
      { x: 3.1, z: 9.1, radius: 0.8, y: CONFIG.map.catwalkY },
    ] as const;
    const dummy = new THREE.Object3D();
    for (let index = 0; index < count; index += 1) {
      const anchor = anchors[index % anchors.length]!;
      const angle = rng.next() * Math.PI * 2;
      const distance = Math.sqrt(rng.next()) * anchor.radius;
      const scale = 0.28 + rng.next() * 0.82;
      dummy.position.set(anchor.x + Math.cos(angle) * distance, anchor.y + scale * 0.08, anchor.z + Math.sin(angle) * distance);
      dummy.rotation.set(rng.next() * Math.PI, rng.next() * Math.PI, rng.next() * Math.PI);
      dummy.scale.set(scale * (0.7 + rng.next() * 0.7), scale * (0.28 + rng.next() * 0.44), scale);
      dummy.updateMatrix();
      rubble.setMatrixAt(index, dummy.matrix);
      rubble.setColorAt(index, new THREE.Color().setHSL(0.09, 0.025, 0.22 + rng.next() * 0.12));
    }
    rubble.instanceMatrix.needsUpdate = true;
    if (rubble.instanceColor !== null) rubble.instanceColor.needsUpdate = true;
    rubble.castShadow = true;
    rubble.receiveShadow = true;
    this.group.add(rubble);
  }

  private buildLamps(): void {
    const locations = [
      { position: [0, 3.18, -1.4] as const, order: 0, color: CONFIG.rendering.environment.warmLightColor },
      { position: [-5.2, 3.12, 7.0] as const, order: 0, color: CONFIG.rendering.environment.warmLightColor },
      { position: [-10, 3.18, 13] as const, order: 1, color: 0xffb66f },
      { position: [-1, 3.0, 12] as const, order: 1, color: 0xe8a85f },
      { position: [2.4, 3.08, 12.4] as const, order: 2, color: CONFIG.rendering.environment.coldLightColor },
      { position: [8.8, 3.1, 14.6] as const, order: 2, color: 0xa1bcc3 },
      { position: [5.8, 6.15, 9.1] as const, order: 3, color: CONFIG.rendering.environment.warmLightColor },
      { position: [10.6, 6.12, 10.2] as const, order: 3, color: 0xff8b42 },
    ];
    const shades = new THREE.InstancedMesh(
      new THREE.CylinderGeometry(
        CONFIG.rendering.environment.lampRadiusM,
        CONFIG.rendering.environment.lampShadeRadiusM,
        0.19,
        12,
        1,
        true,
      ),
      this.materials.steel,
      locations.length,
    );
    const bulbMaterial = new THREE.MeshStandardMaterial({
      color: 0xffc77f,
      emissive: 0xffa64f,
      emissiveIntensity: CONFIG.rendering.environment.practicalBulbEmissive,
      roughness: 0.18,
    });
    const bulbs = new THREE.InstancedMesh(new THREE.SphereGeometry(CONFIG.rendering.environment.lampRadiusM, 10, 7), bulbMaterial, locations.length);
    const dummy = new THREE.Object3D();
    locations.forEach((entry, index) => {
      dummy.position.set(entry.position[0], entry.position[1], entry.position[2]);
      dummy.rotation.set(Math.PI, 0, 0);
      dummy.updateMatrix();
      shades.setMatrixAt(index, dummy.matrix);
      dummy.position.y -= 0.11;
      dummy.rotation.set(0, 0, 0);
      dummy.updateMatrix();
      bulbs.setMatrixAt(index, dummy.matrix);
      const light = new THREE.PointLight(
        entry.color,
        CONFIG.rendering.environment.unpoweredLightIntensity,
        CONFIG.rendering.environment.practicalLightDistanceM,
        CONFIG.rendering.environment.practicalLightDecay,
      );
      light.position.set(entry.position[0], entry.position[1] - 0.12, entry.position[2]);
      light.castShadow = false;
      this.practicalLights.push({ light, order: entry.order, baseIntensity: CONFIG.rendering.environment.poweredLightIntensity });
      this.group.add(light);
    });
    shades.instanceMatrix.needsUpdate = true;
    bulbs.instanceMatrix.needsUpdate = true;
    shades.castShadow = true;
    this.group.add(shades, bulbs);
  }

  private buildDecals(): void {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 512;
    const context = canvas.getContext('2d');
    if (context !== null) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      const gradient = context.createRadialGradient(256, 256, 24, 256, 256, 238);
      gradient.addColorStop(0, 'rgba(8,5,3,.82)');
      gradient.addColorStop(0.42, 'rgba(24,14,8,.48)');
      gradient.addColorStop(1, 'rgba(30,25,19,0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 512, 512);
      context.strokeStyle = 'rgba(12,12,10,.76)';
      context.lineWidth = 4;
      context.beginPath();
      context.moveTo(252, 18);
      context.lineTo(228, 96);
      context.lineTo(277, 164);
      context.lineTo(237, 238);
      context.lineTo(286, 322);
      context.lineTo(248, 494);
      context.moveTo(238, 238);
      context.lineTo(136, 302);
      context.lineTo(84, 392);
      context.moveTo(277, 164);
      context.lineTo(368, 220);
      context.lineTo(433, 210);
      context.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.8, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1 });
    const placements = [
      [-6.81, 1.75, -2.5, Math.PI / 2], [6.81, 1.9, 2.3, -Math.PI / 2],
      [-10.5, 1.7, 16.82, Math.PI], [-14.82, 1.8, 13.1, Math.PI / 2],
      [1.18, 2.1, 14.5, -Math.PI / 2], [12.82, 2.3, 12.7, -Math.PI / 2],
      [4.2, 4.8, 8.18, 0], [10.2, 4.9, 16.82, Math.PI],
    ] as const;
    const decals = new THREE.InstancedMesh(new THREE.PlaneGeometry(2.25, 2.25), material, placements.length);
    const dummy = new THREE.Object3D();
    placements.forEach((placement, index) => {
      dummy.position.set(placement[0], placement[1], placement[2]);
      dummy.rotation.set(0, placement[3], (index % 3 - 1) * 0.15);
      dummy.scale.setScalar(0.72 + (index % 4) * 0.12);
      dummy.updateMatrix();
      decals.setMatrixAt(index, dummy.matrix);
    });
    decals.instanceMatrix.needsUpdate = true;
    decals.renderOrder = 2;
    this.group.add(decals);
  }

  private buildDust(): void {
    const count = CONFIG.rendering.environment.dustParticles;
    const rng = new SeededRng(CONFIG.rendering.environment.detailSeed ^ 0x51d05);
    const positions = new Float32Array(count * 3);
    for (let index = 0; index < count; index += 1) {
      const room = index % 3;
      const offset = index * 3;
      positions[offset] = room === 0 ? -6.8 + rng.next() * 13.6 : room === 1 ? -14.7 + rng.next() * 9.4 : 1.3 + rng.next() * 11.4;
      positions[offset + 1] = rng.next() * (room === 2 ? 6.2 : 3.25);
      positions[offset + 2] = room === 0 ? -4.8 + rng.next() * 9.6 : room === 1 ? 9.2 + rng.next() * 7.6 : 8.2 + rng.next() * 8.5;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const points = new THREE.Points(geometry, new THREE.PointsMaterial({
      color: 0xc1b79d,
      size: CONFIG.rendering.environment.dustSizeM,
      transparent: true,
      opacity: CONFIG.rendering.environment.dustOpacity,
      depthWrite: false,
    }));
    points.name = 'volumetric-dust-motes';
    this.group.add(points);
  }

  private buildExterior(): void {
    const darkEarth = this.materials.clone('concrete', { color: 0x232827, roughness: 1 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(
      CONFIG.rendering.environment.exteriorFogPlaneSizeM,
      CONFIG.rendering.environment.exteriorFogPlaneSizeM,
    ), darkEarth);
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(-1, -0.17, 4);
    ground.receiveShadow = true;
    this.group.add(ground);

    const silhouetteGeometry: THREE.BufferGeometry[] = [];
    const rng = new SeededRng(CONFIG.rendering.environment.detailSeed ^ 0x3d77);
    for (let index = 0; index < CONFIG.rendering.environment.exteriorTreeCount; index += 1) {
      const side = index % 3;
      const x = side === 0 ? -18 - rng.next() * 13 : side === 1 ? 16 + rng.next() * 15 : -14 + rng.next() * 28;
      const z = side === 2 ? -9 - rng.next() * 20 : -4 + rng.next() * 28;
      const height = 3.6 + rng.next() * 4.8;
      silhouetteGeometry.push(this.cylinderBetween([x, 0, z], [x + (rng.next() - 0.5) * 0.5, height, z], 0.1 + rng.next() * 0.12, 7));
      for (let branch = 0; branch < 4; branch += 1) {
        const branchY = height * (0.45 + branch * 0.1);
        const spread = 0.8 + rng.next() * 1.6;
        const angle = rng.next() * Math.PI * 2;
        silhouetteGeometry.push(this.cylinderBetween(
          [x, branchY, z],
          [x + Math.cos(angle) * spread, branchY + 0.7 + rng.next() * 0.8, z + Math.sin(angle) * spread],
          0.035 + rng.next() * 0.035,
          6,
        ));
      }
    }
    for (let index = 0; index < CONFIG.rendering.environment.exteriorWirePosts; index += 1) {
      const x = -21 + index * 1.7;
      const z = -7.7 + Math.sin(index * 0.72) * 0.7;
      silhouetteGeometry.push(this.cylinderBetween([x, 0, z], [x, 1.65, z], 0.035, 6));
      if (index > 0) {
        const priorX = -21 + (index - 1) * 1.7;
        const priorZ = -7.7 + Math.sin((index - 1) * 0.72) * 0.7;
        silhouetteGeometry.push(this.cylinderBetween([priorX, 0.72, priorZ], [x, 0.72, z], 0.008, 5));
        silhouetteGeometry.push(this.cylinderBetween([priorX, 1.23, priorZ], [x, 1.23, z], 0.008, 5));
      }
    }
    const silhouette = this.materials.clone('wood', { color: 0x141918, roughness: 1 });
    this.addMergedDetail('exterior-silhouettes', silhouetteGeometry, silhouette, false);

    const moonMaterial = new THREE.MeshBasicMaterial({ color: CONFIG.rendering.environment.moonColor, transparent: true, opacity: 0.72, fog: false });
    const moon = new THREE.Mesh(new THREE.CircleGeometry(2.1, 32), moonMaterial);
    moon.position.set(-13, 12, -31);
    moon.lookAt(0, 2.2, 0);
    this.group.add(moon);
    const moonLight = new THREE.DirectionalLight(
      CONFIG.rendering.environment.moonColor,
      CONFIG.rendering.environment.moonIntensity,
    );
    moonLight.position.set(-11, 15, -18);
    moonLight.castShadow = true;
    moonLight.shadow.mapSize.set(CONFIG.rendering.shadowMapSize, CONFIG.rendering.shadowMapSize);
    const shadowFrustum = CONFIG.rendering.environment.shadowFrustumM;
    moonLight.shadow.camera.left = -shadowFrustum;
    moonLight.shadow.camera.right = shadowFrustum;
    moonLight.shadow.camera.top = shadowFrustum;
    moonLight.shadow.camera.bottom = -shadowFrustum;
    moonLight.shadow.camera.near = 1;
    moonLight.shadow.camera.far = shadowFrustum * 2.5;
    moonLight.shadow.normalBias = CONFIG.rendering.environment.shadowNormalBias;
    this.group.add(moonLight);
  }

  private buildWindowRecesses(frameMaterial: THREE.Material): void {
    const moonMaterial = new THREE.MeshBasicMaterial({ color: 0x718da0, transparent: true, opacity: 0.2 });
    const frameInstances = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), frameMaterial, WINDOWS.length * 4);
    const panelInstances = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), moonMaterial, WINDOWS.length);
    const rootMatrix = new THREE.Matrix4();
    const localMatrix = new THREE.Matrix4();
    const resultMatrix = new THREE.Matrix4();
    const rootQuaternion = new THREE.Quaternion();
    const localQuaternion = new THREE.Quaternion();
    let frameIndex = 0;
    WINDOWS.forEach((window, windowIndex) => {
      const yaw = window.facing === 'west' ? Math.PI / 2 : window.facing === 'east' ? -Math.PI / 2 : window.facing === 'north' ? Math.PI : 0;
      rootQuaternion.setFromEuler(new THREE.Euler(0, yaw, 0));
      rootMatrix.compose(new THREE.Vector3(window.x, window.y, window.z), rootQuaternion, new THREE.Vector3(1, 1, 1));
      for (const x of [-0.82, 0.82]) {
        localMatrix.compose(new THREE.Vector3(x, 0, 0), localQuaternion, new THREE.Vector3(0.1, 1.65, 0.12));
        frameInstances.setMatrixAt(frameIndex, resultMatrix.multiplyMatrices(rootMatrix, localMatrix));
        frameIndex += 1;
      }
      for (const y of [-0.78, 0.78]) {
        localMatrix.compose(new THREE.Vector3(0, y, 0), localQuaternion, new THREE.Vector3(1.75, 0.1, 0.12));
        frameInstances.setMatrixAt(frameIndex, resultMatrix.multiplyMatrices(rootMatrix, localMatrix));
        frameIndex += 1;
      }
      localMatrix.compose(new THREE.Vector3(0, 0, 0.012), localQuaternion, new THREE.Vector3(1.55, 1.45, 1));
      panelInstances.setMatrixAt(windowIndex, resultMatrix.multiplyMatrices(rootMatrix, localMatrix));
    });
    frameInstances.instanceMatrix.needsUpdate = true;
    panelInstances.instanceMatrix.needsUpdate = true;
    frameInstances.castShadow = true;
    frameInstances.receiveShadow = true;
    this.group.add(frameInstances, panelInstances);
    const boardMaterial = this.materials.clone('wood', { color: 0x9c7955, roughness: 0.9 });
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

  private buildEconomyGeometry(steel: THREE.Material): void {
    for (const wallBuy of WALL_BUYS) {
      const canvas = document.createElement('canvas');
      canvas.width = 512;
      canvas.height = 192;
      const context = canvas.getContext('2d');
      if (context !== null) {
        context.clearRect(0, 0, canvas.width, canvas.height);
        context.strokeStyle = '#d8dfcb';
        context.fillStyle = '#d8dfcb';
        context.lineWidth = 5;
        context.font = 'bold 39px serif';
        context.textAlign = 'center';
        context.strokeRect(13, 15, 486, 162);
        const label = wallBuy.weaponId === undefined ? 'FRAG GRENADES ×4' : CONFIG.weapons[wallBuy.weaponId].name.toUpperCase();
        context.fillText(label, 256, 82);
        context.font = 'bold 30px monospace';
        context.fillText(`${wallBuy.cost} PTS`, 256, 133);
      }
      const texture = new THREE.CanvasTexture(canvas);
      texture.colorSpace = THREE.SRGBColorSpace;
      const material = new THREE.MeshBasicMaterial({ map: texture, transparent: true, opacity: 0.8, depthWrite: false });
      const marker = new THREE.Mesh(new THREE.PlaneGeometry(1.58, 0.6), material);
      marker.position.set(wallBuy.x, wallBuy.y, wallBuy.z);
      marker.rotation.y = wallBuy.yaw;
      marker.translateZ(0.025);
      this.group.add(marker);
    }

    const crateWood = this.materials.clone('wood', { color: 0x7c5a3e, roughness: 0.9 });
    const crateTrim = this.materials.clone('steel', { color: 0x6c7774, roughness: 0.56, metalness: 0.72 });
    for (const location of CRATE_LOCATIONS) {
      const group = new THREE.Group();
      group.position.set(location.x, location.y, location.z);
      group.rotation.y = location.yaw;
      const base = new THREE.Mesh(new THREE.BoxGeometry(1.35, 0.58, 0.72), crateWood);
      base.position.y = 0.34;
      base.castShadow = true;
      group.add(base);
      const bands = new THREE.Mesh(new THREE.BoxGeometry(1.39, 0.12, 0.76), crateTrim);
      bands.position.y = 0.42;
      group.add(bands);
      const lid = new THREE.Mesh(new THREE.BoxGeometry(1.38, 0.16, 0.76), crateWood);
      lid.position.set(0, 0.72, -0.33);
      lid.geometry.translate(0, 0, 0.33);
      lid.castShadow = true;
      group.add(lid);
      const shaft = new THREE.Mesh(
        new THREE.CylinderGeometry(0.42, 0.72, CONFIG.rendering.economyVisual.crateShaftHeightM, 16, 1, true),
        new THREE.MeshBasicMaterial({
          color: CONFIG.rendering.economyVisual.crateBlue,
          transparent: true,
          opacity: CONFIG.rendering.economyVisual.crateShaftClosedOpacity,
          depthWrite: false,
          side: THREE.DoubleSide,
        }),
      );
      shaft.position.y = CONFIG.rendering.economyVisual.crateShaftHeightM * 0.5;
      group.add(shaft);
      const markerLight = new THREE.PointLight(
        CONFIG.rendering.economyVisual.crateBlue,
        CONFIG.rendering.economyVisual.crateMarkerLightIntensity,
        CONFIG.rendering.economyVisual.crateMarkerLightDistanceM,
        2,
      );
      markerLight.position.set(0, 1.15, 0);
      group.add(markerLight);
      const weaponRoot = new THREE.Group();
      const weaponModels = new Map<keyof typeof CONFIG.weapons, THREE.Group>();
      for (const weaponId of Object.keys(CONFIG.weapons) as (keyof typeof CONFIG.weapons)[]) {
        const model = this.buildCrateWeaponModel(weaponId);
        model.visible = false;
        weaponModels.set(weaponId, model);
        weaponRoot.add(model);
      }
      const doll = this.buildPuppeModel();
      doll.visible = false;
      weaponRoot.add(doll);
      weaponRoot.visible = false;
      group.add(weaponRoot);
      group.visible = false;
      this.crateVisuals.set(location.id, { group, lid, shaft, weaponRoot, weaponModels, doll });
      this.group.add(group);
    }

    this.grenadeInstances = new THREE.InstancedMesh(
      new THREE.CapsuleGeometry(CONFIG.combat.grenadeCollisionRadiusM, 0.12, 3, 6),
      steel,
      CONFIG.coop.maxPlayers * CONFIG.combat.maxGrenades,
    );
    this.grenadeInstances.count = 0;
    this.grenadeInstances.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.grenadeInstances.castShadow = true;
    this.group.add(this.grenadeInstances);

    this.buildPowerAndPerks(steel);
    this.buildForge(steel);
    this.buildPowerupPool();
  }

  private buildForge(steel: THREE.Material): void {
    const visual = CONFIG.rendering.forgeVisual;
    const group = new THREE.Group();
    group.position.set(FORGE.x, FORGE.y, FORGE.z);
    group.rotation.y = FORGE.yaw;
    const shell = new THREE.MeshStandardMaterial({
      color: visual.metalColor,
      roughness: 0.46,
      metalness: 0.82,
    });
    const core = new THREE.MeshStandardMaterial({
      color: visual.emberColor,
      emissive: visual.emberColor,
      emissiveIntensity: visual.unpoweredEmissive,
      roughness: 0.28,
      metalness: 0.32,
    });
    const etch = new THREE.MeshStandardMaterial({
      color: visual.etchColor,
      emissive: visual.emberColor,
      emissiveIntensity: visual.unpoweredEmissive,
      roughness: 0.4,
      metalness: 0.5,
    });
    const body = new THREE.Mesh(new THREE.BoxGeometry(visual.bodyWidthM, visual.bodyHeightM, visual.bodyDepthM), shell);
    body.position.y = visual.bodyHeightM * 0.5;
    body.castShadow = true;
    group.add(body);
    const chamber = new THREE.Mesh(
      new THREE.CylinderGeometry(visual.chamberRadiusM, visual.chamberRadiusM, visual.chamberLengthM, 20, 1, true),
      core,
    );
    chamber.rotation.z = Math.PI / 2;
    chamber.position.set(0, visual.bodyHeightM * 0.74, -visual.bodyDepthM * 0.52);
    group.add(chamber);
    for (const side of [-1, 1]) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(visual.ringRadiusM, visual.ringTubeM, 8, 24), etch);
      ring.rotation.y = Math.PI / 2;
      ring.position.set(side * visual.chamberLengthM * 0.43, visual.bodyHeightM * 0.74, -visual.bodyDepthM * 0.52);
      group.add(ring);
      const conduit = new THREE.Mesh(new THREE.CylinderGeometry(visual.ringTubeM, visual.ringTubeM, visual.bodyHeightM * 0.58, 8), steel);
      conduit.position.set(side * visual.bodyWidthM * 0.38, visual.bodyHeightM * 0.34, -visual.bodyDepthM * 0.58);
      group.add(conduit);
    }
    const hatch = new THREE.Mesh(new THREE.BoxGeometry(visual.bodyWidthM * 0.62, visual.bodyHeightM * 0.34, visual.ringTubeM), etch);
    hatch.position.set(0, visual.bodyHeightM * 0.3, -visual.bodyDepthM * 0.53);
    group.add(hatch);
    const portal = new THREE.Mesh(
      new THREE.TorusGeometry(visual.ringRadiusM * 0.78, visual.ringTubeM * 1.4, 10, 28),
      etch,
    );
    portal.position.set(0, visual.bodyHeightM * 0.67, -visual.bodyDepthM * 0.59);
    group.add(portal);
    const throat = new THREE.Mesh(
      new THREE.CircleGeometry(visual.ringRadiusM * 0.68, 28),
      core,
    );
    throat.position.set(0, visual.bodyHeightM * 0.67, -visual.bodyDepthM * 0.595);
    group.add(throat);
    for (const side of [-1, 1]) {
      const upright = new THREE.Mesh(
        new THREE.BoxGeometry(visual.bodyWidthM * 0.12, visual.bodyHeightM * 0.92, visual.ringTubeM * 1.8),
        etch,
      );
      upright.position.set(side * visual.bodyWidthM * 0.42, visual.bodyHeightM * 0.5, -visual.bodyDepthM * 0.61);
      group.add(upright);
    }
    const weapon = new THREE.Group();
    const weaponBody = new THREE.Mesh(new THREE.BoxGeometry(visual.bodyWidthM * 0.42, visual.ringTubeM * 2.4, visual.chamberLengthM * 0.62), etch);
    const weaponBarrel = new THREE.Mesh(new THREE.CylinderGeometry(visual.ringTubeM * 0.42, visual.ringTubeM * 0.55, visual.chamberLengthM * 0.54, 8), core);
    weaponBarrel.rotation.x = Math.PI / 2;
    weaponBarrel.position.z = -visual.chamberLengthM * 0.52;
    weapon.add(weaponBody, weaponBarrel);
    weapon.visible = false;
    group.add(weapon);
    const sparkPositions = new Float32Array(visual.sparkCount * 3);
    for (let index = 0; index < visual.sparkCount; index += 1) {
      const angle = index / visual.sparkCount * Math.PI * 2;
      const radius = visual.chamberRadiusM * (0.38 + (index % 5) * 0.12);
      sparkPositions[index * 3] = Math.cos(angle) * radius;
      sparkPositions[index * 3 + 1] = visual.bodyHeightM * 0.74 + Math.sin(index * 2.17) * visual.chamberRadiusM;
      sparkPositions[index * 3 + 2] = -visual.bodyDepthM * 0.62 + Math.sin(angle) * radius;
    }
    const sparkGeometry = new THREE.BufferGeometry();
    sparkGeometry.setAttribute('position', new THREE.BufferAttribute(sparkPositions, 3));
    const sparks = new THREE.Points(sparkGeometry, new THREE.PointsMaterial({
      color: visual.emberColor,
      size: visual.sparkRadiusM,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    }));
    sparks.visible = false;
    group.add(sparks);
    const light = new THREE.PointLight(visual.emberColor, 0, visual.lightDistanceM, 2);
    light.position.set(0, visual.bodyHeightM * 0.78, -visual.bodyDepthM * 0.8);
    group.add(light);
    this.forgeVisual = { core, etch, light, sparks, weapon };
    this.group.add(group);
  }

  private buildCrateWeaponModel(weaponId: keyof typeof CONFIG.weapons): THREE.Group {
    const definition = CONFIG.weapons[weaponId];
    const group = new THREE.Group();
    group.name = `crate-model-${weaponId}`;
    const glow = new THREE.MeshStandardMaterial({
      color: definition.color,
      emissive: CONFIG.rendering.economyVisual.crateBlue,
      emissiveIntensity: 0.72,
      roughness: weaponId === 'blitzwerfer' || weaponId === 'sonnenpistole' ? 0.24 : 0.42,
      metalness: 0.68,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x262c2a, emissive: 0x162b35, emissiveIntensity: 0.32, roughness: 0.62, metalness: 0.54 });
    const pistol = weaponId === 'melder' || weaponId === 'richter' || weaponId === 'sonnenpistole';
    const heavy = weaponId === 'lasttraeger' || weaponId === 'kettenhund';
    const shotgun = weaponId === 'doppelhieb' || weaponId === 'grabenfeger';
    const scoped = weaponId === 'fernblick';
    const length = pistol ? 0.58 : heavy ? 1.22 : shotgun ? 1.12 : 0.98;
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(pistol ? 0.13 : 0.18, pistol ? 0.12 : 0.16, length * 0.42), glow);
    receiver.position.z = -length * 0.12;
    group.add(receiver);
    const barrelCount = weaponId === 'doppelhieb' || weaponId === 'blitzwerfer' ? 2 : 1;
    for (let index = 0; index < barrelCount; index += 1) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.025, length * 0.48, 9), dark);
      barrel.rotation.x = Math.PI / 2;
      barrel.position.set((index - (barrelCount - 1) * 0.5) * 0.065, 0.025, -length * 0.5);
      group.add(barrel);
    }
    const grip = new THREE.Mesh(new THREE.BoxGeometry(0.11, pistol ? 0.24 : 0.2, 0.11), dark);
    grip.position.set(0, -0.14, pistol ? 0.08 : -0.04);
    grip.rotation.x = -0.2;
    group.add(grip);
    if (!pistol) {
      const stock = new THREE.Mesh(new THREE.BoxGeometry(0.15, 0.15, length * 0.34), dark);
      stock.position.z = length * 0.25;
      group.add(stock);
    }
    if (heavy) {
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.13, 0.13, 0.1, 14), glow);
      drum.rotation.z = Math.PI / 2;
      drum.position.set(0.14, -0.1, -0.08);
      group.add(drum);
    }
    if (scoped) {
      const scope = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.045, 0.46, 12), dark);
      scope.rotation.x = Math.PI / 2;
      scope.position.set(0, 0.14, -0.18);
      group.add(scope);
    }
    if (weaponId === 'blitzwerfer') {
      for (const z of [-0.2, -0.38, -0.56]) {
        const coil = new THREE.Mesh(new THREE.TorusGeometry(0.11, 0.012, 6, 16), glow);
        coil.position.z = z;
        group.add(coil);
      }
    }
    if (weaponId === 'sonnenpistole') {
      const chamber = new THREE.Mesh(new THREE.SphereGeometry(0.115, 14, 9), glow);
      chamber.scale.z = 1.45;
      chamber.position.z = -0.25;
      group.add(chamber);
    }
    group.scale.setScalar(0.72);
    group.rotation.z = pistol ? -0.12 : 0.08;
    return group;
  }

  private buildPuppeModel(): THREE.Group {
    const group = new THREE.Group();
    group.name = 'die-puppe-original-doll';
    const porcelain = new THREE.MeshStandardMaterial({ color: 0xb3a28c, emissive: 0x3a1d17, emissiveIntensity: 0.48, roughness: 0.82 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0x5e342d, emissive: 0x240b0b, emissiveIntensity: 0.28, roughness: 0.96 });
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.18, 16, 11), porcelain);
    head.position.y = 0.33;
    group.add(head);
    const body = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.42, 12), cloth);
    body.position.y = 0.02;
    group.add(body);
    for (const side of [-1, 1]) {
      const limb = new THREE.Mesh(new THREE.CapsuleGeometry(0.028, 0.24, 4, 8), porcelain);
      limb.position.set(side * 0.19, 0.02, 0);
      limb.rotation.z = side * -0.42;
      group.add(limb);
    }
    const eyes = new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), new THREE.MeshBasicMaterial({ color: 0x120504 }));
    eyes.scale.x = 3.2;
    eyes.position.set(0, 0.36, -0.16);
    group.add(eyes);
    return group;
  }

  private buildPowerAndPerks(steel: THREE.Material): void {
    const machineVisual = CONFIG.rendering.perkVisual;
    for (const machine of PERK_MACHINES) {
      const group = new THREE.Group();
      group.position.set(machine.x, machine.y, machine.z);
      group.rotation.y = machine.yaw;
      const material = new THREE.MeshStandardMaterial({
        color: new THREE.Color(machine.color).multiplyScalar(machineVisual.bodyColorMultiplier),
        emissive: machine.color,
        emissiveIntensity: machineVisual.unpoweredEmissive,
        roughness: 0.48,
        metalness: 0.52,
      });
      const bodyParts: THREE.BufferGeometry[] = [];
      const bodyGeometry = new THREE.BoxGeometry(machineVisual.bodyWidthM, machineVisual.bodyHeightM, machineVisual.bodyDepthM, 3, 5, 2);
      bodyGeometry.translate(0, machineVisual.bodyHeightM * 0.5, 0);
      bodyParts.push(bodyGeometry);
      const crownGeometry = new THREE.CylinderGeometry(machineVisual.bodyWidthM * 0.42, machineVisual.bodyWidthM * 0.52, machineVisual.signHeightM, 12, 2);
      crownGeometry.translate(0, machineVisual.bodyHeightM + machineVisual.signHeightM * 0.35, 0);
      bodyParts.push(crownGeometry);
      for (const side of [-1, 1]) {
        const column = new THREE.CylinderGeometry(0.055, 0.07, machineVisual.bodyHeightM * 0.72, 8);
        column.translate(side * machineVisual.bodyWidthM * 0.47, machineVisual.bodyHeightM * 0.48, -machineVisual.bodyDepthM * 0.22);
        bodyParts.push(column);
      }
      if (machine.id === 'eisenbrau') {
        const barrelTop = new THREE.SphereGeometry(machineVisual.bodyWidthM * 0.39, 16, 8, 0, Math.PI * 2, 0, Math.PI * 0.55);
        barrelTop.scale(1, 0.64, 0.9);
        barrelTop.translate(0, machineVisual.bodyHeightM + 0.26, 0);
        bodyParts.push(barrelTop);
      }
      if (machine.id === 'schnellwasser') {
        for (const side of [-1, 1]) {
          const fin = new THREE.ConeGeometry(0.12, 0.46, 8);
          fin.translate(side * 0.22, machineVisual.bodyHeightM + 0.34, 0);
          bodyParts.push(fin);
        }
      }
      if (machine.id === 'doppelschuss') {
        for (const side of [-1, 1]) {
          const flask = new THREE.CylinderGeometry(0.12, 0.15, 0.48, 10);
          flask.translate(side * 0.18, machineVisual.bodyHeightM + 0.31, 0);
          bodyParts.push(flask);
        }
      }
      if (machine.id === 'zweiterAtem') {
        for (const side of [-1, 1]) {
          const wing = new THREE.BoxGeometry(0.28, 0.09, 0.12, 3, 1, 2);
          wing.rotateZ(side * 0.42);
          wing.translate(side * 0.31, machineVisual.bodyHeightM + 0.28, 0);
          bodyParts.push(wing);
        }
      }
      const mergedBody = mergeGeometries(bodyParts, false);
      for (const part of bodyParts) part.dispose();
      if (mergedBody === null) throw new Error(`Unable to merge ${machine.id} machine body.`);
      const body = new THREE.Mesh(mergedBody, material);
      body.castShadow = true;
      group.add(body);
      const signCanvas = document.createElement('canvas');
      signCanvas.width = 512;
      signCanvas.height = 256;
      const signContext = signCanvas.getContext('2d');
      if (signContext !== null) {
        signContext.fillStyle = '#111614';
        signContext.fillRect(0, 0, 512, 256);
        signContext.strokeStyle = '#c9c2ae';
        signContext.lineWidth = 7;
        signContext.strokeRect(13, 13, 486, 230);
        signContext.fillStyle = '#eee6d1';
        signContext.textAlign = 'center';
        signContext.font = '700 48px Arial Narrow, sans-serif';
        const label = CONFIG.perkRuntime.displayNames[machine.id].toUpperCase();
        const words = label.split(' ');
        signContext.fillText(words[0] ?? label, 256, words.length > 1 ? 112 : 143);
        if (words.length > 1) signContext.fillText(words.slice(1).join(' '), 256, 174);
      }
      const signTexture = new THREE.CanvasTexture(signCanvas);
      signTexture.colorSpace = THREE.SRGBColorSpace;
      const signMaterial = new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: machine.color,
        emissiveIntensity: 0,
        map: signTexture,
        roughness: 0.34,
        metalness: 0.15,
      });
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(machineVisual.bodyWidthM * 0.72, machineVisual.bodyHeightM * 0.34), signMaterial);
      sign.position.set(0, machineVisual.bodyHeightM * 0.61, -machineVisual.bodyDepthM * 0.505);
      sign.rotation.y = Math.PI;
      group.add(sign);
      const trimParts: THREE.BufferGeometry[] = [];
      const dispenserGeometry = new THREE.BoxGeometry(machineVisual.bodyWidthM * 0.48, 0.22, 0.12, 3, 2, 2);
      dispenserGeometry.translate(0, machineVisual.bodyHeightM * 0.25, -machineVisual.bodyDepthM * 0.58);
      trimParts.push(dispenserGeometry);
      const dial = new THREE.TorusGeometry(0.115, 0.022, 7, 16);
      dial.translate(0, machineVisual.bodyHeightM * 0.43, -machineVisual.bodyDepthM * 0.585);
      trimParts.push(dial);
      for (const side of [-1, 1]) {
        const foot = new THREE.BoxGeometry(machineVisual.bodyWidthM * 0.22, 0.1, machineVisual.bodyDepthM * 0.82);
        foot.translate(side * machineVisual.bodyWidthM * 0.3, 0.05, 0);
        trimParts.push(foot);
      }
      for (let line = 0; line < 4; line += 1) {
        const grille = new THREE.BoxGeometry(machineVisual.bodyWidthM * 0.52, 0.018, 0.035);
        grille.translate(0, machineVisual.bodyHeightM * (0.72 + line * 0.045), -machineVisual.bodyDepthM * 0.59);
        trimParts.push(grille);
      }
      const mergedTrim = mergeGeometries(trimParts, false);
      for (const part of trimParts) part.dispose();
      if (mergedTrim === null) throw new Error(`Unable to merge ${machine.id} machine trim.`);
      group.add(new THREE.Mesh(mergedTrim, steel));
      const light = new THREE.PointLight(machine.color, 0, 3.2, 2);
      light.position.set(0, machineVisual.bodyHeightM * 0.68, -0.48);
      group.add(light);
      this.perkVisuals.set(machine.id, { material, light, sign: signMaterial });
      this.group.add(group);
    }

    const breaker = new THREE.Group();
    breaker.position.set(POWER_SWITCH.x, POWER_SWITCH.y, POWER_SWITCH.z);
    breaker.rotation.y = POWER_SWITCH.yaw;
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.72, 1.08, 0.2), steel);
    panel.castShadow = true;
    breaker.add(panel);
    this.powerLever = new THREE.Mesh(new THREE.BoxGeometry(0.12, CONFIG.rendering.powerVisual.leverLengthM, 0.12), steel);
    this.powerLever.geometry.translate(0, -CONFIG.rendering.powerVisual.leverLengthM * 0.42, 0);
    this.powerLever.position.set(0, 0.22, -0.2);
    this.powerLever.rotation.x = CONFIG.rendering.powerVisual.offAngleRad;
    breaker.add(this.powerLever);
    this.group.add(breaker);
  }

  private buildPowerupPool(): void {
    const visual = CONFIG.rendering.powerupVisual;
    const capacity = CONFIG.powerups.maxDropsPerRound + 1;
    const iconGeometries = new Map<PowerupId, THREE.BufferGeometry>([
      ['instaKill', this.buildPowerupIconGeometry('instaKill')],
      ['doublePoints', this.buildPowerupIconGeometry('doublePoints')],
      ['nuke', this.buildPowerupIconGeometry('nuke')],
      ['maxAmmo', this.buildPowerupIconGeometry('maxAmmo')],
      ['carpenter', this.buildPowerupIconGeometry('carpenter')],
    ]);
    for (let index = 0; index < capacity; index += 1) {
      const group = new THREE.Group();
      const coreMaterial = new THREE.MeshStandardMaterial({
        color: visual.colors.maxAmmo,
        emissive: visual.colors.maxAmmo,
        emissiveIntensity: visual.glowIntensity,
        roughness: 0.28,
      });
      const ringMaterial = coreMaterial.clone();
      const icons = new Map<PowerupId, THREE.Mesh>();
      for (const [type, geometry] of iconGeometries) {
        const icon = new THREE.Mesh(geometry, coreMaterial);
        icon.visible = false;
        icons.set(type, icon);
        group.add(icon);
      }
      const ring = new THREE.Mesh(new THREE.TorusGeometry(visual.ringRadiusM, 0.035, 6, 16), ringMaterial);
      ring.rotation.x = Math.PI / 2;
      group.add(ring);
      const light = new THREE.PointLight(visual.colors.maxAmmo, visual.glowIntensity, visual.lightDistanceM, 2);
      group.add(light);
      group.visible = false;
      this.powerupVisuals.push({ group, icons, core: coreMaterial, ring: ringMaterial, light });
      this.group.add(group);
    }
  }

  private buildPowerupIconGeometry(type: PowerupId): THREE.BufferGeometry {
    const parts: THREE.BufferGeometry[] = [];
    const box = (size: readonly [number, number, number], position: readonly [number, number, number], rotationZ = 0): void => {
      const geometry = new THREE.BoxGeometry(...size);
      geometry.rotateZ(rotationZ);
      geometry.translate(...position);
      parts.push(geometry);
    };
    if (type === 'instaKill') {
      const cranium = new THREE.SphereGeometry(0.28, 16, 11);
      cranium.scale(1, 0.88, 0.76);
      cranium.translate(0, 0.09, 0);
      parts.push(cranium);
      box([0.28, 0.2, 0.22], [0, -0.16, 0]);
      for (const side of [-1, 1]) box([0.065, 0.075, 0.3], [side * 0.12, -0.02, -0.08], side * 0.18);
    }
    if (type === 'doublePoints') {
      box([0.08, 0.58, 0.12], [-0.17, 0, 0], 0.68);
      box([0.08, 0.58, 0.12], [-0.17, 0, 0], -0.68);
      box([0.3, 0.075, 0.12], [0.18, 0.24, 0]);
      box([0.3, 0.075, 0.12], [0.18, 0, 0], -0.55);
      box([0.3, 0.075, 0.12], [0.18, -0.24, 0]);
    }
    if (type === 'nuke') {
      const body = new THREE.CylinderGeometry(0.16, 0.2, 0.55, 14);
      body.rotateZ(Math.PI / 2);
      parts.push(body);
      const nose = new THREE.ConeGeometry(0.16, 0.22, 14);
      nose.rotateZ(-Math.PI / 2);
      nose.translate(0.38, 0, 0);
      parts.push(nose);
      for (const side of [-1, 1]) box([0.18, 0.04, 0.32], [-0.32, side * 0.12, 0], side * 0.38);
    }
    if (type === 'maxAmmo') {
      box([0.48, 0.28, 0.34], [0, -0.08, 0]);
      box([0.5, 0.055, 0.36], [0, 0.09, 0]);
      for (const x of [-0.15, 0, 0.15]) {
        const round = new THREE.CylinderGeometry(0.035, 0.045, 0.31, 9);
        round.translate(x, 0.29, 0);
        parts.push(round);
      }
    }
    if (type === 'carpenter') {
      box([0.12, 0.62, 0.12], [0, -0.05, 0], -0.55);
      box([0.52, 0.18, 0.18], [-0.12, 0.22, 0], -0.55);
    }
    const merged = mergeGeometries(parts, false);
    for (const part of parts) part.dispose();
    if (merged === null) throw new Error(`Unable to merge ${type} power-up icon.`);
    return merged;
  }

  private buildLighting(): void {
    this.group.add(new THREE.HemisphereLight(0x607d89, 0x171713, CONFIG.rendering.environment.hemisphereIntensity));
    const roomLights = [
      { x: 0, y: 2.9, z: -0.5, color: CONFIG.rendering.environment.warmLightColor },
      { x: -10, y: 2.9, z: 13, color: 0xe8b783 },
      { x: 7, y: 2.85, z: 12.5, color: 0x8ca9b5 },
    ];
    for (const light of roomLights) {
      const point = new THREE.PointLight(
        light.color,
        CONFIG.rendering.environment.roomFillIntensity,
        CONFIG.rendering.environment.roomFillDistanceM,
        CONFIG.rendering.environment.roomFillDecay,
      );
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
