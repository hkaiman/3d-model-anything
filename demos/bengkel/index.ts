import * as THREE from 'three';
import scan from '../../data/demos/bengkel.json';
import { RoomEditSession } from '../../packages/room-runtime/edits';
import { loadTextures, materials, mulberry32, textured } from '../../packages/room-runtime/materials';
import { buildWall, wallPoint, type WallDef, type Opening } from '../../packages/room-runtime/walls';
import { box, boxUV, cylinder, mesh, place, type V3 } from '../../packages/room-runtime/helpers';
import type { BuiltRoom, RoomModule } from '../../packages/room-runtime/types';

/**
 * Bengkel (workshop): rebuilt from a single House Capture session (2026-10-28 16.24.56).
 * Main workshop 4.1 × 3.0 m with a 2.3 × 1.0 m corridor (toilets, basin) off its east side.
 * Coordinates are the converted room's frame: meters, +Y up, floor y = 0.
 */

const MAIN_TOP = 2.675;
const WING_TOP = 2.25;
const BAND_V0 = 1.93; // dark maroon band + white stripe on the main room's upper wall
const WING_X0 = 0.92;
const WING_Z0 = 0.56;

const v3 = (a: number[]) => new THREE.Vector3(a[0], a[1], a[2]);

const inPolygon = (x: number, z: number, poly: number[][] = scan.polygon) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, zi] = poly[i], [xj, zj] = poly[j];
    if (zi > z !== zj > z && x < ((xj - xi) * (z - zi)) / (zj - zi) + xi) inside = !inside;
  }
  return inside;
};

function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, repeat?: [number, number]) {
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  draw(canvas.getContext('2d')!);
  const t = new THREE.CanvasTexture(canvas);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  if (repeat) { t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(...repeat); }
  return t;
}

function palette() {
  const base = materials();
  const std = (color: string, roughness = 0.7, metalness = 0) => new THREE.MeshStandardMaterial({ color, roughness, metalness });
  return {
    base,
    cream: new THREE.MeshStandardMaterial({ color: '#eadfba', roughness: 0.92, normalMap: base.wall.normalMap, normalScale: new THREE.Vector2(0.12, 0.12) }),
    band: std('#4a2f35', 0.9),
    stripe: std('#f1ede4', 0.6),
    laminate: textured({ color: '#e6c58f', set: 'laminate', repeat: 0.7, roughness: 0.55 }),
    tile: std('#5a3b34', 0.35),
    wainscot: std('#e9e6df', 0.3),
    tileCeil: std('#ecebe6', 0.95),
    orange: std('#e8571e', 0.55),
    frameGrey: std('#9aa0a6', 0.4, 0.8),
    white: std('#f2f2ef', 0.5),
    whiteMetal: std('#e6e8ea', 0.45, 0.6),
    black: std('#16161a', 0.55),
    deskTop: std('#1b1a1c', 0.4),
    locker: std('#4b4440', 0.7),
    lockerHandle: std('#b9b9b9', 0.3, 1),
    cardboard: std('#b98f5e', 0.9),
    cardboardLight: std('#caa475', 0.9),
    plastic: std('#d9dde0', 0.35),
    teal: std('#1c5a5c', 1),
    doorWood: std('#6a3f23', 0.55),
    glassOut: new THREE.MeshBasicMaterial({ color: '#d7e4f2' }),
    lattice: std('#f4f3ef', 0.5),
    tube: new THREE.MeshStandardMaterial({ color: '#fff', emissive: '#fff6e0', emissiveIntensity: 2.2 }),
    extinguisher: std('#b3201b', 0.4, 0.3),
    solar: std('#10203d', 0.3, 0.4),
    yellow: std('#e6c41c', 0.5),
  };
}

type Pal = ReturnType<typeof palette>;

