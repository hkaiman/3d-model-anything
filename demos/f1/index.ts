import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import raw from '../../data/demos/f1-raw.json';
import { loadTextures, materials, textured } from '../../packages/room-runtime/materials';
import { buildWall, wallPoint, type Opening, type WallDef } from '../../packages/room-runtime/walls';
import { batchStatic } from '../../packages/room-runtime/batch';
import { RoomEditSession } from '../../packages/room-runtime/edits';
import { box, boxUV, cushion, cylinder, mesh, place } from '../../packages/room-runtime/helpers';
import type { BuiltRoom, RoomModule } from '../../packages/room-runtime/types';

/**
 * F1: one floor of a building (dining room, living rooms, open office, washroom), rebuilt from a Polycam
 * parametric export (24_08_2026.glb). Walls, openings, floors, ceilings and furniture bounds are measured
 * from that file (see data/demos/f1-raw.json); every furniture piece is modeled from its bounds and facing.
 * Coordinates: meters, +Y up, the dining/living floor is y = 0 and the office/washroom floor is 0.2 m lower.
 */

interface Item { name: string; min: number[]; max: number[]; back: number[]; tris: number }
const items = raw.items as Item[];
const named = (re: RegExp) => items.filter((i) => re.test(i.name));

const floors = named(/^Floor_(Other|Living|Dining|Office)/).map((f) => ({ x0: f.min[0], x1: f.max[0], z0: f.min[2], z1: f.max[2], y: f.max[1], kind: f.name.split('_')[1] }));
const ceilings = named(/^Ceiling_(Other|Living|Dining|Office)/).map((f) => ({ x0: f.min[0], x1: f.max[0], z0: f.min[2], z1: f.max[2], y: f.max[1], kind: f.name.split('_')[1] }));
const floorAt = (x: number, z: number) => floors.find((f) => x >= f.x0 - 0.01 && x <= f.x1 + 0.01 && z >= f.z0 - 0.01 && z <= f.z1 + 0.01);
const inside = (x: number, z: number) => !!floorAt(x, z);
const TOP = 2.9;

const wallItems = named(/^Wall_\d+$/);
const POLY = [[-3.27, -11.34], [3.26, -11.34], [3.26, 11.34], [-3.18, 11.34], [-3.18, 1.73], [-0.67, 1.73], [-0.67, -3.67], [-3.27, -3.67]];

function wallDefs() {
  const openings = [...named(/^Door_\d+$/).map((o) => ({ o, kind: 'door' })), ...named(/^Window_\d+$/).map((o) => ({ o, kind: 'window' }))];
  return wallItems.map((w, index) => {
    const dx = w.max[0] - w.min[0], dz = w.max[2] - w.min[2];
    const alongX = dx > dz;
    const t = alongX ? dz : dx;
    const cx = (w.min[0] + w.max[0]) / 2, cz = (w.min[2] + w.max[2]) / 2;
    const probe = (s: number) => (alongX ? [cx, cz + s * (t / 2 + 0.35)] : [cx + s * (t / 2 + 0.35), cz]);
    const side = inside(...(probe(1) as [number, number])) ? 1 : inside(...(probe(-1) as [number, number])) ? -1 : 1;
    const n = alongX ? new THREE.Vector3(0, 0, side) : new THREE.Vector3(side, 0, 0);
    const u = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), n).multiplyScalar(-1); // u × up = n
    const face = alongX ? (side > 0 ? w.max[2] : w.min[2]) : side > 0 ? w.max[0] : w.min[0];
    const [px, pz] = probe(side) as [number, number];
    const originY = floorAt(px, pz)?.y ?? floorAt(...(probe(-side) as [number, number]))?.y ?? 0;
    const start = alongX ? (u.x > 0 ? w.min[0] : w.max[0]) : u.z > 0 ? w.min[2] : w.max[2];
    const origin = alongX ? new THREE.Vector3(start, originY, face) : new THREE.Vector3(face, originY, start);
    const length = alongX ? dx : dz;
    const ops: Opening[] = [];
    const meta: { kind: string; exterior: boolean; u0: number; u1: number; v0: number; v1: number }[] = [];
    for (const { o, kind } of openings) {
      const ox = o.max[0] - o.min[0], oz = o.max[2] - o.min[2];
      if ((ox > oz) !== alongX) continue;
      const plane = alongX ? (o.min[2] + o.max[2]) / 2 : (o.min[0] + o.max[0]) / 2;
      const [a, b] = alongX ? [w.min[2], w.max[2]] : [w.min[0], w.max[0]];
      if (plane < a - 0.08 || plane > b + 0.08) continue;
      const lo = alongX ? o.min[0] : o.min[2], hi = alongX ? o.max[0] : o.max[2];
      const [wl, wh] = alongX ? [w.min[0], w.max[0]] : [w.min[2], w.max[2]];
      if (hi < wl || lo > wh) continue;
      const ua = (lo - start) * (u.x + u.z), ub = (hi - start) * (u.x + u.z);
      const u0 = Math.max(0, Math.min(ua, ub)), u1 = Math.min(length, Math.max(ua, ub));
      const v0 = Math.max(0, o.min[1] - originY), v1 = Math.min(w.max[1] - originY - 0.01, o.max[1] - originY);
      ops.push({ kind: 'rect', u0, u1, v0: v0 < 0.03 ? 0 : v0, v1, casing: kind === 'door' });
      const sx = plane, sz = plane;
      const exterior = alongX ? Math.abs(sz) > 11.2 : Math.abs(sx) > 3.2;
      meta.push({ kind, exterior, u0, u1, v0: v0 < 0.03 ? 0 : v0, v1 });
    }
    const def: WallDef = {
      name: `w${index}`, origin, u, n, length, thickness: t, height: w.max[1] - originY, openings: ops, panels: [],
      crown: false, ext: [0.04, 0.04], baseboardGaps: [],
    };
    return { id: `wall-${index}`, def, meta, src: w };
  });
}

