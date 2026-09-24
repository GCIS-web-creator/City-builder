// ============================================================================
// HouseInstanceRenderer.jsx  (Prompt 24A-R2, res_mid dispatch added in Prompt 39B)
// ----------------------------------------------------------------------------
// House = a light data record.  Drawing = shared module geometry + shared material + InstancedMesh.
//   record : { id, archetype, position, rotationY, scale, level, seed, yardDepth, yardSign, skirt }
//   archetype is either a resolved archetype object (has .id — from getHouseArchetype /
//   getTerraceArchetype / getMediumDensityArchetype) or the shorthand { w, d, variantIndex, kind? }.
//   kind is 'res_low' (default, omit it), 'res_terrace' (pass a resolved terrace archetype — same as
//   before), or 'res_mid' (either pass { w, d, variantIndex, kind: 'res_mid' } or a resolved
//   getMediumDensityArchetype(...) object). res_low/res_terrace/res_mid are NOT separate rendering
//   paths — same records Map, same houseList, same buckets/sectors/InstancedMesh pipeline below;
//   `kind` only selects which HousingPBR.jsx functions build the kit-of-parts (see _lodPartsFor /
//   _lotPartsFor above _buildRecord).
//   Renderer keeps NO Group / Mesh per house. THREE objects are per BUCKET:
//     bucket key = sector | lod | geometryKey | materialKey     (many houses -> one InstancedMesh)
//   One house owns SEVERAL instances (one per module of its kit: wall, roof, windows, columns ...),
//   possibly several in the same bucket (e.g. 4 window frames = 4 instances of the shared unit box).
//   Ownership: house.insts = [inst], inst = { house, b, slot }, bucket.owners[slot] = inst.
//   Add / remove / LOD move / level change = instance-slot bookkeeping only (swap-remove), never
//   geometry creation or dispose. Geometry is created once per module key in HousingPBR.jsx.
// ============================================================================
import * as THREE from 'three';
import {
  getHouseArchetype, getHouseLodParts, getHouseLotParts,
  getMediumDensityArchetype, getMediumDensityLodParts, getMediumDensityLotParts,
  getHighDensityArchetype, getHighDensityLodParts, getHighDensityLotParts,
  getHouseGeometryStats, getHouseMaterialStats, getSolidMaterial, disposeHouseSharedResources, HOUSE_STATS, HOUSE_SCALE,
} from './HousingPBR.jsx';

// ---------------------------------------------------------------------------------------------
// Prompt 39B: res_low / res_terrace / res_mid all share this ONE renderer (bucket/InstancedMesh
// pipeline below never branches on kind). Only the two calls that fetch an archetype's kit-of-parts
// need to know which HousingPBR.jsx module built the archetype, because res_mid uses its own
// LOD/lot functions (different layout shape, no per-instance yardDepth — the yard is a fixed
// allocation baked into the archetype). Every archetype object — low, terrace, or medium — carries
// a `kind` tag ('res_low' default for legacy archetypes with none, 'res_terrace', 'res_mid'); that
// tag is the ONLY thing that determines the dispatch below.
const RES_MID = 'res_mid';
const RES_HIGH = 'res_high';
function _archKind(arch) { return (arch && arch.kind) || 'res_low'; }
/** House body kit-of-parts for one archetype at one LOD, regardless of kind. */
function _lodPartsFor(arch, lod) {
  const kind = _archKind(arch);
  if (kind === RES_MID) return getMediumDensityLodParts(arch, lod);
  if (kind === RES_HIGH) return getHighDensityLodParts(arch, lod);
  return getHouseLodParts(arch, lod);
}
/** Lot dressing (yard/fence) for one archetype. res_mid/res_high ignore yardDepth/rear — their yard
 * (or, for res_high, lack of one) is fixed by the archetype itself — but still gate on yardDepth>=0
 * exactly like res_low/res_terrace, so the record shape (`{ ..., yardDepth, yardSign }`) stays uniform. */
function _lotPartsFor(arch, yardDepth, lod, rear) {
  const kind = _archKind(arch);
  if (kind === RES_MID) return getMediumDensityLotParts(arch, lod);
  if (kind === RES_HIGH) return getHighDensityLotParts(arch, lod);
  return getHouseLotParts(arch, yardDepth, lod, rear);
}

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
const INITIAL_CAPACITY = 16;

