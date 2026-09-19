// ============================================================================
// HousingPBR.jsx
// 低密度住宅(res_low) 30種 ・ テラスハウス(res_terrace) 20種
// PBRマテリアル対応 住宅ジェネレーター
// ----------------------------------------------------------------------------
// 想定リポジトリ構成:
//   jsx/
//     HousingPBR.jsx        <- このファイル
//     Citybuilder_....jsx   <- メインファイル（ここから import して使用）
//   img/
//     Rock/     (foundation/ground系)
//     metal/    (roof/accent系)
//     Tile/     (roof/wall系)
//     asphalt/  (wall/concrete系 ※フォルダ名はasphaltだが中身は漆喰/コンクリート主体)
//     Planks/   (外壁木材/ポーチ床系)
//
// メインファイルからの利用例:
//   import { buildLowDensityHouseByIndex, buildTerraceHouseByIndex } from './HousingPBR.jsx';
//   const house = buildLowDensityHouseByIndex(seed % 30);
//   group.add(house);
//
// 既存コード（citybuilder_iso3d_3lane_highway_part5.jsx）への組み込みポイント:
//   - res_low: buildBuildingVariants() / instanceVariants() の代わりに
//     buildLowDensityHouseByIndex(variantIndex) を各ロットで呼び出す
//   - res_terrace: buildLotGroup() の res_terrace 分岐内で
//     buildTerraceHouseByIndex(unitIndex) を各ユニットに割り当てる
//   （本ファイルは既存の巨大ファイルを直接編集せず、独立モジュールとして
//    安全に import できる形にしてあります）
// ============================================================================

import * as THREE from 'three';

// ----------------------------------------------------------------------------
// 1. PBRテクスチャ対応表（4K-1.zip / 4K-2.zip / 4K-3.zip 実ファイル準拠）
// ----------------------------------------------------------------------------

const TEXTURE_BASE = 'img/';

