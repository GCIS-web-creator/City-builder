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
// 4. 低密度住宅 11サイズ x 10種 = 110種 データ（res_low）
// ----------------------------------------------------------------------------
// メインファイルの区画選択セルは 1セル = 1メートル（PLOT_CELL_SIZE）で、低密度住宅は
// 「選択したセルの実寸そのもの」が建物の間口(width)x奥行(depth)になる（旧30種データは
// CELL=2.5m換算の架空サイズで作られており、しかもメインファイル側からは一度も
// 呼び出されていなかった＝実際には使われていなかったので、ここで作り直す）。
// 許可される区画セルサイズは次の11種類のみ（メインファイル側 LOW_DENSITY_CELL_SIZES と
// 完全に一致させること）:
//   3x2(=2x3, 既存互換)  3x3  3x4  3x5  3x6  4x4  4x5  4x6  5x5  5x6  6x6
// Prompt 23-R2: 5x5 / 5x6 / 6x6 を末尾に追加。既存サイズの配列位置(=sizeIdx=seed)は
// 変えないので、既に建っている家の見た目/シードは変わらない。
const LOW_DENSITY_SIZE_CLASSES = ['2x3', '3x3', '3x4', '3x5', '3x6', '4x4', '4x5', '4x6', '5x5', '5x6', '6x6'];

// 外観バリエーション用パレット（10種を作るための素材の組み合わせ。既存のテラスハウス
// パレットと重複しないよう、低密度住宅らしい戸建て向け素材のみを使用）。
const LOW_DENSITY_FACADE_PALETTE = [
  { family: 'classic_white', facadeMaterial: 'paintedWhiteWood', trimColor: 0xf2ede2, foundationMaterial: 'stoneRough' },
  { family: 'weathered_gray', facadeMaterial: 'weatheredWood', trimColor: 0xf2ede2, foundationMaterial: 'stoneDark' },
  { family: 'earth_brown', facadeMaterial: 'darkWood', trimColor: 0xe8dcc0, foundationMaterial: 'stoneRough' },
  { family: 'sage_blue', facadeMaterial: 'paintedBlueWood', trimColor: 0xf2ede2, foundationMaterial: 'stoneDark' },
  { family: 'cedar_lodge', facadeMaterial: 'rawWoodCedar', trimColor: 0x2a2018, foundationMaterial: 'stoneRough' },
  { family: 'cedar_hinoki', facadeMaterial: 'rawWoodHinoki', trimColor: 0xf2ede2, foundationMaterial: 'concrete' },
  { family: 'stucco_white', facadeMaterial: 'plasterWhite', trimColor: 0x2a2018, foundationMaterial: 'stoneRough' },
  { family: 'stucco_cream', facadeMaterial: 'plasterCream', trimColor: 0xf2ede2, foundationMaterial: 'concrete' },
  { family: 'stucco_worn', facadeMaterial: 'plasterCreamWorn', trimColor: 0x2a2018, foundationMaterial: 'stoneDark' },
  { family: 'blue_dark_trim', facadeMaterial: 'paintedBlueWood', trimColor: 0x232323, foundationMaterial: 'concrete' },
];
const LOW_DENSITY_ROOF_PALETTE = ['asphaltShingleBlack', 'asphaltShingleGray', 'tileRoofBrown', 'tileRoofRed', 'metalRoofDark'];

// 小さいセル(2x3等)ではポーチ／煙突／ドーマーを詰め込むと破綻するため、床面積に応じて
// 出現条件を絞る（buildLowDensityHouse 側でも同じしきい値で二重にガードする）。
function _lowDensityFeaturesForSize(w, d, i) {
  const area = w * d, shortSide = Math.min(w, d);
  return {
    porch: area >= 12 ? { present: true, style: i % 3 === 0 && shortSide >= 4 ? 'wraparound' : 'partial' } : { present: false },
    chimney: area >= 9 && i % 2 === 0,
    dormer: area >= 16 && i % 3 === 1,
    floors: 1,
  };
}