// Shadow policy per LOD (part -> flag). Small detail parts (trim, glass, columns, rails ...) neither cast nor
// receive: they are a few cm thick and would only cost shadow-pass draw calls.
// res_mid part names added below (parapet/roofdeck/core/balcslab/canopy/stepdeck/watertank/hedge/
// planting): same policy as res_low/res_terrace — only Near-LOD structural masses cast shadows, small
// trims (winframe/glass/mullion/sill/railing/baluster/doorframe/door/canopypost/column/acunit/vent/
// pier/winsurround/recess) never do, and nothing casts past Mid (LOD2/3), matching CAST[2]/[3] below.
const CAST = [
  { wall: 1, roof: 1, porchroof: 1, chimney: 1, dormerwall: 1, dormerroof: 1, parapet: 1, roofdeck: 1, core: 1, balcslab: 1, canopy: 1,
    podium: 1, tower: 1, crown: 1, crowncap: 1 },
  { wall: 1, roof: 1, parapet: 1, core: 1, podium: 1, tower: 1, crown: 1 }, { roof: 1, parapet: 1, podium: 1, tower: 1, crown: 1 }, {},
];
// Note: lot-dressing parts (lawn, fence, path, and the yard furniture/pool added in HousingPBR.jsx's
// _lotParts, or hedge/planting added in its res_mid _midLotParts, or the entrance plaza added in its
// res_high _highLotParts) are attached via _attachParts' second loop below, which hardcodes cast=false
// for all of them (same treatment as the lawn) — only RECV matters here for 'furniture'/'pool'/
// 'hedge'/'planting'/'plaza'.
const RECV = [
  { wall: 1, roof: 1, porchroof: 1, foundation: 1, deck: 1, steps: 1, chimney: 1, door: 1, dormerwall: 1, dormerroof: 1, lawn: 1, path: 1, furniture: 1, pool: 1,
    parapet: 1, roofdeck: 1, core: 1, balcslab: 1, canopy: 1, stepdeck: 1, watertank: 1, hedge: 1, planting: 1,
    podium: 1, tower: 1, crown: 1, crowncap: 1, lobbyglass: 1, roofpool: 1, plaza: 1 },
  { wall: 1, roof: 1, foundation: 1, lawn: 1, parapet: 1, core: 1, hedge: 1, podium: 1, tower: 1, crown: 1 },
  { wall: 1, roof: 1, porchroof: 1, lawn: 1, parapet: 1, core: 1, podium: 1, tower: 1, crown: 1 },
  { lawn: 1 },
];

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

const _Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _pv = new THREE.Matrix4(), _frustum = new THREE.Frustum();
const _noRaycast = () => {};
let _skirtGeo = null;
const _WHITE = [1, 1, 1];

