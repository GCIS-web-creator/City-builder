// ============================================================================
// CommercialInstanceRenderer.jsx  (Prompt 43B)
// ----------------------------------------------------------------------------
// 低密度商業建物(com_low)専用の軽量レンダラ。HouseInstanceRenderer とは「別モジュール」（住宅側は無変更）。
// 設計は同じ: Building = 軽いデータrecord。描画 = 共有Geometry + 共有Material + InstancedMesh。
//   record : { id, archetype | {shopType,w,d,variantIndex}, shopType, position, rotationY, scale, level, seed,
//              lotWidth, lotDepth, skirt }
//   THREE.Group / Mesh は建物ごとに一切作らない。THREEオブジェクトは「bucket」単位のみ:
//     bucket key = sector | lod | geometryKey | materialKey   (多数の店舗 -> 1 InstancedMesh)
//   追加 / 削除 / LOD移動 / レベル変更 = instance slot の付け替え(swap-remove)のみ。geometry/material の生成・破棄なし
//   （Geometry は HousingPBR の共有キャッシュ、Material は共有PBR/Solid キャッシュ、駐車ライン等は archetype 単位の結合Geometry）。
//   Store / Workplace / Citizen シミュレーションには一切触れない（このレンダラは見た目だけ）。
// ============================================================================
import * as THREE from 'three';
import {
  getCommercialArchetype, getCommercialLodParts, getCommercialLotParts, getCommercialEmployeeCapacity,
  isCommercialSizeAvailable, getCommercialShopTypesForSize, COMMERCIAL_SIZES,
} from './CommercialPBR.jsx';
import { getSolidMaterial } from './HousingPBR.jsx';

// ---- tuning (same policy as HouseInstanceRenderer) ---------------------------------------------
const SECTOR_SIZE_BY_LOD = [48, 96, 192, 384, 96]; // index 4 = terrain skirts
const SECTOR_CULL_MARGIN = 26;
const ORTHO_T = [70, 140, 300];   // LOD thresholds on (view height + 0.5*dist-to-focus), metres
const PERSP_T = [45, 100, 200];   // LOD thresholds on camera distance, metres (driver / ped cams)
const EVAL_INTERVAL_MS = 66;      // ~15 Hz: sector culling + LOD sweep step
const LOD_EXAM_PER_FRAME = 800, LOD_MOVES_PER_FRAME = 64;
const LOD_EXAM_PER_STEP = 1600, LOD_MOVES_PER_STEP = 96;
const PENDING_PER_FRAME = 96, PENDING_BUDGET_MS = 5;
const INITIAL_CAPACITY = 16;

// Shadow policy: only near structural masses cast; small parts (glass, signs, lines, posts ...) never do.
const CAST = [
  { wall: 1, roof: 1, gableEnd: 1, parapet: 1, canopyRoof: 1, office: 1, walkRoof: 1, awning: 1, island: 0 },
  { wall: 1, roof: 1, gableEnd: 1, parapet: 1, canopyRoof: 1, office: 1 },
  { roof: 1, parapet: 1, wall: 1 },
  {},
];
const RECV = [
  { wall: 1, roof: 1, gableEnd: 1, parapet: 1, foundation: 1, canopyRoof: 1, office: 1, walkRoof: 1, lotPad: 1, asphalt: 1, planter: 1, entryApron: 1, curb: 1, island: 1 },
  { wall: 1, roof: 1, gableEnd: 1, parapet: 1, foundation: 1, lotPad: 1, asphalt: 1, canopyRoof: 1 },
  { wall: 1, roof: 1, parapet: 1, lotPad: 1, asphalt: 1 },
  { lotPad: 1 },
];

const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const _Y = new THREE.Vector3(0, 1, 0);
const _q = new THREE.Quaternion(), _p = new THREE.Vector3(), _s = new THREE.Vector3();
const _pv = new THREE.Matrix4(), _frustum = new THREE.Frustum(), _tm = new THREE.Matrix4();
const _noRaycast = () => {};
const _WHITE = [1, 1, 1];
let _skirtGeo = null;