// NOTE: 以下3件はダウンロード元でのファイル名ゆれ。中身を目視確認の上、
// 実ファイル名をリネームするか、このパスを実際のファイル名に合わせて調整してください。
//   - Planks: wood_Brown_large_diff/nor_gl だが arm だけ wood_Brown_brown_arm
//   - Planks: pillar_bamboo_wall_diff だが nor_gl/arm は bamboo_wall_*
//   - asphalt: blue_asphalt_plaster_wall_diff だが nor_gl/arm は blue_plaster_wall_*
//   - Rock: gravel_floor_02_diff だが nor_gl/arm は gravel_floor_*（_02なし）
const TEXTURE_FILES = {
  // ---- WOOD (外壁・木部) ----
  paintedWhiteWood: { diff: 'Planks/white_planks_clean_diff_4k.jpg', nor: 'Planks/white_planks_clean_nor_gl_4k.jpg', arm: 'Planks/white_planks_clean_arm_4k.jpg' },
  paintedCreamWood: { diff: 'Planks/Cream_oak_veneer_01_diff_4k.jpg', nor: 'Planks/Cream_oak_veneer_01_nor_gl_4k.jpg', arm: 'Planks/Cream_oak_veneer_01_arm_4k.jpg' },
  weatheredWood: { diff: 'Planks/wood_planks_grey_diff_4k.jpg', nor: 'Planks/wood_planks_grey_nor_gl_4k.jpg', arm: 'Planks/wood_planks_grey_arm_4k.jpg' },
  darkWood: { diff: 'Planks/wood_Brown_large_diff_4k.jpg', nor: 'Planks/wood_Brown_large_nor_gl_4k.jpg', arm: 'Planks/wood_Brown_brown_arm_4k.jpg' },
  paintedBlueWood: { diff: 'Planks/blue_painted_planks_diff_4k.jpg', nor: 'Planks/blue_painted_planks_nor_gl_4k.jpg', arm: 'Planks/blue_painted_planks_arm_4k.jpg' },
  rawWoodCedar: { diff: 'Planks/japanese_cedar_planks_diff_4k.jpg', nor: 'Planks/japanese_cedar_planks_nor_gl_4k.jpg', arm: 'Planks/japanese_cedar_planks_arm_4k.jpg' },
  rawWoodHinoki: { diff: 'Planks/hinoki_planks_diff_4k.jpg', nor: 'Planks/hinoki_planks_nor_gl_4k.jpg', arm: 'Planks/hinoki_planks_arm_4k.jpg' },
  deckWood: { diff: 'Planks/wood_floor_deck_diff_4k.jpg', nor: 'Planks/wood_floor_deck_nor_gl_4k.jpg', arm: 'Planks/wood_floor_deck_arm_4k.jpg' },
  fenceBamboo: { diff: 'Planks/pillar_bamboo_wall_diff_4k.jpg', nor: 'Planks/bamboo_wall_nor_gl_4k.jpg', arm: 'Planks/bamboo_wall_arm_4k.jpg' },

  // ---- WALL (漆喰・コンクリート・レンガ) ----
  plasterWhite: { diff: 'asphalt/white_stucco_diff_4k.jpg', nor: 'asphalt/white_stucco_nor_gl_4k.jpg', arm: 'asphalt/white_stucco_arm_4k.jpg' },
  plasterCreamWorn: { diff: 'asphalt/worn_mossy_plasterwall_diff_4k.jpg', nor: 'asphalt/worn_mossy_plasterwall_nor_gl_4k.jpg', arm: 'asphalt/worn_mossy_plasterwall_arm_4k.jpg' },
  plasterCream: { diff: 'asphalt/plastered_wall_05_diff_4k.jpg', nor: 'asphalt/plastered_wall_05_nor_gl_4k.jpg', arm: 'asphalt/plastered_wall_05_arm_4k.jpg' },
  plasterBlue: { diff: 'asphalt/blue_asphalt_plaster_wall_diff_4k.jpg', nor: 'asphalt/blue_plaster_wall_nor_gl_4k.jpg', arm: 'asphalt/blue_plaster_wall_arm_4k.jpg' },
  concrete: { diff: 'asphalt/cracked_concrete_diff_4k.jpg', nor: 'asphalt/cracked_concrete_nor_gl_4k.jpg', arm: 'asphalt/cracked_concrete_arm_4k.jpg' },
  concreteRock: { diff: 'asphalt/rock_embedded_concrete_diff_4k.jpg', nor: 'asphalt/rock_embedded_concrete_nor_gl_4k.jpg', arm: 'asphalt/rock_embedded_concrete_arm_4k.jpg' },
  brickRed: { diff: 'Tile/brick_pavement_04_diff_4k.jpg', nor: 'Tile/brick_pavement_04_nor_gl_4k.jpg', arm: 'Tile/brick_pavement_04_arm_4k.jpg' }, // 暫定素材（本来は舗装用）

  // ---- ROOF ----
  asphaltShingleBlack: { diff: 'Tile/roof_tiles_diff_4k.jpg', nor: 'Tile/roof_tiles_nor_gl_4k.jpg', arm: 'Tile/roof_tiles_arm_4k.jpg' },
  asphaltShingleGray: { diff: 'Tile/grey_roof_01_diff_4k.jpg', nor: 'Tile/grey_roof_01_nor_gl_4k.jpg', arm: 'Tile/grey_roof_01_arm_4k.jpg' },
  tileRoofBrown: { diff: 'Tile/clay_roof_tiles_diff_4k.jpg', nor: 'Tile/clay_roof_tiles_nor_gl_4k.jpg', arm: 'Tile/clay_roof_tiles_arm_4k.jpg' },
  tileRoofRed: { diff: 'Tile/clay_roof_tiles_02_diff_4k.jpg', nor: 'Tile/clay_roof_tiles_02_nor_gl_4k.jpg', arm: 'Tile/clay_roof_tiles_02_arm_4k.jpg' },
  metalRoofDark: { diff: 'metal/corrugated_iron_02_diff_4k.jpg', nor: 'metal/corrugated_iron_02_nor_gl_4k.jpg', arm: 'metal/corrugated_iron_02_arm_4k.jpg' },

  // ---- FOUNDATION / GROUND ----
  stoneRough: { diff: 'Rock/rock_face_03_diff_4k.jpg', nor: 'Rock/rock_face_03_nor_gl_4k.jpg', arm: 'Rock/rock_face_03_arm_4k.jpg' },
  stoneDark: { diff: 'Rock/dark_rock_diff_4k.jpg', nor: 'Rock/dark_rock_nor_gl_4k.jpg', arm: 'Rock/dark_rock_arm_4k.jpg' },
};

// ----------------------------------------------------------------------------
// 2. テクスチャ / マテリアル ローダー（キャッシュ付き）
// ----------------------------------------------------------------------------

const _textureLoader = new THREE.TextureLoader();
const _textureCache = new Map();
const _materialCache = new Map();

