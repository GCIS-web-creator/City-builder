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
  const tex = _textureLoader.load(TEXTURE_BASE + relPath, undefined, undefined, () => console.warn(`[HousingPBR] legacy texture FAILED: ${TEXTURE_BASE + relPath}`));
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

// ============================================================================
// 9. Prompt 24A-R2 — Modular House Kit + Shared Geometry / Material / Texture caches
// ----------------------------------------------------------------------------
// buildLowDensityHouse() / buildLowDensityHouseForCell() above are kept UNCHANGED (legacy / dev
// fallback + terrace path). HouseInstanceRenderer never calls them.
//
// A house archetype is now a *kit-of-parts recipe*: a list of MODULE INSTANCES
//   { part, geoKey, geometry, matKey, material, local(Matrix4), tinted, color? }
// Geometry is created once per module KEY (see _geo) and shared by every part / house / archetype
// that asks for that key:
//   * unit box  ...... window frame / glass / mullion / sill / door frame / handle / gutter /
//                      downspout / corner board / chimney cap  (ONE geometry, scale in `local`)
//   * cylinder ....... porch column (ONE geometry)
//   * railing(len) ... merged rail + balusters, keyed by length (few distinct lengths)
//   * door(w,style) .. slab + raised panels (3 styles)
//   * wall / foundation / deck / porch roof / chimney / dormer boxes, gable slopes, gable ends:
//       keyed by their dimensions only -> shared by every VARIANT of the same oriented size
//       (variants differ by Material + feature flags, not by geometry)
// LOD1..3 keep the size-independent unit geometry path (_unitParts).
//
// Textures: ONE async, size-capped, shared load per image file (see _requestSharedTex). Materials
// start as a flat fallback colour and gain their maps only if the file really loaded, so a missing
// / unreachable / non-image file can never turn a surface black.
// ============================================================================

// ---- 9.0 stats ------------------------------------------------------------------------------
export const HOUSE_STATS = {
  geometryCreated: 0, geometryHit: 0, geometryMiss: 0, geometryCreateMs: 0,
  materialCreated: 0, materialHit: 0, materialMiss: 0, materialCreateMs: 0,
  textureRequested: 0, textureCacheHit: 0, textureLoaded: 0, textureFailed: 0, texturePending: 0,
  textureBytesEst: 0, failedTextures: [],
};
const _q = (v) => Math.round(v * 1000) / 1000;
const _now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ---- 9.1 shared texture loader ---------------------------------------------------------------
// The 4K source files stay on disk untouched. On upload they are decoded OFF the main thread with
// createImageBitmap and down-scaled to HOUSE_TEX_MAX (default 1024, override with
// window.__HOUSE_TEX_MAX__ = 2048 before the first house). A 4096^2 RGBA texture is ~85 MB of GPU
// memory with mips; 1024^2 is ~5 MB, and one house needs 15+ maps.
const _sharedTexEntries = new Map(); // `${path}|${srgb}` -> { url, status:'pending'|'ready'|'failed', tex, waiters }
const _texQueue = [];
let _texActive = 0;
const TEX_CONCURRENCY = 2;
let _texFetcher = null; // tests can inject (url) => Promise<{ image, flipY } | { texture }>
export function __setHouseTextureFetcher(fn) { _texFetcher = fn; }
const _texMax = () => (typeof window !== 'undefined' && window.__HOUSE_TEX_MAX__) || 1024;

async function _defaultFetchTexture(url) {
  if (typeof fetch === 'function' && typeof createImageBitmap === 'function') {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    // A dev server that answers a missing file with index.html (HTTP 200) is caught here.
    if (blob.type && !blob.type.startsWith('image/')) throw new Error(`not an image (content-type "${blob.type}")`);
    const base = { imageOrientation: 'flipY', premultiplyAlpha: 'none', colorSpaceConversion: 'none' };
    let bmp;
    try { bmp = await createImageBitmap(blob, { ...base, resizeWidth: _texMax(), resizeQuality: 'high' }); }
    catch (e) { bmp = await createImageBitmap(blob, base); } // browser without resize options: full-size decode
    return { image: bmp, flipY: false, w: bmp.width, h: bmp.height };
  }
  return new Promise((resolve, reject) => _textureLoader.load(url, (t) => resolve({ texture: t }), undefined, (e) => reject(e && e.message ? e : new Error('image load error'))));
}

function _pumpTexQueue() {
  while (_texActive < TEX_CONCURRENCY && _texQueue.length) {
    const e = _texQueue.shift(); _texActive++;
    (_texFetcher || _defaultFetchTexture)(e.url).then((r) => {
      let tex = r.texture;
      if (!tex) { tex = new THREE.Texture(r.image); tex.flipY = r.flipY === undefined ? true : r.flipY; }
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.anisotropy = 4;
      if (e.srgb && 'colorSpace' in tex) tex.colorSpace = THREE.SRGBColorSpace;
      tex.needsUpdate = true;
      e.tex = tex; e.status = 'ready'; HOUSE_STATS.textureLoaded++;
      HOUSE_STATS.textureBytesEst += (r.w || 1024) * (r.h || 1024) * 4 * 1.33;
    }).catch((err) => {
      e.status = 'failed'; HOUSE_STATS.textureFailed++; HOUSE_STATS.failedTextures.push(e.url);
      if (HOUSE_STATS.textureFailed === 7) console.warn('[HousingPBR] more texture failures suppressed — see window.__HOUSE_RENDER_STATS__.failedTextures');
      else if (HOUSE_STATS.textureFailed < 7) console.warn(`[HousingPBR] texture FAILED: ${e.url} (${err && err.message ? err.message : err}). Surfaces that use it fall back to a flat colour. Check TEXTURE_BASE ("${TEXTURE_BASE}") / the file name / folder case; run window.__HOUSE_TEX_PROBE__() for a full report.`);
    }).finally(() => {
      _texActive--; HOUSE_STATS.texturePending = _texQueue.length + _texActive;
      e.waiters.splice(0).forEach((f) => { try { f(e); } catch (er) { console.error(er); } });
      _pumpTexQueue();
    });
  }
  HOUSE_STATS.texturePending = _texQueue.length + _texActive;
}