export const bengkel: RoomModule = {
  id: 'bengkel',
  label: 'Bengkel · workshop',
  async build(): Promise<BuiltRoom> {
    await loadTextures();
    const m = palette();
    const group = new THREE.Group();
    group.name = 'bengkel';
    const session = new RoomEditSession('bengkel', MAIN_TOP);

    // ---- shell ----
    const wallDefs: WallDef[] = scan.walls.map((w) => {
      const openings: Opening[] = w.openings.map((o) => ({
        kind: 'rect', u0: o.u0, u1: o.u1, v0: o.v0 < 0.02 ? 0 : o.v0, v1: o.v1, casing: o.kind === 'door',
      }));
      const wing = w.height < 2.5;
      return {
        name: `w${w.index}`,
        origin: v3(w.origin), u: v3(w.u), n: v3(w.n),
        length: w.length, thickness: 0.12, height: w.height,
        openings, panels: [], crown: false,
        ext: [0.06, 0.06] as [number, number],
        material: wing ? m.cream : m.cream, trimMaterial: m.white,
        baseboardGaps: [],
      };
    });

    const walls = wallDefs.map((def) => {
      const g = buildWall(def, m.base);
      return { def, group: g as THREE.Object3D };
    });
    walls.forEach((w, i) => { if (session.wall(`wall-${i}`, `Wall ${i + 1}`, w.group)) group.add(w.group); });
    const customWalls = session.customWalls();
    for (const added of customWalls) group.add(added.group);
    const addOnWall = (i: number, o: THREE.Object3D) => { walls[i].group.add(o); return o; };
    const wp = (i: number, u: number, v: number, out = 0) => wallPoint(wallDefs[i], u, v, out);
    const orient = (i: number, o: THREE.Object3D, u: number, v: number, out = 0) => {
      o.position.copy(wp(i, u, v, out));
      o.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(wallDefs[i].u, new THREE.Vector3(0, 1, 0), wallDefs[i].n));
      return addOnWall(i, o);
    };

    // dark band with a white stripe along the top of the main room's walls
    for (const [i, def] of wallDefs.entries()) {
      if (!def.height || def.height < 2.5) continue;
      const h = def.height - BAND_V0;
      orient(i, mesh(new THREE.BoxGeometry(def.length, h, 0.006), m.band), def.length / 2, BAND_V0 + h / 2, 0.003);
      orient(i, mesh(new THREE.BoxGeometry(def.length, 0.04, 0.008), m.stripe), def.length / 2, BAND_V0 - 0.02, 0.004);
    }
    // corridor: white tile wainscot to 1.2 m
    for (const i of [2, 4, 6]) {
      const def = wallDefs[i];
      orient(i, mesh(new THREE.BoxGeometry(def.length, 1.2, 0.012), m.wainscot), def.length / 2, 0.6, 0.006);
    }

    // floors
    const mainFloor = new THREE.Shape(scan.polygon.filter(([x, z]) => !(x > WING_X0 + 0.01 && z > WING_Z0 - 0.01) || (x <= WING_X0 + 0.01)).map(([x, z]) => new THREE.Vector2(x, z)));
    void mainFloor;
    const floorBox = (x0: number, x1: number, z0: number, z1: number, mat: THREE.Material) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      g.rotateX(-Math.PI / 2);
      boxUV(g);
      const f = mesh(g, mat, 'floor');
      f.position.set((x0 + x1) / 2, 0, (z0 + z1) / 2);
      f.receiveShadow = true;
      return f;
    };
    const floor = new THREE.Group();
    floor.add(floorBox(-3.2, WING_X0, -1.54, 1.49, m.laminate));
    floor.add(floorBox(-0.71, WING_X0, 1.49, 1.54, m.laminate));
    floor.add(floorBox(WING_X0, 3.2, WING_Z0, 1.54, m.tile));
    group.add(floor);

    // ceilings: acoustic tile grid (600 mm) with two fluorescent troffers
    const gridTex = canvasTex(256, 256, (c) => {
      c.fillStyle = '#eceae4'; c.fillRect(0, 0, 256, 256);
      c.strokeStyle = '#b9b7b0'; c.lineWidth = 6; c.strokeRect(0, 0, 256, 256);
      c.fillStyle = 'rgba(120,120,110,0.18)';
      for (let i = 0; i < 400; i++) c.fillRect(Math.random() * 256, Math.random() * 256, 2, 2);
    }, [1 / 0.6, 1 / 0.6]);
    const ceilMat = new THREE.MeshStandardMaterial({ map: gridTex, roughness: 0.95 });
    const ceiling = new THREE.Group();
    ceiling.name = 'ceiling';
    const ceilPlane = (x0: number, x1: number, z0: number, z1: number, y: number) => {
      const g = new THREE.PlaneGeometry(x1 - x0, z1 - z0);
      g.rotateX(Math.PI / 2);
      const uv = g.getAttribute('uv');
      for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * (x1 - x0), uv.getY(i) * (z1 - z0));
      const c = mesh(g, ceilMat, 'ceiling');
      c.position.set((x0 + x1) / 2, y, (z0 + z1) / 2);
      return c;
    };
    ceiling.add(ceilPlane(-3.2, WING_X0, -1.54, 1.49, MAIN_TOP));
    ceiling.add(ceilPlane(WING_X0, 3.2, WING_Z0, 1.54, WING_TOP));
    const lights = new THREE.Group();
    lights.add(new THREE.HemisphereLight('#e8edf4', '#e2c9a0', 1.4));
    for (const [x, z] of [[-1.9, -0.35], [-0.4, 0.55]] as [number, number][]) {
      const t = new THREE.Group();
      t.add(box([1.2, 0.04, 0.3], [0, -0.02, 0], m.whiteMetal));
      t.add(box([1.1, 0.005, 0.22], [0, -0.042, 0], m.tube));
      t.position.set(x, MAIN_TOP, z);
      ceiling.add(t);
      const light = new THREE.RectAreaLight('#fff6e8', 6, 1.1, 0.22);
      light.position.set(x, MAIN_TOP - 0.05, z);
      light.rotation.x = -Math.PI / 2;
      lights.add(light);
    }
    const corridorLight = new THREE.PointLight('#fff1d6', 5, 4, 2);
    corridorLight.position.set(2.0, WING_TOP - 0.2, 1.05);
    lights.add(corridorLight);
    group.add(ceiling);

    // ---- window (wall 0, lattice screen over glazing) ----
    {
      const o = scan.walls[0].openings[0];
      const w = o.u1 - o.u0, h = Math.min(o.v1, MAIN_TOP) - o.v0, cu = (o.u0 + o.u1) / 2;
      const lat = canvasTex(1024, 768, (c) => {
        c.clearRect(0, 0, 1024, 768);
        c.strokeStyle = '#f5f4f0'; c.lineWidth = 16; c.lineCap = 'round';
        const rnd = mulberry32(7);
        const pts: [number, number][] = [];
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 6; j++) pts.push([i * 128 + (rnd() - 0.5) * 70, j * 128 + (rnd() - 0.5) * 70]);
        for (let i = 0; i < pts.length; i++) {
          const [x, y] = pts[i];
          for (const k of [i + 1, i + 7, i + 8]) if (pts[k] && rnd() > 0.28) { c.beginPath(); c.moveTo(x, y); c.lineTo(pts[k][0], pts[k][1]); c.stroke(); }
        }
        c.lineWidth = 22; c.strokeRect(6, 6, 1012, 756);
      });
      const screen = mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshStandardMaterial({ map: lat, transparent: true, roughness: 0.6, alphaTest: 0.1 }), 'lattice');
      orient(0, screen, cu, o.v0 + h / 2, -0.04);
      const glass = mesh(new THREE.PlaneGeometry(w, h), m.glassOut, 'sky');
      orient(0, glass, cu, o.v0 + h / 2, -0.07);
      // outside light through the opening
      const sun = new THREE.RectAreaLight('#eaf1ff', 5, w, h);
      sun.position.copy(wp(0, cu, o.v0 + h / 2, -0.02));
      sun.lookAt(sun.position.clone().add(wallDefs[0].n));
      lights.add(sun);
      // sill
      orient(0, mesh(new THREE.BoxGeometry(w + 0.08, 0.03, 0.14), m.white), cu, o.v0 - 0.015, 0.03);
    }

    // ---- doors (wall 2) and the doorway into the corridor (wall 8) ----
    for (const o of scan.walls[2].openings) {
      const w = o.u1 - o.u0, h = o.v1, cu = (o.u0 + o.u1) / 2;
      const leaf = mesh(new THREE.BoxGeometry(w - 0.02, h - 0.02, 0.045), m.doorWood, 'door');
      orient(2, leaf, cu, h / 2, -0.04);
      const plate = mesh(new THREE.BoxGeometry(0.05, 0.12, 0.012), m.lockerHandle);
      orient(2, plate, o.u1 - 0.1, 1.0, -0.01);
      // wall behind the door
      orient(2, mesh(new THREE.BoxGeometry(w, h, 0.01), m.cream), cu, h / 2, -0.35);
    }
    {
      const sign = mesh(new THREE.BoxGeometry(0.17, 0.2, 0.004), new THREE.MeshStandardMaterial({ color: '#2a5d8f', roughness: 0.5 }));
      orient(2, sign, 0.75, 1.5, 0.003);
    }

    // accordion door folded into the east side of the wall-8 doorway, plus the wooden jamb panel
    {
      const folds = new THREE.Group();
      const mat = new THREE.MeshStandardMaterial({ color: '#c3bfb5', roughness: 0.7, side: THREE.DoubleSide });
      for (let k = 0; k < 10; k++) {
        const s = mesh(new THREE.BoxGeometry(0.055, 1.98, 0.012), mat);
        s.position.set(k * 0.04, 0.99, (k % 2 ? 1 : -1) * 0.02);
        s.rotation.y = (k % 2 ? 1 : -1) * 0.5;
        folds.add(s);
      }
      orient(8, folds, 0.08, 0, -0.05);
      orient(8, mesh(new THREE.BoxGeometry(0.06, 2.1, 0.5), new THREE.MeshStandardMaterial({ color: '#c68a3e', roughness: 0.6 })), 1.02, 1.05, 0.25);
    }

    // ---- partition panel (wall 5): orange fabric panel in an aluminium frame ----
    {
      const def = wallDefs[5];
      const pw = def.length, ph = 1.9;
      const panel = new THREE.Group();
      panel.add(box([pw, ph, 0.04], [pw / 2, ph / 2 + 0.08, 0], m.orange));
      for (const [x, y, w, h] of [[pw / 2, ph + 0.08, pw, 0.04], [pw / 2, 0.08, pw, 0.04], [0, ph / 2 + 0.08, 0.04, ph], [pw, ph / 2 + 0.08, 0.04, ph]] as number[][])
        panel.add(box([w, h, 0.06], [x, y, 0], m.frameGrey));
      for (const x of [0.05, pw - 0.05]) panel.add(box([0.05, 0.08, 0.3], [x, 0.04, 0.12], m.frameGrey));
      orient(5, panel, 0, 0, 0.1);
    }

    // ---- desk: L along the west and north walls ----
    const desk = new THREE.Group();
    const leg = (x: number, z: number) => desk.add(box([0.04, 0.72, 0.04], [x, 0.36, z], m.white));
    // west run: x -3.2 .. -2.55, z -1.54 .. 0.15
    desk.add(box([0.65, 0.03, 1.69], [-2.875, 0.735, -0.695], m.deskTop));
    for (const [x, z] of [[-2.58, 0.12], [-2.58, -0.2], [-2.58, -1.5]]) leg(x, z);
    // north return: x -2.55 .. -1.71, z -1.54 .. -0.88
    desk.add(box([0.84, 0.03, 0.66], [-2.13, 0.735, -1.21], m.deskTop));
    for (const [x, z] of [[-1.74, -0.91], [-1.74, -1.5]]) leg(x, z);
    // drawer pedestal
    desk.add(box([0.38, 0.6, 0.5], [-2.9, 0.3, -1.25], m.white));
    // monitor, keyboard, printer
    desk.add(box([0.52, 0.31, 0.02], [-3.0, 1.0, -0.8], m.black));
    desk.add(box([0.06, 0.2, 0.08], [-3.0, 0.86, -0.8], m.black));
    desk.add(box([0.44, 0.015, 0.14], [-2.75, 0.76, -0.8], m.black));
    desk.add(box([0.3, 0.38, 0.3], [-2.95, 0.94, -1.35], m.black));
    desk.add(box([0.3, 0.34, 0.3], [-2.58, 0.92, -1.37], m.yellow));
    desk.add(box([0.28, 0.25, 0.28], [-2.2, 0.88, -1.3], m.cardboard));
    desk.add(box([0.24, 0.16, 0.2], [-2.0, 0.82, -1.35], m.cardboardLight));
    session.furniture('desk', 'L-shaped desk', desk, group);
    desk.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });

    // office chair (black mesh) with a teal towel over the back
    {
      const chair = new THREE.Group();
      chair.add(cylinder(0.27, 0.02, [0, 0.07, 0], m.black, 5));
      chair.add(cylinder(0.025, 0.4, [0, 0.27, 0], m.black));
      chair.add(box([0.48, 0.07, 0.46], [0, 0.48, 0], m.black));
      chair.add(box([0.46, 0.55, 0.06], [0, 0.82, 0.24], m.black));
      chair.add(box([0.44, 0.52, 0.02], [0, 0.82, 0.275], m.teal));
      place(chair, [-2.2, 0, -0.45], -Math.PI / 2 - 0.2);
      session.furniture('chair', 'Office chair', chair, group);
    }

    // ---- white steel shelving rack on the north wall, under the window ----
    {
      const rack = new THREE.Group();
      const [W, D, H] = [1.33, 0.54, 1.86];
      for (const [x, z] of [[-W / 2, -D / 2], [W / 2, -D / 2], [-W / 2, D / 2], [W / 2, D / 2]]) rack.add(box([0.04, H, 0.04], [x, H / 2, z], m.whiteMetal));
      const levels = [0.12, 0.5, 0.88, 1.26, 1.62];
      for (const y of levels) rack.add(box([W, 0.025, D], [0, y, 0], m.whiteMetal));
      const rnd = mulberry32(11);
      const stuffs = [m.cardboard, m.cardboardLight, m.black, m.plastic, m.yellow, m.white];
      for (const y of levels) {
        let x = -W / 2 + 0.08;
        while (x < W / 2 - 0.1) {
          const w = 0.12 + rnd() * 0.2, h = 0.1 + rnd() * 0.22, d = 0.16 + rnd() * 0.25;
          if (x + w > W / 2 - 0.04) break;
          rack.add(box([w, h, d], [x + w / 2, y + 0.0125 + h / 2, (rnd() - 0.5) * 0.12], stuffs[Math.floor(rnd() * stuffs.length)]));
          x += w + 0.02 + rnd() * 0.04;
        }
      }
      rack.position.set(-1.08, 0, -1.27);
      session.furniture('shelving', 'Shelving rack', rack, group);
      rack.traverse((o) => { o.castShadow = true; o.receiveShadow = true; });
    }

    // ---- locker (3 dark doors) on the west wall, with a cardboard pile and rolled mat ----
    {
      const locker = new THREE.Group();
      locker.add(box([0.44, 1.18, 0.47], [0, 0.59, 0], m.locker));
      for (let k = 0; k < 3; k++) {
        locker.add(box([0.012, 0.36, 0.42], [0.22, 0.2 + k * 0.4, 0], m.black));
        locker.add(box([0.012, 0.03, 0.03], [0.23, 0.3 + k * 0.4, 0.17], m.lockerHandle));
      }
      place(locker, [-2.96, 0, 0.4], Math.PI / 2);
      session.furniture('locker', 'Locker', locker, group);
      const rnd = mulberry32(5);
      const pile = new THREE.Group();
      for (let k = 0; k < 11; k++) {
        const w = 0.25 + rnd() * 0.3, h = 0.15 + rnd() * 0.3, d = 0.2 + rnd() * 0.25;
        const b = box([w, h, d], [0, h / 2 + (k > 6 ? 0.28 : 0), 0], rnd() > 0.4 ? m.cardboard : m.cardboardLight);
        b.position.set(-3.0 + rnd() * 0.5, b.position.y, 0.95 + rnd() * 0.45);
        b.rotation.y = (rnd() - 0.5) * 0.6;
        pile.add(b);
      }
      session.furniture('boxes', 'Cardboard boxes', pile, group);
      // solar panel leaning on the partition
      const solar = box([0.55, 1.05, 0.03], [0, 0.55, 0], m.solar);
      solar.position.set(-2.1, 0.54, 1.28);
      solar.rotation.x = 0.28;
      session.furniture('solar-panel', 'Solar panel', solar, group);
      // entrance mat
      session.furniture('door-mat', 'Door mat', box([0.35, 0.012, 0.5], [0.47, 0.006, 0.85], m.black), group);
    }

    // ---- corridor: sink cabinet with mirror (east end), fire extinguisher ----
    {
      const cab = new THREE.Group();
      cab.add(box([0.34, 0.75, 0.98], [0, 0.375, 0], m.white));
      cab.add(box([0.38, 0.03, 1.0], [0, 0.765, 0], m.white));
      cab.add(box([0.3, 0.12, 0.4], [0, 0.78, 0], m.plastic));
      cab.position.set(3.03, 0, 1.05);
      session.furniture('sink-cabinet', 'Sink cabinet', cab, group);
      const mirror = mesh(new THREE.PlaneGeometry(0.6, 0.7), new THREE.MeshStandardMaterial({ color: '#b8c4cc', roughness: 0.1, metalness: 1 }));
      orient(4, mirror, 0.5, 1.45, 0.01);
      const rack = new THREE.Group();
      rack.add(box([0.25, 0.02, 0.5], [0, 0, 0], m.white));
      orient(6, rack, 1.2, 1.1, 0.12);
      const ext = cylinder(0.06, 0.45, [0, 0.225, 0], m.extinguisher);
      ext.position.set(1.0, 0, 1.45);
      session.furniture('extinguisher', 'Fire extinguisher', ext, group);
      session.furniture('wall-cabinet', 'Low cabinet', box([0.62, 0.6, 0.24], [2.45, 0.3, 1.42], m.white), group);
    }

    // ---- camera / layout / reference ----
    const photos = scan.photos.map((p) => ({
      url: `/bengkel/${p.file}`, position: p.position, forward: p.forward, up: p.up, fovY: p.fovY, aspect: p.aspect,
    }));
    group.traverse((o) => { const me = o as THREE.Mesh; if (me.isMesh && me.name !== 'sky' && me.name !== 'lattice') { me.castShadow = me.castShadow || true; me.receiveShadow = true; } });

    return {
      layout: scan as unknown as BuiltRoom['layout'],
      edit: session, group, lights, walls: [...walls.filter((w) => w.group.parent), ...customWalls], ceiling: [ceiling], wallTop: MAIN_TOP, exposure: 1.1,
      render: { toneMapping: THREE.NeutralToneMapping, shadowType: THREE.PCFShadowMap, envSize: 256, envBounces: 1 },
      walkable: (x, z) => inPolygon(x, z) && inPolygon(x + 0.2, z) && inPolygon(x - 0.2, z) && inPolygon(x, z + 0.2) && inPolygon(x, z - 0.2),
      camera: { orbit: [-1.5, 6.5, 6.5], target: [0, 0.8, 0], walk: [0.3, 1.6, 0.2], walkLook: [-2.5, 1.2, -0.3] },
      environment: { center: [-1, 1.4, 0], intensity: 0.8 },
      loadReference: async () => { throw new Error('Reference mesh not loaded.'); },
      referenceAvailable: false,
      referenceKind: 'scan',
      photos,
    };
  },
};