function _loadTex(relPath, { srgb = false, repeatX = 1, repeatY = 1 } = {}) {
  const key = `${relPath}|${repeatX}x${repeatY}|${srgb}`;
  if (_textureCache.has(key)) return _textureCache.get(key);
  const tex = _textureLoader.load(TEXTURE_BASE + relPath);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(repeatX, repeatY);
  tex.anisotropy = 8;
  if (srgb && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
  _textureCache.set(key, tex);
  return tex;
}

/**
 * PBRプリセット名から MeshStandardMaterial を生成（キャッシュ付き）。
 * arm テクスチャは R=AO, G=Roughness, B=Metalness のパック済み前提
 * （Poly Haven形式）。roughnessMap / metalnessMap に同一テクスチャを割り当てる。
 * ※ aoMap は Three.js 仕様上 uv2 が必要なため、標準BoxGeometryのみを使う
 *   本モジュールでは未使用（将来 geometry.setAttribute('uv2', ...) で有効化可）。
 */
function getPBRMaterial(presetKey, { repeatX = 1, repeatY = 1, tint = null, roughness = 1, metalness = 1 } = {}) {
  const files = TEXTURE_FILES[presetKey];
  if (!files) {
    console.warn(`[HousingPBR] unknown material preset: "${presetKey}" — falling back to solid color`);
    return getSolidMaterial(tint || 0xcccccc);
  }
  const key = `${presetKey}|${repeatX.toFixed(2)}x${repeatY.toFixed(2)}|${tint || ''}`;
  if (_materialCache.has(key)) return _materialCache.get(key);

  const map = _loadTex(files.diff, { srgb: true, repeatX, repeatY });
  const normalMap = _loadTex(files.nor, { repeatX, repeatY });
  const armMap = _loadTex(files.arm, { repeatX, repeatY });

  const mat = new THREE.MeshStandardMaterial({
    map,
    normalMap,
    roughnessMap: armMap,
    metalnessMap: armMap,
    roughness,
    metalness,
    color: tint ? new THREE.Color(tint) : 0xffffff,
  });
  _materialCache.set(key, mat);
  return mat;
}

function getSolidMaterial(hexColor, { roughness = 0.7, metalness = 0.0 } = {}) {
  const key = `solid|${hexColor}|${roughness}|${metalness}`;
  if (_materialCache.has(key)) return _materialCache.get(key);
  const mat = new THREE.MeshStandardMaterial({ color: hexColor, roughness, metalness });
  _materialCache.set(key, mat);
  return mat;
}

// ----------------------------------------------------------------------------
// 3. ジオメトリ・ヘルパー
// ----------------------------------------------------------------------------

/** 切妻屋根（三角プリズム / 棟はZ軸方向）。妻壁も含めた一体ソリッド形状。 */
function makeGableRoof({ width, depth, ridgeHeight, overhang = 0.4, material }) {
  const halfW = width / 2 + overhang;
  const extrudeDepth = depth + overhang * 2;
  const shape = new THREE.Shape();
  shape.moveTo(-halfW, 0);
  shape.lineTo(0, ridgeHeight);
  shape.lineTo(halfW, 0);
  shape.lineTo(-halfW, 0);
  const geo = new THREE.ExtrudeGeometry(shape, { depth: extrudeDepth, bevelEnabled: false, curveSegments: 1 });
  geo.translate(0, 0, -extrudeDepth / 2);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, material);
  mesh.castShadow = true;
  return mesh;
}

/** マンサード屋根（四角錐台。CylinderGeometryのradialSegments=4を45°回転して代用） */
function makeMansardRoof({ width, depth, height, material }) {
  const geo = new THREE.CylinderGeometry(width * 0.15, width * 0.62, height, 4, 1);
  geo.rotateY(Math.PI / 4);
  const mesh = new THREE.Mesh(geo, material);
  mesh.scale.z = depth / width;
  mesh.castShadow = true;
  return mesh;
}

// ----------------------------------------------------------------------------
// 4. 低密度住宅 30種 データ（res_low / クラフツマン系戸建て参照）
// ----------------------------------------------------------------------------