function _requestSharedTex(relPath, srgb, cb) {
  const key = `${relPath}|${srgb ? 1 : 0}`;
  let e = _sharedTexEntries.get(key);
  if (e) HOUSE_STATS.textureCacheHit++;
  else {
    e = { key, url: TEXTURE_BASE + relPath, srgb: !!srgb, status: 'pending', tex: null, waiters: [] };
    _sharedTexEntries.set(key, e); HOUSE_STATS.textureRequested++; _texQueue.push(e); _pumpTexQueue();
  }
  if (e.status === 'pending') e.waiters.push(cb); else cb(e);
  return e;
}

/** Dev diagnostic: HEAD/GET every texture path and report status + content-type (finds 404s and SPA-fallback HTML). */
export async function probeHouseTextures(presets = Object.keys(TEXTURE_FILES)) {
  const rows = [];
  for (const p of presets) for (const kind of ['diff', 'nor', 'arm']) {
    const url = TEXTURE_BASE + TEXTURE_FILES[p][kind];
    try { const r = await fetch(url, { method: 'GET' }); const b = await r.blob(); rows.push({ preset: p, kind, url, status: r.status, type: b.type, bytes: b.size, ok: r.ok && (b.type || '').startsWith('image/') }); }
    catch (err) { rows.push({ preset: p, kind, url, status: 'ERR', type: String(err && err.message), bytes: 0, ok: false }); }
  }
  console.table(rows.filter((r) => !r.ok));
  return rows;
}
if (typeof window !== 'undefined') window.__HOUSE_TEX_PROBE__ = probeHouseTextures;

// ---- 9.2 shared materials --------------------------------------------------------------------
// LOD3 flat colours = fallback colour of every preset (representative average of its diffuse map).
const FLAT_COLOR = {
  paintedWhiteWood: 0xd9d6cc, paintedCreamWood: 0xd8c7a0, weatheredWood: 0x8d8a84, darkWood: 0x5a4030,
  paintedBlueWood: 0x6f8aa0, rawWoodCedar: 0xa0703f, rawWoodHinoki: 0xc9a76f, deckWood: 0x8a6a48, fenceBamboo: 0xb8a070,
  plasterWhite: 0xe2dfd6, plasterCreamWorn: 0xb9ae8f, plasterCream: 0xd9c9a6, plasterBlue: 0x7d93a8,
  concrete: 0x8f8d88, concreteRock: 0x85817a, brickRed: 0x8c4a3a,
  asphaltShingleBlack: 0x3a3836, asphaltShingleGray: 0x6d6f72, tileRoofBrown: 0x7a4a34, tileRoofRed: 0x9a4530, metalRoofDark: 0x4d5155,
  stoneRough: 0x7c766c, stoneDark: 0x4a4744,
};
// Only real metals get a metalness map. Dielectrics (wood / tile / stone / stucco) are forced to
// metalness 0: this scene has NO environment map, so any metalness > 0 renders as dark/black.
const METAL_PRESETS = { metalRoofDark: 0.35 };
const _warnedPreset = new Set();

function _solid(hex, o = {}) {
  const roughness = o.roughness ?? 0.7, metalness = o.metalness ?? 0;
  const key = `solid|${hex}|${roughness}|${metalness}`;
  if (_materialCache.has(key)) { HOUSE_STATS.materialHit++; return _materialCache.get(key); }
  HOUSE_STATS.materialMiss++; const t0 = _now();
  const m = getSolidMaterial(hex, { roughness, metalness });
  HOUSE_STATS.materialCreated++; HOUSE_STATS.materialCreateMs += _now() - t0;
  return m;
}
function _glassMaterial() {
  const key = 'shared|glass';
  if (_materialCache.has(key)) { HOUSE_STATS.materialHit++; return _materialCache.get(key); }
  HOUSE_STATS.materialMiss++; const t0 = _now();
  const m = new THREE.MeshStandardMaterial({ color: 0x35506a, roughness: 0.12, metalness: 0, emissive: 0x0b1a28, emissiveIntensity: 0.7 });
  m.name = 'house:glass'; _materialCache.set(key, m);
  HOUSE_STATS.materialCreated++; HOUSE_STATS.materialCreateMs += _now() - t0;
  return m;
}
const _metalMaterial = () => _solid(0x4a5057, { roughness: 0.45, metalness: 0.3 });

