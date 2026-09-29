// ============================================================================
// CommercialPBR.jsx — 低密度商業区（com_low）建物アーキタイプ  (Prompt 43A)
// ----------------------------------------------------------------------------
// HousingPBR.jsx は一切変更せず、その共有PBRマテリアル/共有ジオメトリキャッシュを import して使う
// 独立モジュール。API・パーツ形式は res_mid / res_high と同じ kit-of-parts:
//   part = { part, geoKey, geometry, matKey, material, local(Matrix4), tinted, color? }
// ローカル座標: ロット中心が原点、+z = 道路側(前面)、-z = 奥、x = 道路と平行な幅方向。
// ロットサイズ (w = 道路側の幅セル数, d = 奥行セル数)。許可: 3x4 / 4x4 / 5x4 / 5x5 / 6x6 のみ。
// 建物パーツ(getCommercialLodParts) と 駐車場・縁石・植栽等(getCommercialLotParts) を分離。
// ============================================================================
import * as THREE from 'three';
import { getSharedPBRMaterial, getSharedLiteMaterial, getSolidMaterial, HOUSE_GEOMETRY_CACHE } from './HousingPBR.jsx';

// ---- constants / public tables ---------------------------------------------------------------
export const COMMERCIAL_SIZES = ['3x4', '4x4', '5x4', '5x5', '6x6'];
export const COMMERCIAL_SHOP_TYPES = ['gas_station', 'restaurant', 'bar_pub', 'boutique', 'supermarket_small', 'travel_agency', 'motel', 'small_hotel'];
export const COMMERCIAL_VARIANT_COUNTS = { restaurant: 8, bar_pub: 6, boutique: 6, supermarket_small: 6, travel_agency: 4, motel: 6, small_hotel: 6, gas_station: 6 };
export const COMMERCIAL_LAYOUT_VARIANTS = ['front_parking', 'side_parking', 'rear_parking', 'corner_parking', 'gas_station_forecourt', 'motel_row'];
export const COMMERCIAL_THEME_DEFAULTS = { gasStationAllowed: true }; // テーマ側が gasStationAllowed:false を渡せば gas_station は候補から外れる
export const COMMERCIAL_MAX_LEVEL = 5;

// 店舗タイプ x サイズ (w x d) の許可表。ガソリンスタンドは 5x4 / 5x5 / 6x6 のみ。
const SHOPS_BY_SIZE = {
  '3x4': ['boutique', 'travel_agency', 'bar_pub', 'restaurant'],
  '4x4': ['restaurant', 'bar_pub', 'boutique', 'travel_agency', 'supermarket_small'],
  '5x4': ['restaurant', 'bar_pub', 'boutique', 'supermarket_small', 'gas_station', 'motel'],
  '5x5': ['restaurant', 'bar_pub', 'supermarket_small', 'gas_station', 'motel', 'small_hotel'],
  '6x6': ['restaurant', 'supermarket_small', 'gas_station', 'motel', 'small_hotel'],
};
const SHOP_LABEL = { gas_station: 'ガソリンスタンド', restaurant: 'レストラン', bar_pub: 'バー・パブ', boutique: 'ブティック', supermarket_small: '小規模スーパー', travel_agency: '旅行代理店', motel: 'モーテル', small_hotel: '小規模ホテル' };
const SHOP_NAMES = {
  gas_station: ['FUELIA', 'ROADSTAR', 'GREENOIL', 'AUTOGO', 'PETROVA', 'NOVAFUEL'],
  restaurant: ['DINER 24', 'GRILLHOUSE', 'BISTRO ORA', 'RAMEN KAI', 'CAFE MIRO', 'PIZZA ROMA', 'SUSHI TEN', 'KITCHEN 8'],
  bar_pub: ['THE ANCHOR', 'RED LION', 'TAP ROOM', 'ALE HOUSE', 'NIGHT OWL', 'OLD BARREL'],
  boutique: ['MODA', 'LINEN & CO', 'ATELIER', 'STYLE ROW', 'VELVET', 'FRIDAY'],
  supermarket_small: ['FRESHMART', 'DAILY MARKET', 'GREENGROCER', 'MINIMART', 'SUNBASKET', 'VALUE FOODS'],
  travel_agency: ['TRAVELINE', 'SKYWAY TOURS', 'GLOBETROT', 'HORIZON'],
  motel: ['ROADSIDE INN', 'BLUE MOON', 'SLEEP EASY', 'PINE MOTEL', 'STAR LODGE', 'HIGHWAY REST'],
  small_hotel: ['HOTEL ARBOR', 'CITY STAY', 'GRAND VIEW', 'HOTEL SOLE', 'PLAZA INN', 'HOTEL LUNA'],
};
const SHOP_HEIGHT = { gas_station: 3.0, restaurant: 3.2, bar_pub: 3.0, boutique: 3.0, supermarket_small: 3.8, travel_agency: 3.0, motel: 2.9, small_hotel: 2.9 };
const FLOOR_H = 2.9;
const TYPE_STAFF_MUL = { gas_station: 0.8, restaurant: 1.0, bar_pub: 0.8, boutique: 0.7, supermarket_small: 1.2, travel_agency: 0.6, motel: 0.9, small_hotel: 1.2 };
const LEVEL_STAFF_MUL = [1, 1.6, 2.4, 3.2, 3.86]; // Lv1..Lv5: 最大サイズ(14人) x 3.86 ≒ 54人

const FLAT = { // LOD3 の単色近似（HousingPBR の FLAT_COLOR は非公開のため同値を持つ）
  paintedWhiteWood: 0xd9d6cc, weatheredWood: 0x8d8a84, darkWood: 0x5a4030, paintedBlueWood: 0x6f8aa0, rawWoodCedar: 0xa0703f,
  plasterWhite: 0xe2dfd6, plasterCream: 0xd9c9a6, plasterCreamWorn: 0xb9ae8f, plasterBlue: 0x7d93a8, concrete: 0x8f8d88, concreteRock: 0x85817a, brickRed: 0x8c4a3a,
  asphaltShingleBlack: 0x3a3836, asphaltShingleGray: 0x6d6f72, tileRoofBrown: 0x7a4a34, tileRoofRed: 0x9a4530, metalRoofDark: 0x4d5155, stoneDark: 0x4a4744, stoneRough: 0x7c766c,
};
const C = { asphalt: 0x4b4d52, pad: 0x8d9094, curb: 0xb9bbbd, line: 0xf2f2f2, grass: 0x5c8447, bush: 0x3e6b3c, trunk: 0x5a4030, crown: 0x466b33, door: 0x2f2f33, pole: 0x6b7178, white: 0xf4f0e6, island: 0xa3a6a9, cart: 0x9aa0a6 };

// ---- helpers -----------------------------------------------------------------------------------
const _lp = new THREE.Vector3(), _lq = new THREE.Quaternion(), _ls = new THREE.Vector3(), _lY = new THREE.Vector3(0, 1, 0);
const _local = (px, py, pz, sx = 1, sy = 1, sz = 1, yaw = 0) =>
  new THREE.Matrix4().compose(_lp.set(px, py, pz), yaw ? _lq.setFromAxisAngle(_lY, yaw) : _lq.identity(), _ls.set(sx, sy, sz));
