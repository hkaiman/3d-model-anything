import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';
import { saveEdits, type EditableItem, type RoomEdits } from '../../../packages/room-runtime/edits';
import type { BuiltRoom } from '../../../packages/room-runtime/types';

export interface EditorHost {
  viewport: HTMLElement;
  canvas: HTMLCanvasElement;
  camera: THREE.Camera;
  orbit: OrbitControls;
  scene: THREE.Scene;
  getRoom(): BuiltRoom | undefined;
  /** edit tools only act on the model in the dollhouse view */
  canEdit(): boolean;
  invalidate(): void;
  /** rebuild the current room (reads saved edits); `editing` keeps items separate so they can be picked */
  rebuild(editing: boolean): Promise<void>;
}

type Tool = 'select' | 'wall';
const SNAP = 0.05;
const snap = (v: number) => Math.round(v / SNAP) * SNAP;
const $ = <T extends HTMLElement>(id: string) => document.querySelector<T>(`#${id}`)!;

export function initEditor(host: EditorHost) {
  const section = $('edit-section');
  const toggle = $<HTMLButtonElement>('edit-toggle');
  const tools = $('edit-tools');
  const selectionText = $('edit-selection');
  const statusText = $('edit-status');
  const wallOptions = $('wall-options');
  const heightInput = $<HTMLInputElement>('wall-height');
  const thicknessInput = $<HTMLInputElement>('wall-thickness');
  const colorInput = $<HTMLInputElement>('wall-color');
  const rotateBtn = $<HTMLButtonElement>('edit-rotate');
  const deleteBtn = $<HTMLButtonElement>('edit-delete');
  const resetBtn = $<HTMLButtonElement>('edit-reset');

  let active = false;
  let editRoomId: string | undefined;
  let tool: Tool = 'select';
  let selected: EditableItem | undefined;
  const undoStack: string[] = [];
  const raycaster = new THREE.Raycaster();
  const highlight = new THREE.Box3Helper(new THREE.Box3(), new THREE.Color('#ffd34d'));
  (highlight.material as THREE.LineBasicMaterial).depthTest = false;
  highlight.renderOrder = 999;
  highlight.visible = false;
  const preview = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: '#58d68d', transparent: true, opacity: 0.55, depthTest: false }));
  preview.visible = false;
  preview.renderOrder = 998;
  host.scene.add(highlight, preview);
  let wallStart: THREE.Vector2 | undefined;

  const session = () => host.getRoom()?.edit;
  const say = (text: string) => { statusText.textContent = text; };
  const persist = () => { const s = session(); if (s) saveEdits(s.roomId, s.edits); };
  const pushUndo = () => { const s = session(); if (s) { undoStack.push(JSON.stringify(s.edits)); if (undoStack.length > 50) undoStack.shift(); } };

  function pointerRay(event: PointerEvent | MouseEvent) {
    const rect = host.canvas.getBoundingClientRect();
    raycaster.setFromCamera(new THREE.Vector2(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1), host.camera);
    return raycaster.ray;
  }

  /** nearest floor point under the pointer (real floor meshes, so stepped floors work); falls back to y = 0 */
  function floorPoint(event: PointerEvent | MouseEvent): THREE.Vector3 | undefined {
    const ray = pointerRay(event);
    const room = host.getRoom();
    const floors: THREE.Object3D[] = [];
    room?.group.traverse((o) => { if ((o as THREE.Mesh).isMesh && o.name === 'floor') floors.push(o); });
    raycaster.ray.copy(ray);
    const hit = raycaster.intersectObjects(floors, false)[0];
    if (hit) return hit.point;
    return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), new THREE.Vector3()) ?? undefined;
  }

  function pick(event: PointerEvent): EditableItem | undefined {
    const s = session();
    if (!s) return;
    const ray = pointerRay(event);
    let best: EditableItem | undefined, bestDistance = Infinity;
    const target = new THREE.Vector3();
    for (const item of s.items) {
      if (!item.object.parent || !item.object.visible) continue;
      const box = new THREE.Box3().setFromObject(item.object);
      if (box.isEmpty() || !ray.intersectBox(box, target)) continue;
      // furniture wins over the walls it stands against when both are hit at similar depth
      const d = ray.origin.distanceTo(target) - (item.kind === 'furniture' ? 0.15 : 0);
      if (d < bestDistance) { best = item; bestDistance = d; }
    }
    return best;
  }

  function select(item?: EditableItem) {
    selected = item;
    const movable = item?.kind === 'furniture';
    rotateBtn.disabled = !movable;
    deleteBtn.disabled = !item;
    if (!item) {
      highlight.visible = false;
      selectionText.textContent = tool === 'wall' ? 'Click the floor to start a wall.' : 'Click an item to select it.';
    } else {
      refreshHighlight();
      const c = new THREE.Box3().setFromObject(item.object).getCenter(new THREE.Vector3());
      selectionText.textContent = `${item.label} · x ${c.x.toFixed(2)}, z ${c.z.toFixed(2)}${movable ? ' · drag to move' : ''}`;
    }
    host.invalidate();
  }

  function refreshHighlight() {
    if (!selected) return;
    highlight.box.setFromObject(selected.object);
    highlight.visible = true;
  }

  // ---- pointer handling (capture phase, so a picked item never starts an orbit drag) ----
  let drag: { item: EditableItem; plane: THREE.Plane; start: THREE.Vector3; from: THREE.Vector3; moved: boolean } | undefined;

  host.viewport.addEventListener('pointerdown', (event) => {
    if (!active || !host.canEdit() || event.button !== 0) return;
    if (tool === 'wall') {
      const p = floorPoint(event);
      if (!p) return;
      event.stopImmediatePropagation();
      const point = new THREE.Vector2(snap(p.x), snap(p.z));
      if (!wallStart) { wallStart = point; say('Click where the wall ends · Esc to finish'); return; }
      const end = constrained(point, event.shiftKey);
      if (end.distanceTo(wallStart) < 0.1) return;
      commitWall(wallStart, end);
      wallStart = end; // keep drawing from the end point
      return;
    }
    const item = pick(event);
    if (!item) { select(undefined); return; }
    event.stopImmediatePropagation();
    select(item);
    if (item.kind !== 'furniture') return;
    const box = new THREE.Box3().setFromObject(item.object);
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -box.min.y);
    const start = pointerRay(event).intersectPlane(plane, new THREE.Vector3());
    if (!start) return;
    drag = { item, plane, start, from: item.object.position.clone(), moved: false };
    host.canvas.setPointerCapture(event.pointerId);
  }, true);

  function constrained(point: THREE.Vector2, free: boolean) {
    if (!wallStart || free) return point;
    const dx = Math.abs(point.x - wallStart.x), dz = Math.abs(point.y - wallStart.y);
    if (dz < 0.1 || (dz < dx && dz / dx < 0.06)) return new THREE.Vector2(point.x, wallStart.y);
    if (dx < 0.1 || (dx < dz && dx / dz < 0.06)) return new THREE.Vector2(wallStart.x, point.y);
    return point;
  }

  host.viewport.addEventListener('pointermove', (event) => {
    if (!active || !host.canEdit()) return;
    if (drag) {
      const p = pointerRay(event).intersectPlane(drag.plane, new THREE.Vector3());
      if (!p) return;
      if (!drag.moved) { pushUndo(); drag.moved = true; }
      drag.item.object.position.set(snap(drag.from.x + p.x - drag.start.x), drag.from.y, snap(drag.from.z + p.z - drag.start.z));
      refreshHighlight();
      host.invalidate();
    } else if (tool === 'wall' && wallStart) {
      const p = floorPoint(event);
      if (!p) return;
      const end = constrained(new THREE.Vector2(snap(p.x), snap(p.z)), event.shiftKey);
      const len = end.distanceTo(wallStart);
      const mid = wallStart.clone().add(end).multiplyScalar(0.5);
      const h = Number(heightInput.value) || 2.7, t = Number(thicknessInput.value) || 0.1;
      const y = session()?.floorAt(wallStart.x, wallStart.y) ?? 0;
      preview.visible = len > 0.01;
      preview.scale.set(Math.max(len, 0.01), h, t);
      preview.position.set(mid.x, y + h / 2, mid.y);
      preview.rotation.y = -Math.atan2(end.y - wallStart.y, end.x - wallStart.x);
      selectionText.textContent = `Wall ${len.toFixed(2)} m`;
      host.invalidate();
    }
  });

  const endDrag = () => {
    if (!drag) return;
    const { item, moved } = drag;
    drag = undefined;
    if (!moved) return;
    const s = session();
    if (s && item.home) {
      s.edits.moved[item.id] = { dx: item.object.position.x - item.home.x, dz: item.object.position.z - item.home.z, rot: item.object.rotation.y };
      persist();
      select(item);
    }
  };
  host.viewport.addEventListener('pointerup', endDrag);
  host.viewport.addEventListener('pointercancel', endDrag);

  function commitWall(a: THREE.Vector2, b: THREE.Vector2) {
    const s = session(), room = host.getRoom();
    if (!s || !room) return;
    pushUndo();
    const built = s.addWall({
      id: `added-wall-${Date.now().toString(36)}`, a: [a.x, a.y], b: [b.x, b.y], y: s.floorAt(a.x, a.y),
      height: Number(heightInput.value) || s.wallTop, thickness: Number(thicknessInput.value) || 0.1, color: colorInput.value,
    });
    room.group.add(built.group);
    room.walls.push(built);
    persist();
    say(`Added a ${a.distanceTo(b).toFixed(2)} m wall`);
    host.invalidate();
  }

  // ---- actions ----
  function rotateSelected(direction: number) {
    if (!selected || selected.kind !== 'furniture') return;
    pushUndo();
    selected.object.rotation.y += (direction * Math.PI) / 2;
    const s = session();
    if (s && selected.home) {
      s.edits.moved[selected.id] = { dx: selected.object.position.x - selected.home.x, dz: selected.object.position.z - selected.home.z, rot: selected.object.rotation.y };
      persist();
    }
    select(selected);
  }

  function deleteSelected() {
    const s = session(), room = host.getRoom();
    if (!s || !room || !selected) return;
    pushUndo();
    const item = selected;
    item.object.removeFromParent();
    const wi = room.walls.findIndex((w) => w.group === item.object);
    if (wi >= 0) room.walls.splice(wi, 1);
    s.items.splice(s.items.indexOf(item), 1);
    if (item.kind === 'custom-wall') s.edits.walls = s.edits.walls.filter((w) => w.id !== item.id);
    else if (!s.edits.removed.includes(item.id)) s.edits.removed.push(item.id);
    delete s.edits.moved[item.id];
    persist();
    say(`Removed ${item.label}`);
    select(undefined);
  }

  async function restoreSnapshot(json: string) {
    const s = session();
    if (!s) return;
    s.edits = JSON.parse(json) as RoomEdits;
    persist();
    await host.rebuild(true);
  }

  async function undo() {
    const previous = undoStack.pop();
    if (previous === undefined) { say('Nothing to undo'); return; }
    await restoreSnapshot(previous);
    say('Undone');
  }

  let resetArmed = 0;
  async function reset() {
    const s = session();
    if (!s) return;
    if (!resetArmed) {
      resetBtn.textContent = 'Click again to confirm';
      resetArmed = window.setTimeout(() => { resetArmed = 0; resetBtn.textContent = 'Reset edits'; }, 3000);
      return;
    }
    clearTimeout(resetArmed); resetArmed = 0; resetBtn.textContent = 'Reset edits';
    pushUndo();
    await restoreSnapshot(JSON.stringify({ version: 1, removed: [], moved: {}, walls: [] }));
    say('All edits cleared · Undo restores them');
  }

  async function copyEdits() {
    const s = session();
    if (!s) return;
    const text = JSON.stringify(s.edits, null, 2);
    try { await navigator.clipboard.writeText(text); say('Edits copied to the clipboard'); }
    catch { selectionText.textContent = text; say('Copy failed: the edits are shown above'); }
  }

  async function downloadGlb() {
    const room = host.getRoom();
    if (!room) return;
    say('Exporting…');
    const wasVisible = highlight.visible;
    highlight.visible = false; preview.visible = false;
    try {
      const result = await new GLTFExporter().parseAsync(room.group, { binary: true, onlyVisible: true });
      const blob = new Blob([result as ArrayBuffer], { type: 'model/gltf-binary' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `${room.edit?.roomId ?? 'room'}.glb`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      say('Downloaded the model (geometry and materials; lights stay in the viewer)');
    } catch (error) {
      console.error(error);
      say('Export failed. See the console.');
    }
    highlight.visible = wasVisible;
  }

  function setTool(next: Tool) {
    tool = next;
    wallStart = undefined;
    preview.visible = false;
    tools.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => { const on = b.dataset.tool === next; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
    wallOptions.hidden = next !== 'wall';
    host.canvas.style.cursor = next === 'wall' ? 'crosshair' : '';
    say(next === 'wall' ? 'Click the floor to start a wall · Shift = free angle' : '');
    select(undefined);
  }

  async function setActive(on: boolean) {
    if (on === active) return;
    active = on;
    toggle.setAttribute('aria-pressed', String(on));
    toggle.textContent = on ? 'Finish editing' : 'Edit this room';
    tools.hidden = !on;
    undoStack.length = 0;
    editRoomId = undefined;
    wallStart = undefined;
    preview.visible = highlight.visible = false;
    host.canvas.style.cursor = '';
    toggle.disabled = true;
    say(on ? 'Preparing the room for editing…' : '');
    await host.rebuild(on);
    toggle.disabled = false;
    if (on) { setTool('select'); heightInput.value = String(session()?.wallTop ?? 2.7); }
    host.invalidate();
  }

  toggle.addEventListener('click', () => void setActive(!active));
  tools.querySelectorAll<HTMLButtonElement>('[data-tool]').forEach((b) => b.addEventListener('click', () => setTool(b.dataset.tool as Tool)));
  rotateBtn.addEventListener('click', () => rotateSelected(1));
  deleteBtn.addEventListener('click', deleteSelected);
  $('edit-undo').addEventListener('click', () => void undo());
  resetBtn.addEventListener('click', () => void reset());
  $('edit-copy').addEventListener('click', () => void copyEdits());
  $('edit-glb').addEventListener('click', () => void downloadGlb());

  window.addEventListener('keydown', (event) => {
    if (!active || !host.canEdit()) return;
    const el = event.target as HTMLElement | null;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) return;
    if ((event.ctrlKey || event.metaKey) && event.code === 'KeyZ') { event.preventDefault(); void undo(); }
    else if (event.code === 'Delete' || event.code === 'Backspace') { event.preventDefault(); deleteSelected(); }
    else if (event.code === 'KeyR') { event.preventDefault(); rotateSelected(event.shiftKey ? -1 : 1); }
    else if (event.code === 'Escape') { if (wallStart) { wallStart = undefined; preview.visible = false; say('Wall drawing finished'); host.invalidate(); } else select(undefined); }
  }, true);

  return {
    /** the room (re)built: rebind to its session, drop stale selection, show the section only when it is editable */
    roomChanged(roomId: string) {
      const s = session();
      if (active) { editRoomId ??= roomId; if (roomId !== editRoomId) { active = false; toggle.setAttribute('aria-pressed', 'false'); toggle.textContent = 'Edit this room'; tools.hidden = true; } }
      section.hidden = !s;
      selected = undefined; drag = undefined; wallStart = undefined;
      highlight.visible = preview.visible = false;
      if (!s && active) { active = false; toggle.setAttribute('aria-pressed', 'false'); toggle.textContent = 'Edit this room'; tools.hidden = true; }
      if (active) select(undefined);
    },
    get active() { return active; },
  };
}