export const LOW_DENSITY_HOUSES = LOW_DENSITY_SIZE_CLASSES.flatMap((sizeKey, sizeIdx) => {
  const [a, b] = sizeKey.split('x').map(Number);
  return Array.from({ length: 10 }, (_, i) => {
    const palette = LOW_DENSITY_FACADE_PALETTE[i % LOW_DENSITY_FACADE_PALETTE.length];
    const roofMaterial = LOW_DENSITY_ROOF_PALETTE[(i + sizeIdx) % LOW_DENSITY_ROOF_PALETTE.length];
    const feat = _lowDensityFeaturesForSize(a, b, i);
    return {
      id: `low_${sizeKey}_${String(i + 1).padStart(2, '0')}`,
      sizeKey,
      // widthCells/depthCells はこの変体データの「基準サイズ」。実際に建てる際は
      // buildLowDensityHouseForCell がロットの実寸 w/d でこれを上書きするので、
      // 3x2 選択でも 2x3 選択でも同じ10種プールからそのままの向きで建つ。
      widthCells: a,
      depthCells: b,
      family: palette.family,
      facadeMaterial: palette.facadeMaterial,
      roofMaterial,
      trimColor: palette.trimColor,
      foundationMaterial: palette.foundationMaterial,
      porch: feat.porch,
      chimney: feat.chimney,
      dormer: feat.dormer,
      floors: feat.floors,
      seed: 3000 + sizeIdx * 10 + i,
    };
  });
});

// sizeKey ('2x3' 等) -> このサイズの10種の配列。
const _lowDensityBySize = new Map();
for (const h of LOW_DENSITY_HOUSES) {
  if (!_lowDensityBySize.has(h.sizeKey)) _lowDensityBySize.set(h.sizeKey, []);
  _lowDensityBySize.get(h.sizeKey).push(h);
}
function _lowDensitySizeKey(w, d) { return Math.min(w, d) + 'x' + Math.max(w, d); }
/** そのセルサイズで建築可能かどうか（メインファイル側 LOW_DENSITY_CELL_SIZES と対応）。 */
export function isLowDensityHouseSizeAvailable(w, d) { return _lowDensityBySize.has(_lowDensitySizeKey(w, d)); }
/** そのセルサイズの10種のうち1つの設定を返す（variantIndex は 0-9 の範囲に丸められる）。 */
export function getLowDensityHouseConfigForCell(w, d, variantIndex = 0) {
  const arr = _lowDensityBySize.get(_lowDensitySizeKey(w, d));
  if (!arr || !arr.length) return null;
  const idx = ((variantIndex % arr.length) + arr.length) % arr.length;
  return arr[idx];
}

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

const WINDOW_GLASS = () => getSolidMaterial(0x1c2733, { roughness: 0.15, metalness: 0.1 });

/**
 * config.widthCells/depthCells は「区画セル数 == メートル数」として直接使う（1セル=1m、
 * メインファイルの PLOT_CELL_SIZE と同じ単位）。旧バージョンにあった CELL=2.5 倍率は、
 * この住宅ジェネレーターがメインファイルからまだ一度も呼ばれていなかった頃の名残の
 * 不整合だったので廃止し、選ばれたロットの実寸にそのまま一致させる。
 * 最小許容セル(2x3=2m x 3m)でも窓や玄関がめり込まないよう、間口/奥行が小さいほど
 * 窓の個数・サイズ・付帯物を自動的に簡略化する。
 */