const _q = (v) => Math.round(v * 1000) / 1000;
function _geo(key, build) { // 既存の共有ジオメトリキャッシュ(HOUSE_GEOMETRY_CACHE)にそのまま載せる
  const k = 'com|' + key; let g = HOUSE_GEOMETRY_CACHE.get(k);
  if (!g) { g = build(); HOUSE_GEOMETRY_CACHE.set(k, g); }
  return { key: k, geometry: g };
}
function _uv(g, rx, ry) { const uv = g.attributes.uv; if (uv) { for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rx, uv.getY(i) * ry); uv.needsUpdate = true; } return g; }
const G = {
  box: (ux = 1, uy = 1) => _geo(`box|${ux}|${uy}`, () => _uv(new THREE.BoxGeometry(1, 1, 1), ux, uy)),
  cyl: () => _geo('cyl', () => new THREE.CylinderGeometry(0.5, 0.5, 1, 10)),
  bush: () => _geo('bush', () => new THREE.IcosahedronGeometry(0.5, 1)),
  cone: () => _geo('cone', () => new THREE.ConeGeometry(0.5, 1, 8)),
  // 単位切妻: 棟はX方向(道路と平行)。x∈[-.5,.5], z∈[-.5,.5], 軒y=0 → 棟y=1。屋根面(屋根材)と妻壁(外壁材)を別ジオメトリに。
  gableSlopes: () => _geo('gableSlopes', () => {
    const P = [-.5, 0, .5, .5, 0, .5, .5, 1, 0, -.5, 1, 0, /*front*/ -.5, 1, 0, .5, 1, 0, .5, 0, -.5, -.5, 0, -.5];
    const N = [0, .707, .707, 0, .707, .707, 0, .707, .707, 0, .707, .707, 0, .707, -.707, 0, .707, -.707, 0, .707, -.707, 0, .707, -.707];
    const T = [0, 0, 3, 0, 3, 1.5, 0, 1.5, 0, 0, 3, 0, 3, 1.5, 0, 1.5];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(T, 2));
    g.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]); return g;
  }),
  gableEnds: () => _geo('gableEnds', () => {
    const P = [-.5, 0, .5, -.5, 0, -.5, -.5, 1, 0, .5, 0, -.5, .5, 0, .5, .5, 1, 0];
    const N = [-1, 0, 0, -1, 0, 0, -1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0];
    const T = [0, 0, 1, 0, .5, .5, 0, 0, 1, 0, .5, .5];
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(T, 2));
    g.setIndex([0, 1, 2, 3, 4, 5]); return g;
  }),
};
let _glass = null;
function _glassMat() { // ガラスは HousingPBR 側が非公開のため1つだけ共有生成（商業専用テクスチャは作らない）
  if (!_glass) { _glass = new THREE.MeshStandardMaterial({ color: 0x35506a, roughness: 0.12, metalness: 0, emissive: 0x0b1a28, emissiveIntensity: 0.7 }); _glass.name = 'commercial:glass'; }
  return _glass;
}
function _mat(ref, lod) { // ref: 文字列=PBRプリセット / 数値=単色 / 'glass'
  if (ref === 'glass') return { matKey: 'glass', material: _glassMat(), tinted: false };
  if (typeof ref === 'number') return { matKey: `solid:${ref}`, material: getSolidMaterial(ref, { roughness: 0.7, metalness: 0 }), tinted: false };
  if (lod >= 3) { const c = new THREE.Color(FLAT[ref] ?? 0xcccccc); return { matKey: 'flat:white', material: getSolidMaterial(0xffffff, { roughness: 0.9, metalness: 0 }), tinted: true, color: [c.r, c.g, c.b] }; }
  if (lod === 2) return { matKey: `lite:${ref}`, material: getSharedLiteMaterial(ref), tinted: true };
  return { matKey: `pbr:${ref}`, material: getSharedPBRMaterial(ref), tinted: true };
}
function _mulberry(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function _hash(s) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

// 駐車ライン等の「細い箱の集合」を1つの共有ジオメトリに結合（アーキタイプ単位で1回だけ生成、キャッシュ済み）。
function _mergedBoxesGeo(key, boxes) {
  return _geo(key, () => {
    const parts = boxes.map(([x0, x1, y0, y1, z0, z1]) => { const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0).toNonIndexed(); g.translate((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2); return g; });
    let total = 0; parts.forEach((g) => { total += g.attributes.position.count; });
    const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2); let o = 0;
    parts.forEach((g) => { pos.set(g.attributes.position.array, o * 3); nor.set(g.attributes.normal.array, o * 3); uv.set(g.attributes.uv.array, o * 2); o += g.attributes.position.count; g.dispose(); });
    const out = new THREE.BufferGeometry();
    out.setAttribute('position', new THREE.BufferAttribute(pos, 3)); out.setAttribute('normal', new THREE.BufferAttribute(nor, 3)); out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    out.computeBoundingSphere(); out.computeBoundingBox(); return out;
  });
}