export const LOW_DENSITY_HOUSES = [
  { id: 'low_001', family: 'classic_white', widthCells: 4, depthCells: 5, facadeMaterial: 'paintedWhiteWood', roofMaterial: 'asphaltShingleBlack', trimColor: 0xf2ede2, foundationMaterial: 'stoneRough', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: true, seed: 1001 },
  { id: 'low_002', family: 'classic_white', widthCells: 4, depthCells: 4, facadeMaterial: 'paintedWhiteWood', roofMaterial: 'asphaltShingleGray', trimColor: 0xf2ede2, foundationMaterial: 'stoneRough', porch: { present: true, style: 'partial' }, chimney: true, dormer: false, seed: 1002 },
  { id: 'low_003', family: 'classic_white', widthCells: 3, depthCells: 4, facadeMaterial: 'paintedWhiteWood', roofMaterial: 'tileRoofBrown', trimColor: 0xe8dcc0, foundationMaterial: 'stoneDark', porch: { present: true, style: 'partial' }, chimney: false, dormer: false, seed: 1003 },
  { id: 'low_004', family: 'classic_white', widthCells: 5, depthCells: 5, facadeMaterial: 'paintedWhiteWood', roofMaterial: 'metalRoofDark', trimColor: 0xf2ede2, foundationMaterial: 'stoneRough', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: true, seed: 1004 },
  { id: 'low_005', family: 'classic_white', widthCells: 4, depthCells: 5, facadeMaterial: 'paintedWhiteWood', roofMaterial: 'asphaltShingleBlack', trimColor: 0x232323, foundationMaterial: 'concrete', porch: { present: true, style: 'partial' }, chimney: false, dormer: true, seed: 1005 },

  { id: 'low_006', family: 'weathered_gray', widthCells: 4, depthCells: 4, facadeMaterial: 'weatheredWood', roofMaterial: 'asphaltShingleGray', trimColor: 0xf2ede2, foundationMaterial: 'stoneDark', porch: { present: true, style: 'partial' }, chimney: true, dormer: false, seed: 1006 },
  { id: 'low_007', family: 'weathered_gray', widthCells: 4, depthCells: 5, facadeMaterial: 'weatheredWood', roofMaterial: 'tileRoofRed', trimColor: 0x2a2018, foundationMaterial: 'stoneRough', porch: { present: true, style: 'wraparound' }, chimney: false, dormer: true, seed: 1007 },
  { id: 'low_008', family: 'weathered_gray', widthCells: 3, depthCells: 4, facadeMaterial: 'weatheredWood', roofMaterial: 'metalRoofDark', trimColor: 0xf2ede2, foundationMaterial: 'concrete', porch: { present: false }, chimney: false, dormer: false, seed: 1008 },
  { id: 'low_009', family: 'weathered_gray', widthCells: 5, depthCells: 5, facadeMaterial: 'weatheredWood', roofMaterial: 'asphaltShingleBlack', trimColor: 0xe8dcc0, foundationMaterial: 'stoneDark', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: true, seed: 1009 },
  { id: 'low_010', family: 'weathered_gray', widthCells: 4, depthCells: 4, facadeMaterial: 'weatheredWood', roofMaterial: 'asphaltShingleGray', trimColor: 0x232323, foundationMaterial: 'stoneRough', porch: { present: true, style: 'partial' }, chimney: true, dormer: false, seed: 1010 },

  { id: 'low_011', family: 'earth_brown', widthCells: 4, depthCells: 5, facadeMaterial: 'darkWood', roofMaterial: 'tileRoofBrown', trimColor: 0xe8dcc0, foundationMaterial: 'stoneRough', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: false, seed: 1011 },
  { id: 'low_012', family: 'earth_brown', widthCells: 3, depthCells: 4, facadeMaterial: 'darkWood', roofMaterial: 'asphaltShingleBlack', trimColor: 0xf2ede2, foundationMaterial: 'stoneDark', porch: { present: true, style: 'partial' }, chimney: false, dormer: false, seed: 1012 },
  { id: 'low_013', family: 'earth_brown', widthCells: 4, depthCells: 4, facadeMaterial: 'darkWood', roofMaterial: 'metalRoofDark', trimColor: 0x2a2018, foundationMaterial: 'concrete', porch: { present: false }, chimney: true, dormer: false, seed: 1013 },
  { id: 'low_014', family: 'earth_brown', widthCells: 5, depthCells: 5, facadeMaterial: 'darkWood', roofMaterial: 'tileRoofRed', trimColor: 0xf2ede2, foundationMaterial: 'stoneRough', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: true, seed: 1014 },
  { id: 'low_015', family: 'earth_brown', widthCells: 4, depthCells: 5, facadeMaterial: 'darkWood', roofMaterial: 'asphaltShingleGray', trimColor: 0xe8dcc0, foundationMaterial: 'stoneDark', porch: { present: true, style: 'partial' }, chimney: true, dormer: false, seed: 1015 },

  { id: 'low_016', family: 'sage_blue', widthCells: 4, depthCells: 4, facadeMaterial: 'paintedBlueWood', roofMaterial: 'asphaltShingleBlack', trimColor: 0xf2ede2, foundationMaterial: 'stoneRough', porch: { present: true, style: 'partial' }, chimney: false, dormer: false, seed: 1016 },
  { id: 'low_017', family: 'sage_blue', widthCells: 4, depthCells: 5, facadeMaterial: 'paintedBlueWood', roofMaterial: 'asphaltShingleGray', trimColor: 0xf2ede2, foundationMaterial: 'stoneDark', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: true, seed: 1017 },
  { id: 'low_018', family: 'sage_blue', widthCells: 3, depthCells: 4, facadeMaterial: 'paintedBlueWood', roofMaterial: 'metalRoofDark', trimColor: 0x232323, foundationMaterial: 'concrete', porch: { present: false }, chimney: false, dormer: false, seed: 1018 },
  { id: 'low_019', family: 'sage_blue', widthCells: 5, depthCells: 5, facadeMaterial: 'paintedBlueWood', roofMaterial: 'tileRoofBrown', trimColor: 0xe8dcc0, foundationMaterial: 'stoneRough', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: false, seed: 1019 },
  { id: 'low_020', family: 'sage_blue', widthCells: 4, depthCells: 4, facadeMaterial: 'paintedBlueWood', roofMaterial: 'asphaltShingleBlack', trimColor: 0xf2ede2, foundationMaterial: 'stoneDark', porch: { present: true, style: 'partial' }, chimney: true, dormer: true, seed: 1020 },

  { id: 'low_021', family: 'cedar_lodge', widthCells: 4, depthCells: 5, facadeMaterial: 'rawWoodCedar', roofMaterial: 'metalRoofDark', trimColor: 0x2a2018, foundationMaterial: 'stoneDark', porch: { present: true, style: 'partial' }, chimney: false, dormer: false, seed: 1021 },
  { id: 'low_022', family: 'cedar_lodge', widthCells: 3, depthCells: 4, facadeMaterial: 'rawWoodHinoki', roofMaterial: 'asphaltShingleGray', trimColor: 0xf2ede2, foundationMaterial: 'concrete', porch: { present: false }, chimney: false, dormer: false, seed: 1022 },
  { id: 'low_023', family: 'cedar_lodge', widthCells: 4, depthCells: 4, facadeMaterial: 'rawWoodCedar', roofMaterial: 'tileRoofBrown', trimColor: 0x2a2018, foundationMaterial: 'stoneRough', porch: { present: true, style: 'partial' }, chimney: false, dormer: true, seed: 1023 },
  { id: 'low_024', family: 'cedar_lodge', widthCells: 5, depthCells: 5, facadeMaterial: 'rawWoodHinoki', roofMaterial: 'asphaltShingleBlack', trimColor: 0xe8dcc0, foundationMaterial: 'stoneDark', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: false, seed: 1024 },
  { id: 'low_025', family: 'cedar_lodge', widthCells: 4, depthCells: 5, facadeMaterial: 'rawWoodCedar', roofMaterial: 'metalRoofDark', trimColor: 0x232323, foundationMaterial: 'stoneRough', porch: { present: false }, chimney: false, dormer: false, seed: 1025 },

  { id: 'low_026', family: 'stucco', widthCells: 4, depthCells: 4, facadeMaterial: 'plasterWhite', roofMaterial: 'tileRoofRed', trimColor: 0x2a2018, foundationMaterial: 'stoneRough', porch: { present: true, style: 'partial' }, chimney: true, dormer: false, seed: 1026 },
  { id: 'low_027', family: 'stucco', widthCells: 4, depthCells: 5, facadeMaterial: 'plasterCreamWorn', roofMaterial: 'tileRoofBrown', trimColor: 0xf2ede2, foundationMaterial: 'concrete', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: true, seed: 1027 },
  { id: 'low_028', family: 'stucco', widthCells: 3, depthCells: 4, facadeMaterial: 'plasterCream', roofMaterial: 'asphaltShingleGray', trimColor: 0x2a2018, foundationMaterial: 'stoneDark', porch: { present: false }, chimney: false, dormer: false, seed: 1028 },
  { id: 'low_029', family: 'stucco', widthCells: 5, depthCells: 5, facadeMaterial: 'plasterWhite', roofMaterial: 'metalRoofDark', trimColor: 0xf2ede2, foundationMaterial: 'stoneRough', porch: { present: true, style: 'wraparound' }, chimney: true, dormer: true, seed: 1029 },
  { id: 'low_030', family: 'stucco', widthCells: 4, depthCells: 4, facadeMaterial: 'plasterCreamWorn', roofMaterial: 'tileRoofRed', trimColor: 0xe8dcc0, foundationMaterial: 'concrete', porch: { present: true, style: 'partial' }, chimney: false, dormer: false, seed: 1030 },
];

