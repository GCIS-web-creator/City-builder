// ============================================================================
// HouseInstanceRenderer.jsx  (Prompt 24A)
// ----------------------------------------------------------------------------
// House = a light data record.  Drawing = shared merged geometry + shared material + InstancedMesh.
//   record : { id, archetype:{w,d,variantIndex}, position, rotationY, scale, level, seed, skirt }
//   Renderer keeps NO Group / Mesh per house. THREE objects are per BUCKET:
//     bucket key = sector | lod | geometryKey | materialKey     (many houses -> one InstancedMesh)
//   houseRenderRefs: house.refs = Map(bucket -> instanceIndex); bucket.owners[instanceIndex] = house.
//   Add / remove / LOD move / level change = instance-slot bookkeeping only (swap-remove), never
//   geometry creation or dispose. Geometry is created once per archetype-part-LOD in HousingPBR.jsx.
// ============================================================================
import * as THREE from 'three';
import { getHouseArchetype, getHouseLodParts, getHouseGeometryStats, getHouseMaterialStats, getSolidMaterial } from './HousingPBR.jsx';

// World-space sector size per LOD. Near LODs use small sectors (tight frustum culling); far LODs use big
// ones (everything is on screen when zoomed out anyway) so far houses collapse into a handful of buckets.
const SECTOR_SIZE_BY_LOD = [48, 96, 192, 384, 96]; // index 4 = terrain skirts
const SECTOR_CULL_MARGIN = 26;          // keep shadow casters just outside the view alive
const ORTHO_T = [70, 140, 300];         // LOD thresholds on (view height + 0.5*dist-to-focus), metres
const PERSP_T = [45, 100, 200];         // LOD thresholds on camera distance, metres (driver / ped cams)
const LOD_EXAM_PER_FRAME = 800;         // houses re-evaluated per frame after a view change
const LOD_MOVES_PER_FRAME = 64;         // max LOD bucket moves per frame
const PENDING_PER_FRAME = 96;           // queued (bulk) houses placed per frame
const PENDING_BUDGET_MS = 5;

// Shadow policy per LOD (part -> flag). LOD3: none.
const CAST = [{ wall: 1, roof: 1 }, { wall: 1, roof: 1 }, { roof: 1 }, {}];
const RECV = [{ wall: 1, roof: 1, foundation: 1, deck: 1 }, { wall: 1, roof: 1, foundation: 1 }, { wall: 1, roof: 1, porchroof: 1 }, {}];

const IS_DEV = (() => { try { return !!(import.meta && import.meta.env && import.meta.env.DEV); } catch (e) { return false; } })();

const _Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _pv = new THREE.Matrix4(), _frustum = new THREE.Frustum(), _box = new THREE.Box3();
const _noRaycast = () => {};
let _skirtGeo = null;
const _WHITE = [1, 1, 1];