// part collector: extents-based boxes (min/max) so layout code reads like a plan.
function _collector(lod) {
  const list = [];
  const push = (part, geo, ref, m, extra) => list.push({ part, geoKey: geo.key, geometry: geo.geometry, ...(_mat(ref, lod)), local: m, ...extra });
  return {
    list,
    box(part, ref, x0, x1, y0, y1, z0, z1, uv = [2, 2], extra) { if (x1 - x0 < 1e-4 || y1 - y0 < 1e-4 || z1 - z0 < 1e-4) return; push(part, G.box(uv[0], uv[1]), ref, _local((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, x1 - x0, y1 - y0, z1 - z0), extra); },
    merged(part, ref, key, boxes, extra) { if (boxes.length) push(part, _mergedBoxesGeo(key, boxes), ref, _local(0, 0, 0), extra); },
    cyl(part, ref, x, y0, y1, z, dia, extra) { push(part, G.cyl(), ref, _local(x, (y0 + y1) / 2, z, dia, y1 - y0, dia), extra); },
    bush(part, ref, x, y, z, s, extra) { push(part, G.bush(), ref, _local(x, y, z, s, s * 0.8, s), extra); },
    cone(part, ref, x, y0, y1, z, dia, extra) { push(part, G.cone(), ref, _local(x, (y0 + y1) / 2, z, dia, y1 - y0, dia), extra); },
    gable(refRoof, refWall, x0, x1, z0, z1, yBase, rise, ov = 0.25) { // 切妻 (棟=X方向)
      const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, w = x1 - x0 + ov * 2, d = z1 - z0 + ov * 2;
      push('roof', G.gableSlopes(), refRoof, _local(cx, yBase, cz, w, rise, d), { tinted: typeof refRoof === 'string' });
      push('gableEnd', G.gableEnds(), refWall, _local(cx, yBase, cz, w - ov * 2, rise * (1 - 0.0), d - ov * 2 + 0.02), { tinted: typeof refWall === 'string' });
    },
  };
}

// ---- variant tables (seed で切り替わる外観セット) ------------------------------------------------
// L=layout  F=外壁  R=屋根材  RT=屋根形状(flat/gable/lowGable)  B=ブランド色  S=看板種別  E=入口位置(l/c/r)
// W=窓(wide/grid/ribbon)  A=庇(awning)  M=左右反転  T=樹木
const V = {
  restaurant: [
    { L: 'front_parking', F: 'plasterCream', R: 'tileRoofRed', RT: 'gable', B: 0xd9a521, S: 'building', E: 'c', W: 'wide', A: 1, M: 0, T: 1 },
    { L: 'side_parking', F: 'brickRed', R: 'metalRoofDark', RT: 'flat', B: 0xc0392b, S: 'canopy', E: 'l', W: 'grid', A: 1, M: 0, T: 0 },
    { L: 'rear_parking', F: 'plasterWhite', R: 'asphaltShingleGray', RT: 'lowGable', B: 0x2e8b57, S: 'building', E: 'r', W: 'wide', A: 0, M: 1, T: 1 },
    { L: 'corner_parking', F: 'concrete', R: 'tileRoofBrown', RT: 'gable', B: 0xe67e22, S: 'building', E: 'c', W: 'ribbon', A: 1, M: 1, T: 1 },
    { L: 'front_parking', F: 'paintedWhiteWood', R: 'metalRoofDark', RT: 'gable', B: 0x1f6fb2, S: 'entrance', E: 'c', W: 'grid', A: 0, M: 0, T: 0 },
    { L: 'side_parking', F: 'plasterBlue', R: 'asphaltShingleBlack', RT: 'flat', B: 0xf1c40f, S: 'roadside', E: 'l', W: 'wide', A: 1, M: 1, T: 1 },
    { L: 'front_parking', F: 'brickRed', R: 'tileRoofRed', RT: 'lowGable', B: 0x8e44ad, S: 'building', E: 'r', W: 'ribbon', A: 1, M: 0, T: 0 },
    { L: 'corner_parking', F: 'rawWoodCedar', R: 'asphaltShingleGray', RT: 'gable', B: 0xc0392b, S: 'canopy', E: 'c', W: 'grid', A: 1, M: 0, T: 1 },
  ],
  bar_pub: [
    { L: 'front_parking', F: 'darkWood', R: 'asphaltShingleBlack', RT: 'gable', B: 0x1e6b3a, S: 'building', E: 'r', W: 'grid', A: 1, M: 0, T: 0 },
    { L: 'side_parking', F: 'brickRed', R: 'metalRoofDark', RT: 'flat', B: 0xb8862b, S: 'entrance', E: 'l', W: 'ribbon', A: 0, M: 1, T: 0 },
    { L: 'front_parking', F: 'concreteRock', R: 'asphaltShingleGray', RT: 'lowGable', B: 0x7a1f2b, S: 'building', E: 'c', W: 'grid', A: 1, M: 0, T: 1 },
    { L: 'rear_parking', F: 'stoneDark', R: 'tileRoofBrown', RT: 'gable', B: 0x2d5f8b, S: 'building', E: 'l', W: 'wide', A: 1, M: 1, T: 0 },
    { L: 'corner_parking', F: 'darkWood', R: 'metalRoofDark', RT: 'flat', B: 0xd35400, S: 'roadside', E: 'r', W: 'ribbon', A: 0, M: 0, T: 1 },
    { L: 'side_parking', F: 'brickRed', R: 'tileRoofRed', RT: 'gable', B: 0x16a085, S: 'canopy', E: 'c', W: 'grid', A: 1, M: 1, T: 0 },
  ],
  boutique: [
    { L: 'front_parking', F: 'plasterWhite', R: 'metalRoofDark', RT: 'flat', B: 0xd81b60, S: 'building', E: 'l', W: 'wide', A: 1, M: 0, T: 1 },
    { L: 'front_parking', F: 'plasterCream', R: 'tileRoofRed', RT: 'lowGable', B: 0x6a1b9a, S: 'building', E: 'r', W: 'wide', A: 1, M: 1, T: 0 },
    { L: 'side_parking', F: 'plasterBlue', R: 'asphaltShingleGray', RT: 'flat', B: 0xf39c12, S: 'entrance', E: 'c', W: 'wide', A: 0, M: 0, T: 1 },
    { L: 'rear_parking', F: 'concrete', R: 'metalRoofDark', RT: 'flat', B: 0x00897b, S: 'building', E: 'l', W: 'ribbon', A: 1, M: 1, T: 0 },
    { L: 'front_parking', F: 'paintedWhiteWood', R: 'asphaltShingleBlack', RT: 'gable', B: 0xc2185b, S: 'roadside', E: 'c', W: 'wide', A: 1, M: 0, T: 1 },
    { L: 'corner_parking', F: 'plasterCreamWorn', R: 'tileRoofBrown', RT: 'lowGable', B: 0x37474f, S: 'building', E: 'r', W: 'grid', A: 0, M: 1, T: 0 },
  ],
  supermarket_small: [
    { L: 'front_parking', F: 'plasterWhite', R: 'metalRoofDark', RT: 'flat', B: 0x2e9e44, S: 'building', E: 'c', W: 'wide', A: 1, M: 0, T: 0 },
    { L: 'side_parking', F: 'concrete', R: 'asphaltShingleGray', RT: 'flat', B: 0xe53935, S: 'roadside', E: 'l', W: 'wide', A: 1, M: 0, T: 1 },
    { L: 'front_parking', F: 'plasterBlue', R: 'metalRoofDark', RT: 'lowGable', B: 0xfbc02d, S: 'building', E: 'r', W: 'wide', A: 1, M: 1, T: 0 },
    { L: 'corner_parking', F: 'plasterCream', R: 'asphaltShingleBlack', RT: 'flat', B: 0x1e88e5, S: 'building', E: 'c', W: 'ribbon', A: 0, M: 1, T: 1 },
    { L: 'rear_parking', F: 'brickRed', R: 'metalRoofDark', RT: 'flat', B: 0x43a047, S: 'canopy', E: 'l', W: 'wide', A: 1, M: 0, T: 0 },
    { L: 'front_parking', F: 'concreteRock', R: 'tileRoofRed', RT: 'lowGable', B: 0xef6c00, S: 'building', E: 'r', W: 'wide', A: 1, M: 1, T: 1 },
  ],
  travel_agency: [
    { L: 'front_parking', F: 'plasterWhite', R: 'metalRoofDark', RT: 'flat', B: 0x0288d1, S: 'building', E: 'l', W: 'wide', A: 1, M: 0, T: 0 },
    { L: 'front_parking', F: 'plasterCream', R: 'tileRoofRed', RT: 'lowGable', B: 0xff7043, S: 'building', E: 'c', W: 'wide', A: 0, M: 1, T: 1 },
    { L: 'rear_parking', F: 'plasterBlue', R: 'asphaltShingleGray', RT: 'flat', B: 0x00acc1, S: 'entrance', E: 'r', W: 'grid', A: 1, M: 0, T: 0 },
    { L: 'side_parking', F: 'paintedWhiteWood', R: 'asphaltShingleBlack', RT: 'gable', B: 0x5e35b1, S: 'roadside', E: 'l', W: 'wide', A: 1, M: 1, T: 1 },
  ],
  motel: [
    { L: 'motel_row', F: 'plasterCream', R: 'asphaltShingleGray', RT: 'lowGable', B: 0xc62828, S: 'roadside', E: 'c', W: 'grid', A: 1, M: 0, T: 1 },
    { L: 'motel_row', F: 'brickRed', R: 'metalRoofDark', RT: 'flat', B: 0x1565c0, S: 'building', E: 'l', W: 'grid', A: 1, M: 1, T: 0 },
    { L: 'motel_row', F: 'plasterWhite', R: 'tileRoofBrown', RT: 'lowGable', B: 0xf9a825, S: 'roadside', E: 'r', W: 'grid', A: 0, M: 0, T: 1 },
    { L: 'motel_row', F: 'concrete', R: 'asphaltShingleBlack', RT: 'flat', B: 0x00796b, S: 'building', E: 'c', W: 'ribbon', A: 1, M: 1, T: 0 },
    { L: 'motel_row', F: 'plasterBlue', R: 'metalRoofDark', RT: 'lowGable', B: 0xad1457, S: 'roadside', E: 'l', W: 'grid', A: 1, M: 0, T: 0 },
    { L: 'motel_row', F: 'weatheredWood', R: 'tileRoofRed', RT: 'gable', B: 0x558b2f, S: 'building', E: 'r', W: 'grid', A: 0, M: 1, T: 1 },
  ],
  small_hotel: [
    { L: 'front_parking', F: 'plasterWhite', R: 'metalRoofDark', RT: 'flat', B: 0x8d6e63, S: 'building', E: 'c', W: 'grid', A: 1, M: 0, T: 1 },
    { L: 'side_parking', F: 'plasterCream', R: 'asphaltShingleGray', RT: 'flat', B: 0x3949ab, S: 'roadside', E: 'l', W: 'grid', A: 1, M: 1, T: 0 },
    { L: 'front_parking', F: 'brickRed', R: 'metalRoofDark', RT: 'flat', B: 0xb71c1c, S: 'building', E: 'r', W: 'grid', A: 1, M: 0, T: 0 },
    { L: 'corner_parking', F: 'concrete', R: 'asphaltShingleBlack', RT: 'flat', B: 0x00838f, S: 'building', E: 'c', W: 'ribbon', A: 0, M: 1, T: 1 },
    { L: 'rear_parking', F: 'plasterBlue', R: 'metalRoofDark', RT: 'flat', B: 0xef6c00, S: 'canopy', E: 'l', W: 'grid', A: 1, M: 0, T: 0 },
    { L: 'front_parking', F: 'plasterCreamWorn', R: 'tileRoofBrown', RT: 'lowGable', B: 0x6d4c41, S: 'roadside', E: 'c', W: 'grid', A: 1, M: 1, T: 1 },
  ],
  gas_station: [
    { L: 'gas_station_forecourt', F: 'plasterWhite', R: 'metalRoofDark', RT: 'flat', B: 0x1fa34a, S: 'canopy', E: 'c', W: 'wide', A: 1, M: 0, T: 1 },
    { L: 'gas_station_forecourt', F: 'concrete', R: 'asphaltShingleGray', RT: 'lowGable', B: 0xd32f2f, S: 'canopy', E: 'l', W: 'wide', A: 1, M: 1, T: 0 },
    { L: 'gas_station_forecourt', F: 'plasterBlue', R: 'metalRoofDark', RT: 'flat', B: 0x1565c0, S: 'roadside', E: 'r', W: 'wide', A: 0, M: 0, T: 1 },
    { L: 'gas_station_forecourt', F: 'plasterCream', R: 'tileRoofRed', RT: 'lowGable', B: 0xfbc02d, S: 'canopy', E: 'c', W: 'ribbon', A: 1, M: 1, T: 0 },
    { L: 'gas_station_forecourt', F: 'brickRed', R: 'asphaltShingleBlack', RT: 'flat', B: 0xef6c00, S: 'roadside', E: 'l', W: 'wide', A: 1, M: 0, T: 0 },
    { L: 'gas_station_forecourt', F: 'plasterWhite', R: 'asphaltShingleGray', RT: 'lowGable', B: 0x00897b, S: 'canopy', E: 'r', W: 'wide', A: 0, M: 1, T: 1 },
  ],
};

// ---- size / availability / capacity API --------------------------------------------------------
const _sizeKey = (w, d) => `${w}x${d}`;
export function isCommercialSizeAvailable(w, d) { return Object.prototype.hasOwnProperty.call(SHOPS_BY_SIZE, _sizeKey(w, d)); }
export function getCommercialShopTypesForSize(w, d, theme = COMMERCIAL_THEME_DEFAULTS) {
  return (SHOPS_BY_SIZE[_sizeKey(w, d)] || []).filter((t) => isCommercialShopTypeAllowed(t, theme));
}
export function isCommercialShopTypeAllowed(shopType, theme = COMMERCIAL_THEME_DEFAULTS) {
  if (shopType === 'gas_station' && theme && theme.gasStationAllowed === false) return false;
  return true;
}
/** zone growth などが「このサイズに何を建てるか」を seed で決めるための補助（gas_station は重み高め）。 */
export function pickCommercialShopType(w, d, seed = 0, theme = COMMERCIAL_THEME_DEFAULTS) {
  const list = getCommercialShopTypesForSize(w, d, theme); if (!list.length) return null;
  const weights = list.map((t) => (t === 'gas_station' ? 1.4 : t === 'small_hotel' || t === 'motel' ? 0.7 : 1));
  const total = weights.reduce((a, b) => a + b, 0); let r = _mulberry(_hash('pick|' + seed) ^ (w * 31 + d))() * total;
  for (let i = 0; i < list.length; i++) { r -= weights[i]; if (r <= 0) return list[i]; }
  return list[list.length - 1];
}
export function getCommercialVariantCount(shopType) { return COMMERCIAL_VARIANT_COUNTS[shopType] || 0; }
/** 従業員数。Lv1: 最小(3x4)≒3人〜最大(6x6)≒14人。Lv5(最大サイズ)≒54人。level は 1..COMMERCIAL_MAX_LEVEL にクランプ。 */
export function getCommercialEmployeeCapacity(arch, level = 1) {
  if (!arch) return 0;
  const area = arch.w * arch.d, lv = Math.max(1, Math.min(COMMERCIAL_MAX_LEVEL, Math.floor(level) || 1));
  const base = Math.max(3, Math.min(14, Math.round((3 + (area - 12) * (11 / 24)) * (TYPE_STAFF_MUL[arch.shopType] || 1))));
  return Math.max(1, Math.round(base * LEVEL_STAFF_MUL[lv - 1]));
}

// ---- planning (layout resolution in lot frame) --------------------------------------------------
function _plan(type, w, d, v, rng) {
  const xL = -w / 2, xR = w / 2, zR = -d / 2, zF = d / 2, mir = v.M ? -1 : 1;
  let layout = v.L;
  if (layout === 'side_parking' && w < 5) layout = 'front_parking';
  if (layout === 'corner_parking' && !(w >= 5 && d >= 5)) layout = 'front_parking';
  if (type === 'motel') layout = 'motel_row';
  if (type === 'gas_station') layout = 'gas_station_forecourt';
  const P = { layout, w, d, xL, xR, zR, zF, mir, park: [], plant: [], bld: null, driveX: 0, lane: null };
  const rs = (a, b) => a + (b - a) * rng();
  if (layout === 'front_parking') {
    const pd = d >= 6 ? 2.2 : d >= 5 ? 1.8 : 1.4;
    P.bld = { x0: xL + 0.15, x1: xR - 0.15, z0: zR + 0.3, z1: zF - pd };
    P.park.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zF - pd, z1: zF - 0.1, axis: 'x' });
    P.plant.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zR, z1: zR + 0.3 });
    P.driveX = mir * (w * 0.18);
  } else if (layout === 'side_parking') {
    const pw = w >= 6 ? 2.0 : 1.6;
    const bx0 = mir > 0 ? xL + 0.15 : xL + pw + 0.05, bx1 = mir > 0 ? xR - pw - 0.05 : xR - 0.15;
    P.bld = { x0: bx0, x1: bx1, z0: zR + 0.3, z1: zF - 0.5 };
    const px0 = mir > 0 ? xR - pw : xL, px1 = mir > 0 ? xR : xL + pw;
    P.park.push({ x0: px0 + 0.03, x1: px1 - 0.03, z0: zR + 0.3, z1: zF - 0.1, axis: 'z' });
    P.park.push({ x0: bx0, x1: bx1, z0: zF - 0.5, z1: zF - 0.1, axis: 'lane' });
    P.plant.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zR, z1: zR + 0.3 });
    P.driveX = mir > 0 ? xR - pw / 2 : xL + pw / 2;
  } else if (layout === 'rear_parking') {
    const bd = d >= 6 ? 2.6 : d >= 5 ? 2.2 : 1.9;
    P.bld = { x0: xL + 0.15, x1: xR - 0.15, z0: zF - 0.5 - bd, z1: zF - 0.5 };
    P.park.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zR + 0.15, z1: zF - 0.5 - bd - 0.05, axis: 'x' });
    P.park.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zF - 0.5, z1: zF - 0.1, axis: 'lane' });
    P.driveX = mir * (w * 0.3);
  } else if (layout === 'corner_parking') {
    const bw = w * 0.6, pd = d >= 6 ? 2.2 : 1.8;
    const bx0 = mir > 0 ? xL + 0.15 : xR - 0.15 - bw, bx1 = bx0 + bw;
    P.bld = { x0: bx0, x1: bx1, z0: zR + 0.3, z1: zF - pd };
    P.park.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zF - pd, z1: zF - 0.1, axis: 'x' });
    const sx0 = mir > 0 ? bx1 + 0.1 : xL + 0.05, sx1 = mir > 0 ? xR - 0.05 : bx0 - 0.1;
    if (sx1 - sx0 > 0.7) P.park.push({ x0: sx0, x1: sx1, z0: zR + 0.3, z1: zF - pd, axis: 'z' });
    P.plant.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zR, z1: zR + 0.3 });
    P.driveX = mir * (w * 0.2);
  } else if (layout === 'motel_row') {
    const bd = d >= 5 ? 1.9 : 1.6, walk = 0.6;
    P.bld = { x0: xL + 0.15, x1: xR - 0.15, z0: zR + 0.3, z1: zR + 0.3 + bd };
    P.walk = { z0: P.bld.z1, z1: P.bld.z1 + walk };
    P.park.push({ x0: xL + 0.05, x1: xR - 0.05, z0: P.bld.z1 + walk, z1: zF - 0.1, axis: 'x' });
    P.plant.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zR, z1: zR + 0.3 });
    P.driveX = mir * (w * 0.25);
  } else { // gas_station_forecourt
    const sw = Math.min(w - 0.4, w >= 6 ? 4.0 : 3.2), sd = d >= 5 ? 1.5 : 1.2;
    const off = (v.E === 'l' ? -1 : v.E === 'r' ? 1 : 0) * mir * Math.max(0, (w - sw) / 2 - 0.1);
    P.bld = { x0: off - sw / 2, x1: off + sw / 2, z0: zR + 0.25, z1: zR + 0.25 + sd };
    const cw = Math.min(w - 0.5, w >= 6 ? 4.4 : 3.4), cd = d >= 6 ? 2.0 : 1.7, cz = zF - 0.25 - cd / 2;
    P.canopy = { x0: -cw / 2, x1: cw / 2, z0: cz - cd / 2, z1: cz + cd / 2, h: 2.5 };
    P.pumps = w >= 6 && d >= 5 ? 4 : w >= 5 && d >= 5 ? 4 : 2;
    P.park.push({ x0: xL + 0.05, x1: xR - 0.05, z0: zR + 0.05, z1: zF - 0.1, axis: 'forecourt' });
    P.plant.push({ x0: xL + 0.05, x1: xL + 0.4, z0: P.bld.z1 + 0.1, z1: P.canopy.z0 - 0.1 }, { x0: xR - 0.4, x1: xR - 0.05, z0: P.bld.z1 + 0.1, z1: P.canopy.z0 - 0.1 });
    P.driveX = 0;
  }
  const b = P.bld; b.w = b.x1 - b.x0; b.d = b.z1 - b.z0;
  b.floors = type === 'small_hotel' ? (w >= 6 ? 3 : 2 + (v.M ? 1 : 0)) : 1;
  b.h = type === 'small_hotel' ? FLOOR_H * b.floors : (SHOP_HEIGHT[type] || 3);
  const doorSpan = Math.max(0, b.w / 2 - 0.55);
  b.doorX = (b.x0 + b.x1) / 2 + (v.E === 'l' ? -1 : v.E === 'r' ? 1 : 0) * doorSpan * (type === 'gas_station' ? 0 : 1);
  if (type === 'gas_station') b.doorX = (b.x0 + b.x1) / 2;
  // 駐車台数（ストール幅 1.1m 目安）
  let stalls = 0;
  for (const r of P.park) { if (r.axis === 'x') stalls += Math.max(0, Math.floor((r.x1 - r.x0 - 0.8) / 1.1)); else if (r.axis === 'z') stalls += Math.max(0, Math.floor((r.z1 - r.z0) / 1.1)); }
  if (layout === 'gas_station_forecourt') stalls = 2;
  P.stalls = stalls;
  return P;
}