export function buildLowDensityHouse(config) {
  const group = new THREE.Group();
  group.name = config.id;

  const width = Math.max(1.6, config.widthCells * 0.92);
  const depthFull = Math.max(1.6, config.depthCells * 0.92);
  // Prompt 23-R2: the whole house — INCLUDING the front porch and its steps — must stay inside the
  // selected cells (= the lot footprint, config.widthCells x config.depthCells metres). Before, the
  // porch + steps stuck out 2-3 m past the front edge (onto the sidewalk / road) and a wraparound porch
  // was wider than the lot. So when a porch is present the main body is shortened by the porch's
  // front extension and the whole assembly is re-centred on the footprint (see the end of this function).
  const hasPorch = !!(config.porch && config.porch.present && depthFull >= 3.2);
  const porchDepthC = Math.min(1.8, Math.max(0.9, depthFull * 0.3));
  const stepCountC = porchDepthC >= 1.4 ? 3 : 2;
  const frontExt = hasPorch ? porchDepthC + 0.34 + (stepCountC - 1) * 0.32 : 0;
  const depth = hasPorch ? Math.max(2.0, depthFull - frontExt) : depthFull;
  const floorHeight = 2.9;
  const wallHeight = floorHeight * (config.floors || 1);
  const ridgeHeight = wallHeight * 0.5;
  const baseY = 0.35; // 基礎の高さぶんの底上げ

  const facadeMat = getPBRMaterial(config.facadeMaterial, { repeatX: Math.max(width, 1) / 2, repeatY: wallHeight / 2 });
  const roofMat = getPBRMaterial(config.roofMaterial, { repeatX: Math.max(width, 1) / 3, repeatY: Math.max(depth, 1) / 3 });
  const foundationMat = getPBRMaterial(config.foundationMaterial, { repeatX: Math.max(width, 1) / 2, repeatY: 0.5 });
  const trimMat = getSolidMaterial(config.trimColor);

  // 基礎
  const foundation = new THREE.Mesh(new THREE.BoxGeometry(width + 0.2, baseY, depth + 0.2), foundationMat);
  foundation.position.y = baseY / 2;
  group.add(foundation);

  // 壁本体
  const walls = new THREE.Mesh(new THREE.BoxGeometry(width, wallHeight, depth), facadeMat);
  walls.position.y = baseY + wallHeight / 2;
  walls.castShadow = walls.receiveShadow = true;
  group.add(walls);

  // 切妻屋根（軒の出は小さい家ほど相対的に抑える）
  // Prompt 23-R2: eaves are clamped so the roof also stays inside the lot (body is 0.92 of the lot; slack = 4%)
  const overhang = Math.max(0.08, Math.min(0.5, Math.min(width, depth) * 0.14, Math.min(config.widthCells, config.depthCells) * 0.04));
  const roof = makeGableRoof({ width, depth, ridgeHeight, overhang, material: roofMat });
  roof.position.y = baseY + wallHeight;
  group.add(roof);

  // 窓：間口が狭い(2m台)場合は中央1つ、それ以外は左右2つ。サイズも間口に応じて縮小。
  const winY = baseY + wallHeight * 0.55;
  const winW = Math.min(1.05, width * 0.3), winH = Math.min(1.25, wallHeight * 0.42);
  const glassW = winW - 0.15, glassH = winH - 0.15;
  const windowXs = width >= 3.2 ? [-width * 0.28, width * 0.28] : [0];
  // 玄関を中央以外に配置できるときだけ窓を2つとも中央から離す。中央1窓の場合は玄関を脇へ。
  const doorX = windowXs.length === 1 ? width * 0.26 : 0;
  windowXs.forEach((x) => {
    const frame = new THREE.Mesh(new THREE.BoxGeometry(winW, winH, 0.05), trimMat);
    frame.position.set(x, winY, depth / 2);
    group.add(frame);
    const glass = new THREE.Mesh(new THREE.BoxGeometry(glassW, glassH, 0.08), WINDOW_GLASS());
    glass.position.set(x, winY, depth / 2 + 0.02);
    group.add(glass);
  });
  const doorW = Math.min(0.9, width * 0.32);
  const door = new THREE.Mesh(new THREE.BoxGeometry(doorW, 1.9, 0.08), getSolidMaterial(0x3a2a1c));
  door.position.set(doorX, baseY + 0.95, depth / 2 + 0.02);
  group.add(door);

  // 煙突（間口3m未満では省略 — 壁からはみ出すため）
  if (config.chimney && width >= 3) {
    const chimneyMat = getPBRMaterial('brickRed', { repeatX: 0.5, repeatY: 1 });
    const chimneyH = wallHeight * 0.9 + ridgeHeight * 0.6;
    const cw = Math.min(0.7, width * 0.16);
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(cw, chimneyH, cw), chimneyMat);
    chimney.position.set(width * 0.3, baseY + chimneyH / 2, -depth * 0.2);
    group.add(chimney);
  }

  // ドーマー（十分な奥行・間口がある場合のみ）
  if (config.dormer && width >= 3.6 && depth >= 4.4) {
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

  // ポーチ（奥行3.2m未満では省略。前方(道路側の宅地セットバック側)へ張り出すだけなので
  // 隣接ロットへは食い込まない）
  if (hasPorch) {
    const wrap = config.porch.style === 'wraparound' && width >= 4;
    const porchDepth = porchDepthC;
    // never wider than the lot itself (a wraparound porch used to overhang the neighbouring lot)
    const porchWidth = wrap ? Math.min(width + 1.0, config.widthCells - 0.25) : Math.max(1.2, width * 0.55);
    const deckMat = getPBRMaterial('deckWood', { repeatX: porchWidth / 1.5, repeatY: porchDepth / 1.5 });

    const floor = new THREE.Mesh(new THREE.BoxGeometry(porchWidth, 0.15, porchDepth), deckMat);
    floor.position.set(0, baseY + 0.08, depth / 2 + porchDepth / 2);
    group.add(floor);

    const colCount = wrap ? 6 : 4;
    for (let i = 0; i < colCount; i++) {
      const t = i / (colCount - 1);
      const col = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.11, 2.2, 8), trimMat);
      col.position.set(-porchWidth / 2 + t * porchWidth, baseY + 1.25, depth / 2 + porchDepth - 0.1);
      group.add(col);
    }
    const porchRoof = new THREE.Mesh(new THREE.BoxGeometry(Math.min(porchWidth + 0.3, config.widthCells), 0.12, porchDepth + 0.3), roofMat);
    porchRoof.position.set(0, baseY + 2.4, depth / 2 + porchDepth / 2);
    group.add(porchRoof);

    const stepCount = stepCountC;
    for (let s = 0; s < stepCount; s++) {
      const step = new THREE.Mesh(new THREE.BoxGeometry(Math.min(1.2, porchWidth * 0.8) - s * 0.15, 0.15, 0.32), foundationMat);
      step.position.set(0, baseY - 0.15 * (stepCount - s) + 0.075, depth / 2 + porchDepth + 0.18 + s * 0.32);
      group.add(step);
    }
  }

  // re-centre body + porch + steps on the lot footprint (everything above is a direct child of `group`)
  if (frontExt > 0) group.children.forEach((ch) => { ch.position.z -= frontExt / 2; });

  group.userData.houseConfig = config;
  return group;
}

