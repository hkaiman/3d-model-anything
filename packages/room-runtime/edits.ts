import * as THREE from 'three';
import { buildWall, type WallDef } from './walls';
import { materials } from './materials';

/**
 * User edits to a rebuilt room, kept per room in localStorage. A room module reads them while it builds
 * (skipping removed items, applying moves, adding walls); the viewer's editor changes them live.
 */

export interface WallSpec {
  id: string;
  a: [number, number];
  b: [number, number];
  /** floor height under the wall's start */
  y: number;
  height: number;
  thickness: number;
  color: string;
}

export interface Move { dx: number; dz: number; rot: number }

export interface RoomEdits {
  version: 1;
  removed: string[];
  /** offset from the scanned position (meters) and added rotation (radians) about the item's centre */
  moved: Record<string, Move>;
  walls: WallSpec[];
}

export const emptyEdits = (): RoomEdits => ({ version: 1, removed: [], moved: {}, walls: [] });
const storageKey = (roomId: string) => `room-edits:${roomId}`;

export function loadEdits(roomId: string): RoomEdits {
  try {
    const parsed = JSON.parse(localStorage.getItem(storageKey(roomId)) ?? 'null') as Partial<RoomEdits> | null;
    if (parsed?.version === 1) return { ...emptyEdits(), ...parsed } as RoomEdits;
  } catch { /* storage can be unavailable or hold junk: start clean */ }
  return emptyEdits();
}

export function saveEdits(roomId: string, edits: RoomEdits) {
  try {
    const empty = !edits.removed.length && !edits.walls.length && !Object.keys(edits.moved).length;
    if (empty) localStorage.removeItem(storageKey(roomId));
    else localStorage.setItem(storageKey(roomId), JSON.stringify(edits));
  } catch { /* edits then last only for this page view */ }
}

export type EditKind = 'furniture' | 'wall' | 'custom-wall';

export interface EditableItem {
  id: string;
  label: string;
  kind: EditKind;
  /** the node to hide/remove/move; furniture is wrapped so it pivots about its own centre */
  object: THREE.Object3D;
  /** original centre of a movable item (x, z) */
  home?: { x: number; z: number };
}

/** A straight wall between two floor points, built with the same wall builder as scanned walls */
export function createWall(spec: WallSpec): { def: WallDef; group: THREE.Object3D } {
  const m = materials();
  const a = new THREE.Vector3(spec.a[0], spec.y, spec.a[1]);
  const b = new THREE.Vector3(spec.b[0], spec.y, spec.b[1]);
  const u = b.clone().sub(a).setY(0);
  const length = u.length();
  u.normalize();
  const n = u.clone().cross(new THREE.Vector3(0, 1, 0)); // u × up = n
  const def: WallDef = {
    name: spec.id,
    origin: a.clone().addScaledVector(n, spec.thickness / 2), // interior face; the slab runs back by its thickness
    u, n, length, thickness: spec.thickness, height: spec.height + spec.y,
    openings: [], panels: [], crown: false, ext: [spec.thickness / 2, spec.thickness / 2],
    material: new THREE.MeshStandardMaterial({ color: spec.color, roughness: 0.9, normalMap: m.wall.normalMap, normalScale: new THREE.Vector2(0.1, 0.1) }),
    trimMaterial: m.trim,
  };
  const group = buildWall(def, m);
  group.name = spec.id;
  return { def, group };
}

/** Per-build bookkeeping a room module uses to expose its removable / movable parts */
export class RoomEditSession {
  edits: RoomEdits;
  readonly items: EditableItem[] = [];
  /** floor height at a point, for new walls */
  floorAt: (x: number, z: number) => number = () => 0;

  constructor(readonly roomId: string, readonly wallTop = 2.7) {
    this.edits = loadEdits(roomId);
  }

  removed(id: string) { return this.edits.removed.includes(id); }

  /** Wrap a furniture piece so it can pivot about its centre, apply its saved move, and add it to `parent`. */
  furniture(id: string, label: string, obj: THREE.Object3D, parent: THREE.Object3D): THREE.Object3D | undefined {
    if (this.removed(id)) return undefined;
    obj.updateMatrixWorld(true);
    const c = new THREE.Box3().setFromObject(obj).getCenter(new THREE.Vector3());
    const wrapper = new THREE.Group();
    wrapper.name = id;
    wrapper.position.set(c.x, 0, c.z);
    obj.position.x -= c.x;
    obj.position.z -= c.z;
    wrapper.add(obj);
    const move = this.edits.moved[id];
    if (move) { wrapper.position.x += move.dx; wrapper.position.z += move.dz; wrapper.rotation.y = move.rot; }
    parent.add(wrapper);
    this.items.push({ id, label, kind: 'furniture', object: wrapper, home: { x: c.x, z: c.z } });
    return wrapper;
  }

  /** Register a scanned wall; false when the user deleted it (the caller then skips it). */
  wall(id: string, label: string, group: THREE.Object3D): boolean {
    if (this.removed(id)) return false;
    this.items.push({ id, label, kind: 'wall', object: group });
    return true;
  }

  /** Walls the user added, built and registered */
  customWalls() {
    return this.edits.walls.map((spec) => this.addWall(spec, false));
  }

  addWall(spec: WallSpec, remember = true) {
    const built = createWall(spec);
    this.items.push({ id: spec.id, label: 'Added wall', kind: 'custom-wall', object: built.group });
    if (remember) this.edits.walls.push(spec);
    return built;
  }
}