// ---- archetype ---------------------------------------------------------------------------------
export const COMMERCIAL_ARCHETYPES = new Map();
export function getCommercialArchetype(shopType, w, d, variantIndex = 0) {
  if (!isCommercialSizeAvailable(w, d)) return null;
  if (!(SHOPS_BY_SIZE[_sizeKey(w, d)] || []).includes(shopType)) return null;
  const tbl = V[shopType]; if (!tbl) return null;
  const vi = ((Math.floor(variantIndex) % tbl.length) + tbl.length) % tbl.length;
  const id = `com_${shopType}_${w}x${d}_${String(vi + 1).padStart(2, '0')}`;
  if (COMMERCIAL_ARCHETYPES.has(id)) return COMMERCIAL_ARCHETYPES.get(id);
  const v = tbl[vi], seed = _hash(id), rng = _mulberry(seed);
  const plan = _plan(shopType, w, d, v, rng);
  const names = SHOP_NAMES[shopType];
  const brandIdx = vi % names.length;
  const signKind = v.S;
  const arch = {
    id, baseId: `com_${shopType}_${String(vi + 1).padStart(2, '0')}`, sizeClass: _sizeKey(w, d), w, d, kind: 'com_low',
    shopType, shopLabel: SHOP_LABEL[shopType], variantIndex: vi, seed, layoutVariant: plan.layout,
    floors: plan.bld.floors, height: plan.bld.h, roofType: v.RT,
    materialRefs: { facade: v.F, roof: v.R, foundation: 'stoneDark', accent: v.B },
    houseScale: { x: 1, y: 1, z: 1 }, // 実寸のパーツ座標（既定のHOUSE_SCALEは適用しない）
    gasStationAllowed: shopType === 'gas_station' ? true : undefined,
    parking: { stalls: plan.stalls, driveX: plan.driveX },
    // Business Name 接続用の看板データ（文字は後で差し替え可能）
    signs: [], nightLights: [],
    brandId: `${shopType}_${brandIdx}`, brandColor: v.B, signText: names[brandIdx], signKind,
    layout: plan, variant: v, _lodParts: [null, null, null, null], _lotParts: null,
  };
  _planSigns(arch);
  COMMERCIAL_ARCHETYPES.set(id, arch);
  return arch;
}
export const COMMERCIAL_ARCHETYPE_COUNT = Object.values(COMMERCIAL_VARIANT_COUNTS).reduce((a, b) => a + b, 0);