function palette() {
  const base = materials();
  const std = (color: string, roughness = 0.7, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return {
    base,
    wall: new THREE.MeshStandardMaterial({ color: '#f1e7da', roughness: 0.92, normalMap: base.wall.normalMap, normalScale: new THREE.Vector2(0.1, 0.1) }),
    trim: std('#f4efe6', 0.5),
    laminate: textured({ color: '#d9b98a', set: 'laminate', repeat: 0.8, roughness: 0.55 }),
    carpet: textured({ color: '#7d8590', set: 'carpet', repeat: 1.5, normalScale: 0.8 }),
    tile: std('#cfd0cc', 0.35),
    ceiling: std('#f4f2ee', 0.95),
    wood: std('#b8956a', 0.6),
    woodDark: std('#6f5239', 0.6),
    deskTop: std('#d8c9ad', 0.5),
    metal: std('#b9bcc0', 0.4, 0.9),
    black: std('#1b1c1f', 0.55),
    plastic: std('#2a2b2f', 0.5),
    fabric: std('#6a717c', 1),
    fabricWarm: std('#8a8576', 1),
    white: std('#f3f3f1', 0.35),
    porcelain: std('#f6f7f5', 0.18),
    frame: std('#3a3d40', 0.4, 0.8),
    glass: new THREE.MeshStandardMaterial({ color: '#9bb6c4', roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.22, depthWrite: false }),
    sky: new THREE.MeshBasicMaterial({ color: '#cfe0ee', side: THREE.DoubleSide }),
    doorLeaf: std('#8b6a48', 0.5),
    bulb: new THREE.MeshStandardMaterial({ color: '#fff', emissive: '#fff4de', emissiveIntensity: 2 }),
  };
}
type Pal = ReturnType<typeof palette>;

// ---- furniture (local frame: +z is the front, origin at the footprint centre on the floor) ----

function swivelChair(m: Pal, h: number) {
  const g = new THREE.Group();
  const seatY = 0.47;
  for (let k = 0; k < 5; k++) {
    const a = (k / 5) * Math.PI * 2;
    const leg = box([0.3, 0.035, 0.05], [Math.cos(a) * 0.15, 0.07, Math.sin(a) * 0.15], m.black);
    leg.rotation.y = -a;
    g.add(leg);
    g.add(cylinder(0.025, 0.03, [Math.cos(a) * 0.29, 0.03, Math.sin(a) * 0.29], m.black, 10));
  }
  g.add(cylinder(0.03, seatY - 0.12, [0, 0.12 + (seatY - 0.12) / 2, 0], m.metal, 12));
  g.add(cushion([0.5, 0.08, 0.5], [0, seatY + 0.04, 0.02], 0.025, m.fabric));
  g.add(cushion([0.46, h - seatY - 0.3, 0.07], [0, seatY + 0.28 + (h - seatY - 0.3) / 2, -0.24], 0.03, m.fabric));
  g.add(box([0.04, 0.3, 0.05], [0, seatY + 0.2, -0.22], m.black));
  for (const s of [-1, 1]) {
    g.add(box([0.03, 0.22, 0.03], [s * 0.27, seatY + 0.15, -0.05], m.black));
    g.add(box([0.06, 0.03, 0.26], [s * 0.27, seatY + 0.26, -0.04], m.black));
  }
  return g;
}

function sideChair(m: Pal, w: number, d: number, h: number, arms: boolean) {
  const g = new THREE.Group();
  const seatY = 0.46;
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box([0.035, seatY, 0.035], [sx * (w / 2 - 0.03), seatY / 2, sz * (d / 2 - 0.03)], m.metal));
  g.add(cushion([w - 0.02, 0.06, d - 0.02], [0, seatY + 0.03, 0.01], 0.02, m.fabric));
  g.add(box([w - 0.06, 0.03, 0.03], [0, seatY - 0.05, d / 2 - 0.04], m.metal));
  for (const sx of [-1, 1]) g.add(box([0.03, h - seatY, 0.03], [sx * (w / 2 - 0.03), seatY + (h - seatY) / 2, -d / 2 + 0.03], m.metal));
  g.add(cushion([w - 0.08, 0.28, 0.04], [0, h - 0.2, -d / 2 + 0.03], 0.015, m.fabric));
  if (arms) for (const sx of [-1, 1]) {
    g.add(box([0.03, 0.2, 0.03], [sx * (w / 2 - 0.02), seatY + 0.14, 0.05], m.metal));
    g.add(box([0.05, 0.025, d * 0.55], [sx * (w / 2 - 0.02), seatY + 0.25, -0.02], m.black));
  }
  return g;
}