/** Full PBR (diff + normal + ARM) at repeat 1x1 — ONE material per preset, shared by all houses. Starts as a flat fallback colour. */
export function getSharedPBRMaterial(presetKey) {
  const files = TEXTURE_FILES[presetKey];
  if (!files) {
    if (!_warnedPreset.has(presetKey)) { _warnedPreset.add(presetKey); console.warn(`[HousingPBR] unknown preset "${presetKey}" → flat fallback`); }
    return _solid(0xb0aca4, { roughness: 0.9 });
  }
  const key = `shared|pbr|${presetKey}`;
  if (_materialCache.has(key)) { HOUSE_STATS.materialHit++; return _materialCache.get(key); }
  HOUSE_STATS.materialMiss++; const t0 = _now();
  const mat = new THREE.MeshStandardMaterial({ color: FLAT_COLOR[presetKey] ?? 0xb0aca4, roughness: 0.88, metalness: 0 });
  mat.name = `house:pbr:${presetKey}`; _materialCache.set(key, mat);
  HOUSE_STATS.materialCreated++;
  const got = {}; let left = 3;
  const finish = () => { // ONE program update per material, once all three maps have settled
    if (--left) return;
    if (got.diff.status === 'ready') { mat.map = got.diff.tex; mat.color.setHex(0xffffff); }
    if (got.nor.status === 'ready') mat.normalMap = got.nor.tex;
    if (got.arm.status === 'ready') {
      mat.roughnessMap = got.arm.tex; mat.roughness = 1;
      if (METAL_PRESETS[presetKey] !== undefined) { mat.metalnessMap = got.arm.tex; mat.metalness = METAL_PRESETS[presetKey]; }
    }
    mat.userData.texState = { diff: got.diff.status, nor: got.nor.status, arm: got.arm.status };
    mat.needsUpdate = true;
  };
  _requestSharedTex(files.diff, true, (e) => { got.diff = e; finish(); });
  _requestSharedTex(files.nor, false, (e) => { got.nor = e; finish(); });
  _requestSharedTex(files.arm, false, (e) => { got.arm = e; finish(); });
  HOUSE_STATS.materialCreateMs += _now() - t0;
  return mat;
}

/** LOD2: diffuse map only — same Texture object as the PBR material. */
export function getSharedLiteMaterial(presetKey) {
  const files = TEXTURE_FILES[presetKey];
  if (!files) return _solid(0xb0aca4, { roughness: 0.9 });
  const key = `shared|lite|${presetKey}`;
  if (_materialCache.has(key)) { HOUSE_STATS.materialHit++; return _materialCache.get(key); }
  HOUSE_STATS.materialMiss++; const t0 = _now();
  const mat = new THREE.MeshStandardMaterial({ color: FLAT_COLOR[presetKey] ?? 0xb0aca4, roughness: 0.85, metalness: 0 });
  mat.name = `house:lite:${presetKey}`; _materialCache.set(key, mat);
  HOUSE_STATS.materialCreated++;
  _requestSharedTex(files.diff, true, (e) => { if (e.status === 'ready') { mat.map = e.tex; mat.color.setHex(0xffffff); mat.needsUpdate = true; } });
  HOUSE_STATS.materialCreateMs += _now() - t0;
  return mat;
}
function _flatMaterial(presetKey) { return _solid(FLAT_COLOR[presetKey] ?? 0xcccccc, { roughness: 0.9, metalness: 0 }); }

export function getHouseMaterialStats() {
  let shared = 0, solid = 0; _materialCache.forEach((_, k) => { if (k.startsWith('shared|')) shared++; else if (k.startsWith('solid|')) solid++; });
  let ready = 0, failed = 0; _sharedTexEntries.forEach((e) => { if (e.status === 'ready') ready++; else if (e.status === 'failed') failed++; });
  return {
    pbrAndLiteMaterials: shared, solidMaterials: solid, totalMaterials: _materialCache.size,
    sharedTextures: _sharedTexEntries.size, totalTextures: _sharedTexEntries.size + _textureCache.size,
    texturesReady: ready, texturesFailed: failed, texturesPending: _sharedTexEntries.size - ready - failed,
    textureRequested: HOUSE_STATS.textureRequested, textureCacheHit: HOUSE_STATS.textureCacheHit,
    materialHit: HOUSE_STATS.materialHit, materialMiss: HOUSE_STATS.materialMiss, materialCreateMs: +HOUSE_STATS.materialCreateMs.toFixed(3),
    textureBytesEstMB: +(HOUSE_STATS.textureBytesEst / 1048576).toFixed(1), failedTextures: HOUSE_STATS.failedTextures.slice(),
  };
}

// ---- 9.3 shared geometry cache + module builders ---------------------------------------------
// HOUSE_GEOMETRY_CACHE: module key -> BufferGeometry. Never disposed per house (renderer shutdown only).
export const HOUSE_GEOMETRY_CACHE = new Map();
function _geo(key, build) {
  let g = HOUSE_GEOMETRY_CACHE.get(key);
  if (g) { HOUSE_STATS.geometryHit++; return { key, geometry: g }; }
  HOUSE_STATS.geometryMiss++; const t0 = _now();
  g = build(); HOUSE_GEOMETRY_CACHE.set(key, g);
  HOUSE_STATS.geometryCreated++; HOUSE_STATS.geometryCreateMs += _now() - t0;
  return { key, geometry: g };
}
export function disposeHouseSharedResources() { // renderer / app shutdown ONLY (never per house)
  HOUSE_GEOMETRY_CACHE.forEach((g) => g && g.dispose()); HOUSE_GEOMETRY_CACHE.clear();
  _materialCache.forEach((m) => m.dispose()); _materialCache.clear();
  _sharedTexEntries.forEach((e) => { if (e.tex) e.tex.dispose(); }); _sharedTexEntries.clear();
  HOUSE_ARCHETYPES.forEach((a) => { a._lodParts = [null, null, null, null]; });
}