// 看板・夜間照明フック（データのみ。描画は _buildingParts / _lotParts が同じ座標で行う）
function _planSigns(arch) {
  const P = arch.layout, b = P.bld, v = arch.variant, T = arch.shopType;
  const mk = (kind, x, y, z, sw, sh, yaw = 0) => arch.signs.push({ signKind: kind, signText: arch.signText, brandColor: arch.brandColor, brandId: arch.brandId, pos: { x, y, z }, size: { w: sw, h: sh }, yaw });
  const kinds = [v.S];
  if ((T === 'gas_station' || T === 'motel' || T === 'small_hotel' || T === 'supermarket_small') && v.S !== 'roadside') kinds.push('roadside');
  for (const k of kinds) {
    if (k === 'building') mk('building', (b.x0 + b.x1) / 2, b.h - 0.45, b.z1 + 0.05, Math.min(b.w * 0.62, 2.4), 0.5);
    else if (k === 'entrance') mk('entrance', b.doorX + 0.45, b.h * 0.68, b.z1 + 0.3, 0.06, 0.5, Math.PI / 2);
    else if (k === 'canopy') {
      if (P.canopy) mk('canopy', 0, P.canopy.h - 0.1, P.canopy.z1 + 0.03, (P.canopy.x1 - P.canopy.x0) * 0.5, 0.26);
      else mk('canopy', b.doorX, b.h * 0.72 - 0.02, b.z1 + 0.58, Math.min(b.w * 0.5, 1.8), 0.24);
    } else if (k === 'roadside') mk('roadside', -P.driveX * 0.0 + (P.driveX >= 0 ? -1 : 1) * (P.w / 2 - 0.4), 1.7, P.zF - 0.3, 0.9, 0.5);
  }
  const lx = P.w / 2 - 0.25;
  arch.nightLights.push({ kind: 'pole', x: -lx, y: 2.4, z: P.zF - 0.5 }, { kind: 'pole', x: lx, y: 2.4, z: P.zF - 0.5 });
  arch.signs.forEach((s) => arch.nightLights.push({ kind: 'sign', x: s.pos.x, y: s.pos.y, z: s.pos.z }));
  if (P.canopy) arch.nightLights.push({ kind: 'canopy', x: 0, y: P.canopy.h - 0.2, z: (P.canopy.z0 + P.canopy.z1) / 2 });
}