function table(m: Pal, w: number, d: number, h: number) {
  const g = new THREE.Group();
  const top = 0.035;
  g.add(box([w, top, d], [0, h - top / 2, 0], m.deskTop));
  if (w > 1.4 && d < 1.0) {
    // office desk: end panels, a modesty panel and a drawer unit
    for (const s of [-1, 1]) g.add(box([0.03, h - top, d - 0.06], [s * (w / 2 - 0.05), (h - top) / 2, 0], m.white));
    g.add(box([w - 0.1, h * 0.4, 0.02], [0, h * 0.6, -d / 2 + 0.06], m.white));
    g.add(box([0.38, h - top - 0.04, d - 0.1], [w / 2 - 0.27, (h - top - 0.04) / 2 + 0.02, 0], m.white));
  } else {
    const leg = Math.min(0.06, d / 8);
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box([leg, h - top, leg], [sx * (w / 2 - 0.07), (h - top) / 2, sz * (d / 2 - 0.07)], m.metal));
  }
  return g;
}

function shelf(m: Pal, w: number, d: number, h: number) {
  const g = new THREE.Group();
  const t = 0.02;
  for (const s of [-1, 1]) g.add(box([t, h, d], [s * (w / 2 - t / 2), h / 2, 0], m.wood));
  g.add(box([w, h, 0.012], [0, h / 2, -d / 2 + 0.006], m.wood));
  const n = Math.max(2, Math.round(h / 0.38));
  for (let k = 0; k <= n; k++) g.add(box([w - 2 * t, t, d - 0.012], [0, k === 0 ? 0.06 : (k / n) * (h - t / 2), 0.006], m.wood));
  if (h < 1.1) g.add(box([w - 2 * t, h - 0.1, 0.02], [0, h / 2 + 0.03, d / 2 - 0.01], m.woodDark)); // low unit: doored
  return g;
}

function armchair(m: Pal, w: number, d: number, h: number) {
  const g = new THREE.Group();
  const seat = 0.42;
  g.add(cushion([w, seat - 0.08, d], [0, 0.08 + (seat - 0.08) / 2, 0], 0.04, m.fabricWarm));
  g.add(cushion([w - 0.3, 0.14, d - 0.2], [0, seat + 0.07, 0.08], 0.05, m.fabricWarm));
  g.add(cushion([w - 0.3, h - seat, 0.22], [0, seat + (h - seat) / 2, -d / 2 + 0.11], 0.06, m.fabricWarm));
  for (const s of [-1, 1]) g.add(cushion([0.15, 0.36, d], [s * (w / 2 - 0.075), seat + 0.1, 0], 0.05, m.fabricWarm));
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box([0.04, 0.08, 0.04], [sx * (w / 2 - 0.08), 0.04, sz * (d / 2 - 0.08)], m.black));
  return g;
}