function _scaleUV(geo, rx, ry) {
  const uv = geo.attributes.uv; if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rx, uv.getY(i) * ry);
  uv.needsUpdate = true; return geo;
}
// Version-independent merge (BufferGeometryUtils.mergeGeometries was renamed between three releases).
function _mergeGeos(list) {
  const parts = list.filter(Boolean).map((g) => (g.index ? g.toNonIndexed() : g));
  if (!parts.length) return null;
  let total = 0; parts.forEach((g) => { total += g.attributes.position.count; });
  const pos = new Float32Array(total * 3), nor = new Float32Array(total * 3), uv = new Float32Array(total * 2);
  let o = 0;
  parts.forEach((g) => {
    pos.set(g.attributes.position.array, o * 3);
    if (g.attributes.normal) nor.set(g.attributes.normal.array, o * 3);
    if (g.attributes.uv) uv.set(g.attributes.uv.array, o * 2);
    o += g.attributes.position.count;
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingSphere(); out.computeBoundingBox();
  list.forEach((g) => g && g.dispose()); parts.forEach((g) => g.dispose());
  return out;
}
const _boxAt = (w, h, d, x, y, z, ux = 1, uy = 1) => { const g = new THREE.BoxGeometry(w, h, d); _scaleUV(g, ux, uy); g.translate(x, y, z); return g; };

const _boxMod = (w, h, d, ux = 1, uy = 1) => _geo(`box|${_q(w)}x${_q(h)}x${_q(d)}|uv${_q(ux)}x${_q(uy)}`, () => _scaleUV(new THREE.BoxGeometry(w, h, d), ux, uy));
const _unitBox = () => _boxMod(1, 1, 1, 1, 1); // shared by every un-textured detail
const _columnMod = () => _geo('cyl|0.07-0.11-2.2-8', () => new THREE.CylinderGeometry(0.07, 0.11, 2.2, 8));

// Gable roof as TWO slope panels (roof material, explicit UVs at ~2.5 m per tile) + TWO gable-end
// pentagons (facade material). The old ExtrudeGeometry prism painted the gable ends with the roof
// texture and let the extrude UV generator stretch the slope UVs; this fixes both.
function _pushTri(pos, nor, uv, a, b, c, n, ua, ub, uc) {
  const e1 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], e2 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
  const cx = e1[1] * e2[2] - e1[2] * e2[1], cy = e1[2] * e2[0] - e1[0] * e2[2], cz = e1[0] * e2[1] - e1[1] * e2[0];
  if (cx * n[0] + cy * n[1] + cz * n[2] < 0) { [b, c] = [c, b]; [ub, uc] = [uc, ub]; } // force CCW toward the outward normal
  [a, b, c].forEach((p) => pos.push(p[0], p[1], p[2])); for (let i = 0; i < 3; i++) nor.push(n[0], n[1], n[2]);
  uv.push(ua[0], ua[1], ub[0], ub[1], uc[0], uc[1]);
}
function _mkGeo(pos, nor, uv) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeBoundingSphere(); g.computeBoundingBox(); return g;
}
const ROOF_TILE_M = 2.5, FACADE_TILE_M = 2.0;
function _gableSlopesMod(width, depth, ridge, ov) {
  return _geo(`gslope|${_q(width)}x${_q(depth)}|${_q(ridge)}|${_q(ov)}`, () => {
    const hw = width / 2 + ov, hd = depth / 2 + ov, L = Math.hypot(hw, ridge), r = 1 / ROOF_TILE_M;
    const pos = [], nor = [], uv = [];
    const quad = (A, B, C, D, n, uA, uB, uC, uD) => { _pushTri(pos, nor, uv, A, B, C, n, uA, uB, uC); _pushTri(pos, nor, uv, A, C, D, n, uA, uC, uD); };
    for (const s of [-1, 1]) { // s=-1 left slope, s=+1 right slope
      const A = [s * hw, 0, -hd], B = [0, ridge, -hd], C = [0, ridge, hd], D = [s * hw, 0, hd], n = [s * ridge / L, hw / L, 0];
      quad(A, B, C, D, n, [0, 0], [0, L * r], [2 * hd * r, L * r], [2 * hd * r, 0]);
    }
    const bn = [0, -1, 0]; // soffit: hides the see-through under the eaves from low cameras
    quad([-hw, 0, -hd], [hw, 0, -hd], [hw, 0, hd], [-hw, 0, hd], bn, [0, 0], [1, 0], [1, 1], [0, 1]);
    return _mkGeo(pos, nor, uv);
  });
}
function _gableEndsMod(width, depth, ridge, ov) {
  return _geo(`gend|${_q(width)}x${_q(depth)}|${_q(ridge)}|${_q(ov)}`, () => {
    const hw = width / 2, h0 = ridge * ov / (width / 2 + ov), r = 1 / FACADE_TILE_M;
    const P = [[-hw, 0], [hw, 0], [hw, h0], [0, ridge], [-hw, h0]];
    const pos = [], nor = [], uv = [];
    for (const s of [1, -1]) {
      const z = s * depth / 2, n = [0, 0, s], V = P.map((p) => [p[0], p[1], z]), U = P.map((p) => [p[0] * r, p[1] * r]);
      for (let i = 1; i < 4; i++) _pushTri(pos, nor, uv, V[0], V[i], V[i + 1], n, U[0], U[i], U[i + 1]);
    }
    return _mkGeo(pos, nor, uv);
  });
}
// wall assembly = wall box + facade-coloured gable ends (same material, same size -> ONE geometry / ONE bucket)
const _bodyMod = (L) => _geo(`body|${_q(L.width)}x${_q(L.wallHeight)}x${_q(L.depth)}|${_q(L.ridgeHeight)}|${_q(L.overhang)}`, () => {
  const box = _boxAt(L.width, L.wallHeight, L.depth, 0, L.wallHeight / 2, 0, L.uvFacade[0], L.uvFacade[1]);
  const ends = _gableEndsMod(L.width, L.depth, L.ridgeHeight, L.overhang).geometry.clone().translate(0, L.wallHeight, 0);
  return _mergeGeos([box, ends]);
});
const _dormerBodyMod = (dw, dd, dh, uvf) => _geo(`dbody|${_q(dw)}x${_q(dh)}x${_q(dd)}`, () => {
  const box = _boxAt(dw, dh, dd, 0, 0, 0, uvf[0], uvf[1]);
  const ends = _gableEndsMod(dw, dd, dh * 0.6, 0.1).geometry.clone().translate(0, dh / 2, 0);
  return _mergeGeos([box, ends]);
});
// porch stairs: one merged module, origin = centre of the porch front edge on the ground line (baseY); shared by every size with the same top-step width
const _stairsMod = (topW, count) => _geo(`stairs|${_q(topW)}|${count}`, () => {
  const list = [];
  for (let s = 0; s < count; s++) list.push(_boxAt(_q(topW - s * 0.15), 0.15, 0.32, 0, -0.15 * (count - s) + 0.075, 0.18 + s * 0.32, 1, 0.3));
  return _mergeGeos(list);
});
const _doorMod = (doorW, style) => _geo(`door|${_q(doorW)}|${style}`, () => {
  const u = [0.5, 0.9], list = [_boxAt(doorW, 1.9, 0.07, 0, 0, 0, u[0], u[1])];
  if (style === 'paneled') [[-1, 0.5, 0.62], [1, 0.5, 0.62], [-1, -0.42, 0.72], [1, -0.42, 0.72]].forEach(([sx, y, h]) => list.push(_boxAt(doorW * 0.34, h, 0.03, sx * doorW * 0.21, y, 0.04, 0.3, 0.4)));
  else if (style === 'lite') list.push(_boxAt(doorW * 0.6, 1.5, 0.03, 0, 0.05, 0.04, 0.3, 0.8));
  else list.push(_boxAt(doorW * 0.8, 0.05, 0.03, 0, 0.1, 0.04, 0.3, 0.1)); // flat door: one kick/lock rail
  return _mergeGeos(list);
});
const _railMod = (len) => _geo(`rail|${_q(len)}`, () => {
  const l = _q(len), list = [_boxAt(l, 0.05, 0.07, 0, 0.9, 0), _boxAt(l, 0.04, 0.05, 0, 0.14, 0)];
  const n = Math.max(2, Math.floor(l / 0.14));
  for (let i = 0; i < n; i++) list.push(_boxAt(0.025, 0.76, 0.025, -l / 2 + (i + 0.5) * (l / n), 0.52, 0));
  return _mergeGeos(list);
});