function _rng(seed) {
  let a = (Math.imul((seed | 0) ^ 0x9e3779b9, 2654435761) >>> 0) || 1;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---- Prompt 43C: Level growth (visual) ---------------------------------------------------------------
// Level は「同じ shop レコードの見た目パラメータ」を切り替えるだけ（壊して作り直さない）:
//   * 本体(壁/屋根/看板など body parts)の縦スケール  LEVEL_BODY_HEIGHT[level-1]  ... 建物が一回り大きく見える
//   * Lv2: ロードサイド・パイロン看板  /  Lv3: 大型パイロン看板 + 街灯2本   ... 共有 BoxGeometry + 共有 solid material の追加インスタンスのみ
// 追加パーツは lot フレーム（ロット中心原点 / +Z=道路側 / lotWidth x lotDepth）の四隅付近にだけ置く（建物レイアウトに依存しない）。
// 低密度商業の敷地(lotWidth x lotDepth)は一切はみ出さない。LOD 0/1 のみ（遠景では描かない）。
const LEVEL_BODY_HEIGHT = [1, 1.16, 1.34];
let _extraBoxGeo = null;
const _extraCache = new Map(); // `${w}x${d}|${level}` -> parts[]  (Matrix4 は共有・不変)
function _extraPart(color, sx, sy, sz, x, y, z, part) {
  if (!_extraBoxGeo) _extraBoxGeo = new THREE.BoxGeometry(1, 1, 1);
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion(), new THREE.Vector3(sx, sy, sz));
  return { geoKey: 'com|extraBox', geometry: _extraBoxGeo, matKey: `solid:${color}`, material: getSolidMaterial(color, { roughness: 0.7, metalness: 0.1 }), part, local: m, tinted: false };
}
/** Lv2/Lv3 の追加パーツ（lot フレーム）。lod>=2 と Lv1 は空配列。 */
export function getLevelExtraParts(w, d, level, lod) {
  const lv = Math.min(Math.max(level | 0, 1), 3);
  if (lv < 2 || lod > 1) return _EMPTY;
  const key = `${w}x${d}|${lv}`;
  let parts = _extraCache.get(key);
  if (parts) return parts;
  parts = [];
  const hx = w / 2, hz = d / 2;
  const px = hx - 0.45, pz = hz - 0.45;               // 道路側の右コーナー
  if (lv === 2) {
    parts.push(_extraPart(0x555b60, 0.16, 2.6, 0.16, px, 1.3, pz, 'sign'));            // 支柱
    parts.push(_extraPart(0xf2c14e, 0.95, 0.7, 0.12, px, 2.85, pz, 'sign'));            // 看板パネル
  } else {
    parts.push(_extraPart(0x555b60, 0.2, 3.8, 0.2, px, 1.9, pz, 'sign'));
    parts.push(_extraPart(0xf2c14e, 1.45, 1.05, 0.14, px, 4.15, pz, 'sign'));
    parts.push(_extraPart(0xe8e4d8, 1.05, 0.28, 0.16, px, 3.5, pz, 'sign'));            // 価格/サブ看板
    for (const sx of [-1, 1]) {                                                          // 街灯 x2（道路側の両端）
      const lx = sx * (hx - 0.35), lz = hz - 0.9;
      parts.push(_extraPart(0x40454a, 0.1, 3.6, 0.1, lx, 1.8, lz, 'pole'));
      parts.push(_extraPart(0xfff2c8, 0.5, 0.12, 0.25, lx, 3.68, lz, 'pole'));
    }
  }
  _extraCache.set(key, parts);
  return parts;
}
const _EMPTY = Object.freeze([]);