function toilet(m: Pal, w: number, d: number) {
  const g = new THREE.Group();
  g.add(box([w * 0.85, 0.36, 0.2], [0, 0.57, -d / 2 + 0.12], m.porcelain)); // cistern
  g.add(cushion([w * 0.9, 0.38, d * 0.62], [0, 0.2, -d / 2 + 0.12 + d * 0.31], 0.08, m.porcelain));
  g.add(cushion([w * 0.9, 0.03, d * 0.6], [0, 0.4, -d / 2 + 0.12 + d * 0.31], 0.02, m.white));
  g.add(cylinder(0.02, 0.04, [w * 0.2, 0.77, -d / 2 + 0.12], m.metal, 10));
  return g;
}

function basin(m: Pal, w: number, d: number, h: number) {
  const g = new THREE.Group();
  g.add(cushion([w, 0.14, d], [0, h - 0.07, 0], 0.04, m.porcelain));
  g.add(cylinder(0.03, 0.14, [0, h + 0.07, -d / 2 + 0.05], m.metal, 10));
  return g;
}

function cabinet(m: Pal, w: number, d: number, h: number) {
  const g = new THREE.Group();
  g.add(box([w, h, d], [0, h / 2, 0], m.wood));
  g.add(box([w - 0.04, h - 0.04, 0.015], [0, h / 2, d / 2 + 0.002], m.woodDark));
  g.add(box([0.02, 0.14, 0.02], [w / 2 - 0.05, h / 2, d / 2 + 0.02], m.metal));
  return g;
}

// ---- room ----