// ----------------------------------------------------------------------------
// 5. テラスハウス 20種 データ（res_terrace / 連棟住宅参照）
// ----------------------------------------------------------------------------

export const TERRACE_HOUSES = [
  { id: 'terrace_001', family: 'red_brick', floors: 3, facadeMaterial: 'brickRed', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleBlack', stoopSteps: 3, awning: 'green', accessories: ['airConditioner'], partyWall: 'both', seed: 2001 },
  { id: 'terrace_002', family: 'red_brick', floors: 4, facadeMaterial: 'brickRed', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleGray', stoopSteps: 4, awning: 'none', accessories: ['satelliteDish'], partyWall: 'both', seed: 2002 },
  { id: 'terrace_003', family: 'red_brick', floors: 3, facadeMaterial: 'brickRed', roofStyle: 'mansard', roofMaterial: 'tileRoofRed', stoopSteps: 3, awning: 'green', accessories: ['planterBox'], partyWall: 'end', seed: 2003 },
  { id: 'terrace_004', family: 'red_brick', floors: 4, facadeMaterial: 'brickRed', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleBlack', stoopSteps: 5, awning: 'navy', accessories: ['airConditioner', 'satelliteDish'], partyWall: 'both', seed: 2004 },
  { id: 'terrace_005', family: 'red_brick', floors: 3, facadeMaterial: 'brickRed', roofStyle: 'gable', roofMaterial: 'tileRoofBrown', stoopSteps: 3, awning: 'none', accessories: ['planterBox'], partyWall: 'end', seed: 2005 },

  { id: 'terrace_006', family: 'gray_stone', floors: 4, facadeMaterial: 'concrete', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleGray', stoopSteps: 4, awning: 'none', accessories: ['airConditioner'], partyWall: 'both', seed: 2006 },
  { id: 'terrace_007', family: 'gray_stone', floors: 3, facadeMaterial: 'concreteRock', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleBlack', stoopSteps: 3, awning: 'navy', accessories: ['satelliteDish'], partyWall: 'both', seed: 2007 },
  { id: 'terrace_008', family: 'gray_stone', floors: 4, facadeMaterial: 'concrete', roofStyle: 'mansard', roofMaterial: 'asphaltShingleGray', stoopSteps: 4, awning: 'none', accessories: ['solarPanel'], partyWall: 'end', seed: 2008 },
  { id: 'terrace_009', family: 'gray_stone', floors: 3, facadeMaterial: 'concreteRock', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleBlack', stoopSteps: 3, awning: 'green', accessories: ['planterBox', 'airConditioner'], partyWall: 'both', seed: 2009 },
  { id: 'terrace_010', family: 'gray_stone', floors: 4, facadeMaterial: 'concrete', roofStyle: 'gable', roofMaterial: 'tileRoofBrown', stoopSteps: 5, awning: 'none', accessories: ['satelliteDish'], partyWall: 'both', seed: 2010 },

  { id: 'terrace_011', family: 'cream_stucco', floors: 3, facadeMaterial: 'plasterWhite', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleGray', stoopSteps: 3, awning: 'green', accessories: ['planterBox'], partyWall: 'end', seed: 2011 },
  { id: 'terrace_012', family: 'cream_stucco', floors: 4, facadeMaterial: 'plasterCream', roofStyle: 'mansard', roofMaterial: 'tileRoofBrown', stoopSteps: 4, awning: 'navy', accessories: ['airConditioner'], partyWall: 'both', seed: 2012 },
  { id: 'terrace_013', family: 'cream_stucco', floors: 3, facadeMaterial: 'plasterCreamWorn', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleBlack', stoopSteps: 3, awning: 'none', accessories: ['satelliteDish', 'planterBox'], partyWall: 'both', seed: 2013 },
  { id: 'terrace_014', family: 'cream_stucco', floors: 4, facadeMaterial: 'plasterWhite', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleGray', stoopSteps: 5, awning: 'green', accessories: ['solarPanel'], partyWall: 'end', seed: 2014 },
  { id: 'terrace_015', family: 'cream_stucco', floors: 3, facadeMaterial: 'plasterCream', roofStyle: 'gable', roofMaterial: 'tileRoofRed', stoopSteps: 3, awning: 'none', accessories: ['airConditioner'], partyWall: 'both', seed: 2015 },

  { id: 'terrace_016', family: 'dark_brown', floors: 4, facadeMaterial: 'darkWood', accentMaterial: 'plasterCreamWorn', roofStyle: 'flatParapet', roofMaterial: 'metalRoofDark', stoopSteps: 4, awning: 'none', accessories: ['airConditioner', 'satelliteDish'], partyWall: 'both', seed: 2016 },
  { id: 'terrace_017', family: 'dark_brown', floors: 3, facadeMaterial: 'darkWood', accentMaterial: 'plasterWhite', roofStyle: 'mansard', roofMaterial: 'tileRoofBrown', stoopSteps: 3, awning: 'navy', accessories: ['planterBox'], partyWall: 'end', seed: 2017 },
  { id: 'terrace_018', family: 'dark_brown', floors: 4, facadeMaterial: 'darkWood', accentMaterial: 'concrete', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleBlack', stoopSteps: 5, awning: 'green', accessories: ['solarPanel', 'airConditioner'], partyWall: 'both', seed: 2018 },
  { id: 'terrace_019', family: 'dark_brown', floors: 3, facadeMaterial: 'darkWood', accentMaterial: 'brickRed', roofStyle: 'gable', roofMaterial: 'tileRoofRed', stoopSteps: 3, awning: 'none', accessories: ['satelliteDish'], partyWall: 'both', seed: 2019 },
  { id: 'terrace_020', family: 'dark_brown', floors: 4, facadeMaterial: 'darkWood', accentMaterial: 'plasterCream', roofStyle: 'flatParapet', roofMaterial: 'asphaltShingleGray', stoopSteps: 4, awning: 'navy', accessories: ['planterBox', 'satelliteDish'], partyWall: 'end', seed: 2020 },
];

// ----------------------------------------------------------------------------
// 6. 低密度住宅ビルダー
// ----------------------------------------------------------------------------

const CELL = 2.5; // 1ロットセル(m)。プロジェクト側の実際のグリッド単位に合わせて調整してください。
const WINDOW_GLASS = () => getSolidMaterial(0x1c2733, { roughness: 0.15, metalness: 0.1 });

export function buildLowDensityHouse(config) {
  const group = new THREE.Group();
  group.name = config.id;

  const width = config.widthCells * CELL * 0.9;
  const depth = config.depthCells * CELL * 0.9;
  const floorHeight = 3.0;
  const wallHeight = floorHeight * (config.floors || 1);
  const ridgeHeight = wallHeight * 0.55;
  const baseY = 0.4; // 基礎の高さぶんの底上げ

  const facadeMat = getPBRMaterial(config.facadeMaterial, { repeatX: width / 2, repeatY: wallHeight / 2 });
  const roofMat = getPBRMaterial(config.roofMaterial, { repeatX: width / 3, repeatY: depth / 3 });
  const foundationMat = getPBRMaterial(config.foundationMaterial, { repeatX: width / 2, repeatY: 0.5 });
  const trimMat = getSolidMaterial(config.trimColor);

  // 基礎
  const foundation = new THREE.Mesh(new THREE.BoxGeometry(width + 0.3, baseY, depth + 0.3), foundationMat);
  foundation.position.y = baseY / 2;
  group.add(foundation);

  // 壁本体
  const walls = new THREE.Mesh(new THREE.BoxGeometry(width, wallHeight, depth), facadeMat);
  walls.position.y = baseY + wallHeight / 2;
  walls.castShadow = walls.receiveShadow = true;
  group.add(walls);

  // 切妻屋根
  const roof = makeGableRoof({ width, depth, ridgeHeight, overhang: 0.5, material: roofMat });
  roof.position.y = baseY + wallHeight;
  group.add(roof);

  // 窓 x2（正面左右対称）+ 玄関
  const winY = baseY + wallHeight * 0.55;
  [-width * 0.28, width * 0.28].forEach((x) => {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(1.05, 1.25, 0.05), trimMat);
    frame.position.set(x, winY, depth / 2);
    group.add(frame);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.1, 0.08), WINDOW_GLASS());
    glass.position.set(x, winY, depth / 2 + 0.02);
    group.add(glass);
  });
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.9, 1.9, 0.08), getSolidMaterial(0x3a2a1c));
  door.position.set(0, baseY + 0.95, depth / 2 + 0.02);
  group.add(door);

  // 煙突
  if (config.chimney) {
    const chimneyMat = getPBRMaterial('brickRed', { repeatX: 0.5, repeatY: 1 });
    const chimneyH = wallHeight * 0.9 + ridgeHeight * 0.6;
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.7, chimneyH, 0.7), chimneyMat);
    chimney.position.set(width * 0.3, baseY + chimneyH / 2, -depth * 0.2);
    group.add(chimney);
  }

  // ドーマー
  if (config.dormer) {
    const dw = width * 0.28, dd = depth * 0.22, dh = 0.9;
    const dormerY = baseY + wallHeight + ridgeHeight * 0.35;
    const dormerWall = new THREE.Mesh(new THREE.BoxGeometry(dw, dh, dd), facadeMat);
    dormerWall.position.set(0, dormerY, depth * 0.18);
    group.add(dormerWall);
    const dormerRoof = makeGableRoof({ width: dw, depth: dd, ridgeHeight: dh * 0.6, overhang: 0.1, material: roofMat });
    dormerRoof.position.set(0, dormerY + dh / 2, depth * 0.18);
    group.add(dormerRoof);
    const dormerWin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.06), WINDOW_GLASS());
    dormerWin.position.set(0, dormerY, depth * 0.18 + dd / 2 + 0.03);
    group.add(dormerWin);
  }

  // ポーチ
  if (config.porch && config.porch.present) {
    const wrap = config.porch.style === 'wraparound';
    const porchDepth = 1.8;
    const porchWidth = wrap ? width + 1.0 : width * 0.55;
    const deckMat = getPBRMaterial('deckWood', { repeatX: porchWidth / 1.5, repeatY: porchDepth / 1.5 });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(porchWidth, 0.15, porchDepth), deckMat);
    floor.position.set(0, baseY + 0.08, depth / 2 + porchDepth / 2);
    group.add(floor);

    const colCount = wrap ? 6 : 4;
    for (let i = 0; i < colCount; i++) {
      const t = i / (colCount - 1);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.13, 2.3, 8), trimMat);
      col.position.set(-porchWidth / 2 + t * porchWidth, baseY + 1.3, depth / 2 + porchDepth - 0.1);
      group.add(col);
    }
    const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(porchWidth + 0.3, 0.12, porchDepth + 0.3), roofMat);
    porchRoof.position.set(0, baseY + 2.5, depth / 2 + porchDepth / 2);
    group.add(porchRoof);

    for (let s = 0; s < 3; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(1.2 - s * 0.15, 0.15, 0.35), foundationMat);
      step.position.set(0, baseY - 0.15 * (3 - s) + 0.075, depth / 2 + porchDepth + 0.2 + s * 0.35);
      group.add(step);
    }
  }

  group.userData.houseConfig = config;
  return group;
}