// ---- 9.4 layout (numbers only — exact mirror of the maths in buildLowDensityHouse) --------------
function _lowDensityLayout(config) {
  const width = Math.max(1.6, config.widthCells * 0.92);
  const depthFull = Math.max(1.6, config.depthCells * 0.92);
  const hasPorch = !!(config.porch && config.porch.present && depthFull >= 3.2);
  const porchDepthC = Math.min(1.8, Math.max(0.9, depthFull * 0.3));
  const stepCountC = porchDepthC >= 1.4 ? 3 : 2;
  const frontExt = hasPorch ? porchDepthC + 0.34 + (stepCountC - 1) * 0.32 : 0;
  const depth = hasPorch ? Math.max(2.0, depthFull - frontExt) : depthFull;
  const floors = config.floors || 1;
  const wallHeight = 2.9 * floors, ridgeHeight = wallHeight * 0.5, baseY = 0.35;
  const overhang = Math.max(0.08, Math.min(0.5, Math.min(width, depth) * 0.14, Math.min(config.widthCells, config.depthCells) * 0.04));
  const winW = Math.min(1.05, width * 0.3), winH = Math.min(1.25, wallHeight * 0.42);
  const windowXs = width >= 3.2 ? [-width * 0.28, width * 0.28] : [0];
  const L = {
    width, depth, depthFull, hasPorch, porchDepthC, stepCountC, frontExt, floors, wallHeight, ridgeHeight, baseY, overhang,
    winY: baseY + wallHeight * 0.55, winW, winH, glassW: winW - 0.15, glassH: winH - 0.15, windowXs,
    doorX: windowXs.length === 1 ? width * 0.26 : 0, doorW: Math.min(0.9, width * 0.32),
    chimney: !!(config.chimney && width >= 3),
    dormer: !!(config.dormer && width >= 3.6 && depth >= 4.4),
    uvFacade: [Math.max(width, 1) / 2, wallHeight / 2], uvRoof: [Math.max(width, 1) / 3, Math.max(depth, 1) / 3], uvFound: [Math.max(width, 1) / 2, 0.5],
    widthCells: config.widthCells, depthCells: config.depthCells, dimKey: `${config.widthCells}x${config.depthCells}`, porch: null,
  };
  if (hasPorch) {
    const wrap = config.porch.style === 'wraparound' && width >= 4;
    const porchWidth = wrap ? Math.min(width + 1.0, config.widthCells - 0.25) : Math.max(1.2, width * 0.55);
    L.porch = { wrap, style: wrap ? 'wraparound' : 'partial', key: wrap ? 'w' : 'p', depth: porchDepthC, width: porchWidth, colCount: wrap ? 6 : 4, uvDeck: [porchWidth / 1.5, porchDepthC / 1.5] };
  }
  return L;
}
// Chimney: top always clears the roof surface at its x by 0.85 m (the legacy formula ended exactly ON the roof
// surface, so the chimney was practically invisible).
function _chimneySpec(L) {
  const x = L.width * 0.3, hw = L.width / 2 + L.overhang;
  const roofAtX = L.ridgeHeight * Math.max(0, 1 - Math.abs(x) / hw);
  return { x, z: -L.depth * 0.2, cw: Math.min(0.7, L.width * 0.16), chH: L.wallHeight + roofAtX + 0.85 };
}