export const f1: RoomModule = {
  id: 'f1',
  label: 'F1 · office floor',
  async build(): Promise<BuiltRoom> {
    await loadTextures();
    const m = palette();
    const group = new THREE.Group();
    group.name = 'f1';
    const lights = new THREE.Group();
    lights.add(new THREE.HemisphereLight('#eef2f7', '#d9c7aa', 1.6));
    const session = new RoomEditSession('f1', TOP);
    session.floorAt = (x, z) => floorAt(x, z)?.y ?? 0;

    // walls
    const built = wallDefs().filter((b) => !session.removed(b.id));
    const walls = built.map(({ def, id }, k) => {
      def.material = m.wall; def.trimMaterial = m.trim;
      const wallGroup = buildWall(def, m.base) as THREE.Object3D;
      session.wall(id, `Wall ${k + 1}`, wallGroup);
      return { def, group: wallGroup };
    });
    walls.forEach((w) => group.add(w.group));
    const orient = (i: number, o: THREE.Object3D, u: number, v: number, out = 0) => {
      const def = walls[i].def;
      o.position.copy(wallPoint(def, u, v, out));
      o.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(def.u, new THREE.Vector3(0, 1, 0), def.n));
      walls[i].group.add(o);
      return o;
    };

    // windows and doors
    const scannedWalls = walls.length;
    built.forEach(({ meta }, i) => {
      const def = walls[i].def;
      for (const o of meta) {
        const w = o.u1 - o.u0, h = o.v1 - o.v0, cu = (o.u0 + o.u1) / 2, cv = (o.v0 + o.v1) / 2;
        if (o.kind === 'door') {
          orient(i, mesh(new THREE.BoxGeometry(w - 0.02, h - 0.01, 0.04), m.doorLeaf, 'door'), cu, h / 2, -def.thickness / 2);
          orient(i, box([0.05, 0.12, 0.012], [0, 0, 0], m.metal), o.u1 - 0.1, 1.0, -def.thickness / 2 + 0.03);
          continue;
        }
        const bar = 0.05, depth = -def.thickness / 2;
        const frame = (fw: number, fh: number, u: number, v: number) => orient(i, mesh(new THREE.BoxGeometry(fw, fh, 0.06), m.frame), u, v, depth);
        frame(w, bar, cu, o.v0 + bar / 2); frame(w, bar, cu, o.v1 - bar / 2);
        frame(bar, h, o.u0 + bar / 2, cv); frame(bar, h, o.u1 - bar / 2, cv);
        const cols = Math.max(1, Math.round(w / 1.4));
        for (let k = 1; k < cols; k++) frame(0.04, h, o.u0 + (w * k) / cols, cv);
        if (h > 1.6) frame(w, 0.04, cu, o.v0 + h * 0.72);
        orient(i, mesh(new THREE.PlaneGeometry(w, h), m.glass, 'glass'), cu, cv, depth);
        orient(i, mesh(new THREE.BoxGeometry(w + 0.1, 0.03, 0.18), m.trim), cu, o.v0 - 0.015, 0.05);
        if (o.exterior) {
          orient(i, mesh(new THREE.PlaneGeometry(w + 2, h + 2), m.sky, 'sky'), cu, cv, -def.thickness - 0.6).userData.noMerge = true;
          const sun = new THREE.RectAreaLight('#eaf1ff', 3, w, h);
          sun.position.copy(wallPoint(def, cu, cv, 0.05));
          sun.lookAt(sun.position.clone().add(def.n));
          lights.add(sun);
        }
      }
    });

    // walls the user added
    for (const added of session.customWalls()) { group.add(added.group); walls.push(added); }
    void scannedWalls;

    // floors and ceilings
    const slab = (z: { x0: number; x1: number; z0: number; z1: number }, y: number, mat: THREE.Material, up: boolean, scale = 1) => {
      const g = new THREE.PlaneGeometry(z.x1 - z.x0, z.z1 - z.z0);
      g.rotateX(up ? -Math.PI / 2 : Math.PI / 2);
      boxUV(g, scale);
      const s = mesh(g, mat, up ? 'floor' : 'ceiling');
      s.position.set((z.x0 + z.x1) / 2, y, (z.z0 + z.z1) / 2);
      return s;
    };
    const floorMat = (kind: string) => (kind === 'Office' ? m.carpet : kind === 'Other' ? m.tile : m.laminate);
    for (const f of floors) group.add(slab(f, f.y, floorMat(f.kind), true));
    const ceiling = new THREE.Group();
    ceiling.name = 'ceiling';
    for (const c of ceilings) {
      ceiling.add(slab(c, c.y, m.ceiling, false));
      // recessed panel lights on a grid
      const nx = Math.max(1, Math.round((c.x1 - c.x0) / 2.2)), nz = Math.max(1, Math.round((c.z1 - c.z0) / 3.2));
      for (let a = 0; a < nx; a++) for (let b = 0; b < nz; b++) {
        const x = c.x0 + ((a + 0.5) * (c.x1 - c.x0)) / nx, z = c.z0 + ((b + 0.5) * (c.z1 - c.z0)) / nz;
        const lamp = box([0.6, 0.02, 0.6], [x, c.y - 0.012, z], m.bulb);
        lamp.castShadow = false;
        ceiling.add(lamp);
      }
      const pl = new THREE.PointLight('#fff3df', 7, 9, 2);
      pl.position.set((c.x0 + c.x1) / 2, c.y - 0.3, (c.z0 + c.z1) / 2);
      lights.add(pl);
    }
    group.add(ceiling);

    // furniture
    const nearestWallAway = (min: number[], max: number[]) => {
      const gaps: [number, number, number][] = []; // distance, frontX, frontZ
      const cx = (min[0] + max[0]) / 2, cz = (min[2] + max[2]) / 2;
      for (const { src } of built) {
        const alongX = src.max[0] - src.min[0] > src.max[2] - src.min[2];
        if (alongX) {
          if (cx < src.min[0] - 0.1 || cx > src.max[0] + 0.1) continue;
          gaps.push([Math.abs(min[2] - src.max[2]), 0, 1], [Math.abs(src.min[2] - max[2]), 0, -1]);
        } else {
          if (cz < src.min[2] - 0.1 || cz > src.max[2] + 0.1) continue;
          gaps.push([Math.abs(min[0] - src.max[0]), 1, 0], [Math.abs(src.min[0] - max[0]), -1, 0]);
        }
      }
      return gaps.sort((a, b) => a[0] - b[0])[0] ?? [0, 0, 1];
    };
    const furniture = new THREE.Group();
    furniture.name = 'furniture';
    for (const it of items) {
      const kind = /^(chair_swivel|chair_dining|chair_other|table_|storage_shelf|sofa_|toilet|sink|storage_cabinet)/.exec(it.name)?.[1];
      if (!kind) continue;
      const dx = it.max[0] - it.min[0], dz = it.max[2] - it.min[2], h = it.max[1] - it.min[1];
      const cx = (it.min[0] + it.max[0]) / 2, cz = (it.min[2] + it.max[2]) / 2;
      const floorY = floorAt(cx, cz)?.y ?? 0;
      let front: [number, number] = [-it.back[0], -it.back[1]];
      if (/^(storage|sink)/.test(kind)) { const g = nearestWallAway(it.min, it.max); front = [g[1], g[2]]; }
      const mag = Math.hypot(...front);
      if (mag < 1e-3) front = [0, 1];
      const snapped = !kind.startsWith('chair_swivel');
      let ang = Math.atan2(front[0], front[1]);
      if (snapped) ang = Math.round(ang / (Math.PI / 2)) * (Math.PI / 2);
      const quarter = Math.abs(Math.round(ang / (Math.PI / 2))) % 2 === 1;
      const [lw, ld] = quarter ? [dz, dx] : [dx, dz];
      let obj: THREE.Group;
      if (kind === 'chair_swivel') obj = swivelChair(m, h);
      else if (kind === 'chair_dining' || kind === 'chair_other') obj = sideChair(m, lw, ld, h, it.name.includes('arms'));
      else if (kind.startsWith('table')) { obj = table(m, dx >= dz ? dx : dz, dx >= dz ? dz : dx, h); ang = dx >= dz ? 0 : Math.PI / 2; }
      else if (kind === 'storage_shelf') obj = it.name.includes('shelf_1') ? shelf(m, lw, ld, h) : shelf(m, lw, ld, h);
      else if (kind === 'sofa_') obj = armchair(m, lw, ld, h);
      else if (kind === 'toilet') obj = toilet(m, lw, ld);
      else if (kind === 'sink') obj = basin(m, lw, ld, h);
      else obj = cabinet(m, lw, ld, h);
      obj.position.set(cx, floorY, cz);
      obj.rotation.y = ang;
      obj.name = it.name;
      session.furniture(it.name, it.name.replace(/_\d+$/, '').replace(/_/g, ' '), obj, furniture);
    }
    furniture.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    group.add(furniture);

    const layout: BuiltRoom['layout'] = {
      note: 'Measured from the Polycam parametric export; furniture positions are exact, shapes are modeled.',
      polygon: POLY,
      walls: walls.map(({ def }, i) => {
        const a = def.origin, b = def.origin.clone().addScaledVector(def.u, def.length);
        return { a: [a.x, a.z], b: [b.x, b.z], u: [def.u.x, def.u.z], length: def.length,
          openings: (built[i]?.meta ?? []).map((o) => ({ kind: o.kind, u0: o.u0, u1: o.u1 })) };
      }),
      objects: items.filter((i) => /^(table|storage|sofa|toilet|sink)/.test(i.name)).map((i) => ({
        category: i.name.split('_')[0], center: [(i.min[0] + i.max[0]) / 2, (i.min[1] + i.max[1]) / 2, (i.min[2] + i.max[2]) / 2],
        size: [i.max[0] - i.min[0], i.max[1] - i.min[1], i.max[2] - i.min[2]], rotY: 0,
      })),
    };

    let optimized: ReturnType<typeof batchStatic> | undefined;
    return {
      layout, edit: session, group, lights, walls, ceiling: [ceiling], wallTop: TOP, exposure: 1.05,
      render: { toneMapping: THREE.NeutralToneMapping, shadowType: THREE.PCFShadowMap, envSize: 256, envBounces: 1 },
      optimize(opts) { return (optimized ??= batchStatic(group, [...walls.map((w) => w.group), ceiling], { mergeDynamic: !!opts?.static })); },
      walkable: (x, z) => [[0, 0], [0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]].every(([a, b]) => {
        const px = x + a, pz = z + b;
        const inPoly = (() => { let r = false; for (let i = 0, j = POLY.length - 1; i < POLY.length; j = i++) { const [xi, zi] = POLY[i], [xj, zj] = POLY[j]; if (zi > pz !== zj > pz && px < ((xj - xi) * (pz - zi)) / (zj - zi) + xi) r = !r; } return r; })();
        return inPoly;
      }),
      camera: { orbit: [10, 22, 20], target: [0, 0.8, 0], walk: [1.5, 1.6, 9], walkLook: [0, 1.3, 0] },
      environment: { center: [0, 1.5, 4], intensity: 0.7 },
      loadReference: async (onProgress) => {
        const gltf = await new GLTFLoader().loadAsync('/f1/scan.glb', (e) => e.total && onProgress?.(e.loaded / e.total));
        gltf.scene.position.y = -raw.shift;
        return gltf.scene;
      },
      referenceAvailable: true,
      referenceKind: 'scan',
      photos: [],
    };
  },
};