// ----------------------------------------------------------------------------
// 7. テラスハウスビルダー
// ----------------------------------------------------------------------------

export function buildTerraceHouse(config) {
  const group = new THREE.Group();
  group.name = config.id;

  const width = CELL * 1.5;      // 間口(狭小)。土地グリッドに合わせて要調整
  const depth = CELL * 2 * 1.5;  // 奥行
  const floorHeight = 3.1;
  const wallHeight = floorHeight * config.floors;

  const facadeMat = getPBRMaterial(config.facadeMaterial, { repeatX: width / 1.5, repeatY: wallHeight / 1.5 });
  const accentMat = config.accentMaterial ? getPBRMaterial(config.accentMaterial, { repeatX: width / 1.5, repeatY: 1 }) : null;
  const roofMat = getPBRMaterial(config.roofMaterial, { repeatX: width / 1.5, repeatY: depth / 3 });

  // 正面壁
  const frontWall = new THREE.Mesh(new THREE.BoxGeometry(width, wallHeight, 0.25), facadeMat);
  frontWall.position.set(0, wallHeight / 2, depth / 2);
  group.add(frontWall);

  // 腰壁アクセント（1階部分に別素材を帯状に重ねる。dark_brownファミリー用）
  if (accentMat) {
    const skirt = new THREE.Mesh(new THREE.BoxGeometry(width + 0.02, floorHeight * 0.9, 0.27), accentMat);
    skirt.position.set(0, floorHeight * 0.45, depth / 2);
    group.add(skirt);
  }

  // 背面壁
  const backWall = new THREE.Mesh(new THREE.BoxGeometry(width, wallHeight, 0.25), facadeMat);
  backWall.position.set(0, wallHeight / 2, -depth / 2);
  group.add(backWall);

  // 側面壁（partyWall='both'の場合は隣棟と共有のため描画しない）
  if (config.partyWall !== 'both') {
    const sideSign = 1; // 端ユニットの露出側
    const side = new THREE.Mesh(new THREE.BoxGeometry(0.25, wallHeight, depth), facadeMat);
    side.position.set(sideSign * width / 2, wallHeight / 2, 0);
    group.add(side);
  }

  // 屋根
  let roofTopY = wallHeight;
  if (config.roofStyle === 'flatParapet') {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(width, 0.2, depth), roofMat);
    slab.position.set(0, wallHeight + 0.1, 0);
    group.add(slab);
    const parapetH = 0.6;
    const pMat = getSolidMaterial(0xd8d2c4);
    [
      [width / 2 - 0.05, 0, 0.1, depth],
      [-width / 2 + 0.05, 0, 0.1, depth],
      [0, depth / 2 - 0.05, width, 0.1],
      [0, -depth / 2 + 0.05, width, 0.1],
    ].forEach(([px, pz, dx, dz]) => {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(dx, parapetH, dz), pMat);
      seg.position.set(px, wallHeight + parapetH / 2, pz);
      group.add(seg);
    });
    roofTopY = wallHeight + 0.3;
  } else if (config.roofStyle === 'mansard') {
    const mansardH = wallHeight * 0.28;
    const roof = makeMansardRoof({ width, depth, height: mansardH, material: roofMat });
    roof.position.set(0, wallHeight + mansardH / 2, 0);
    group.add(roof);
    roofTopY = wallHeight + mansardH;
  } else {
    const ridgeHeight = wallHeight * 0.22;
    const roof = makeGableRoof({ width, depth, ridgeHeight, overhang: 0.25, material: roofMat });
    roof.position.y = wallHeight;
    group.add(roof);
    roofTopY = wallHeight + ridgeHeight;
  }

  // 玄関ドア + ストゥープ階段
  const stoopH = 0.15 * config.stoopSteps;
  const door = new THREE.Mesh(new THREE.BoxGeometry(0.85, 1.95, 0.08), getSolidMaterial(0x2c1d12));
  door.position.set(0, stoopH + 0.975, depth / 2 + 0.05);
  group.add(door);

  const stepMat = getPBRMaterial('stoneRough', { repeatX: 1, repeatY: 1 });
  for (let s = 0; s < config.stoopSteps; s++) {
    const step = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.15, 0.32), stepMat);
    step.position.set(0, 0.075 + s * 0.15, depth / 2 + 0.3 + s * 0.3);
    group.add(step);
  }
  const railMat = getSolidMaterial(0x1a1a1a, { metalness: 0.6, roughness: 0.4 });
  [-0.6, 0.6].forEach((x) => {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.9, config.stoopSteps * 0.3), railMat);
    rail.position.set(x, 0.45 + stoopH / 2, depth / 2 + 0.3 + (config.stoopSteps * 0.3) / 2);
    group.add(rail);
  });

  // オーニング
  if (config.awning && config.awning !== 'none') {
    const color = config.awning === 'green' ? 0x2e6b3e : 0x1e335c;
    const awning = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.05, 0.6), getSolidMaterial(color));
    awning.rotation.x = -0.3;
    awning.position.set(0, stoopH + 2.1, depth / 2 + 0.35);
    group.add(awning);
  }

  // 屋上アクセサリ
  (config.accessories || []).forEach((acc, i) => {
    const ox = -width / 4 + i * (width / 2);
    if (acc === 'airConditioner') {
      const unit = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.35, 0.35), getSolidMaterial(0xd8d8d8));
      unit.position.set(ox, roofTopY + 0.17, -depth / 4);
      group.add(unit);
    } else if (acc === 'satelliteDish') {
      const poleMat = getSolidMaterial(0x333333);
      const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 0.6, 6), poleMat);
      pole.position.set(ox, roofTopY + 0.3, -depth / 4 + 0.4);
      group.add(pole);
      const dish = new THREE.Mesh(new THREE.CircleGeometry(0.35, 16), getSolidMaterial(0xcccccc, { metalness: 0.3 }));
      dish.rotation.y = Math.PI / 4;
      dish.position.set(ox, roofTopY + 0.6, -depth / 4 + 0.4);
      group.add(dish);
    } else if (acc === 'solarPanel') {
      const panel = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.05, 1.6), getSolidMaterial(0x1a2436, { metalness: 0.4, roughness: 0.3 }));
      panel.rotation.x = -0.15;
      panel.position.set(0, roofTopY + 0.15, 0);
      group.add(panel);
    } else if (acc === 'planterBox') {
      const boxMat = getPBRMaterial('deckWood', { repeatX: 1, repeatY: 1 });
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.25, 0.3), boxMat);
      box.position.set(0, stoopH + 0.4, depth / 2 + 0.62);
      group.add(box);
    }
  });

  group.userData.houseConfig = config;
  return group;
}

// ----------------------------------------------------------------------------
// 8. 公開ユーティリティ
// ----------------------------------------------------------------------------

export function getLowDensityHouseConfig(index) {
  return LOW_DENSITY_HOUSES[((index % LOW_DENSITY_HOUSES.length) + LOW_DENSITY_HOUSES.length) % LOW_DENSITY_HOUSES.length];
}
export function getTerraceHouseConfig(index) {
  return TERRACE_HOUSES[((index % TERRACE_HOUSES.length) + TERRACE_HOUSES.length) % TERRACE_HOUSES.length];
}
export function buildLowDensityHouseByIndex(index) {
  return buildLowDensityHouse(getLowDensityHouseConfig(index));
}
export function buildTerraceHouseByIndex(index) {
  return buildTerraceHouse(getTerraceHouseConfig(index));
}

export { TEXTURE_BASE, TEXTURE_FILES, getPBRMaterial, getSolidMaterial };