// ---- 9.5 House Archetypes ----------------------------------------------------------------------
export const HOUSE_ARCHETYPE_BASES = new Map(LOW_DENSITY_HOUSES.map((h) => [h.id, h]));
export const HOUSE_ARCHETYPES = new Map();
const DOOR_PRESETS = ['darkWood', 'rawWoodCedar', 'paintedBlueWood', 'paintedWhiteWood'];
const DOOR_STYLES = ['flat', 'paneled', 'lite'];

export function getHouseArchetype(w, d, variantIndex = 0) {
  const base = getLowDensityHouseConfigForCell(w, d, variantIndex);
  if (!base) return null;
  const id = `${base.id}@${w}x${d}`;
  if (HOUSE_ARCHETYPES.has(id)) return HOUSE_ARCHETYPES.get(id);
  const cfg = { ...base, widthCells: w, depthCells: d };
  const L = _lowDensityLayout(cfg);
  const arch = {
    id, baseId: base.id, sizeClass: base.sizeKey, w, d,
    facadeFamily: base.family, roofType: 'gable',
    windowStyle: L.windowXs.length === 2 ? 'double' : 'single', porchStyle: L.hasPorch ? L.porch.style : 'none',
    chimney: L.chimney, dormer: L.dormer, floors: L.floors,
    doorStyle: DOOR_STYLES[base.seed % DOOR_STYLES.length],
    materialRefs: { facade: base.facadeMaterial, roof: base.roofMaterial, foundation: base.foundationMaterial, deck: 'deckWood', chimney: 'brickRed',
      door: DOOR_PRESETS[(base.seed >> 1) % DOOR_PRESETS.length], trim: base.trimColor },
    layout: L, seed: base.seed, _lodParts: [null, null, null, null],
    // feature flags (Part 19/20): a house registers instances only for the features that are ON
    features: { porch: L.hasPorch, chimney: L.chimney, dormer: L.dormer, wraparound: L.hasPorch && L.porch.wrap },
  };
  HOUSE_ARCHETYPES.set(id, arch);
  return arch;
}

// ---- 9.6 LOD0: kit-of-parts recipe -------------------------------------------------------------
const _lp = new THREE.Vector3(), _ls = new THREE.Vector3(), _lq = new THREE.Quaternion(), _lY = new THREE.Vector3(0, 1, 0);
function _local(px, py, pz, sx = 1, sy = 1, sz = 1, yaw = 0) {
  return new THREE.Matrix4().compose(_lp.set(px, py, pz), yaw ? _lq.setFromAxisAngle(_lY, yaw) : _lq.identity(), _ls.set(sx, sy, sz));
}
function _matInfo(refs, role) {
  switch (role) {
    case 'facade': case 'roof': case 'foundation': case 'deck': case 'chimney': case 'door':
      return { matKey: `pbr:${refs[role]}`, material: getSharedPBRMaterial(refs[role]) };
    case 'trim': return { matKey: `solid:${refs.trim}`, material: _solid(refs.trim, { roughness: 0.65 }) };
    case 'glass': return { matKey: 'glass', material: _glassMaterial() };
    default: return { matKey: 'metal', material: _metalMaterial() }; // 'metal'
  }
}