/**
 * ロットの実際の間口(w)x奥行(d)（メートル、= 選択セル数）から、対応するサイズクラスの
 * 10種プールの中から1棟選んで建てる。w/d はそのまま使う（11サイズのどちらの向きで
 * 選択されていても、正規化したクラスから10種を探した上で実寸 w/d で建てる）。
 * サイズが11種のどれにも一致しない場合は null を返す（呼び出し側で建築を拒否すること）。
 */
export function buildLowDensityHouseForCell(w, d, variantIndex = 0) {
  const base = getLowDensityHouseConfigForCell(w, d, variantIndex);
  if (!base) return null;
  return buildLowDensityHouse({ ...base, widthCells: w, depthCells: d });
}

// ----------------------------------------------------------------------------
// 7. テラスハウスビルダー
// ----------------------------------------------------------------------------

// Prompt 23-R2 ROOT-CAUSE FIX: buildTerraceHouse below still multiplies by CELL, but the CELL
// constant was deleted when the low-density generator moved to 1 cell = 1 m (see §6 comment).
// Every call therefore threw `ReferenceError: CELL is not defined`. The terrace house keeps its
// original 2.5 m-per-unit proportions (the main file's res_terrace branch rescales it with the
// matching NATIVE_W = 2.5*1.5 / NATIVE_D = 2.5*2*1.5), so the constant is restored here, scoped
// to the terrace builder only — low-density houses never use it.
const CELL = 2.5;

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