function _rng(seed) { // mulberry32
  let a = (Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
function levelStyle(level) { return level > 0 ? 'std' : 'none'; }

export function createHouseInstanceRenderer(scene) {
  const houses = new Map();
  const houseList = [];               // for round-robin LOD passes
  const buckets = new Map();
  const sectors = new Map();
  const archUse = new Map();          // archetype id -> house count
  const pending = [];
  const stats = { updateMs: 0, lastPlaceMs: 0, frame: 0, houseCreateMs: 0, instanceWriteMs: 0, instanceUpdateMs: 0, addCalls: 0 };
  let ctx = null;                     // last view context (for initial LOD of new houses)
  let viewSig = '';
  let lodCursor = 0, lodRemaining = 0;
  let lastCamera = null;
  let emptyBuckets = 0;               // buckets currently holding 0 instances (pruned in batches)
  let forcedLod = null;               // dev/stress: force every house to one LOD

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
    if (b.part === 'poolwater') {
      // Pool water's ripple is driven by a uTime uniform on its (single, shared) material — see
      // _poolWaterMaterial() in HousingPBR.jsx. onBeforeRender fires automatically whenever this
      // bucket's mesh is actually drawn, so no hook into the main app's render loop is needed.
      const mat = b.material;
      mesh.onBeforeRender = () => {
        const sh = mat?.userData?.shader;
        if (sh?.uniforms?.uTime) sh.uniforms.uTime.value = _now() / 1000;
      };
    }
    return mesh;
  }
  function _bucket(sector, lodKey, geoKey, geometry, matKey, material, part, cast, recv, tinted) {
    const key = `${sector.key}|${lodKey}|${geoKey}|${matKey}${tinted ? '+t' : ''}`;
    let b = buckets.get(key);
    if (b) return b;
    b = { key, sector, geometry, material, part, tinted: !!tinted, cast: !!cast, recv: !!recv, count: 0, capacity: INITIAL_CAPACITY, owners: [], mesh: null };
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
    const slot = b.count++, inst = { house, b, slot };
    b.owners[slot] = inst;
    b.mesh.instanceMatrix.array.set(matrix.elements, slot * 16);
    if (b.tinted) b.mesh.instanceColor.array.set(tint, slot * 3);
    b.mesh.count = b.count;
    b.mesh.instanceMatrix.needsUpdate = true; if (b.tinted) b.mesh.instanceColor.needsUpdate = true;
    b.mesh.visible = b.sector.visible;
    return inst;
  }
  function _bucketRemove(inst) {
    const b = inst.b, slot = inst.slot, last = b.count - 1;
    if (slot !== last) { // swap-remove: move the last instance into the vacated slot
      b.mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      if (b.tinted) b.mesh.instanceColor.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
      const moved = b.owners[last]; b.owners[slot] = moved; moved.slot = slot;
    }
    b.owners[last] = undefined; b.count = last; b.mesh.count = last;
    b.mesh.instanceMatrix.needsUpdate = true; if (b.tinted) b.mesh.instanceColor.needsUpdate = true;
    if (last === 0) { b.mesh.visible = false; emptyBuckets++; }
  }

  // ---------- per-house attach / detach ----------
  function _composeMatrices(h) {
    _p.set(h.position.x, h.position.y, h.position.z);
    _s.set(h.scale, h.scale * h.sy, h.scale);
    _q.setFromAxisAngle(_Y, h.rotationY + (h.yardSign < 0 ? Math.PI : 0)); h.lotMatrix.compose(_p, _q, _s); // yard/fence frame (NOT shrunk): +Z = road side
    _q.setFromAxisAngle(_Y, h.rotationY);
    const hs = h.arch && h.arch.houseScale; // per-archetype override (e.g. terrace: full width so party walls touch, deeper footprint)
    if (hs) _s.set(h.scale * hs.x, h.scale * h.sy * hs.y, h.scale * hs.z);
    else _s.multiplyScalar(HOUSE_SCALE); // default: uniform HOUSE_SCALE, unchanged
    h.matrix.compose(_p, _q, _s); // house only: HOUSE_SCALE (or archetype's houseScale override)
    if (h.skirt) {
      _q.setFromAxisAngle(_Y, h.skirt.yaw || 0);
      _p.set(h.position.x, h.position.y - h.skirt.height / 2 + 0.02, h.position.z);
      _s.set(h.skirt.width, h.skirt.height, h.skirt.depth);
      h.skirtMatrix.compose(_p, _q, _s);
    }
  }
  const _tm = new THREE.Matrix4(), _tc = [1, 1, 1];
  function _attachParts(h, lod) {
    const t0 = _now();
    const parts = _lodPartsFor(h.arch, lod);   // cached on the archetype; module geometry comes from the shared cache
    const sector = _sector(h.position.x, h.position.z, lod);
    for (const p of parts) {
      const b = _bucket(sector, lod, p.geoKey, p.geometry, p.matKey, p.material, p.part, CAST[lod][p.part], RECV[lod][p.part], p.tinted);
      const m = p.local ? _tm.multiplyMatrices(h.matrix, p.local) : h.matrix;
      let c = _WHITE;
      if (p.tinted) { c = _tc; const base = p.color || _WHITE; c[0] = base[0] * h.tint[0]; c[1] = base[1] * h.tint[1]; c[2] = base[2] * h.tint[2]; }
      h.insts.push(_bucketAdd(b, h, m, c));
    }
    if (h.yardDepth >= 0) { // lot dressing: front yard + fence/wall around the whole lot (same shared-geometry instancing)
      for (const p of _lotPartsFor(h.arch, h.yardDepth, lod, h.yardRear)) {
        const b = _bucket(sector, lod, p.geoKey, p.geometry, p.matKey, p.material, p.part, false, RECV[lod][p.part], false);
        h.insts.push(_bucketAdd(b, h, _tm.multiplyMatrices(h.lotMatrix, p.local), _WHITE));
      }
    }
    h.lod = lod;
    stats.instanceWriteMs += _now() - t0;
  }
  function _detachParts(h) {
    for (let i = 0; i < h.insts.length; i++) _bucketRemove(h.insts[i]);
    h.insts.length = 0;
  }
  function _attachSkirt(h) {
    if (!h.skirt) return;
    if (!_skirtGeo) _skirtGeo = new THREE.BoxGeometry(1, 1, 1);
    const color = h.skirt.retaining ? 0x5b5750 : 0x8a8378;
    const b = _bucket(_sector(h.position.x, h.position.z, 4), 'S', 'skirt', _skirtGeo, `solid:${color}`, getSolidMaterial(color, { roughness: 0.95, metalness: 0 }), 'skirt', true, true, false);
    h.skirtInst = _bucketAdd(b, h, h.skirtMatrix, _WHITE);
  }
  function _detachSkirt(h) { if (h.skirtInst) { _bucketRemove(h.skirtInst); h.skirtInst = null; } }

  function _lodFor(h, c, cur) {
    if (forcedLod !== null) return forcedLod;
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
    h.lod = ctx || forcedLod !== null ? _lodFor(h, ctx, 0) : 0;
    _attachParts(h, h.lod);
    _attachSkirt(h);
    h.placed = true;
  }

  // ---------- public API ----------
  function _buildRecord(rec, existing) {
    const a = rec.archetype;
    // a.id present = caller already resolved the archetype (getHouseArchetype / getTerraceArchetype /
    // getMediumDensityArchetype / getHighDensityArchetype) and just hands the object through — this
    // already works for any kind, unchanged. a.kind === 'res_mid' / 'res_high' are shorthand forms,
    // mirroring the existing {w,d,variantIndex} convenience for res_low, so callers don't have to
    // import getMediumDensityArchetype/getHighDensityArchetype themselves.
    const arch = a.id ? a
      : a.kind === 'res_mid' ? getMediumDensityArchetype(a.w, a.d, a.variantIndex || 0)
      : a.kind === 'res_high' ? getHighDensityArchetype(a.w, a.d, a.variantIndex || 0)
      : getHouseArchetype(a.w, a.d, a.variantIndex || 0);
    if (!arch) throw new Error(`no ${a.kind || 'res_low'} house archetype for ${a.w}x${a.d}`);
    const rnd = _rng(rec.seed == null ? 1 : rec.seed);
    const v = 0.9 + rnd() * 0.13; // subtle per-house tint (seed-driven; NOT per-house geometry)
    const h = existing || { id: rec.id, insts: [], skirtInst: null, matrix: new THREE.Matrix4(), lotMatrix: new THREE.Matrix4(), skirtMatrix: new THREE.Matrix4(), placed: false, lod: 0, listIndex: -1 };
    h.arch = arch; h.level = rec.level ?? 1; h.style = levelStyle(h.level); h.seed = rec.seed ?? 0;
    h.position = { x: rec.position.x, y: rec.position.y, z: rec.position.z };
    h.rotationY = rec.rotationY || 0; h.scale = rec.scale || 1;
    h.sy = 0.97 + rnd() * 0.07; // height jitter only: footprint stays inside the lot
    h.tint = [v * (0.985 + rnd() * 0.03), v, v * (0.985 + rnd() * 0.03)];
    h.skirt = rec.skirt ? { ...rec.skirt } : null;
    // Part 19: lightweight feature flags come from the archetype (porch / chimney / dormer / wraparound)
    h.features = arch.features;
    h.yardDepth = rec.yardDepth == null ? -1 : rec.yardDepth; // -1 = no lot dressing (legacy records); >= 0 = yard depth in metres (fence always drawn)
    h.yardSign = rec.yardSign < 0 ? -1 : 1;
    h.yardRear = !!rec.yardRear; // true = closed U-shaped fence open toward the house (private back yard); false = front-yard fence with a road-facing gate
    _composeMatrices(h);
    return h;
  }

  function _unregister(h) {
    houses.delete(h.id);
    if (h.listIndex >= 0) { const last = houseList.pop(); if (last !== h) { houseList[h.listIndex] = last; last.listIndex = h.listIndex; } }
    const n = (archUse.get(h.arch.id) || 1) - 1; if (n <= 0) archUse.delete(h.arch.id); else archUse.set(h.arch.id, n);
  }

  /** Add a house. immediate=true places its instances now (cheap slot writes); false queues it for batched placement. */
  function addHouse(rec, opts = {}) {
    if (houses.has(rec.id)) return updateHouse(rec);
    const t0 = _now();
    const h = _buildRecord(rec, null);
    houses.set(h.id, h); h.listIndex = houseList.push(h) - 1;
    archUse.set(h.arch.id, (archUse.get(h.arch.id) || 0) + 1);
    if (opts.immediate === false) pending.push(h);
    else {
      try { _place(h); }
      catch (err) { _detachParts(h); _detachSkirt(h); _unregister(h); throw err; } // throws for a geometry/material failure -> caller rolls the lot back
    }
    stats.lastPlaceMs = _now() - t0; stats.houseCreateMs += stats.lastPlaceMs; stats.addCalls++;
    return h.id;
  }
  /** Bulk add: records are queued and placed a few per frame (flushPending, time-budgeted). Archetype kits are built once, on first use. */
  function addHouses(recs) { return recs.map((r) => addHouse(r, { immediate: false })); }
  function removeHouse(id) {
    const h = houses.get(id); if (!h) return false;
    if (h.placed) { _detachParts(h); _detachSkirt(h); }
    else { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); }
    _unregister(h);
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
    if (wasPlaced) _place(h); // level / skirt / transform change = remove instances + add instances (slot bookkeeping only)
    return h.id;
  }
  const setLevel = (id, level) => { const h = houses.get(id); if (!h || h.level === level) return; h.level = level; if (levelStyle(level) !== h.style) { h.style = levelStyle(level); if (h.placed) { _detachParts(h); _attachParts(h, h.lod); } } };
  const hasHouse = (id) => houses.has(id);

  function flushPending(budgetMs = PENDING_BUDGET_MS) {
    const t0 = _now(); let n = 0;
    while (pending.length && n < PENDING_PER_FRAME && _now() - t0 < budgetMs) { _place(pending.shift()); n++; }
    return n;
  }

  function _makeCtx(camera, opts) {
    const f = opts.focus || { x: 0, z: 0 };
    if (camera.isOrthographicCamera) return { ortho: true, viewH: (camera.top - camera.bottom) / (camera.zoom || 1), fx: f.x, fz: f.z };
    return { ortho: false, cx: camera.position.x, cy: camera.position.y, cz: camera.position.z };
  }

  /** Call once per frame with the camera that is about to render. */
  function update(camera, opts = {}) {
    const t0 = _now();
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
    // batched LOD pass: bucket moves only (cached kits -> no geometry generation), capped per frame
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
    stats.updateMs = _now() - t0;
    stats.instanceUpdateMs = stats.updateMs;
    if (typeof window !== 'undefined' && (++stats.frame % 30) === 0) window.__HOUSE_RENDER_STATS__ = getStats(); // cheap: a few loops every 30 frames
  }

  function _prune() { // drop empty buckets (their instance buffers only) so the scene graph does not accumulate dead meshes
    buckets.forEach((b, k) => { if (b.count === 0) { scene.remove(b.mesh); b.mesh.dispose(); b.sector.buckets.delete(b); buckets.delete(k); } });
    emptyBuckets = 0;
  }

  function getStats() {
    const inst = [0, 0, 0, 0]; let visibleMeshes = 0, instances = 0, live = 0;
    buckets.forEach((b) => { if (b.count > 0) { live++; if (b.mesh.visible) visibleMeshes++; instances += b.count; } });
    houseList.forEach((h) => { if (h.placed) inst[h.lod]++; });
    const g = getHouseGeometryStats(), m = getHouseMaterialStats();
    return {
      houseCount: houses.size, pendingHouses: pending.length, archetypeCount: archUse.size, archetypeCacheSize: g.archetypeCount,
      geometryCount: g.geometryCount, geometryHit: g.geometryHit, geometryMiss: g.geometryMiss, geometryCreateMs: g.geometryCreateMs,
      materialCount: m.totalMaterials, materialHit: m.materialHit, materialMiss: m.materialMiss, materialCreateMs: m.materialCreateMs,
      textureCount: m.totalTextures, textureRequested: m.textureRequested, textureCacheHit: m.textureCacheHit,
      texturesReady: m.texturesReady, texturesFailed: m.texturesFailed, texturesPending: m.texturesPending, textureBytesEstMB: m.textureBytesEstMB, failedTextures: m.failedTextures,
      bucketCount: buckets.size, liveBuckets: live, instancedMeshCount: buckets.size, drawCallsVisible: visibleMeshes, instanceCount: instances,
      instancesPerHouse: houses.size ? +(instances / houses.size).toFixed(1) : 0,
      housesByLOD: inst, sectors: sectors.size,
      houseCreateMs: +stats.houseCreateMs.toFixed(3), instanceWriteMs: +stats.instanceWriteMs.toFixed(3), instanceUpdateMs: +stats.instanceUpdateMs.toFixed(3),
      updateMs: +stats.updateMs.toFixed(3), lastPlaceMs: +stats.lastPlaceMs.toFixed(3),
    };
  }

  /** Consistency check (dev/test): every instance sits in its owner slot with the right matrix. Returns mismatch count. */
  function verify() {
    let bad = 0; const m = new THREE.Matrix4();
    houses.forEach((h) => {
      if (!h.placed) return;
      const body = _lodPartsFor(h.arch, h.lod), lot = h.yardDepth >= 0 ? _lotPartsFor(h.arch, h.yardDepth, h.lod, h.yardRear) : [];
      if (h.insts.length !== body.length + lot.length) bad++;
      h.insts.forEach((inst, i) => {
        if (inst.b.owners[inst.slot] !== inst || inst.slot >= inst.b.count || inst.house !== h) { bad++; return; }
        const isLot = i >= body.length, p = isLot ? lot[i - body.length] : body[i]; if (!p) return; const base = isLot ? h.lotMatrix : h.matrix; const exp = p.local ? m.multiplyMatrices(base, p.local) : base;
        const arr = inst.b.mesh.instanceMatrix.array;
        for (let k = 0; k < 16; k++) if (Math.abs(arr[inst.slot * 16 + k] - exp.elements[k]) > 1e-4) { bad++; break; }
      });
    });
    buckets.forEach((b) => { for (let i = 0; i < b.count; i++) { const o = b.owners[i]; if (!o || o.slot !== i || o.b !== b) bad++; } });
    return bad;
  }

  /** Renderer shutdown. Shared geometry / materials / textures are disposed ONLY when opts.disposeShared is true. */
  function dispose(opts = {}) {
    buckets.forEach((b) => { scene.remove(b.mesh); b.mesh.dispose(); });
    buckets.clear(); sectors.clear(); houses.clear(); houseList.length = 0; pending.length = 0; archUse.clear(); emptyBuckets = 0;
    if (opts.disposeShared) { disposeHouseSharedResources(); if (_skirtGeo) { _skirtGeo.dispose(); _skirtGeo = null; } }
  }

  const setForcedLod = (l) => { forcedLod = l; viewSig = ''; lodRemaining = houseList.length; };

  /** Dev benchmark: places N synthetic houses (all 11 sizes, both orientations), measures placement + LOD settle. */
  function benchmark(counts = [1, 2, 10, 100, 500, 1000], camera = lastCamera, keep = false) {
    const sizes = ['2x3', '3x3', '3x4', '3x5', '3x6', '4x4', '4x5', '4x6', '5x5', '5x6', '6x6'].flatMap((k) => { const [a, b] = k.split('x').map(Number); return a === b ? [[a, b]] : [[a, b], [b, a]]; });
    const rows = [];
    for (const n of counts) {
      const ids = []; const t0 = _now(); const w0 = { ...getStats() };
      for (let i = 0; i < n; i++) {
        const [w, d] = sizes[i % sizes.length], gx = i % 72, gz = Math.floor(i / 72);
        const id = `bench_${n}_${i}`; ids.push(id);
        addHouse({ id, archetype: { w, d, variantIndex: i % 10 }, position: { x: -180 + gx * 5, y: 0, z: -180 + gz * 8 }, rotationY: (i % 8) * 0.4, level: 1, seed: i, yardDepth: i % 4 === 3 ? 0 : Math.min(3, 6 - d), skirt: i % 9 === 0 ? { height: 0.6, retaining: false, width: w * 0.97, depth: d * 0.97, yaw: (i % 8) * 0.4 } : null }, { immediate: true });
      }
      const placeMs = _now() - t0;
      let updMs = 0; if (camera) { viewSig = ''; for (let f = 0; f < 200 && (f === 0 || lodRemaining > 0); f++) { const u0 = _now(); update(camera, { focus: { x: 0, z: 0 } }); updMs += _now() - u0; } }
      const s = getStats();
      rows.push({ houses: n, placementMs: +placeMs.toFixed(2), msPerHouse: +(placeMs / n).toFixed(4), lodSettleUpdateMs: +updMs.toFixed(2), newGeometries: s.geometryCount - w0.geometryCount, ...s });
      if (!keep) { ids.forEach(removeHouse); _prune(); }
    }
    return rows;
  }

  const api = { addHouse, addHouses, removeHouse, updateHouse, setLevel, hasHouse, flushPending, update, getStats, verify, dispose, benchmark, setForcedLod };
  if (typeof window !== 'undefined') {
    window.__HOUSE_RENDERER__ = api;
    window.__HOUSE_BENCH__ = (counts, keep) => { const r = benchmark(counts, lastCamera, keep); console.table(r); return r; };
  }
  return api;
}