function _rng(seed) { // mulberry32
  let a = (Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
// Level -> visual bucket style. All occupied levels currently share the same house (the legacy
// builder ignored level too), but level changes go through the same remove/add-instance path so a
// per-level style can be added here without touching the renderer.
function levelStyle(level) { return level > 0 ? 'std' : 'none'; }

export function createHouseInstanceRenderer(scene) {
  const houses = new Map();
  const houseList = [];               // for round-robin LOD passes
  const buckets = new Map();
  const sectors = new Map();
  const archUse = new Map();          // archetype id -> house count
  const pending = [];
  const stats = { updateMs: 0, lastPlaceMs: 0, frame: 0, tick: 0 };
  let ctx = null;                     // last view context (for initial LOD of new houses)
  let viewSig = '';
  let lodCursor = 0, lodRemaining = 0;
  let lastCamera = null;
  let emptyBuckets = 0;               // buckets currently holding 0 instances (pruned in batches)

  // ---------- sectors / buckets ----------
  function _sector(x, z, lodIdx) {
    const size = SECTOR_SIZE_BY_LOD[lodIdx];
    const sx = Math.floor(x / size), sz = Math.floor(z / size), key = `${lodIdx}:${sx}_${sz}`;
    let s = sectors.get(key);
    if (!s) {
      s = { key, box: new THREE.Box3(new THREE.Vector3(sx * size - SECTOR_CULL_MARGIN, -40, sz * size - SECTOR_CULL_MARGIN),
        new THREE.Vector3((sx + 1) * size + SECTOR_CULL_MARGIN, 90, (sz + 1) * size + SECTOR_CULL_MARGIN)), buckets: new Set(), visible: true };
      sectors.set(key, s);
    }
    return s;
  }
  function _makeMesh(b, cap) {
    const mesh = new THREE.InstancedMesh(b.geometry, b.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (b.tinted) {
      mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3);
      mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    }
    mesh.count = b.count; mesh.frustumCulled = false; mesh.raycast = _noRaycast; // culling is per sector, below
    mesh.castShadow = b.cast; mesh.receiveShadow = b.recv;
    mesh.visible = b.count > 0 && b.sector.visible;
    mesh.name = `houses|${b.key}`;
    return mesh;
  }
  function _bucket(sector, lodKey, geoKey, geometry, matKey, material, part, cast, recv, tinted) {
    const key = `${sector.key}|${lodKey}|${geoKey}|${matKey}`;
    let b = buckets.get(key);
    if (b) return b;
    b = { key, sector, geometry, material, part, tinted: !!tinted, cast: !!cast, recv: !!recv, count: 0, capacity: 8, owners: [], mesh: null };
    b.mesh = _makeMesh(b, b.capacity);
    emptyBuckets++; // decremented by the first _bucketAdd
    scene.add(b.mesh);
    sector.buckets.add(b);
    buckets.set(key, b);
    return b;
  }
  function _grow(b) {
    const old = b.mesh, cap = b.capacity * 2;
    b.capacity = cap;
    const mesh = _makeMesh(b, cap);
    mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, b.count * 16));
    if (b.tinted) mesh.instanceColor.array.set(old.instanceColor.array.subarray(0, b.count * 3));
    scene.remove(old); old.dispose(); // frees only the old instance buffers; geometry/material are shared
    scene.add(mesh); b.mesh = mesh;
  }
  function _bucketAdd(b, house, matrix, tint) {
    if (b.count === b.capacity) _grow(b);
    if (b.count === 0) emptyBuckets = Math.max(0, emptyBuckets - 1);
    const slot = b.count++;
    b.owners[slot] = house; house.refs.set(b, slot);
    b.mesh.instanceMatrix.array.set(matrix.elements, slot * 16);
    if (b.tinted) b.mesh.instanceColor.array.set(tint, slot * 3);
    b.mesh.count = b.count;
    b.mesh.instanceMatrix.needsUpdate = true; if (b.tinted) b.mesh.instanceColor.needsUpdate = true;
    b.mesh.visible = b.sector.visible;
  }
  function _bucketRemove(b, house) {
    const slot = house.refs.get(b); if (slot === undefined) return;
    const last = b.count - 1;
    if (slot !== last) { // swap-remove: move the last instance into the vacated slot
      const ma = b.mesh.instanceMatrix.array;
      ma.copyWithin(slot * 16, last * 16, last * 16 + 16);
      if (b.tinted) b.mesh.instanceColor.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
      const moved = b.owners[last]; b.owners[slot] = moved; moved.refs.set(b, slot);
    }
    b.owners[last] = undefined; b.count = last; b.mesh.count = last;
    house.refs.delete(b);
    b.mesh.instanceMatrix.needsUpdate = true; if (b.tinted) b.mesh.instanceColor.needsUpdate = true;
    if (last === 0) { b.mesh.visible = false; emptyBuckets++; }
  }

  // ---------- per-house attach / detach ----------
  function _composeMatrices(h) {
    _q.setFromAxisAngle(_Y, h.rotationY); _p.set(h.position.x, h.position.y, h.position.z);
    _s.set(h.scale, h.scale * h.sy, h.scale);
    h.matrix.compose(_p, _q, _s);
    if (h.skirt) {
      _q.setFromAxisAngle(_Y, h.skirt.yaw || 0);
      _p.set(h.position.x, h.position.y - h.skirt.height / 2 + 0.02, h.position.z);
      _s.set(h.skirt.width, h.skirt.height, h.skirt.depth);
      h.skirtMatrix.compose(_p, _q, _s);
    }
  }
  const _tm = new THREE.Matrix4(), _tc = [1, 1, 1];
  function _attachParts(h, lod) {
    const parts = getHouseLodParts(h.arch, lod);
    const sector = _sector(h.position.x, h.position.z, lod);
    for (const p of parts) {
      const b = _bucket(sector, lod, p.geoKey, p.geometry, p.matKey, p.material, p.part, CAST[lod][p.part], RECV[lod][p.part], p.tinted);
      const m = p.local ? _tm.multiplyMatrices(h.matrix, p.local) : h.matrix;
      let c = _WHITE;
      if (p.tinted) { c = _tc; const base = p.color || _WHITE; c[0] = base[0] * h.tint[0]; c[1] = base[1] * h.tint[1]; c[2] = base[2] * h.tint[2]; }
      _bucketAdd(b, h, m, c);
      h.partBuckets.push(b);
    }
    h.lod = lod;
  }
  function _detachParts(h) {
    for (const b of h.partBuckets) _bucketRemove(b, h);
    h.partBuckets.length = 0;
  }
  function _attachSkirt(h) {
    if (!h.skirt) return;
    if (!_skirtGeo) _skirtGeo = new THREE.BoxGeometry(1, 1, 1);
    const color = h.skirt.retaining ? 0x5b5750 : 0x8a8378;
    const b = _bucket(_sector(h.position.x, h.position.z, 4), 'S', 'skirt', _skirtGeo, `solid:${color}`, getSolidMaterial(color, { roughness: 0.95, metalness: 0 }), 'skirt', true, true, false);
    _bucketAdd(b, h, h.skirtMatrix, _WHITE);
    h.skirtBucket = b;
  }
  function _detachSkirt(h) { if (h.skirtBucket) { _bucketRemove(h.skirtBucket, h); h.skirtBucket = null; } }

  function _lodFor(h, c, cur) {
    if (!c) return cur;
    let m, T;
    if (c.ortho) { m = c.viewH + 0.5 * Math.hypot(h.position.x - c.fx, h.position.z - c.fz); T = ORTHO_T; }
    else { m = Math.hypot(h.position.x - c.cx, h.position.y - c.cy, h.position.z - c.cz); T = PERSP_T; }
    let lod = cur;
    while (lod < 3 && m > T[lod] * 1.08) lod++;   // hysteresis so houses at a threshold do not flicker
    while (lod > 0 && m < T[lod - 1] * 0.92) lod--;
    return lod;
  }

  function _place(h) {
    h.lod = ctx ? _lodFor(h, ctx, 0) : 0;
    _attachParts(h, h.lod);
    _attachSkirt(h);
    h.placed = true;
  }

  // ---------- public API ----------
  function _buildRecord(rec, existing) {
    const a = rec.archetype;
    const arch = a.id ? a : getHouseArchetype(a.w, a.d, a.variantIndex || 0);
    if (!arch) throw new Error(`no low-density house archetype for ${a.w}x${a.d}`);
    getHouseLodParts(arch, 0); // build + validate the shared LOD0 geometry NOW (throws here, not later inside a frame)
    const rnd = _rng(rec.seed == null ? 1 : rec.seed);
    const v = 0.9 + rnd() * 0.13; // subtle per-house tint (seed-driven; NOT per-house geometry)
    const h = existing || { id: rec.id, refs: new Map(), partBuckets: [], skirtBucket: null, matrix: new THREE.Matrix4(), skirtMatrix: new THREE.Matrix4(), placed: false, lod: 0, listIndex: -1 };
    h.arch = arch; h.level = rec.level ?? 1; h.style = levelStyle(h.level); h.seed = rec.seed ?? 0;
    h.position = { x: rec.position.x, y: rec.position.y, z: rec.position.z };
    h.rotationY = rec.rotationY || 0; h.scale = rec.scale || 1;
    h.sy = 0.97 + rnd() * 0.07; // height jitter only: footprint stays inside the lot
    h.tint = [v * (0.985 + rnd() * 0.03), v, v * (0.985 + rnd() * 0.03)];
    h.skirt = rec.skirt ? { ...rec.skirt } : null;
    _composeMatrices(h);
    return h;
  }

  /** Add a house. immediate=true places its instances now (cheap slot writes); false queues it for batched placement. */
  function addHouse(rec, opts = {}) {
    if (houses.has(rec.id)) return updateHouse(rec);
    const t0 = performance.now();
    const h = _buildRecord(rec, null);
    houses.set(h.id, h); h.listIndex = houseList.push(h) - 1;
    archUse.set(h.arch.id, (archUse.get(h.arch.id) || 0) + 1);
    if (opts.immediate === false) pending.push(h); else _place(h);
    stats.lastPlaceMs = performance.now() - t0;
    return h.id;
  }
  function removeHouse(id) {
    const h = houses.get(id); if (!h) return false;
    if (h.placed) { _detachParts(h); _detachSkirt(h); }
    else { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); }
    houses.delete(id);
    const last = houseList.pop(); if (last !== h) { houseList[h.listIndex] = last; last.listIndex = h.listIndex; }
    const n = (archUse.get(h.arch.id) || 1) - 1; if (n <= 0) archUse.delete(h.arch.id); else archUse.set(h.arch.id, n);
    return true;
  }
  /** Re-sync an existing house after a level / grading / archetype change. No geometry is created or disposed. */
  function updateHouse(rec) {
    const h = houses.get(rec.id); if (!h) return addHouse(rec);
    const prevArch = h.arch.id;
    const wasPlaced = h.placed;
    if (wasPlaced) { _detachParts(h); _detachSkirt(h); }
    _buildRecord(rec, h);
    if (h.arch.id !== prevArch) {
      const n = (archUse.get(prevArch) || 1) - 1; if (n <= 0) archUse.delete(prevArch); else archUse.set(prevArch, n);
      archUse.set(h.arch.id, (archUse.get(h.arch.id) || 0) + 1);
    }
    if (wasPlaced) { _place(h); } // level / skirt / transform change = remove instance + add instance (slot bookkeeping only)
    return h.id;
  }
  const setLevel = (id, level) => { const h = houses.get(id); if (!h || h.level === level) return; h.level = level; if (levelStyle(level) !== h.style) { h.style = levelStyle(level); if (h.placed) { _detachParts(h); _attachParts(h, h.lod); } } };
  const hasHouse = (id) => houses.has(id);

  function flushPending(budgetMs = PENDING_BUDGET_MS) {
    const t0 = performance.now(); let n = 0;
    while (pending.length && n < PENDING_PER_FRAME && performance.now() - t0 < budgetMs) { _place(pending.shift()); n++; }
    return n;
  }

  function _makeCtx(camera, opts) {
    const f = opts.focus || { x: 0, z: 0 };
    if (camera.isOrthographicCamera) return { ortho: true, viewH: (camera.top - camera.bottom) / (camera.zoom || 1), fx: f.x, fz: f.z };
    return { ortho: false, cx: camera.position.x, cy: camera.position.y, cz: camera.position.z };
  }

  /** Call once per frame with the camera that is about to render. */
  function update(camera, opts = {}) {
    const t0 = performance.now();
    lastCamera = camera;
    flushPending();
    ctx = _makeCtx(camera, opts);
    const sig = ctx.ortho ? `o|${Math.round(ctx.viewH * 4)}|${Math.round(ctx.fx / 6)}|${Math.round(ctx.fz / 6)}` : `p|${Math.round(ctx.cx / 3)}|${Math.round(ctx.cy / 3)}|${Math.round(ctx.cz / 3)}`;
    if (sig !== viewSig) { viewSig = sig; lodRemaining = houseList.length; }
    // per-sector frustum culling (InstancedMesh.frustumCulled is off: one instanced mesh spans many houses)
    camera.updateMatrixWorld();
    _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse); _frustum.setFromProjectionMatrix(_pv);
    sectors.forEach((s) => {
      const vis = _frustum.intersectsBox(s.box);
      if (vis !== s.visible) { s.visible = vis; s.buckets.forEach((b) => { b.mesh.visible = vis && b.count > 0; }); }
    });
    // batched LOD pass: bucket moves only, capped per frame
    if (lodRemaining > 0 && houseList.length) {
      const exam = Math.min(LOD_EXAM_PER_FRAME, lodRemaining); let done = 0, moves = 0;
      while (done < exam && moves < LOD_MOVES_PER_FRAME) {
        if (lodCursor >= houseList.length) lodCursor = 0;
        const h = houseList[lodCursor++]; done++;
        if (!h.placed) continue;
        const nl = _lodFor(h, ctx, h.lod);
        if (nl !== h.lod) { _detachParts(h); _attachParts(h, nl); moves++; }
      }
      lodRemaining -= done;
    }
    if (emptyBuckets > 48) _prune();
    stats.updateMs = performance.now() - t0;
    if (IS_DEV && typeof window !== 'undefined' && (++stats.frame % 30) === 0) window.__HOUSE_RENDER_STATS__ = getStats();
  }

  function _prune() { // drop empty buckets (their instance buffers only) so the scene graph does not accumulate dead meshes
    buckets.forEach((b, k) => { if (b.count === 0) { scene.remove(b.mesh); b.mesh.dispose(); b.sector.buckets.delete(b); buckets.delete(k); } });
    emptyBuckets = 0;
  }

  function getStats() {
    const inst = [0, 0, 0, 0]; let visibleMeshes = 0, instances = 0;
    buckets.forEach((b) => { if (b.count > 0) { if (b.mesh.visible) visibleMeshes++; instances += b.count; } });
    houseList.forEach((h) => { if (h.placed) inst[h.lod]++; });
    const g = getHouseGeometryStats(), m = getHouseMaterialStats();
    return {
      houseCount: houses.size, pendingHouses: pending.length, archetypeCount: archUse.size, archetypeCacheSize: g.archetypeCount,
      geometryCount: g.geometryCount, materialCount: m.totalMaterials, textureCount: m.totalTextures, sharedTextureCount: m.sharedTextures,
      meshCount: buckets.size, drawCallsVisible: visibleMeshes, instanceCount: instances, housesByLOD: inst,
      sectors: sectors.size, updateMs: +stats.updateMs.toFixed(3), lastPlaceMs: +stats.lastPlaceMs.toFixed(3),
    };
  }

  /** Consistency check (dev/test): every ref points at an owner slot holding the right matrix. Returns mismatch count. */
  function verify() {
    let bad = 0; const m = new THREE.Matrix4();
    houses.forEach((h) => {
      if (!h.placed) return;
      const parts = getHouseLodParts(h.arch, h.lod);
      if (h.partBuckets.length !== parts.length) bad++;
      h.partBuckets.forEach((b, i) => {
        const slot = h.refs.get(b);
        if (slot === undefined || b.owners[slot] !== h || slot >= b.count) { bad++; return; }
        const p = parts[i]; const exp = p.local ? m.multiplyMatrices(h.matrix, p.local) : h.matrix;
        const arr = b.mesh.instanceMatrix.array;
        for (let k = 0; k < 16; k++) if (Math.abs(arr[slot * 16 + k] - exp.elements[k]) > 1e-5) { bad++; break; }
      });
    });
    buckets.forEach((b) => { for (let i = 0; i < b.count; i++) { const o = b.owners[i]; if (!o || o.refs.get(b) !== i) bad++; } });
    return bad;
  }

  function dispose() {
    buckets.forEach((b) => { scene.remove(b.mesh); b.mesh.dispose(); }); // shared geometry / materials are never disposed here
    buckets.clear(); sectors.clear(); houses.clear(); houseList.length = 0; pending.length = 0; archUse.clear();
  }

  /** Dev benchmark: places N synthetic houses (all 11 sizes, both orientations), measures placement + one update(). */
  function benchmark(counts = [1, 2, 10, 100, 500, 1000, 2000, 5000], camera = lastCamera, keep = false) {
    const sizes = ['2x3', '3x3', '3x4', '3x5', '3x6', '4x4', '4x5', '4x6', '5x5', '5x6', '6x6'].flatMap((k) => { const [a, b] = k.split('x').map(Number); return a === b ? [[a, b]] : [[a, b], [b, a]]; });
    const rows = [];
    for (const n of counts) {
      const ids = []; const t0 = performance.now();
      for (let i = 0; i < n; i++) {
        const [w, d] = sizes[i % sizes.length], gx = i % 72, gz = Math.floor(i / 72);
        const id = `bench_${n}_${i}`; ids.push(id);
        addHouse({ id, archetype: { w, d, variantIndex: i % 10 }, position: { x: -180 + gx * 5, y: 0, z: -180 + gz * 8 }, rotationY: (i % 8) * 0.4, level: 1, seed: i, skirt: i % 9 === 0 ? { height: 0.6, retaining: false, width: w * 0.97, depth: d * 0.97, yaw: (i % 8) * 0.4 } : null }, { immediate: true });
      }
      const placeMs = performance.now() - t0;
      const u0 = performance.now(); if (camera) { viewSig = ''; update(camera, { focus: { x: 0, z: 0 } }); } const updMs = performance.now() - u0;
      rows.push({ houses: n, placeMs: +placeMs.toFixed(2), msPerHouse: +(placeMs / n).toFixed(4), firstUpdateMs: +updMs.toFixed(2), ...getStats() });
      if (!keep) { ids.forEach(removeHouse); _prune(); }
    }
    return rows;
  }

  const api = { addHouse, removeHouse, updateHouse, setLevel, hasHouse, flushPending, update, getStats, verify, dispose, benchmark };
  if (IS_DEV && typeof window !== 'undefined') { window.__HOUSE_RENDERER__ = api; window.__HOUSE_BENCH__ = (counts, keep) => { const r = benchmark(counts, lastCamera, keep); console.table(r); return r; }; }
  return api;
}