function _lod0Parts(arch) {
  const L = arch.layout, refs = arch.materialRefs, zs = -L.frontExt / 2, list = [];
  const { width, depth, baseY, wallHeight, ridgeHeight, overhang } = L;
  const add = (part, g, role, local, tinted) => list.push({ part, geoKey: g.key, geometry: g.geometry, ..._matInfo(refs, role), local, tinted: !!tinted });
  const U = _unitBox();
  const unit = (part, role, x, y, z, sx, sy, sz) => add(part, U, role, _local(x, y, z + zs, sx, sy, sz), false);
  const topY = baseY + wallHeight, fz = depth / 2;

  // --- facade / siding, foundation, roof (+ facade-coloured gable ends)
  add('wall', _bodyMod(L), 'facade', _local(0, baseY, zs), true); // wall box + gable ends
  add('foundation', _boxMod(width + 0.2, baseY, depth + 0.2, L.uvFound[0], L.uvFound[1]), 'foundation', _local(0, baseY / 2, zs), true);
  add('roof', _gableSlopesMod(width, depth, ridgeHeight, overhang), 'roof', _local(0, topY, zs), true);

  // --- metal: gutters, downspouts, chimney cap, door handle
  const hw = width / 2 + overhang;
  [-1, 1].forEach((s) => {
    unit('gutter', 'metal', s * hw, topY + 0.02, 0, 0.07, 0.09, depth + overhang * 2);
    unit('downspout', 'metal', s * (width / 2 + 0.045), baseY + wallHeight / 2, -depth / 2 + 0.06, 0.06, wallHeight, 0.06);
  });
  // --- trim: corner boards
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([sx, sz]) => unit('corner', 'trim', sx * (width / 2 + 0.03), baseY + wallHeight / 2, sz * (depth / 2 + 0.03), 0.09, wallHeight, 0.09));

  // --- windows: frame + glass + mullions + sill (all the shared unit box; size lives in `local`)
  L.windowXs.forEach((x) => {
    unit('winframe', 'trim', x, L.winY, fz, L.winW, L.winH, 0.05);
    unit('glass', 'glass', x, L.winY, fz + 0.02, L.glassW, L.glassH, 0.08);
    unit('mullion', 'trim', x, L.winY, fz + 0.06, 0.035, L.glassH, 0.03);
    unit('mullion', 'trim', x, L.winY, fz + 0.06, L.glassW, 0.035, 0.03);
    unit('sill', 'trim', x, L.winY - L.winH / 2 - 0.03, fz + 0.06, L.winW + 0.16, 0.06, 0.16);
  });
  // --- door: frame (trim) + wood slab (3 shared styles) + handle (metal)
  unit('doorframe', 'trim', L.doorX, baseY + 1.0, fz, L.doorW + 0.16, 2.02, 0.05);
  add('door', _doorMod(L.doorW, arch.doorStyle), 'door', _local(L.doorX, baseY + 0.95, fz + 0.03 + zs), false);
  unit('handle', 'metal', L.doorX + L.doorW * 0.36, baseY + 0.95, fz + 0.085, 0.045, 0.14, 0.05);

  // --- chimney (only when ON)
  if (L.chimney) {
    const c = _chimneySpec(L);
    add('chimney', _boxMod(c.cw, c.chH, c.cw, 0.5, 1), 'chimney', _local(c.x, baseY + c.chH / 2, c.z + zs), true);
    unit('chimneycap', 'metal', c.x, baseY + c.chH + 0.04, c.z, c.cw + 0.12, 0.08, c.cw + 0.12);
  }
  // --- dormer (only when ON)
  if (L.dormer) {
    const dw = width * 0.28, dd = depth * 0.22, dh = 0.9, dY = baseY + wallHeight + ridgeHeight * 0.35, dz = depth * 0.18;
    add('dormerwall', _dormerBodyMod(dw, dd, dh, L.uvFacade), 'facade', _local(0, dY, dz + zs), true); // dormer box + its gable ends
    add('dormerroof', _gableSlopesMod(dw, dd, dh * 0.6, 0.1), 'roof', _local(0, dY + dh / 2, dz + zs), true);
    unit('winframe', 'trim', 0, dY, dz + dd / 2 + 0.01, 0.62, 0.62, 0.05);
    unit('glass', 'glass', 0, dY, dz + dd / 2 + 0.03, 0.5, 0.5, 0.06);
  }
  // --- porch (only when ON): deck, roof, columns, steps, railings
  if (L.hasPorch) {
    const p = L.porch, pz = fz + p.depth / 2, deckTop = baseY + 0.155;
    add('deck', _boxMod(p.width, 0.15, p.depth, p.uvDeck[0], p.uvDeck[1]), 'deck', _local(0, baseY + 0.08, pz + zs), true);
    add('porchroof', _boxMod(Math.min(p.width + 0.3, L.widthCells), 0.12, p.depth + 0.3, L.uvRoof[0], L.uvRoof[1]), 'roof', _local(0, baseY + 2.4, pz + zs), true);
    const colZ = fz + p.depth - 0.1, col = _columnMod();
    for (let i = 0; i < p.colCount; i++) add('column', col, 'trim', _local(-p.width / 2 + (i / (p.colCount - 1)) * p.width, baseY + 1.25, colZ + zs), false);
    add('steps', _stairsMod(Math.min(1.2, p.width * 0.8), L.stepCountC), 'foundation', _local(0, baseY, fz + p.depth + zs), true);
    // railings: between columns on the front (entrance bay left open) + both sides of a wraparound porch
    const seg = p.width / (p.colCount - 1), rl = _q(seg - 0.16);
    for (let i = 0; i < p.colCount - 1; i++) {
      const xm = -p.width / 2 + (i + 0.5) * seg;
      if (Math.abs(xm) < seg * 0.6) continue;
      add('railing', _railMod(rl), 'trim', _local(xm, deckTop, colZ + zs), false);
    }
    if (p.wrap) [-1, 1].forEach((s) => add('railing', _railMod(_q(p.depth - 0.25)), 'trim', _local(s * (p.width / 2 - 0.05), deckTop, fz + p.depth / 2 - 0.05 + zs, 1, 1, 1, Math.PI / 2), false));
  }
  return list;
}

// ---- 9.7 LOD1..3: UNIT geometry + per-part local matrix ---------------------------------------
// From LOD1 on the body parts are UNIT boxes / a UNIT gable prism shared by every house of every
// size; the size is applied by a per-part local matrix. Bucket count is then independent of how many
// sizes / variants are on the map (only the material varies).
function _unitBoxGeo(uvx, uvy) { return _boxMod(1, 1, 1, uvx, uvy); }
function _unitGableGeo(uvx, uvy) {
  return _geo(`unit|gable|${uvx}x${uvy}`, () => {
    const shape = new THREE.Shape(); shape.moveTo(-0.5, 0); shape.lineTo(0, 1); shape.lineTo(0.5, 0); shape.lineTo(-0.5, 0);
    const g = new THREE.ExtrudeGeometry(shape, { depth: 1, bevelEnabled: false, curveSegments: 1 });
    g.translate(0, 0, -0.5); g.computeVertexNormals(); return _scaleUV(g, uvx, uvy);
  });
}
const _flatRGB = (preset) => { const c = new THREE.Color(FLAT_COLOR[preset] ?? 0xcccccc); return [c.r, c.g, c.b]; };