export function createCommercialInstanceRenderer(scene) {
  const shops = new Map();
  const shopList = [];
  const buckets = new Map();
  const sectors = new Map();
  const archUse = new Map();
  const pending = [];
  const stats = { updateMs: 0, placeMs: 0, addCalls: 0, instanceWriteMs: 0 };
  let ctx = null, viewSig = '', lodCursor = 0, lodRemaining = 0, lastCamera = null, emptyBuckets = 0, forcedLod = null;
  const _lastVP = new Array(16).fill(0);
  let _haveVP = false, _evalCam = null, _lastViewH = NaN, _lastEvalMs = -1e9, _evalDirty = true, _lodBurst = false;
  const perf = { calls: 0, evals: 0, cullRuns: 0, lodSteps: 0, lodExamined: 0, lodMoves: 0, cpuMs: 0 };

  // ---------- sectors / buckets ----------
  function _sector(x, z, lodIdx) {
    const size = SECTOR_SIZE_BY_LOD[lodIdx], sx = Math.floor(x / size), sz = Math.floor(z / size), key = `${lodIdx}:${sx}_${sz}`;
    let s = sectors.get(key);
    if (!s) {
      s = { key, box: new THREE.Box3(new THREE.Vector3(sx * size - SECTOR_CULL_MARGIN, -40, sz * size - SECTOR_CULL_MARGIN), new THREE.Vector3((sx + 1) * size + SECTOR_CULL_MARGIN, 90, (sz + 1) * size + SECTOR_CULL_MARGIN)), buckets: new Set(), visible: true };
      sectors.set(key, s);
    }
    return s;
  }
  function _makeMesh(b, cap) {
    const mesh = new THREE.InstancedMesh(b.geometry, b.material, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    if (b.tinted) { mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3).fill(1), 3); mesh.instanceColor.setUsage(THREE.DynamicDrawUsage); }
    mesh.count = b.count; mesh.frustumCulled = false; mesh.raycast = _noRaycast; // culling is per sector
    mesh.castShadow = b.cast; mesh.receiveShadow = b.recv;
    mesh.visible = b.count > 0 && b.sector.visible;
    mesh.name = `commercial|${b.key}`;
    return mesh;
  }
  function _bucket(sector, lodKey, geoKey, geometry, matKey, material, part, cast, recv, tinted) {
    const key = `${sector.key}|${lodKey}|${geoKey}|${matKey}${tinted ? '+t' : ''}`;
    let b = buckets.get(key); if (b) return b;
    b = { key, sector, geometry, material, part, tinted: !!tinted, cast: !!cast, recv: !!recv, count: 0, capacity: INITIAL_CAPACITY, owners: [], mesh: null };
    b.mesh = _makeMesh(b, b.capacity); emptyBuckets++; scene.add(b.mesh); sector.buckets.add(b); buckets.set(key, b);
    return b;
  }
  function _grow(b) {
    const old = b.mesh, cap = b.capacity * 2; b.capacity = cap;
    const mesh = _makeMesh(b, cap);
    mesh.instanceMatrix.array.set(old.instanceMatrix.array.subarray(0, b.count * 16));
    if (b.tinted) mesh.instanceColor.array.set(old.instanceColor.array.subarray(0, b.count * 3));
    scene.remove(old); old.dispose(); scene.add(mesh); b.mesh = mesh;
  }
  function _bucketAdd(b, shop, matrix, tint) {
    if (b.count === b.capacity) _grow(b);
    if (b.count === 0) emptyBuckets = Math.max(0, emptyBuckets - 1);
    const slot = b.count++, inst = { shop, b, slot };
    b.owners[slot] = inst;
    b.mesh.instanceMatrix.array.set(matrix.elements, slot * 16);
    if (b.tinted) b.mesh.instanceColor.array.set(tint, slot * 3);
    b.mesh.count = b.count; b.mesh.instanceMatrix.needsUpdate = true; if (b.tinted) b.mesh.instanceColor.needsUpdate = true;
    b.mesh.visible = b.sector.visible;
    return inst;
  }
  function _bucketRemove(inst) {
    const b = inst.b, slot = inst.slot, last = b.count - 1;
    if (slot !== last) {
      b.mesh.instanceMatrix.array.copyWithin(slot * 16, last * 16, last * 16 + 16);
      if (b.tinted) b.mesh.instanceColor.array.copyWithin(slot * 3, last * 3, last * 3 + 3);
      const moved = b.owners[last]; b.owners[slot] = moved; moved.slot = slot;
    }
    b.owners[last] = undefined; b.count = last; b.mesh.count = last;
    b.mesh.instanceMatrix.needsUpdate = true; if (b.tinted) b.mesh.instanceColor.needsUpdate = true;
    if (last === 0) { b.mesh.visible = false; emptyBuckets++; }
  }

  // ---------- per-shop attach / detach ----------
  function _compose(h) {
    _p.set(h.position.x, h.position.y, h.position.z);
    _q.setFromAxisAngle(_Y, h.rotationY);
    _s.set(h.scale, h.scale, h.scale);
    h.matrix.compose(_p, _q, _s); // アーキタイプは実寸座標(houseScale 1)なので縮小しない。+Z = 道路側
    _s.set(h.scale, h.scale * LEVEL_BODY_HEIGHT[Math.min(Math.max(h.level | 0, 1), 3) - 1], h.scale); // Prompt 43C: Level による本体の縦スケール（lot/駐車場は不変）
    h.bodyMatrix.compose(_p, _q, _s);
    _s.set(h.scale, h.scale, h.scale);
    if (h.skirt) {
      _q.setFromAxisAngle(_Y, h.skirt.yaw || 0); _p.set(h.position.x, h.position.y - h.skirt.height / 2 + 0.02, h.position.z); _s.set(h.skirt.width, h.skirt.height, h.skirt.depth);
      h.skirtMatrix.compose(_p, _q, _s);
    }
  }
  function _attachParts(h, lod) {
    const t0 = _now(), sector = _sector(h.position.x, h.position.z, lod);
    const add = (p, cast, recv, tint, base) => {
      const b = _bucket(sector, lod, p.geoKey, p.geometry, p.matKey, p.material, p.part, cast, recv, p.tinted);
      let c = _WHITE;
      if (p.tinted) { c = [1, 1, 1]; const col = p.color || _WHITE; c[0] = col[0] * tint[0]; c[1] = col[1] * tint[1]; c[2] = col[2] * tint[2]; }
      h.insts.push(_bucketAdd(b, h, p.local ? _tm.multiplyMatrices(base, p.local) : base, c));
    };
    for (const p of getCommercialLodParts(h.arch, lod)) add(p, CAST[lod][p.part], RECV[lod][p.part], h.tint, h.bodyMatrix);
    for (const p of getCommercialLotParts(h.arch, lod)) add(p, false, RECV[lod][p.part], _WHITE, h.matrix); // 駐車場/縁石/植栽: 影は投げない
    for (const p of getLevelExtraParts(h.lotW, h.lotD, h.level, lod)) add(p, false, false, _WHITE, h.matrix); // Prompt 43C: Lv2/3 看板・街灯
    h.lod = lod; stats.instanceWriteMs += _now() - t0;
  }
  function _detachParts(h) { for (let i = 0; i < h.insts.length; i++) _bucketRemove(h.insts[i]); h.insts.length = 0; }
  function _attachSkirt(h) {
    if (!h.skirt) return;
    if (!_skirtGeo) _skirtGeo = new THREE.BoxGeometry(1, 1, 1);
    const color = h.skirt.retaining ? 0x5b5750 : 0x8a8378;
    const b = _bucket(_sector(h.position.x, h.position.z, 4), 'S', 'com|skirt', _skirtGeo, `solid:${color}`, getSolidMaterial(color, { roughness: 0.95, metalness: 0 }), 'skirt', true, true, false);
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
    while (lod < 3 && m > T[lod] * 1.08) lod++;   // hysteresis
    while (lod > 0 && m < T[lod - 1] * 0.92) lod--;
    return lod;
  }
  function _place(h) { h.lod = ctx || forcedLod !== null ? _lodFor(h, ctx, 0) : 0; _attachParts(h, h.lod); _attachSkirt(h); h.placed = true; }

  // ---------- public API ----------
  function _buildRecord(rec, existing) {
    const a = rec.archetype || {};
    const arch = a.id ? a : getCommercialArchetype(a.shopType || rec.shopType, a.w ?? rec.lotWidth, a.d ?? rec.lotDepth, a.variantIndex || 0);
    if (!arch) throw new Error(`no commercial archetype for ${a.shopType || rec.shopType} ${a.w ?? rec.lotWidth}x${a.d ?? rec.lotDepth}`);
    const rnd = _rng(rec.seed == null ? 1 : rec.seed), v = 0.94 + rnd() * 0.08; // 微小な個体差(tint)のみ。geometryは不変
    const h = existing || { id: rec.id, insts: [], skirtInst: null, matrix: new THREE.Matrix4(), bodyMatrix: new THREE.Matrix4(), skirtMatrix: new THREE.Matrix4(), placed: false, lod: 0, listIndex: -1 };
    h.arch = arch; h.shopType = arch.shopType; h.level = rec.level ?? 1; h.seed = rec.seed ?? 0;
    h.position = { x: rec.position.x, y: rec.position.y, z: rec.position.z };
    h.rotationY = rec.rotationY || 0; h.scale = rec.scale || 1;
    h.tint = [v, v, v]; h.skirt = rec.skirt ? { ...rec.skirt } : null;
    h.lotW = rec.lotWidth ?? a.w ?? arch.w ?? 4; h.lotD = rec.lotDepth ?? a.d ?? arch.d ?? 4; // Prompt 43C: level extras need the lot size
    _compose(h); return h;
  }
  function _unregister(h) {
    shops.delete(h.id);
    if (h.listIndex >= 0) { const last = shopList.pop(); if (last !== h) { shopList[h.listIndex] = last; last.listIndex = h.listIndex; } }
    const n = (archUse.get(h.arch.id) || 1) - 1; if (n <= 0) archUse.delete(h.arch.id); else archUse.set(h.arch.id, n);
  }
  function addShop(rec, opts = {}) {
    if (shops.has(rec.id)) return updateShop(rec);
    const t0 = _now(), h = _buildRecord(rec, null);
    shops.set(h.id, h); h.listIndex = shopList.push(h) - 1; archUse.set(h.arch.id, (archUse.get(h.arch.id) || 0) + 1); _evalDirty = true;
    if (opts.immediate === false) pending.push(h);
    else { try { _place(h); } catch (err) { _detachParts(h); _detachSkirt(h); _unregister(h); throw err; } }
    stats.placeMs = _now() - t0; stats.addCalls++;
    return h.id;
  }
  const addShops = (recs) => recs.map((r) => addShop(r, { immediate: false }));
  function removeShop(id) {
    const h = shops.get(id); if (!h) return false;
    if (h.placed) { _detachParts(h); _detachSkirt(h); } else { const i = pending.indexOf(h); if (i >= 0) pending.splice(i, 1); }
    _unregister(h); _evalDirty = true; return true;
  }
  function updateShop(rec) {
    const h = shops.get(rec.id); if (!h) return addShop(rec);
    const prev = h.arch.id, was = h.placed; _evalDirty = true;
    if (was) { _detachParts(h); _detachSkirt(h); }
    _buildRecord(rec, h);
    if (h.arch.id !== prev) { const n = (archUse.get(prev) || 1) - 1; if (n <= 0) archUse.delete(prev); else archUse.set(prev, n); archUse.set(h.arch.id, (archUse.get(h.arch.id) || 0) + 1); }
    if (was) _place(h);
    return h.id;
  }
  /** Prompt 43C: Level 変更 = 同じ record の instance slot 付け替えのみ（geometry/material 生成なし・建て直し禁止）。変化したら true。 */
  function setLevel(id, level) {
    const h = shops.get(id); if (!h) return false;
    const lv = Math.min(Math.max(level | 0, 1), 5);
    if (h.level === lv) return false;
    h.level = lv; _compose(h); _evalDirty = true;
    if (h.placed) { const lod = h.lod; _detachParts(h); _attachParts(h, lod); }
    return true;
  }
  const hasShop = (id) => shops.has(id);
  const getEmployeeCapacity = (id) => { const h = shops.get(id); return h ? getCommercialEmployeeCapacity(h.arch, h.level) : 0; };

  function flushPending(budgetMs = PENDING_BUDGET_MS) {
    const t0 = _now(); let n = 0;
    while (pending.length && n < PENDING_PER_FRAME && _now() - t0 < budgetMs) { _place(pending.shift()); n++; }
    if (n) _evalDirty = true; return n;
  }
  function _makeCtx(camera, opts) {
    const f = opts.focus || { x: 0, z: 0 };
    if (camera.isOrthographicCamera) return { ortho: true, viewH: (camera.top - camera.bottom) / (camera.zoom || 1), fx: f.x, fz: f.z };
    return { ortho: false, cx: camera.position.x, cy: camera.position.y, cz: camera.position.z };
  }
  function _lodStep(examCap, moveCap) {
    const exam = Math.min(examCap, lodRemaining); let done = 0, moves = 0;
    while (done < exam && moves < moveCap) {
      if (lodCursor >= shopList.length) lodCursor = 0;
      const h = shopList[lodCursor++]; done++;
      if (!h.placed) continue;
      const nl = _lodFor(h, ctx, h.lod);
      if (nl !== h.lod) { _detachParts(h); _attachParts(h, nl); moves++; } // slot 付け替えのみ（geometry生成なし）
    }
    lodRemaining -= done; perf.lodSteps++; perf.lodExamined += done; perf.lodMoves += moves;
    if (lodRemaining <= 0) _lodBurst = false;
  }

  /** 毎フレーム呼ぶ。店舗が0件なら即return。カリング/LODは ~15Hz かつ視点変更時のみ（HouseInstanceRenderer 41A と同方針）。 */
  function update(camera, opts = {}) {
    if (!shops.size && !buckets.size) return;
    const t0 = _now(); perf.calls++; lastCamera = camera;
    if (pending.length) flushPending();
    const ortho = !!camera.isOrthographicCamera, viewH = ortho ? (camera.top - camera.bottom) / (camera.zoom || 1) : 0;
    const zoomChanged = ortho && Math.abs(viewH - _lastViewH) > 1e-4 * (viewH || 1);
    const immediate = opts.force === true || camera !== _evalCam || zoomChanged || !_haveVP;
    const due = immediate || (t0 - _lastEvalMs >= EVAL_INTERVAL_MS);
    if (due) {
      _lastEvalMs = t0; perf.evals++; if (immediate) _lodBurst = true;
      camera.updateMatrixWorld();
      _pv.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      const el = _pv.elements; let vpChanged = !_haveVP || immediate;
      if (!vpChanged) for (let i = 0; i < 16; i++) if (el[i] !== _lastVP[i]) { vpChanged = true; break; }
      if (vpChanged || _evalDirty) {
        for (let i = 0; i < 16; i++) _lastVP[i] = el[i];
        _haveVP = true; _evalCam = camera; _lastViewH = viewH; _evalDirty = false; perf.cullRuns++;
        ctx = _makeCtx(camera, opts);
        const sig = ctx.ortho ? `o|${Math.round(ctx.viewH * 4)}|${Math.round(ctx.fx / 6)}|${Math.round(ctx.fz / 6)}` : `p|${Math.round(ctx.cx / 3)}|${Math.round(ctx.cy / 3)}|${Math.round(ctx.cz / 3)}`;
        if (sig !== viewSig) { viewSig = sig; lodRemaining = shopList.length; }
        _frustum.setFromProjectionMatrix(_pv); // sector frustum culling（InstancedMesh.frustumCulled は off）
        sectors.forEach((s) => {
          const vis = _frustum.intersectsBox(s.box);
          if (vis !== s.visible) { s.visible = vis; s.buckets.forEach((b) => { b.mesh.visible = vis && b.count > 0; }); }
        });
      }
      if (lodRemaining > 0 && shopList.length) _lodStep(_lodBurst ? LOD_EXAM_PER_FRAME : LOD_EXAM_PER_STEP, _lodBurst ? LOD_MOVES_PER_FRAME : LOD_MOVES_PER_STEP);
      else _lodBurst = false;
    } else if (_lodBurst && lodRemaining > 0 && shopList.length) _lodStep(LOD_EXAM_PER_FRAME, LOD_MOVES_PER_FRAME);
    if (emptyBuckets > 48) _prune();
    stats.updateMs = _now() - t0; perf.cpuMs += stats.updateMs;
    if (typeof window !== 'undefined' && window.__commercialStats) window.__COMMERCIAL_RENDER_STATS__ = getStats();
  }
  function getPerf(reset = true) { const p = { ...perf }; if (reset) { perf.calls = perf.evals = perf.cullRuns = perf.lodSteps = perf.lodExamined = perf.lodMoves = 0; perf.cpuMs = 0; } return p; }
  function _prune() {
    buckets.forEach((b, k) => { if (b.count === 0) { scene.remove(b.mesh); b.mesh.dispose(); b.sector.buckets.delete(b); buckets.delete(k); } });
    emptyBuckets = 0;
  }
  function getStats() {
    const lodCount = [0, 0, 0, 0]; let visibleMeshes = 0, instances = 0, live = 0; const byPart = {};
    buckets.forEach((b) => { if (b.count > 0) { live++; if (b.mesh.visible) visibleMeshes++; instances += b.count; byPart[b.part] = (byPart[b.part] || 0) + b.count; } });
    shopList.forEach((h) => { if (h.placed) lodCount[h.lod]++; });
    let groups = 0; scene.traverse((o) => { if (o.isGroup && o.name && o.name.startsWith('commercial')) groups++; });
    return {
      shopCount: shops.size, pendingShops: pending.length, archetypeCount: archUse.size,
      bucketCount: buckets.size, liveBuckets: live, instancedMeshCount: buckets.size, drawCallsVisible: visibleMeshes, instanceCount: instances,
      instancesPerShop: shops.size ? +(instances / shops.size).toFixed(1) : 0, shopsByLOD: lodCount, sectors: sectors.size,
      instancesByPart: byPart, perShopGroups: groups, updateMs: +stats.updateMs.toFixed(3), lastPlaceMs: +stats.placeMs.toFixed(3), instanceWriteMs: +stats.instanceWriteMs.toFixed(3),
    };
  }
  /** dev/test: 全インスタンスが所有スロットと正しい行列を持つか。不一致数を返す。 */
  function verify() {
    let bad = 0; const m = new THREE.Matrix4();
    shops.forEach((h) => {
      if (!h.placed) return;
      const body = getCommercialLodParts(h.arch, h.lod), lot = getCommercialLotParts(h.arch, h.lod), extra = getLevelExtraParts(h.lotW, h.lotD, h.level, h.lod);
      if (h.insts.length !== body.length + lot.length + extra.length) bad++;
      h.insts.forEach((inst, i) => {
        if (inst.b.owners[inst.slot] !== inst || inst.slot >= inst.b.count || inst.shop !== h) { bad++; return; }
        const p = i < body.length ? body[i] : i < body.length + lot.length ? lot[i - body.length] : extra[i - body.length - lot.length]; if (!p) return;
        const base = i < body.length ? h.bodyMatrix : h.matrix;
        const exp = p.local ? m.multiplyMatrices(base, p.local) : base, arr = inst.b.mesh.instanceMatrix.array;
        for (let k = 0; k < 16; k++) if (Math.abs(arr[inst.slot * 16 + k] - exp.elements[k]) > 1e-4) { bad++; break; }
      });
    });
    buckets.forEach((b) => { for (let i = 0; i < b.count; i++) { const o = b.owners[i]; if (!o || o.slot !== i || o.b !== b) bad++; } });
    return bad;
  }
  function dispose() { // instance buffers のみ破棄。共有 geometry / material は HousingPBR のキャッシュ側が管理
    buckets.forEach((b) => { scene.remove(b.mesh); b.mesh.dispose(); });
    buckets.clear(); sectors.clear(); shops.clear(); shopList.length = 0; pending.length = 0; archUse.clear(); emptyBuckets = 0;
    if (_skirtGeo) { _skirtGeo.dispose(); _skirtGeo = null; }
    if (_extraBoxGeo) { _extraBoxGeo.dispose(); _extraBoxGeo = null; _extraCache.clear(); }
  }
  const setForcedLod = (l) => { forcedLod = l; viewSig = ''; lodRemaining = shopList.length; _lodBurst = true; _evalDirty = true; };

  /** dev benchmark: N 件の合成店舗(全サイズ x 全店舗種別)を置き、配置/LOD settle を計測。 */
  function benchmark(counts = [1, 10, 100, 500, 1000], camera = lastCamera, keep = false) {
    const combos = COMMERCIAL_SIZES.flatMap((k) => { const [w, d] = k.split('x').map(Number); return getCommercialShopTypesForSize(w, d).map((t) => [t, w, d]); });
    const rows = [];
    for (const n of counts) {
      const ids = [], t0 = _now();
      for (let i = 0; i < n; i++) {
        const [t, w, d] = combos[i % combos.length], gx = i % 60, gz = Math.floor(i / 60), id = `combench_${n}_${i}`; ids.push(id);
        addShop({ id, archetype: { shopType: t, w, d, variantIndex: i }, position: { x: -180 + gx * 7, y: 0, z: -180 + gz * 9 }, rotationY: (i % 4) * Math.PI / 2, level: 1 + (i % 5), seed: i }, { immediate: true });
      }
      const placeMs = _now() - t0; let updMs = 0;
      if (camera) { viewSig = ''; for (let f = 0; f < 200 && (f === 0 || lodRemaining > 0); f++) { const u0 = _now(); update(camera, { focus: { x: 0, z: 0 }, force: true }); updMs += _now() - u0; } }
      rows.push({ shops: n, placementMs: +placeMs.toFixed(2), msPerShop: +(placeMs / n).toFixed(4), lodSettleUpdateMs: +updMs.toFixed(2), ...getStats() });
      if (!keep) { ids.forEach(removeShop); _prune(); }
    }
    return rows;
  }

  const api = { addShop, addShops, removeShop, updateShop, setLevel, hasShop, getEmployeeCapacity, flushPending, update, getStats, getPerf, verify, dispose, benchmark, setForcedLod };
  if (typeof window !== 'undefined') {
    window.__COMMERCIAL_RENDERER__ = api;
    window.__COMMERCIAL_BENCH__ = (counts, keep) => { const r = benchmark(counts, lastCamera, keep); console.table(r); return r; };
  }
  return api;
}
export { isCommercialSizeAvailable };