// ---- building parts ----------------------------------------------------------------------------
function _signParts(c, arch, lod) {
  for (const s of arch.signs) {
    const { x, y, z } = s.pos, bc = s.brandColor;
    if (s.signKind === 'roadside') {
      c.cyl('signPole', C.pole, x, 0, y - 0.15, z, 0.09);
      c.box('signPanel', bc, x - s.size.w / 2, x + s.size.w / 2, y - s.size.h / 2, y + s.size.h / 2, z - 0.04, z + 0.04, [1, 1], { emissiveHook: 'sign' });
      if (lod === 0) c.box('signText', C.white, x - s.size.w * 0.4, x + s.size.w * 0.4, y - s.size.h * 0.3, y + s.size.h * 0.3, z + 0.04, z + 0.055, [1, 1], { emissiveHook: 'sign', signText: s.signText });
    } else if (s.signKind === 'entrance') {
      c.box('signBlade', bc, x - 0.03, x + 0.03, y - 0.25, y + 0.25, z - 0.25, z + 0.25, [1, 1], { emissiveHook: 'sign' });
    } else { // building / canopy
      c.box('signPanel', bc, x - s.size.w / 2, x + s.size.w / 2, y - s.size.h / 2, y + s.size.h / 2, z, z + 0.08, [1, 1], { emissiveHook: 'sign' });
      if (lod === 0) c.box('signText', C.white, x - s.size.w * 0.42, x + s.size.w * 0.42, y - s.size.h * 0.3, y + s.size.h * 0.3, z + 0.08, z + 0.095, [1, 1], { emissiveHook: 'sign', signText: s.signText });
    }
  }
}
function _roof(c, arch, b, yTop, lod) {
  const v = arch.variant, R = v.R;
  if (arch.roofType === 'flat' || arch.shopType === 'small_hotel' && arch.roofType !== 'lowGable') {
    c.box('parapet', R, b.x0 - 0.08, b.x1 + 0.08, yTop, yTop + 0.28, b.z0 - 0.08, b.z1 + 0.08, [2, 1]);
  } else {
    const rise = arch.roofType === 'gable' ? Math.min(1.1, b.d * 0.42) : Math.min(0.55, b.d * 0.24);
    c.gable(R, v.F, b.x0, b.x1, b.z0, b.z1, yTop, rise, arch.roofType === 'gable' ? 0.22 : 0.35);
  }
}
function _frontWindows(c, arch, b, lod, y0, y1, doorSkip = true) {
  const style = arch.variant.W, dw = 0.6;
  const segs = []; const dx0 = b.doorX - dw / 2 - 0.05, dx1 = b.doorX + dw / 2 + 0.05;
  const L0 = b.x0 + 0.2, R0 = b.x1 - 0.2;
  if (!doorSkip) segs.push([L0, R0]); else { if (dx0 - L0 > 0.5) segs.push([L0, dx0]); if (R0 - dx1 > 0.5) segs.push([dx1, R0]); }
  const z = b.z1;
  for (const [a, e] of segs) {
    if (style === 'grid' && lod === 0) {
      const n = Math.max(1, Math.floor((e - a) / 0.75)), pw = (e - a) / n;
      for (let i = 0; i < n; i++) c.box('window', 'glass', a + i * pw + 0.08, a + (i + 1) * pw - 0.08, y0, y1, z, z + 0.04, [1, 1]);
    } else if (style === 'ribbon') {
      c.box('window', 'glass', a, e, y0 + (y1 - y0) * 0.3, y1 - (y1 - y0) * 0.2, z, z + 0.04, [1, 1]);
    } else {
      c.box('window', 'glass', a, e, y0, y1, z, z + 0.04, [1, 1]);
      if (lod === 0 && e - a > 1.1) c.box('mullion', C.door, (a + e) / 2 - 0.02, (a + e) / 2 + 0.02, y0, y1, z + 0.03, z + 0.06, [1, 1]);
    }
  }
}
function _buildingParts(arch, lod) {
  const c = _collector(lod), P = arch.layout, b = P.bld, v = arch.variant, refs = arch.materialRefs, T = arch.shopType;
  const found = 0.15;
  if (lod === 3) { // 簡略: 壁+屋根の2ボックス（ガソスタは キャノピーも）
    c.box('wall', refs.facade, b.x0, b.x1, 0, b.h, b.z0, b.z1);
    c.box('roof', refs.roof, b.x0 - 0.1, b.x1 + 0.1, b.h, b.h + 0.3, b.z0 - 0.1, b.z1 + 0.1);
    if (P.canopy) c.box('canopy', arch.brandColor, P.canopy.x0, P.canopy.x1, P.canopy.h - 0.2, P.canopy.h, P.canopy.z0, P.canopy.z1, [1, 1]);
    return c.list;
  }
  c.box('foundation', refs.foundation, b.x0 - 0.04, b.x1 + 0.04, 0, found, b.z0 - 0.04, b.z1 + 0.04, [2, 1]);
  c.box('wall', refs.facade, b.x0, b.x1, found, b.h, b.z0, b.z1, [3, 1.5]);
  _roof(c, arch, b, b.h, lod);

  // --- 前面(店舗)開口 ---
  const wy0 = found + 0.35, wy1 = Math.min(b.h - 0.7, found + 2.3);
  if (T === 'small_hotel') {
    const cols = Math.max(2, Math.floor(b.w / 0.85)), pw = (b.w - 0.4) / cols;
    for (let f = 0; f < b.floors; f++) {
      const fy = found + FLOOR_H * f;
      if (lod >= 2) break;
      if (lod === 1) { c.box('window', 'glass', b.x0 + 0.2, b.x1 - 0.2, fy + 1.0, fy + 2.1, b.z1, b.z1 + 0.04, [1, 1]); continue; }
      for (let i = 0; i < cols; i++) {
        if (f === 0 && Math.abs(b.x0 + 0.2 + (i + 0.5) * pw - b.doorX) < 0.7) continue;
        const x = b.x0 + 0.2 + i * pw; c.box('window', 'glass', x + 0.1, x + pw - 0.1, fy + 0.9, fy + 2.1, b.z1, b.z1 + 0.04, [1, 1]);
        if (f > 0) c.box('balcony', C.pole, x + 0.05, x + pw - 0.05, fy + 0.02, fy + 0.12, b.z1, b.z1 + 0.35, [1, 1]);
      }
    }
    if (lod === 0) { // 屋上設備
      c.box('rooftopUnit', C.pole, b.x0 + 0.4, b.x0 + 1.2, b.h + 0.3, b.h + 0.9, b.z0 + 0.3, b.z0 + 0.9, [1, 1]);
      c.box('rooftopUnit', C.pole, b.x1 - 1.1, b.x1 - 0.5, b.h + 0.3, b.h + 0.75, b.z0 + 0.3, b.z0 + 0.8, [1, 1]);
    }
  } else if (T === 'motel') {
    const n = Math.max(3, Math.floor(b.w / 1.1)), rw = b.w / n, wk = P.walk;
    if (lod <= 1) {
      for (let i = 0; i < n; i++) {
        const x0 = b.x0 + i * rw;
        c.box('door', C.door, x0 + 0.12, x0 + 0.42, found, found + 1.9, b.z1, b.z1 + 0.04, [1, 1]);
        if (lod === 0 || i % 2 === 0) c.box('window', 'glass', x0 + 0.52, x0 + rw - 0.1, found + 0.8, found + 1.9, b.z1, b.z1 + 0.04, [1, 1]);
      }
    }
    // 外廊下の庇 + 柱
    c.box('walkRoof', refs.roof, b.x0 - 0.05, b.x1 + 0.05, b.h - 0.25, b.h - 0.12, b.z1, wk.z1 + 0.1, [2, 1]);
    if (lod === 0) for (let i = 0; i <= n; i += 1) c.cyl('post', C.pole, b.x0 + i * rw, 0, b.h - 0.25, wk.z1 - 0.05, 0.08);
    // 事務所エントランス（中央付近だけ突出）
    c.box('office', refs.facade, b.doorX - 0.7, b.doorX + 0.7, found, b.h + 0.2, wk.z0, wk.z1 + 0.15, [1, 1]);
    c.box('door', 'glass', b.doorX - 0.4, b.doorX + 0.4, found, found + 1.9, wk.z1 + 0.15, wk.z1 + 0.19, [1, 1]);
  } else {
    _frontWindows(c, arch, b, lod, wy0, wy1, true);
    c.box('door', C.door, b.doorX - 0.3, b.doorX + 0.3, found, found + 2.0, b.z1, b.z1 + 0.05, [1, 1]);
    if (lod === 0) { // 側面窓
      for (const sx of [b.x0, b.x1]) { const s = sx === b.x0 ? -1 : 1; const zc = (b.z0 + b.z1) / 2; c.box('window', 'glass', sx + (s > 0 ? 0 : -0.04), sx + (s > 0 ? 0.04 : 0), wy0 + 0.3, wy1 - 0.2, zc - 0.4, zc + 0.4, [1, 1]); }
    }
    if (T === 'supermarket_small' && lod === 0) { // カート置き場（簡易）
      c.box('cartCorral', C.cart, b.doorX + 0.5, b.doorX + 1.1, 0, 0.7, b.z1 + 0.15, b.z1 + 0.45, [1, 1]);
    }
    if (T === 'bar_pub' && lod === 0) { // 小さな屋外スペース（テーブル2）
      const tx = b.doorX + (v.E === 'r' ? -1 : 1) * 0.9;
      for (const dz of [0.35, 0.8]) { c.cyl('tableTop', C.white, tx, 0.7, 0.74, b.z1 + dz, 0.4); c.cyl('tableLeg', C.pole, tx, 0, 0.7, b.z1 + dz, 0.05); }
    }
  }
  // --- 庇 / 入口キャノピー ---
  if (v.A && T !== 'motel' && T !== 'gas_station' && lod <= 1) {
    const aw = Math.min(b.w - 0.2, T === 'supermarket_small' ? b.w - 0.2 : 1.8), ax = T === 'supermarket_small' ? (b.x0 + b.x1) / 2 : b.doorX;
    const ax0 = Math.max(b.x0, ax - aw / 2), ax1 = Math.min(b.x1, ax + aw / 2);
    c.box('awning', v.B, ax0, ax1, found + 2.3, found + 2.42, b.z1, b.z1 + 0.55, [1, 1]);
    if (lod === 0) { c.cyl('awningPost', C.pole, ax0 + 0.05, 0, found + 2.3, b.z1 + 0.5, 0.07); c.cyl('awningPost', C.pole, ax1 - 0.05, 0, found + 2.3, b.z1 + 0.5, 0.07); }
  }
  // --- ガソリンスタンド キャノピー + 給油機 ---
  if (P.canopy) {
    const cp = P.canopy, cxm = (cp.x0 + cp.x1) / 2;
    c.box('canopyRoof', C.white, cp.x0, cp.x1, cp.h - 0.22, cp.h, cp.z0, cp.z1, [1, 1]);
    c.box('canopyBand', arch.brandColor, cp.x0 - 0.02, cp.x1 + 0.02, cp.h - 0.26, cp.h - 0.06, cp.z1, cp.z1 + 0.04, [1, 1], { emissiveHook: 'canopy' });
    c.box('canopyBand', arch.brandColor, cp.x0 - 0.02, cp.x1 + 0.02, cp.h - 0.26, cp.h - 0.06, cp.z0 - 0.04, cp.z0, [1, 1], { emissiveHook: 'canopy' });
    if (lod <= 1) {
      const px = [cp.x0 + 0.15, cp.x1 - 0.15];
      for (const x of px) for (const z of [cp.z0 + 0.15, cp.z1 - 0.15]) c.cyl('canopyPost', C.pole, x, 0, cp.h - 0.22, z, 0.12);
    }
    if (lod === 0) {
      const zc = (cp.z0 + cp.z1) / 2, isl = P.pumps >= 4 ? [-0.22, 0.22] : [0];
      for (const f of isl) {
        const ix = cxm + f * (cp.x1 - cp.x0);
        c.box('island', C.island, ix - 0.14, ix + 0.14, 0, 0.14, cp.z0 + 0.2, cp.z1 - 0.2, [1, 1]);
        for (const dz of [-0.28, 0.28]) {
          c.box('pump', arch.brandColor, ix - 0.11, ix + 0.11, 0.14, 1.25, zc + dz - 0.09, zc + dz + 0.09, [1, 1]);
          c.box('pumpScreen', 'glass', ix - 0.07, ix + 0.07, 0.85, 1.1, zc + dz + (dz > 0 ? 0.09 : -0.09) * 1, zc + dz + (dz > 0 ? 0.1 : -0.1), [1, 1]);
        }
      }
    }
  }
  _signParts(c, arch, lod);
  return c.list;
}