function _unitParts(arch, lod) {
  const L = arch.layout, refs = arch.materialRefs, zs = -L.frontExt / 2;
  const { width, depth, baseY, wallHeight, ridgeHeight } = L;
  const list = [];
  const add = (part, g, matInfo, local, tinted, extra) => list.push({ part, geoKey: g.key, geometry: g.geometry, ...matInfo, local, tinted, ...extra });
  const pbr = (k) => ({ matKey: `pbr:${k}`, material: getSharedPBRMaterial(k) });
  const facadeMat = lod === 1 ? pbr(refs.facade) : lod === 2 ? { matKey: `lite:${refs.facade}`, material: getSharedLiteMaterial(refs.facade) } : { matKey: 'flat:white', material: _solid(0xffffff, { roughness: 0.9 }) };
  const roofMat = lod === 1 ? pbr(refs.roof) : lod === 2 ? { matKey: `lite:${refs.roof}`, material: getSharedLiteMaterial(refs.roof) } : { matKey: 'flat:white', material: _solid(0xffffff, { roughness: 0.9 }) };
  const wallColor = lod === 3 ? { color: _flatRGB(refs.facade) } : null, roofColor = lod === 3 ? { color: _flatRGB(refs.roof) } : null;
  const roofLocal = _local(0, baseY + wallHeight, zs, width + L.overhang * 2, ridgeHeight, depth + L.overhang * 2);
  if (lod === 1) {
    add('wall', _unitBoxGeo(2, 1.45), facadeMat, _local(0, baseY + wallHeight / 2, zs, width, wallHeight, depth), true);
    add('roof', _unitGableGeo(1.5, 1.5), roofMat, roofLocal, true);
    add('foundation', _unitBoxGeo(2, 0.5), pbr(refs.foundation), _local(0, baseY / 2, zs, width + 0.2, baseY, depth + 0.2), true);
    if (L.hasPorch) {
      const p = L.porch;
      add('deck', _unitBoxGeo(2, 1), pbr(refs.deck), _local(0, baseY + 0.08, depth / 2 + p.depth / 2 + zs, p.width, 0.15, p.depth), true);
      add('porchroof', _unitBoxGeo(1.5, 1.5), roofMat, _local(0, baseY + 2.4, depth / 2 + p.depth / 2 + zs, Math.min(p.width + 0.3, L.widthCells), 0.12, p.depth + 0.3), true);
    }
    if (L.chimney) { const c = _chimneySpec(L); add('chimney', _unitBoxGeo(0.5, 1), pbr(refs.chimney), _local(c.x, baseY + c.chH / 2, c.z + zs, c.cw, c.chH, c.cw), true); }
    // windows + door: instances of the ONE shared unit box (no size-specific geometry at any LOD)
    const U = _unitBox(), gm = { matKey: 'glass', material: _glassMaterial() };
    L.windowXs.forEach((x) => add('glass', U, gm, _local(x, L.winY, depth / 2 + 0.02 + zs, L.glassW, L.glassH, 0.08), false));
    add('door', U, { matKey: `flat:${refs.door}`, material: _flatMaterial(refs.door) }, _local(L.doorX, baseY + 0.95, depth / 2 + 0.02 + zs, L.doorW, 1.9, 0.08), false);
  } else { // LOD2 / LOD3: body reaches the ground (no foundation part), roof, (LOD2) porch roof
    const h = baseY + wallHeight;
    add('wall', _unitBoxGeo(2, 1.6), facadeMat, _local(0, h / 2, zs, width, h, depth), true, wallColor);
    add('roof', _unitGableGeo(1.5, 1.5), roofMat, roofLocal, true, roofColor);
    if (lod === 2 && L.hasPorch) {
      const p = L.porch;
      add('porchroof', _unitBoxGeo(1.5, 1.5), roofMat, _local(0, baseY + 2.4, depth / 2 + p.depth / 2 + zs, Math.min(p.width + 0.3, L.widthCells), 0.12, p.depth + 0.3), true);
    }
  }
  return list;
}

/** Renderable module instances of an archetype at one LOD (cached on the archetype). */
export function getHouseLodParts(arch, lod) {
  if (arch._lodParts[lod]) return arch._lodParts[lod];
  return (arch._lodParts[lod] = lod === 0 ? _lod0Parts(arch) : _unitParts(arch, lod));
}
/** Build + cache every LOD of one archetype (call ahead of a bulk placement so no frame pays for it). */
export function prewarmHouseArchetype(arch, lods = [0, 1, 2, 3]) { lods.forEach((l) => getHouseLodParts(arch, l)); return arch; }

export function getHouseGeometryStats() {
  const kinds = {};
  HOUSE_GEOMETRY_CACHE.forEach((_, k) => { const t = k.split('|')[0]; kinds[t] = (kinds[t] || 0) + 1; });
  return {
    geometryCount: HOUSE_GEOMETRY_CACHE.size, archetypeCount: HOUSE_ARCHETYPES.size, baseDesignCount: HOUSE_ARCHETYPE_BASES.size,
    geometryHit: HOUSE_STATS.geometryHit, geometryMiss: HOUSE_STATS.geometryMiss, geometryCreated: HOUSE_STATS.geometryCreated,
    geometryCreateMs: +HOUSE_STATS.geometryCreateMs.toFixed(3), geometryKinds: kinds,
  };
}