// ---- lot dressing (parking / curb / planters / lights / trees) -----------------------------------
function _lotParts(arch, lod) {
  const c = _collector(lod), P = arch.layout, v = arch.variant, rng = _mulberry(arch.seed ^ 0x9e3779b1);
  const { xL, xR, zR, zF } = P;
  c.box('lotPad', C.pad, xL, xR, -0.04, 0.02, zR, zF, [1, 1]); // 全ロットの舗装ベース（LOD全て）
  for (const r of P.park) c.box('asphalt', C.asphalt, r.x0, r.x1, 0.02, 0.05, r.z0, r.z1, [1, 1]);
  if (lod >= 2) return c.list;
  // 駐車ライン: 個別Meshにせず、アーキタイプ単位の結合ジオメトリ1つ（parkingLine）にまとめる
  const lines = [];
  for (const r of P.park) {
    if (r.axis === 'x') { const n = Math.max(0, Math.floor((r.x1 - r.x0 - 0.8) / 1.1)); const sx = (r.x0 + r.x1) / 2 - (n * 1.1) / 2; for (let i = 0; i <= n; i++) lines.push([sx + i * 1.1 - 0.015, sx + i * 1.1 + 0.015, 0.05, 0.056, r.z0 + 0.1, r.z1 - 0.05]); }
    else if (r.axis === 'z') { const n = Math.max(0, Math.floor((r.z1 - r.z0) / 1.1)); for (let i = 0; i <= n; i++) lines.push([r.x0 + 0.05, r.x1 - 0.05, 0.05, 0.056, r.z0 + i * 1.1 - 0.015, r.z0 + i * 1.1 + 0.015]); }
  }
  c.merged('parkingLine', C.line, `parkLines|${arch.id}`, lines);
  if (P.layout === 'gas_station_forecourt' && P.canopy) {
    const cp = P.canopy, lm = []; for (let i = 0; i < 3; i++) lm.push([cp.x0 - 0.3, cp.x0 - 0.27, 0.05, 0.056, cp.z0 + 0.1 + i * 0.5, cp.z0 + 0.35 + i * 0.5]);
    c.merged('laneMark', 0xf1c40f, `laneMark|${arch.id}`, lm);
  }
  // 前面の縁石（ドライブウェイ部分は開ける）
  const gap = Math.min(0.7, P.w * 0.2), gx = Math.max(xL + gap + 0.2, Math.min(xR - gap - 0.2, P.driveX));
  c.box('curb', C.curb, xL, gx - gap, 0, 0.14, zF - 0.1, zF, [1, 1]); c.box('curb', C.curb, gx + gap, xR, 0, 0.14, zF - 0.1, zF, [1, 1]);
  // 植栽帯
  for (const r of P.plant) {
    if (r.x1 - r.x0 < 0.1 || r.z1 - r.z0 < 0.1) continue;
    c.box('planter', C.grass, r.x0, r.x1, 0.02, 0.12, r.z0, r.z1, [1, 1]);
    if (lod === 0) { const n = Math.max(1, Math.floor((r.x1 - r.x0) / 0.8)); for (let i = 0; i < n; i++) c.bush('shrub', C.bush, r.x0 + (i + 0.5) * (r.x1 - r.x0) / n, 0.32, (r.z0 + r.z1) / 2, 0.3 + rng() * 0.12); }
  }
  if (lod === 1) return c.list;
  // --- LOD0 のみ: 街灯 / ボラード / 樹木 / 入口前スペース ---
  const lx = xR - 0.2, lz = zF - 0.55;
  for (const x of [-lx, lx]) { c.cyl('lightPole', C.pole, x, 0, 2.4, lz, 0.07); c.box('lightHead', C.white, x - 0.15, x + 0.15, 2.38, 2.46, lz - 0.05, lz + 0.05, [1, 1], { emissiveHook: 'light' }); }
  const b = P.bld;
  if (arch.shopType !== 'gas_station' && arch.shopType !== 'motel') {
    c.box('entryApron', C.curb, b.doorX - 0.6, b.doorX + 0.6, 0.02, 0.06, b.z1, Math.min(zF - 0.1, b.z1 + 0.9), [1, 1]);
    for (const dx of [-0.85, 0.85]) c.cyl('bollard', C.pole, b.doorX + dx, 0, 0.5, Math.min(zF - 0.15, b.z1 + 0.85), 0.09);
  }
  if (v.T) { // 樹木（奥の角）
    const tx = (P.mir > 0 ? xR - 0.3 : xL + 0.3), tz = zR + 0.15;
    if (!(b.x0 - 0.05 < tx && tx < b.x1 + 0.05 && b.z0 - 0.05 < tz && tz < b.z1 + 0.05) || true) { c.cyl('trunk', C.trunk, tx, 0, 0.9, tz, 0.1); c.cone('crown', C.crown, tx, 0.7, 2.3, tz, 0.9); }
  }
  return c.list;
}

// ---- public part getters ------------------------------------------------------------------------
/** 建物本体・屋根・窓・扉・庇/キャノピー・看板・給油機。LOD0=詳細 / LOD1=主要建物+主要看板 / LOD2=建物+屋根(liteマテリアル) / LOD3=簡略(単色2ボックス)。 */
export function getCommercialLodParts(arch, lod) {
  if (!arch) return [];
  const l = Math.max(0, Math.min(3, lod | 0));
  return arch._lodParts[l] || (arch._lodParts[l] = _buildingParts(arch, l));
}
/** 駐車場・ライン・縁石・植栽・街灯・ボラード・樹木（建物フットプリントの外側の舗装/装飾）。 */
export function getCommercialLotParts(arch, lod) {
  if (!arch) return [];
  if (!arch._lotParts) arch._lotParts = new Map();
  const l = Math.max(0, Math.min(3, lod | 0)), key = `com|${l}`;
  let v = arch._lotParts.get(key); if (!v) { v = _lotParts(arch, l); arch._lotParts.set(key, v); }
  return v;
}
export function prewarmCommercialArchetype(arch, lods = [0, 1, 2, 3]) { lods.forEach((l) => { getCommercialLodParts(arch, l); getCommercialLotParts(arch, l); }); return arch; }
