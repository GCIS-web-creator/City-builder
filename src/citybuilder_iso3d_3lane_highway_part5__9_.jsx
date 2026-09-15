import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import * as THREE from 'three';

const GRID_SIZE = 64;
const TILE = 6;
const MAX_LEVEL = 3;
const GROW_CHANCE = 0.16;

const TILE_EMPTY = 0;
const TILE_ROAD = 1;
const TILE_RES = 2;
const TILE_COM = 3;
const TILE_IND = 4;
// Education facilities are NOT a zone type (isZoneType() below intentionally excludes this) — a
// dedicated grid value keeps them out of zone painting/dezoning/growth entirely while still
// marking their cells non-empty for road/lot/other-facility collision checks.
const TILE_EDU = 5;

const INCOME_PER_POP = 2;
const INCOME_PER_JOB = 1.5;
const ROAD_UPKEEP = 1;
const BUILDING_UPKEEP = 0.6;
const START_TREASURY = 5000;

const NUM_CARS = 18;
const NUM_PEDS = 45;
const CAR_SPEED = 9;
// The "standard" road speed (km/h) that CAR_SPEED (world units/sec) represents — every road
// type's actual driving speed is scaled against this baseline via speedForRoadType() below, so a
// 'two' road (maxSpeed 50) drives at exactly CAR_SPEED (unchanged legacy behavior) while a highway
// (maxSpeed 100) drives at 2x that, a 'small' road (maxSpeed 30) drives slower, etc. — see
// requirement #14 ("道路によって速度差が出るようにしてください").
const BASE_ROAD_SPEED_KMH = 50;
// how long (seconds) the game enforces between two external-highway-gate car spawns, so traffic
// doesn't all flood in on the same frame the instant a gate segment clears (requirement #13).
const EXTERNAL_SPAWN_MIN_INTERVAL = 0.45;
const PED_SPEED = 2.3;
const CAR_LANE = TILE * 0.16;
// Standard physical width of ONE lane on a 3+ lane road (world units), used by getRoadLayout.
// This is a fixed target — NOT "carriageway / lane count" — specifically so that adjacent
// same-direction lanes on 4/6/8-lane roads sit as close together as a real lane actually needs
// to be, instead of stretching to fill whatever width hubMul happens to give the road. Any
// carriageway width left over after packing lanes/2 lanes at this width becomes an outer
// shoulder margin (between the outermost lane and the curb) rather than being divided into the
// lanes themselves — see getRoadLayout. Tightening THIS single constant (not a per-car offset
// multiplier) is what narrows the visual gap between neighboring lanes' traffic everywhere at
// once: car driving lines, painted dividers, and curves.
const STANDARD_LANE_WIDTH = TILE * 0.235;
const PED_LANE = TILE * 0.47;
const CAR_ACCEL = 10;
const CAR_BRAKE = 15;
const CAR_TURN_SPEED_MULT = 0.42;
// how long (seconds), after finishing a turn, the car's speed target eases back up from turn
// speed to full speed rather than jumping straight back to CAR_SPEED the instant the corner
// bezier ends — this is what stops the "sudden burst of acceleration right after the curve".
const TURN_EXIT_EASE = 0.9;
// -- car following / intersection queueing --
// gaps are expressed in "segment fractions" (1.0 = one full tile length along the car's path),
// same unit as car.t, so they can be compared directly against it.
const CAR_FOLLOW_HARD_GAP = 0.24; // closer than this -> hold station right behind the car ahead
const CAR_FOLLOW_SOFT_GAP = 0.5; // closer than this -> start easing off the throttle

// -- smooth cornering --
// Started much earlier in the segment (was 0.62) so the arc through a turn is long and gradual
// instead of being compressed into the last ~38% of the segment, which is what made turns look
// like a sudden kink/elbow rather than a smooth curve.
const CORNER_START = 0.32; // fraction of segment t where the corner blend begins
const CORNER_MIRROR = 1 - CORNER_START; // matching fraction into the next segment

// -- road geometry (hub + arm auto-tiling, sidewalk always present) --
//
// Vertical stack (bottom -> top): sidewalk slab -> curb rim -> asphalt road.
// The old code stacked these the wrong way (sidewalk top sat ABOVE the road top), so the
// pale sidewalk box fully hid the dark asphalt underneath it and the game only ever showed
// a bright "floor" with cars floating on it. Every Y below is now derived from the actual
// surface heights so the asphalt is guaranteed to sit above the sidewalk, with a visible
// curb step in between.
const SIDEWALK_H = 0.34; // sidewalk slab thickness (box centered on y=0, like before)
const CURB_H = 0.09; // curb rim thickness, sits directly on top of the sidewalk
const ROAD_H = 0.22; // asphalt slab thickness, sits directly on top of the curb
const SIDEWALK_TOP_Y = SIDEWALK_H / 2; // top face of the sidewalk slab
const CURB_TOP_Y = SIDEWALK_TOP_Y + CURB_H; // top face of the curb rim
const CURB_Y = SIDEWALK_TOP_Y + CURB_H / 2; // curb slab center
const ROAD_Y = CURB_TOP_Y + ROAD_H / 2; // asphalt slab center — clearly above the sidewalk now
const ROAD_TOP_Y = CURB_TOP_Y + ROAD_H; // asphalt surface — this is what cars/signals/gates rest on

// road width: independent of the sidewalk footprint so pavement is always visible on both sides.
// HUB_HALF * 2 = the *baseline* (2-lane "two" type, hubMul 1.0) road width -> 0.34*2 = 68% of a
// tile, leaving a clear sidewalk margin on every side (see ROAD_TYPES[].hubMul for other widths).
const HUB_HALF = TILE * 0.34;
const SIDEWALK_HALF = TILE * 0.49; // half-width of the sidewalk slab (matches sidewalkGeo below)
const CURB_MARGIN = TILE * 0.045; // how far the curb peeks out past the asphalt edge, per side (clamped so it never pokes past the sidewalk — see roadHalfWidth())

const CAR_GROUND_Y = ROAD_TOP_Y; // vehicles rest on the actual road surface, not on a bare y=0 plane
const PED_GROUND_Y = SIDEWALK_TOP_Y; // pedestrians rest on the actual sidewalk surface
const PED_SCALE = 0.5;

// -- terrain layer (Prompt 2 of the Tile->World Space migration) --
// Flat dummy implementation: always returns the same values the game already assumed
// everywhere (Y=0, straight-up normal, zero slope), so wiring these in changes nothing
// about current behavior. Once real heightfield data exists, only these three functions
// need to change — every call site below already goes through them.
function terrainHeight(x, z) { return 0; }
function terrainNormal(x, z) { return { x: 0, y: 1, z: 0 }; }
function terrainSlope(x, z) { return 0; }

// how far (world units), on EACH side of a tile boundary, the asphalt width blends from one road
// type's width to another's when two different road types meet — see armGeoShortByType /
// makeTaperPrismGeometry below. Clamped per-type against that type's own arm length so it can
// never eat into (or past) the hub.
const ROAD_TAPER_HALF = TILE * 0.16;

// Builds a trapezoidal prism: a box-like solid whose cross-section width blends linearly from
// `nearHalfW` (at local z=0) to `farHalfW` (at local z=length), used as the connector piece
// between two road types of different widths so the pavement visually narrows/widens across the
// tile boundary instead of jumping straight from one width to the other. Winding isn't hand-
// verified face-by-face, so callers should render this with a double-sided material — a stray
// backwards face would otherwise vanish instead of just shading oddly.
function makeTaperPrismGeometry(nearHalfW, farHalfW, length, height) {
  const hy = height / 2;
  const v = [
    -nearHalfW, hy, 0, nearHalfW, hy, 0, farHalfW, hy, length, -farHalfW, hy, length, // 0-3 top
    -nearHalfW, -hy, 0, nearHalfW, -hy, 0, farHalfW, -hy, length, -farHalfW, -hy, length, // 4-7 bottom
  ];
  const idxArr = [
    0, 2, 1, 0, 3, 2, // top
    4, 5, 6, 4, 6, 7, // bottom
    0, 1, 5, 0, 5, 4, // near face (z=0)
    3, 7, 6, 3, 6, 2, // far face (z=length)
    0, 4, 7, 0, 7, 3, // left face
    1, 2, 6, 1, 6, 5, // right face
  ];
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  geo.setIndex(idxArr);
  geo.computeVertexNormals();
  return geo;
}

// half-width of the asphalt + how far the curb should extend beyond it, for a given road type's
// hubMul. Clamped so hub+curb geometry can never be wider than the sidewalk slab underneath it.
function roadHalfWidth(hubMul) {
  const rhw = HUB_HALF * hubMul;
  const curbMargin = Math.max(0, Math.min(CURB_MARGIN, (SIDEWALK_HALF - rhw) * 0.55));
  return { rhw, curbHalf: rhw + curbMargin };
}

// ============================================================================
// RoadLayout — SINGLE SOURCE OF TRUTH for a road type's physical cross-section.
//
// Every system that needs to know "where is the pavement edge / where is the median / where is
// lane N's centerline / where is the divider BETWEEN lane N and lane N+1" (road-paint textures,
// car lane offsets, pedestrian sidewalk offsets, building/zone footprint checks) derives those
// numbers from THIS function instead of recomputing them locally. That is what keeps the painted
// lane lines, the car's driving line, and the road's collision footprint from drifting apart as
// lane counts / medians change — car position == laneCenters[i], dash position == laneDividers[i]
// (the literal midpoint between two adjacent laneCenters), always, on straight AND curved
// segments alike (see drawRoadPaint / makeAsphaltCurveTexture / segPoint / pickForwardLaneOffset,
// all of which read from this same object).
//
// Model: the paved half-width (rhw, from roadHalfWidth) is the asphalt from the centerline out to
// one edge. A median (when present) is a physical strip that eats into that half-width from the
// centerline outward — it is NOT one of the lanes, and lane centers are never placed inside it.
// What remains after subtracting the median (the "carriageway") holds `lanes/2` lanes for that
// side, each STANDARD_LANE_WIDTH wide — a fixed target width, not "carriageway / lane count" —
// so adjacent same-direction lanes sit only as far apart as a real lane needs to be, instead of
// stretching to fill whatever width hubMul happens to give the road (this is what keeps
// neighboring cars from drifting apart on wide roads without touching any per-car offset). Any
// leftover carriageway width becomes an outer shoulder margin between the outermost lane and the
// curb, not extra lane width. The other side of the road is the exact mirror image. Roads with
// <3 lanes (small/two/dirt) keep the original fixed single CAR_LANE offset, via the `legacy` flag.
// ============================================================================
function getRoadLayout(rt) {
  const { rhw, curbHalf } = roadHalfWidth(rt.hubMul);
  if (!rt.lanes || rt.lanes < 3) {
    // legacy 1-lane-each-way roads: exactly the original behavior (fixed CAR_LANE offset).
    return {
      rhw, curbHalf, median: false, medianHalfWidth: 0,
      lanesPerSide: 1, laneWidth: null, laneCenters: [CAR_LANE], laneDividers: [], legacy: true,
    };
  }
  const lanesPerSide = rt.lanes / 2;
  // Median is a real physical strip carved OUT of the paved half-width, sized as a fraction of
  // that half-width (so it scales with 4/6/8-lane roads) but clamped to sane world-unit bounds.
  // Carving it out of rhw — rather than adding it on top — is what keeps the asphalt's total
  // physical width (rhw, used everywhere else: hub/arm geometry, curb, overhang) unchanged by
  // whether a road happens to have a median, while still guaranteeing lane centers never land
  // inside it.
  const medianHalfWidth = rt.median ? Math.max(TILE * 0.05, Math.min(rhw * 0.24, TILE * 0.16)) : 0;
  const carriagewayWidth = Math.max(0.01, rhw - medianHalfWidth);
  // fixed per-lane width, never wider than what the carriageway can actually fit (guards against
  // a pathologically narrow custom road type) — the rest of the carriageway becomes shoulder.
  const laneWidth = Math.min(STANDARD_LANE_WIDTH, carriagewayWidth / lanesPerSide);
  const laneCenters = [];
  for (let k = 0; k < lanesPerSide; k++) laneCenters.push(medianHalfWidth + laneWidth * (k + 0.5));
  // laneDividers[i] = the boundary between laneCenters[i] and laneCenters[i+1] — computed
  // literally as their midpoint (never inferred separately), so the painted line is guaranteed to
  // fall exactly between the two lanes it separates, on straight roads and through curves alike.
  // There is deliberately no divider between the median and laneCenters[0]: the median itself
  // (drawn separately, see drawRoadPaint) is what marks that boundary, not a lane dash.
  const laneDividers = [];
  for (let k = 0; k < laneCenters.length - 1; k++) laneDividers.push((laneCenters[k] + laneCenters[k + 1]) / 2);
  return { rhw, curbHalf, median: !!rt.median, medianHalfWidth, lanesPerSide, laneWidth, laneCenters, laneDividers, legacy: false };
}

// -- lane geometry (drives BOTH the road-paint texture split above and the actual car lane
// offsets below, from one source — getRoadLayout — so the painted lines and the car positions
// always agree) --
// For roads with <3 lanes we keep the original single fixed CAR_LANE offset (one lane each way)
// so "two"/"small"/"dirt" behavior is untouched. For roads with 3+ lanes, the CARRIAGEWAY half-
// width (paved half-width MINUS any median) is split into `lanes/2` equal-width lanes per side.
function laneSpacingFor(rt) {
  const layout = getRoadLayout(rt);
  return layout.legacy ? CAR_LANE * 2 : layout.laneWidth;
}
// Returns the usable lane offsets for a road type with 3+ lanes, as positive-magnitude distances
// from the centerline, one lane-width apart, ALREADY PUSHED OUT PAST ANY MEDIAN — a SYMMETRIC
// split (rt.lanes/2 lanes per direction, e.g. 4-lane = 2 each way). Both directions of travel use
// the exact same set of magnitudes (see pickForwardLaneOffset): offsets are meant to be multiplied
// by a travel-direction-relative perpendicular vector (see segPoint), so "own right, small
// distance" == inner lane and "own right, large distance" == outer lane, for either direction.
// Returns null for <3 lane roads (legacy single-offset roads), matching previous behavior.
function laneOffsetGroups(rt) {
  const layout = getRoadLayout(rt);
  if (layout.legacy) return null;
  return { spacing: layout.laneWidth, offsets: layout.laneCenters, medianHalfWidth: layout.medianHalfWidth };
}
// Picks a lane offset (a signed-by-direction scalar, see segPoint) for an entity about to drive
// the given typeKey road. For <3-lane roads this always returns the original fixed CAR_LANE,
// matching pre-existing behavior exactly. For 3+ lane (symmetric) roads, `currentOffset`, when
// given, is the entity's lane offset on the segment it's leaving — the candidate closest to it is
// chosen instead of a random one, so a lane change across a road-type boundary continues from
// roughly where the vehicle already was instead of jumping to an arbitrary lane.
function pickForwardLaneOffset(typeKey, axisSign, flipBit, currentOffset) {
  // 'small' roads are single-lane one-way streets — there is no opposing lane to stay clear of,
  // so drive along the physical center of the pavement instead of offset toward one edge.
  if (typeKey === 'small') return 0;
  const rt = ROAD_TYPES[typeKey];
  const groups = laneOffsetGroups(rt);
  if (!groups) return CAR_LANE;
  const options = groups.offsets;
  if (options.length === 1) return options[0];
  if (currentOffset === undefined || currentOffset === null) {
    return options[Math.floor(Math.random() * options.length)];
  }
  const curMag = Math.abs(currentOffset);
  let best = options[0], bestDist = Infinity;
  options.forEach((o) => { const d = Math.abs(o - curMag); if (d < bestDist) { bestDist = d; best = o; } });
  return best;
}

// -- road types (first pass: cost / lanes / max speed / width+color only — land-value + noise come later) --
// `median: true` roads have NO edge pedestrian margin — the paved width is fully occupied by
// carriageway plus a raised centre median (people/vehicles cannot cross at the median; elevated
// road pillars and tram tracks can be placed there instead). `edgeWalk: true` roads keep a real
// pedestrian sidewalk on both outer edges even though they also have a median (only the widest
// 8-lane road does this — see spec).
const ROAD_TYPES = {
  small: { id: 'small', label: '小さな道路', cost: 8, lanes: 1, maxSpeed: 30, hubMul: 0.70, unpaved: false, median: false, edgeWalk: true, color: '#33383e', shoulder: '#22262b' },
  two: { id: 'two', label: '2車線道路', cost: 15, lanes: 2, maxSpeed: 50, hubMul: 1.0, unpaved: false, median: false, edgeWalk: true, color: '#33383e', shoulder: '#22262b' },
  four: { id: 'four', label: '4車線道路', cost: 32, lanes: 4, maxSpeed: 60, hubMul: 1.76, unpaved: false, median: false, edgeWalk: true, color: '#33383e', shoulder: '#22262b' },
  four_median: { id: 'four_median', label: '中央分離帯付き4車線道路', cost: 40, lanes: 4, maxSpeed: 50, hubMul: 1.76, unpaved: false, median: true, edgeWalk: false, color: '#33383e', shoulder: '#22262b' },
  six: { id: 'six', label: '6車線道路', cost: 55, lanes: 6, maxSpeed: 50, hubMul: 2.647, unpaved: false, median: false, edgeWalk: true, color: '#33383e', shoulder: '#22262b' },
  six_median: { id: 'six_median', label: '中央分離帯付き6車線道路', cost: 65, lanes: 6, maxSpeed: 60, hubMul: 2.647, unpaved: false, median: true, edgeWalk: false, color: '#33383e', shoulder: '#22262b' },
  eight_median: { id: 'eight_median', label: '中央分離帯付き8車線道路', cost: 90, lanes: 8, maxSpeed: 60, hubMul: 3.235, unpaved: false, median: true, edgeWalk: true, color: '#33383e', shoulder: '#22262b' },
  dirt: { id: 'dirt', label: '未舗装路', cost: 4, lanes: 1, maxSpeed: 20, hubMul: 0.66, unpaved: true, median: false, edgeWalk: true, color: '#8a6a45', shoulder: '#6b4f30' },
  // -- 高速道路 (highway) — see 【追加仕様：外部都市からの流入交通システム】 --
  // Not just "a fast road": this is the game's designated connection to the outside world. It is
  // ALWAYS present from map edge inward at game start (see the initial-grid setup in the main
  // effect below), external traffic spawns/despawns only through tiles of this type sitting on
  // the map border (see computeHighwayGates), `highway: true` is what hasConnectedRoadNeighbor()
  // reads to refuse it as valid zone/building frontage (real highways have no direct residential
  // driveways — access must go through an ordinary road, i.e. a simple IC/interchange stub), and
  // `edgeWalk: false` means it has no pedestrian sidewalk at all (no walking on the highway).
  // maxSpeed 100 vs the 'two' road's 50 baseline is exactly the "2x" the spec calls for, and this
  // number is what actually drives vehicle speed now — see speedForRoadType() below.
  highway: { id: 'highway', label: '高速道路', cost: 60, lanes: 4, maxSpeed: 100, hubMul: 1.76, unpaved: false, median: true, edgeWalk: false, color: '#262b30', shoulder: '#1a1e22', highway: true },
};
const ROAD_TYPE_KEYS = ['small', 'two', 'four', 'four_median', 'six', 'six_median', 'eight_median', 'dirt', 'highway']; // index in this array == the value stored in the roadType grid
const DEFAULT_ROAD_TYPE_IDX = ROAD_TYPE_KEYS.indexOf('two');
// Converts a road type's nominal maxSpeed (km/h) into the actual world-units/sec a vehicle should
// drive at on that road, scaled against CAR_SPEED @ BASE_ROAD_SPEED_KMH (see comment there). This
// is the SINGLE place "how fast does this road type actually drive" is answered — the car update
// loop and any future agent (transit, freight, ...) should read speed through this, not CAR_SPEED
// directly, so adding new road types (JCT ramps, expressways, etc.) automatically gets correct
// speed behavior for free (requirement #3: "今後道路タイプを追加した場合にも扱いやすいように").
function speedForRoadType(rt) {
  return CAR_SPEED * (rt.maxSpeed / BASE_ROAD_SPEED_KMH);
}

// how far (in tile units, one side) a road type's pavement extends beyond the standard 1-tile
// cell it's painted on. Roads wider than 1 tile (hubMul such that rhw*2 > TILE) reserve this much
// extra space on EACH side as road-occupied ground: no zone/building/planting may be placed there,
// and this same figure is what building-placement/adjacency, pedestrian paths and vehicle paths
// should treat as the road's real footprint instead of the bare 1-tile grid cell.
function roadOverhangTiles(hubMul) {
  const { rhw } = roadHalfWidth(hubMul);
  return Math.max(0, (rhw * 2 - TILE) / 2 / TILE);
}

// getRoadFootprintHalfWidth: the SAME rhw (paved half-width, world units) that drives hub/arm
// geometry, car lanes, and road paint, exposed under one name for building/zone placement checks
// (see roadTypeOverhangs / tileBlockedByRoadFootprint below) so "how wide is this road, physically"
// is answered identically everywhere instead of each caller re-deriving it (see requirement #21).
function getRoadFootprintHalfWidth(rt) {
  return roadHalfWidth(rt.hubMul).rhw;
}

// ============================================================================
// Free Road Network (World Space) — RoadNode / RoadSegment data model + curve API.
//
// This is the new "road = free World Space geometry" system (Prompt 3 of the
// Tile->World Space migration). It is additive: nothing below reads or writes gridRef /
// roadTypeRef / intersectionTypeRef / idx(tx,ty) — the old Tile-road system is untouched
// and keeps driving existing cars/pedestrians/buildings exactly as before. Road *shape*
// (position, curve, elevation) is authored and stored here in World Space units, not as a
// Tile column. Every existing ROAD_TYPES / getRoadLayout / roadHalfWidth /
// getRoadFootprintHalfWidth / laneOffsetGroups / pickForwardLaneOffset function above is
// reused as-is for cross-section (lane count, width, median) — only the CENTERLINE that
// those lane offsets get applied to is now a curve in World Space instead of a tile axis.
// ============================================================================
let _roadNetworkIdCounter = 1;
function makeRoadNode(x, y, z) {
  return { id: `n${_roadNetworkIdCounter++}`, position: { x, y, z }, connectedSegmentIds: [] };
}
// opts: { roadType, curve: null | {controlPoint:{x,y,z}}, elevation: {start,end} }
function makeRoadSegment(startNodeId, endNodeId, opts = {}) {
  const roadType = opts.roadType && ROAD_TYPES[opts.roadType] ? opts.roadType : 'two';
  return {
    id: `s${_roadNetworkIdCounter++}`,
    startNodeId, endNodeId,
    roadType,
    curve: opts.curve || null, // null = straight segment; otherwise a quadratic-bezier control point
    elevation: opts.elevation || { start: 0, end: 0 }, // world-unit offset ABOVE terrainHeight at each end
    lanes: ROAD_TYPES[roadType].lanes,
    width: getRoadFootprintHalfWidth(ROAD_TYPES[roadType]) * 2,
  };
}
function addRoadNodeToNetwork(network, node) { network.nodes.set(node.id, node); return node; }
function addRoadSegmentToNetwork(network, segment) {
  network.segments.set(segment.id, segment);
  const a = network.nodes.get(segment.startNodeId), b = network.nodes.get(segment.endNodeId);
  if (a) a.connectedSegmentIds.push(segment.id);
  if (b) b.connectedSegmentIds.push(segment.id);
  return segment;
}

// -- curve evaluation API — every consumer (rendering, and eventually Vehicles) goes through
// these instead of re-deriving centerline math, so the curve shape/width/lanes never drift
// apart between what's drawn and what's driven on. --
function _roadNodes(network, segment) {
  return { a: network.nodes.get(segment.startNodeId), b: network.nodes.get(segment.endNodeId) };
}
function _roadElevationY(nodePos, elevAtEnd) { return terrainHeight(nodePos.x, nodePos.z) + elevAtEnd; }
function getRoadPoint(network, segment, t) {
  const { a, b } = _roadNodes(network, segment);
  const ya = _roadElevationY(a.position, segment.elevation.start);
  const yb = _roadElevationY(b.position, segment.elevation.end);
  const y = ya + (yb - ya) * t;
  if (segment.curve && segment.curve.controlPoint) {
    const c = segment.curve.controlPoint, omt = 1 - t;
    return {
      x: omt * omt * a.position.x + 2 * omt * t * c.x + t * t * b.position.x,
      y,
      z: omt * omt * a.position.z + 2 * omt * t * c.z + t * t * b.position.z,
    };
  }
  return { x: a.position.x + (b.position.x - a.position.x) * t, y, z: a.position.z + (b.position.z - a.position.z) * t };
}
function getRoadTangent(network, segment, t) {
  const { a, b } = _roadNodes(network, segment);
  let dx, dz;
  if (segment.curve && segment.curve.controlPoint) {
    const c = segment.curve.controlPoint, omt = 1 - t;
    dx = 2 * omt * (c.x - a.position.x) + 2 * t * (b.position.x - c.x);
    dz = 2 * omt * (c.z - a.position.z) + 2 * t * (b.position.z - c.z);
  } else {
    dx = b.position.x - a.position.x; dz = b.position.z - a.position.z;
  }
  const len = Math.hypot(dx, dz) || 1;
  return { x: dx / len, y: 0, z: dz / len };
}
function getRoadNormal(network, segment, t) {
  const tan = getRoadTangent(network, segment, t);
  return { x: -tan.z, y: 0, z: tan.x }; // left-hand normal in the XZ plane
}
function getRoadWidth(segment) { return getRoadFootprintHalfWidth(ROAD_TYPES[segment.roadType]) * 2; }
// laneIndex convention: 0..lanesPerSide-1 = one direction (positive normal offset),
// lanesPerSide..2*lanesPerSide-1 = the opposing direction (negative normal offset) — matches the
// magnitude convention already used by laneOffsetGroups()/pickForwardLaneOffset() above.
function getRoadLaneCenter(network, segment, laneIndex, t) {
  const layout = getRoadLayout(ROAD_TYPES[segment.roadType]);
  const centers = layout.laneCenters;
  const mag = centers[laneIndex % centers.length];
  const sign = laneIndex < centers.length ? 1 : -1;
  const p = getRoadPoint(network, segment, t), n = getRoadNormal(network, segment, t);
  return { x: p.x + n.x * mag * sign, y: p.y, z: p.z + n.z * mag * sign };
}
// Builds a flat ribbon Mesh geometry for a segment's full paved width, following its curve —
// left/right edges are the centerline offset by ±getRoadWidth(segment)/2 along getRoadNormal(t),
// so a curved segment's asphalt stays a CONSTANT width along its whole length (never widens or
// narrows through the bend, since every cross-section uses the same halfW).
function buildRoadSegmentGeometry(network, segment, subdivisions = 20) {
  const halfW = getRoadWidth(segment) / 2;
  const positions = [], uvs = [];
  for (let i = 0; i <= subdivisions; i++) {
    const t = i / subdivisions;
    const p = getRoadPoint(network, segment, t), n = getRoadNormal(network, segment, t);
    positions.push(p.x + n.x * halfW, p.y + 0.015, p.z + n.z * halfW);
    positions.push(p.x - n.x * halfW, p.y + 0.015, p.z - n.z * halfW);
    uvs.push(0, t, 1, t);
  }
  const indices = [];
  for (let i = 0; i < subdivisions; i++) {
    const a = i * 2, b = i * 2 + 1, c = (i + 1) * 2, d = (i + 1) * 2 + 1;
    indices.push(a, c, b, b, c, d);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ============================================================================
// Roadside Land / Parcel system (Prompt 4 of the Tile->World Space migration).
//
// Land is derived from the free RoadSegment network's actual geometry — distance to the
// nearest road, which side, how far along it — NEVER from a Tile grid, and NEVER from
// "does this Tile have a road Tile to its N/E/S/W". A point in World Space either sits on
// the road's real paved Footprint (getRoadFootprintHalfWidth — the SAME half-width that
// drives hub/arm geometry, car lanes and road paint, so land and pavement can never drift
// apart), or it sits in one of 8 roadside distance BANDS beyond that footprint. Bands are a
// distance measure, not a Tile index — they follow the road's curve exactly because every
// query below is answered against getRoadPoint/getRoadNormal at the road's OWN closest t,
// not against a straight-line projection.
//
// This was purely additive as of Prompt 4: nothing here read gridRef/lotIdGridRef, and nothing in
// the old Tile-lot system (tileBlockedByRoadFootprint / hasConnectedRoadNeighbor / lotHasRoadAccess
// / clampLotSize / updateLotPreview / finalizeLot) was touched. Prompt 5 is that "future Prompt":
// building placement (lotHasRoadAccess / findLotFrontage, defined further down, near
// pickTerraceOrientation) now DOES query this layer (getRoadFrontage) for real frontage-edge
// detection, alongside the old Tile-grid road network — both road systems coexist, so a Building
// can front either kind.
// ============================================================================
const ROADSIDE_BAND_COUNT = 8;
const ROADSIDE_BAND_DEPTH = TILE * 1.0; // world-unit depth of ONE distance band (band 1 = closest to the road)
let _parcelIdCounter = 1;

// Closest point on a single segment's curve to (x,z), found by coarse sampling followed by a
// local golden-section refinement between the two samples straddling the best coarse sample —
// cheap, robust for both straight and quadratic-bezier segments, no derivative/root-solving
// required (works the same whether curve is null or a bezier control point).
function closestPointOnRoadSegment(network, segment, x, z, coarseSamples = 24) {
  let bestT = 0, bestDist = Infinity, bestPoint = null;
  for (let i = 0; i <= coarseSamples; i++) {
    const t = i / coarseSamples;
    const p = getRoadPoint(network, segment, t);
    const d = Math.hypot(p.x - x, p.z - z);
    if (d < bestDist) { bestDist = d; bestT = t; bestPoint = p; }
  }
  // refine within the coarse step on either side of bestT
  let lo = Math.max(0, bestT - 1 / coarseSamples), hi = Math.min(1, bestT + 1 / coarseSamples);
  for (let iter = 0; iter < 14; iter++) {
    const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
    const p1 = getRoadPoint(network, segment, m1), p2 = getRoadPoint(network, segment, m2);
    const d1 = Math.hypot(p1.x - x, p1.z - z), d2 = Math.hypot(p2.x - x, p2.z - z);
    if (d1 < d2) { hi = m2; if (d1 < bestDist) { bestDist = d1; bestT = m1; bestPoint = p1; } }
    else { lo = m1; if (d2 < bestDist) { bestDist = d2; bestT = m2; bestPoint = p2; } }
  }
  return { t: bestT, point: bestPoint, distance: bestDist };
}

// getNearestRoadPoint(x,z): scans every RoadSegment in the network (no tile-neighbor lookup —
// this is the free-road equivalent of "which road is closest", answered from actual geometry).
function getNearestRoadPoint(network, x, z) {
  let best = null;
  for (const segment of network.segments.values()) {
    const hit = closestPointOnRoadSegment(network, segment, x, z);
    if (!best || hit.distance < best.distance) {
      const n = getRoadNormal(network, segment, hit.t);
      const side = ((x - hit.point.x) * n.x + (z - hit.point.z) * n.z) >= 0 ? 'left' : 'right';
      best = { segmentId: segment.id, segment, t: hit.t, point: hit.point, distance: hit.distance, side };
    }
  }
  return best; // null if the network has no segments yet
}

// getNearestRoadDistance(x,z): distance from (x,z) to the nearest road's PAVED EDGE (0 = right
// at the edge, negative = inside the pavement) — NOT the centerline distance, so band 1 always
// starts flush against the actual asphalt regardless of how wide that road type is.
function getNearestRoadDistance(network, x, z) {
  const nearest = getNearestRoadPoint(network, x, z);
  if (!nearest) return Infinity;
  return nearest.distance - getRoadWidth(nearest.segment) / 2;
}

// isInsideRoadFootprint(x,z): true if the point sits on the road's actual paved width — the
// only area land generation must treat as occupied. Uses the exact same half-width
// (getRoadFootprintHalfWidth) as hub/arm geometry, so a 8-lane road's real footprint (not an
// inflated "N tiles blocked on each side" guess) is what's excluded from buildable land.
function isInsideRoadFootprint(network, x, z) {
  const nearest = getNearestRoadPoint(network, x, z);
  if (!nearest) return false;
  return nearest.distance <= getRoadWidth(nearest.segment) / 2;
}

// getRoadsideBand(x,z): which of the 8 roadside distance bands (1 = closest) this point falls
// in, or null if it's on the pavement itself or farther than band 8. A distance MEASURE, never
// a Tile index — identical logic for a straight segment and the tightest curve.
function getRoadsideBand(network, x, z) {
  const edgeDist = getNearestRoadDistance(network, x, z);
  if (edgeDist < 0) return null; // inside the road footprint
  const band = Math.floor(edgeDist / ROADSIDE_BAND_DEPTH) + 1;
  return band >= 1 && band <= ROADSIDE_BAND_COUNT ? band : null;
}

// getRoadFrontage(x,z): which road (and where along it) this point fronts, if any, within the
// 8-band roadside range — the free-road equivalent of the old lotHasRoadAccess() tile scan.
function getRoadFrontage(network, x, z) {
  const band = getRoadsideBand(network, x, z);
  if (band == null) return null;
  const nearest = getNearestRoadPoint(network, x, z);
  return { segmentId: nearest.segmentId, side: nearest.side, t: nearest.t, roadPoint: nearest.point, band, distanceFromRoadEdge: nearest.distance - getRoadWidth(nearest.segment) / 2 };
}

// getBuildableLandAt(x,z): the single answer "can something be built here, according to the
// free Road Network" — occupied by pavement, fronting a road within the 8 bands (buildable), or
// unserviced land with no nearby road (not buildable). This is the intended entry point for a
// future building-placement Prompt; it does not itself place or validate any building yet.
function getBuildableLandAt(network, x, z) {
  if (isInsideRoadFootprint(network, x, z)) return { buildable: false, reason: 'road_footprint' };
  const frontage = getRoadFrontage(network, x, z);
  if (!frontage) return { buildable: false, reason: 'no_road_frontage' };
  return { buildable: true, ...frontage };
}

// createParcelAlongFrontage: builds one Parcel record — a real World Space polygon strip, band
// `band` deep, along segment `segmentId` between t=fromT..toT on the given side — by sampling
// getRoadPoint/getRoadNormal along the curve (so the polygon bends with the road; it is never
// a straight Tile rectangle). This is a data-construction helper; nothing calls it automatically
// for every road yet (that is future building-placement Prompt work) — the roadside-land overlay
// below calls it once per band per segment purely to visualize/prove the query layer.
function createParcelAlongFrontage(network, segmentId, side, band, subdivisions = 12) {
  const segment = network.segments.get(segmentId);
  if (!segment) return null;
  const halfW = getRoadWidth(segment) / 2;
  const innerDist = halfW + (band - 1) * ROADSIDE_BAND_DEPTH;
  const outerDist = halfW + band * ROADSIDE_BAND_DEPTH;
  const sideSign = side === 'left' ? 1 : -1;
  const innerEdge = [], outerEdge = [];
  let area = 0;
  for (let i = 0; i <= subdivisions; i++) {
    const t = i / subdivisions;
    const p = getRoadPoint(network, segment, t), n = getRoadNormal(network, segment, t);
    innerEdge.push({ x: p.x + n.x * innerDist * sideSign, z: p.z + n.z * innerDist * sideSign });
    outerEdge.push({ x: p.x + n.x * outerDist * sideSign, z: p.z + n.z * outerDist * sideSign });
  }
  const polygon = [...innerEdge, ...outerEdge.reverse()];
  // shoelace formula for the polygon's world-unit area
  for (let i = 0; i < polygon.length; i++) {
    const a = polygon[i], b = polygon[(i + 1) % polygon.length];
    area += a.x * b.z - b.x * a.z;
  }
  area = Math.abs(area) / 2;
  return {
    id: `parcel${_parcelIdCounter++}`,
    polygon,
    area,
    roadFrontage: [{ segmentId, side, fromT: 0, toT: 1 }],
    roadSegmentIds: [segmentId],
    buildable: true,
    band,
  };
}


// -- one-way direction enum for 'small' roads (see recomputeOneWayNetwork / isRoadMoveAllowed) --
// Actual compass directions, NOT a +/- sign: a bare sign bit can't tell "east" apart from "south"
// once a one-way road bends, which is what made curves/loops break before. DIR_DELTA's order
// (N,E,S,W) matches roadNeighbors()'s neighbor-offset order.
const DIR_N = 0, DIR_E = 1, DIR_S = 2, DIR_W = 3;
const DIR_DELTA = [[0, -1], [1, 0], [0, 1], [-1, 0]]; // N, E, S, W
const DIR_OPP = [DIR_S, DIR_W, DIR_N, DIR_E];
const dirFromDelta = (dx, dy) => (dx === 1 ? DIR_E : dx === -1 ? DIR_W : dy === 1 ? DIR_S : DIR_N);
const dirBit = (d) => 1 << d;

// -- explicit turn classification (STRAIGHT / LEFT / RIGHT / UTURN), replacing the old
// "direction changed at all" boolean, which could not tell a 90° turn apart from a dead-end
// reversal. World axes: +X = East, +Z = South (see tileWorldX/tileWorldZ), so DIR_N/E/S/W (which
// walk N->E->S->W->N, see DIR_DELTA) advance in COMPASS-CLOCKWISE order — turning from any
// direction to the next one in that cycle (N->E, E->S, S->W, W->N) is a real-world RIGHT turn;
// the reverse cycle (N->W, W->S, S->E, E->N) is a LEFT turn; two steps around is a U-TURN.
const TURN_STRAIGHT = 0, TURN_RIGHT = 1, TURN_UTURN = 2, TURN_LEFT = 3;
function classifyTurn(fromDir, toDir) {
  return ((toDir - fromDir) % 4 + 4) % 4; // 0=straight, 1=right, 2=uturn, 3=left — matches the constants above
}

// -- accidents --
const ACCIDENT_RADIUS = 1.15;
const ACCIDENT_CHANCE = 0.006;

const MAX_INSTANCES = 4200;
const ROAD_TILE_CAP = GRID_SIZE * GRID_SIZE;
const ARM_CAP = 9000;
const VARIANT_CAP = 2400;
const SIGNAL_CAP = ROAD_TILE_CAP; // per intersection; poles/heads now render per-corner so meshes below multiply this

// -- intersection graph classification (node layer built on top of the grid) --
const NODE_NONE = 0;
const NODE_DEADEND = 1;
const NODE_STRAIGHT = 2;
const NODE_CURVE = 3;
const NODE_T = 4;
const NODE_CROSS = 5; // 4-way+ -> gets a traffic signal

// -- traffic signals --
const SIGNAL_GREEN_TIME = 6; // seconds each axis stays green
const SIGNAL_YELLOW_TIME = 1.6; // seconds each axis stays yellow before switching to red
const SIGNAL_GREEN_COLOR = 0x5ce07a;
const SIGNAL_YELLOW_COLOR = 0xf0c33a;
const SIGNAL_RED_COLOR = 0xe0544a;
const SIGNAL_LIT_INTENSITY = 1.1;
const SIGNAL_UNLIT_INTENSITY = 0.06; // lamp is "off" but still faintly shows its color, like a real unlit signal lens
// a car travels from the center of its current tile (t=0) to the center of the next tile (t=1).
// the painted stop line sits right at the edge of the intersection's hub square, well short of
// the hub center — so cars must brake early and halt there, not creep deep into the crossing.
const SIGNAL_STOP_T = 0.4; // where the car actually halts (moved back a bit for more visible clearance before the hub edge)
const SIGNAL_BRAKE_T = 0.22; // where the car starts checking/braking for a red light

// body h / footprint per zone+level -> gives shops/offices/factories distinct massing
const BUILDING_CONFIG = {
  [TILE_RES]: [{ h: 5, foot: 0.55 }, { h: 9, foot: 0.58 }, { h: 14, foot: 0.6 }],
  [TILE_COM]: [{ h: 3.2, foot: 0.82 }, { h: 8, foot: 0.6 }, { h: 16, foot: 0.58 }],
  [TILE_IND]: [{ h: 4, foot: 0.84 }, { h: 6, foot: 0.88 }, { h: 7.5, foot: 0.9 }],
};

const ZONE_COLORS = {
  [TILE_RES]: { tint: 0x3a5a8a, tintDim: 0x2a3a45, building: [0x9b8262, 0x5a90d8, 0x3a6cb0], roof: [0x7a4030, 0x2a548f, 0x224c85] },
  [TILE_COM]: { tint: 0x8a6a3a, tintDim: 0x453a2a, building: [0xd4a860, 0xe0b060, 0x8fd8e8], roof: [0x8a97a0, 0x785a28, 0x4a5860] },
  [TILE_IND]: { tint: 0x6a3a8a, tintDim: 0x3a2a45, building: [0x9b6fdc, 0x8a8f94, 0x7a828a], roof: [0x5a3a80, 0x6a727a, 0x565c62] },
};

// ============ residential lot types (multi-tile plots) ============
// res_low stays a plain 1-tile paint zone (existing behaviour); the other five are
// drag-rectangle "lots" that occupy w x h tiles as a single growing building.
const RES_LOT_TYPES = {
  res_terrace: { label: 'テラスハウス', unlockPop: 0, hMin: 3.4, hMax: 4.4, pop: [2, 30], jobs: [0, 0], color: 0xb08a5a, roof: 0x7a4a34 },
  res_mid: { label: '中密度住宅', unlockPop: 200, hMin: 9, hMax: 18, pop: [60, 300], jobs: [0, 0], color: 0x8fa8c8, roof: 0x4a6a90 },
  res_lowrent: { label: '低家賃住宅', unlockPop: 400, hMin: 12, hMax: 22, pop: [200, 300], jobs: [0, 0], color: 0x8a8a82, roof: 0x5a5a54 },
  res_mixed: { label: '複合住宅', unlockPop: 600, hMin: 10, hMax: 20, pop: [50, 100], jobs: [10, 40], color: 0xd8b878, roof: 0x8a97a0 },
  res_high: { label: '高密度住宅', unlockPop: 1500, hMin: 22, hMax: 46, pop: [300, 1100], jobs: [0, 0], color: 0x9fd0e0, roof: 0xd8dce0 },
};

// ============ industry: resource graph + building defs (Phase 1 data model) ============
// Pure data tables — deliberately independent of any rendering/AI code so later phases
// (production chains, education matching, profitability, cargo) can be layered on top without
// touching the road/car/pedestrian systems. See IndustryLot-equivalent state: industryDataRef.
const RESOURCES = {
  raw_ore_rock: { name: '岩', tier: 0, category: 'raw', price: 8 },
  raw_timber: { name: '木材', tier: 0, category: 'raw', price: 7 },
  raw_oil: { name: '石油', tier: 0, category: 'raw', price: 10 },
  raw_crop: { name: '野菜', tier: 0, category: 'raw', price: 6 },
  raw_livestock: { name: '家畜', tier: 0, category: 'raw', price: 9 },
  proc_ore: { name: '鉱石', tier: 1, category: 'processed', price: 18 },
  proc_plastic: { name: 'プラスチック', tier: 1, category: 'processed', price: 20 },
  proc_lumber: { name: '材木', tier: 1, category: 'processed', price: 16 },
  proc_chem: { name: '石油化学製品', tier: 1, category: 'processed', price: 24 },
  proc_food: { name: '食品', tier: 1, category: 'processed', price: 15 },
  adv_electronics: { name: '電子機器', tier: 2, category: 'advanced', price: 55 },
  adv_medicine: { name: '薬品', tier: 2, category: 'advanced', price: 62 },
  know_software: { name: 'ソフトウェア', tier: 3, category: 'knowledge', price: 120 },
};

// pollution/employee weights are per-level multipliers used by computePollution() (Phase 2) and,
// later, the profitability/education phases — kept on the same record as needs/produces so every
// subsystem reads from one source of truth.
const INDUSTRY_BUILDINGS = {
  quarry: { category: 'extraction', needs: [], produces: [{ id: 'raw_ore_rock', rate: 1 }], eduReq: 'low', pollution: { air: 0.6, soil: 0.3, noise: 0.9 }, jobsPerLevel: 8 },
  timber_camp: { category: 'extraction', needs: [], produces: [{ id: 'raw_timber', rate: 1 }], eduReq: 'low', pollution: { air: 0.2, soil: 0.2, noise: 0.5 }, jobsPerLevel: 7 },
  oil_well: { category: 'extraction', needs: [], produces: [{ id: 'raw_oil', rate: 1 }], eduReq: 'low', pollution: { air: 0.7, soil: 0.9, noise: 0.4 }, jobsPerLevel: 6 },
  farm: { category: 'extraction', needs: [], produces: [{ id: 'raw_crop', rate: 1 }], eduReq: 'low', pollution: { air: 0.1, soil: 0.15, noise: 0.1 }, jobsPerLevel: 9 },
  ore_processor: { category: 'production', needs: [{ id: 'raw_ore_rock', rate: 1 }], produces: [{ id: 'proc_ore', rate: 0.8 }], eduReq: 'low', pollution: { air: 0.8, soil: 0.5, noise: 0.7 }, jobsPerLevel: 12 },
  plastics_plant: { category: 'production', needs: [{ id: 'raw_oil', rate: 1 }], produces: [{ id: 'proc_plastic', rate: 0.8 }], eduReq: 'mid', pollution: { air: 0.9, soil: 0.6, noise: 0.5 }, jobsPerLevel: 12 },
  sawmill: { category: 'production', needs: [{ id: 'raw_timber', rate: 1 }], produces: [{ id: 'proc_lumber', rate: 0.8 }], eduReq: 'low', pollution: { air: 0.4, soil: 0.2, noise: 0.6 }, jobsPerLevel: 10 },
  refinery: { category: 'production', needs: [{ id: 'raw_oil', rate: 1 }], produces: [{ id: 'proc_chem', rate: 0.7 }], eduReq: 'mid', pollution: { air: 1.0, soil: 0.7, noise: 0.5 }, jobsPerLevel: 14 },
  food_plant: { category: 'production', needs: [{ id: 'raw_crop', rate: 1 }, { id: 'raw_livestock', rate: 0.5 }], produces: [{ id: 'proc_food', rate: 0.8 }], eduReq: 'low', pollution: { air: 0.3, soil: 0.2, noise: 0.4 }, jobsPerLevel: 12 },
  electronics: { category: 'production', needs: [{ id: 'proc_ore', rate: 1 }, { id: 'proc_plastic', rate: 1 }], produces: [{ id: 'adv_electronics', rate: 0.7 }], eduReq: 'mid', pollution: { air: 0.4, soil: 0.2, noise: 0.3 }, jobsPerLevel: 18 },
  pharma_lab: { category: 'production', needs: [{ id: 'proc_chem', rate: 1 }], produces: [{ id: 'adv_medicine', rate: 0.6 }], eduReq: 'high', pollution: { air: 0.3, soil: 0.2, noise: 0.15 }, jobsPerLevel: 16 },
  software_office: { category: 'production', needs: [{ id: 'adv_electronics', rate: 1 }], produces: [{ id: 'know_software', rate: 0.5 }], eduReq: 'high', zone: 'office', pollution: { air: 0.02, soil: 0.01, noise: 0.05 }, jobsPerLevel: 22 },
  ore_storage: { category: 'storage', stores: ['proc_ore', 'raw_ore_rock'], capacityPerLevel: 40, pollution: { air: 0.05, soil: 0.05, noise: 0.1 }, jobsPerLevel: 3 },
  general_storage: { category: 'storage', stores: ['proc_lumber', 'proc_plastic', 'proc_food'], capacityPerLevel: 40, pollution: { air: 0.05, soil: 0.05, noise: 0.1 }, jobsPerLevel: 3 },
};

// which buildingDefs a tile may roll when it first reaches a given growth level — deliberately
// simple (no resource-node adjacency check yet, since the map doesn't place raw-resource nodes
// yet; see design doc §1/§8 phase 4) so Phase 1 stays just the data model + a plausible default.
const INDUSTRY_BUILDINGS_BY_LEVEL = [
  ['quarry', 'timber_camp', 'oil_well', 'farm'],
  ['ore_processor', 'sawmill', 'refinery', 'food_plant', 'ore_storage', 'general_storage'],
  ['electronics', 'plastics_plant', 'pharma_lab', 'software_office'],
];

function pickIndustryBuilding(level) {
  const pool = INDUSTRY_BUILDINGS_BY_LEVEL[Math.min(level, INDUSTRY_BUILDINGS_BY_LEVEL.length) - 1];
  return pool[Math.floor(Math.random() * pool.length)];
}

// ============ Commercial / Business data model (Prompt 5, Step 2) ============
// Product catalog is deliberately its OWN namespace ('sh_xxx') so it never collides with the
// existing industrial RESOURCES table (§商品種類は現在のゲームのResource体系と衝突しないように整理する).
// Each shopType lists which product lines it carries; price is the per-unit retail price used to
// derive revenue/inventory value (real numbers, never a display-only placeholder).
const SHOP_PRODUCTS = {
  sh_food: { name: '食料品', price: 4 },
  sh_drink: { name: '飲料', price: 3 },
  sh_household: { name: '日用品', price: 6 },
  sh_daily: { name: '雑貨', price: 5 },
  sh_meal: { name: '食事', price: 12 },
  sh_apparel: { name: '衣料品', price: 18 },
  sh_electronics_retail: { name: '家電', price: 45 },
  sh_service: { name: 'サービス', price: 20 },
};
const SHOP_TYPES = {
  supermarket: { name: 'スーパーマーケット', products: ['sh_food', 'sh_drink', 'sh_household'], jobsPerLevel: 6 },
  convenience_store: { name: 'コンビニ', products: ['sh_food', 'sh_drink', 'sh_daily'], jobsPerLevel: 3 },
  restaurant: { name: 'レストラン', products: ['sh_meal', 'sh_drink'], jobsPerLevel: 5 },
  clothing_store: { name: '衣料品店', products: ['sh_apparel'], jobsPerLevel: 3 },
  electronics_store: { name: '家電量販店', products: ['sh_electronics_retail'], jobsPerLevel: 4 },
  service_shop: { name: 'サービス業', products: ['sh_service'], jobsPerLevel: 4 },
};
const SHOP_TYPES_BY_LEVEL = [
  ['convenience_store', 'service_shop'],
  ['supermarket', 'restaurant', 'clothing_store'],
  ['supermarket', 'restaurant', 'electronics_store'],
];
// picked ONCE at store creation (mirrors pickIndustryBuilding) — never re-rolled on every
// Inspector open (§禁止事項6: Inspectorを開くたびにランダムな…売上・在庫を生成しない).
function pickShopType(level) {
  const pool = SHOP_TYPES_BY_LEVEL[Math.min(Math.max(level, 1), SHOP_TYPES_BY_LEVEL.length) - 1];
  return pool[Math.floor(Math.random() * pool.length)];
}
const BUSINESS_NAME_PARTS = ['グリーン', 'サン', 'シティ', 'セントラル', 'パーク', 'ハーバー', 'リバー', 'スター'];
let businessNameSeq = 1;
// assigned ONCE per store id (deterministic per-instance, never re-rolled) so re-opening the same
// building's Inspector always shows the same businessName.
function generateBusinessName(shopType) {
  const part = BUSINESS_NAME_PARTS[businessNameSeq % BUSINESS_NAME_PARTS.length];
  const label = SHOP_TYPES[shopType]?.name || shopType;
  businessNameSeq++;
  return `${part}${label}${businessNameSeq}`;
}

// ============ Phase 3-7 constants (suitability / education / transport / profitability) ============
const EDU_TIERS = ['none', 'low', 'mid', 'high'];
const EDU_TIER_SHARE = { none: 0.20, low: 0.45, mid: 0.25, high: 0.10 }; // fixed until a school system exists
const SUITABILITY_RADIUS = 8;
const SUITABILITY_WEIGHTS = { labor: 0.45, resource: 0.35, transit: 0.20 };
const HUB_TYPES = { rail: { name: '貨物駅', cost: 3000 }, port: { name: '貨物港', cost: 5000 }, airport: { name: '貨物空港', cost: 8000 } };
const HUB_DISCOUNT = 0.35; // hub-to-hub link cost is multiplied by this instead of using raw tile distance
const TRANSPORT_UNIT_COST = 0.06; // currency per resource-unit per tile of distance
const TAX_MIN = -0.10, TAX_MAX = 0.30;
const UTILITY_DISCOUNT_MAX_BONUS = 0.40; // +40% efficiency at 0% utility cost, per design doc §5

// ============ Prompt 5 of the Tile->World Space migration: buildings/lots ============
// A lot's real position/size now live as World Space data — position.x/y/z + footprint.width/
// depth (+rotation) — NEVER as a Tile-grid rectangle. gx/gy/w/h are kept on the lot object too,
// but ONLY as a rasterization of that footprint onto the Tile grid for backward-compat bookkeeping
// (lotIdGridRef occupancy, existing Citizen/pollution code that resolves a homeId to a tile index
// — see getEnvironmentAt) — they are derived FROM position/footprint, never the source of truth.
const LOT_FOOTPRINT_MIN = 3; // meters — smallest footprint edge a free-sized lot may have
const LOT_FOOTPRINT_MAX = 16; // meters — largest footprint edge (covers 8x8/4x8/8x4/3x6/6x12/12x4 etc.)

function clampLotSize(type, rawW, rawH) {
  if (type === 'res_terrace') {
    // Standard terrace lot is always exactly ONE fixed unit: 6m wide (frontage) x 12m deep — a
    // FIXED World Space size, not "1 Tile x 2 Tiles". The drag direction only picks a starting
    // guess for which axis is narrow; the real road-facing side is re-checked/auto-corrected
    // against both road systems in pickTerraceOrientation.
    return rawW >= rawH ? { w: TILE * 2, h: TILE } : { w: TILE, h: TILE * 2 };
  }
  // Free World Space footprint, in meters — deliberately NEVER rounded/forced to a Tile (TILE=6)
  // multiple, so sizes like 8x8 / 4x8 / 8x4 / 3x6 / 6x12 / 12x4 are all valid continuous sizes.
  return {
    w: Math.min(LOT_FOOTPRINT_MAX, Math.max(LOT_FOOTPRINT_MIN, rawW)),
    h: Math.min(LOT_FOOTPRINT_MAX, Math.max(LOT_FOOTPRINT_MIN, rawH)),
  };
}

const GIVEN_NAMES = ['大輔', '花子', '健太', '美咲', '翔太', '愛', '拓也', '由美', '蓮', '葵', '颯太', '陽菜', '直樹', '真央', '駿'];
const DEST_FLAVORS = ['仕事に向かっている', '買い物帰り', '友人と食事へ', '通勤中', '用事を済ませに', 'ドライブ中', '家族の迎えに'];

// ============ Game Clock (city-sim foundation, Part 1) ============
// The single source of truth for "what time it is" in the simulated city. Every future system
// (citizens, schools, workplaces, shops, hospitals, disasters, ...) will read time from here —
// never from setInterval call counts or requestAnimationFrame frame counts. Part 1 only builds
// this foundation; Citizen/Household/School/Workplace themselves come in later parts.
const GAME_START_YEAR = 2050;
const GAME_START_MONTH = 1; // 1-12
const GAME_START_DAY = 1;
// real-world <-> game-time conversion rate, kept as one tunable constant (not buried in logic).
// At timeScale=1 (the "1x" speed button) this many GAME minutes pass per real second.
const GAME_MINUTES_PER_REAL_SECOND = 10;
// fixed real-world cadence for advancing the clock + processing due simulation events. This is
// intentionally its OWN interval, independent of both the Three.js render loop (rAF) and the
// existing growth/economy tick's interval, so nothing here is ever driven by frame count.
const GAME_CLOCK_INTERVAL_MS = 200;
const WEEKDAY_LABELS_JA = ['日', '月', '火', '水', '木', '金', '土']; // index = Date#getUTCDay()
const GAME_START_EPOCH_MS = Date.UTC(GAME_START_YEAR, GAME_START_MONTH - 1, GAME_START_DAY, 0, 0, 0);

// Event type enum only, for now — Part 1 explicitly does not implement any of these; they exist
// so Part 2+ (Citizen life events) can start scheduling/handling them against the same queue.
const SIM_EVENT_TYPES = {
  START_WORK: 'START_WORK', END_WORK: 'END_WORK', START_SCHOOL: 'START_SCHOOL', END_SCHOOL: 'END_SCHOOL',
  GO_SHOPPING: 'GO_SHOPPING', RETURN_HOME: 'RETURN_HOME', BECOME_TEEN: 'BECOME_TEEN', BECOME_ADULT: 'BECOME_ADULT',
  BECOME_ELDERLY: 'BECOME_ELDERLY', GET_SICK: 'GET_SICK', RECOVER: 'RECOVER', DIE: 'DIE', MOVE_CITY: 'MOVE_CITY',
  // Part 3 additions — school-day granularity beyond the generic START_SCHOOL/END_SCHOOL pair
  // Part 1 already reserved. ARRIVE_SCHOOL separates "left home for school" from "counted as
  // attending today", and GRADUATE is its own event so education-level changes are never buried
  // inside a daily LEAVE_SCHOOL handler.
  ARRIVE_SCHOOL: 'ARRIVE_SCHOOL', LEAVE_SCHOOL: 'LEAVE_SCHOOL', GRADUATE: 'GRADUATE',
  // Part 4 additions — Workplace/Occupation/Daily Schedule (§Daily Schedule, §Job Matching).
  // START_WORK/END_WORK/GO_SHOPPING/RETURN_HOME above were only reserved as placeholders by
  // Part 1; they get real handlers here. PLAN_DAY is the single once-a-day kickoff event every
  // working-age citizen reschedules for itself (never polled), exactly like Part 3's
  // scheduleSchoolAttempt() pattern. JOB_SEARCH and LEAVE_SHOPPING are the only genuinely new
  // event names this part needs.
  PLAN_DAY: 'PLAN_DAY', JOB_SEARCH: 'JOB_SEARCH', LEAVE_SHOPPING: 'LEAVE_SHOPPING',
  // Part 5 additions — Health/Status/Migration/Death (§Health, §Migration, §Death). HEALTH_CHECK
  // is the single recurring per-citizen "ambient life" tick that decides whether GET_SICK,
  // MOVE_CITY (used here as the scheduled migration-out departure) or nothing happens next; the
  // resulting sickness/injury is always resolved later by the existing RECOVER event slot Part 1
  // already reserved. No new anonymous/global tick is introduced — this is scheduled exactly like
  // PLAN_DAY, once per citizen, self-rescheduling.
  HEALTH_CHECK: 'HEALTH_CHECK',
};

class GameClock {
  constructor() {
    this.gameTimeMs = 0; // ms of GAME time elapsed since GAME_START_EPOCH_MS — NOT real ms, NOT a tick count
    this.initialDate = { year: GAME_START_YEAR, month: GAME_START_MONTH, day: GAME_START_DAY };
    this.timeScale = 1; // 1 / 2 / 4 — multiplies how much GAME time passes per real ms
    this.paused = false;
    this._lastRealMs = null;
  }
  // Advance gameTimeMs by however much real time has passed since the last call. Call this from
  // a fixed-cadence source only (GAME_CLOCK_INTERVAL_MS below) — never from rAF.
  advance(nowRealMs) {
    if (this._lastRealMs == null) { this._lastRealMs = nowRealMs; return; }
    const dtRealMs = nowRealMs - this._lastRealMs;
    this._lastRealMs = nowRealMs;
    if (this.paused || dtRealMs <= 0) return;
    const gameMsPerRealMs = (GAME_MINUTES_PER_REAL_SECOND * 60000) / 1000;
    this.gameTimeMs += dtRealMs * gameMsPerRealMs * this.timeScale;
  }
  getEpochMs() { return GAME_START_EPOCH_MS + this.gameTimeMs; }
  getDate() {
    const epochMs = this.getEpochMs();
    const d = new Date(epochMs);
    const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1, day = d.getUTCDate();
    const hour = d.getUTCHours(), minute = d.getUTCMinutes(), second = d.getUTCSeconds();
    const weekday = WEEKDAY_LABELS_JA[d.getUTCDay()];
    const dayOfYear = Math.floor((epochMs - Date.UTC(year, 0, 1)) / 86400000) + 1;
    const totalDays = Math.floor(this.gameTimeMs / 86400000);
    return { year, month, day, weekday, hour, minute, second, dayOfYear, totalDays };
  }
  isWeekend() { const wd = new Date(this.getEpochMs()).getUTCDay(); return wd === 0 || wd === 6; }
  isWeekday() { return !this.isWeekend(); }
}

// currentGameTime - birthTime style age math for future Citizens — deliberately NOT "age += 1
// per tick"; age is always derived on demand from two epoch timestamps (Part 2+ will call this
// with a Citizen's birthTime once Citizens exist).
function differenceInGameDays(laterEpochMs, earlierEpochMs) {
  return Math.floor((laterEpochMs - earlierEpochMs) / 86400000);
}

// ============ SimulationManager (Part 1 foundation) ============
// Owns the event queue and decides what runs as the GameClock advances. No Citizen/Household/
// School/Workplace handlers yet — Part 2+ registers real logic via sim.onEvent.
class SimulationManager {
  constructor() {
    this.currentSimulationTime = 0;
    this.lastSimulationTime = 0;
    this.eventQueue = [];
    this._needsSort = false;
    this.onEvent = null; // (event) => void — set by future Part 2+ systems
  }
  // Sort is deferred to processDueEvents() rather than done on every push — with tens of
  // thousands of future citizen events, sorting on every scheduleEvent() would be far too slow.
  scheduleEvent(event) { this.eventQueue.push(event); this._needsSort = true; }
  processDueEvents(now) {
    if (!this.eventQueue.length) return;
    if (this._needsSort) { this.eventQueue.sort((a, b) => a.time - b.time); this._needsSort = false; }
    while (this.eventQueue.length && this.eventQueue[0].time <= now) {
      const event = this.eventQueue.shift();
      if (this.onEvent) this.onEvent(event);
    }
  }
  // Called once per GAME_CLOCK_INTERVAL_MS tick — NOT once per rendered frame, so city size never
  // affects render framerate even once thousands of citizens are scheduling events (Part 2+).
  updateTo(now) {
    this.lastSimulationTime = this.currentSimulationTime;
    this.currentSimulationTime = now;
    this.processDueEvents(now);
  }
}

// ============ Citizen / Household (city-sim foundation, Part 2) ============
// Every resident is a real Citizen entity (population = living Citizen count, never a formula) —
// but "existing" and "being drawn every frame" are separate concerns; see the LOD note near
// getCitizenLodTier() below. Citizens read time exclusively from the Part 1 GameClock/
// SimulationManager — they never keep their own clock.
const AGE_STAGE_DAYS = { childToTeen: 21, teenToAdult: 36, adultToElderly: 84 }; // days spent IN each stage
// cumulative absolute day-thresholds since birth (not per-stage counters) — this is what
// getAgeGroup() actually compares against, per the "出生からの時間関係" requirement.
const AGE_GROUP_START_DAY = {
  Child: 0,
  Teen: AGE_STAGE_DAYS.childToTeen,
  Adult: AGE_STAGE_DAYS.childToTeen + AGE_STAGE_DAYS.teenToAdult,
  Elderly: AGE_STAGE_DAYS.childToTeen + AGE_STAGE_DAYS.teenToAdult + AGE_STAGE_DAYS.adultToElderly,
};
const EDUCATION_LEVELS = ['NONE', 'LOW', 'AVERAGE', 'HIGH', 'VERY_HIGH'];
const JOB_LEVELS = ['SIMPLE', 'BASIC', 'SENIOR', 'SPECIALIST', 'MANAGER'];
// education is a SOFT preference, never a hard restriction (design doc §Job Level) — this just
// maps an education level to the job level a citizen would prefer, if one is available.
const EDUCATION_TO_PREFERRED_JOB_LEVEL = { NONE: 'SIMPLE', LOW: 'BASIC', AVERAGE: 'SENIOR', HIGH: 'SPECIALIST', VERY_HIGH: 'MANAGER' };

// ============ Education Facilities — placeable buildings (Part 1/4) ============
// This is a PLACEMENT/DATA layer only. It is deliberately independent from the abstract
// EDU_CATEGORY_SCHEDULE / educationFacilitiesRef simulation above (Citizen enrollment,
// graduation, staffing sim) — nothing here reads or writes citizens/households/educationFacilities,
// and nothing above reads this.
// Zone tiles (TILE_RES/TILE_COM/TILE_IND) are NOT reused: education facilities occupy their own
// grid value (TILE_EDU) and their own id-grid (eduFacilityIdGridRef), exactly mirroring how
// lotsRef/lotIdGridRef keep a residential lot's definition separate from its placed instance.
const EDUCATION_OUTPUT_LEVELS = EDUCATION_LEVELS; // NONE/LOW/AVERAGE/HIGH/VERY_HIGH — same 5 tiers
const EDUCATION_OUTPUT_LABEL_JA = {
  NONE: '学歴無し', LOW: '低学歴', AVERAGE: '平均学歴', HIGH: '高学歴', VERY_HIGH: '非常に高学歴',
};
const EDUCATION_FACILITY_CATEGORIES = ['ELEMENTARY', 'HIGH_SCHOOL', 'UNIVERSITY', 'COMPREHENSIVE_UNIVERSITY', 'ENGINEERING_UNIVERSITY', 'MEDICAL_UNIVERSITY', 'RESEARCH', 'SPECIAL'];
const EDUCATION_FACILITY_PACKS = [
  'BASE', 'MA', 'UP', 'MH', 'LV', 'DG', 'BRIDGES_PORTS', 'SC', 'SK', 'UK', 'EE', 'FR', 'DE', 'JP', 'CN', 'NE', 'SW', 'NL',
];
// Part 4/4: final education-UI grouping (§最終的な教育施設カテゴリ). "特殊大学" bundles two
// EDUCATION_FACILITY_CATEGORIES entries (ENGINEERING_UNIVERSITY/MEDICAL_UNIVERSITY) into one tab;
// every other tab maps 1:1 onto a category. Purely a UI grouping — EDUCATION_FACILITY_CATEGORIES
// itself (the data-level category set) is unchanged.
const EDU_UI_GROUPS = [
  { key: 'ELEMENTARY', label: '小学校', categories: ['ELEMENTARY'] },
  { key: 'HIGH_SCHOOL', label: '高校', categories: ['HIGH_SCHOOL'] },
  { key: 'UNIVERSITY', label: '大学', categories: ['UNIVERSITY'] },
  { key: 'COMPREHENSIVE_UNIVERSITY', label: '総合大学', categories: ['COMPREHENSIVE_UNIVERSITY'] },
  { key: 'SPECIAL_UNIVERSITY', label: '特殊大学', categories: ['ENGINEERING_UNIVERSITY', 'MEDICAL_UNIVERSITY'] },
  { key: 'RESEARCH', label: '研究施設', categories: ['RESEARCH'] },
];
// Part 3/4: a graduation-time reduction effect (facility or upgrade level) can never push an
// individual citizen's graduation below this many game days. Citizen-side graduation timing is
// NOT simulated yet (Part 3 forbids it) — this constant is stored now so the future graduation
// calculator has a single authoritative floor to read, instead of each caller guessing one.
const GRADUATION_TIME_FLOOR_DAYS = 180;

// Definitions (the facility's PERFORMANCE) — never mutated by instances. Part 1 registers just
// one placeable facility per category as a smoke test; Part 2+ appends more entries here without
// touching the shape below.
const EDUCATION_FACILITIES = {
  edu_elementary_test: {
    id: 'edu_elementary_test',
    name: '小学校',
    category: 'ELEMENTARY',
    educationOutput: 'LOW',
    cost: 8000,
    monthlyUpkeep: 120,
    capacity: 400,
    maxCapacity: 600,
    baseStaff: 20,
    staffModel: { base: 20, studentsPerStaff: 20, minStaff: 20, maxStaff: 60 },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 },
    size: { w: 3, h: 3 },
    pack: 'BASE',
    cityEffects: { landValueRadius: 6, landValueAmount: 0.05 },
    upgrades: [],
  },
  edu_highschool_test: {
    id: 'edu_highschool_test',
    name: '高校',
    category: 'HIGH_SCHOOL',
    educationOutput: 'AVERAGE',
    cost: 16000,
    monthlyUpkeep: 260,
    capacity: 800,
    maxCapacity: 1100,
    baseStaff: 45,
    staffModel: { base: 45, studentsPerStaff: 22, minStaff: 45, maxStaff: 120 },
    pollution: { air: 0.05, soil: 0.02, noise: 0.2 },
    size: { w: 4, h: 4 },
    pack: 'BASE',
    cityEffects: { landValueRadius: 7, landValueAmount: 0.05 },
    upgrades: [],
  },
  edu_university_test: {
    id: 'edu_university_test',
    name: '大学',
    category: 'UNIVERSITY',
    educationOutput: 'HIGH',
    cost: 45000,
    monthlyUpkeep: 620,
    capacity: 1500,
    maxCapacity: 2400,
    baseStaff: 90,
    staffModel: { base: 90, studentsPerStaff: 25, minStaff: 90, maxStaff: 260 },
    pollution: { air: 0.08, soil: 0.03, noise: 0.15 },
    size: { w: 5, h: 5 },
    pack: 'BASE',
    cityEffects: { landValueRadius: 9, landValueAmount: 0.08 },
    upgrades: [],
  },

  // ---- BASE ----
  edu_elem_small: {
    id: 'edu_elem_small', name: '小さな小学校', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 40000, monthlyUpkeep: 5000, capacity: 400, maxCapacity: 400,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(400 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 9, h: 6 }, pack: 'BASE',
    upgrades: [
      { id: 'ext_wing', name: '拡張棟', cost: 8000, monthlyUpkeep: 1000, capacityBonus: 100, size: { w: 3, h: 9 }, multiInstance: true, note: '本体隣接・道路隣接必須' },
      { id: 'gymnasium', name: 'ギムナジウム', cost: 12000, monthlyUpkeep: 2000, size: { w: 6, h: 11 }, multiInstance: true, note: '本体隣接・道路隣接必須',
        cityEffects: { attractiveness: 1, welfare: { radius: 200, amount: 1 }, outdoorRecreation: 1 } },
    ],
  },
  edu_elem_standard: {
    id: 'edu_elem_standard', name: '小学校', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 100000, monthlyUpkeep: 12500, capacity: 1000, maxCapacity: 1500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1500 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 18, h: 8 }, pack: 'BASE',
    upgrades: [
      { id: 'child_clinic', name: '子供診療所', cost: 24000, monthlyUpkeep: 5000, size: { w: 6, h: 8 }, effects: { type: 'unknown' } },
      { id: 'ext_building', name: '拡張校舎', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 500 },
      { id: 'playground', name: '遊び場', cost: 24000, monthlyUpkeep: 2500, size: { w: 6, h: 4 },
        cityEffects: { attractiveness: 1, welfare: { radius: 300, amount: 1 }, outdoorRecreation: 1 } },
    ],
  },
  edu_elem_urban: {
    id: 'edu_elem_urban', name: '都市小学校', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 150000, monthlyUpkeep: 17500, capacity: 1500, maxCapacity: 2000,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(2000 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 6, h: 8 }, pack: 'BASE',
    upgrades: [
      { id: 'extra_floor', name: '追加階層', cost: 30000, monthlyUpkeep: 10000, capacityBonus: 500 },
      { id: 'schoolyard_playground', name: '校庭の遊び場', cost: 15000, monthlyUpkeep: 10000,
        cityEffects: { welfare: { radius: 300, amount: 1 } } },
    ],
  },
  // ---- MA ----
  edu_elem_community: {
    id: 'edu_elem_community', name: 'コミュニティ小学校', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 25000, monthlyUpkeep: 6000, capacity: 600, maxCapacity: 750,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(750 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 7, h: 5 }, pack: 'MA',
    upgrades: [
      { id: 'community_playground', name: 'コミュニティの遊び場', cost: 20000, monthlyUpkeep: 5000, size: { w: 7, h: 5 },
        cityEffects: { attractiveness: 15, outdoorRecreation: 20 } },
      { id: 'ext_building', name: '拡張校舎', cost: 17500, monthlyUpkeep: 4000, capacityBonus: 150 },
    ],
  },
  // ---- UP ----
  edu_elem_urbane: {
    id: 'edu_elem_urbane', name: '都会の小学校', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 125000, monthlyUpkeep: 14000, capacity: 1200, maxCapacity: 1700,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1700 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 7, h: 7 }, pack: 'UP',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 500 },
      { id: 'urbane_playground', name: '都会の遊び場', cost: 24000, monthlyUpkeep: 3500, effects: { type: 'unknown' } },
    ],
  },
  // ---- MH ----
  edu_elem_mediterranean: {
    id: 'edu_elem_mediterranean', name: '地中海風の小学校', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 100000, monthlyUpkeep: 10000, capacity: 1000, maxCapacity: 1500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1500 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 10, h: 5 }, pack: 'MH',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 22500, monthlyUpkeep: 4000, capacityBonus: 500 },
    ],
  },
  // ---- UK ----
  edu_elem_uk_urban: {
    id: 'edu_elem_uk_urban', name: '都会のプライマリスクール', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 100000, monthlyUpkeep: 12500, capacity: 500, maxCapacity: 1050,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1050 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 9, h: 8 }, pack: 'UK',
    upgrades: [
      { id: 'extra_classroom_large', name: '追加教室', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 500 },
      { id: 'extra_classroom_small', name: '追加教室', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 50 },
    ],
  },
  edu_elem_uk_suburban: {
    id: 'edu_elem_uk_suburban', name: '郊外のプライマリスクール', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 100000, monthlyUpkeep: 12500, capacity: 1000, maxCapacity: 1550,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1550 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 8, h: 15 }, pack: 'UK',
    upgrades: [
      { id: 'ext_classroom', name: '拡張教室', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 500 },
      { id: 'extra_classroom', name: '追加教室', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 50 },
    ],
  },
  // ---- EE ----
  edu_elem_ee_small: {
    id: 'edu_elem_ee_small', name: '小学校（東欧風）小型', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 40000, monthlyUpkeep: 12500, capacity: 100, maxCapacity: 190,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(190 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 7, h: 4 }, pack: 'EE',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 8000, monthlyUpkeep: 5000, capacityBonus: 90 },
    ],
  },
  edu_elem_ee_large: {
    id: 'edu_elem_ee_large', name: '小学校（東欧風）大型', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 150000, monthlyUpkeep: 12500, capacity: 1500, maxCapacity: 1500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1500 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 12, h: 12 }, pack: 'EE',
    upgrades: [],
  },
  // ---- FR ----
  edu_elem_fr: {
    id: 'edu_elem_fr', name: '小学校（フランス風）', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 125000, monthlyUpkeep: 12500, capacity: 1000, maxCapacity: 1250,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1250 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 6, h: 5 }, pack: 'FR',
    upgrades: [
      { id: 'schoolyard_sunroom', name: '校庭のサンルーム', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 250 },
    ],
  },
  // ---- DE ----
  edu_elem_de: {
    id: 'edu_elem_de', name: '小学校（ドイツ風）', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 100000, monthlyUpkeep: 12500, capacity: 1500, maxCapacity: 2000,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(2000 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 9, h: 9 }, pack: 'DE',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 500 },
      { id: 'gym_ext', name: '体育館拡張', cost: 22500, monthlyUpkeep: 3000, cityEffects: { outdoorRecreation: 20 } },
    ],
  },
  // ---- JP ----
  edu_elem_jp: {
    id: 'edu_elem_jp', name: '町の小学校（日本風）', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 100000, monthlyUpkeep: 12500, capacity: 1000, maxCapacity: 1500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1500 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 12, h: 16 }, pack: 'JP',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 22500, monthlyUpkeep: 5000, capacityBonus: 500 },
      { id: 'elem_gym', name: '小学校の体育館', cost: 24000, monthlyUpkeep: 2500,
        cityEffects: { welfare: { radius: 300, amount: 1 }, outdoorRecreation: 1 } },
    ],
  },
  // ---- CN ----
  edu_elem_cn: {
    id: 'edu_elem_cn', name: '紅岩小学校', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 50000, monthlyUpkeep: 5000, capacity: 800, maxCapacity: 800,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(800 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 6, h: 7 }, pack: 'CN',
    upgrades: [
      { id: 'hongyan_ext_project', name: '岩紅小学校拡張プロジェクト', cost: 24000, monthlyUpkeep: 2500, effects: { type: 'unknown' } },
    ],
  },
  // ---- NE ----
  edu_elem_ne: {
    id: 'edu_elem_ne', name: '小学校（アメリカ北東風）', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 150000, monthlyUpkeep: 17500, capacity: 1200, maxCapacity: 1500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1500 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 10, h: 7 }, pack: 'NE',
    cityEffects: { welfare: { radius: 1000, amount: 1 }, outdoorRecreation: 1, attractiveness: 1 },
    upgrades: [
      { id: 'ext_floor', name: '拡張階層', cost: 30000, monthlyUpkeep: 10000, capacityBonus: 300 },
    ],
  },
  // ---- SW ----
  edu_elem_sw: {
    id: 'edu_elem_sw', name: '小学校（アメリカ南西風）', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 75000, monthlyUpkeep: 12500, capacity: 1000, maxCapacity: 1500, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1500 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 14, h: 12 }, pack: 'SW',
    upgrades: [
      { id: 'art_music_wing', name: 'アート&ミュージック棟', cost: 5500, monthlyUpkeep: 500, capacityBonus: 500 },
      { id: 'extra_classroom', name: '追加教室', cost: 125000, monthlyUpkeep: 5000, capacityBonus: 1000 },
      { id: 'annex_building', name: 'アネックスビル', cost: 75000, monthlyUpkeep: 5000, size: { w: 9, h: 4 }, capacityBonus: 750, multiInstance: true },
    ],
  },
  // ---- NL ----
  edu_elem_nl: {
    id: 'edu_elem_nl', name: '小学校（オランダ風）', category: 'ELEMENTARY', educationOutput: 'LOW',
    cost: 100000, monthlyUpkeep: 12500, capacity: 1000, maxCapacity: 1500, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 20, minStaff: 15, maxStaff: 15 + Math.ceil(1500 / 20) },
    pollution: { air: 0.02, soil: 0.01, noise: 0.15 }, size: { w: 9, h: 4 }, pack: 'NL',
    upgrades: [
      { id: 'adventure_playground', name: 'アドベンチャープレイグラウンド', cost: 22500, monthlyUpkeep: 1500,
        cityEffects: { welfare: { radius: 1000, amount: 1 }, outdoorRecreation: 1, attractiveness: 2 } },
      { id: 'ext_wing', name: '拡張棟', cost: 22500, monthlyUpkeep: 5000, size: { w: 5, h: 4 }, capacityBonus: 500, multiInstance: true },
    ],
  },

  // ============ High Schools (高校) — Part 2/4 ============
  // ---- BASE ----
  edu_hs_small: {
    id: 'edu_hs_small', name: '小さな高校', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 150000, monthlyUpkeep: 11250, capacity: 400, maxCapacity: 500, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(500 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 12, h: 8 }, pack: 'BASE',
    upgrades: [
      { id: 'ext_wing', name: '拡張棟', cost: 40000, monthlyUpkeep: 3000, size: { w: 6, h: 6 }, capacityBonus: 100, multiInstance: true },
      { id: 'sports_park', name: '高校スポーツパーク', cost: 25000, monthlyUpkeep: 1500, size: { w: 13, h: 24 }, multiInstance: true,
        cityEffects: { attractiveness: 10, welfare: { radius: 300, amount: 3 }, outdoorRecreation: 10 } },
    ],
  },
  edu_hs_standard: {
    id: 'edu_hs_standard', name: '高校', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 22500, capacity: 800, maxCapacity: 1200,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1200 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 22, h: 16 }, pack: 'BASE',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 400, multiInstance: true },
      { id: 'school_library', name: '学校図書館', cost: 85000, monthlyUpkeep: 10000, multiInstance: true, effects: { type: 'unknown' } },
      { id: 'sports_ground', name: 'スポーツ場', cost: 56000, monthlyUpkeep: 7500, size: { w: 26, h: 20 }, multiInstance: true,
        cityEffects: { attractiveness: 25, welfare: { radius: 500, amount: 4 }, outdoorRecreation: 20 } },
    ],
  },
  edu_hs_urban: {
    id: 'edu_hs_urban', name: '都市高校', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 22500, capacity: 800, maxCapacity: 1200,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1200 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 12, h: 6 }, pack: 'BASE',
    upgrades: [
      { id: 'extra_floor', name: '追加階層', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 400 },
      { id: 'rooftop_sports_park', name: '屋上スポーツパーク', cost: 30000, monthlyUpkeep: 7500,
        cityEffects: { welfare: { radius: 500, amount: 4 }, outdoorRecreation: 40 } },
    ],
  },
  // ---- MA ----
  edu_hs_ma: {
    id: 'edu_hs_ma', name: 'モダンな高校', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 200000, monthlyUpkeep: 50000, capacity: 1750, maxCapacity: 1950, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1950 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 12, h: 6 }, pack: 'MA',
    upgrades: [
      { id: 'ext_edu_wing', name: '追加の教育棟', cost: 70000, monthlyUpkeep: 20000, size: { w: 6, h: 4 }, capacityBonus: 1000, multiInstance: true },
      { id: 'dormitory', name: '学生寮', cost: 50000, monthlyUpkeep: 5000, size: { w: 6, h: 4 }, capacityBonus: 200, multiInstance: true },
      { id: 'mindfulness_room', name: 'マインドフルネスルーム', cost: 7000, monthlyUpkeep: 1000, effects: { type: 'unknown' } },
    ],
  },
  // ---- UP ----
  edu_hs_up: {
    id: 'edu_hs_up', name: '都会の高校', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 20000, capacity: 800, maxCapacity: 1600,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1600 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 9, h: 8 }, pack: 'UP',
    upgrades: [
      { id: 'gym_ext', name: 'ジム拡張', cost: 56000, monthlyUpkeep: 7500, effects: { type: 'unknown' } },
      { id: 'ext_building', name: '拡張校舎', cost: 130000, monthlyUpkeep: 20000, capacityBonus: 800 },
    ],
  },
  // ---- MH ----
  edu_hs_mh: {
    id: 'edu_hs_mh', name: '地中海風の高校', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 30000, capacity: 800, maxCapacity: 1200,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1200 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 9, h: 8 }, pack: 'MH',
    cityEffects: { attractiveness: 10, outdoorRecreation: 10 },
    upgrades: [
      { id: 'extra_floor', name: '追加フロア', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 400 },
    ],
  },
  // ---- DG ----
  edu_hs_dg: {
    id: 'edu_hs_dg', name: '高校（中国の高校）', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 30000, capacity: 800, maxCapacity: 1200,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1200 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 13, h: 11 }, pack: 'DG',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 400 },
    ],
  },
  // ---- UK ----
  edu_hs_uk: {
    id: 'edu_hs_uk', name: 'セカンダリスクール', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 330000, monthlyUpkeep: 22500, capacity: 1500, maxCapacity: 1950,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1950 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 30, h: 19 }, pack: 'UK',
    upgrades: [
      { id: 'indoor_sports_facility', name: '屋内スポーツ施設', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 50 },
      { id: 'tech_wing', name: '技術棟', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 400 },
    ],
  },
  // ---- EE ----
  edu_hs_ee_small: {
    id: 'edu_hs_ee_small', name: '高校（東欧風）小型', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 150000, monthlyUpkeep: 22500, capacity: 250, maxCapacity: 450,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(450 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 8, h: 3 }, pack: 'EE',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 50000, monthlyUpkeep: 10000, capacityBonus: 200, multiInstance: true },
      { id: 'sports_hall', name: 'スポーツホール', cost: 25000, monthlyUpkeep: 1500, size: { w: 4, h: 4 }, multiInstance: true,
        cityEffects: { welfare: { radius: 300, amount: 3 }, outdoorRecreation: 10, attractiveness: 10 } },
    ],
  },
  edu_hs_ee_large: {
    id: 'edu_hs_ee_large', name: '高校（東欧風）大型', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 22500, capacity: 800, maxCapacity: 800,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(800 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 14, h: 10 }, pack: 'EE',
    upgrades: [],
  },
  // ---- FR ----
  edu_hs_fr: {
    id: 'edu_hs_fr', name: '高校（フランス風）', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 25000, capacity: 2500, maxCapacity: 2700,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(2700 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 9, h: 8 }, pack: 'FR',
    upgrades: [
      { id: 'science_lab', name: 'サイエンスラボ', cost: 4000, monthlyUpkeep: 2000, capacityBonus: 100 },
      { id: 'ext_schoolyard', name: '拡張校庭', cost: 4000, monthlyUpkeep: 2000, capacityBonus: 100,
        cityEffects: { welfare: { radius: 300, amount: 1 } } },
    ],
  },
  // ---- DE ----
  edu_hs_de: {
    id: 'edu_hs_de', name: '高校（ドイツ風）', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 330000, monthlyUpkeep: 22500, capacity: 1000, maxCapacity: 1600,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1600 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 8, h: 9 }, pack: 'DE',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 600 },
      { id: 'gym_ext', name: '体育館拡張', cost: 130000, monthlyUpkeep: 3000, cityEffects: { outdoorRecreation: 20 } },
    ],
  },
  // ---- JP ----
  edu_hs_jp: {
    id: 'edu_hs_jp', name: '町の高校（日本風）', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 22500, capacity: 800, maxCapacity: 1200,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1200 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 20, h: 22 }, pack: 'JP',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 400 },
      { id: 'hs_gym', name: '高校の体育館', cost: 56000, monthlyUpkeep: 7500,
        cityEffects: { outdoorRecreation: 20, welfare: { radius: 500, amount: 4 } } },
    ],
  },
  // ---- CN ----
  edu_hs_cn: {
    id: 'edu_hs_cn', name: '高校（中国風）', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 410000, monthlyUpkeep: 45000, capacity: 2000, maxCapacity: 2000,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(2000 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 18, h: 18 }, pack: 'CN',
    upgrades: [],
  },
  // ---- NE ----
  edu_hs_ne: {
    id: 'edu_hs_ne', name: '高校（アメリカ北東風）', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 22500, capacity: 800, maxCapacity: 1300,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1300 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 18, h: 14 }, pack: 'NE',
    cityEffects: { welfare: { radius: 1200, amount: 1 }, outdoorRecreation: 25, attractiveness: 1 },
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 500 },
    ],
  },
  // ---- SW ----
  edu_hs_sw: {
    id: 'edu_hs_sw', name: '高校（アメリカ南西風）', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 350000, monthlyUpkeep: 22500, capacity: 1200, maxCapacity: 1400, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(1400 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 42, h: 18 }, pack: 'SW',
    upgrades: [
      { id: 'library', name: '図書館', cost: 130000, monthlyUpkeep: 10000, capacityBonus: 230, multiInstance: true, effects: { type: 'unknown' } },
      { id: 'gymnasium', name: 'ギムナジウム', cost: 180000, monthlyUpkeep: 1500, capacityBonus: 240, multiInstance: true,
        cityEffects: { welfare: { radius: 1000, amount: 3 }, outdoorRecreation: 10, attractiveness: 10 } },
      { id: 'small_classroom_wing', name: '小型教室棟', cost: 85000, monthlyUpkeep: 10000, size: { w: 5, h: 8 }, capacityBonus: 200, multiInstance: true },
      { id: 'large_classroom_wing', name: '大型教室棟', cost: 100000, monthlyUpkeep: 6000, size: { w: 16, h: 6 }, capacityBonus: 500, multiInstance: true },
    ],
  },
  // ---- NL ----
  edu_hs_nl: {
    id: 'edu_hs_nl', name: '高等学校（オランダ風）', category: 'HIGH_SCHOOL', educationOutput: 'AVERAGE',
    cost: 300000, monthlyUpkeep: 22500, capacity: 2500, maxCapacity: 3500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 22, minStaff: 15, maxStaff: 15 + Math.ceil(3500 / 22) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.18 }, size: { w: 7, h: 9 }, pack: 'NL',
    upgrades: [
      { id: 'ext_wing', name: '拡張棟', cost: 100000, monthlyUpkeep: 15000, capacityBonus: 750,
        cityEffects: { welfare: { radius: 300, amount: 1 } }, effects: { type: 'unknown', note: '卒業時間短縮' } },
      { id: 'rooftop_chem_lab', name: '屋上化学実験室', cost: 35000, monthlyUpkeep: 3500, capacityBonus: 250,
        cityEffects: { welfare: { radius: 300, amount: 1 }, health: { radius: 300, amount: 1 } }, effects: { type: 'unknown', note: '卒業時間短縮' } },
    ],
  },

  // ============ University (大学) — Part 3/4 ============
  edu_univ_standard: {
    id: 'edu_univ_standard', name: '大学', category: 'UNIVERSITY', educationOutput: 'HIGH',
    cost: 750000, monthlyUpkeep: 75000, capacity: 10000, maxCapacity: 12500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(12500 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 22, h: 16 }, pack: 'BASE',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 300000, monthlyUpkeep: 27500, capacityBonus: 2500, multiInstance: true },
      { id: 'university_library', name: '大学図書館', cost: 245000, monthlyUpkeep: 25000, size: { w: 10, h: 8 }, multiInstance: true, effects: { type: 'unknown', category: 'graduationTime' } },
    ],
  },
  edu_univ_ma: {
    id: 'edu_univ_ma', name: 'モダンなコミュニティカレッジ', category: 'UNIVERSITY', educationOutput: 'HIGH',
    cost: 375000, monthlyUpkeep: 40000, capacity: 5000, maxCapacity: 5800, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(5800 / 25) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.15 }, size: { w: 20, h: 8 }, pack: 'MA',
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 100000, monthlyUpkeep: 15000, capacityBonus: 1000 },
      { id: 'student_dormitory', name: '大学学生寮', cost: 75000, monthlyUpkeep: 12000, size: { w: 10, h: 5 }, capacityBonus: 800, multiInstance: true },
      { id: 'sports_ground', name: 'スポーツ場', cost: 36000, monthlyUpkeep: 7500, size: { w: 20, h: 12 },
        cityEffects: { attractiveness: 25, outdoorRecreation: 40 } },
    ],
  },
  edu_univ_ee: {
    id: 'edu_univ_ee', name: '単科大学（東欧風）', category: 'UNIVERSITY', educationOutput: 'HIGH',
    cost: 750000, monthlyUpkeep: 75000, capacity: 10000, maxCapacity: 10000,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(10000 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 16, h: 10 }, pack: 'EE',
    upgrades: [],
  },
  edu_univ_fr: {
    id: 'edu_univ_fr', name: '単科大学（フランス風）', category: 'UNIVERSITY', educationOutput: 'HIGH',
    cost: 450000, monthlyUpkeep: 55000, capacity: 1500, maxCapacity: 1650,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(1650 / 25) },
    pollution: { air: 0, soil: 0, noise: 0 }, size: { w: 8, h: 2 }, pack: 'FR',
    upgrades: [
      { id: 'rooftop_leisure_area', name: '屋上レジャーエリア', cost: 75000, monthlyUpkeep: 10000, capacityBonus: 150 },
    ],
  },
  edu_univ_jp: {
    id: 'edu_univ_jp', name: '単科大学（日本風）', category: 'UNIVERSITY', educationOutput: 'HIGH',
    cost: 750000, monthlyUpkeep: 75000, capacity: 10000, maxCapacity: 11500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(11500 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 16, h: 16 }, pack: 'JP',
    upgrades: [
      { id: 'faculty_building', name: '学部棟', cost: 245000, monthlyUpkeep: 25000, capacityBonus: 750 },
      { id: 'cafeteria_shop', name: '食堂と売店', cost: 245000, monthlyUpkeep: 25000, capacityBonus: 750, effects: { type: 'unknown', category: 'graduationTime' } },
    ],
  },
  edu_univ_cn: {
    id: 'edu_univ_cn', name: '専門学校（中国風）', category: 'UNIVERSITY', educationOutput: 'HIGH',
    cost: 650000, monthlyUpkeep: 50000, capacity: 6000, maxCapacity: 6000,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(6000 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 18, h: 12 }, pack: 'CN',
    upgrades: [],
  },
  edu_univ_nl: {
    id: 'edu_univ_nl', name: '大学講堂（オランダ風）', category: 'UNIVERSITY', educationOutput: 'HIGH',
    cost: 350000, monthlyUpkeep: 45000, capacity: 750, maxCapacity: 750,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(750 / 25) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.15 }, size: { w: 4, h: 5 }, pack: 'NL',
    effects: { type: 'unknown', category: 'graduationTime', note: '最短相当' },
    upgrades: [],
  },

  // ============ Comprehensive University (総合大学) — Part 3/4 ============
  edu_compuniv_standard: {
    id: 'edu_compuniv_standard', name: '総合大学', category: 'COMPREHENSIVE_UNIVERSITY', educationOutput: 'VERY_HIGH',
    cost: 1500000, monthlyUpkeep: 100000, capacity: 15000, maxCapacity: 17500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(17500 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 40, h: 28 }, pack: 'BASE',
    upgrades: [
      { id: 'university_library', name: '総合大学図書館', cost: 250000, monthlyUpkeep: 47500, size: { w: 12, h: 12 }, effects: { type: 'unknown', category: 'graduationTime' } },
      { id: 'ext_building', name: '拡張校舎', cost: 375000, monthlyUpkeep: 37500, capacityBonus: 2500 },
      { id: 'university_park', name: '総合大学公園', cost: 50000, monthlyUpkeep: 20000, size: { w: 18, h: 18 }, multiInstance: true,
        cityEffects: { attractiveness: 10, welfare: { radius: 500, amount: 4 }, outdoorRecreation: 20 } },
    ],
  },
  edu_compuniv_ma: {
    id: 'edu_compuniv_ma', name: 'モダンな総合大学', category: 'COMPREHENSIVE_UNIVERSITY', educationOutput: 'VERY_HIGH',
    cost: 750000, monthlyUpkeep: 50000, capacity: 8500, maxCapacity: 10500, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(10500 / 25) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.15 }, size: { w: 16, h: 8 }, pack: 'MA',
    upgrades: [
      { id: 'academy_facility', name: 'アカデミー施設', cost: 115000, monthlyUpkeep: 10000, size: { w: 4, h: 6 }, capacityBonus: 2000, note: '騒音 中' },
      { id: 'university_library', name: '総合大学図書館', cost: 250000, monthlyUpkeep: 70000, size: { w: 8, h: 10 }, capacityBonus: 8500, effects: { type: 'unknown', category: 'graduationTime' } },
      { id: 'ext_building', name: '拡張校舎', cost: 180000, monthlyUpkeep: 10500, capacityBonus: 2000 },
    ],
  },
  edu_compuniv_jp: {
    id: 'edu_compuniv_jp', name: '総合大学（日本風）', category: 'COMPREHENSIVE_UNIVERSITY', educationOutput: 'VERY_HIGH',
    cost: 1500000, monthlyUpkeep: 100000, capacity: 12500, maxCapacity: 16500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(16500 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 25, h: 19 }, pack: 'JP',
    upgrades: [
      { id: 'university_library', name: '総合大学図書館', cost: 250000, monthlyUpkeep: 47500, size: { w: 6, h: 5 }, effects: { type: 'unknown', category: 'graduationTime' } },
      { id: 'ext_building', name: '拡張校舎', cost: 375000, monthlyUpkeep: 37500, capacityBonus: 4000 },
    ],
  },
  edu_compuniv_cn: {
    id: 'edu_compuniv_cn', name: '総合大学（中国風）', category: 'COMPREHENSIVE_UNIVERSITY', educationOutput: 'VERY_HIGH',
    cost: 1300000, monthlyUpkeep: 65000, capacity: 5500, maxCapacity: 7500, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(7500 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 38, h: 20 }, pack: 'CN',
    upgrades: [
      { id: 'literature_college', name: '文学院', cost: 375000, monthlyUpkeep: 37500, capacityBonus: 6000 },
      { id: 'science_college', name: '理学院', cost: 375000, monthlyUpkeep: 37500, capacityBonus: 6000 },
      { id: 'athletic_track', name: '競技トラック', cost: 50000, monthlyUpkeep: 20000, size: { w: 18, h: 23 },
        cityEffects: { attractiveness: 10, welfare: { radius: 500, amount: 4 }, outdoorRecreation: 20 } },
      { id: 'campus_building', name: '大学校舎', cost: 250000, monthlyUpkeep: 47500, size: { w: 16, h: 12 }, capacityBonus: 4500 },
      { id: 'academy_wing', name: '大学学院', cost: 100000, monthlyUpkeep: 10000, size: { w: 8, h: 5 }, capacityBonus: 2000 },
    ],
  },
  edu_compuniv_nl: {
    id: 'edu_compuniv_nl', name: '大学（オランダ風）', category: 'COMPREHENSIVE_UNIVERSITY', educationOutput: 'VERY_HIGH',
    cost: 350000, monthlyUpkeep: 50000, capacity: 5000, maxCapacity: 6500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(6500 / 25) },
    pollution: { air: 0.03, soil: 0.01, noise: 0.15 }, size: { w: 10, h: 9 }, pack: 'NL',
    upgrades: [
      { id: 'auditorium', name: '講堂', cost: 150000, monthlyUpkeep: 15000, capacityBonus: 1500, effects: { type: 'unknown', category: 'graduationTime' } },
      { id: 'research_library', name: '研究図書館', cost: 100000, monthlyUpkeep: 20000, effects: { type: 'unknown', category: 'graduationTime' } },
    ],
  },

  // ============ Engineering University (工科大学) — Part 3/4 ============
  edu_enguniv_standard: {
    id: 'edu_enguniv_standard', name: '工科大学', category: 'ENGINEERING_UNIVERSITY', educationOutput: 'VERY_HIGH',
    cost: 1600000, monthlyUpkeep: 160000, capacity: 15000, maxCapacity: 17500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(17500 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 53, h: 38 }, pack: 'BASE',
    cityEffects: { industryEfficiency: 0.10, officeEfficiency: 0.10 },
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 320000, monthlyUpkeep: 57500, capacityBonus: 2500 },
      { id: 'workshop_renovation', name: '作業場改修', cost: 320000, monthlyUpkeep: 50000, effects: { type: 'unknown', category: 'graduationTime' } },
    ],
  },
  edu_enguniv_ma: {
    id: 'edu_enguniv_ma', name: 'モダンな工科大学', category: 'ENGINEERING_UNIVERSITY', educationOutput: 'VERY_HIGH',
    cost: 985000, monthlyUpkeep: 63600, capacity: 9850, maxCapacity: 10350, maxCapacityUnbounded: true,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(10350 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 24, h: 16 }, pack: 'MA',
    cityEffects: { industryEfficiency: 0.10, officeEfficiency: 0.10 },
    upgrades: [
      { id: 'ext_building_a', name: '拡張校舎', cost: 240000, monthlyUpkeep: 27500, capacityBonus: 4500 },
      { id: 'ext_building_b', name: '拡張校舎', cost: 110000, monthlyUpkeep: 17500, capacityBonus: 3000 },
      { id: 'student_plaza', name: 'モダンな学生広場', cost: 30000, monthlyUpkeep: 5000, effects: { type: 'unknown' } },
      { id: 'engineering_academy_facility', name: '工科アカデミー施設', cost: 211000, monthlyUpkeep: 22500, size: { w: 4, h: 12 }, capacityBonus: 2110, multiInstance: true, note: '騒音 中' },
      { id: 'auditorium', name: '講堂', cost: 200000, monthlyUpkeep: 25000, size: { w: 10, h: 12 }, capacityBonus: 500, effects: { type: 'unknown', category: 'graduationTime' } },
    ],
  },

  // ============ Medical University (医科大学) — Part 3/4 ============
  edu_meduniv_standard: {
    id: 'edu_meduniv_standard', name: '医科大学', category: 'MEDICAL_UNIVERSITY', educationOutput: 'VERY_HIGH',
    cost: 2400000, monthlyUpkeep: 240000, capacity: 15000, maxCapacity: 17500,
    baseStaff: 15, staffModel: { base: 15, studentsPerStaff: 25, minStaff: 15, maxStaff: 15 + Math.ceil(17500 / 25) },
    pollution: { air: 0.05, soil: 0.02, noise: 0.3 }, size: { w: 62, h: 18 }, pack: 'BASE',
    cityEffects: { treatmentFailureRate: -0.25, hospitalEfficiency: 0.10 },
    upgrades: [
      { id: 'ext_building', name: '拡張校舎', cost: 480000, monthlyUpkeep: 57500, capacityBonus: 2500 },
      { id: 'university_hospital', name: '大学病院', cost: 480000, monthlyUpkeep: 50000, size: { w: 15, h: 7 }, multiInstance: true,
        cityEffects: { patientCapacity: 100, health: { radius: 1000, amount: 0.05 } } },
      { id: 'research_facility', name: '研究施設', cost: 480000, monthlyUpkeep: 75000, size: { w: 16, h: 8 }, effects: { type: 'unknown', category: 'graduationTime' } },
    ],
  },

  // ============ Research Facilities (研究施設) — Part 4/4 ============
  // Research facilities do NOT enroll students (§学生を直接収容しない研究施設) — they exist purely
  // to feed computeEducationCityEffects() (studentCapacity/studentCount kept at 0 below, not
  // omitted, per spec). They are still School/Education-Inspector-owned data (never treated as a
  // School per §教育施設と研究施設の違い), and their cityEffects follow the same one-way
  // "facility definition -> static effect -> city aggregate" flow as every other definition here —
  // none of oreDeposit/oilDeposit/universityInterest/etc. are ever fed back into a definition, so
  // there is no self-reference or infinite-growth path (§自己参照・無限増加禁止).
  edu_research_radio_telescope: {
    id: 'edu_research_radio_telescope', name: '電波望遠鏡', category: 'RESEARCH', educationOutput: 'NONE',
    cost: 3200000, monthlyUpkeep: 160000, capacity: 0, maxCapacity: 0, studentCapacity: 0, studentCount: 0,
    baseStaff: 0, staffModel: { base: 0, studentsPerStaff: 1, minStaff: 0, maxStaff: 0 },
    pollution: { air: 0, soil: 0, noise: 0 }, size: { w: 8, h: 8 }, pack: 'BASE',
    cityEffects: { comprehensiveUniversityGraduationRate: 0.05, universityInterest: 0.15 },
    upgrades: [],
  },
  edu_research_geological_institute: {
    id: 'edu_research_geological_institute', name: '地質研究所', category: 'RESEARCH', educationOutput: 'NONE',
    cost: 2500000, monthlyUpkeep: 115000, capacity: 0, maxCapacity: 0, studentCapacity: 0, studentCount: 0,
    baseStaff: 0, staffModel: { base: 0, studentsPerStaff: 1, minStaff: 0, maxStaff: 0 },
    pollution: { air: 0, soil: 0, noise: 0.15 }, size: { w: 12, h: 12 }, pack: 'BASE', // 騒音: 中
    // 資源産出システムは今回未実装 — oreDeposit/oilDepositは「将来の都市効果」として保存するのみ。
    cityEffects: { oreDeposit: 2.0, oilDeposit: 2.0, universityGraduationRate: 0.03 },
    upgrades: [],
  },
  edu_research_lhc: {
    id: 'edu_research_lhc', name: '大型ハドロン衝突型加速器', category: 'RESEARCH', educationOutput: 'NONE',
    cost: 4000000, monthlyUpkeep: 200000, capacity: 0, maxCapacity: 0, studentCapacity: 0, studentCount: 0,
    baseStaff: 0, staffModel: { base: 0, studentsPerStaff: 1, minStaff: 0, maxStaff: 0 },
    pollution: { air: 0, soil: 0, noise: 0 }, size: { w: 54, h: 64 }, pack: 'BASE',
    // 水消費などのインフラ計算は今回未実装 — cityEffectsのみ保存。
    cityEffects: {
      universityInterest: 0.15, softwareDemand: 0.20, electronicsDemand: 0.20,
      softwareProductionEfficiency: 0.05, electronicsProductionEfficiency: 0.05,
    },
    upgrades: [],
  },
  edu_research_library_cn: {
    id: 'edu_research_library_cn', name: '市立図書館（中国風）', category: 'RESEARCH', educationOutput: 'NONE',
    cost: 2200000, monthlyUpkeep: 115000, capacity: 0, maxCapacity: 0, studentCapacity: 0, studentCount: 0,
    baseStaff: 0, staffModel: { base: 0, studentsPerStaff: 1, minStaff: 0, maxStaff: 0 },
    pollution: { air: 0, soil: 0, noise: 0.08 }, size: { w: 14, h: 12 }, pack: 'CN', // 騒音: 低
    cityEffects: {
      attractiveness: 10, universityGraduationRate: 0.01, comprehensiveUniversityGraduationRate: 0.01,
      universityInterest: 0.05, outdoorRecreation: 5,
      welfare: { radius: 1000, amount: 5 },
    },
    // 自由時間に市民が訪れる将来拡張ポイント（Citizen visitor AIは今回禁止 — フラグのみ保持）。
    freeTimeVisitorHook: 'reserved_future_visitor_ai',
    upgrades: [],
  },
};

let eduFacilityInstanceIdSeq = 1;
// Instance = "a specific placed building" — performance numbers are looked up from
// EDUCATION_FACILITIES[definitionId] on demand, never copied in, so a definition balance change
// instantly applies to every placed instance (same pattern as lots referencing RES_LOT_TYPES).
function createEducationFacilityInstance(definitionId, tx, ty) {
  const def = EDUCATION_FACILITIES[definitionId];
  if (!def) return null;
  return {
    instanceId: `edufac_${eduFacilityInstanceIdSeq++}`,
    definitionId,
    tx, ty,
    w: def.size.w, h: def.size.h,
    upgrades: [],
    currentCapacity: def.capacity,
    currentStaff: def.baseStaff,
    enabled: true,
    monthlyUpkeep: def.monthlyUpkeep,
    group: null,
    // Part 5: enrolledStudents is the SINGLE source of truth for who is enrolled here — a Set of
    // citizen ids (not a count), so GRADUATE/LEAVE/withdraw/removeFacility can all remove by id in
    // O(1) and availableSeats is always derived (currentCapacity - enrolledStudents.size), never
    // hand-incremented/decremented separately (§二重管理による不整合を防いでください).
    enrolledStudents: new Set(),
  };
}

// Part 3/4: recompute an instance's derived numbers (capacity/upkeep/staff) from its definition
// plus whatever upgrades are currently installed (instance.upgrades holds upgrade-id strings;
// a multiInstance upgrade simply appears more than once). Definitions are never mutated — this
// only writes back onto the instance, exactly like the rest of the Part 1 instance/definition split.
function recalcEducationFacilityInstance(instance) {
  const def = EDUCATION_FACILITIES[instance.definitionId];
  if (!def) return;
  let capacityBonus = 0, upkeepBonus = 0;
  for (const upgradeId of instance.upgrades) {
    const upgradeDef = (def.upgrades || []).find((u) => u.id === upgradeId);
    if (!upgradeDef) continue;
    capacityBonus += upgradeDef.capacityBonus || 0;
    upkeepBonus += upgradeDef.monthlyUpkeep || 0;
  }
  let capacity = def.capacity + capacityBonus;
  if (!def.maxCapacityUnbounded && typeof def.maxCapacity === 'number') {
    capacity = Math.min(capacity, def.maxCapacity);
  }
  instance.currentCapacity = capacity;
  instance.monthlyUpkeep = def.monthlyUpkeep + upkeepBonus;
  const sm = def.staffModel || { base: def.baseStaff, studentsPerStaff: 20, minStaff: def.baseStaff, maxStaff: def.baseStaff };
  const rawStaff = sm.base + Math.ceil(capacity / (sm.studentsPerStaff || 20));
  instance.currentStaff = Math.min(sm.maxStaff ?? rawStaff, Math.max(sm.minStaff ?? sm.base, rawStaff));
}

// Part 3/4: cityEffects live on facility/upgrade DEFINITIONS (§教育施設自身の都市効果 — the
// "effect of the facility itself", never mutated). educationCityEffectsRef below stores the
// separate "city-wide aggregate" — a plain sum recomputed from scratch over every placed,
// enabled instance each time this runs. Because it is always rebuilt from the current instance
// list (never incremented onto its own prior value), it cannot self-reference or compound —
// two university hospitals contribute their patientCapacity/health exactly twice, not more.
const EDU_CITY_EFFECT_FLAT_KEYS = [
  'industryEfficiency', 'officeEfficiency', 'treatmentFailureRate', 'hospitalEfficiency', 'patientCapacity', 'healthRadiusEffect', 'attractiveness', 'outdoorRecreation',
  // Part 4/4: research-facility / library effect keys — summed the exact same way as the keys
  // above (never applied to industry/office/hospital/resource systems yet, per §禁止事項).
  'universityInterest', 'universityGraduationRate', 'comprehensiveUniversityGraduationRate',
  'softwareDemand', 'electronicsDemand', 'softwareProductionEfficiency', 'electronicsProductionEfficiency',
  'oreDeposit', 'oilDeposit',
];
function addEducationCityEffectSource(aggregate, effectsObj, sourceName) {
  if (!effectsObj) return;
  for (const key of EDU_CITY_EFFECT_FLAT_KEYS) {
    if (typeof effectsObj[key] === 'number') aggregate[key] = (aggregate[key] || 0) + effectsObj[key];
  }
  // welfare/health are radius-scoped, not city-wide flat numbers — kept as a list of individual
  // sources rather than summed into one meaningless radius, so future spatial code can apply each.
  if (effectsObj.welfare && typeof effectsObj.welfare.amount === 'number') {
    aggregate.radiusEffects.push({ type: 'welfare', radius: effectsObj.welfare.radius, amount: effectsObj.welfare.amount, source: sourceName });
  }
  if (effectsObj.health && typeof effectsObj.health.amount === 'number') {
    aggregate.radiusEffects.push({ type: 'health', radius: effectsObj.health.radius, amount: effectsObj.health.amount, source: sourceName });
  }
}
function computeEducationCityEffects(facilitiesMap) {
  const aggregate = {
    industryEfficiency: 0, officeEfficiency: 0,
    treatmentFailureRate: 0, hospitalEfficiency: 0,
    patientCapacity: 0, healthRadiusEffect: 0,
    attractiveness: 0, outdoorRecreation: 0,
    // Part 4/4 additions (research facilities / CN library) — same flat-sum treatment as above.
    universityInterest: 0, universityGraduationRate: 0, comprehensiveUniversityGraduationRate: 0,
    softwareDemand: 0, electronicsDemand: 0, softwareProductionEfficiency: 0, electronicsProductionEfficiency: 0,
    oreDeposit: 0, oilDeposit: 0,
    radiusEffects: [],
  };
  for (const instance of facilitiesMap.values()) {
    if (!instance.enabled) continue;
    const def = EDUCATION_FACILITIES[instance.definitionId];
    if (!def) continue;
    if (def.cityEffects) addEducationCityEffectSource(aggregate, def.cityEffects, def.name);
    for (const upgradeId of instance.upgrades) {
      const upgradeDef = (def.upgrades || []).find((u) => u.id === upgradeId);
      if (upgradeDef && upgradeDef.cityEffects) addEducationCityEffectSource(aggregate, upgradeDef.cityEffects, `${def.name} / ${upgradeDef.name}`);
    }
  }
  return aggregate;
}

// Age is NEVER incremented per tick — always derived on demand from birthTime vs the current
// GameClock time, exactly like differenceInGameDays() above.
function getCitizenAgeDays(citizen, nowEpochMs) {
  return Math.max(0, differenceInGameDays(nowEpochMs, citizen.birthTime));
}
// single source of truth for life-stage boundaries — change AGE_STAGE_DAYS above, not this.
function getAgeGroup(ageDays) {
  if (ageDays >= AGE_GROUP_START_DAY.Elderly) return 'Elderly';
  if (ageDays >= AGE_GROUP_START_DAY.Adult) return 'Adult';
  if (ageDays >= AGE_GROUP_START_DAY.Teen) return 'Teen';
  return 'Child';
}

let citizenIdSeq = 1, householdIdSeq = 1;

function createCitizen(overrides) {
  const education = overrides.education || EDUCATION_LEVELS[Math.floor(Math.random() * EDUCATION_LEVELS.length)];
  return {
    id: overrides.id ?? `cit_${citizenIdSeq++}`,
    name: overrides.name || GIVEN_NAMES[Math.floor(Math.random() * GIVEN_NAMES.length)],
    birthTime: overrides.birthTime, // epoch ms (GameClock time), required
    alive: true,
    deathTime: null,
    ageGroup: overrides.ageGroup || 'Adult', // cached label, recomputed via refreshCitizenAgeGroup()
    education,
    educationProgress: 0,
    // Part 3: extensible higher-education decision — null until a Teen actually graduates high
    // school (or an Adult opts back in); see decideHigherEducation()/desiredEducationCategory() below.
    educationDecision: overrides.educationDecision ?? null,
    // Part 3: fixed at creation (not re-rolled) so "does this LOW-education Adult ever go back to
    // finish high school" stays a stable trait per citizen rather than a coin flip every retry.
    wantsAdultReeducation: overrides.wantsAdultReeducation ?? (Math.random() < 0.15),
    // Part 5: fixed at creation (not re-rolled), same pattern as wantsAdultReeducation — decides
    // once whether this citizen continues on to highschool after finishing elementary, so LOW
    // education keeps a real population share instead of 100% of Teens progressing (§進学率).
    wantsHighschool: overrides.wantsHighschool ?? (Math.random() < EDUCATION_PROGRESSION_RULES.ELEMENTARY_TO_HIGHSCHOOL),
    educationHistory: overrides.educationHistory ?? [],
    occupation: overrides.occupation ?? null,
    preferredJobLevel: EDUCATION_TO_PREFERRED_JOB_LEVEL[education],
    actualJobLevel: overrides.actualJobLevel ?? null,
    workplaceId: null,
    currentSchoolId: null,
    householdId: overrides.householdId ?? null,
    homeId: overrides.homeId ?? null,
    personalMoney: overrides.personalMoney ?? 0,
    // Part 5: health is a 0-100 gauge (design doc §Health: "0～100程度で構いません"). statuses is
    // an array of {type, since, meta} objects — a Citizen can hold several at once (e.g. SICK AND
    // HOMELESS simultaneously) — see STATUS_TYPES / addCitizenStatus below.
    health: overrides.health ?? Math.round(70 + Math.random() * 30),
    statuses: [],
    // Part 5: cityResident=false is what Migration uses to drop a Citizen out of the population
    // count WITHOUT deleting the record (§Migration: "Citizen recordそのものは保持"). alive stays
    // true for a migrant — only Death sets alive=false. Population = alive && cityResident.
    cityResident: overrides.cityResident ?? true,
    homelessSince: null,
    // Part 5: guards the HEALTH_CHECK self-rescheduling chain, exactly like dailyRoutineActive
    // guards PLAN_DAY — started once via bootstrapHealth(), never re-triggered.
    healthRoutineActive: false,
    lastHealthCheckDay: -Infinity,
    currentActivity: 'idle',
    activityStartTime: overrides.birthTime,
    activityEndTime: null,
    destinationType: null,
    destinationId: null,
    // Part 4: a real structured travel window (or null when stationary) — see §TravelState /
    // simulateCitizenUntil(). Was a placeholder 'none' string in Part 2; nothing outside Part 4
    // ever read it, so repurposing it as null|object here is safe.
    travelState: null,
    lastSimulatedAt: overrides.birthTime,
    // Part 4: Employee-only fields (§給与/§Daily Schedule). salary is a per-workday wage paid to
    // the household on END_WORK; shift is rolled once at hire time (§Employee 70/30 split) and
    // kept stable, not re-rolled daily.
    salary: overrides.salary ?? 0,
    shift: overrides.shift ?? null,
    // Part 4: guards so PLAN_DAY's self-rescheduling chain (§Daily Schedule) is only ever
    // started ONCE per citizen, from whichever transition gets there first (bootstrap seed,
    // BECOME_ADULT, or GRADUATE-without-further-school) — see handleWorkplaceEvent below.
    dailyRoutineActive: overrides.dailyRoutineActive ?? false,
    lastJobSearchDay: -Infinity, // §Unemployed: throttles JOB_SEARCH retries to once every JOB_SEARCH_RETRY_DAYS
  };
}

function createHousehold(overrides) {
  return {
    id: overrides.id ?? `hh_${householdIdSeq++}`,
    members: overrides.members || [], // citizen ids
    homeId: overrides.homeId ?? null, // tile index / lot id
    wealth: overrides.wealth ?? 0,
    income: 0,
    expenses: 0,
    housingCost: overrides.housingCost ?? 0,
    householdState: 'normal',
    // Part 4: guards against charging housingCost more than once on the same game-day when
    // several members of the same household RETURN_HOME on the same day (§Household経済).
    lastRentDay: -1,
    // Part 5: guards evictToHomeless() so a household already evicted (§Homeless: "家賃を払えな
    // い" / "家を失う") isn't evicted again every subsequent rent day.
    evicted: false,
  };
}

// keeps a Citizen's cached ageGroup field in sync — call after time jumps large enough to matter
// (e.g. once per growth tick), never per rendered frame.
function refreshCitizenAgeGroup(citizen, nowEpochMs) {
  citizen.ageGroup = getAgeGroup(getCitizenAgeDays(citizen, nowEpochMs));
  citizen.lastSimulatedAt = nowEpochMs;
  return citizen.ageGroup;
}

// Rendering LOD (data-only foundation — nothing calls this yet). Distance is in grid tiles from
// whatever the active camera is looking at; callers decide the thresholds later. Citizens are
// NEVER removed from citizensRef by LOD — only their rendering treatment changes.
function getCitizenLodTier(distanceInTiles) {
  if (distanceInTiles <= 24) return 'NEAR'; // full 3D avatar, walking, camera-trackable
  if (distanceInTiles <= 80) return 'MID'; // simplified position, updated occasionally
  return 'FAR'; // no 3D avatar; life simulation still runs via SimulationManager/time-jump
}

// ============ School / Education Lifecycle (city-sim foundation, Part 3) ============
// Builds strictly on top of Part 1 (GameClock / SimulationManager+event queue) and Part 2
// (Citizen / Household / AGE_STAGE_DAYS / EDUCATION_LEVELS) — neither is modified. Nothing below
// scans citizensRef every frame, or even every tick: every state change (age-stage transition,
// a school day starting/ending, graduation) is scheduled once on the SAME SimulationManager queue
// Part 1 already built, and the next event time is always derived on demand (birthTime + a fixed
// day-threshold, a school's openTime, ...), exactly like getCitizenAgeDays() never keeps a running
// counter. See SIM_EVENT_TYPES above for the event vocabulary this section drives.

// Part 5: schedule/eligibility constants keyed by EDUCATION_FACILITY_CATEGORIES. This is
// deliberately NOT a second facility registry — cost/capacity/upkeep/pollution/cityEffects/
// upgrades all stay exclusively on EDUCATION_FACILITIES (Part 1-4); this table only holds the
// operational scheduling data (school hours, nominal course length, which ageGroups may attend)
// that Part 1-4's economic definitions never needed. Enrollment/graduation below always reads
// capacity/enabled from the real placed instance (educationFacilitiesRef), never from here.
const EDU_CATEGORY_SCHEDULE = {
  ELEMENTARY: { openTime: 8, closeTime: 15, graduationDays: AGE_STAGE_DAYS.childToTeen, attendsAgeGroups: ['Child'] },
  HIGH_SCHOOL: { openTime: 8, closeTime: 15, graduationDays: AGE_STAGE_DAYS.teenToAdult, attendsAgeGroups: ['Teen', 'Adult'] },
  UNIVERSITY: { openTime: 9, closeTime: 16, graduationDays: 40, attendsAgeGroups: ['Teen', 'Adult'] },
  COMPREHENSIVE_UNIVERSITY: { openTime: 9, closeTime: 16, graduationDays: 60, attendsAgeGroups: ['Teen', 'Adult'] },
  ENGINEERING_UNIVERSITY: { openTime: 9, closeTime: 16, graduationDays: 60, attendsAgeGroups: ['Teen', 'Adult'] },
  MEDICAL_UNIVERSITY: { openTime: 9, closeTime: 16, graduationDays: 70, attendsAgeGroups: ['Teen', 'Adult'] },
};
// School only runs on weekdays (design doc §時間帯) — graduationDays above is calendar days matched
// to the corresponding age-stage length, but attendance only happens ~5/7 of those days, so
// advanceEducationProgress() below converts it into a school-DAY count, not a calendar-day count.
const SCHOOL_DAYS_PER_WEEK = 5;

// Part 5: how eagerly a citizen advances to the NEXT education stage — never 100%, so NONE/LOW/
// AVERAGE/HIGH/VERY_HIGH all keep a real population share (§進学率を100%固定にしない / §禁止：
// 学校を建てたら全市民が勝手に高学歴になる). Kept as one small constant table, not a hardcoded
// probability scattered through the decision functions below.
const EDUCATION_PROGRESSION_RULES = {
  ELEMENTARY_TO_HIGHSCHOOL: 0.9, // 小学校 → 高校: 高確率
  HIGHSCHOOL_TO_UNIVERSITY: 0.45, // 高校 → 大学: 中程度
  UNIVERSITY_TO_COMPREHENSIVE: 0.12, // 大学 → 総合大学: 低〜中程度
  UNIVERSITY_TO_ENGINEERING: 0.10, // 大学 → 工科大学: 低〜中程度
  UNIVERSITY_TO_MEDICAL: 0.07, // 大学 → 医科大学: 低〜中程度
};

function facilityAvailableSeats(instance) { return Math.max(0, instance.currentCapacity - instance.enrolledStudents.size); }
function facilityHasCapacity(instance) { return facilityAvailableSeats(instance) > 0; }

// Home tile lookup mirrors resolveAnchorTile('home', ...) inside the component (§距離: 新しい
//交通網/道路システムは作らず、既存homeIdをそのままworld/grid distanceに使う) — duplicated here as
// a tiny pure function only because this file's free-function section runs outside the component
// and has no access to lotsRef; the numeric-tile-index case (the common one — see resHomePool) is
// identical to resolveAnchorTile's own logic.
function homeTileForCitizen(citizen) {
  if (citizen.homeId == null || typeof citizen.homeId !== 'number') return null;
  return { tx: citizen.homeId % GRID_SIZE, ty: Math.floor(citizen.homeId / GRID_SIZE) };
}
function educationFacilityCenterTile(instance) {
  return { tx: instance.tx + (instance.w - 1) / 2, ty: instance.ty + (instance.h - 1) / 2 };
}
function tileDistance(a, b) {
  if (!a || !b) return GRID_SIZE; // unknown distance -> treat as far-ish rather than crashing/ranking first
  return Math.hypot(a.tx - b.tx, a.ty - b.ty);
}

// §学校選択スコア: distance + seat availability + education-level fit, kept intentionally simple
// (Part 5's job is the Citizen<->Facility connection, not a full suitability model). A facility
// offering the right category has already satisfied "適切な教育レベル", so that term is a flat
// bonus rather than a separate scored axis.
function scoreEducationFacility(instance, homeTile) {
  const seats = facilityAvailableSeats(instance);
  const seatScore = Math.min(1, seats / 50);
  const dist = tileDistance(homeTile, educationFacilityCenterTile(instance));
  const distanceScore = 1 / (1 + dist / GRID_SIZE);
  const educationLevelScore = 0.2; // flat: category match is a precondition for even reaching this scorer
  return distanceScore * 0.5 + seatScore * 0.35 + educationLevelScore * 0.15;
}

// §学校選択: searches the REAL placed EDUCATION_FACILITIES instances (never a second registry,
// never auto-builds one — §禁止：教育施設が勝手に建つ) for the best-scoring facility of `category`
// that is enabled and has a free seat. Returns null (never forces an enrollment) if none qualify —
// caller (START_SCHOOL handler) treats that exactly like "citywide full" and retries later.
function findBestEducationFacility(citizen, facilitiesMap, category) {
  if (!category) return null;
  const homeTile = homeTileForCitizen(citizen);
  let best = null, bestScore = -Infinity;
  facilitiesMap.forEach((instance) => {
    if (!instance.enabled) return;
    const def = EDUCATION_FACILITIES[instance.definitionId];
    if (!def || def.category !== category) return;
    if (!facilityHasCapacity(instance)) return;
    const score = scoreEducationFacility(instance, homeTile);
    if (score > bestScore) { bestScore = score; best = instance; }
  });
  return best;
}

// Used only when BOOTSTRAPPING a citizen who "lived offscreen" (initial city spawn) — biases the
// random education roll to be plausible for the age group being created, e.g. a Child can't
// already hold a university degree. Ongoing education changes are never random; they only ever
// come from GRADUATE (see handleLifecycleEvent below).
function pickPlausibleEducationForAge(ageGroup) {
  const poolByAgeGroup = {
    Child: ['NONE', 'NONE', 'LOW'],
    Teen: ['NONE', 'LOW', 'LOW', 'AVERAGE'],
    Adult: EDUCATION_LEVELS,
    Elderly: EDUCATION_LEVELS,
  };
  const pool = poolByAgeGroup[ageGroup] || EDUCATION_LEVELS;
  return pool[Math.floor(Math.random() * pool.length)];
}

// ---- Part 5 debug/recovery helpers (§enrollment consistency check / §整合性修復) ----
// Dev-only — never called every frame. enrolledStudents (a Set) is the source of truth on the
// facility side; these just verify/repair the citizen<->facility cross-references.
function debugEducationEnrollmentIntegrity(citizensMap, facilitiesMap) {
  const issues = [];
  facilitiesMap.forEach((instance, numericId) => {
    if (instance.enrolledStudents.size > instance.currentCapacity) {
      issues.push({ type: 'OVER_CAPACITY', facilityId: numericId, enrolled: instance.enrolledStudents.size, capacity: instance.currentCapacity });
    }
    instance.enrolledStudents.forEach((citizenId) => {
      const c = citizensMap.get(citizenId);
      if (!c || !c.alive || c.currentSchoolId !== numericId) issues.push({ type: 'GHOST_ENROLLMENT', facilityId: numericId, citizenId });
    });
  });
  citizensMap.forEach((citizen, citizenId) => {
    if (citizen.currentSchoolId == null) return;
    const facility = facilitiesMap.get(citizen.currentSchoolId);
    if (!facility) { issues.push({ type: 'DANGLING_FACILITY_ID', citizenId, facilityId: citizen.currentSchoolId }); return; }
    if (!facility.enrolledStudents.has(citizenId)) issues.push({ type: 'MISSING_FROM_FACILITY', citizenId, facilityId: citizen.currentSchoolId });
  });
  return issues;
}
function repairEducationEnrollmentState(citizensMap, facilitiesMap) {
  facilitiesMap.forEach((instance) => {
    instance.enrolledStudents.forEach((citizenId) => {
      const c = citizensMap.get(citizenId);
      if (!c || !c.alive || c.currentSchoolId !== instance.numericId) instance.enrolledStudents.delete(citizenId);
    });
  });
  citizensMap.forEach((citizen, citizenId) => {
    if (citizen.currentSchoolId == null) return;
    const facility = facilitiesMap.get(citizen.currentSchoolId);
    if (!facility) { citizen.currentSchoolId = null; return; }
    if (facility.enrolledStudents.size >= facility.currentCapacity && !facility.enrolledStudents.has(citizenId)) {
      citizen.currentSchoolId = null; // can't fit — drop the dangling reference rather than overfill
    } else {
      facility.enrolledStudents.add(citizenId);
    }
  });
}
// Rebuilds every facility's enrolledStudents Set from scratch off Citizen-side state — for
// debug/recovery use only (§rebuildEducationEnrollmentCounts), never on a per-frame/per-tick path.
function rebuildEducationEnrollmentCounts(citizensMap, facilitiesMap) {
  facilitiesMap.forEach((instance) => instance.enrolledStudents.clear());
  citizensMap.forEach((citizen, citizenId) => {
    if (citizen.currentSchoolId == null) return;
    const facility = facilitiesMap.get(citizen.currentSchoolId);
    if (facility) facility.enrolledStudents.add(citizenId);
  });
}

// ---- weekday/weekend + school-hour epoch helpers ----
// GameClock.isWeekend()/isWeekday() only answer "is it currently the weekend" — scheduling a
// school event needs the weekday-ness of an arbitrary FUTURE epoch, hence these free functions.
function isWeekendEpoch(epochMs) { const wd = new Date(epochMs).getUTCDay(); return wd === 0 || wd === 6; }
function startOfGameDayEpoch(epochMs) { return Math.floor(epochMs / 86400000) * 86400000; }
// next epoch >= fromEpochMs that both falls on a WEEKDAY and sits at hourOfDay — used for "when
// does today/tomorrow's school day start" and "when is the next school day after today's LEAVE_SCHOOL".
function nextSchoolOpenEpoch(fromEpochMs, hourOfDay) {
  let dayStart = startOfGameDayEpoch(fromEpochMs);
  let candidate = dayStart + hourOfDay * 3600000;
  if (candidate < fromEpochMs) { dayStart += 86400000; candidate = dayStart + hourOfDay * 3600000; }
  while (isWeekendEpoch(candidate)) { dayStart += 86400000; candidate = dayStart + hourOfDay * 3600000; }
  return candidate;
}

// ---- teen.educationDecision (design doc §Teen: extensible college-vs-work decision) ----
// A plain data object, not just a boolean, so a later part can add real academicAptitude/
// learningInterest traits to `factors` without touching any caller — see design doc's "後から
//拡張可能な構造". Reused for Adults opting back into comprehensive_university after a HIGH-level
// job, since the underlying decision (spend more time studying vs. not) is the same shape.
// Post-highschool (education just became AVERAGE) decision: WORK or UNIVERSITY only. Never jumps
// straight to COMPREHENSIVE/ENGINEERING/MEDICAL from here — those require a completed UNIVERSITY
// (HIGH) first, decided separately by decideSpecializedEducation below (§教育レベルを飛ばして
// 無条件にVERY_HIGHへ上げない).
function decideHigherEducation(citizen, household) {
  const wealth = household?.wealth ?? 0;
  const wealthFactor = Math.min(1, Math.max(0, wealth / 20000)); // soft normalization, tunable
  // placeholder trait until a real one exists on Citizen — kept inside `factors` (not inlined into
  // the score) specifically so it's obvious where academicAptitude/learningInterest plug in later.
  const learningInterest = Math.random();
  const score = wealthFactor * 0.5 + learningInterest * 0.5;
  const choice = score <= (1 - EDUCATION_PROGRESSION_RULES.HIGHSCHOOL_TO_UNIVERSITY) ? 'WORK' : 'UNIVERSITY';
  return { decidedAt: null, factors: { wealth, wealthFactor, learningInterest }, choice };
}

// Post-university (education just became HIGH) decision: WORK, or one of the three VERY_HIGH
// paths. §特殊大学: 適性/志望/空席などを考慮できるようにするが、全員が同じ大学へ行かないよう
// weighted random split between the three keeps the population spread out rather than funneling
// everyone into one specific university.
function decideSpecializedEducation(citizen, household) {
  const wealth = household?.wealth ?? 0;
  const wealthFactor = Math.min(1, Math.max(0, wealth / 20000));
  const learningInterest = Math.random();
  const r = Math.random();
  const { UNIVERSITY_TO_COMPREHENSIVE: pComp, UNIVERSITY_TO_ENGINEERING: pEng, UNIVERSITY_TO_MEDICAL: pMed } = EDUCATION_PROGRESSION_RULES;
  let choice = 'WORK';
  if (r < pComp) choice = 'COMPREHENSIVE_UNIVERSITY';
  else if (r < pComp + pEng) choice = 'ENGINEERING_UNIVERSITY';
  else if (r < pComp + pEng + pMed) choice = 'MEDICAL_UNIVERSITY';
  return { decidedAt: null, factors: { wealth, wealthFactor, learningInterest }, choice };
}

// Which EDUCATION_FACILITY_CATEGORIES value (if any) this citizen should currently be trying to
// attend, given ageGroup + education + (for post-highschool/post-university students) their
// educationDecision. Returns null for: Elderly (school不可), already VERY_HIGH (nothing higher), a
// Child who already finished elementary but isn't a Teen yet (home/idle per design doc, NOT a
// forced highschool commute), a LOW citizen who rolled against continuing (§進学率), and an
// undecided/WORK-decided post-highschool or post-university student. This is the single source of
// truth both scheduleSchoolAttempt() and the START_SCHOOL handler re-check against, so a citizen
// never enrolls in something that no longer fits.
function desiredEducationCategory(citizen) {
  if (citizen.ageGroup === 'Elderly') return null;
  if (citizen.education === 'NONE') {
    return EDU_CATEGORY_SCHEDULE.ELEMENTARY.attendsAgeGroups.includes(citizen.ageGroup) ? 'ELEMENTARY' : null;
  }
  if (citizen.education === 'LOW') {
    if (!EDU_CATEGORY_SCHEDULE.HIGH_SCHOOL.attendsAgeGroups.includes(citizen.ageGroup)) return null;
    // §進学率: 小学校卒業後、全員が高校へ進むわけではない — a fixed per-citizen trait (rolled once,
    // see createCitizen), not a coin flip every retry.
    if (!citizen.wantsHighschool) return null;
    // Adults returning to finish high school is a standing per-citizen trait, not something every
    // LOW-education Adult attempts every day (design doc: "再教育を許可", not "全員が再教育する").
    if (citizen.ageGroup === 'Adult' && !citizen.wantsAdultReeducation) return null;
    return 'HIGH_SCHOOL';
  }
  if (citizen.education === 'AVERAGE') {
    return citizen.educationDecision?.choice === 'UNIVERSITY' ? 'UNIVERSITY' : null; // no decision yet, or chose WORK
  }
  if (citizen.education === 'HIGH') {
    const choice = citizen.educationDecision?.choice;
    if (choice === 'COMPREHENSIVE_UNIVERSITY' || choice === 'ENGINEERING_UNIVERSITY' || choice === 'MEDICAL_UNIVERSITY') return choice;
    return null; // no decision yet, or chose WORK
  }
  return null; // VERY_HIGH — nothing higher to attend
}

// Attendance-based progress, NOT "N days at school = graduate" — school.satisfaction (currently a
// flat 1, reserved for a future attendance-quality model per design doc §Education Progress)
// scales how much a single school day is worth, so a badly-satisfied school naturally takes
// longer to graduate from once that model exists, with zero changes needed here.
function advanceEducationProgress(citizen, facilityInstance) {
  const def = EDUCATION_FACILITIES[facilityInstance.definitionId];
  const sched = EDU_CATEGORY_SCHEDULE[def.category];
  const totalSchoolDays = Math.max(1, Math.round((sched.graduationDays * SCHOOL_DAYS_PER_WEEK) / 7));
  citizen.educationProgress = Math.min(1, citizen.educationProgress + 1 / totalSchoolDays);
  return citizen.educationProgress >= 1;
}

// Schedules AT MOST one event — never polls — for the next time this citizen should try to start
// school. If desiredEducationCategory() says they shouldn't be in school right now, this is a no-op (the
// citizen simply stays home/idle, per design doc §Child, until something calls this again — a
// life-stage change or GRADUATE).
function scheduleSchoolAttempt(sim, citizen, nowEpochMs) {
  const category = desiredEducationCategory(citizen);
  if (!category) return;
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.START_SCHOOL, time: nextSchoolOpenEpoch(nowEpochMs + 1, EDU_CATEGORY_SCHEDULE[category].openTime), citizenId: citizen.id, category });
}

// Schedules the single age-stage transition that follows the citizen's CURRENT ageGroup, derived
// from birthTime — never a running per-tick counter (design doc §年齢ライフサイクル, and matches
// getCitizenAgeDays()'s existing on-demand-derivation pattern). Elderly has no further stage.
const AGE_STAGE_SUCCESSOR = {
  Child: { event: SIM_EVENT_TYPES.BECOME_TEEN, atDay: AGE_GROUP_START_DAY.Teen, ageGroup: 'Teen' },
  Teen: { event: SIM_EVENT_TYPES.BECOME_ADULT, atDay: AGE_GROUP_START_DAY.Adult, ageGroup: 'Adult' },
  Adult: { event: SIM_EVENT_TYPES.BECOME_ELDERLY, atDay: AGE_GROUP_START_DAY.Elderly, ageGroup: 'Elderly' },
};
function scheduleNextAgeStageEvent(sim, citizen) {
  const next = AGE_STAGE_SUCCESSOR[citizen.ageGroup];
  if (!next) return;
  sim.scheduleEvent({ type: next.event, time: citizen.birthTime + next.atDay * 86400000, citizenId: citizen.id });
}

// Plugs a brand-new citizen (spawn OR a future birth) into both the age-stage timeline and, if
// applicable, a first school attempt. Call this once, right after refreshCitizenAgeGroup().
function initializeCitizenLifecycle(clock, sim, householdsMap, citizen) {
  // Citizens seeded mid-life (Part 2's initial spawn) may already be a Teen who "graduated high
  // school offscreen" — give them an educationDecision immediately so they aren't stuck forever
  // with desiredEducationCategory() returning null for lack of one.
  if (citizen.ageGroup === 'Teen' && citizen.education === 'AVERAGE' && !citizen.educationDecision) {
    citizen.educationDecision = { ...decideHigherEducation(citizen, householdsMap.get(citizen.householdId)), decidedAt: clock.getEpochMs() };
  }
  scheduleNextAgeStageEvent(sim, citizen);
  scheduleSchoolAttempt(sim, citizen, clock.getEpochMs());
}

// The single SimulationManager.onEvent handler for every lifecycle/school event this section
// schedules. Built once as a plain function of (refs), wired into sim.onEvent from inside the
// component (see the useEffect near the Game Clock loop) so it always reads the LIVE Maps rather
// than a stale closure.
function handleLifecycleEvent(event, { clock, sim, citizens, households, educationFacilities }) {
  const citizen = event.citizenId ? citizens.get(event.citizenId) : null;
  if (event.citizenId && (!citizen || !citizen.alive)) return; // citizen may have died/moved away since this was scheduled
  const now = clock.getEpochMs();
  switch (event.type) {
    case SIM_EVENT_TYPES.BECOME_TEEN:
    case SIM_EVENT_TYPES.BECOME_ADULT:
    case SIM_EVENT_TYPES.BECOME_ELDERLY: {
      const stage = event.type === SIM_EVENT_TYPES.BECOME_TEEN ? 'Teen' : event.type === SIM_EVENT_TYPES.BECOME_ADULT ? 'Adult' : 'Elderly';
      citizen.ageGroup = stage; // the only place this cached field is mutated outside refreshCitizenAgeGroup — always in lockstep with a real event
      citizen.lastSimulatedAt = now;
      if (stage === 'Elderly') {
        // school不可 / work不可 for Elderly (design doc §Elderly) — unenroll immediately rather
        // than waiting for the school day to end.
        if (citizen.currentSchoolId != null) {
          const facility = educationFacilities.get(citizen.currentSchoolId);
          if (facility) facility.enrolledStudents.delete(citizen.id); // §席の解放
          citizen.currentSchoolId = null;
        }
        citizen.currentActivity = 'idle';
        citizen.workplaceId = null;
        citizen.occupation = null;
        citizen.actualJobLevel = null;
      }
      scheduleNextAgeStageEvent(sim, citizen);
      if (stage !== 'Elderly') scheduleSchoolAttempt(sim, citizen, now); // e.g. a Child who just became Teen may now be eligible for highschool
      break;
    }
    case SIM_EVENT_TYPES.START_SCHOOL: {
      // Re-validate against desiredEducationCategory() at FIRE time, not schedule time —
      // ageGroup, education, or the educationDecision may have changed since this was queued, and
      // seats are a shared, contended resource other citizens may have filled in the meantime.
      const category = desiredEducationCategory(citizen);
      // §二重入学禁止: never enroll a citizen who already holds a seat somewhere.
      if (category !== event.category || citizen.currentSchoolId != null) {
        scheduleSchoolAttempt(sim, citizen, now); // stale attempt — re-plan against current state instead of enrolling into the wrong thing
        break;
      }
      const facility = findBestEducationFacility(citizen, educationFacilities, category);
      // §満員時 / §教育不足: no facility of this category exists, or all are full/disabled — retry
      // next school day rather than forcing attendance or bumping educationLevel (design doc:
      // Child stays home/idle; the same courtesy is extended to Teen/Adult attempts).
      if (!facility || facility.enrolledStudents.size >= facility.currentCapacity) {
        sim.scheduleEvent({ type: SIM_EVENT_TYPES.START_SCHOOL, time: nextSchoolOpenEpoch(now + 86400000, EDU_CATEGORY_SCHEDULE[category].openTime), citizenId: citizen.id, category });
        break;
      }
      facility.enrolledStudents.add(citizen.id); // §入学処理: facility側 enrolledStudents += 1 (availableSeats is always derived from this)
      citizen.currentSchoolId = facility.numericId;
      citizen.currentActivity = 'school';
      citizen.destinationType = 'school';
      citizen.destinationId = facility.numericId;
      citizen.activityStartTime = now;
      citizen.activityEndTime = startOfGameDayEpoch(now) + EDU_CATEGORY_SCHEDULE[category].closeTime * 3600000;
      sim.scheduleEvent({ type: SIM_EVENT_TYPES.ARRIVE_SCHOOL, time: now, citizenId: citizen.id });
      break;
    }
    case SIM_EVENT_TYPES.ARRIVE_SCHOOL: {
      if (citizen.currentSchoolId == null) break; // unenrolled between START_SCHOOL and ARRIVE_SCHOOL (e.g. just became Elderly)
      const facility = educationFacilities.get(citizen.currentSchoolId);
      if (!facility) break;
      const def = EDUCATION_FACILITIES[facility.definitionId];
      sim.scheduleEvent({ type: SIM_EVENT_TYPES.LEAVE_SCHOOL, time: startOfGameDayEpoch(now) + EDU_CATEGORY_SCHEDULE[def.category].closeTime * 3600000, citizenId: citizen.id });
      break;
    }
    case SIM_EVENT_TYPES.LEAVE_SCHOOL: {
      const facility = citizen.currentSchoolId != null ? educationFacilities.get(citizen.currentSchoolId) : null;
      citizen.currentActivity = 'home';
      citizen.activityStartTime = now;
      citizen.activityEndTime = null;
      if (!facility) break;
      const def = EDUCATION_FACILITIES[facility.definitionId];
      const graduated = advanceEducationProgress(citizen, facility);
      if (graduated) sim.scheduleEvent({ type: SIM_EVENT_TYPES.GRADUATE, time: now, citizenId: citizen.id, facilityNumericId: facility.numericId });
      else sim.scheduleEvent({ type: SIM_EVENT_TYPES.START_SCHOOL, time: nextSchoolOpenEpoch(now + 1, EDU_CATEGORY_SCHEDULE[def.category].openTime), citizenId: citizen.id, category: def.category });
      break;
    }
    case SIM_EVENT_TYPES.GRADUATE: {
      // §卒業処理 order: confirm facility -> release seat -> update educationLevel -> clear
      // enrollment state -> record history -> decide next stage.
      const facility = educationFacilities.get(event.facilityNumericId);
      const def = facility ? EDUCATION_FACILITIES[facility.definitionId] : null;
      if (facility) facility.enrolledStudents.delete(citizen.id); // §席の解放
      citizen.education = def ? def.educationOutput : citizen.education;
      citizen.educationProgress = 0;
      // education is a SOFT preference (design doc §重要), so a graduation only updates the
      // preference, never a hard job-eligibility gate — preferredJobLevel vs. actualJobLevel stay
      // exactly as Part 2 defined them.
      citizen.preferredJobLevel = EDUCATION_TO_PREFERRED_JOB_LEVEL[citizen.education];
      citizen.currentSchoolId = null;
      citizen.currentActivity = 'idle';
      // §Education history: keep only the most recent few entries, never an unbounded log.
      if (facility) {
        citizen.educationHistory = citizen.educationHistory || [];
        citizen.educationHistory.push({ facilityId: facility.numericId, facilityType: facility.definitionId, endTick: now, result: 'graduated' });
        if (citizen.educationHistory.length > 5) citizen.educationHistory.shift();
      }
      if (citizen.education === 'AVERAGE' && !citizen.educationDecision) {
        // design doc §Teen: right after high-school graduation, decide college vs. work.
        citizen.educationDecision = { ...decideHigherEducation(citizen, households.get(citizen.householdId)), decidedAt: now };
      } else if (citizen.education === 'HIGH' && (!citizen.educationDecision || citizen.educationDecision.choice === 'UNIVERSITY')) {
        // right after university graduation, decide comprehensive/engineering/medical vs. work —
        // replaces the now-stale post-highschool decision object.
        citizen.educationDecision = { ...decideSpecializedEducation(citizen, households.get(citizen.householdId)), decidedAt: now };
      }
      scheduleSchoolAttempt(sim, citizen, now); // may immediately queue university/comprehensive_university, or do nothing (WORK / already VERY_HIGH)
      break;
    }
    default: break;
  }
}

// ============ Workplace / Occupation / Daily Schedule / Offscreen Simulation (Part 4) ============
// Builds strictly on Part 1 (GameClock/SimulationManager), Part 2 (Citizen/Household/JOB_LEVELS/
// EDUCATION_TO_PREFERRED_JOB_LEVEL) and Part 3 (School) — none of those are modified. This part
// registers its OWN onEvent listener (handleWorkplaceEvent), wired ALONGSIDE Part 3's
// handleLifecycleEvent from the same useEffect (SimulationManager.onEvent just becomes a tiny
// dispatcher that calls both), so Part 3's school-day chain keeps running completely untouched.
// Every state change here is one scheduled SimulationManager event — nothing below scans
// citizensRef/workplacesRef every frame or even every tick, which is what makes 12,000+ offscreen
// citizens cheap (design doc §禁止事項: 「12,480人を毎フレーム更新」).

// ---- tunables (design doc: "正確な比率は設定値化してください") ----
const EMPLOYEE_MORNING_SHIFT_RATIO = 0.70; // ~70% morning shift, ~30% afternoon/night shift
const STUDENT_SHOPPING_TRIP_CHANCE = 0.35; // §Student: occasional shopping detour after LEAVE_SCHOOL
const SHOPPING_TRIP_CHANCE = 0.35; // §Employee/Unemployed/Retired: same detour, end of day
const JOB_SEARCH_RETRY_DAYS = 2; // §Unemployed: how often a JOB_SEARCH retry is attempted
const JOB_UPGRADE_CHECK_CHANCE = 0.08; // §Job Matching: per work-day odds of checking for a better job

// jobLevel -> tunable DEFAULT capacity share + salary band for auto-seeded Workplaces
// (ensureWorkplaceSupply, defined where the component has workplacesRef) — exactly like
// EDU_CATEGORY_SCHEDULE, this is only the bootstrap default; a future building-placement tool can set
// per-instance capacity/salary from a real commercial/industrial lot without touching any of the
// matching/event logic below.
const JOB_LEVEL_DEFS = {
  SIMPLE: { shareOfJobs: 0.34, salary: [18, 26] },
  BASIC: { shareOfJobs: 0.30, salary: [26, 38] },
  SENIOR: { shareOfJobs: 0.20, salary: [38, 55] },
  SPECIALIST: { shareOfJobs: 0.11, salary: [55, 80] },
  MANAGER: { shareOfJobs: 0.05, salary: [80, 120] },
};

let workplaceIdSeq = 1;
function createWorkplace(overrides) {
  const jobLevel = overrides.jobLevel;
  const band = JOB_LEVEL_DEFS[jobLevel].salary;
  return {
    id: overrides.id ?? `wp_${workplaceIdSeq++}`,
    buildingId: overrides.buildingId ?? null, // not tied to a placed lot yet — same limitation Part 3 accepted for School
    capacity: overrides.capacity ?? 24,
    requiredEducation: overrides.requiredEducation ?? null, // a soft hint only — see jobSearchOrder(), never a hard gate
    jobLevel,
    salary: overrides.salary ?? Math.round(band[0] + Math.random() * (band[1] - band[0])),
    employees: overrides.employees || new Set(), // citizen ids — mirrors School.students exactly
  };
}
function workplaceHasCapacity(wp) { return wp.employees.size < wp.capacity; }

// ---- Store (Prompt 2, Step 5-7 — "接続可能な最小構造") ----
// A real, building-backed shopping destination: tx/ty IS the actual grid tile (the store's
// building), never a fabricated position. visitors mirrors Workplace.employees/School.students —
// the set of citizen ids currently inside, so the Building side can answer "who is here now"
// (§Step10) without a global Citizen scan.
let storeIdSeq = 1;
function createStore(overrides) {
  // Prompt 5, Step2: shopType/businessName are rolled ONCE here (like buildingDefId for
  // industry) and never re-rolled — see pickShopType/generateBusinessName above.
  const shopType = overrides.shopType || pickShopType(overrides.level ?? 1);
  const businessName = overrides.businessName || generateBusinessName(shopType);
  return {
    id: overrides.id ?? `store_${storeIdSeq++}`,
    businessId: overrides.id ?? `store_${storeIdSeq}`, // same id space — a Store IS the Business record (§重複実装しない)
    buildingId: overrides.tx != null && overrides.ty != null ? `${overrides.tx}_${overrides.ty}` : null,
    tx: overrides.tx, ty: overrides.ty, // the real building tile
    shopType,
    businessName,
    level: overrides.level ?? 1,
    capacity: overrides.capacity ?? 30 + (overrides.level ?? 1) * 15, // customers/day soft cap, scales with building level
    inventory: overrides.inventory ?? 200,
    maxInventory: overrides.maxInventory ?? 200,
    revenueToday: 0,
    expensesToday: 0,
    profitToday: 0,
    revenueTotal: 0,
    customerCountToday: 0,
    visitors: overrides.visitors || new Set(), // citizen ids currently inside/en route
    openHour: overrides.openHour ?? 8,
    closeHour: overrides.closeHour ?? 21,
    lastRestockDay: overrides.lastRestockDay ?? -1,
    // Prompt 5, Step2/10: real, Simulation-owned business finances — accumulated day over day
    // from actual revenueToday/expensesToday (§ランダム偽データ禁止), never a fixed display value.
    money: overrides.money ?? 2000 + (overrides.level ?? 1) * 500,
    ownerId: overrides.ownerId ?? null, // set to the first hired employee's citizen id (see daily tick)
    requiredEmployees: (SHOP_TYPES[shopType]?.jobsPerLevel || 3) * (overrides.level ?? 1),
  };
}
// Building asset value (Step2 assetValue) derived from real level/inventory state — a function of
// the same numbers already tracked on the store, never an independent random field.
function computeStoreAssetValue(store) {
  const buildingValue = 4000 * store.level;
  const inventoryValue = store.inventory * 3;
  return Math.round(buildingValue + inventoryValue + Math.max(0, store.money));
}
// Splits the store's single inventory pool across its shopType's product lines (real division of
// the actual tracked inventory number, not a separate fabricated per-product stock).
function getStoreProductLines(store) {
  const def = SHOP_TYPES[store.shopType];
  if (!def) return [];
  const n = def.products.length || 1;
  const perProductStock = Math.floor(store.inventory / n);
  const perProductMax = Math.floor(store.maxInventory / n);
  return def.products.map((pid) => ({
    id: pid, name: SHOP_PRODUCTS[pid]?.name || pid, price: SHOP_PRODUCTS[pid]?.price || 0,
    stock: perProductStock, maxStock: perProductMax,
  }));
}
function storeIsOpenNow(store, hourOfDay) {
  if (store.openHour === store.closeHour) return true; // 24h
  if (store.openHour < store.closeHour) return hourOfDay >= store.openHour && hourOfDay < store.closeHour;
  return hourOfDay >= store.openHour || hourOfDay < store.closeHour; // wraps past midnight
}
function storeHasStock(store) { return store.inventory > 0; }
// Applies one shopping trip's effect onto the store's real Building state (§Step6:
// customerCountToday++ / inventory減少 / revenue増加) and returns the amount actually spent so the
// caller can apply the matching household.wealth-=/expenses+= side (household state stays owned
// by the household, never duplicated onto the store).
function applyStorePurchase(store, spend) {
  const unitsSold = Math.max(1, Math.min(store.inventory, Math.round(spend / 3)));
  store.inventory -= unitsSold;
  store.revenueToday += spend;
  store.revenueTotal += spend;
  store.customerCountToday += 1;
}

// preferredJobLevel search order for a first hire: try the citizen's own preference first, then
// walk DOWNWARD only (design doc's explicit example: VERY_HIGH -> Manager(full) -> Specialist
// (full) -> Basic — never refused a job for being "overqualified"; §Job Matching bans the
// opposite ban only, not this one).
function jobSearchOrder(preferredJobLevel) {
  const startIdx = JOB_LEVELS.indexOf(preferredJobLevel);
  const order = [];
  for (let i = startIdx; i >= 0; i--) order.push(JOB_LEVELS[i]);
  return order;
}
function findJobForCitizen(workplacesMap, citizen) {
  for (const level of jobSearchOrder(citizen.preferredJobLevel)) {
    for (const wp of workplacesMap.values()) {
      if (wp.jobLevel === level && workplaceHasCapacity(wp)) return wp;
    }
  }
  return null;
}
// "Job switch" (§Job Matching): looks for an opening strictly BETWEEN the citizen's current job
// level and their preferredJobLevel (closer to preference), never above it and never sideways.
function findBetterJobForCitizen(workplacesMap, citizen) {
  const currentRank = JOB_LEVELS.indexOf(citizen.actualJobLevel);
  const preferredRank = JOB_LEVELS.indexOf(citizen.preferredJobLevel);
  if (currentRank >= preferredRank) return null;
  for (let rank = preferredRank; rank > currentRank; rank--) {
    const level = JOB_LEVELS[rank];
    for (const wp of workplacesMap.values()) {
      if (wp.jobLevel === level && workplaceHasCapacity(wp)) return wp;
    }
  }
  return null;
}

function hireIntoWorkplace(citizen, workplace, now) {
  workplace.employees.add(citizen.id);
  citizen.workplaceId = workplace.id;
  citizen.occupation = 'Employee';
  citizen.actualJobLevel = workplace.jobLevel;
  citizen.salary = workplace.salary;
  // §Employee: ~70/30 morning-vs-other split, rolled ONCE at hire (a stable per-citizen trait,
  // not re-rolled every day — same pattern as Part 3's wantsAdultReeducation).
  if (Math.random() < EMPLOYEE_MORNING_SHIFT_RATIO) {
    citizen.shift = { startHour: 8 + Math.random(), endHour: 17 + Math.random() };
  } else if (Math.random() < 0.5) {
    citizen.shift = { startHour: 13 + Math.random(), endHour: 22 + Math.random() }; // afternoon/evening
  } else {
    citizen.shift = { startHour: 22 + Math.random() * 0.5, endHour: 6 + Math.random() }; // night shift, wraps past midnight
  }
  citizen.lastSimulatedAt = now;
}
function leaveWorkforce(citizen) {
  citizen.workplaceId = null;
  citizen.actualJobLevel = null;
  citizen.salary = 0;
  citizen.shift = null;
}
// Tries to find ANY job (first hire) for a currently-jobless citizen; on failure, marks them
// Unemployed (§Unemployed: "job searchなどの状態を持たせられる構造") rather than leaving occupation
// null forever.
function attemptJobSearch(sim, citizen, workplaces, now) {
  citizen.currentActivity = 'job_search'; // §Activity enum: distinct from 'idle' for the instant this resolves
  const wp = findJobForCitizen(workplaces, citizen);
  if (wp) { hireIntoWorkplace(citizen, wp, now); return true; }
  citizen.occupation = 'Unemployed';
  citizen.currentActivity = 'idle'; // no job found this attempt — back to the same "その他" state as before
  return false;
}
function tryJobUpgrade(citizen, workplaces, now) {
  if (citizen.occupation !== 'Employee' || Math.random() >= JOB_UPGRADE_CHECK_CHANCE) return;
  const better = findBetterJobForCitizen(workplaces, citizen);
  if (!better) return;
  const oldWp = workplaces.get(citizen.workplaceId);
  if (oldWp) oldWp.employees.delete(citizen.id);
  hireIntoWorkplace(citizen, better, now);
}

// ---- Household economy (§Household経済 / §給与) ----
// Deliberately NOT a precise economic model (design doc explicitly says this isn't required) —
// but every figure below traces back to a real per-household/per-citizen quantity (salary,
// household size, an actual shopping trip), never "building数 × 固定値" city-wide.
function payWage(citizen, household) {
  if (!household || !citizen.salary) return;
  household.wealth += citizen.salary;
  household.income += citizen.salary; // running total, informational (city-wide income stat is unaffected)
}
function chargeHousingIfDue(household, nowEpochMs) {
  if (!household) return;
  const day = Math.floor(nowEpochMs / 86400000);
  if (household.lastRentDay === day) return; // another member already paid rent for this household today
  household.lastRentDay = day;
  household.wealth -= household.housingCost;
  household.expenses += household.housingCost;
}
function computeShoppingSpend(household) {
  const base = 4 + Math.random() * 10;
  // wealthier households spend a bit more per trip, poorer ones pull back — bounded, since a
  // full bankruptcy model is explicitly out of scope for this part.
  const wealthFactor = household ? Math.max(0.5, Math.min(1.5, 1 + household.wealth / 5000)) : 1;
  return Math.round(base * wealthFactor);
}

// ---- Daily Schedule (§Daily Schedule / §Activity / §TravelState) ----
// currentActivity here is one of: HOME/COMMUTE/WORK/SHOPPING (School/idle are Part 2/3's).
function computeShiftEpochs(shift, dayStartEpoch) {
  const startEpoch = dayStartEpoch + shift.startHour * 3600000;
  let endEpoch = dayStartEpoch + shift.endHour * 3600000;
  if (endEpoch <= startEpoch) endEpoch += 86400000; // night shift wraps past midnight
  return { startEpoch, endEpoch };
}
// Schedules tomorrow's (or later today's, if not yet past) PLAN_DAY kickoff at a randomized wake
// hour — design doc: "時間は固定しすぎず、Citizenによって変動して構いません".
function schedulePlanDay(sim, citizen, now) {
  const wakeHour = 5.5 + Math.random() * 2; // 05:30-07:30
  let dayStart = startOfGameDayEpoch(now);
  let t = dayStart + wakeHour * 3600000;
  if (t <= now) { dayStart += 86400000; t = dayStart + wakeHour * 3600000; }
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.PLAN_DAY, time: t, citizenId: citizen.id });
}
// ctx (optional, 5th arg) carries { findStoreForCitizen, stores } — see the wiring useEffect
// (component scope) for what it resolves to. Passing no ctx keeps the old abstract-'shop' trip,
// which is also the automatic fallback once a real store lookup comes back empty (§禁止事項6: no
// full commercial rewrite this pass — just make a real store the PREFERRED path).
function startShoppingTrip(sim, citizen, now, thenPlanDay, ctx) {
  const store = ctx && ctx.findStoreForCitizen ? ctx.findStoreForCitizen(citizen) : null;
  const destId = store ? store.id : 'shop';
  const shopTravelMs = (10 + Math.random() * 20) * 60000;
  citizen.currentActivity = 'commute';
  citizen.destinationType = 'shopping';
  citizen.destinationId = destId;
  citizen.travelState = { from: citizen.homeId, to: destId, departureTime: now, arrivalTime: now + shopTravelMs, path: null, pathProgress: 0 };
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.GO_SHOPPING, time: now + shopTravelMs, citizenId: citizen.id, thenPlanDay, storeId: destId });
}
function goHome(sim, citizen, now, thenPlanDay) {
  const travelMs = (10 + Math.random() * 20) * 60000;
  // Whatever real anchor the citizen was actually just at (store id, workplace id, or the legacy
  // 'shop' placeholder) — never a hardcoded guess at what kind of trip this was.
  const fromAnchor = citizen.destinationId != null ? citizen.destinationId : (citizen.workplaceId || 'shop');
  citizen.currentActivity = 'commute';
  citizen.destinationType = 'home';
  citizen.destinationId = citizen.homeId;
  citizen.travelState = { from: fromAnchor, to: citizen.homeId, departureTime: now, arrivalTime: now + travelMs, path: null, pathProgress: 0 };
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.RETURN_HOME, time: now + travelMs, citizenId: citizen.id, thenPlanDay });
}
// Employee's full day: commute -> work -> (leave_work handler decides shopping vs. straight home).
function scheduleEmployeeDay(sim, citizen, now) {
  const shift = citizen.shift || { startHour: 9, endHour: 18 };
  let dayStart = startOfGameDayEpoch(now);
  let { startEpoch } = computeShiftEpochs(shift, dayStart);
  if (startEpoch <= now) { dayStart += 86400000; ({ startEpoch } = computeShiftEpochs(shift, dayStart)); }
  const commuteMs = (10 + Math.random() * 25) * 60000; // 10-35 min, individual variance — no real routing cost needed just for timing
  citizen.currentActivity = 'commute';
  citizen.destinationType = 'workplace';
  citizen.destinationId = citizen.workplaceId;
  citizen.travelState = { from: citizen.homeId, to: citizen.workplaceId, departureTime: startEpoch - commuteMs, arrivalTime: startEpoch, path: null, pathProgress: 0 };
  citizen.activityStartTime = startEpoch - commuteMs;
  citizen.activityEndTime = startEpoch;
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.START_WORK, time: startEpoch, citizenId: citizen.id, workplaceId: citizen.workplaceId });
}
// Unemployed/Retired day: an occasional JOB_SEARCH (Unemployed only, throttled by
// JOB_SEARCH_RETRY_DAYS) plus the same shopping-detour chance everyone else gets, otherwise a
// quiet day at home — never "just standing still forever" (§Unemployed / §Retired).
function scheduleNonWorkerDay(sim, citizen, workplaces, now, ctx) {
  if (citizen.occupation === 'Unemployed') {
    const today = Math.floor(now / 86400000);
    if (today - citizen.lastJobSearchDay >= JOB_SEARCH_RETRY_DAYS) {
      citizen.lastJobSearchDay = today;
      sim.scheduleEvent({ type: SIM_EVENT_TYPES.JOB_SEARCH, time: now, citizenId: citizen.id });
    }
  }
  citizen.currentActivity = 'idle';
  if (Math.random() < SHOPPING_TRIP_CHANCE) startShoppingTrip(sim, citizen, now, true, ctx);
  else schedulePlanDay(sim, citizen, now);
}
function scheduleDailyRoutine(sim, citizen, workplaces, now, ctx) {
  if (!citizen.alive) return;
  if (citizen.occupation === 'Employee' && citizen.workplaceId) scheduleEmployeeDay(sim, citizen, now);
  else scheduleNonWorkerDay(sim, citizen, workplaces, now, ctx); // Unemployed or Retired (Students are driven entirely by Part 3)
}
// One-time bootstrap for a spawned (or newly-adult/newly-retired) citizen who isn't in school —
// mirrors Part 3's initializeCitizenLifecycle: schedule the recurring chain exactly once.
function bootstrapOccupation(clock, sim, citizen, workplaces) {
  if (citizen.dailyRoutineActive) return;
  const now = clock.getEpochMs();
  if (citizen.currentSchoolId) { citizen.occupation = 'Student'; return; } // Part 3 already enrolled them; no PLAN_DAY chain needed
  if (citizen.ageGroup === 'Child' || citizen.ageGroup === 'Teen') return; // not working-age and not in school -> stays idle, per Part 2/3 default
  if (citizen.ageGroup === 'Elderly') citizen.occupation = 'Retired';
  else attemptJobSearch(sim, citizen, workplaces, now); // Adult
  citizen.dailyRoutineActive = true;
  schedulePlanDay(sim, citizen, now);
}

// The single SimulationManager.onEvent handler Part 4 owns — wired ALONGSIDE Part 3's
// handleLifecycleEvent (both are called, in order, from the same onEvent dispatcher; see the
// wiring useEffect in the component). Reads the LIVE Maps passed in ctx, never a captured
// closure, exactly like Part 3.
function handleWorkplaceEvent(event, ctx) {
  const { clock, sim, citizens, households, workplaces } = ctx;
  const citizen = event.citizenId ? citizens.get(event.citizenId) : null;
  if (event.citizenId && (!citizen || !citizen.alive)) return;
  const now = clock.getEpochMs();
  switch (event.type) {
    case SIM_EVENT_TYPES.START_SCHOOL: {
      citizen.occupation = 'Student'; // labels the occupation state (§職業); Part 3 owns everything else about this event
      break;
    }
    case SIM_EVENT_TYPES.BECOME_ADULT: {
      if (!citizen.dailyRoutineActive && !citizen.currentSchoolId) bootstrapOccupation(clock, sim, citizen, workplaces);
      break;
    }
    case SIM_EVENT_TYPES.BECOME_ELDERLY: {
      // Adult Employee -> Elderly retires automatically (§Retired), distinct from Unemployed.
      const wp = citizen.workplaceId ? workplaces.get(citizen.workplaceId) : null;
      if (wp) wp.employees.delete(citizen.id);
      leaveWorkforce(citizen);
      citizen.occupation = 'Retired';
      citizen.travelState = null;
      if (!citizen.dailyRoutineActive) { citizen.dailyRoutineActive = true; schedulePlanDay(sim, citizen, now); }
      break;
    }
    case SIM_EVENT_TYPES.GRADUATE: {
      // Part 3's handleLifecycleEvent already ran first this same tick and decided whether this
      // citizen continues to more school (re-enrolling sets currentSchoolId again via a future
      // START_SCHOOL). If they're NOT continuing, this is when they first enter the job market.
      if (!citizen.currentSchoolId) bootstrapOccupation(clock, sim, citizen, workplaces);
      break;
    }
    case SIM_EVENT_TYPES.LEAVE_SCHOOL: {
      // §Student: an occasional shopping detour on top of Part 3's own school-day chain, without
      // touching Part 3's advanceEducationProgress/GRADUATE scheduling at all.
      if (Math.random() < STUDENT_SHOPPING_TRIP_CHANCE) startShoppingTrip(sim, citizen, now, false, ctx);
      break;
    }
    case SIM_EVENT_TYPES.PLAN_DAY: {
      scheduleDailyRoutine(sim, citizen, workplaces, now, ctx);
      break;
    }
    case SIM_EVENT_TYPES.JOB_SEARCH: {
      if (citizen.occupation === 'Unemployed') attemptJobSearch(sim, citizen, workplaces, now);
      break;
    }
    case SIM_EVENT_TYPES.START_WORK: {
      if (citizen.occupation !== 'Employee' || citizen.workplaceId !== event.workplaceId) break; // stale: retired/switched/fired since this was scheduled
      citizen.travelState = null;
      citizen.currentActivity = 'work';
      const { endEpoch } = computeShiftEpochs(citizen.shift || { startHour: 9, endHour: 18 }, startOfGameDayEpoch(now));
      citizen.activityStartTime = now;
      citizen.activityEndTime = endEpoch;
      sim.scheduleEvent({ type: SIM_EVENT_TYPES.END_WORK, time: endEpoch, citizenId: citizen.id, workplaceId: citizen.workplaceId });
      break;
    }
    case SIM_EVENT_TYPES.END_WORK: {
      if (citizen.occupation !== 'Employee' || citizen.workplaceId !== event.workplaceId) break;
      payWage(citizen, households.get(citizen.householdId));
      tryJobUpgrade(citizen, workplaces, now);
      if (Math.random() < SHOPPING_TRIP_CHANCE) startShoppingTrip(sim, citizen, now, true, ctx);
      else goHome(sim, citizen, now, true);
      break;
    }
    case SIM_EVENT_TYPES.GO_SHOPPING: {
      citizen.travelState = null;
      citizen.currentActivity = 'shopping';
      const household = households.get(citizen.householdId);
      const spend = computeShoppingSpend(household);
      if (household) { household.wealth -= spend; household.expenses += spend; }
      // §Step6/7: a REAL store (resolved back in startShoppingTrip) gets its Building state
      // updated and the citizen added to its live occupant set — the abstract 'shop' fallback
      // (no store found at trip-start time) simply skips this, exactly as before.
      const store = ctx.stores && citizen.destinationId ? ctx.stores.get(citizen.destinationId) : null;
      if (store) { store.visitors.add(citizen.id); applyStorePurchase(store, spend); }
      const shopMs = (15 + Math.random() * 35) * 60000;
      citizen.activityStartTime = now;
      citizen.activityEndTime = now + shopMs;
      sim.scheduleEvent({ type: SIM_EVENT_TYPES.LEAVE_SHOPPING, time: now + shopMs, citizenId: citizen.id, thenPlanDay: event.thenPlanDay, storeId: citizen.destinationId });
      break;
    }
    case SIM_EVENT_TYPES.LEAVE_SHOPPING: {
      // §Step7: leaves the store's occupant set the moment they depart — never double-membership,
      // never lingering after the trip ends.
      const store = ctx.stores && event.storeId ? ctx.stores.get(event.storeId) : null;
      if (store) store.visitors.delete(citizen.id);
      goHome(sim, citizen, now, event.thenPlanDay);
      break;
    }
    case SIM_EVENT_TYPES.RETURN_HOME: {
      citizen.travelState = null;
      citizen.currentActivity = 'home';
      citizen.destinationType = null;
      citizen.destinationId = null;
      chargeHousingIfDue(households.get(citizen.householdId), now);
      if (event.thenPlanDay) schedulePlanDay(sim, citizen, now);
      break;
    }
    default: break;
  }
}

// ---- Offscreen Simulation core (§Offscreen Simulation / §simulateCitizenUntil) ----
// Every citizen's STATE already advances uniformly and cheaply through the SAME
// SimulationManager event queue Part 1/3 built (PLAN_DAY/START_WORK/GO_SHOPPING/... above),
// regardless of camera distance — the queue only ever wakes up for citizens with something due,
// which is what makes "12,480人を毎フレーム更新" unnecessary in the first place. What THIS
// function does is purely a RENDERING concern: given a citizen's already-simulated state, where
// are they RIGHT NOW for display. It is only ever called for a citizen that actually needs to be
// drawn/inspected — never in a loop over every citizen — and it only reads state; it never
// mutates simulation state or touches the event queue.
function simulateCitizenUntil(citizen, nowEpochMs, ctx) {
  if (!citizen || !citizen.alive) return null;
  const ts = citizen.travelState;
  if (ts && nowEpochMs >= ts.departureTime) {
    const span = Math.max(1, ts.arrivalTime - ts.departureTime);
    const frac = Math.max(0, Math.min(1, (nowEpochMs - ts.departureTime) / span));
    if (frac >= 1) return ctx.resolveTile(ts.to);
    if (!ts.path) ts.path = ctx.computeWalkingPath(ts.from, ts.to); // computed once, lazily, only when actually queried for display (§Pathfinding)
    return ctx.interpolatePath(ts.path, frac);
  }
  // Not travelling yet (still at the origin) or stationary at the current activity's location.
  const anchor = ts ? ts.from
    : (citizen.currentActivity === 'work' || citizen.currentActivity === 'shopping' || citizen.currentActivity === 'school')
      ? citizen.destinationId
      : citizen.homeId;
  return ctx.resolveTile(anchor);
}

// ============ Health / Status / Migration / Death / Retirement (Part 5) ============
// Builds strictly on Part 1 (GameClock/SimulationManager), Part 2 (Citizen/Household), Part 3
// (School) and Part 4 (Workplace/Daily Schedule/Offscreen Simulation) — none of those are
// modified beyond the small new Citizen/Household fields added above. Registers its OWN onEvent
// listener (handleHealthEvent), wired ALONGSIDE Part 3/4's handlers from the same dispatcher.
// Retirement itself was already fully implemented by Part 4's BECOME_ELDERLY handler (Adult
// Employee -> Retired, work/school disabled, shopping/home still allowed) — this part only adds
// the health/status layer on top of it.

// ---- Status model (§Health) ----
// A status is a plain {type, since, meta} object, never a bare string, so e.g. INJURED can record
// its cause and SICK can record which environmental read caused it (§Status object内に情報を持
// たせる).
const STATUS_TYPES = { SICK: 'SICK', WEAKENED: 'WEAKENED', INJURED: 'INJURED', HOMELESS: 'HOMELESS', ANXIETY: 'ANXIETY' };
function hasStatus(citizen, type) { return citizen.statuses.some((s) => s.type === type); }
function addStatus(citizen, type, meta) {
  if (hasStatus(citizen, type)) return; // never duplicate the same status
  citizen.statuses.push({ type, since: citizen.lastSimulatedAt, meta: meta || null });
}
function removeStatus(citizen, type) { citizen.statuses = citizen.statuses.filter((s) => s.type !== type); }

// ---- tunables (design doc: keep every probability/duration a named constant, not buried) ----
const HEALTH_CHECK_INTERVAL_DAYS = 1;
const HEALTH_MAX = 100;
const HEALTH_REGEN_PER_CHECK = 2; // slow natural regen for a healthy, housed citizen
const WEAKENED_HEALTH_THRESHOLD = 40; // below this health, WEAKENED is applied (no work/school penalty — §Weakened)
const SICK_BASE_CHANCE_PER_CHECK = 0.006; // baseline daily odds before environment/health modifiers
const SICK_HEALTH_WEIGHT = 0.015; // extra chance per point of (100 - health)
const SICK_POLLUTION_WEIGHT = 0.05; // extra chance per unit of local air/soil pollution
const SICK_SANITATION_WEIGHT = 0.03; // extra chance per unit of (1 - waterSanitation)
// water sanitation isn't implemented yet (design doc explicitly allows a placeholder input) — this
// is that placeholder; a future water-system can replace getWaterSanitationAt's body without
// touching computeSickChance's shape at all.
const WATER_SANITATION_DEFAULT = 0.85; // 0 (unsafe) .. 1 (fully sanitary)
const SICK_DURATION_MS = [2, 5].map((d) => d * 86400000); // 2-5 game days in hospital/recovering
const INJURY_DURATION_MS = [1, 4].map((d) => d * 86400000); // 1-4 game days recovering
const SICK_DEATH_CHANCE_ON_CHECK = 0.01; // small per-health-check odds an untreated Sick citizen dies
const HOMELESS_MIGRATE_CHANCE_PER_CHECK = 0.05; // §Homeless: "原則として都市外へ移住しやすい"
const HOMELESS_DEBT_THRESHOLD = -250; // household wealth this far negative triggers eviction (§家賃を払えない)
const ELDERLY_SICK_MULTIPLIER = 1.6; // Elderly are somewhat more sick-prone, not a hard rule

// ---- Sick (§Sick) ----
// Deliberately structured so air/soil pollution and water sanitation are all read through ctx
// hooks (never hardcoded lookups), so a future, more detailed environment model can be swapped in
// without touching this function's shape at all (§将来接続できる構造).
function computeSickChance(citizen, ctx) {
  if (!citizen.alive || hasStatus(citizen, STATUS_TYPES.SICK)) return 0;
  const env = ctx.getEnvironmentAt(citizen.homeId); // { air, soil, waterSanitation } — see component-side getEnvironmentAt
  let chance = SICK_BASE_CHANCE_PER_CHECK;
  chance += Math.max(0, HEALTH_MAX - citizen.health) * SICK_HEALTH_WEIGHT / 100;
  chance += Math.max(0, env.air) * SICK_POLLUTION_WEIGHT;
  chance += Math.max(0, env.soil) * SICK_POLLUTION_WEIGHT;
  chance += Math.max(0, 1 - env.waterSanitation) * SICK_SANITATION_WEIGHT;
  if (citizen.ageGroup === 'Elderly') chance *= ELDERLY_SICK_MULTIPLIER;
  return Math.min(0.35, chance);
}

// Interrupts whatever the citizen was doing (work/school/shopping/commute) and sends them toward
// care — a real hospital tile if ctx.findHospitalTile() has one, otherwise the explicit "moved to
// an external city's hospital" fallback the design doc asks for (§病院がない場合).
function sendCitizenToCare(sim, citizen, ctx, now) {
  citizen.travelState = null;
  citizen.destinationType = null; citizen.destinationId = null;
  const hospitalTile = ctx.findHospitalTile ? ctx.findHospitalTile(citizen) : null;
  citizen.currentActivity = hospitalTile ? 'hospital' : 'hospital_outside_city';
  citizen.activityStartTime = now;
}
function startSickness(sim, citizen, ctx, now) {
  addStatus(citizen, STATUS_TYPES.SICK, { source: 'health_check' });
  sendCitizenToCare(sim, citizen, ctx, now);
  const durationMs = SICK_DURATION_MS[0] + Math.random() * (SICK_DURATION_MS[1] - SICK_DURATION_MS[0]);
  citizen.activityEndTime = now + durationMs;
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.RECOVER, time: now + durationMs, citizenId: citizen.id, statusType: STATUS_TYPES.SICK });
}
// Exported-style helper (also used by the future disaster/fire system, per §既存Pedestrian事故処
// 理 and §Anxiety) — never restricted to anonymous pedestrians (§禁止事項).
function applyInjury(sim, citizen, ctx, now, cause) {
  if (!citizen || !citizen.alive) return;
  addStatus(citizen, STATUS_TYPES.INJURED, { cause: cause || 'accident' });
  citizen.health = Math.max(0, citizen.health - (10 + Math.random() * 15));
  sendCitizenToCare(sim, citizen, ctx, now);
  const durationMs = INJURY_DURATION_MS[0] + Math.random() * (INJURY_DURATION_MS[1] - INJURY_DURATION_MS[0]);
  citizen.activityEndTime = now + durationMs;
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.RECOVER, time: now + durationMs, citizenId: citizen.id, statusType: STATUS_TYPES.INJURED });
}
// §Anxiety hooks for a future fire/disaster system: applied when evacuation is late, cleared once
// the fire is out. Kept here (not stubbed inline at the call site) so both hooks stay next to the
// rest of the status logic.
function applyFireAnxiety(citizen) { if (citizen && citizen.alive) addStatus(citizen, STATUS_TYPES.ANXIETY, { source: 'fire' }); }
function clearFireAnxiety(citizen) { if (citizen) removeStatus(citizen, STATUS_TYPES.ANXIETY); }
// §建物崩壊前に逃げ切れなければ死亡する可能性 — a future disaster system calls this directly; it
// just forwards to the same killCitizen() every other death path uses.
function applyDisasterFatality(sim, citizen, ctx, now, cause) { killCitizen(sim, citizen, ctx, now, cause || 'disaster'); }

function afterRecovery(sim, citizen, ctx, now) {
  citizen.currentActivity = 'idle';
  citizen.activityEndTime = null;
  // resume whichever routine chain applies — Student vs Employee/Unemployed/Retired — exactly
  // like a fresh bootstrap, but only if one isn't already running (guards mirror bootstrapOccupation).
  if (!citizen.currentSchoolId && !citizen.dailyRoutineActive && citizen.ageGroup !== 'Child' && citizen.ageGroup !== 'Teen') {
    bootstrapOccupation(ctx.clock, sim, citizen, ctx.workplaces);
  } else if (citizen.dailyRoutineActive) {
    schedulePlanDay(sim, citizen, now);
  }
}

// ---- Homeless (§Homeless) ----
// Future hook: an actual park/sports-facility building can act as a temporary shelter
// (§park/sports facilityを一時的なshelterとして利用) — returns null until such a system exists,
// exactly like findHospitalTile below; evictToHomeless already tolerates a null shelter (the
// citizen simply has no fixed home tile but keeps working/schooling/shopping per §Homeless).
function findShelterTile(ctx) { return ctx.findShelterTile ? ctx.findShelterTile() : null; }
function evictToHomeless(sim, citizen, ctx, now, reason) {
  if (!citizen.alive || hasStatus(citizen, STATUS_TYPES.HOMELESS)) return;
  addStatus(citizen, STATUS_TYPES.HOMELESS, { reason: reason || 'eviction' });
  citizen.homelessSince = now;
  const shelter = findShelterTile(ctx);
  citizen.homeId = shelter; // null is fine — resolveAnchorTile/getCitizenDisplayState already fall back gracefully
}
function evictHousehold(sim, household, ctx, now, reason) {
  if (!household || household.evicted) return;
  household.evicted = true;
  household.members.forEach((cid) => {
    const c = ctx.citizens.get(cid);
    if (c && c.alive) evictToHomeless(sim, c, ctx, now, reason);
  });
}

// ---- Migration (§Migration) ----
// cityResident=false drops the Citizen from the population count (population = alive &&
// cityResident) WITHOUT deleting the record — the Map entry, and the household membership record,
// are both left in place so "this Citizen used to live here" stays inspectable later.
function migrateOutCitizen(sim, citizen, ctx, now, reason) {
  if (!citizen.alive || !citizen.cityResident) return;
  const wp = citizen.workplaceId ? ctx.workplaces.get(citizen.workplaceId) : null;
  if (wp) wp.employees.delete(citizen.id);
  const facility = citizen.currentSchoolId != null ? ctx.educationFacilities.get(citizen.currentSchoolId) : null;
  if (facility) facility.enrolledStudents.delete(citizen.id); // §席の解放: Citizen migration等でCitizenがシステムから消える場合
  if (ctx.stores && citizen.destinationType === 'shopping' && citizen.destinationId) {
    const store = ctx.stores.get(citizen.destinationId);
    if (store) store.visitors.delete(citizen.id);
  }
  citizen.currentSchoolId = null;
  citizen.travelState = null;
  citizen.currentActivity = 'moved_away';
  citizen.cityResident = false;
  if (ctx.onPopulationChange) ctx.onPopulationChange(-1);
}

// ---- Death (§Death) ----
// alive=false + deathTime recorded — the Citizen object is never deleted from the Map (§重要：
// Citizen objectを即座にdeleteしてはいけません). Population/jobs/school rosters all drop the
// citizen the same way migration does, since a dead citizen must stop counting everywhere too.
function killCitizen(sim, citizen, ctx, now, cause) {
  if (!citizen.alive) return;
  const wasCounted = citizen.alive && citizen.cityResident;
  const wp = citizen.workplaceId ? ctx.workplaces.get(citizen.workplaceId) : null;
  if (wp) wp.employees.delete(citizen.id);
  const facility = citizen.currentSchoolId != null ? ctx.educationFacilities.get(citizen.currentSchoolId) : null;
  if (facility) facility.enrolledStudents.delete(citizen.id); // §席の解放: Citizen削除時cleanup
  if (ctx.stores && citizen.destinationType === 'shopping' && citizen.destinationId) {
    const store = ctx.stores.get(citizen.destinationId);
    if (store) store.visitors.delete(citizen.id);
  }
  citizen.currentSchoolId = null;
  citizen.travelState = null;
  citizen.currentActivity = 'deceased';
  citizen.alive = false;
  citizen.deathTime = now;
  citizen.deathCause = cause || 'unknown';
  if (wasCounted && ctx.onPopulationChange) ctx.onPopulationChange(-1);
}

// ---- Hospital hook (§病院がない場合は外部都市の病院へ移動できる未来設計) ----
// No hospital building type exists yet — this always returns null today, which is exactly what
// makes sendCitizenToCare() above fall back to the 'hospital_outside_city' activity. A future
// hospital-placement tool only needs to implement ctx.findHospitalTile(citizen) for this to start
// resolving to a real on-map tile, with zero changes to the sickness/injury logic itself.
function findHospitalTile(ctx, citizen) { return ctx.findHospitalTile ? ctx.findHospitalTile(citizen) : null; }

// ---- HEALTH_CHECK bootstrap + event handler ----
// One-time start of the recurring HEALTH_CHECK chain, mirroring bootstrapOccupation exactly —
// called once per citizen right after spawn (or migration-in), never re-triggered.
function bootstrapHealth(clock, sim, citizen) {
  if (citizen.healthRoutineActive) return;
  citizen.healthRoutineActive = true;
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.HEALTH_CHECK, time: clock.getEpochMs() + Math.random() * 86400000, citizenId: citizen.id });
}
function scheduleNextHealthCheck(sim, citizen, now) {
  sim.scheduleEvent({ type: SIM_EVENT_TYPES.HEALTH_CHECK, time: now + HEALTH_CHECK_INTERVAL_DAYS * 86400000, citizenId: citizen.id });
}

// The single SimulationManager.onEvent handler Part 5 owns — wired ALONGSIDE Part 3/4's handlers
// (all three run, in order, from the same onEvent dispatcher; see the wiring useEffect in the
// component). Reads the LIVE Maps passed in ctx, never a captured closure, exactly like Part 3/4.
function handleHealthEvent(event, ctx) {
  const { sim, citizens } = ctx;
  const citizen = event.citizenId ? citizens.get(event.citizenId) : null;
  if (event.citizenId && !citizen) return;
  const now = ctx.clock.getEpochMs();
  switch (event.type) {
    case SIM_EVENT_TYPES.HEALTH_CHECK: {
      if (!citizen.alive || !citizen.cityResident) return; // dead/migrated — the chain simply stops
      const today = Math.floor(now / 86400000);
      citizen.lastHealthCheckDay = today;
      // gentle natural regen for anyone not already Sick/Injured, capped at HEALTH_MAX
      if (!hasStatus(citizen, STATUS_TYPES.SICK) && !hasStatus(citizen, STATUS_TYPES.INJURED)) {
        citizen.health = Math.min(HEALTH_MAX, citizen.health + HEALTH_REGEN_PER_CHECK);
      }
      // Weakened is a pure low-health label — §Weakened explicitly keeps work/school/shopping
      // available, so this never blocks the routine chain below.
      if (citizen.health < WEAKENED_HEALTH_THRESHOLD) addStatus(citizen, STATUS_TYPES.WEAKENED, { health: citizen.health });
      else removeStatus(citizen, STATUS_TYPES.WEAKENED);
      // Sick roll — never re-triggers on an already-Sick/Injured citizen (§Sick: work/school不可
      // already covers them; computeSickChance already returns 0 in that case too).
      if (!hasStatus(citizen, STATUS_TYPES.INJURED) && Math.random() < computeSickChance(citizen, ctx)) {
        startSickness(sim, citizen, ctx, now);
      } else if (hasStatus(citizen, STATUS_TYPES.SICK) && Math.random() < SICK_DEATH_CHANCE_ON_CHECK) {
        killCitizen(sim, citizen, ctx, now, 'illness');
        return;
      }
      // Homeless citizens keep working/schooling/shopping (§Homeless) but drift toward migrating
      // out of the city — this is the one place that chance is rolled, per HEALTH_CHECK tick.
      if (hasStatus(citizen, STATUS_TYPES.HOMELESS) && Math.random() < HOMELESS_MIGRATE_CHANCE_PER_CHECK) {
        migrateOutCitizen(sim, citizen, ctx, now, 'homeless');
        return;
      }
      scheduleNextHealthCheck(sim, citizen, now);
      break;
    }
    case SIM_EVENT_TYPES.RECOVER: {
      if (!citizen.alive) return;
      removeStatus(citizen, event.statusType || STATUS_TYPES.SICK);
      if (event.statusType === STATUS_TYPES.INJURED) citizen.health = Math.min(HEALTH_MAX, citizen.health + 15);
      else citizen.health = Math.min(HEALTH_MAX, citizen.health + 25);
      afterRecovery(sim, citizen, ctx, now);
      break;
    }
    case SIM_EVENT_TYPES.DIE: {
      killCitizen(sim, citizen, ctx, now, event.cause || 'unknown');
      break;
    }
    case SIM_EVENT_TYPES.MOVE_CITY: {
      migrateOutCitizen(sim, citizen, ctx, now, event.reason || 'migration');
      break;
    }
    default: break;
  }
}

// ============ vehicle kinds ============
// wheel offsets are in meters, measured from the vehicle's own center (x = left/right, z = front/back)
const KIND_SPECS = [
  {
    id: 'sedan', weight: 10, bodyLen: 0.62, bodyWid: 0.30, bodyH: 0.78,
    cabin: { len: 0.30, wid: 0.21, h: 0.40, offZ: 0.06 },
    wheel: { r: 0.34, w: 0.18, offsets: [[0.80, 1.30], [0.80, -1.30], [-0.80, 1.30], [-0.80, -1.30]] },
    driverY: 0.90, colors: [0xd0503f, 0x3f7fd0, 0xd0c840, 0xe0e0e0, 0x3a3a3a],
  },
  {
    id: 'taxi', weight: 3, bodyLen: 0.62, bodyWid: 0.30, bodyH: 0.78,
    cabin: { len: 0.30, wid: 0.21, h: 0.40, offZ: 0.06 },
    wheel: { r: 0.34, w: 0.18, offsets: [[0.80, 1.30], [0.80, -1.30], [-0.80, 1.30], [-0.80, -1.30]] },
    driverY: 0.90, colors: [0xf0c020], sign: true,
  },
  {
    id: 'sports', weight: 2, bodyLen: 0.58, bodyWid: 0.30, bodyH: 0.60,
    cabin: { len: 0.26, wid: 0.20, h: 0.22, offZ: -0.02 },
    wheel: { r: 0.32, w: 0.22, offsets: [[0.84, 1.10], [0.84, -1.10], [-0.84, 1.10], [-0.84, -1.10]] },
    driverY: 0.68, colors: [0xd01f2f, 0x1f3fd0, 0xe8e8e8],
  },
  {
    id: 'pickup', weight: 3, bodyLen: 0.84, bodyWid: 0.32, bodyH: 0.74,
    cabin: { len: 0.26, wid: 0.24, h: 0.34, offZ: 0.26 },
    cargo: { len: 0.46, wid: 0.26, h: 0.24, offZ: -0.16, yAdd: 0.12 },
    wheel: { r: 0.38, w: 0.22, offsets: [[0.84, 1.30], [0.84, -1.65], [-0.84, 1.30], [-0.84, -1.65]] },
    driverY: 0.88, colors: [0x3a4a3a, 0x8a8f94, 0x2f3a4a],
  },
  {
    id: 'box', weight: 2, bodyLen: 0.94, bodyWid: 0.34, bodyH: 0.68,
    cabin: { len: 0.22, wid: 0.28, h: 0.32, offZ: 0.38 },
    cargo: { len: 0.58, wid: 0.32, h: 1.30, offZ: -0.08, yAdd: 0.62 },
    wheel: { r: 0.40, w: 0.24, offsets: [[0.88, 1.35], [0.88, -1.95], [-0.88, 1.35], [-0.88, -1.95]] },
    driverY: 0.82, colors: [0xe8e8e8, 0x3f7fd0, 0xd0503f],
  },
  {
    id: 'moto', weight: 3, bodyLen: 0.5, bodyWid: 0.12, bodyH: 0.30,
    wheel: { r: 0.30, w: 0.12, offsets: [[0, 1.05], [0, -1.05]] },
    driverY: 0.80, colors: [0x202020, 0xd01f2f, 0x1f3fd0], moto: true,
  },
];

// shrink all vehicle kinds uniformly (body, cabin, cargo, wheels, driver seat) to ~half size
const CAR_SCALE = 0.5;
KIND_SPECS.forEach((spec) => {
  spec.bodyLen *= CAR_SCALE; spec.bodyWid *= CAR_SCALE; spec.bodyH *= CAR_SCALE;
  if (spec.cabin) { spec.cabin.len *= CAR_SCALE; spec.cabin.wid *= CAR_SCALE; spec.cabin.h *= CAR_SCALE; spec.cabin.offZ *= CAR_SCALE; }
  if (spec.cargo) { spec.cargo.len *= CAR_SCALE; spec.cargo.wid *= CAR_SCALE; spec.cargo.h *= CAR_SCALE; spec.cargo.offZ *= CAR_SCALE; spec.cargo.yAdd *= CAR_SCALE; }
  spec.wheel.r *= CAR_SCALE; spec.wheel.w *= CAR_SCALE;
  spec.wheel.offsets = spec.wheel.offsets.map(([ox, oz]) => [ox * CAR_SCALE, oz * CAR_SCALE]);
  spec.driverY *= CAR_SCALE;
});

function makeGrid() {
  return new Uint8Array(GRID_SIZE * GRID_SIZE);
}

function hash2(tx, ty) {
  let h = tx * 374761393 + ty * 668265263;
  h = (h ^ (h >>> 13)) * 1274126177;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function lerpAngle(a, b, t) {
  let diff = (((b - a) % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
  return a + diff * t;
}

function smoothstep(t) {
  const c = Math.max(0, Math.min(1, t));
  return c * c * (3 - 2 * c);
}

function randomProfile() {
  const name = GIVEN_NAMES[Math.floor(Math.random() * GIVEN_NAMES.length)];
  const age = 20 + Math.floor(Math.random() * 46);
  const dest = DEST_FLAVORS[Math.floor(Math.random() * DEST_FLAVORS.length)];
  return { name, age, dest };
}

// ============ canvas textures ============
function makeCheckerTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 512; canvas.height = 512;
  const ctx = canvas.getContext('2d');
  const cell = 512 / 16;
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    ctx.fillStyle = (x + y) % 2 === 0 ? '#1c2a22' : '#203026';
    ctx.fillRect(x * cell, y * cell, cell, cell);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(GRID_SIZE / 4, GRID_SIZE / 4);
  return tex;
}

function makePavementTexture() {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#7c817c'; ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 2;
  for (let i = 0; i <= 128; i += 21) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, 128); ctx.stroke(); ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(128, i); ctx.stroke(); }
  ctx.strokeStyle = 'rgba(20,25,20,0.18)'; ctx.lineWidth = 3;
  ctx.strokeRect(3, 3, 122, 122);
  return new THREE.CanvasTexture(canvas);
}

const ASPHALT_COLOR = '#3d434a';
const ASPHALT_SHOULDER_COLOR = '#262b31';
const ROAD_LINE_COLOR = '#eef0f2'; // solid edge lines + dashed centerline paint

// Shared layout fractions (0..1 across the road's own width) used by BOTH the hub-through
// texture and the arm textures, so the solid edge lines land at the exact same relative
// position on every piece of a straight road — this is what makes the line read as one
// continuous stripe running down the road instead of a line that jumps sideways at every
// tile seam. Dash length/gap are specified in world units (not pixels) and the dash COUNT
// is derived per-segment from its real length, so the centerline dash *rhythm* also stays
// consistent world-to-world even though hub squares and arm strips are different sizes.
const ROAD_EDGE_FRAC = 0.12; // solid edge line distance from the pavement edge, as a fraction of road width
const ROAD_EDGE_WIDTH_FRAC = 0.03; // edge line thickness, as a fraction of road width
const ROAD_DASH_WIDTH_FRAC = 0.022; // lane-divider dash thickness, as a fraction of road width — kept clearly thinner than the solid edge line (ROAD_EDGE_WIDTH_FRAC) so dividers read as thin lane markings, not another solid line
const ROAD_DASH_LEN = TILE * 0.24; // dash length in world units
const ROAD_DASH_GAP = TILE * 0.18; // gap between dashes in world units
const ROAD_DASH_PERIOD = ROAD_DASH_LEN + ROAD_DASH_GAP;
// -- 4-lane ("片側2車線") layout: the road's paved width is split into `lanes` equal lanes,
// symmetric about the centerline — half the lanes each direction (e.g. 4-lane = 2 each way). A
// solid centerline separates the two directions; a dashed divider separates the 2 same-direction
// lanes on each side. See drawRoadPaint / makeAsphaltCurveTexture.

// hub (intersection/straight center square): a single uniform dark-gray asphalt slab.
// - "through" tiles (a straight run with traffic on only one axis) get solid painted edge lines
//   on both sides plus a dashed centerline between the two lanes, oriented to match that axis —
//   the same solid/dash/solid pattern real one-lane-each-way roads use, so it reads as a road
//   at a glance instead of a flat gray slab.
// - curves, T-junctions and crossroads get a plain slab with no paint: several different lane
//   directions cross here, so lane lines from one axis would just paint a confusing patch in
//   the middle (this was the old "center stays white" look).
// unpaved (dirt) roads never get painted lines — real dirt roads aren't marked.
// `lengthWorld` is the real-world length (in the direction the dashes run) this texture will be
// stretched across, so the dash pitch comes out consistent no matter how big the tile is.
function makeAsphaltHubTexture(color = ASPHALT_COLOR, unpaved = false, through = false, lengthWorld = TILE, rt = ROAD_TYPES.two, flip = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, 128, 128);
  if (unpaved) {
    // a little speckle so dirt roads don't look like flat paint
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let n = 0; n < 40; n++) { const rx = Math.random() * 128, ry = Math.random() * 128; ctx.fillRect(rx, ry, 2, 2); }
  } else if (through) {
    drawRoadPaint(ctx, lengthWorld, rt, flip);
  }
  return new THREE.CanvasTexture(canvas);
}

// Paints the solid edge lines + dashed centerline shared by the hub-through and arm-dash
// textures onto a 128x128 canvas, using the SAME width fractions in both places (so the lines
// line up across the hub/arm seam) and a dash count derived from lengthWorld (so the dash
// rhythm matches real-world spacing instead of a fixed pixel count).
//
// Takes the ROAD TYPE OBJECT (not raw lanes/median booleans) and derives every marking position
// from getRoadLayout(rt) — the SAME function that drives car lane offsets and building/zone
// footprint checks (see requirement #21: asphalt width / lane positions / car paths / building
// collision must all come from one source). This is what fixes a median road drawing its lane
// dividers as if the median weren't there (dividers used to be spaced across the FULL paved
// width, so a 6-lane median road's dividers landed almost on top of the median block and the
// road visually read as ~4 lanes) — dividers are now placed using the median-aware carriageway
// width, so N lanes always shows N lanes. `flip` mirrors which side (near x=0 vs near x=128)
// holds which lane group, matching threeLaneDirRef per tile.
function drawRoadPaint(ctx, lengthWorld, rt = ROAD_TYPES.two, flip = false) {
  const layout = getRoadLayout(rt);
  const lanes = rt.lanes || 2;
  const median = !!rt.median;
  const rhw = layout.rhw;
  const edgeW = 128 * ROAD_EDGE_WIDTH_FRAC;
  const edgeX1 = 128 * ROAD_EDGE_FRAC;
  const edgeX2 = 128 * (1 - ROAD_EDGE_FRAC);
  // median roads have no shoulder/sidewalk margin, so the usual "edge line inset from the
  // pavement border" would sit almost on top of the outermost lane divider — skip it there.
  if (!median) {
    ctx.fillStyle = ROAD_LINE_COLOR;
    ctx.fillRect(edgeX1 - edgeW / 2, 0, edgeW, 128);
    ctx.fillRect(edgeX2 - edgeW / 2, 0, edgeW, 128);
  }
  // BUG FIXED HERE: lane-center/divider/median positions used to be run through `laneX()`
  // (edgeX1..edgeX2 — a band deliberately INSET from the true pavement edge, meant only for
  // where the solid EDGE LINE itself is drawn). Any *other* position (dividers, the median
  // block) was being computed as a TRUE physical world offset (out of getRoadLayout, in the same
  // world units the car's THREE.js position uses) and then run through that same inset mapping —
  // double-compressing it toward the centerline. The car mesh, meanwhile, sits at its true world
  // offset on a plain BoxGeometry whose default UVs span the FULL pavement width uncompressed, so
  // the painted divider landed measurably closer to center than the actual midpoint between the
  // two lanes it was supposed to separate — worse the further out the lane (i.e. worse on wider
  // and median roads, exactly what showed up in testing).
  // `pxForOffset` is the direct, UNCOMPRESSED mapping matching that same default box UV: offset 0
  // (centerline) -> pixel 64 (canvas center), offset ±rhw (true pavement edge) -> pixel 0/128.
  // Every offset-based position (dividers, median block) must go through THIS, never laneX().
  const pxForOffset = (offset) => 64 + 64 * (offset / rhw);

  const dashW = 128 * ROAD_DASH_WIDTH_FRAC;
  const reps = Math.max(1, Math.round(lengthWorld / ROAD_DASH_PERIOD));
  const stepPx = 128 / reps;
  const dashPx = stepPx * (ROAD_DASH_LEN / ROAD_DASH_PERIOD);
  const drawDash = (xCenter) => {
    for (let k = 0; k < reps; k++) {
      const y = k * stepPx + (stepPx - dashPx) / 2;
      ctx.fillRect(xCenter - dashW / 2, y, dashW, dashPx);
    }
  };

  if (lanes >= 3) {
    // symmetric N-lane split (lanes/2 lanes per direction, e.g. 4-lane = 2 each way): one solid
    // centerline in the middle separating the two directions, plus one dashed same-direction
    // lane divider per side. Fully symmetric, so `flip` has no effect here (unlike the old
    // 2-vs-1 3-lane layout) — kept in the signature only for call-site compatibility.
    // median roads get a wide raised-median block, sized to the SAME medianHalfWidth the car
    // lane math reserves, instead of a thin solid centerline — there's a physical curbed island
    // down the middle that vehicles/pedestrians can't cross.
    if (median) {
      const centerW = 128 * (layout.medianHalfWidth / rhw);
      ctx.fillStyle = '#5a5f66';
      ctx.fillRect(pxForOffset(0) - centerW / 2, 0, centerW, 128); // raised median island, real width
    } else {
      const centerW = edgeW * 1.3;
      ctx.fillStyle = ROAD_LINE_COLOR;
      ctx.fillRect(pxForOffset(0) - centerW / 2, 0, centerW, 128); // solid centerline between directions
    }
    ctx.fillStyle = ROAD_LINE_COLOR;
    // laneDividers[i] comes straight out of getRoadLayout as the literal midpoint between two
    // adjacent lane centers — not recomputed here — so the painted dash is guaranteed to land
    // exactly between the two lanes it separates, matching where cars actually drive in each
    // (pxForOffset, NOT laneX — see note above).
    for (const dividerOffset of layout.laneDividers) {
      drawDash(pxForOffset(-dividerOffset));
      drawDash(pxForOffset(dividerOffset));
    }
  } else if (lanes === 1) {
    drawDirectionArrows(ctx, lengthWorld, flip); // one-way road: single column of arrows, oriented by `flip`
  } else {
    drawDash(pxForOffset(0));
  }
}

// 'small' roads are one-way (see oneWayDirRef): instead of a center dashed line (which reads as
// "you may change lanes here", meaningless on a single-lane one-way street), paint one column of
// arrows pointing the single direction traffic is allowed to travel. `flip` picks which way,
// using the SAME convention as oneWayDirRef (false/0 = arrows point toward +length).
function drawDirectionArrows(ctx, lengthWorld, flip = false) {
  const period = TILE * 0.5; // world-unit spacing between arrows, independent of dash rhythm
  const reps = Math.max(1, Math.round(lengthWorld / period));
  const stepPx = 128 / reps;
  const arrowLenPx = Math.min(stepPx * 0.55, 128 * 0.22);
  const arrowHalfW = 128 * 0.07;
  ctx.fillStyle = ROAD_LINE_COLOR;
  const pointsDown = !flip;
  for (let k = 0; k < reps; k++) {
    const yc = k * stepPx + stepPx / 2;
    const yTip = pointsDown ? yc + arrowLenPx / 2 : yc - arrowLenPx / 2;
    const yBack = pointsDown ? yc - arrowLenPx / 2 : yc + arrowLenPx / 2;
    ctx.beginPath();
    ctx.moveTo(64, yTip);
    ctx.lineTo(64 - arrowHalfW, yBack);
    ctx.lineTo(64 + arrowHalfW, yBack);
    ctx.closePath();
    ctx.fill();
  }
}

// arm strip (the short connector between a hub square and the tile edge): same background
// color + same edge/dash layout as the hub-through texture (see drawRoadPaint), just applied to
// a strip instead of a square, so a straight run of hub+arm+hub+arm reads as one paved lane
// with a continuous edge line and dash rhythm rather than a chain of separately-decorated tiles.
function makeArmDashTexture(color = ASPHALT_COLOR, unpaved = false, lengthWorld = TILE, rt = ROAD_TYPES.two, flip = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, 128, 128);
  if (!unpaved) drawRoadPaint(ctx, lengthWorld, rt, flip);
  return new THREE.CanvasTexture(canvas);
}

// arm segment touching an intersection tile: a bold white stop line right at the hub edge
// (top of this texture, since the arm geometry is translated so its near-hub end sits at the
// low end of its local Z range) instead of the running dash pattern, like a real 一時停止線.
// A zebra crosswalk (横断歩道) is painted just behind the stop line — a band of white bars
// running across the full road width — so pedestrians have an actual marked place to cross
// instead of just walking across bare asphalt.
function makeArmStopTexture(color = ASPHALT_COLOR, unpaved = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, 128, 128);
  if (!unpaved) {
    const edgeW = 128 * ROAD_EDGE_WIDTH_FRAC;
    const edgeX1 = 128 * ROAD_EDGE_FRAC;
    const edgeX2 = 128 * (1 - ROAD_EDGE_FRAC);
    ctx.fillStyle = ROAD_LINE_COLOR;
    ctx.fillRect(edgeX1 - edgeW / 2, 0, edgeW, 128);
    ctx.fillRect(edgeX2 - edgeW / 2, 0, edgeW, 128);
    ctx.fillRect(edgeX1 - edgeW / 2, 10, (edgeX2 - edgeX1) + edgeW, 16);
    // zebra crosswalk band, just past the stop line
    const stripeCount = 6;
    const bandY0 = 34, bandY1 = 92;
    const bandLen = bandY1 - bandY0;
    const stripeH = bandLen / (stripeCount * 2);
    for (let s = 0; s < stripeCount; s++) {
      const y = bandY0 + s * stripeH * 2;
      ctx.fillRect(edgeX1 + edgeW, y, (edgeX2 - edgeX1) - edgeW * 2, stripeH);
    }
  }
  return new THREE.CanvasTexture(canvas);
}

// curve hub tile (a NODE_CURVE node connects exactly two PERPENDICULAR arms, e.g. north+east):
// paints a quarter-circle lane marking (two edge arcs + a dashed centerline arc) connecting the
// two paved edges so the road visibly bends instead of showing a blank plain slab. `corner`
// picks which pair of edges this texture connects — 'ne' (north+east), 'es' (east+south), 'sw'
// (south+west), 'wn' (west+north) — and is drawn directly for that exact orientation (the mesh
// is never rotated for curves, so there's no need to reason about how rotation maps to the
// canvas' U/V axes; each of the 4 possible curves just gets its own baked texture).
// Canvas convention (matches drawRoadPaint/makeAsphaltHubTexture): x = world X (east is larger
// x), y = world Z (south is larger y), so "top" = north, "right" = east, "bottom" = south,
// "left" = west.
// `lanes`/`flip` mirror drawRoadPaint's straight-road markings onto the curve's arc so a 3-lane
// curve reads as three real lanes (dashed same-direction divider arc + solid opposing-centerline
// arc) instead of always falling back to the plain single-centerline 2-lane look.
function makeAsphaltCurveTexture(color = ASPHALT_COLOR, unpaved = false, corner = 'ne', rt = ROAD_TYPES.two, flip = false) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, 128, 128);
  if (unpaved) {
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let n = 0; n < 40; n++) { const rx = Math.random() * 128, ry = Math.random() * 128; ctx.fillRect(rx, ry, 2, 2); }
    return new THREE.CanvasTexture(canvas);
  }
  const layout = getRoadLayout(rt);
  const lanes = rt.lanes || 2;
  const median = !!rt.median;
  const rhw = layout.rhw;
  // center = the tile corner the curve bends around; angle range = the 90° sweep from one
  // connected edge's midpoint to the other's, going the short way around that corner.
  const CORNER_DEFS = {
    ne: { cx: 128, cy: 0, a0: Math.PI / 2, a1: Math.PI },
    es: { cx: 128, cy: 128, a0: Math.PI, a1: Math.PI * 1.5 },
    sw: { cx: 0, cy: 128, a0: Math.PI * 1.5, a1: Math.PI * 2 },
    wn: { cx: 0, cy: 0, a0: 0, a1: Math.PI / 2 },
  };
  const { cx, cy, a0, a1 } = CORNER_DEFS[corner] || CORNER_DEFS.ne;
  const edgeW = 128 * ROAD_EDGE_WIDTH_FRAC;
  const outerR = 128 * (1 - ROAD_EDGE_FRAC);
  const innerR = 128 * ROAD_EDGE_FRAC;
  // BUG FIXED HERE (same root cause as drawRoadPaint's pxForOffset, see the note there): this
  // used to map a TRUE world-unit lateral offset into 0..1 and then interpolate that fraction
  // between outerR/innerR — which are themselves already an edge-INSET pair of radii (meant only
  // for where the solid edge arcs are drawn), not the true 0..128 canvas span. That double-
  // compressed every divider arc toward the corner's mid-radius, worst on the outer lanes of wide
  // roads — exactly like the straight-segment bug. `radiusForOffset` is the direct, UNCOMPRESSED
  // mapping matching the hub tile's plain box UV (same one the straight case's pxForOffset uses):
  // offset 0 (centerline) -> radius 64 (canvas center), offset ±rhw (true pavement edge) ->
  // radius 0/128, so a lane's arc lands at the same physical distance from the corner that a car
  // actually drives at.
  const radiusForOffset = (offset) => 64 + 64 * (offset / rhw);
  // median roads have no shoulder/sidewalk margin, so skip the edge arcs (same reasoning as
  // drawRoadPaint) — they'd sit almost on top of the outermost lane divider arc.
  if (!median) {
    ctx.strokeStyle = ROAD_LINE_COLOR;
    ctx.lineWidth = edgeW;
    ctx.beginPath(); ctx.arc(cx, cy, outerR, a0, a1); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy, innerR, a0, a1); ctx.stroke();
  }
  const dashPattern = [128 * (ROAD_DASH_LEN / TILE), 128 * (ROAD_DASH_GAP / TILE)];
  if (lanes >= 3) {
    // symmetric N-lane split, same as drawRoadPaint but applied radially: one solid centerline
    // arc (or, for median roads, a median-island arc of the SAME physical width the car lane
    // math reserves) at the true center radius, plus one dashed same-direction divider arc per
    // side, placed past the median using the real carriageway lane width instead of naively
    // dividing the full paved arc by lane count.
    const centerR = radiusForOffset(0);
    ctx.strokeStyle = median ? '#5a5f66' : ROAD_LINE_COLOR;
    ctx.lineWidth = median ? 128 * (layout.medianHalfWidth / rhw) : edgeW * 1.3;
    ctx.beginPath(); ctx.arc(cx, cy, centerR, a0, a1); ctx.stroke();
    ctx.strokeStyle = ROAD_LINE_COLOR;
    ctx.lineWidth = 128 * ROAD_DASH_WIDTH_FRAC;
    ctx.setLineDash(dashPattern);
    // laneDividers[i] comes straight out of getRoadLayout (same array drawRoadPaint reads) — the
    // literal midpoint between two adjacent lane centers — so the curve's divider arcs land on
    // the exact same lane boundaries the straight-segment dashes do, and cars driving through the
    // curve (see movePoint, which also reads laneCenters via pickForwardLaneOffset) stay between
    // them.
    for (const dividerOffset of layout.laneDividers) {
      const rA = radiusForOffset(-dividerOffset);
      const rB = radiusForOffset(dividerOffset);
      ctx.beginPath(); ctx.arc(cx, cy, rA, a0, a1); ctx.stroke();
      ctx.beginPath(); ctx.arc(cx, cy, rB, a0, a1); ctx.stroke();
    }
    ctx.setLineDash([]);
  } else if (lanes !== 1) {
    // 1-lane roads get no arc marking here (arrows are for straight runs only); 2-lane curves
    // keep the plain dashed centerline.
    ctx.lineWidth = 128 * ROAD_DASH_WIDTH_FRAC;
    ctx.setLineDash(dashPattern);
    ctx.beginPath(); ctx.arc(cx, cy, 64, a0, a1); ctx.stroke();
    ctx.setLineDash([]);
  }
  return new THREE.CanvasTexture(canvas);
}

// dead-end hub tile (a NODE_DEADEND node has exactly one connected neighbor): paints a normal
// paved approach (edge lines running in from the connected side) capped by a solid line near the
// far edge, like a real road's end-of-pavement marking, instead of a blank plain slab. `side`
// is the single connected neighbor's direction ('n'|'e'|'s'|'w') and is drawn directly for that
// exact orientation for the same reason as the curve texture above — no mesh rotation needed.
function makeAsphaltDeadEndTexture(color = ASPHALT_COLOR, unpaved = false, side = 's') {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = color; ctx.fillRect(0, 0, 128, 128);
  if (unpaved) {
    ctx.fillStyle = 'rgba(0,0,0,0.12)';
    for (let n = 0; n < 40; n++) { const rx = Math.random() * 128, ry = Math.random() * 128; ctx.fillRect(rx, ry, 2, 2); }
    return new THREE.CanvasTexture(canvas);
  }
  const edgeW = 128 * ROAD_EDGE_WIDTH_FRAC;
  const edgeX1 = 128 * ROAD_EDGE_FRAC;
  const edgeX2 = 128 * (1 - ROAD_EDGE_FRAC);
  const capW = 128 * ROAD_EDGE_WIDTH_FRAC * 1.3;
  const capInset = 128 * 0.16; // how far from the far edge the cap line sits
  ctx.fillStyle = ROAD_LINE_COLOR;
  // side = which edge the road continues FROM (the connected neighbor); the cap sits at the
  // OPPOSITE edge, and the two edge lines run the full length either way (pavement fills the
  // whole tile — only the cap differs from a normal straight tile).
  if (side === 's') { ctx.fillRect(edgeX1 - edgeW / 2, 0, edgeW, 128); ctx.fillRect(edgeX2 - edgeW / 2, 0, edgeW, 128); ctx.fillRect(edgeX1 - edgeW / 2, capInset - capW / 2, (edgeX2 - edgeX1) + edgeW, capW); }
  else if (side === 'n') { ctx.fillRect(edgeX1 - edgeW / 2, 0, edgeW, 128); ctx.fillRect(edgeX2 - edgeW / 2, 0, edgeW, 128); ctx.fillRect(edgeX1 - edgeW / 2, 128 - capInset - capW / 2, (edgeX2 - edgeX1) + edgeW, capW); }
  else if (side === 'e') { ctx.fillRect(0, edgeX1 - edgeW / 2, 128, edgeW); ctx.fillRect(0, edgeX2 - edgeW / 2, 128, edgeW); ctx.fillRect(capInset - capW / 2, edgeX1 - edgeW / 2, capW, (edgeX2 - edgeX1) + edgeW); }
  else { ctx.fillRect(0, edgeX1 - edgeW / 2, 128, edgeW); ctx.fillRect(0, edgeX2 - edgeW / 2, 128, edgeW); ctx.fillRect(128 - capInset - capW / 2, edgeX1 - edgeW / 2, capW, (edgeX2 - edgeX1) + edgeW); }
  return new THREE.CanvasTexture(canvas);
}

function makeFacadeTexture(baseColor, rows) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(baseColor);
  ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  ctx.fillRect(0, 0, 128, 128);
  const cols = 4;
  const padX = 128 / cols, padY = 128 / rows;
  for (let r = 0; r < rows; r++) for (let cIdx = 0; cIdx < cols; cIdx++) {
    const lit = Math.random() > 0.45;
    ctx.fillStyle = lit ? 'rgba(255, 230, 170, 0.65)' : 'rgba(10, 14, 12, 0.4)';
    const w = padX * 0.58, h = padY * 0.5;
    ctx.fillRect(cIdx * padX + (padX - w) / 2, r * padY + (padY - h) / 2, w, h);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

function makeShopFrontTexture(baseColor, altSign) {
  const canvas = document.createElement('canvas');
  canvas.width = 128; canvas.height = 128;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(baseColor);
  ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  ctx.fillRect(0, 0, 128, 128);
  ctx.fillStyle = 'rgba(255,230,190,0.7)';
  ctx.fillRect(10, 55, 108, 55);
  ctx.strokeStyle = 'rgba(40,30,20,0.5)'; ctx.lineWidth = 4;
  ctx.strokeRect(10, 55, 108, 55);
  ctx.fillStyle = altSign ? 'rgba(60,120,90,0.7)' : 'rgba(200,60,50,0.65)';
  ctx.fillRect(0, 30, 128, 14);
  return new THREE.CanvasTexture(canvas);
}

function makeCorrugatedTexture(baseColor) {
  const canvas = document.createElement('canvas');
  canvas.width = 64; canvas.height = 64;
  const ctx = canvas.getContext('2d');
  const c = new THREE.Color(baseColor);
  ctx.fillStyle = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
  ctx.fillRect(0, 0, 64, 64);
  for (let y = 0; y < 64; y += 6) {
    ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(0, y, 64, 2);
    ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(0, y + 2, 64, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = THREE.RepeatWrapping; tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  return tex;
}

// two extra zone-agnostic massing archetypes, layered on top of whatever facade/roof materials the
// caller already built for a given zone+level, so every zone/level gets 4 visually distinct shapes
// instead of just the 2 "plain box" / "box + accessory" variants.
function makeLShapeVariant(cfg, li, facadeMat, roofMat) {
  const full = TILE * cfg.foot, h = cfg.h;
  const legLen = full * 0.62, legThick = full * 0.42;
  const matSet = [facadeMat(li, 4), facadeMat(li, 4), roofMat(li), roofMat(li), facadeMat(li, 4), facadeMat(li, 4)];
  const geoA = new THREE.BoxGeometry(legLen, h, legThick);
  geoA.translate(-(full - legLen) / 2, h / 2, (full - legThick) / 2);
  const geoB = new THREE.BoxGeometry(legThick, h, legLen);
  geoB.translate((full - legThick) / 2, h / 2, -(full - legLen) / 2);
  return { parts: [{ geo: geoA, mat: matSet }, { geo: geoB, mat: matSet }] };
}

function makeSteppedVariant(cfg, li, facadeMat, roofMat) {
  const h = cfg.h;
  const h1 = h * 0.52, h2 = h * 0.30, h3 = h * 0.18;
  const f1 = cfg.foot, f2 = cfg.foot * 0.7, f3 = cfg.foot * 0.42;
  const g1 = new THREE.BoxGeometry(TILE * f1, h1, TILE * f1); g1.translate(0, h1 / 2, 0);
  const g2 = new THREE.BoxGeometry(TILE * f2, h2, TILE * f2); g2.translate(0, h1 + h2 / 2, 0);
  const g3 = new THREE.BoxGeometry(TILE * f3, h3, TILE * f3); g3.translate(0, h1 + h2 + h3 / 2, 0);
  return { parts: [
    { geo: g1, mat: [facadeMat(li, 3), facadeMat(li, 3), roofMat(li), roofMat(li), facadeMat(li, 3), facadeMat(li, 3)] },
    { geo: g2, mat: [facadeMat(li, 2), facadeMat(li, 2), roofMat(li), roofMat(li), facadeMat(li, 2), facadeMat(li, 2)] },
    { geo: g3, mat: [facadeMat(li, 1), facadeMat(li, 1), roofMat(li), roofMat(li), facadeMat(li, 1), facadeMat(li, 1)] },
  ] };
}

// ============ building variant definitions ============
// each variant is a list of "parts" (geometry+material), all driven by the same per-tile transform.
// 4 shape variants per zone/level: A (plain box + small accessory), B (box + zone-flavored accessory),
// C (L-shaped footprint), D (stepped/tiered tower) — so fully-grown buildings actually look different.
function buildBuildingVariants(zone) {
  const c = ZONE_COLORS[zone];
  const cfgs = BUILDING_CONFIG[zone];
  const out = [];

  const facadeMat = (li, altRows) => new THREE.MeshStandardMaterial({
    map: (zone === TILE_COM && li === 0) ? makeShopFrontTexture(c.building[li], !!altRows) : makeFacadeTexture(c.building[li], altRows || (2 + li * 2)),
    roughness: zone === TILE_COM && li === 2 ? 0.15 : 0.6,
    metalness: zone === TILE_COM && li === 2 ? 0.3 : 0,
  });
  const roofMat = (li) => new THREE.MeshStandardMaterial({ color: c.roof[li], roughness: 0.7 });

  // ---- level 1 (index 0) ----
  {
    const cfg = cfgs[0];
    const bodyGeoA = new THREE.BoxGeometry(TILE * cfg.foot, cfg.h, TILE * cfg.foot); bodyGeoA.translate(0, cfg.h / 2, 0);
    let accA;
    if (zone === TILE_RES) { accA = new THREE.ConeGeometry(TILE * cfg.foot * 0.75, 2.4, 4); accA.rotateY(Math.PI / 4); accA.translate(0, cfg.h + 1.2, 0); }
    else if (zone === TILE_COM) { accA = new THREE.BoxGeometry(TILE * cfg.foot * 1.08, 0.3, TILE * cfg.foot * 1.2); accA.rotateX(-0.22); accA.translate(0, cfg.h + 0.55, -TILE * 0.12); }
    else { accA = new THREE.CylinderGeometry(0.35, 0.42, 3, 8); accA.translate(TILE * 0.22, cfg.h + 1.5, -TILE * 0.18); }
    const accMatA = zone === TILE_RES ? new THREE.MeshStandardMaterial({ color: 0x8a4030, roughness: 0.8 })
      : zone === TILE_COM ? new THREE.MeshStandardMaterial({ map: makeCorrugatedTexture(0x9aa4ac), roughness: 0.7 })
      : new THREE.MeshStandardMaterial({ color: 0x555b60, roughness: 0.8 });
    const variantA = { parts: [{ geo: bodyGeoA, mat: [facadeMat(0), facadeMat(0), roofMat(0), roofMat(0), facadeMat(0), facadeMat(0)] }, { geo: accA, mat: accMatA }] };

    let variantB;
    if (zone === TILE_RES) {
      const foot2 = cfg.foot * 0.92, h2 = cfg.h * 0.86;
      const bodyGeoB = new THREE.BoxGeometry(TILE * foot2, h2, TILE * foot2); bodyGeoB.translate(0, h2 / 2, 0);
      const chimGeo = new THREE.CylinderGeometry(0.18, 0.22, 1.6, 6); chimGeo.translate(-TILE * 0.14, h2 + 0.8, TILE * 0.12);
      variantB = { parts: [
        { geo: bodyGeoB, mat: [facadeMat(0, 3), facadeMat(0, 3), roofMat(0), roofMat(0), facadeMat(0, 3), facadeMat(0, 3)] },
        { geo: chimGeo, mat: new THREE.MeshStandardMaterial({ color: 0x6a4a3a, roughness: 0.85 }) },
      ] };
    } else if (zone === TILE_COM) {
      const bodyGeoB = new THREE.BoxGeometry(TILE * cfg.foot * 0.95, cfg.h * 0.95, TILE * cfg.foot * 0.95); bodyGeoB.translate(0, cfg.h * 0.475, 0);
      const signGeo = new THREE.BoxGeometry(TILE * cfg.foot * 1.02, 1.1, 0.35); signGeo.translate(0, cfg.h * 0.95 + 0.6, TILE * cfg.foot * 0.49);
      variantB = { parts: [
        { geo: bodyGeoB, mat: [facadeMat(0, true), facadeMat(0, true), roofMat(0), roofMat(0), facadeMat(0, true), facadeMat(0, true)] },
        { geo: signGeo, mat: new THREE.MeshStandardMaterial({ color: 0x3a6a50, emissive: 0x1a3a28, emissiveIntensity: 0.4, roughness: 0.4 }) },
      ] };
    } else {
      const bodyGeoB = new THREE.BoxGeometry(TILE * cfg.foot, cfg.h, TILE * cfg.foot); bodyGeoB.translate(0, cfg.h / 2, 0);
      const siloA = new THREE.CylinderGeometry(0.4, 0.4, cfg.h * 0.9, 10); siloA.translate(TILE * 0.24, cfg.h * 0.45, TILE * 0.2);
      const siloB = new THREE.CylinderGeometry(0.32, 0.32, cfg.h * 0.7, 10); siloB.translate(TILE * 0.24 + 0.9, cfg.h * 0.35, TILE * 0.2);
      variantB = { parts: [
        { geo: bodyGeoB, mat: [facadeMat(0, 3), facadeMat(0, 3), roofMat(0), roofMat(0), facadeMat(0, 3), facadeMat(0, 3)] },
        { geo: siloA, mat: new THREE.MeshStandardMaterial({ color: 0x8f959a, roughness: 0.55, metalness: 0.3 }) },
        { geo: siloB, mat: new THREE.MeshStandardMaterial({ color: 0x8f959a, roughness: 0.55, metalness: 0.3 }) },
      ] };
    }
    const variantC = makeLShapeVariant(cfg, 0, facadeMat, roofMat);
    const variantD = makeSteppedVariant(cfg, 0, facadeMat, roofMat);
    out.push([variantA, variantB, variantC, variantD]);
  }

  // ---- level 2 (index 1) ----
  {
    const cfg = cfgs[1];
    const bodyGeoA = new THREE.BoxGeometry(TILE * cfg.foot, cfg.h, TILE * cfg.foot); bodyGeoA.translate(0, cfg.h / 2, 0);
    let accA;
    if (zone === TILE_RES) { accA = new THREE.CylinderGeometry(0.7, 0.7, 1.4, 8); accA.translate(TILE * 0.15, cfg.h + 0.7, TILE * 0.1); }
    else if (zone === TILE_COM) { accA = new THREE.BoxGeometry(1.4, 0.9, 1.4); accA.translate(TILE * 0.15, cfg.h + 0.45, TILE * 0.15); }
    else { accA = new THREE.BoxGeometry(TILE * cfg.foot * 1.03, 0.5, TILE * cfg.foot * 1.03); accA.translate(0, cfg.h + 0.25, 0); }
    const accMatA = zone === TILE_RES ? new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.6 })
      : zone === TILE_COM ? new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.6 })
      : new THREE.MeshStandardMaterial({ map: makeCorrugatedTexture(0x8a97a0), roughness: 0.75 });
    const variantA = { parts: [{ geo: bodyGeoA, mat: [facadeMat(1), facadeMat(1), roofMat(1), roofMat(1), facadeMat(1), facadeMat(1)] }, { geo: accA, mat: accMatA }] };

    let variantB;
    if (zone === TILE_IND) {
      const bodyGeoB = new THREE.BoxGeometry(TILE * cfg.foot, cfg.h, TILE * cfg.foot); bodyGeoB.translate(0, cfg.h / 2, 0);
      const toothMat = new THREE.MeshStandardMaterial({ map: makeCorrugatedTexture(0x9aa4ac), roughness: 0.7 });
      const toothA = new THREE.BoxGeometry(TILE * cfg.foot * 0.5, 0.35, TILE * cfg.foot * 1.02); toothA.rotateZ(0.3); toothA.translate(-TILE * cfg.foot * 0.22, cfg.h + 0.35, 0);
      const toothB = new THREE.BoxGeometry(TILE * cfg.foot * 0.5, 0.35, TILE * cfg.foot * 1.02); toothB.rotateZ(-0.3); toothB.translate(TILE * cfg.foot * 0.22, cfg.h + 0.35, 0);
      variantB = { parts: [
        { geo: bodyGeoB, mat: [facadeMat(1, 3), facadeMat(1, 3), roofMat(1), roofMat(1), facadeMat(1, 3), facadeMat(1, 3)] },
        { geo: toothA, mat: toothMat }, { geo: toothB, mat: toothMat },
      ] };
    } else {
      const mainH = cfg.h * 0.7, topH = cfg.h * 0.42;
      const lowerGeo = new THREE.BoxGeometry(TILE * cfg.foot, mainH, TILE * cfg.foot); lowerGeo.translate(0, mainH / 2, 0);
      const upperGeo = new THREE.BoxGeometry(TILE * cfg.foot * 0.6, topH, TILE * cfg.foot * 0.6); upperGeo.translate(0, mainH + topH / 2, 0);
      const tankGeo = new THREE.CylinderGeometry(0.5, 0.5, 1.1, 8); tankGeo.translate(TILE * cfg.foot * 0.18, mainH + topH + 0.55, 0);
      variantB = { parts: [
        { geo: lowerGeo, mat: [facadeMat(1, 3), facadeMat(1, 3), roofMat(1), roofMat(1), facadeMat(1, 3), facadeMat(1, 3)] },
        { geo: upperGeo, mat: [facadeMat(1, 2), facadeMat(1, 2), roofMat(1), roofMat(1), facadeMat(1, 2), facadeMat(1, 2)] },
        { geo: tankGeo, mat: new THREE.MeshStandardMaterial({ color: 0xc8ccd0, roughness: 0.5 }) },
      ] };
    }
    const variantC = makeLShapeVariant(cfg, 1, facadeMat, roofMat);
    const variantD = makeSteppedVariant(cfg, 1, facadeMat, roofMat);
    out.push([variantA, variantB, variantC, variantD]);
  }

  // ---- level 3 (index 2) ----
  {
    const cfg = cfgs[2];
    const bodyGeoA = new THREE.BoxGeometry(TILE * cfg.foot, cfg.h, TILE * cfg.foot); bodyGeoA.translate(0, cfg.h / 2, 0);
    let accA;
    if (zone === TILE_RES) { accA = new THREE.CylinderGeometry(0.15, 0.15, 3.2, 6); accA.translate(-TILE * 0.15, cfg.h + 1.6, 0); }
    else if (zone === TILE_COM) { accA = new THREE.TorusGeometry(1.3, 0.16, 8, 16); accA.rotateX(Math.PI / 2); accA.translate(0, cfg.h + 0.2, 0); }
    else { accA = new THREE.CylinderGeometry(0.5, 0.6, 4.6, 8); accA.translate(TILE * 0.24, cfg.h + 2.3, TILE * 0.2); }
    const accMatA = zone === TILE_RES ? new THREE.MeshStandardMaterial({ color: 0xd0d4d8, roughness: 0.4 })
      : zone === TILE_COM ? new THREE.MeshStandardMaterial({ color: 0xe8e8e8, roughness: 0.4 })
      : new THREE.MeshStandardMaterial({ color: 0x4a4f54, roughness: 0.7, emissive: 0xff5522, emissiveIntensity: 0.15 });
    const variantA = { parts: [{ geo: bodyGeoA, mat: [facadeMat(2), facadeMat(2), roofMat(2), roofMat(2), facadeMat(2), facadeMat(2)] }, { geo: accA, mat: accMatA }] };

    let variantB;
    if (zone === TILE_RES) {
      const hA = cfg.h, hB = cfg.h * 0.78, footT = cfg.foot * 0.46;
      const towerA = new THREE.BoxGeometry(TILE * footT, hA, TILE * footT); towerA.translate(-TILE * footT * 0.62, hA / 2, 0);
      const towerB = new THREE.BoxGeometry(TILE * footT, hB, TILE * footT); towerB.translate(TILE * footT * 0.62, hB / 2, 0);
      const bridge = new THREE.BoxGeometry(TILE * footT * 1.5, 1.2, TILE * footT * 0.5); bridge.translate(0, hB * 0.6, 0);
      variantB = { parts: [
        { geo: towerA, mat: [facadeMat(2, 5), facadeMat(2, 5), roofMat(2), roofMat(2), facadeMat(2, 5), facadeMat(2, 5)] },
        { geo: towerB, mat: [facadeMat(2, 4), facadeMat(2, 4), roofMat(2), roofMat(2), facadeMat(2, 4), facadeMat(2, 4)] },
        { geo: bridge, mat: new THREE.MeshStandardMaterial({ color: 0x8a8f94, roughness: 0.6 }) },
      ] };
    } else if (zone === TILE_COM) {
      const mainH = cfg.h * 0.62, topH = cfg.h * 0.38;
      const lowerGeo = new THREE.BoxGeometry(TILE * cfg.foot, mainH, TILE * cfg.foot); lowerGeo.translate(0, mainH / 2, 0);
      const upperGeo = new THREE.BoxGeometry(TILE * cfg.foot * 0.6, topH, TILE * cfg.foot * 0.6); upperGeo.translate(0, mainH + topH / 2, 0);
      const spireGeo = new THREE.CylinderGeometry(0.1, 0.16, 3, 6); spireGeo.translate(0, mainH + topH + 1.5, 0);
      variantB = { parts: [
        { geo: lowerGeo, mat: [facadeMat(2, 6), facadeMat(2, 6), roofMat(2), roofMat(2), facadeMat(2, 6), facadeMat(2, 6)] },
        { geo: upperGeo, mat: [facadeMat(2, 3), facadeMat(2, 3), roofMat(2), roofMat(2), facadeMat(2, 3), facadeMat(2, 3)] },
        { geo: spireGeo, mat: new THREE.MeshStandardMaterial({ color: 0xd8dce0, roughness: 0.3, metalness: 0.4 }) },
      ] };
    } else {
      const bodyGeoB = new THREE.BoxGeometry(TILE * cfg.foot * 0.85, cfg.h * 0.8, TILE * cfg.foot * 0.85); bodyGeoB.translate(-TILE * cfg.foot * 0.05, cfg.h * 0.4, 0);
      const tankA = new THREE.CylinderGeometry(0.9, 0.9, cfg.h * 0.95, 12); tankA.translate(TILE * cfg.foot * 0.34, cfg.h * 0.475, TILE * cfg.foot * 0.1);
      const tankB = new THREE.CylinderGeometry(0.65, 0.65, cfg.h * 0.6, 12); tankB.translate(TILE * cfg.foot * 0.34 + 1.6, cfg.h * 0.3, TILE * cfg.foot * 0.1);
      variantB = { parts: [
        { geo: bodyGeoB, mat: [facadeMat(2, 5), facadeMat(2, 5), roofMat(2), roofMat(2), facadeMat(2, 5), facadeMat(2, 5)] },
        { geo: tankA, mat: new THREE.MeshStandardMaterial({ color: 0x9aa4ac, roughness: 0.5, metalness: 0.3 }) },
        { geo: tankB, mat: new THREE.MeshStandardMaterial({ color: 0x9aa4ac, roughness: 0.5, metalness: 0.3 }) },
      ] };
    }
    const variantC = makeLShapeVariant(cfg, 2, facadeMat, roofMat);
    const variantD = makeSteppedVariant(cfg, 2, facadeMat, roofMat);
    out.push([variantA, variantB, variantC, variantD]);
  }

  return out;
}

// ============ residential lot mesh builder (variable World Space w x h footprint, in meters) ====
// w/h are the lot's real World Space footprint.width/footprint.depth directly (NEVER multiplied
// by TILE here) — this is the "buildLotGroup receives worldWidth/worldDepth directly" requirement.
function buildLotGroup(type, w, h, level, frontSign = -1) {
  const spec = RES_LOT_TYPES[type];
  const group = new THREE.Group();
  const totalW = w, totalD = h;
  if (level === 0) {
    const g = new THREE.PlaneGeometry(totalW * 0.94, totalD * 0.94);
    g.rotateX(-Math.PI / 2);
    const m = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ color: spec.color, transparent: true, opacity: 0.45, roughness: 1 }));
    m.position.y = 0.4; m.receiveShadow = true;
    group.add(m);
    return group;
  }
  const growT = (level - 1) / 2;
  const bodyH = spec.hMin + (spec.hMax - spec.hMin) * growT;
  const facade = (rows) => new THREE.MeshStandardMaterial({ map: makeFacadeTexture(spec.color, rows), roughness: 0.6 });
  const roofMat = new THREE.MeshStandardMaterial({ color: spec.roof, roughness: 0.7 });
  const addBox = (bw, bh, bd, bx, bz, mat) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat);
    m.position.set(bx, bh / 2, bz);
    m.castShadow = true; m.receiveShadow = true;
    group.add(m);
    return m;
  };

  if (type === 'res_terrace') {
    // A terrace lot is ALWAYS a single 1x2 (or 2x1) building — never split into separate
    // per-tile houses. Whichever axis is the narrow (size==1) one is the frontage that faces
    // the road; the long (size==2) axis extends back away from the street. Because the lot's
    // own w/h already encode that orientation (see clampLotSize + pickTerraceOrientation), the
    // single merged body below just needs to fill the footprint — no extra rotation logic needed.
    const frontIsX = h >= w; // frontage faces along +/-x when the lot is narrow in x (w===1)
    const bw = totalW * (frontIsX ? 0.8 : 0.86);
    const bd = totalD * (frontIsX ? 0.86 : 0.8);
    addBox(bw, bodyH, bd, 0, 0, facade(2));
    // Simple gabled roof: a triangular-prism ridge running along the long (depth) axis of the
    // single building, built from an extruded triangle so it's a normal house roof (two sloped
    // planes + closed gable ends) instead of a stretched 4-sided cone. The old code stretched a
    // CylinderGeometry cone by a huge Z factor to reach the building's length, which produced an
    // oversized triangle/pyramid roof that dwarfed the house — this shape is sized directly from
    // the building footprint so it always matches it.
    const ridgeLen = frontIsX ? bd : bw; // roof ridge runs along the building's long axis
    const roofSpan = frontIsX ? bw : bd; // eave-to-eave width, across the short (frontage) axis
    const roofOverhang = Math.min(roofSpan * 0.08, 0.22); // small eave overhang past the wall
    const roofHalfSpan = roofSpan / 2 + roofOverhang;
    const roofHeight = Math.min(roofSpan * 0.4, 1.0); // gentle pitch, capped so it never towers
    const roofShape = new THREE.Shape();
    roofShape.moveTo(-roofHalfSpan, 0);
    roofShape.lineTo(roofHalfSpan, 0);
    roofShape.lineTo(0, roofHeight);
    roofShape.closePath();
    const roofG = new THREE.ExtrudeGeometry(roofShape, { depth: ridgeLen, bevelEnabled: false });
    roofG.translate(0, 0, -ridgeLen / 2); // center the extrusion on the ridge axis
    if (!frontIsX) roofG.rotateY(Math.PI / 2); // align ridge (extrude axis) with the building's long axis
    const roof = new THREE.Mesh(roofG, roofMat);
    roof.position.set(0, bodyH, 0); // sits right on the wall top (eave line) — no floating gap
    roof.castShadow = true;
    group.add(roof);
    // small entrance/porch detail on the frontage (narrow) side so the building visibly reads
    // as facing the street, without changing the footprint or splitting it into multiple boxes.
    // frontSign picks WHICH of the two short edges is the real road side (see
    // pickTerraceOrientation) — previously this always faced -z/-x regardless of where the road
    // actually was, which let the porch/entrance end up facing away from the street and
    // visually blocking the road on the far side instead.
    const porchW = frontIsX ? bw * 0.4 : totalW * 0.22;
    let porchD = frontIsX ? totalD * 0.22 : bd * 0.4;
    const doorMat = new THREE.MeshStandardMaterial({ color: 0x2a2422, roughness: 0.6 });
    // clamp the porch so it can never poke past the LOT's own edge (where the sidewalk starts) —
    // porchD was sized purely off the building footprint and didn't account for how little space
    // is actually left between the wall and the lot boundary, which is what let the entrance box
    // ride up onto the sidewalk on some lot proportions.
    const wallEmbed = 0.3; // how far the porch box is sunk back into the wall, flush with it
    if (frontIsX) {
      const maxOut = Math.max(0.4, totalD / 2 - bd / 2 - 0.15);
      porchD = Math.min(porchD, maxOut + wallEmbed);
      addBox(porchW, bodyH * 0.28, porchD, 0, frontSign * (bd / 2 + porchD / 2 - wallEmbed), doorMat);
    } else {
      const maxOut = Math.max(0.4, totalW / 2 - bw / 2 - 0.15);
      porchD = Math.min(porchD, maxOut + wallEmbed);
      addBox(porchD, bodyH * 0.28, porchW, frontSign * (bw / 2 + porchD / 2 - wallEmbed), 0, doorMat);
    }
  } else if (type === 'res_mixed') {
    const shopH = 3.2;
    addBox(totalW * 0.9, shopH, totalD * 0.9, 0, 0, new THREE.MeshStandardMaterial({ map: makeShopFrontTexture(spec.color, true), roughness: 0.6 }));
    addBox(totalW * 0.62, bodyH, totalD * 0.62, 0, 0, facade(8)).position.y = shopH + bodyH / 2;
  } else if (type === 'res_lowrent') {
    // thresholds were originally "tile area >= 9" (a 3x3-Tile lot) — kept equivalent in World
    // Space m^2 (9 * TILE * TILE) now that w/h are meters, not Tile counts.
    const slabs = w * h >= 9 * TILE * TILE ? 3 : 2;
    for (let i = 0; i < slabs; i++) {
      const bx = (i - (slabs - 1) / 2) * (totalW / slabs) * 0.92;
      addBox((totalW / slabs) * 0.72, bodyH, totalD * 0.8, bx, 0, facade(10));
    }
  } else if (type === 'res_high') {
    // "tile area >= 12" -> equivalent World Space m^2 threshold (12 * TILE * TILE).
    const towers = w * h >= 12 * TILE * TILE ? 2 : 1;
    for (let i = 0; i < towers; i++) {
      const bx = towers === 1 ? 0 : (i - 0.5) * totalW * 0.5;
      const tw = towers === 1 ? totalW * 0.56 : totalW * 0.4;
      const td = towers === 1 ? totalD * 0.56 : totalD * 0.7;
      const th = bodyH * (i === 0 ? 1 : 0.8);
      addBox(tw, th, td, bx, 0, facade(12));
      const spire = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.25, 3, 6), roofMat);
      spire.position.set(bx, th + 1.5, 0);
      group.add(spire);
    }
    const plaza = new THREE.Mesh(new THREE.BoxGeometry(totalW * 0.9, 0.2, totalD * 0.9), new THREE.MeshStandardMaterial({ color: 0x3a6a48, roughness: 1 }));
    plaza.position.y = 0.1; plaza.receiveShadow = true;
    group.add(plaza);
  } else { // res_mid
    // "w/h >= 4 Tiles each" -> equivalent World Space meter threshold (4 * TILE).
    const blocks = w >= 4 * TILE && h >= 4 * TILE ? 2 : 1;
    for (let i = 0; i < blocks; i++) {
      const bx = blocks === 1 ? 0 : (i - 0.5) * totalW * 0.48;
      const bw = blocks === 1 ? totalW * 0.68 : totalW * 0.42;
      addBox(bw, bodyH, totalD * 0.68, bx, 0, facade(6));
    }
  }
  return group;
}

// ============ education facility mesh builder (Part 1: placeholder box, reuses existing
// building-rendering conventions — castShadow/receiveShadow, TILE-based footprint) ============
// Distinct from buildLotGroup on purpose (§建物描画 — "通常の住宅・商業・工業buildingと区別できる
// 表示"): a flat-roofed block in a category color plus a thin cyan "roof marker" disc, so an
// education facility reads as a special/civic building at a glance rather than a zone building.
const EDUCATION_CATEGORY_COLOR = {
  ELEMENTARY: 0xe0b060,
  HIGH_SCHOOL: 0x5a90d8,
  UNIVERSITY: 0x9b6fdc,
  COMPREHENSIVE_UNIVERSITY: 0x7a5fc0,
  RESEARCH: 0x5ad0e0,
  SPECIAL: 0xe05a4f,
};
function buildEducationFacilityGroup(definitionId, w, h) {
  const def = EDUCATION_FACILITIES[definitionId];
  const group = new THREE.Group();
  if (!def) return group;
  const color = EDUCATION_CATEGORY_COLOR[def.category] || 0xa8d8bc;
  const totalW = w * TILE, totalD = h * TILE;
  const bodyH = 8 + Math.min(w, h) * 1.5;
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(totalW * 0.88, bodyH, totalD * 0.88),
    new THREE.MeshStandardMaterial({ color, roughness: 0.65 }),
  );
  body.position.y = bodyH / 2; body.castShadow = true; body.receiveShadow = true;
  group.add(body);
  // civic "marker" disc on the roof — visually separates this from any RES/COM/IND building.
  const marker = new THREE.Mesh(
    new THREE.CylinderGeometry(Math.min(totalW, totalD) * 0.16, Math.min(totalW, totalD) * 0.16, 0.6, 16),
    new THREE.MeshStandardMaterial({ color: 0x7fe0e0, emissive: 0x1a4a4a, roughness: 0.4 }),
  );
  marker.position.y = bodyH + 0.3;
  group.add(marker);
  return group;
}

function instanceVariants(scene, variantDefs, cap) {
  return variantDefs.map((levelVariants) => levelVariants.map((variant) => variant.parts.map((part) => {
    const m = new THREE.InstancedMesh(part.geo, part.mat, cap);
    m.castShadow = true; m.receiveShadow = true;
    scene.add(m);
    return m;
  })));
}

// ============ vehicle kind meshes ============
function buildKindMeshes(scene, spec) {
  const bodyGeo = new THREE.BoxGeometry(TILE * spec.bodyWid, spec.bodyH, TILE * spec.bodyLen);
  bodyGeo.translate(0, spec.bodyH / 2, 0);
  const chassisMeshes = spec.colors.map((col) => {
    const mat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.35, metalness: 0.35 });
    const m = new THREE.InstancedMesh(bodyGeo, mat, NUM_CARS + 2);
    m.castShadow = true; scene.add(m);
    return m;
  });

  let cabinMeshes = null;
  if (spec.cabin) {
    const cg = new THREE.BoxGeometry(TILE * spec.cabin.wid, spec.cabin.h, TILE * spec.cabin.len);
    cg.translate(0, spec.bodyH + spec.cabin.h / 2, TILE * spec.cabin.offZ);
    const glassMat = new THREE.MeshStandardMaterial({ color: 0x1a2226, roughness: 0.25, metalness: 0.4 });
    cabinMeshes = spec.colors.map(() => {
      const m = new THREE.InstancedMesh(cg, glassMat, NUM_CARS + 2);
      m.castShadow = true; scene.add(m);
      return m;
    });
  }

  let cargoMeshes = null;
  if (spec.cargo) {
    const cgo = new THREE.BoxGeometry(TILE * spec.cargo.wid, spec.cargo.h, TILE * spec.cargo.len);
    cgo.translate(0, spec.bodyH + spec.cargo.yAdd, TILE * spec.cargo.offZ);
    cargoMeshes = spec.colors.map(() => {
      const mat = spec.id === 'box'
        ? new THREE.MeshStandardMaterial({ map: makeCorrugatedTexture(0xd8dce0), roughness: 0.7 })
        : new THREE.MeshStandardMaterial({ color: 0x2c2f31, roughness: 0.8 });
      const m = new THREE.InstancedMesh(cgo, mat, NUM_CARS + 2);
      m.castShadow = true; scene.add(m);
      return m;
    });
  }

  // small front headlights (pale emissive) and rear taillights (red emissive) so the car's
  // heading is readable at a glance, without touching any AI/road logic — purely cosmetic
  // InstancedMesh pairs built once here, matrix-updated per frame like signMesh below.
  const halfLen = TILE * spec.bodyLen / 2;
  const lightY = spec.bodyH * 0.55;
  const headGeo = new THREE.BoxGeometry(TILE * spec.bodyWid * 0.62, spec.bodyH * 0.16, spec.bodyH * 0.12);
  headGeo.translate(0, lightY, halfLen - spec.bodyH * 0.1);
  const headMat = new THREE.MeshStandardMaterial({ color: 0xfff3c8, emissive: 0xfff0a0, emissiveIntensity: 0.9, roughness: 0.3 });
  const headlightMesh = new THREE.InstancedMesh(headGeo, headMat, NUM_CARS + 2);
  scene.add(headlightMesh);

  const tailGeo = new THREE.BoxGeometry(TILE * spec.bodyWid * 0.62, spec.bodyH * 0.14, spec.bodyH * 0.1);
  tailGeo.translate(0, lightY, -(halfLen - spec.bodyH * 0.1));
  const tailMat = new THREE.MeshStandardMaterial({ color: 0x4a0e0e, emissive: 0xd02020, emissiveIntensity: 0.7, roughness: 0.35 });
  const taillightMesh = new THREE.InstancedMesh(tailGeo, tailMat, NUM_CARS + 2);
  scene.add(taillightMesh);

  const driverZ = spec.cabin ? TILE * spec.cabin.offZ : 0;
  const driverBodyGeo = new THREE.CylinderGeometry(0.16 * CAR_SCALE, 0.2 * CAR_SCALE, 0.42 * CAR_SCALE, 6);
  driverBodyGeo.translate(0, spec.driverY, driverZ);
  const driverHeadGeo = new THREE.SphereGeometry(0.15 * CAR_SCALE, 8, 6);
  driverHeadGeo.translate(0, spec.driverY + 0.32 * CAR_SCALE, driverZ);
  const driverBodyMesh = new THREE.InstancedMesh(driverBodyGeo, new THREE.MeshStandardMaterial({ color: 0x2a3a5a, roughness: 0.85 }), NUM_CARS + 2);
  const driverHeadMesh = new THREE.InstancedMesh(driverHeadGeo, new THREE.MeshStandardMaterial({ color: 0xe0b088, roughness: 0.8 }), NUM_CARS + 2);
  scene.add(driverBodyMesh); scene.add(driverHeadMesh);

  let signMesh = null;
  if (spec.sign) {
    const sg = new THREE.BoxGeometry(TILE * 0.14 * CAR_SCALE, 0.14 * CAR_SCALE, TILE * 0.14 * CAR_SCALE);
    sg.translate(0, spec.bodyH + spec.cabin.h + 0.09 * CAR_SCALE, TILE * spec.cabin.offZ);
    signMesh = new THREE.InstancedMesh(sg, new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd35a, emissiveIntensity: 0.6 }), NUM_CARS + 2);
    scene.add(signMesh);
  }

  return {
    spec, chassisMeshes, cabinMeshes, cargoMeshes, driverBodyMesh, driverHeadMesh, signMesh,
    headlightMesh, taillightMesh,
    chassisCounts: new Array(spec.colors.length).fill(0),
    cabinCounts: new Array(spec.colors.length).fill(0),
    cargoCounts: new Array(spec.colors.length).fill(0),
    driverCount: 0, signCount: 0, lightCount: 0,
  };
}

export default function CityGridIso() {
  const mountRef = useRef(null);
  const gridRef = useRef(makeGrid());
  const levelRef = useRef(makeGrid());
  const connectedRef = useRef(makeGrid());
  // list of { tx, ty, inTx, inTy } — every map-edge highway tile that outside traffic can
  // enter/exit through (see computeHighwayGates). Recomputed after every road-network change.
  const highwayGatesRef = useRef([]);
  // throttles external (highway-gate) car spawns so traffic trickles in over time instead of
  // flooding in the instant a gate segment is clear (requirement #13).
  const externalSpawnTimerRef = useRef(0);
  const intersectionTypeRef = useRef(makeGrid()); // node classification per road tile (NODE_* codes)
  const roadTypeRef = useRef(new Uint8Array(GRID_SIZE * GRID_SIZE).fill(DEFAULT_ROAD_TYPE_IDX)); // ROAD_TYPE_KEYS index per road tile
  // per-tile flag for 3+ lane roads: 0 = "increasing tx/ty is the 2-lane side", 1 = flipped (the
  // decreasing direction is the 2-lane side). Set once when a tile is painted and left alone
  // afterwards, so a straight run of 3-lane road keeps a stable "which way has 2 lanes" until it
  // hits a branch/intersection or is repainted — see applyTool() and pickForwardLaneOffset().
  const threeLaneDirRef = useRef(new Uint8Array(GRID_SIZE * GRID_SIZE));
  const threeLaneFlipRef = useRef(false); // which way new 3-lane road paints will use (toggle in UI)
  // per-tile ALLOWED-EXIT bitmask for 'small' (小さな道路) tiles only — bit `dirBit(DIR_N/E/S/W)`
  // is set when a car on this tile may leave toward that compass direction. NOT a simple +/- sign:
  // a whole connected network of 'small' tiles (straight runs, bends, branches, and loops) is
  // recomputed together by recomputeOneWayNetwork() so the flow direction is consistent — see
  // that function for how the bits are derived, and applyTool() for when it's called.
  const oneWayDirRef = useRef(new Uint8Array(GRID_SIZE * GRID_SIZE));
  const oneWayFlipRef = useRef(false); // which direction new 'small' road paints will allow (toggle in UI)
  const signalPhaseRef = useRef({ phase: 'ns', timer: 0 }); // cycle: 'ns' green -> 'ns_yellow' -> 'ew' green -> 'ew_yellow' -> 'ns' ...
  const lotIdGridRef = useRef(new Int32Array(GRID_SIZE * GRID_SIZE).fill(-1));
  const lotsRef = useRef(new Map());
  const lotIdCounterRef = useRef(1);
  // Education facilities: separate id-grid + instance map from lots/zones (§特殊施設としての管理).
  // eduFacilityIdGridRef mirrors lotIdGridRef's role (which instance owns this cell, or -1).
  const eduFacilityIdGridRef = useRef(new Int32Array(GRID_SIZE * GRID_SIZE).fill(-1));
  const educationFacilitiesRef = useRef(new Map()); // numericId -> instance (see createEducationFacilityInstance)
  const eduFacilityIdCounterRef = useRef(1);
  // Part 3/4: city-wide aggregate of every placed education facility's cityEffects — see
  // computeEducationCityEffects() above. Recomputed from scratch on every placement/removal/
  // upgrade (never applied to Citizens/industry/hospital sim — that stays out of scope here).
  const educationCityEffectsRef = useRef(computeEducationCityEffects(new Map()));
  const popRef = useRef(0);
  // ---- Game Clock / Simulation foundation (Part 1) — see class defs above ----
  const gameClockRef = useRef(null);
  if (!gameClockRef.current) gameClockRef.current = new GameClock();
  const simManagerRef = useRef(null);
  if (!simManagerRef.current) simManagerRef.current = new SimulationManager();
  // ---- Citizen / Household foundation (Part 2) ----
  // plain Maps, NOT React state — could hold 100,000+ entries, so nothing here ever goes through
  // setState. id -> entity.
  const citizensRef = useRef(new Map());
  const householdsRef = useRef(new Map());
  const livingCitizenCountRef = useRef(0); // maintained incrementally, never recounted by scanning the Map
  const citizenSeedDoneRef = useRef(false);
  // ---- School / Education Lifecycle (Part 3/5) ----
  // Part 5: Citizen enrollment reads/writes the REAL educationFacilitiesRef instances (declared
  // further below, alongside the rest of the Part 1-4 education-facility state) — no separate
  // schools Map is kept here anymore (§既存の、EDUCATION_FACILITIES / educationFacilitiesRefを
  // 利用してください／同じ定義を二重登録しないでください).
  // ---- Workplace / Occupation / Daily Schedule (Part 4) ----
  const workplacesRef = useRef(new Map());

  // ---- Commercial / Store (Prompt 2, Step 5-7) ----
  // Real store entities, one per zoned+built TILE_COM tile (key = that tile's grid index, which
  // also doubles as its stable buildingId) — synced from the SAME grid/level scan the growth tick
  // already does every interval (see the ensureCommercialSupply block inside it), never a second
  // full-grid pass. This is the "接続可能な最小構造" the prompt asks for: a real building-backed
  // shopping destination, not a full commercial economy rewrite.
  const commercialDataRef = useRef(new Map());

  // ---- Workplace <-> real Building binding (fix: Workplace was population-abstract only) ----
  // tileIndex -> workplaceId, for TILE_COM/TILE_IND tiles that have been given a dedicated real
  // Workplace record. pendingJobTilesRef is filled during the same grid scan below and drained by
  // ensureWorkplaceSupply right after — no extra full-grid pass, and workplacesRef's own
  // population-driven capacity target (untouched) still decides HOW MANY Workplaces exist; this
  // only decides which of them, if any, get grounded to a real tile.
  const workplaceTileMapRef = useRef(new Map());
  const pendingJobTilesRef = useRef([]);

  // ---- industry data model (Phase 1) + pollution fields (Phase 2) ----
  // tile index -> IndustryLot-equivalent record: { buildingDefId, storage, employees,
  // pollutionOutput, profitability }. Kept as a plain Map (not React state) since it's read/
  // written every growth tick, same pattern as gridRef/levelRef.
  const industryDataRef = useRef(new Map());
  // 3 city-wide pollution fields at grid resolution, recomputed in a periodic batch (not every
  // frame) — see computePollution() below.
  const pollutionRef = useRef({
    air: new Float32Array(GRID_SIZE * GRID_SIZE),
    soil: new Float32Array(GRID_SIZE * GRID_SIZE),
    noise: new Float32Array(GRID_SIZE * GRID_SIZE),
  });
  const pollutionTickRef = useRef(0);
  const showPollutionRef = useRef(false);
  // ---- Phase 3-7 refs ----
  const eduPoolRef = useRef({ none: 0, low: 0, mid: 0, high: 0 });
  const resourceMarketRef = useRef({}); // resourceId -> { supply, demand, fulfillment, price }
  const cargoHubsRef = useRef(new Map()); // tile index -> { type }
  const suitabilityCacheRef = useRef(new Map()); // road-tile index -> last computed score, for the overlay
  const cityIndustryProfitRef = useRef(0);
  const industryJobsRef = useRef({ required: 0, filled: 0 });
  // Part 5 (§Economy): a periodically-refreshed aggregate over real Household records — computed
  // on the same cadence as computePollution() (every 8 growth ticks), never scanned per frame.
  // Used only to add a modest, real-state-derived term to the income formula below; the existing
  // population×fixed-rate formula is intentionally left in place (§経済モデルを全面的に作り直す必
  // 要はありません), this just keeps it from being the ONLY thing driving revenue.
  const householdEconomyRef = useRef({ wealth: 0, income: 0 });

  const threeRef = useRef(null);
  const toolRef = useRef('select');
  const taxRef = useRef(0.09);
  const camTargetRef = useRef({ x: 0, z: 0 });
  const zoomRef = useRef(1);
  const azimuthRef = useRef(Math.PI / 4);
  const keysRef = useRef(new Set());
  const cameraModeRef = useRef('iso');
  const selectedCarRef = useRef(null);
  const selectedPedRef = useRef(null);
  const dragRef = useRef({ dragging: false, painting: false, anchor: null, startX: 0, startY: 0 });
  const hoverTileRef = useRef(null);

  // -- Free Road Network (World Space) — Prompt 3 of the Tile->World Space migration --
  // roadNetworkRef is the "primary system": road shape/position/curve/elevation is authored and
  // stored here in World Space, independent of GRID_SIZE/tile adjacency. It is purely additive —
  // the old gridRef/roadTypeRef Tile-road system below is completely untouched and keeps working;
  // the two coexist (new -> old projection would go here later, never old -> new).
  const roadNetworkRef = useRef({ nodes: new Map(), segments: new Map(), intersections: new Map() });
  // Draft state for the road currently being drawn with the 'freeroad' tool (null = not drawing).
  // { startNodeId, startPos:{x,y,z}, startElevation, endPreviewPos:{x,y,z}, curveBend, elevationOffset }
  const freeRoadDraftRef = useRef(null);
  const freeRoadTypeRef = useRef('two'); // which ROAD_TYPE_KEYS entry new free-road segments use
  // -- Roadside Land / Parcel system (Prompt 4) — additive, keyed off roadNetworkRef above, not
  // the Tile grid. landParcelsRef holds Parcel records built by createParcelAlongFrontage(); the
  // query API (getNearestRoadPoint/getBuildableLandAt/etc.) above works even with this Map empty.
  const landParcelsRef = useRef(new Map());
  const showRoadsideLandRef = useRef(false);

  const [tool, setTool] = useState('select');
  const [freeRoadType, setFreeRoadTypeState] = useState('two'); // mirrors freeRoadTypeRef, for the UI selector
  const [showRoadsideLand, setShowRoadsideLand] = useState(false); // mirrors showRoadsideLandRef, roadside-land band overlay toggle
  const [toolCategory, setToolCategory] = useState(null); // which submenu is open: 'res' | 'zone' | null
  const [threeLaneFlip, setThreeLaneFlipState] = useState(false); // mirrors threeLaneFlipRef, for the UI toggle button
  const [oneWayFlip, setOneWayFlipState] = useState(false); // mirrors oneWayFlipRef, for the UI toggle button
  const [selected, setSelected] = useState(null);
  const [hud, setHud] = useState({ tileX: null, tileY: null, roadCount: 0, zoom: 1, signalCount: 0 });
  const [stats, setStats] = useState({ population: 0, jobs: 0, employedCitizens: 0, tick: 0 });
  const [budget, setBudget] = useState({ treasury: START_TREASURY, income: 0, expenses: 0, net: 0, educationUpkeep: 0 });
  const [taxRate, setTaxRate] = useState(0.09);
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [clockDisplay, setClockDisplay] = useState(() => ({
    year: GAME_START_YEAR, month: GAME_START_MONTH, day: GAME_START_DAY,
    weekday: WEEKDAY_LABELS_JA[new Date(GAME_START_EPOCH_MS).getUTCDay()],
    hour: 0, minute: 0, second: 0, dayOfYear: 1, totalDays: 0,
  }));
  const [driverPanel, setDriverPanel] = useState(null); // {name, age, dest}
  const [pedPanel, setPedPanel] = useState(null); // {name, age, dest}
  const [eduFacilityPanel, setEduFacilityPanel] = useState(null); // Education Facility Inspector data
  const [storePanel, setStorePanel] = useState(null); // Store/Workplace Inspector data (fix: Step10 UI wiring)
  const [eduFacilityVersion, setEduFacilityVersion] = useState(0); // bumps to re-render toolbar/inspector after ref-Map mutations
  const [eduCityEffectsSummary, setEduCityEffectsSummary] = useState(() => educationCityEffectsRef.current); // Part 3/4: display mirror of educationCityEffectsRef
  // Part 4/4: educationFacilityCount is its OWN count (§建物数/施設数 — never mixed into
  // buildingCount/zoneCount, which stay lot/zone-only). Research facilities live in the same
  // educationFacilitiesRef map, so they're included here too (§Researchも教育施設レイヤー内に保持).
  const educationFacilityCount = useMemo(() => educationFacilitiesRef.current.size, [eduFacilityVersion]);
  const [eduGroupFilter, setEduGroupFilter] = useState('ELEMENTARY'); // Part 4/4: category-tab filter for the 教育 submenu
  const [eduPackFilter, setEduPackFilter] = useState('ALL'); // Part 4/4: Pack filter for the 教育 submenu
  const [cameraMode, setCameraMode] = useState('iso'); // 'iso' | 'driver' | 'ped'
  const [showPollution, setShowPollution] = useState(false); // mirrors showPollutionRef, for the UI toggle button

  // Leaving the 'freeroad' tool (switched to any other tool) cancels any in-progress draft so a
  // half-drawn preview segment never lingers once the user has moved on to something else.
  if (tool !== 'freeroad' && freeRoadDraftRef.current && threeRef.current) threeRef.current.cancelFreeRoadDraft();
  toolRef.current = tool;
  freeRoadTypeRef.current = freeRoadType;
  taxRef.current = taxRate;
  showPollutionRef.current = showPollution;
  showRoadsideLandRef.current = showRoadsideLand;

  const idx = (tx, ty) => ty * GRID_SIZE + tx;
  const inBounds = (tx, ty) => tx >= 0 && tx < GRID_SIZE && ty >= 0 && ty < GRID_SIZE;
  const isZoneType = (v) => v === TILE_RES || v === TILE_COM || v === TILE_IND;
  const isBorder = (tx, ty) => tx === 0 || tx === GRID_SIZE - 1 || ty === 0 || ty === GRID_SIZE - 1;
  const tileWorldX = (tx) => (tx - GRID_SIZE / 2) * TILE + TILE / 2;
  const tileWorldZ = (ty) => (ty - GRID_SIZE / 2) * TILE + TILE / 2;

  // ============ Health environment hooks (Part 5) ============
  // Declared early (before removeLot/evictHouseholdsAtHome etc. below, which depend on some of
  // these) so every later useCallback can safely list them as a dependency without a
  // temporal-dead-zone hazard. getEnvironmentAt resolves a citizen's homeId (a raw tile index OR
  // a multi-tile lot id, same two shapes resolveAnchorTile() further down handles) into the
  // air/soil pollution already computed by Phase 2's computePollution(), plus a placeholder
  // water-sanitation value (§water sanitationがまだ十分実装されていない場合、仮の入力値を用意して
  // も構いません) — a future water system only needs to change the waterSanitation line below.
  const getEnvironmentAt = useCallback((homeId) => {
    if (homeId == null) return { air: 0, soil: 0, waterSanitation: WATER_SANITATION_DEFAULT };
    let tileIndex = null;
    if (typeof homeId === 'number') tileIndex = homeId;
    else { const lot = lotsRef.current.get(homeId); if (lot) tileIndex = idx(lot.gx, lot.gy); }
    if (tileIndex == null) return { air: 0, soil: 0, waterSanitation: WATER_SANITATION_DEFAULT };
    const { air, soil } = pollutionRef.current;
    return { air: air[tileIndex] || 0, soil: soil[tileIndex] || 0, waterSanitation: WATER_SANITATION_DEFAULT };
  }, []);
  // §病院がない場合は外部都市の病院へ移動 / §park・sports facilityをshelterとして利用 — no
  // Hospital/Park/SportsFacility building type exists yet, so both simply return null today; see
  // sendCitizenToCare()/evictToHomeless() (free functions above) for the fallback behavior this
  // produces. A future building-placement tool only needs to change these two callbacks.
  const findHospitalTileImpl = useCallback(() => null, []);
  const findShelterTileImpl = useCallback(() => null, []);
  // getRoadFootprintHalfWidth(rt)/roadOverhangTiles(rt.hubMul) are the road-system's single
  // source of truth for "how physically wide is this road" (requirement #10/#21). A wide road
  // (six/six_median/eight_median etc.) occupies extra ground beyond its own 1-tile grid cell —
  // this helper checks whether tile (tx,ty) falls inside that overhang from ANY orthogonally
  // adjacent road tile, and is the ONE place building/zone/lot placement asks that question, so
  // a terrace lot, a single-tile zone paint, and a multi-tile lot drag all agree on the same
  // answer instead of each re-deriving (and potentially mis-deriving) it separately.
  const tileBlockedByRoadFootprint = (tx, ty) => {
    const grid = gridRef.current;
    const neighbors = [[tx, ty - 1], [tx, ty + 1], [tx - 1, ty], [tx + 1, ty]];
    for (const [nx, ny] of neighbors) {
      if (!inBounds(nx, ny) || grid[idx(nx, ny)] !== TILE_ROAD) continue;
      const nType = ROAD_TYPES[ROAD_TYPE_KEYS[roadTypeRef.current[idx(nx, ny)]]];
      if (roadOverhangTiles(nType.hubMul) > 0.01) return true;
    }
    return false;
  };
  const roadNeighbors = (tx, ty) => {
    const grid = gridRef.current;
    const out = [];
    [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([dx, dy]) => {
      const nx = tx + dx, ny = ty + dy;
      if (inBounds(nx, ny) && grid[idx(nx, ny)] === TILE_ROAD) out.push({ tx: nx, ty: ny });
    });
    return out;
  };
  // pedestrian version of roadNeighbors: excludes tiles whose road type has no edge sidewalk
  // (median-only roads like four_median/six_median) — pedestrians cannot walk there at all.
  const isPedWalkableRoad = (tx, ty) => {
    if (!inBounds(tx, ty) || gridRef.current[idx(tx, ty)] !== TILE_ROAD) return false;
    const rt = ROAD_TYPES[ROAD_TYPE_KEYS[roadTypeRef.current[idx(tx, ty)]]];
    return !!rt.edgeWalk;
  };
  const pedRoadNeighbors = (tx, ty) => {
    const out = [];
    [[0, -1], [1, 0], [0, 1], [-1, 0]].forEach(([dx, dy]) => {
      const nx = tx + dx, ny = ty + dy;
      if (isPedWalkableRoad(nx, ny)) out.push({ tx: nx, ty: ny });
    });
    return out;
  };
  // one-way enforcement: 'small' (小さな道路) tiles only allow travel toward a compass direction
  // that's actually set in this tile's oneWayDirRef exit bitmask (see recomputeOneWayNetwork);
  // every other road type returns true unconditionally (unchanged behavior). Used only by car
  // routing below — pedestrians use the sidewalk on both sides and are unaffected, so they keep
  // calling the plain pickForwardNeighbor above.
  const isRoadMoveAllowed = (fromTx, fromTy, toTx, toTy) => {
    const i = idx(fromTx, fromTy);
    const typeKey = ROAD_TYPE_KEYS[roadTypeRef.current[i]];
    const toTypeKey = ROAD_TYPE_KEYS[roadTypeRef.current[idx(toTx, toTy)]];
    // never let a car merge onto a one-way 'small' road from a DIFFERENT road type — that merge
    // point has no direction data in the small network's own flow graph, so it was previously
    // allowed unconditionally and let cars enter against the one-way flow (the "car enters from
    // the wrong side and vanishes" bug).
    if (toTypeKey === 'small' && typeKey !== 'small') return false;
    if (typeKey !== 'small') return true;
    // always allowed to leave a 'small' road back onto a different road type, so one-way traffic
    // can actually drain back onto the main network instead of getting stuck at the boundary.
    if (toTypeKey !== 'small') return true;
    const d = dirFromDelta(toTx - fromTx, toTy - fromTy);
    return (oneWayDirRef.current[i] & dirBit(d)) !== 0;
  };
  // Recomputes the allowed-exit bitmask for the WHOLE connected network of 'small' road tiles
  // reachable from (seedTx, seedTy) through other 'small' tiles (4-connected). This replaces the
  // old "single +/- sign for the whole road" model, which could only ever mean "increasing X or
  // increasing Y", so it silently allowed both east AND south on a bend, or let a loop admit
  // traffic from both directions — exactly the bugs this fixes.
  //
  // Method: an undirected DFS over the network from a deterministic root (the lowest tile index
  // in the component). Tree edges are directed away from the root (parent -> child); back edges
  // (found when DFS reaches an already-visited tile that isn't its immediate parent) are directed
  // from the current tile back up to that ancestor, closing the loop. This is the standard
  // construction for orienting a graph so every cycle becomes a single consistent one-way loop
  // (a straight run or bend is just a 2-node-per-step special case of this), while any tree-only
  // edge (a dead-end spur) simply flows outward from the root and is never traversable backward —
  // which is exactly the desired "stop, don't U-turn" rule for small-road dead ends.
  // oneWayFlipRef reverses the WHOLE resulting network at once (every edge's direction swaps),
  // matching the "reverse the whole road" behavior the UI toggle is meant to have.
  const recomputeOneWayNetwork = (seedTx, seedTy) => {
    const grid = gridRef.current;
    const smallIdx = ROAD_TYPE_KEYS.indexOf('small');
    const isSmall = (tx, ty) => inBounds(tx, ty) && grid[idx(tx, ty)] === TILE_ROAD && roadTypeRef.current[idx(tx, ty)] === smallIdx;
    if (!isSmall(seedTx, seedTy)) return;
    const startI = idx(seedTx, seedTy);
    // gather the connected component first, so the root can be chosen deterministically
    const comp = [startI];
    const inComp = new Set([startI]);
    for (let qi = 0; qi < comp.length; qi++) {
      const ci = comp[qi];
      const cx = ci % GRID_SIZE, cy = Math.floor(ci / GRID_SIZE);
      DIR_DELTA.forEach(([dx, dy]) => {
        const nx = cx + dx, ny = cy + dy;
        if (isSmall(nx, ny)) { const ni = idx(nx, ny); if (!inComp.has(ni)) { inComp.add(ni); comp.push(ni); } }
      });
    }
    const root = comp.reduce((a, b) => (b < a ? b : a));
    const depth = new Map([[root, 0]]);
    const edgeSeen = new Set();
    const edgeKey = (a, b) => (a < b ? `${a}_${b}` : `${b}_${a}`);
    const edges = []; // { fromI, toI, dir } — flow direction FROM fromI TO toI (dir as seen from fromI)
    const visit = (ci) => {
      const cx = ci % GRID_SIZE, cy = Math.floor(ci / GRID_SIZE);
      for (let d = 0; d < 4; d++) {
        const [dx, dy] = DIR_DELTA[d];
        const nx = cx + dx, ny = cy + dy;
        if (!isSmall(nx, ny)) continue;
        const ni = idx(nx, ny);
        const key = edgeKey(ci, ni);
        if (edgeSeen.has(key)) continue;
        edgeSeen.add(key);
        if (!depth.has(ni)) {
          depth.set(ni, depth.get(ci) + 1);
          edges.push({ fromI: ci, toI: ni, dir: d });
          visit(ni);
        } else {
          // back edge to an already-visited tile — in an undirected DFS this is always an
          // ancestor, never a cross edge, so flowing current -> ancestor always closes a loop
          // consistently rather than creating a conflicting second direction.
          edges.push({ fromI: ci, toI: ni, dir: d });
        }
      }
    };
    visit(root);
    const flip = oneWayFlipRef.current;
    const masks = new Uint8Array(GRID_SIZE * GRID_SIZE);
    edges.forEach(({ fromI, toI, dir }) => {
      if (!flip) masks[fromI] |= dirBit(dir);
      else masks[toI] |= dirBit(DIR_OPP[dir]);
    });
    comp.forEach((ci) => { oneWayDirRef.current[ci] = masks[ci]; });
  };
  // Call after any change that can add, remove, or retype a road tile touching 'small' roads —
  // recomputes (tx,ty)'s own network if it's still 'small', plus every still-'small' neighbor's
  // network (covers: placing a new small tile that merges into or extends an existing network;
  // erasing/retyping a small tile away, which can split or shrink a neighboring network).
  const refreshOneWayNetworkAround = (tx, ty) => {
    const grid = gridRef.current;
    const smallIdx = ROAD_TYPE_KEYS.indexOf('small');
    const candidates = [[tx, ty], ...DIR_DELTA.map(([dx, dy]) => [tx + dx, ty + dy])];
    candidates.forEach(([cx, cy]) => {
      if (!inBounds(cx, cy)) return;
      const ci = idx(cx, cy);
      if (grid[ci] === TILE_ROAD && roadTypeRef.current[ci] === smallIdx) recomputeOneWayNetwork(cx, cy);
    });
  };
  // car-only variant of pickForwardNeighbor: prefers neighbors that respect the one-way
  // direction of the tile being left, and actually ROUTES toward the car's destination instead
  // of blindly preferring to continue straight — the old "always go straight when possible"
  // priority meant a car only ever turned at a junction when going straight was unavailable, so
  // in practice cars just queued up behind whoever was ahead of them and never turned left/right
  // on their own. Distance-to-destination is now the primary signal (with a little randomness so
  // traffic doesn't all funnel down one "optimal" corridor), which gives each car real agency
  // about which way it goes at every intersection.
  // At a genuine dead end (or a one-way conflict with nowhere else legal to go), this returns a
  // U-turn back the way the car came (flagged with `uturn: true`) instead of returning null —
  // returning null caused the caller to despawn the car in place, which is what made cars vanish
  // at the end of a road instead of turning around. This now applies to EVERY road type,
  // including 'small' (一方通行) roads — a car that reaches the end of a one-way street reverses
  // course rather than disappearing.
  const pickForwardNeighborCar = (tx, ty, exTx, exTy, destTx, destTy) => {
    const all = roadNeighbors(tx, ty);
    const forward = all.filter((n) => !(n.tx === exTx && n.ty === exTy) && isRoadMoveAllowed(tx, ty, n.tx, n.ty));
    if (!forward.length) {
      const back = all.find((n) => n.tx === exTx && n.ty === exTy);
      return back ? { tx: back.tx, ty: back.ty, uturn: true } : null;
    }
    if (destTx === undefined || destTx === null || forward.length === 1) {
      return forward[Math.floor(Math.random() * forward.length)];
    }
    // greedy distance-to-destination bias: pick the candidate(s) that reduce Manhattan distance
    // the most (this is what makes a car actually turn left/right toward where it's headed
    // instead of defaulting to straight-through), breaking ties randomly, but only most of the
    // time so traffic still spreads across more than one "optimal" route.
    if (Math.random() < 0.2) return forward[Math.floor(Math.random() * forward.length)];
    let bestDist = Infinity, bestSet = [];
    forward.forEach((n) => {
      const d = Math.abs(n.tx - destTx) + Math.abs(n.ty - destTy);
      if (d < bestDist) { bestDist = d; bestSet = [n]; } else if (d === bestDist) bestSet.push(n);
    });
    return bestSet[Math.floor(Math.random() * bestSet.length)];
  };
  // Resolves the lane offset a car/entity should use while driving from fromTile to toTile,
  // based on the road type of the tile it's leaving and (for 3+ lane roads) that tile's stored
  // flip bit. Uses the SAME px/pz perpendicular-to-travel convention as segPoint below, so
  // "positive offset" always means "this entity's own right", which is what naturally keeps
  // opposite-direction traffic on opposite physical sides without special-casing direction here.
  const laneOffsetForMove = (fromTx, fromTy, toTx, toTy, currentOffset) => {
    const i = idx(fromTx, fromTy);
    const typeKey = ROAD_TYPE_KEYS[roadTypeRef.current[i]] || 'two';
    const dx = toTx - fromTx, dy = toTy - fromTy;
    const axisSign = dx !== 0 ? Math.sign(dx) : Math.sign(dy);
    const flipBit = threeLaneDirRef.current[i];
    return pickForwardLaneOffset(typeKey, axisSign, flipBit, currentOffset);
  };
  const segPoint = (fromTile, toTile, lane, t) => {
    const fx = tileWorldX(fromTile.tx), fz = tileWorldZ(fromTile.ty);
    const tx2 = tileWorldX(toTile.tx), tz2 = tileWorldZ(toTile.ty);
    const dx = tx2 - fx, dz = tz2 - fz;
    const len = Math.hypot(dx, dz) || 1;
    const px = -dz / len, pz = dx / len;
    return { x: fx + dx * t + px * lane, z: fz + dz * t + pz * lane, heading: Math.atan2(dx, dz) };
  };
  // laneCur = the lane offset for the segment the entity is currently on; laneNext = the lane
  // offset it will use on the SEGMENT AFTER nextTile. Using two separate values (instead of one
  // shared "lane" for both ends of the curve, as before) means that whenever the road type/flip
  // changes across a turn (e.g. a 2-lane road curving into a 3-lane one), the lateral offset
  // blends continuously across the corner's bezier instead of snapping the instant the car
  // crosses into the new tile — this is what keeps 2<->3 lane transitions and curves warp-free.
  const movePoint = (fromTile, toTile, nextTile, laneCur, laneNext, t, turning) => {
    if (!turning || !nextTile || t < CORNER_START) {
      return segPoint(fromTile, toTile, laneCur, Math.min(t, 1));
    }
    const s = smoothstep((t - CORNER_START) / (1 - CORNER_START));
    const p0 = segPoint(fromTile, toTile, laneCur, CORNER_START);
    const p2 = segPoint(toTile, nextTile, laneNext, CORNER_MIRROR);

    const fx = tileWorldX(fromTile.tx), fz = tileWorldZ(fromTile.ty);
    const tx2 = tileWorldX(toTile.tx), tz2 = tileWorldZ(toTile.ty);
    const nx = tileWorldX(nextTile.tx), nz = tileWorldZ(nextTile.ty);
    const dInLen = Math.hypot(tx2 - fx, tz2 - fz) || 1;
    const dIn = { x: (tx2 - fx) / dInLen, z: (tz2 - fz) / dInLen };
    const dOutLen = Math.hypot(nx - tx2, nz - tz2) || 1;
    const dOut = { x: (nx - tx2) / dOutLen, z: (nz - tz2) / dOutLen };

    // -- canonical fillet control point: the intersection of the ENTRY lane's straight line
    // (through p0, heading = FROM direction) and the EXIT lane's straight line (through p2,
    // heading = TO direction) — NOT simply "the entry lane extended a fixed distance" (the old
    // formula, which only guaranteed tangency at the entry end). Solving for the true
    // intersection makes the quadratic Bezier genuinely tangent to BOTH the incoming and outgoing
    // lane lines, so a car's heading matches its actual direction of travel at both ends of the
    // curve (requirement #35), and the curve's shape (tight vs. wide) responds correctly to
    // which lane (inner/outer) it's built for instead of using one generic path for every lane.
    const det = dIn.x * (-dOut.z) - dIn.z * (-dOut.x);
    let ctrl;
    if (Math.abs(det) > 1e-6) {
      const rhsX = p2.x - p0.x, rhsZ = p2.z - p0.z;
      const sParam = (rhsX * (-dOut.z) - rhsZ * (-dOut.x)) / det;
      ctrl = { x: p0.x + dIn.x * sParam, z: p0.z + dIn.z * sParam };
    } else {
      ctrl = segPoint(fromTile, toTile, laneCur, 1); // degenerate fallback — should not occur for a real 90° bend
    }
    const u = 1 - s;
    let x = u * u * p0.x + 2 * u * s * ctrl.x + s * s * p2.x;
    let z = u * u * p0.z + 2 * u * s * ctrl.z + s * s * p2.z;

    // -- hard median guard (requirement #36): a car's path may never cross into either road's
    // physical median strip, checked directly against the real road geometry (getRoadLayout)
    // rather than assumed safe because the endpoints look fine. For EACH of the two roads this
    // curve touches, clamp the interpolated point's perpendicular offset from that road's own
    // centerline — measured on the same signed axis segPoint uses, so "which side" always
    // matches the lane the car is actually supposed to be on — so it can never fall inside that
    // road's median band, which runs the full length of the road on either side of the corner.
    const fromTypeKey = ROAD_TYPE_KEYS[roadTypeRef.current[idx(fromTile.tx, fromTile.ty)]];
    const toTypeKey = ROAD_TYPE_KEYS[roadTypeRef.current[idx(toTile.tx, toTile.ty)]];
    const fromMedianHalf = fromTypeKey ? getRoadLayout(ROAD_TYPES[fromTypeKey]).medianHalfWidth : 0;
    const toMedianHalf = toTypeKey ? getRoadLayout(ROAD_TYPES[toTypeKey]).medianHalfWidth : 0;
    // Softened on purpose: the old version hard-snapped the point the instant it crossed the
    // median line, which introduced a sudden discontinuity (visible kink) right in the middle of
    // the curve — most noticeable on inner lanes, which pass closest to the median. Pulling the
    // point back only partway (instead of all the way to the boundary) keeps the intent (don't
    // let the curve wander far into the median) without breaking the curve's smoothness.
    const clampAgainstMedian = (px, pz, center, dir, laneOffset, medianHalfWidth) => {
      if (medianHalfWidth <= 0) return { x: px, z: pz };
      const nrmX = -dir.z, nrmZ = dir.x; // same "own right" perpendicular convention as segPoint's px/pz
      const offset = (px - center.x) * nrmX + (pz - center.z) * nrmZ;
      const sign = laneOffset >= 0 ? 1 : -1;
      const minOffset = sign * medianHalfWidth;
      const violation = sign > 0 ? minOffset - offset : offset - minOffset;
      if (violation <= 0) return { x: px, z: pz };
      const delta = sign * violation * 0.5;
      return { x: px + nrmX * delta, z: pz + nrmZ * delta };
    };
    let clamped = clampAgainstMedian(x, z, { x: fx, z: fz }, dIn, laneCur, fromMedianHalf);
    x = clamped.x; z = clamped.z;
    clamped = clampAgainstMedian(x, z, { x: tx2, z: tz2 }, dOut, laneNext, toMedianHalf);
    x = clamped.x; z = clamped.z;

    return { x, z, heading: lerpAngle(p0.heading, p2.heading, s) };
  };
  // how long (seconds) a straight-line lane-offset change (e.g. crossing from a 2-lane road onto
  // a 3-lane one on the same heading) takes to blend from the old offset to the new one, instead
  // of snapping instantly. Corner-based transitions are handled separately by movePoint's own
  // spatial blend above; this covers the NON-turning case that movePoint alone can't smooth.
  const LANE_BLEND_DUR = 0.45;

  const recomputeConnectivity = useCallback(() => {
    const grid = gridRef.current;
    const connected = connectedRef.current;
    connected.fill(0);
    const queue = [];
    for (let tx = 0; tx < GRID_SIZE; tx++) [0, GRID_SIZE - 1].forEach((ty) => {
      const i = idx(tx, ty);
      if (grid[i] === TILE_ROAD && !connected[i]) { connected[i] = 1; queue.push(i); }
    });
    for (let ty = 0; ty < GRID_SIZE; ty++) [0, GRID_SIZE - 1].forEach((tx) => {
      const i = idx(tx, ty);
      if (grid[i] === TILE_ROAD && !connected[i]) { connected[i] = 1; queue.push(i); }
    });
    const dirs = [[0, -1], [1, 0], [0, 1], [-1, 0]];
    let head = 0;
    while (head < queue.length) {
      const i = queue[head++];
      const tx = i % GRID_SIZE, ty = Math.floor(i / GRID_SIZE);
      for (const [dx, dy] of dirs) {
        const nx = tx + dx, ny = ty + dy;
        if (!inBounds(nx, ny)) continue;
        const ni = idx(nx, ny);
        if (grid[ni] === TILE_ROAD && !connected[ni]) { connected[ni] = 1; queue.push(ni); }
      }
    }
  }, []);

  // NOTE: a highway-type neighbor deliberately does NOT count as road access here. Real highways
  // have no direct driveways — a zone/lot/building must front an ordinary road; the player has to
  // route a normal road off the highway's IC/interchange stub first (requirement #11: "住宅地への
  // 直接アクセス不可"). This is the one shared place that rule lives, so zoning eligibility, lot
  // placement (lotHasRoadAccess), and level-up growth (which all call this) stay consistent.
  const hasConnectedRoadNeighbor = useCallback((tx, ty) => {
    const grid = gridRef.current;
    const roadType = roadTypeRef.current;
    for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
      const nx = tx + dx, ny = ty + dy;
      if (!inBounds(nx, ny) || grid[idx(nx, ny)] !== TILE_ROAD) continue;
      if (ROAD_TYPE_KEYS[roadType[idx(nx, ny)]] === 'highway') continue;
      return true;
    }
    return false;
  }, []);

  // Finds every highway tile currently sitting ON the map border that is part of the connected
  // road network AND has a real road tile immediately inland of it — i.e. every point where
  // outside-world traffic can actually enter/exit this city (requirement #4/#18: the highway IS
  // the "外部交通ゲート"). Recomputed whenever the road network changes (see recomputeConnectivity
  // call sites) rather than hardcoded, so player-extended highway reaching a second map edge, or a
  // future second highway entrance, is picked up automatically with no extra wiring.
  const computeHighwayGates = useCallback(() => {
    const grid = gridRef.current;
    const roadType = roadTypeRef.current;
    const connected = connectedRef.current;
    const highwayIdx = ROAD_TYPE_KEYS.indexOf('highway');
    const gates = [];
    const seen = new Set();
    const tryAdd = (tx, ty, inTx, inTy) => {
      const key = `${tx},${ty}`;
      if (seen.has(key)) return;
      const i = idx(tx, ty);
      if (grid[i] !== TILE_ROAD || roadType[i] !== highwayIdx || !connected[i]) return;
      if (!inBounds(inTx, inTy) || grid[idx(inTx, inTy)] !== TILE_ROAD) return;
      seen.add(key);
      gates.push({ tx, ty, inTx, inTy });
    };
    for (let tx = 0; tx < GRID_SIZE; tx++) {
      tryAdd(tx, 0, tx, 1);
      tryAdd(tx, GRID_SIZE - 1, tx, GRID_SIZE - 2);
    }
    for (let ty = 0; ty < GRID_SIZE; ty++) {
      tryAdd(0, ty, 1, ty);
      tryAdd(GRID_SIZE - 1, ty, GRID_SIZE - 2, ty);
    }
    return gates;
  }, []);

  // ---- World Space footprint occupancy / frontage (Prompt 5 of the Tile->World Space migration)
  // lotFootprintClear(cx, cz, w, h): can a w x h (meters) footprint centered at (cx, cz) be placed
  // here — checked against Buildable Land, the Road Footprint of BOTH road systems this game has
  // (the old Tile-grid road network AND the free World Space RoadSegment network from Prompt 3/4),
  // and every other placed Building's real World Space rectangle (never a Tile coincidence, since
  // footprints are no longer forced to Tile multiples). The footprint is also rasterized onto the
  // Tile grid purely to reuse gridRef/lotIdGridRef's existing zone/road/lot/edu-facility occupancy
  // bookkeeping — that rasterization is bookkeeping only, never the placement's source of truth.
  const lotFootprintClear = useCallback((cx, cz, w, h) => {
    const grid = gridRef.current, lotIdGrid = lotIdGridRef.current;
    const network = roadNetworkRef.current;
    const halfW = w / 2, halfD = h / 2;
    const minX = cx - halfW, maxX = cx + halfW, minZ = cz - halfD, maxZ = cz + halfD;
    const mapHalf = (GRID_SIZE * TILE) / 2;
    if (minX < -mapHalf || maxX > mapHalf || minZ < -mapHalf || maxZ > mapHalf) return false;

    // 1) rasterized Tile-grid occupancy — old zone/road/lot/edu-facility bookkeeping
    const gx0 = Math.floor((minX + mapHalf) / TILE), gx1 = Math.ceil((maxX + mapHalf) / TILE) - 1;
    const gy0 = Math.floor((minZ + mapHalf) / TILE), gy1 = Math.ceil((maxZ + mapHalf) / TILE) - 1;
    for (let y = gy0; y <= gy1; y++) for (let x = gx0; x <= gx1; x++) {
      if (!inBounds(x, y)) return false;
      if (grid[idx(x, y)] !== TILE_EMPTY || lotIdGrid[idx(x, y)] !== -1) return false;
      // wide roads (six/six_median/eight_median etc.) occupy extra ground beyond their own grid
      // cell — treat any orthogonal neighbour whose pavement overhang reaches into this tile as
      // road-occupied too, so a Building can't be dropped into the overhang.
      if (tileBlockedByRoadFootprint(x, y)) return false;
    }

    // 2) the free (World Space) RoadSegment network's REAL paved footprint — sampled across the
    // continuous rectangle, so a curved road that cuts across a Tile boundary is still caught even
    // when the rasterized check above wouldn't flag that Tile.
    const sampX = Math.max(2, Math.ceil(w / 2)), sampZ = Math.max(2, Math.ceil(h / 2));
    for (let iz = 0; iz <= sampZ; iz++) for (let ix = 0; ix <= sampX; ix++) {
      const sx = minX + (maxX - minX) * (ix / sampX), sz = minZ + (maxZ - minZ) * (iz / sampZ);
      if (isInsideRoadFootprint(network, sx, sz)) return false;
    }

    // 3) real World Space rectangle overlap against every other placed Building
    for (const other of lotsRef.current.values()) {
      const ow = other.footprint.width / 2, od = other.footprint.depth / 2;
      const overlapsX = minX < other.position.x + ow && maxX > other.position.x - ow;
      const overlapsZ = minZ < other.position.z + od && maxZ > other.position.z - od;
      if (overlapsX && overlapsZ) return false;
    }
    return true;
  }, []);

  // findLotFrontage: 建物のfrontage edge -> 最寄りのRoadSegment 判定 (§道路接道). Samples the four
  // edge midpoints of the footprint (never a Tile-neighbor lookup) against BOTH road systems that
  // coexist in this game — the old Tile-grid road network (reusing hasConnectedRoadNeighbor's own
  // "a highway neighbor does NOT count" rule) and the free World Space RoadSegment network
  // (getRoadFrontage, which itself resolves to the nearest RoadSegment's own curve) — so a Building
  // can front either kind of road, on a straight OR curved alignment.
  const findLotFrontage = useCallback((cx, cz, w, h) => {
    const grid = gridRef.current, roadType = roadTypeRef.current;
    const network = roadNetworkRef.current;
    const halfW = w / 2, halfD = h / 2, probe = 0.6, mapHalf = (GRID_SIZE * TILE) / 2;
    const edges = [
      { fx: cx, fz: cz - halfD - probe, sign: -1 }, // north edge
      { fx: cx, fz: cz + halfD + probe, sign: 1 },  // south edge
      { fx: cx - halfW - probe, fz: cz, sign: -1 }, // west edge
      { fx: cx + halfW + probe, fz: cz, sign: 1 },  // east edge
    ];
    for (const e of edges) {
      const tx = Math.floor((e.fx + mapHalf) / TILE), ty = Math.floor((e.fz + mapHalf) / TILE);
      if (inBounds(tx, ty) && grid[idx(tx, ty)] === TILE_ROAD && ROAD_TYPE_KEYS[roadType[idx(tx, ty)]] !== 'highway') {
        return { ok: true, frontSign: e.sign };
      }
      if (getRoadFrontage(network, e.fx, e.fz)) return { ok: true, frontSign: e.sign };
    }
    return { ok: false, frontSign: -1 };
  }, []);

  // Terrace houses are always a single fixed 6m x 12m World Space unit. Given a drag anchor/cursor
  // (World Space points, not Tile coords), this tries BOTH possible orientations anchored at the
  // same corner and picks whichever one actually has its narrow (frontage) edge fronting a road —
  // that is what makes the building automatically face the real street instead of blindly following
  // whichever way the player happened to drag. Falls back to the drag-implied orientation (or
  // whichever orientation is clear at all) if neither/both look equally good.
  const pickTerraceOrientation = useCallback((ax, az, cx, cz) => {
    const dxAbs = Math.abs(cx - ax), dzAbs = Math.abs(cz - az);
    const primary = dxAbs >= dzAbs ? { w: TILE * 2, h: TILE } : { w: TILE, h: TILE * 2 };
    const alt = { w: primary.h, h: primary.w };
    const tryOrientation = (dims) => {
      const x0 = cx >= ax ? ax : ax - dims.w;
      const z0 = cz >= az ? az : az - dims.h;
      const centerX = x0 + dims.w / 2, centerZ = z0 + dims.h / 2;
      if (!lotFootprintClear(centerX, centerZ, dims.w, dims.h)) return null;
      const frontage = findLotFrontage(centerX, centerZ, dims.w, dims.h);
      return { centerX, centerZ, w: dims.w, h: dims.h, frontOk: frontage.ok, frontSign: frontage.frontSign };
    };
    const a = tryOrientation(primary);
    const b = tryOrientation(alt);
    if (a && a.frontOk) return a;
    if (b && b.frontOk) return b;
    if (a) return a;
    if (b) return b;
    const fx0 = cx >= ax ? ax : ax - primary.w, fz0 = cz >= az ? az : az - primary.h;
    return { centerX: fx0 + primary.w / 2, centerZ: fz0 + primary.h / 2, w: primary.w, h: primary.h, frontOk: false, frontSign: -1 };
  }, [lotFootprintClear, findLotFrontage]);

  // lotHasRoadAccess is now a pure World Space query — centered at (cx, cz) with a w x h (meters)
  // footprint — answered from findLotFrontage's real frontage-edge scan, never from a Tile-adjacency
  // guess. Kept as its own named function (rather than inlining findLotFrontage everywhere) since
  // level-up growth (which calls this with the lot's live position/footprint) needs the same rule
  // placement does.
  const lotHasRoadAccess = useCallback((cx, cz, w, h) => findLotFrontage(cx, cz, w, h).ok, [findLotFrontage]);

  const rebuildLotGroup = useCallback((lot) => {
    const t = threeRef.current; if (!t) return;
    if (lot.group) {
      t.scene.remove(lot.group);
      lot.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); }
      });
    }
    const group = buildLotGroup(lot.type, lot.footprint.width, lot.footprint.depth, lot.level, lot.frontSign);
    // buildingY = terrainHeight(x,z), re-queried live (never a hardcoded Y) so a later terrain
    // change is picked up the next time this Building's group is rebuilt (level-up, etc.).
    const y = terrainHeight(lot.position.x, lot.position.z);
    lot.position.y = y;
    group.position.set(lot.position.x, y, lot.position.z);
    if (lot.rotation) group.rotation.y = lot.rotation;
    t.scene.add(group);
    lot.group = group;
  }, []);

  // Part 5 (§Homeless: "家を失う"): any household whose homeId still points at a home tile/lot
  // that just got bulldozed/dezoned loses that home and its members are evicted to Homeless —
  // scanning householdsRef here is fine (a rare, explicit player action), never a per-frame cost.
  const evictHouseholdsAtHome = useCallback((homeId) => {
    const ctx = {
      citizens: citizensRef.current, workplaces: workplacesRef.current, educationFacilities: educationFacilitiesRef.current,
      findShelterTile: findShelterTileImpl,
    };
    const now = gameClockRef.current.getEpochMs();
    householdsRef.current.forEach((household) => {
      if (household.homeId === homeId && !household.evicted) evictHousehold(simManagerRef.current, household, ctx, now, 'lot_removed');
    });
  }, [findShelterTileImpl]);

  const removeLot = useCallback((id) => {
    const lot = lotsRef.current.get(id);
    if (!lot) return;
    const grid = gridRef.current, lotIdGrid = lotIdGridRef.current;
    for (let y = lot.gy; y < lot.gy + lot.h; y++) for (let x = lot.gx; x < lot.gx + lot.w; x++) {
      const i = idx(x, y); grid[i] = TILE_EMPTY; lotIdGrid[i] = -1;
    }
    evictHouseholdsAtHome(id);
    const t = threeRef.current;
    if (t && lot.group) {
      t.scene.remove(lot.group);
      lot.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); }); }
      });
    }
    lotsRef.current.delete(id);
    threeRef.current?.syncInstances?.();
  }, [evictHouseholdsAtHome]);

  // finalizeLot's real placement data is World Space: (centerX, centerZ) + (width, depth) in
  // meters — NEVER a Tile rect. gx/gy/w/h are still computed and stored on the resulting lot, but
  // only as a rasterization for the Tile-grid bookkeeping other systems (Citizens, pollution,
  // removeLot, growth tick's buildingCount) still read — see the migration header comment above
  // clampLotSize.
  const finalizeLot = useCallback((type, centerX, centerZ, width, depth, frontSign) => {
    const spec = RES_LOT_TYPES[type];
    if (!spec || popRef.current < spec.unlockPop) return false;
    if (!lotFootprintClear(centerX, centerZ, width, depth)) return false;
    if (!lotHasRoadAccess(centerX, centerZ, width, depth)) return false;
    const mapHalf = (GRID_SIZE * TILE) / 2;
    const halfW = width / 2, halfD = depth / 2;
    const gx = Math.floor((centerX - halfW + mapHalf) / TILE);
    const gy = Math.floor((centerZ - halfD + mapHalf) / TILE);
    const w = Math.ceil((centerX + halfW + mapHalf) / TILE) - gx;
    const h = Math.ceil((centerZ + halfD + mapHalf) / TILE) - gy;
    if (gx < 0 || gy < 0 || gx + w > GRID_SIZE || gy + h > GRID_SIZE) return false;
    const grid = gridRef.current, lotIdGrid = lotIdGridRef.current;
    const id = lotIdCounterRef.current++;
    for (let y = gy; y < gy + h; y++) for (let x = gx; x < gx + w; x++) {
      const i = idx(x, y); grid[i] = TILE_RES; lotIdGrid[i] = id;
    }
    const lot = {
      id, type,
      position: { x: centerX, y: terrainHeight(centerX, centerZ), z: centerZ },
      footprint: { width, depth },
      rotation: 0,
      gx, gy, w, h, // legacy Tile-grid rasterization — bookkeeping only, see migration header comment
      level: 0, group: null, frontSign: frontSign ?? -1,
    };
    lotsRef.current.set(id, lot);
    rebuildLotGroup(lot);
    threeRef.current?.rebuildRoadTileList?.();
    threeRef.current?.syncInstances?.();
    return true;
  }, [lotFootprintClear, lotHasRoadAccess, rebuildLotGroup]);

  // ============ Education facilities: placement / removal / selection (Part 1) ============
  // eduFacilityHasRoadAccess reuses hasConnectedRoadNeighbor()/the same footprint-scan shape as
  // lotHasRoadAccess — per §配置ルール this must NOT be a re-implemented duplicate.
  const eduFacilityHasRoadAccess = useCallback((gx, gy, w, h) => {
    for (let y = gy; y < gy + h; y++) for (let x = gx; x < gx + w; x++) {
      if (x > gx && x < gx + w - 1 && y > gy && y < gy + h - 1) continue;
      if (hasConnectedRoadNeighbor(x, y)) return true;
    }
    return false;
  }, [hasConnectedRoadNeighbor]);

  const canPlaceEducationFacility = useCallback((definitionId, gx, gy) => {
    const def = EDUCATION_FACILITIES[definitionId];
    if (!def) return false;
    const { w, h } = def.size;
    if (gx < 0 || gy < 0 || gx + w > GRID_SIZE || gy + h > GRID_SIZE) return false;
    const grid = gridRef.current, lotIdGrid = lotIdGridRef.current, eduGrid = eduFacilityIdGridRef.current;
    for (let y = gy; y < gy + h; y++) for (let x = gx; x < gx + w; x++) {
      const i = idx(x, y);
      // §土地占有: must be EMPTY, not another education facility, not a road footprint, not an
      // existing lot/building.
      if (grid[i] !== TILE_EMPTY) return false;
      if (lotIdGrid[i] !== -1 || eduGrid[i] !== -1) return false;
      if (tileBlockedByRoadFootprint(x, y)) return false;
    }
    if (!eduFacilityHasRoadAccess(gx, gy, w, h)) return false;
    return true;
  }, [eduFacilityHasRoadAccess]);

  const rebuildEducationFacilityGroup = useCallback((instance) => {
    const t = threeRef.current; if (!t) return;
    if (instance.group) {
      t.scene.remove(instance.group);
      instance.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach((m) => m.dispose()); }
      });
    }
    const group = buildEducationFacilityGroup(instance.definitionId, instance.w, instance.h);
    group.position.set(
      tileWorldX(instance.tx) + ((instance.w - 1) * TILE) / 2,
      0,
      tileWorldZ(instance.ty) + ((instance.h - 1) * TILE) / 2,
    );
    t.scene.add(group);
    instance.group = group;
  }, []);

  const placeEducationFacility = useCallback((definitionId, gx, gy) => {
    if (!canPlaceEducationFacility(definitionId, gx, gy)) return false;
    const def = EDUCATION_FACILITIES[definitionId];
    if (budget.treasury < def.cost) return false;
    const instance = createEducationFacilityInstance(definitionId, gx, gy);
    if (!instance) return false;
    const grid = gridRef.current, eduGrid = eduFacilityIdGridRef.current;
    const numericId = eduFacilityIdCounterRef.current++;
    instance.numericId = numericId;
    for (let y = gy; y < gy + instance.h; y++) for (let x = gx; x < gx + instance.w; x++) {
      const i = idx(x, y); grid[i] = TILE_EDU; eduGrid[i] = numericId;
    }
    educationFacilitiesRef.current.set(numericId, instance);
    rebuildEducationFacilityGroup(instance);
    setBudget((b) => ({ ...b, treasury: b.treasury - def.cost }));
    setEduFacilityVersion((v) => v + 1);
    return true;
  }, [canPlaceEducationFacility, rebuildEducationFacilityGroup, budget]);

  const removeEducationFacility = useCallback((numericId) => {
    const instance = educationFacilitiesRef.current.get(numericId);
    if (!instance) return;
    // §施設削除: in-progress students lose their seat but keep their attained educationLevel —
    // they're simply put back into the normal scheduleSchoolAttempt() retry loop (same path a
    // citizen who found no capacity takes), never deleted/downgraded/force-upgraded.
    const now = gameClockRef.current.getEpochMs();
    instance.enrolledStudents.forEach((citizenId) => {
      const citizen = citizensRef.current.get(citizenId);
      if (!citizen) return;
      citizen.currentSchoolId = null;
      citizen.currentActivity = 'idle';
      scheduleSchoolAttempt(simManagerRef.current, citizen, now);
    });
    instance.enrolledStudents.clear();
    const grid = gridRef.current, eduGrid = eduFacilityIdGridRef.current;
    for (let y = instance.ty; y < instance.ty + instance.h; y++) for (let x = instance.tx; x < instance.tx + instance.w; x++) {
      const i = idx(x, y); grid[i] = TILE_EMPTY; eduGrid[i] = -1;
    }
    const t = threeRef.current;
    if (t && instance.group) {
      t.scene.remove(instance.group);
      instance.group.traverse((o) => {
        if (o.geometry) o.geometry.dispose();
        if (o.material) { const mats = Array.isArray(o.material) ? o.material : [o.material]; mats.forEach((m) => m.dispose()); }
      });
    }
    educationFacilitiesRef.current.delete(numericId);
    setEduFacilityVersion((v) => v + 1);
    setEduFacilityPanel((p) => (p && p.numericId === numericId ? null : p));
  }, []);

  // Part 4/4: enabled/disabled toggle (§施設有効/無効). When disabled, computeEducationCityEffects
  // (via the `if (!instance.enabled) continue;` guard) drops this instance's cityEffects/research
  // effects from the aggregate entirely — no separate "disabled" bookkeeping needed. Citizen
  // simulation is untouched (§ただしCitizen simulationはまだないので、学生AIそのものを停止する必要
  // はありません) — this purely flips the flag the aggregator and pollution/upkeep sums already read.
  const toggleEducationFacilityEnabled = useCallback((numericId) => {
    const instance = educationFacilitiesRef.current.get(numericId);
    if (!instance) return;
    instance.enabled = !instance.enabled;
    setEduFacilityVersion((v) => v + 1);
  }, []);

  // Part 3/4: install one copy of an upgrade onto a placed facility instance. multiInstance
  // upgrades (§複数設置可能アップグレード) may be added more than once — each call just pushes
  // another upgradeId onto instance.upgrades; non-multiInstance upgrades are blocked if already
  // present. Capacity/upkeep/staff are recalculated from the definition, never hand-edited.
  const addEducationFacilityUpgrade = useCallback((numericId, upgradeId) => {
    const instance = educationFacilitiesRef.current.get(numericId);
    if (!instance) return false;
    const def = EDUCATION_FACILITIES[instance.definitionId];
    if (!def) return false;
    const upgradeDef = (def.upgrades || []).find((u) => u.id === upgradeId);
    if (!upgradeDef) return false;
    const alreadyInstalled = instance.upgrades.includes(upgradeId);
    if (alreadyInstalled && !upgradeDef.multiInstance) return false;
    if (budget.treasury < upgradeDef.cost) return false;
    instance.upgrades.push(upgradeId);
    recalcEducationFacilityInstance(instance);
    setBudget((b) => ({ ...b, treasury: b.treasury - upgradeDef.cost }));
    setEduFacilityVersion((v) => v + 1);
    return true;
  }, [budget]);

  const updateEducationFacilityPreview = useCallback((definitionId, tx, ty) => {
    const t = threeRef.current; if (!t || !t.lotPreviewMesh) return;
    const def = EDUCATION_FACILITIES[definitionId];
    if (!def) { t.lotPreviewMesh.visible = false; return; }
    const { w, h } = def.size;
    const valid = canPlaceEducationFacility(definitionId, tx, ty);
    t.lotPreviewMesh.position.set(tileWorldX(tx) + ((w - 1) * TILE) / 2, 0.55, tileWorldZ(ty) + ((h - 1) * TILE) / 2);
    t.lotPreviewMesh.scale.set(w * TILE * 0.96, 1, h * TILE * 0.96);
    t.lotPreviewMesh.material.color.set(valid ? 0x7fe0a8 : 0xe05a4f);
    t.lotPreviewMesh.visible = true;
    return valid;
  }, [canPlaceEducationFacility]);

  const openEducationFacilityInspector = useCallback((numericId) => {
    const instance = educationFacilitiesRef.current.get(numericId);
    if (!instance) return false;
    const def = EDUCATION_FACILITIES[instance.definitionId];
    if (!def) return false;
    // Part 3/4: per-upgrade install count so multiInstance upgrades (e.g. 大学病院) show "x2" and
    // the panel can still offer a purchase button for non-multiInstance upgrades already at 0/1.
    const availableUpgrades = (def.upgrades || []).map((u) => ({
      id: u.id, name: u.name, cost: u.cost, monthlyUpkeep: u.monthlyUpkeep,
      capacityBonus: u.capacityBonus || 0, multiInstance: !!u.multiInstance,
      installedCount: instance.upgrades.filter((x) => x === u.id).length,
      // §Upgrade Inspector: 各upgradeの「サイズ」「都市効果」もそのままPart 1-3のupgrade定義から
      // 表示できるようにする（配置方式は「本体隣接」固定 — Part 1-3のupgrade配置UI自体は未実装のため）。
      size: u.size || null,
      cityEffects: u.cityEffects || null,
    }));
    setEduFacilityPanel({
      numericId,
      instanceId: instance.instanceId,
      name: def.name,
      category: def.category,
      currentCapacity: instance.currentCapacity,
      maxCapacity: def.maxCapacity,
      currentStaff: instance.currentStaff,
      // Part 5: real enrollment, read straight off the facility instance (single source of truth)
      enrolledStudents: instance.enrolledStudents.size,
      availableSeats: facilityAvailableSeats(instance),
      monthlyUpkeep: instance.monthlyUpkeep,
      cost: def.cost,
      size: def.size,
      educationOutput: def.educationOutput,
      educationOutputLabel: EDUCATION_OUTPUT_LABEL_JA[def.educationOutput],
      pack: def.pack,
      enabled: instance.enabled,
      upgradeCount: instance.upgrades.length,
      availableUpgrades,
      pollution: def.pollution || { air: 0, soil: 0, noise: 0 },
      cityEffects: def.cityEffects || null,
      // Part 4/4: Research施設の場合、学生数より研究施設効果を優先表示（§教育施設Inspector）。
      // Non-research facilities still carry def.cityEffects above; this is just the Inspector's
      // "which block to show first" hint — same underlying data, no duplicate effect source.
      isResearch: def.category === 'RESEARCH',
      researchEffects: def.category === 'RESEARCH' ? (def.cityEffects || null) : null,
    });
    return true;
  }, []);

  // ax/az/cx/cz are World Space points (raw raycast coordinates, never Tile indices) — the drag
  // anchor and current cursor position. w/h come out of clampLotSize as a continuous World Space
  // footprint, so the preview (and the resulting lot) is never snapped to a Tile-multiple size or
  // a Tile-center position (§禁止事項: 建物を毎回Tile centerへ吸着 / サイズをTILEの整数倍に強制).
  const updateLotPreview = useCallback((type, ax, az, cx, cz) => {
    const t = threeRef.current; if (!t || !t.lotPreviewMesh) return;
    const spec = RES_LOT_TYPES[type];
    if (!spec) { t.lotPreviewMesh.visible = false; return; }
    let centerX, centerZ, w, h, valid, frontSign = -1;
    if (type === 'res_terrace') {
      const orient = pickTerraceOrientation(ax, az, cx, cz);
      ({ centerX, centerZ, w, h, frontSign } = orient);
      dragRef.current.rect = { x: centerX, z: centerZ, w, h, frontSign };
      valid = popRef.current >= spec.unlockPop && orient.frontOk;
    } else {
      const rawW = Math.abs(cx - ax), rawH = Math.abs(cz - az);
      ({ w, h } = clampLotSize(type, rawW, rawH));
      const x0 = cx >= ax ? ax : ax - w, z0 = cz >= az ? az : az - h;
      centerX = x0 + w / 2; centerZ = z0 + h / 2;
      valid = popRef.current >= spec.unlockPop && lotFootprintClear(centerX, centerZ, w, h);
      if (valid) {
        const frontage = findLotFrontage(centerX, centerZ, w, h);
        frontSign = frontage.frontSign;
        valid = frontage.ok;
      }
      dragRef.current.rect = { x: centerX, z: centerZ, w, h, frontSign };
    }
    const y = terrainHeight(centerX, centerZ);
    t.lotPreviewMesh.position.set(centerX, y + 0.55, centerZ);
    t.lotPreviewMesh.scale.set(w * 0.96, 1, h * 0.96);
    t.lotPreviewMesh.material.color.set(valid ? 0x7fe0a8 : 0xe05a4f);
    t.lotPreviewMesh.visible = true;
    dragRef.current.rectValid = valid;
  }, [lotFootprintClear, findLotFrontage, pickTerraceOrientation]);

  // ============ Three.js setup (once) ============
  useEffect(() => {
    const mount = mountRef.current;
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0f1512);
    scene.fog = new THREE.Fog(0x0f1512, 300, 900);

    const viewSize = GRID_SIZE * TILE * 0.62;
    const aspect = mount.clientWidth / mount.clientHeight || 1;
    const camera = new THREE.OrthographicCamera((-viewSize * aspect) / 2, (viewSize * aspect) / 2, viewSize / 2, -viewSize / 2, 0.1, 3000);
    const CAM_DIST = GRID_SIZE * TILE * 0.9;
    const CAM_ELEV = Math.atan2(1.1, Math.SQRT2);
    camera.position.set(CAM_DIST * 0.5586, CAM_DIST * 0.6141, CAM_DIST * 0.5586);
    camera.lookAt(0, 0, 0);

    const driverCamera = new THREE.PerspectiveCamera(70, aspect, 0.1, 2000);

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    mount.appendChild(renderer.domElement);

    scene.add(new THREE.HemisphereLight(0x8fb8c8, 0x1a2018, 0.8));
    scene.add(new THREE.AmbientLight(0x405048, 0.5));
    const sun = new THREE.DirectionalLight(0xfff4dd, 1.6);
    sun.position.set(GRID_SIZE * TILE * 0.5, GRID_SIZE * TILE * 0.9, GRID_SIZE * TILE * 0.25);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const se = GRID_SIZE * TILE * 0.65;
    Object.assign(sun.shadow.camera, { left: -se, right: se, top: se, bottom: -se, far: GRID_SIZE * TILE * 3 });
    sun.shadow.bias = -0.0015;
    scene.add(sun); scene.add(sun.target);

    const groundGeo = new THREE.PlaneGeometry(GRID_SIZE * TILE, GRID_SIZE * TILE);
    groundGeo.rotateX(-Math.PI / 2);
    // terrainHeight() is flat (0) today, so this loop is a no-op — but the vertices are now
    // wired through it so a future non-flat terrainHeight() only has to change that one function.
    {
      const posAttr = groundGeo.attributes.position;
      for (let i = 0; i < posAttr.count; i++) {
        const vx = posAttr.getX(i);
        const vz = posAttr.getZ(i);
        posAttr.setY(i, terrainHeight(vx, vz));
      }
      posAttr.needsUpdate = true;
      groundGeo.computeVertexNormals();
    }
    const ground = new THREE.Mesh(groundGeo, new THREE.MeshStandardMaterial({ map: makeCheckerTexture(), roughness: 1 }));
    ground.receiveShadow = true;
    scene.add(ground);

    // Ground plane used for pointer raycasts — offset by terrainHeight(0,0) (currently 0) instead
    // of a bare literal 0, so this stays correct once terrain has real elevation at the origin.
    const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -terrainHeight(0, 0));
    const dummy = new THREE.Object3D();
    const wheelDummy = new THREE.Object3D();

    // ---- Free Road Network rendering (World Space, Prompt 3) — additive group, separate from
    // the tile hub/arm InstancedMeshes below. One real Mesh per RoadSegment (segments are rare
    // relative to tiles, so per-segment Meshes are fine — no InstancedMesh batching needed here).
    const freeRoadGroup = new THREE.Group();
    freeRoadGroup.name = 'freeRoadGroup';
    scene.add(freeRoadGroup);
    const freeRoadMaterialCache = {};
    function freeRoadMaterialFor(roadType) {
      const rt = ROAD_TYPES[roadType];
      if (!freeRoadMaterialCache[roadType]) {
        freeRoadMaterialCache[roadType] = new THREE.MeshStandardMaterial({ color: rt.color, roughness: rt.unpaved ? 1 : 0.9 });
      }
      return freeRoadMaterialCache[roadType];
    }
    function rebuildFreeRoadSegmentMesh(segment) {
      const existing = freeRoadGroup.getObjectByName(segment.id);
      if (existing) { freeRoadGroup.remove(existing); existing.geometry.dispose(); }
      const geo = buildRoadSegmentGeometry(roadNetworkRef.current, segment);
      const mesh = new THREE.Mesh(geo, freeRoadMaterialFor(segment.roadType));
      mesh.name = segment.id;
      mesh.receiveShadow = true;
      mesh.castShadow = false;
      freeRoadGroup.add(mesh);
    }
    function removeFreeRoadSegmentMesh(segmentId) {
      const existing = freeRoadGroup.getObjectByName(segmentId);
      if (existing) { freeRoadGroup.remove(existing); existing.geometry.dispose(); }
    }
    // Preview group: the in-progress draft (start marker + live curve ribbon) while the
    // 'freeroad' tool is drawing. Rebuilt every pointer-move / K,L,O,M press, never persisted.
    const freeRoadPreviewGroup = new THREE.Group();
    freeRoadPreviewGroup.name = 'freeRoadPreviewGroup';
    scene.add(freeRoadPreviewGroup);
    const freeRoadPreviewMat = new THREE.MeshBasicMaterial({ color: 0x6ad0ff, transparent: true, opacity: 0.55, depthWrite: false });
    const freeRoadNodeMarkerGeo = new THREE.SphereGeometry(TILE * 0.18, 12, 10);
    const freeRoadNodeMarkerMat = new THREE.MeshBasicMaterial({ color: 0x6ad0ff });
    function clearFreeRoadPreview() {
      while (freeRoadPreviewGroup.children.length) {
        const c = freeRoadPreviewGroup.children.pop();
        // freeRoadNodeMarkerGeo is a shared, reusable geometry (used for every start-node marker) —
        // never dispose it here, only the per-preview ribbon geometries built fresh each update.
        if (c.geometry && c.geometry !== freeRoadNodeMarkerGeo) c.geometry.dispose();
      }
    }
    // -- draft lifecycle: start / update / curve+elevation adjust / finalize / cancel --
    // Curve is expressed as a signed "bend" in world units: the quadratic-bezier control point is
    // placed at the segment midpoint, offset sideways (along the midpoint's perpendicular) by
    // `bend`. bend=0 is a perfectly straight segment (curve:null).
    const FREE_ROAD_CURVE_STEP = TILE * 0.35;
    const FREE_ROAD_CURVE_MAX = TILE * 6;
    const FREE_ROAD_ELEV_STEP = 0.5;
    const FREE_ROAD_ELEV_MAX = 12;
    function draftPreviewSegment() {
      const d = freeRoadDraftRef.current;
      if (!d) return null;
      // Build a throwaway network containing just the two draft-preview nodes, so the SAME
      // getRoadPoint/getRoadTangent/getRoadNormal/buildRoadSegmentGeometry used for real,
      // finalized segments also drives the live preview — no separate preview-only math to drift.
      const previewNet = { nodes: new Map(), segments: new Map(), intersections: new Map() };
      const startNode = { id: 'draft_start', position: d.startPos, connectedSegmentIds: [] };
      const endNode = { id: 'draft_end', position: d.endPreviewPos, connectedSegmentIds: [] };
      previewNet.nodes.set(startNode.id, startNode);
      previewNet.nodes.set(endNode.id, endNode);
      const mx = (d.startPos.x + d.endPreviewPos.x) / 2, mz = (d.startPos.z + d.endPreviewPos.z) / 2;
      const dx = d.endPreviewPos.x - d.startPos.x, dz = d.endPreviewPos.z - d.startPos.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const curve = Math.abs(d.curveBend) > 1e-4
        ? { controlPoint: { x: mx + nx * d.curveBend, y: 0, z: mz + nz * d.curveBend } }
        : null;
      const segment = makeRoadSegment('draft_start', 'draft_end', {
        roadType: freeRoadTypeRef.current,
        curve,
        elevation: { start: d.startElevation, end: d.elevationOffset },
      });
      return { network: previewNet, segment };
    }
    function updateFreeRoadPreview() {
      clearFreeRoadPreview();
      const d = freeRoadDraftRef.current;
      if (!d) return;
      const startMarker = new THREE.Mesh(freeRoadNodeMarkerGeo, freeRoadNodeMarkerMat);
      startMarker.position.set(d.startPos.x, d.startPos.y + 0.2, d.startPos.z);
      freeRoadPreviewGroup.add(startMarker);
      const dist = Math.hypot(d.endPreviewPos.x - d.startPos.x, d.endPreviewPos.z - d.startPos.z);
      if (dist < 0.05) return; // avoid degenerate zero-length preview geometry
      const { network, segment } = draftPreviewSegment();
      const geo = buildRoadSegmentGeometry(network, segment, 24);
      const ribbon = new THREE.Mesh(geo, freeRoadPreviewMat);
      freeRoadPreviewGroup.add(ribbon);
    }
    function startFreeRoadDraft(point) {
      const y = terrainHeight(point.x, point.z);
      freeRoadDraftRef.current = {
        startPos: { x: point.x, y, z: point.z },
        startElevation: freeRoadDraftRef.current ? freeRoadDraftRef.current.elevationOffset : 0, // chain: continue from previous end height
        endPreviewPos: { x: point.x, y, z: point.z },
        curveBend: 0,
        elevationOffset: freeRoadDraftRef.current ? freeRoadDraftRef.current.elevationOffset : 0,
      };
      updateFreeRoadPreview();
    }
    function updateFreeRoadDraftEnd(point) {
      const d = freeRoadDraftRef.current;
      if (!d) return;
      d.endPreviewPos = { x: point.x, y: terrainHeight(point.x, point.z), z: point.z };
      updateFreeRoadPreview();
    }
    function adjustFreeRoadCurve(sign) {
      const d = freeRoadDraftRef.current;
      if (!d) return;
      d.curveBend = Math.max(-FREE_ROAD_CURVE_MAX, Math.min(FREE_ROAD_CURVE_MAX, d.curveBend + sign * FREE_ROAD_CURVE_STEP));
      updateFreeRoadPreview();
    }
    function adjustFreeRoadElevation(sign) {
      const d = freeRoadDraftRef.current;
      if (!d) return;
      d.elevationOffset = Math.max(-FREE_ROAD_ELEV_MAX, Math.min(FREE_ROAD_ELEV_MAX, d.elevationOffset + sign * FREE_ROAD_ELEV_STEP));
      updateFreeRoadPreview();
    }
    function finalizeFreeRoadDraft() {
      const d = freeRoadDraftRef.current;
      if (!d) return;
      const dist = Math.hypot(d.endPreviewPos.x - d.startPos.x, d.endPreviewPos.z - d.startPos.z);
      if (dist < 0.05) { cancelFreeRoadDraft(); return; } // ignore an accidental zero-length click
      const network = roadNetworkRef.current;
      const startNode = addRoadNodeToNetwork(network, makeRoadNode(d.startPos.x, d.startPos.y, d.startPos.z));
      const endNode = addRoadNodeToNetwork(network, makeRoadNode(d.endPreviewPos.x, d.endPreviewPos.y, d.endPreviewPos.z));
      const mx = (d.startPos.x + d.endPreviewPos.x) / 2, mz = (d.startPos.z + d.endPreviewPos.z) / 2;
      const dx = d.endPreviewPos.x - d.startPos.x, dz = d.endPreviewPos.z - d.startPos.z;
      const len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len, nz = dx / len;
      const curve = Math.abs(d.curveBend) > 1e-4
        ? { controlPoint: { x: mx + nx * d.curveBend, y: 0, z: mz + nz * d.curveBend } }
        : null;
      const segment = addRoadSegmentToNetwork(network, makeRoadSegment(startNode.id, endNode.id, {
        roadType: freeRoadTypeRef.current,
        curve,
        elevation: { start: d.startElevation, end: d.elevationOffset },
      }));
      rebuildFreeRoadSegmentMesh(segment);
      rebuildRoadsideLandOverlay();
      // Chain: immediately continue drawing from the just-placed end node, like the existing
      // drag-to-paint tile road tools — Escape (or switching tool) stops the chain.
      startFreeRoadDraft(d.endPreviewPos);
    }
    function cancelFreeRoadDraft() {
      freeRoadDraftRef.current = null;
      clearFreeRoadPreview();
    }

    // ---- Roadside Land / Parcel overlay (Prompt 4) — visualizes createParcelAlongFrontage()'s
    // 8 distance bands on both sides of every free RoadSegment, proving the query layer follows
    // curves, respects the road's real paved footprint, and leaves buildable land next to even
    // the widest (8-lane/median/highway) road types. Rebuilt whenever the free road network
    // changes; toggled via showRoadsideLandRef (see the UI button).
    const roadsideLandGroup = new THREE.Group();
    roadsideLandGroup.name = 'roadsideLandGroup';
    roadsideLandGroup.visible = false;
    scene.add(roadsideLandGroup);
    const roadsideLandMatCache = {};
    function roadsideLandMaterialForBand(band) {
      if (!roadsideLandMatCache[band]) {
        // near-road bands read warm/green, far bands cool toward blue — purely a readability aid
        // for confirming which band is which; has no effect on buildability itself.
        const t = (band - 1) / (ROADSIDE_BAND_COUNT - 1);
        const color = new THREE.Color().setHSL(0.33 - t * 0.05, 0.55, 0.35 + t * 0.25);
        roadsideLandMatCache[band] = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.4, depthWrite: false });
      }
      return roadsideLandMatCache[band];
    }
    function polygonToFlatGeometry(polygon, y) {
      // polygon is [...innerEdge, ...outerEdge.reversed] from createParcelAlongFrontage — a
      // simple non-self-intersecting quad-strip loop, fan-triangulated from vertex 0.
      const positions = [];
      for (let i = 1; i < polygon.length - 1; i++) {
        positions.push(polygon[0].x, y, polygon[0].z);
        positions.push(polygon[i].x, y, polygon[i].z);
        positions.push(polygon[i + 1].x, y, polygon[i + 1].z);
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
      geo.computeVertexNormals();
      return geo;
    }
    function rebuildRoadsideLandOverlay() {
      while (roadsideLandGroup.children.length) {
        const c = roadsideLandGroup.children.pop();
        c.geometry.dispose();
      }
      landParcelsRef.current.clear();
      const network = roadNetworkRef.current;
      for (const segment of network.segments.values()) {
        for (const side of ['left', 'right']) {
          for (let band = 1; band <= ROADSIDE_BAND_COUNT; band++) {
            const parcel = createParcelAlongFrontage(network, segment.id, side, band);
            if (!parcel) continue;
            landParcelsRef.current.set(parcel.id, parcel);
            const y = terrainHeight(0, 0) + 0.01 + band * 0.001; // tiny per-band lift so band edges don't z-fight
            const geo = polygonToFlatGeometry(parcel.polygon, y);
            const mesh = new THREE.Mesh(geo, roadsideLandMaterialForBand(band));
            mesh.name = parcel.id;
            roadsideLandGroup.add(mesh);
          }
        }
      }
    }

    // ---- roads: sidewalk base -> curb rim -> asphalt hub/arms (auto-tiling via rotation) ----
    // Vertical stack is sidewalk (bottom) -> curb -> asphalt (top); see the ROAD_Y/CURB_Y block
    // near the top of the file for why. Every road-surface mesh below is built and positioned
    // from that shared stack so the asphalt is always visibly above and narrower than the
    // sidewalk, with a curb rim visible in between.
    const roadSideMat = new THREE.MeshStandardMaterial({ color: 0x1e2124, roughness: 0.95 });
    const sidewalkTopMat = new THREE.MeshStandardMaterial({ map: makePavementTexture(), roughness: 1 });
    const sidewalkGeo = new THREE.BoxGeometry(TILE * 0.98, SIDEWALK_H, TILE * 0.98);
    const sidewalkMesh = new THREE.InstancedMesh(sidewalkGeo, [roadSideMat, roadSideMat, sidewalkTopMat, roadSideMat, roadSideMat, roadSideMat], ROAD_TILE_CAP);
    sidewalkMesh.receiveShadow = true; scene.add(sidewalkMesh);

    // Each road type gets its OWN hub/arm/curb geometry sized to its real width (rather than one
    // shared geometry rescaled per-instance). This lets the arm length be computed exactly as
    // "distance from this type's asphalt edge to the tile boundary", so a run of same-type road
    // tiles has its hub+arm+hub+arm meet edge-to-edge with no gap and no overlap — that seam-free
    // join, together with the shared paint layout in drawRoadPaint(), is what turns a chain of
    // separate tile squares into one continuous-looking road instead of a strip of tiles.
    const hubGeoByType = {}, hubGeoSquareByType = {}, armGeoByType = {}, armDepthByType = {};
    const armGeoShortByType = {}, taperHalfByType = {};
    const curbHubGeoByType = {}, curbArmGeoByType = {};
    ROAD_TYPE_KEYS.forEach((key) => {
      const { rhw, curbHalf } = roadHalfWidth(ROAD_TYPES[key].hubMul);
      // the hub square's length along the travel direction (z) must never exceed one tile —
      // only its width (x) should grow with wide road types. Capping hubDepth here (instead of
      // always using the full rhw*2 square) is what keeps 2+ tile wide roads from bleeding their
      // pavement into the neighboring tile lengthwise on straight runs AND on curves, which both
      // share this same geometry.
      const hubDepth = Math.min(rhw * 2, TILE);
      const armDepth = Math.max(0.05, TILE / 2 - hubDepth / 2); // reaches exactly to the tile edge
      armDepthByType[key] = armDepth;
      // how much of THIS type's arm gets carved off its outer end to make room for a taper
      // connector where it meets a different road type — never more than half the arm itself.
      const taperHalf = Math.min(ROAD_TAPER_HALF, armDepth * 0.5);
      taperHalfByType[key] = taperHalf;

      const hubGeo = new THREE.BoxGeometry(rhw * 2, ROAD_H, hubDepth);
      hubGeoByType[key] = hubGeo;
      // SQUARE hub variant — used ONLY for hub shapes that are never rotated to match a specific
      // travel direction (curves, T-junctions, crossroads, dead-ends; see syncInstances, which
      // always places these with rotation (0,0,0)). The straight-run hub above deliberately clamps
      // its length along local Z to one tile (see hubDepth), so its "extra width" for a 4+/6+/8-
      // lane road only ever grows along local X. That's fine for a straight tile because it gets
      // rotated per axis — but curve/T/cross/dead-end tiles are NEVER rotated, so with the clamped
      // geometry the widening panel was always baked onto world X regardless of which way the road
      // actually bent, producing a hugely stretched, elliptical patch of pavement whenever a wide
      // road's turn happened to line up with that fixed axis (reported bug: extending a wide road
      // curve east-west makes the pavement balloon outward). Making this hub perfectly square
      // (rhw*2 in BOTH directions) removes the preferred axis entirely, so the curve/T/cross tile
      // is correctly wide on every side no matter which way it connects.
      const hubGeoSquare = new THREE.BoxGeometry(rhw * 2, ROAD_H, rhw * 2);
      hubGeoSquareByType[key] = hubGeoSquare;
      const armGeo = new THREE.BoxGeometry(rhw * 2, ROAD_H, armDepth);
      armGeo.translate(0, 0, hubDepth / 2 + armDepth / 2);
      armGeoByType[key] = armGeo;
      // shortened variant: identical near edge (still meets the hub at `rhw`), but stops
      // `taperHalf` short of the tile edge — used only on the side(s) of a tile that border a
      // different road type, so a taper connector (see makeTaperPrismGeometry) can fill the gap
      // with a smoothly-blending width instead of the two full-width arms meeting edge-to-edge.
      const shortDepth = Math.max(0.02, armDepth - taperHalf);
      const armGeoShort = new THREE.BoxGeometry(rhw * 2, ROAD_H, shortDepth);
      armGeoShort.translate(0, 0, hubDepth / 2 + shortDepth / 2);
      armGeoShortByType[key] = armGeoShort;

      // curb: a shorter, slightly wider slab sitting directly under the asphalt so its rim peeks
      // out on every side — this rim (plus the color change to each type's `shoulder` tone) is
      // the visible boundary between "this is sidewalk" and "this is road". Its length (z) is
      // capped the same way as the asphalt hub above, for the same reason.
      const curbHubDepth = Math.min(curbHalf * 2, TILE);
      const curbHubGeo = new THREE.BoxGeometry(curbHalf * 2, CURB_H, curbHubDepth);
      curbHubGeoByType[key] = curbHubGeo;
      const curbArmGeo = new THREE.BoxGeometry(curbHalf * 2, CURB_H, armDepth);
      curbArmGeo.translate(0, 0, hubDepth / 2 + armDepth / 2);
      curbArmGeoByType[key] = curbArmGeo;
    });

    // ---- road-type taper connectors: one small trapezoid piece per ordered pair of different
    // road types, dropped in at a tile boundary wherever two different-width road types meet, so
    // the pavement blends from one width to the other instead of jumping. Only ONE material
    // (double-sided, solid color blended from both types) is used per pair — this is a short
    // transition piece, not a fully lane-painted tile, so it doesn't need its own dashed texture.
    const taperMeshes = {}; // key: "`${fromKey}_${toKey}`"
    ROAD_TYPE_KEYS.forEach((fromKey) => {
      ROAD_TYPE_KEYS.forEach((toKey) => {
        if (fromKey === toKey) return;
        const { rhw: rhwFrom } = roadHalfWidth(ROAD_TYPES[fromKey].hubMul);
        const { rhw: rhwTo } = roadHalfWidth(ROAD_TYPES[toKey].hubMul);
        const taperFrom = taperHalfByType[fromKey], taperTo = taperHalfByType[toKey];
        const len = Math.max(0.04, taperFrom + taperTo);
        const geo = makeTaperPrismGeometry(rhwFrom, rhwTo, len, ROAD_H);
        // anchor so local z=0 lands exactly where `fromKey`'s shortened arm ends (TILE/2 -
        // taperFrom out from the tile center) — matching the same "outward from hub" convention
        // armGeo itself already uses, so this can be placed with the SAME position/rotation
        // pushArm uses for that compass direction.
        geo.translate(0, 0, TILE / 2 - taperFrom);
        const cA = new THREE.Color(ROAD_TYPES[fromKey].color);
        const cB = new THREE.Color(ROAD_TYPES[toKey].color);
        const mat = new THREE.MeshStandardMaterial({
          color: new THREE.Color((cA.r + cB.r) / 2, (cA.g + cB.g) / 2, (cA.b + cB.b) / 2),
          roughness: 0.9, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        const mesh = new THREE.InstancedMesh(geo, mat, ARM_CAP);
        mesh.receiveShadow = true; scene.add(mesh);
        taperMeshes[`${fromKey}_${toKey}`] = mesh;
      });
    });

    // hubThroughMeshesFlip / armPlainMeshesFlip only get populated for road types with 3+ lanes
    // (see `multiLane` below) — they hold the mirror-image lane texture (2-lane group + 1-lane
    // group swapped sides) used wherever a tile's stored flip bit says "flip". Two/small/dirt
    // never touch these (their paint is left-right symmetric, so no mirror is ever needed).
    const hubThroughMeshes = {}, hubThroughMeshesFlip = {}, hubPlainMeshes = {}, armPlainMeshes = {}, armPlainMeshesFlip = {}, armStopMeshes = {};
    const armPlainShortMeshes = {};
    const curbHubMeshes = {}, curbArmMeshes = {};
    // curve (NODE_CURVE) and dead-end (NODE_DEADEND) hub tiles get their own baked-orientation
    // texture set (see makeAsphaltCurveTexture / makeAsphaltDeadEndTexture) instead of falling
    // back to the blank hubPlainMat slab, so bends and road ends read as designed pavement
    // instead of a flat undecorated square.
    const CURVE_CORNERS = ['ne', 'es', 'sw', 'wn'];
    const DEADEND_SIDES = ['n', 'e', 's', 'w'];
    const hubCurveMeshes = {}, hubCurveMeshesFlip = {}, hubDeadEndMeshes = {};
    ROAD_TYPE_KEYS.forEach((key) => {
      const rt = ROAD_TYPES[key];
      const hubGeo = hubGeoByType[key], hubGeoSquare = hubGeoSquareByType[key], armGeo = armGeoByType[key];
      const hubLen = hubGeo.parameters.depth; // = rhw*2, the physical length the hub-through dashes run across
      const armLen = armDepthByType[key];
      const multiLane = rt.lanes >= 3;
      // 'small' roads are one-way (see oneWayDirRef): they also need a mirrored texture variant
      // — arrows pointing the opposite way — even though they're not multi-lane, so the hub-
      // through and arm textures get a flip variant for them too (curves don't need one: they
      // carry no direction marking either way).
      const needsDirFlip = multiLane || key === 'small';

      const hubThroughMat = new THREE.MeshStandardMaterial({ map: makeAsphaltHubTexture(rt.color, rt.unpaved, true, hubLen, rt, false), roughness: rt.unpaved ? 1 : 0.9 });
      const htMesh = new THREE.InstancedMesh(hubGeo, [roadSideMat, roadSideMat, hubThroughMat, roadSideMat, roadSideMat, roadSideMat], ROAD_TILE_CAP);
      htMesh.receiveShadow = true; scene.add(htMesh); hubThroughMeshes[key] = htMesh;

      if (needsDirFlip) {
        const hubThroughFlipMat = new THREE.MeshStandardMaterial({ map: makeAsphaltHubTexture(rt.color, rt.unpaved, true, hubLen, rt, true), roughness: rt.unpaved ? 1 : 0.9 });
        const htfMesh = new THREE.InstancedMesh(hubGeo, [roadSideMat, roadSideMat, hubThroughFlipMat, roadSideMat, roadSideMat, roadSideMat], ROAD_TILE_CAP);
        htfMesh.receiveShadow = true; scene.add(htfMesh); hubThroughMeshesFlip[key] = htfMesh;
      }

      const hubPlainMat = new THREE.MeshStandardMaterial({ map: makeAsphaltHubTexture(rt.color, rt.unpaved, false), roughness: rt.unpaved ? 1 : 0.9 });
      const hpMesh = new THREE.InstancedMesh(hubGeoSquare, [roadSideMat, roadSideMat, hubPlainMat, roadSideMat, roadSideMat, roadSideMat], ROAD_TILE_CAP);
      hpMesh.receiveShadow = true; scene.add(hpMesh); hubPlainMeshes[key] = hpMesh;

      hubCurveMeshes[key] = {};
      hubCurveMeshesFlip[key] = {};
      CURVE_CORNERS.forEach((corner) => {
        const curveMat = new THREE.MeshStandardMaterial({ map: makeAsphaltCurveTexture(rt.color, rt.unpaved, corner, rt, false), roughness: rt.unpaved ? 1 : 0.9 });
        const cMesh = new THREE.InstancedMesh(hubGeoSquare, [roadSideMat, roadSideMat, curveMat, roadSideMat, roadSideMat, roadSideMat], ROAD_TILE_CAP);
        cMesh.receiveShadow = true; scene.add(cMesh); hubCurveMeshes[key][corner] = cMesh;
        // 3+ lane curves also need the mirrored lane layout (matches threeLaneDirRef's flip bit,
        // same as the straight hubThroughMeshesFlip set) so a bend doesn't silently reset which
        // side carries the 2-lane group.
        if (multiLane) {
          const curveMatFlip = new THREE.MeshStandardMaterial({ map: makeAsphaltCurveTexture(rt.color, rt.unpaved, corner, rt, true), roughness: rt.unpaved ? 1 : 0.9 });
          const cfMesh = new THREE.InstancedMesh(hubGeoSquare, [roadSideMat, roadSideMat, curveMatFlip, roadSideMat, roadSideMat, roadSideMat], ROAD_TILE_CAP);
          cfMesh.receiveShadow = true; scene.add(cfMesh); hubCurveMeshesFlip[key][corner] = cfMesh;
        }
      });

      hubDeadEndMeshes[key] = {};
      DEADEND_SIDES.forEach((side) => {
        const deMat = new THREE.MeshStandardMaterial({ map: makeAsphaltDeadEndTexture(rt.color, rt.unpaved, side), roughness: rt.unpaved ? 1 : 0.9 });
        const deMesh = new THREE.InstancedMesh(hubGeoSquare, [roadSideMat, roadSideMat, deMat, roadSideMat, roadSideMat, roadSideMat], ROAD_TILE_CAP);
        deMesh.receiveShadow = true; scene.add(deMesh); hubDeadEndMeshes[key][side] = deMesh;
      });

      // arm materials get a slight camera-ward polygon offset so their top face never sits
      // exactly coplanar with the abutting hub tile's top face at the shared tile-edge seam —
      // without this, two coplanar faces meeting at that seam z-fight (flicker/blur) as the
      // camera moves, which is what made road-to-road joints look blurry.
      const armDashMat = new THREE.MeshStandardMaterial({ map: makeArmDashTexture(rt.color, rt.unpaved, armLen, rt, false), roughness: rt.unpaved ? 1 : 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const pMesh = new THREE.InstancedMesh(armGeo, [roadSideMat, roadSideMat, armDashMat, roadSideMat, roadSideMat, roadSideMat], ARM_CAP);
      pMesh.receiveShadow = true; scene.add(pMesh); armPlainMeshes[key] = pMesh;

      // shortened counterpart of the mesh above — same texture/material, just stops short of the
      // tile edge (see armGeoShortByType) so a taper connector piece can fill the remaining gap
      // where this side of the tile borders a different road type.
      const psMesh = new THREE.InstancedMesh(armGeoShortByType[key], [roadSideMat, roadSideMat, armDashMat, roadSideMat, roadSideMat, roadSideMat], ARM_CAP);
      psMesh.receiveShadow = true; scene.add(psMesh); armPlainShortMeshes[key] = psMesh;

      if (needsDirFlip) {
        const armDashFlipMat = new THREE.MeshStandardMaterial({ map: makeArmDashTexture(rt.color, rt.unpaved, armLen, rt, true), roughness: rt.unpaved ? 1 : 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
        const pfMesh = new THREE.InstancedMesh(armGeo, [roadSideMat, roadSideMat, armDashFlipMat, roadSideMat, roadSideMat, roadSideMat], ARM_CAP);
        pfMesh.receiveShadow = true; scene.add(pfMesh); armPlainMeshesFlip[key] = pfMesh;
      }

      const armStopMat = new THREE.MeshStandardMaterial({ map: makeArmStopTexture(rt.color, rt.unpaved), roughness: rt.unpaved ? 1 : 0.9, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 });
      const sMesh = new THREE.InstancedMesh(armGeo, [roadSideMat, roadSideMat, armStopMat, roadSideMat, roadSideMat, roadSideMat], ARM_CAP);
      sMesh.receiveShadow = true; scene.add(sMesh); armStopMeshes[key] = sMesh;

      const curbMat = new THREE.MeshStandardMaterial({ color: rt.shoulder, roughness: 0.95 });
      const chMesh = new THREE.InstancedMesh(curbHubGeoByType[key], curbMat, ROAD_TILE_CAP);
      chMesh.receiveShadow = true; scene.add(chMesh); curbHubMeshes[key] = chMesh;
      const curbArmMat = curbMat.clone();
      curbArmMat.polygonOffset = true; curbArmMat.polygonOffsetFactor = -1; curbArmMat.polygonOffsetUnits = -1;
      const caMesh = new THREE.InstancedMesh(curbArmGeoByType[key], curbArmMat, ARM_CAP);
      caMesh.receiveShadow = true; scene.add(caMesh); curbArmMeshes[key] = caMesh;
    });

    const gateGeo = new THREE.ConeGeometry(TILE * 0.22, TILE * 0.9, 6);
    gateGeo.translate(0, TILE * 0.45, 0); // cone base sits at local y=0; final world height comes from dummy.position.y (= ROAD_TOP_Y) in syncInstances
    const gateMesh = new THREE.InstancedMesh(gateGeo, new THREE.MeshStandardMaterial({ color: 0x7fe0e0, emissive: 0x2fa0a0, emissiveIntensity: 0.8, roughness: 0.4 }), 256);
    gateMesh.castShadow = true;
    scene.add(gateMesh);

    // ---- traffic signals (placed at NODE_CROSS and NODE_T intersections; one pole per corner, so a
    // 4-way gets 4 heads — two facing each axis — and a T-junction gets one at each of its corners) ----
    // Real 3-light signal head: a dark housing box with three stacked circular lenses (red top,
    // yellow middle, green bottom). All three lenses always exist; the inactive ones just sit at
    // SIGNAL_UNLIT_INTENSITY (dark) instead of disappearing, like a real unlit signal lamp.
    const signalPoleGeo = new THREE.CylinderGeometry(0.06, 0.06, 1.6, 6);
    signalPoleGeo.translate(0, 0.8, 0);
    const signalHousingGeo = new THREE.BoxGeometry(0.26, 0.62, 0.16);
    signalHousingGeo.translate(0, 1.6, 0);
    const signalPoleMat = new THREE.MeshStandardMaterial({ color: 0x2a2a2a, roughness: 0.8 });
    const signalHousingMat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
    const lensGeo = (yOff) => { const g = new THREE.SphereGeometry(0.085, 8, 8); g.translate(0, 1.6 + yOff, 0.09); return g; };
    const signalRedGeo = lensGeo(0.19);
    const signalYellowGeo = lensGeo(0);
    const signalGreenGeo = lensGeo(-0.19);
    const mkLensMat = (color) => new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: SIGNAL_UNLIT_INTENSITY, roughness: 0.35 });
    const signalNSRedMat = mkLensMat(SIGNAL_RED_COLOR);
    const signalNSYellowMat = mkLensMat(SIGNAL_YELLOW_COLOR);
    const signalNSGreenMat = mkLensMat(SIGNAL_GREEN_COLOR);
    const signalEWRedMat = mkLensMat(SIGNAL_RED_COLOR);
    const signalEWYellowMat = mkLensMat(SIGNAL_YELLOW_COLOR);
    const signalEWGreenMat = mkLensMat(SIGNAL_GREEN_COLOR);
    const signalPoleMesh = new THREE.InstancedMesh(signalPoleGeo, signalPoleMat, SIGNAL_CAP * 4);
    const signalHousingMesh = new THREE.InstancedMesh(signalHousingGeo, signalHousingMat, SIGNAL_CAP * 4);
    const signalNSRedMesh = new THREE.InstancedMesh(signalRedGeo, signalNSRedMat, SIGNAL_CAP * 2);
    const signalNSYellowMesh = new THREE.InstancedMesh(signalYellowGeo, signalNSYellowMat, SIGNAL_CAP * 2);
    const signalNSGreenMesh = new THREE.InstancedMesh(signalGreenGeo, signalNSGreenMat, SIGNAL_CAP * 2);
    const signalEWRedMesh = new THREE.InstancedMesh(signalRedGeo, signalEWRedMat, SIGNAL_CAP * 2);
    const signalEWYellowMesh = new THREE.InstancedMesh(signalYellowGeo, signalEWYellowMat, SIGNAL_CAP * 2);
    const signalEWGreenMesh = new THREE.InstancedMesh(signalGreenGeo, signalEWGreenMat, SIGNAL_CAP * 2);
    signalPoleMesh.castShadow = true;
    scene.add(signalPoleMesh); scene.add(signalHousingMesh);
    scene.add(signalNSRedMesh); scene.add(signalNSYellowMesh); scene.add(signalNSGreenMesh);
    scene.add(signalEWRedMesh); scene.add(signalEWYellowMesh); scene.add(signalEWGreenMesh);

    // ---- direction signs for one-way 'small' roads: a small blue arrow sign planted beside the
    // road every 4 tiles (see the `(tx + ty) % 4 === 0` placement below), so which way the
    // one-way street runs is obvious from beside it instead of only from the faint arrows painted
    // on the asphalt itself. ----
    const dirSignPoleGeo = new THREE.CylinderGeometry(0.035, 0.035, 1.0, 6);
    dirSignPoleGeo.translate(0, 0.5, 0);
    const dirSignPoleMat = new THREE.MeshStandardMaterial({ color: 0x3a3a3a, roughness: 0.8 });
    const dirSignBoardGeo = new THREE.PlaneGeometry(0.62, 0.62);
    dirSignBoardGeo.rotateX(-Math.PI / 2);
    dirSignBoardGeo.translate(0, 1.02, 0);
    const dirSignTexture = (() => {
      const canvas = document.createElement('canvas');
      canvas.width = 64; canvas.height = 64;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#2f6fd8'; ctx.fillRect(0, 0, 64, 64);
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4; ctx.strokeRect(3, 3, 58, 58);
      ctx.fillStyle = '#ffffff';
      ctx.beginPath();
      ctx.moveTo(32, 10); ctx.lineTo(50, 34); ctx.lineTo(38, 34); ctx.lineTo(38, 54); ctx.lineTo(26, 54); ctx.lineTo(26, 34); ctx.lineTo(14, 34);
      ctx.closePath(); ctx.fill();
      return new THREE.CanvasTexture(canvas);
    })();
    const dirSignBoardMat = new THREE.MeshBasicMaterial({ map: dirSignTexture, side: THREE.DoubleSide });
    const dirSignPoleMesh = new THREE.InstancedMesh(dirSignPoleGeo, dirSignPoleMat, ROAD_TILE_CAP);
    const dirSignBoardMesh = new THREE.InstancedMesh(dirSignBoardGeo, dirSignBoardMat, ROAD_TILE_CAP);
    dirSignPoleMesh.castShadow = true;
    scene.add(dirSignPoleMesh); scene.add(dirSignBoardMesh);

    const tintGeo = new THREE.BoxGeometry(TILE * 0.96, 0.1, TILE * 0.96);
    const zoneTint = {}, zoneTintDim = {};
    [TILE_RES, TILE_COM, TILE_IND].forEach((z) => {
      const c = ZONE_COLORS[z];
      const tm = new THREE.InstancedMesh(tintGeo, new THREE.MeshStandardMaterial({ color: c.tint, roughness: 1, transparent: true, opacity: 0.55 }), MAX_INSTANCES);
      tm.receiveShadow = true; scene.add(tm); zoneTint[z] = tm;
      const dm = new THREE.InstancedMesh(tintGeo, new THREE.MeshStandardMaterial({ color: c.tintDim, roughness: 1, transparent: true, opacity: 0.55 }), MAX_INSTANCES);
      dm.receiveShadow = true; scene.add(dm); zoneTintDim[z] = dm;
    });

    // ---- buildings: 4 shape variants per zone/level, chosen per-tile by hash ----
    const buildingVariantDefs = {};
    const buildingMeshes = {};
    [TILE_RES, TILE_COM, TILE_IND].forEach((z) => {
      buildingVariantDefs[z] = buildBuildingVariants(z);
      buildingMeshes[z] = instanceVariants(scene, buildingVariantDefs[z], VARIANT_CAP);
    });

    const markerGeo = new THREE.PlaneGeometry(TILE * 0.98, TILE * 0.98);
    markerGeo.rotateX(-Math.PI / 2);
    const hoverMesh = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0x7fe0e0, transparent: true, opacity: 0.3, depthWrite: false }));
    hoverMesh.position.y = ROAD_TOP_Y + 0.05; hoverMesh.visible = false; scene.add(hoverMesh);
    const selectMesh = new THREE.Mesh(markerGeo, new THREE.MeshBasicMaterial({ color: 0x7fe0e0, transparent: true, opacity: 0.18, depthWrite: false }));
    selectMesh.position.y = ROAD_TOP_Y + 0.02; selectMesh.visible = false; scene.add(selectMesh);
    const carSelectMesh = new THREE.Mesh(new THREE.RingGeometry(1.3, 1.6, 16), new THREE.MeshBasicMaterial({ color: 0xffd35a, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    carSelectMesh.rotateX(-Math.PI / 2);
    carSelectMesh.visible = false;
    scene.add(carSelectMesh);
    const pedSelectMesh = new THREE.Mesh(new THREE.RingGeometry(0.5, 0.66, 16), new THREE.MeshBasicMaterial({ color: 0x7fe0e0, transparent: true, opacity: 0.85, depthWrite: false, side: THREE.DoubleSide }));
    pedSelectMesh.rotateX(-Math.PI / 2);
    pedSelectMesh.visible = false;
    scene.add(pedSelectMesh);
    const lotPreviewGeo = new THREE.PlaneGeometry(1, 1);
    lotPreviewGeo.rotateX(-Math.PI / 2);
    const lotPreviewMesh = new THREE.Mesh(lotPreviewGeo, new THREE.MeshBasicMaterial({ color: 0x7fe0a8, transparent: true, opacity: 0.35, depthWrite: false }));
    lotPreviewMesh.visible = false;
    scene.add(lotPreviewMesh);

    // ---- pollution overlay (Phase 2) ----
    // one shared flat-quad InstancedMesh, per-instance vertex color, count/matrix/color rebuilt
    // by syncPollutionOverlay() whenever computePollution() runs — not every frame.
    const pollutionGeo = new THREE.PlaneGeometry(TILE * 0.92, TILE * 0.92);
    pollutionGeo.rotateX(-Math.PI / 2);
    const pollutionMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.55, depthWrite: false });
    const pollutionMesh = new THREE.InstancedMesh(pollutionGeo, pollutionMat, ROAD_TILE_CAP);
    pollutionMesh.count = 0;
    pollutionMesh.visible = false;
    scene.add(pollutionMesh);

    // ---- industry suitability overlay (Phase 3) — road tiles only, shown while the
    // industrial zone tool is selected. Same InstancedMesh-of-quads technique as pollution.
    const suitGeo = new THREE.PlaneGeometry(TILE * 0.86, TILE * 0.86);
    suitGeo.rotateX(-Math.PI / 2);
    const suitMat = new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.6, depthWrite: false });
    const suitabilityMesh = new THREE.InstancedMesh(suitGeo, suitMat, ROAD_TILE_CAP);
    suitabilityMesh.count = 0;
    suitabilityMesh.visible = false;
    scene.add(suitabilityMesh);

    // ---- cargo hub markers (Phase 6) ----
    const hubGeo = new THREE.CylinderGeometry(TILE * 0.32, TILE * 0.38, TILE * 0.5, 6);
    hubGeo.translate(0, TILE * 0.25, 0);
    const hubMat = new THREE.MeshStandardMaterial({ color: 0xd9a441, roughness: 0.5, metalness: 0.2 });
    const hubMesh = new THREE.InstancedMesh(hubGeo, hubMat, 128);
    hubMesh.count = 0;
    scene.add(hubMesh);

    // ---- vehicles: several distinct kinds, each with wheels + a seated driver ----
    const vehicleKinds = KIND_SPECS.map((spec) => buildKindMeshes(scene, spec));
    const spawnPool = [];
    KIND_SPECS.forEach((spec, ki) => { for (let n = 0; n < Math.round(spec.weight); n++) spawnPool.push(ki); });
    const randomKindIdx = () => spawnPool[Math.floor(Math.random() * spawnPool.length)];

    const wheelGeo = new THREE.CylinderGeometry(1, 1, 1, 10);
    wheelGeo.rotateZ(Math.PI / 2);
    const wheelMesh = new THREE.InstancedMesh(wheelGeo, new THREE.MeshStandardMaterial({ color: 0x16171a, roughness: 0.9 }), (NUM_CARS + 2) * 4);
    wheelMesh.castShadow = true; scene.add(wheelMesh);

    const allChassisMeshes = vehicleKinds.flatMap((kd) => kd.chassisMeshes);

    // crash marker (bounces above a crashed vehicle or a hit pedestrian)
    const crashGeo = new THREE.OctahedronGeometry(0.55, 0);
    const crashMesh = new THREE.InstancedMesh(crashGeo, new THREE.MeshStandardMaterial({ color: 0xff3a3a, emissive: 0xff2020, emissiveIntensity: 0.9, roughness: 0.4 }), 40);
    scene.add(crashMesh);

    // ---- pedestrians ----
    const pedColors = [0x3a5a8a, 0x8a3a3a, 0x3a8a5a, 0x8a7a3a];
    const pedBodyGeo = new THREE.CylinderGeometry(0.28, 0.36, 1.15, 6);
    pedBodyGeo.translate(0, 0.58, 0);
    const pedHeadGeo = new THREE.SphereGeometry(0.26, 8, 6);
    pedHeadGeo.translate(0, 1.35, 0);
    const pedHeadMesh = new THREE.InstancedMesh(pedHeadGeo, new THREE.MeshStandardMaterial({ color: 0xe0b088, roughness: 0.8 }), NUM_PEDS + 2);
    scene.add(pedHeadMesh);
    const pedBodyMeshes = pedColors.map((col) => {
      const m = new THREE.InstancedMesh(pedBodyGeo, new THREE.MeshStandardMaterial({ color: col, roughness: 0.85 }), NUM_PEDS + 2);
      m.castShadow = true; scene.add(m);
      return m;
    });

    const raycaster = new THREE.Raycaster();

    threeRef.current = {
      scene, camera, driverCamera, renderer, ground, groundPlane, raycaster,
      sidewalkMesh, hubThroughMeshes, hubThroughMeshesFlip, hubPlainMeshes, armPlainMeshes, armPlainMeshesFlip, armStopMeshes, curbHubMeshes, curbArmMeshes, gateMesh, zoneTint, zoneTintDim, buildingMeshes, buildingVariantDefs, dummy,
      hoverMesh, selectMesh, carSelectMesh, pedSelectMesh, lotPreviewMesh, pollutionMesh, suitabilityMesh, hubMesh, sun,
      vehicleKinds, wheelMesh, allChassisMeshes, crashMesh,
      pedBodyMeshes, pedHeadMesh, pedColorsLen: pedColors.length,
      // Free Road Network (World Space, Prompt 3) — see the block above raycaster setup.
      freeRoadGroup, freeRoadPreviewGroup, rebuildFreeRoadSegmentMesh, removeFreeRoadSegmentMesh,
      startFreeRoadDraft, updateFreeRoadDraftEnd, adjustFreeRoadCurve, adjustFreeRoadElevation,
      finalizeFreeRoadDraft, cancelFreeRoadDraft,
      // Roadside Land / Parcel overlay (Prompt 4).
      roadsideLandGroup, rebuildRoadsideLandOverlay,
    };

    const syncInstances = () => {
      const grid = gridRef.current, level = levelRef.current, connected = connectedRef.current;
      const intersectionType = intersectionTypeRef.current;
      const roadType = roadTypeRef.current;
      let sidewalkCount = 0, gateCount = 0;
      let signalPoleCount = 0, signalHousingCount = 0, signalNSCount = 0, signalEWCount = 0;
      let dirSignCount = 0;
      const hubThroughCounts = {}, hubThroughFlipCounts = {}, hubPlainCounts = {}, armPlainCounts = {}, armPlainFlipCounts = {}, armStopCounts = {};
      const armPlainShortCounts = {};
      const taperCounts = {}; // key: "`${fromKey}_${toKey}`"
      const curbHubCounts = {}, curbArmCounts = {};
      const hubCurveCounts = {}, hubCurveFlipCounts = {}, hubDeadEndCounts = {};
      ROAD_TYPE_KEYS.forEach((key) => {
        hubThroughCounts[key] = 0; hubThroughFlipCounts[key] = 0; hubPlainCounts[key] = 0; armPlainCounts[key] = 0; armPlainFlipCounts[key] = 0; armStopCounts[key] = 0; curbHubCounts[key] = 0; curbArmCounts[key] = 0;
        armPlainShortCounts[key] = 0;
        hubCurveCounts[key] = { ne: 0, es: 0, sw: 0, wn: 0 };
        hubCurveFlipCounts[key] = { ne: 0, es: 0, sw: 0, wn: 0 };
        hubDeadEndCounts[key] = { n: 0, e: 0, s: 0, w: 0 };
      });
      ROAD_TYPE_KEYS.forEach((fromKey) => ROAD_TYPE_KEYS.forEach((toKey) => { if (fromKey !== toKey) taperCounts[`${fromKey}_${toKey}`] = 0; }));
      const tintCounts = { [TILE_RES]: 0, [TILE_COM]: 0, [TILE_IND]: 0 };
      const dimCounts = { [TILE_RES]: 0, [TILE_COM]: 0, [TILE_IND]: 0 };
      const buildCounts = {
        [TILE_RES]: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        [TILE_COM]: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
        [TILE_IND]: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
      };

      for (let ty = 0; ty < GRID_SIZE; ty++) for (let tx = 0; tx < GRID_SIZE; tx++) {
        const i = idx(tx, ty);
        const v = grid[i];
        if (v !== TILE_ROAD) intersectionType[i] = NODE_NONE;
        if (v === TILE_EMPTY) continue;
        const wx = tileWorldX(tx), wz = tileWorldZ(ty);

        if (v === TILE_ROAD) {
          const typeKey = ROAD_TYPE_KEYS[roadType[i]] || 'two';
          const hubMul = ROAD_TYPES[typeKey].hubMul;
          // 3+ lane roads render from a mirrored texture/mesh set when this tile's stored flip
          // bit is set (kept for future asymmetric layouts, though the symmetric 4-lane layout
          // itself looks identical either way). 'small' one-way roads use the same mirrored-mesh
          // mechanism, but computed PER ARM DIRECTION from oneWayDirRef's exit bitmask (see
          // dirBit) instead of a single tile-wide bit, since a 'small' tile can have a different
          // exit/entry direction on each of its up to 4 connected sides (e.g. a straight-through
          // tile has one exit side and one entry side, needing opposite arrow orientations).
          const isMultiLane = ROAD_TYPES[typeKey].lanes >= 3;
          const isSmallOneWay = typeKey === 'small';
          const multiLaneFlip = isMultiLane && threeLaneDirRef.current[i] === 1;
          // The sidewalk/ground slab under a road tile defaults to ~1 tile wide (SIDEWALK_HALF).
          // Wide roads (six/six_median/eight_median...) have a real pavement edge (curbHalf) well
          // beyond that on their own — without this, there was no paved surface at all out where
          // pedOffsetForTile now walks pedestrians (see fix there), so they'd visibly be standing
          // on bare terrain, or worse, the walk offset used to get clamped back onto the asphalt
          // instead. Scale this same ground slab out to comfortably cover the real curb line,
          // from the SAME roadHalfWidth() used everywhere else, instead of a second guess at "how
          // wide is this road".
          const { curbHalf: sidewalkCurbHalf } = roadHalfWidth(hubMul);
          const sidewalkScale = Math.max(1, (sidewalkCurbHalf + TILE * 0.12) / SIDEWALK_HALF);
          dummy.position.set(wx, 0, wz); dummy.rotation.set(0, 0, 0); dummy.scale.set(sidewalkScale, 1, sidewalkScale); dummy.updateMatrix();
          sidewalkMesh.setMatrixAt(sidewalkCount++, dummy.matrix);

          const nbN = inBounds(tx, ty - 1) && grid[idx(tx, ty - 1)] === TILE_ROAD;
          const nbE = inBounds(tx + 1, ty) && grid[idx(tx + 1, ty)] === TILE_ROAD;
          const nbS = inBounds(tx, ty + 1) && grid[idx(tx, ty + 1)] === TILE_ROAD;
          const nbW = inBounds(tx - 1, ty) && grid[idx(tx - 1, ty)] === TILE_ROAD;
          const connCount = (nbN ? 1 : 0) + (nbE ? 1 : 0) + (nbS ? 1 : 0) + (nbW ? 1 : 0);

          // node classification: this is the logical graph layer above the raw grid
          let nodeType;
          if (connCount <= 1) nodeType = NODE_DEADEND;
          else if (connCount === 2) nodeType = (nbN && nbS) || (nbE && nbW) ? NODE_STRAIGHT : NODE_CURVE;
          else if (connCount === 3) nodeType = NODE_T;
          else nodeType = NODE_CROSS;
          intersectionType[i] = nodeType;
          const useStopLine = nodeType === NODE_T || nodeType === NODE_CROSS;

          // curb rim, directly under the asphalt hub: every road tile gets one regardless of node
          // type, so the sidewalk/road boundary is always visible even at curves/T/cross tiles.
          dummy.position.set(wx, CURB_Y, wz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          curbHubMeshes[typeKey].setMatrixAt(curbHubCounts[typeKey]++, dummy.matrix);

          // hub slab: a straight through-run gets a dashed centerline rotated to match its axis
          // (default dash art runs N-S, so an E-W straight rotates 90°); a curve gets a baked
          // quarter-circle marking picked for its exact bend (see makeAsphaltCurveTexture); a
          // dead-end gets a baked cap-line marking picked for its single connected side (see
          // makeAsphaltDeadEndTexture); T-junctions and crossroads still get the plain slab,
          // since no single lane axis applies there. Geometry is already sized exactly to this
          // road type's real width, so no per-instance width scale is needed — only the Y
          // position (up on top of the curb) and, for through tiles, the rotation that orients
          // the centerline with the traffic axis (curve/dead-end textures are pre-baked per
          // orientation, so those meshes are never rotated).
          if (nodeType === NODE_STRAIGHT) {
            const isEW = (nbE && nbW);
            const rotY = isEW ? Math.PI / 2 : 0;
            // canvas "+y" (arrows pointing away from the hub) maps, after this rotation, to world
            // east (isEW) or world south (N-S) — see drawDirectionArrows / pushArm below for the
            // same convention applied per-arm.
            const refDir = isEW ? DIR_E : DIR_S;
            const hubFlip = isMultiLane ? multiLaneFlip : isSmallOneWay ? (oneWayDirRef.current[i] & dirBit(refDir)) === 0 : false;
            dummy.position.set(wx, ROAD_Y, wz); dummy.rotation.set(0, rotY, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            if (hubFlip && hubThroughMeshesFlip[typeKey]) hubThroughMeshesFlip[typeKey].setMatrixAt(hubThroughFlipCounts[typeKey]++, dummy.matrix);
            else hubThroughMeshes[typeKey].setMatrixAt(hubThroughCounts[typeKey]++, dummy.matrix);
          } else if (nodeType === NODE_CURVE) {
            const corner = (nbN && nbE) ? 'ne' : (nbE && nbS) ? 'es' : (nbS && nbW) ? 'sw' : 'wn';
            dummy.position.set(wx, ROAD_Y, wz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            if (multiLaneFlip && hubCurveMeshesFlip[typeKey] && hubCurveMeshesFlip[typeKey][corner]) {
              hubCurveMeshesFlip[typeKey][corner].setMatrixAt(hubCurveFlipCounts[typeKey][corner]++, dummy.matrix);
            } else {
              hubCurveMeshes[typeKey][corner].setMatrixAt(hubCurveCounts[typeKey][corner]++, dummy.matrix);
            }
          } else if (nodeType === NODE_DEADEND) {
            const side = nbN ? 'n' : nbE ? 'e' : nbS ? 's' : nbW ? 'w' : 's';
            dummy.position.set(wx, ROAD_Y, wz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            hubDeadEndMeshes[typeKey][side].setMatrixAt(hubDeadEndCounts[typeKey][side]++, dummy.matrix);
          } else {
            dummy.position.set(wx, ROAD_Y, wz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            hubPlainMeshes[typeKey].setMatrixAt(hubPlainCounts[typeKey]++, dummy.matrix);
          }

          // signals: every T-junction or 4-way gets a pole+head at each of its 4 corners (two corners
          // facing each axis), not just a single direction — matches a real intersection. Poles now
          // stand on the actual road surface (ROAD_TOP_Y) instead of the old y=0, which used to bury
          // most of the pole under the (mis-stacked) sidewalk.
          if (useStopLine) {
            const poleOff = HUB_HALF * hubMul * 0.62;
            const corners = [
              { dx: -1, dz: -1, axis: 'ns' }, { dx: 1, dz: -1, axis: 'ew' },
              { dx: 1, dz: 1, axis: 'ns' }, { dx: -1, dz: 1, axis: 'ew' },
            ];
            corners.forEach(({ dx, dz, axis }) => {
              dummy.position.set(wx + dx * poleOff, ROAD_TOP_Y, wz + dz * poleOff); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
              signalPoleMesh.setMatrixAt(signalPoleCount++, dummy.matrix);
              signalHousingMesh.setMatrixAt(signalHousingCount++, dummy.matrix);
              if (axis === 'ns') {
                signalNSRedMesh.setMatrixAt(signalNSCount, dummy.matrix);
                signalNSYellowMesh.setMatrixAt(signalNSCount, dummy.matrix);
                signalNSGreenMesh.setMatrixAt(signalNSCount, dummy.matrix);
                signalNSCount++;
              } else {
                signalEWRedMesh.setMatrixAt(signalEWCount, dummy.matrix);
                signalEWYellowMesh.setMatrixAt(signalEWCount, dummy.matrix);
                signalEWGreenMesh.setMatrixAt(signalEWCount, dummy.matrix);
                signalEWCount++;
              }
            });
          }

          // ---- one-way 'small' road direction signs: planted beside the road, on the traffic's
          // own-right side, every 4 tiles along the street (the (tx+ty) % 4 test advances by 1
          // every single tile step in any straight direction, so it reliably gives a period-4
          // spacing along the road regardless of whether it runs N-S or E-W). ----
          if (isSmallOneWay) {
            const mask = oneWayDirRef.current[i];
            let flowDir = -1;
            for (let d = 0; d < 4; d++) { if (mask & dirBit(d)) { flowDir = d; break; } }
            if (flowDir >= 0 && (tx + ty) % 4 === 0) {
              const [fdx, fdy] = DIR_DELTA[flowDir];
              const perpX = -fdy, perpZ = fdx; // "own right" side of the direction of travel
              const signOff = HUB_HALF * hubMul + TILE * 0.3;
              const sx = wx + perpX * signOff, sz = wz + perpZ * signOff;
              const rotY = Math.atan2(fdx, fdy);
              dummy.position.set(sx, ROAD_TOP_Y, sz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
              dirSignPoleMesh.setMatrixAt(dirSignCount, dummy.matrix);
              dummy.rotation.set(0, rotY, 0); dummy.updateMatrix();
              dirSignBoardMesh.setMatrixAt(dirSignCount, dummy.matrix);
              dirSignCount++;
            }
          }

          const pushArm = (rotY, nbTx, nbTy, drawConnector, armDir) => {
            dummy.position.set(wx, CURB_Y, wz); dummy.rotation.set(0, rotY, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            curbArmMeshes[typeKey].setMatrixAt(curbArmCounts[typeKey]++, dummy.matrix);
            // if the tile on this side is a different road type, this arm stops short of the
            // tile edge (armPlainShortMeshes) and a taper connector piece fills the remaining gap
            // with a width that blends between the two types — see ROAD_TAPER_HALF /
            // makeTaperPrismGeometry. Intersections (useStopLine) are left on the full-length arm
            // for now so stop-line placement/signals aren't affected by this.
            const neighborTypeKey = ROAD_TYPE_KEYS[roadType[idx(nbTx, nbTy)]] || 'two';
            const differs = !useStopLine && neighborTypeKey !== typeKey;
            // per-arm flip: a 'small' one-way tile can have a different exit/entry direction on
            // each side (e.g. straight-through = one exit arm + one entry arm), so this is
            // recomputed per direction from the bitmask rather than reusing one tile-wide flag.
            const armFlip = isMultiLane ? multiLaneFlip : isSmallOneWay ? (oneWayDirRef.current[i] & dirBit(armDir)) === 0 : false;
            dummy.position.set(wx, ROAD_Y, wz); dummy.rotation.set(0, rotY, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            if (useStopLine) armStopMeshes[typeKey].setMatrixAt(armStopCounts[typeKey]++, dummy.matrix);
            else if (differs) armPlainShortMeshes[typeKey].setMatrixAt(armPlainShortCounts[typeKey]++, dummy.matrix);
            else if (armFlip && armPlainMeshesFlip[typeKey]) armPlainMeshesFlip[typeKey].setMatrixAt(armPlainFlipCounts[typeKey]++, dummy.matrix);
            else armPlainMeshes[typeKey].setMatrixAt(armPlainCounts[typeKey]++, dummy.matrix);
            // the connector itself is only placed from the E/S side of each boundary (drawConnector),
            // so it's never rendered twice for the same tile-to-tile seam — the neighbor tile's own
            // shortened arm (computed the same way when its turn comes up in this same loop) meets
            // this piece exactly at its far end.
            if (differs && drawConnector) {
              const tKey = `${typeKey}_${neighborTypeKey}`;
              const tMesh = taperMeshes[tKey];
              if (tMesh) {
                dummy.position.set(wx, ROAD_Y, wz); dummy.rotation.set(0, rotY, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
                tMesh.setMatrixAt(taperCounts[tKey]++, dummy.matrix);
              }
            }
          };
          if (nbN) pushArm(Math.PI, tx, ty - 1, false, DIR_N);
          if (nbS) pushArm(0, tx, ty + 1, true, DIR_S);
          if (nbE) pushArm(Math.PI / 2, tx + 1, ty, true, DIR_E);
          if (nbW) pushArm(-Math.PI / 2, tx - 1, ty, false, DIR_W);

          if (isBorder(tx, ty) && connected[i]) {
            dummy.position.set(wx, ROAD_TOP_Y, wz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            gateMesh.setMatrixAt(gateCount++, dummy.matrix);
          }
        } else if (isZoneType(v)) {
          const lvl = level[i];
          if (lvl === 0) {
            const eligible = hasConnectedRoadNeighbor(tx, ty);
            const mesh = eligible ? zoneTint[v] : zoneTintDim[v];
            const count = eligible ? tintCounts[v]++ : dimCounts[v]++;
            dummy.position.set(wx, 0.4, wz); dummy.rotation.set(0, 0, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
            mesh.setMatrixAt(count, dummy.matrix);
          } else {
            const bIdx = lvl - 1;
            const j = hash2(tx, ty);
            const variant = Math.floor(hash2(tx + 91, ty + 37) * 4) % 4;
            const count = buildCounts[v][bIdx][variant]++;
            dummy.position.set(wx, 0, wz);
            dummy.rotation.set(0, (j - 0.5) * 0.25, 0);
            const foot = 0.92 + j * 0.14;
            const hj = 0.94 + ((j * 7) % 1) * 0.1;
            dummy.scale.set(foot, hj, foot);
            dummy.updateMatrix();
            buildingMeshes[v][bIdx][variant].forEach((partMesh) => partMesh.setMatrixAt(count, dummy.matrix));
          }
        }
      }

      sidewalkMesh.count = sidewalkCount; sidewalkMesh.instanceMatrix.needsUpdate = true;
      ROAD_TYPE_KEYS.forEach((key) => {
        hubThroughMeshes[key].count = hubThroughCounts[key]; hubThroughMeshes[key].instanceMatrix.needsUpdate = true;
        if (hubThroughMeshesFlip[key]) { hubThroughMeshesFlip[key].count = hubThroughFlipCounts[key]; hubThroughMeshesFlip[key].instanceMatrix.needsUpdate = true; }
        hubPlainMeshes[key].count = hubPlainCounts[key]; hubPlainMeshes[key].instanceMatrix.needsUpdate = true;
        CURVE_CORNERS.forEach((corner) => { const m = hubCurveMeshes[key][corner]; m.count = hubCurveCounts[key][corner]; m.instanceMatrix.needsUpdate = true; });
        if (hubCurveMeshesFlip[key]) CURVE_CORNERS.forEach((corner) => { const m = hubCurveMeshesFlip[key][corner]; if (m) { m.count = hubCurveFlipCounts[key][corner]; m.instanceMatrix.needsUpdate = true; } });
        DEADEND_SIDES.forEach((side) => { const m = hubDeadEndMeshes[key][side]; m.count = hubDeadEndCounts[key][side]; m.instanceMatrix.needsUpdate = true; });
        armPlainMeshes[key].count = armPlainCounts[key]; armPlainMeshes[key].instanceMatrix.needsUpdate = true;
        armPlainShortMeshes[key].count = armPlainShortCounts[key]; armPlainShortMeshes[key].instanceMatrix.needsUpdate = true;
        if (armPlainMeshesFlip[key]) { armPlainMeshesFlip[key].count = armPlainFlipCounts[key]; armPlainMeshesFlip[key].instanceMatrix.needsUpdate = true; }
        armStopMeshes[key].count = armStopCounts[key]; armStopMeshes[key].instanceMatrix.needsUpdate = true;
        curbHubMeshes[key].count = curbHubCounts[key]; curbHubMeshes[key].instanceMatrix.needsUpdate = true;
        curbArmMeshes[key].count = curbArmCounts[key]; curbArmMeshes[key].instanceMatrix.needsUpdate = true;
      });
      Object.keys(taperMeshes).forEach((key) => {
        const m = taperMeshes[key]; m.count = taperCounts[key] || 0; m.instanceMatrix.needsUpdate = true;
      });
      gateMesh.count = gateCount; gateMesh.instanceMatrix.needsUpdate = true;
      signalPoleMesh.count = signalPoleCount; signalPoleMesh.instanceMatrix.needsUpdate = true;
      signalHousingMesh.count = signalHousingCount; signalHousingMesh.instanceMatrix.needsUpdate = true;
      signalNSRedMesh.count = signalNSCount; signalNSRedMesh.instanceMatrix.needsUpdate = true;
      signalNSYellowMesh.count = signalNSCount; signalNSYellowMesh.instanceMatrix.needsUpdate = true;
      signalNSGreenMesh.count = signalNSCount; signalNSGreenMesh.instanceMatrix.needsUpdate = true;
      signalEWRedMesh.count = signalEWCount; signalEWRedMesh.instanceMatrix.needsUpdate = true;
      signalEWYellowMesh.count = signalEWCount; signalEWYellowMesh.instanceMatrix.needsUpdate = true;
      signalEWGreenMesh.count = signalEWCount; signalEWGreenMesh.instanceMatrix.needsUpdate = true;
      dirSignPoleMesh.count = dirSignCount; dirSignPoleMesh.instanceMatrix.needsUpdate = true;
      dirSignBoardMesh.count = dirSignCount; dirSignBoardMesh.instanceMatrix.needsUpdate = true;
      [TILE_RES, TILE_COM, TILE_IND].forEach((z) => {
        zoneTint[z].count = tintCounts[z]; zoneTint[z].instanceMatrix.needsUpdate = true;
        zoneTintDim[z].count = dimCounts[z]; zoneTintDim[z].instanceMatrix.needsUpdate = true;
        buildingMeshes[z].forEach((variants, li) => variants.forEach((partMeshes, vi) => {
          const cnt = buildCounts[z][li][vi];
          partMeshes.forEach((m) => { m.count = cnt; m.instanceMatrix.needsUpdate = true; });
        }));
      });
      setHud((h) => ({ ...h, roadCount: sidewalkCount, signalCount: signalNSCount }));
    };
    threeRef.current.syncInstances = syncInstances;
    // InstancedMesh frustum-culls using a bounding sphere computed from its own (un-instanced)
    // geometry, positioned at the mesh's own transform (world origin here) — it does NOT expand
    // to cover where individual instances actually are. On a 64x64 tile map, cars/pedestrians/
    // buildings/road tiles near the edges sit far from that origin-centered sphere, so as soon
    // as the camera pans away from the map center the whole mesh (every instance in it, near or
    // far) gets culled at once — which is what looked like cars suddenly popping in/out. Every
    // InstancedMesh in this scene is small and cheap to draw per-instance, so it's safe to just
    // disable frustum culling on all of them and let the GPU do per-triangle clipping instead.
    scene.traverse((o) => { if (o.isInstancedMesh) o.frustumCulled = false; });

    // ---- initial external highway connection (【追加仕様】 #2/#12) ----
    // The game never starts on a blank map: a highway already runs in from the west map edge,
    // standing in for "an outside city is out there", plus a short ordinary-road stub (a minimal
    // IC/interchange — see requirement #10) so the player has something real to extend their own
    // road network from on turn one, instead of laying every road themselves from nothing.
    // Only done once, on first mount — gridRef starts as an all-TILE_EMPTY Uint8Array, so this
    // simply seeds a few tiles before the very first recomputeConnectivity()/syncInstances() below.
    {
      const grid = gridRef.current;
      const roadType = roadTypeRef.current;
      const highwayIdx = ROAD_TYPE_KEYS.indexOf('highway');
      const twoIdx = ROAD_TYPE_KEYS.indexOf('two');
      const midY = Math.floor(GRID_SIZE / 2);
      const HIGHWAY_LEN = 8; // tiles of highway, from the map edge (tx=0) inward
      const IC_STUB_LEN = 3; // ordinary-road tiles right after the highway ends, for the player to build from
      for (let tx = 0; tx <= HIGHWAY_LEN; tx++) {
        const i = idx(tx, midY);
        grid[i] = TILE_ROAD;
        roadType[i] = highwayIdx;
      }
      for (let tx = HIGHWAY_LEN + 1; tx <= HIGHWAY_LEN + IC_STUB_LEN; tx++) {
        const i = idx(tx, midY);
        grid[i] = TILE_ROAD;
        roadType[i] = twoIdx;
      }
    }

    recomputeConnectivity();
    highwayGatesRef.current = computeHighwayGates();
    syncInstances();

    // ---- traffic agents (plain data, updated per animation frame) ----
    const cars = Array.from({ length: NUM_CARS }, () => {
      const kindIdx = randomKindIdx();
      const colorIdx = Math.floor(Math.random() * KIND_SPECS[kindIdx].colors.length);
      return {
        active: false, fromTx: 0, fromTy: 0, toTx: 0, toTy: 0, nextTx: null, nextTy: null, t: 0,
        state: 'drive', crashTimer: 0, crashTilt: 0, closeFlag: false, speed: 0, stuckTimer: 0, turnCooldown: 0,
        kindIdx, colorIdx, profile: randomProfile(), worldX: 0, worldZ: 0, heading: 0, laneOffset: CAR_LANE,
        nextLaneOffset: CAR_LANE, laneBlendFrom: CAR_LANE, laneBlendTo: CAR_LANE, laneBlendT: 1,
        destTx: 0, destTy: 0,
        // every car now comes from, and eventually returns to, the outside world through a
        // highway gate (【追加仕様】 #6/#7) — 'exiting' flips true once the car's current
        // destination IS a highway gate it's driving out through (see pickCarDestination),
        // at which point arriving there despawns it back out to the outside world instead of
        // assigning yet another in-city destination.
        origin: 'outside', exiting: false,
      };
    });
    const peds = Array.from({ length: NUM_PEDS }, () => ({
      active: false, fromTx: 0, fromTy: 0, toTx: 0, toTy: 0, nextTx: null, nextTy: null, t: 0,
      state: 'walk', dwell: 0, crashTimer: 0, closeFlag: false,
      colorIdx: Math.floor(Math.random() * pedColors.length), enterTx: 0, enterTy: 0,
      worldX: 0, worldZ: 0, heading: 0, profile: randomProfile(),
      // Part 5 (Simulation-authoritative rendering): every active ped is now bound to a REAL
      // Citizen entity (citizenId) whose travelState actually drives worldX/worldZ each frame —
      // see the 'sim' ped state below. prevWorldX/prevWorldZ are only used to derive a facing
      // heading from frame-to-frame displacement for citizen-driven peds.
      citizenId: null, prevWorldX: 0, prevWorldZ: 0,
    }));
    threeRef.current.cars = cars;
    threeRef.current.peds = peds;

    const roadTileListRef = { current: [] };
    const pedTileListRef = { current: [] };
    // Non-highway road tiles only — this is the candidate pool for an in-city car DESTINATION
    // (requirement #8: a car may never be "sent to" a highway tile as if it were somewhere to be,
    // since you can't park/arrive on a highway — only the explicit gate-exit trip target,
    // computed separately in pickExitGate, ever points a car at a highway tile).
    const cityRoadTileListRef = { current: [] };
    // subset of cityRoadTileListRef that sits next to an actual residential/commercial/industrial
    // tile — biasing destinations toward these (see pickCarDestination) is the "住宅・商業・工業…
    // を目的地候補に" requirement, and gives a natural, cheap slot to later attach a real
    // home/workplace assignment (requirement #8: "将来...拡張可能な構造") without changing this
    // list's shape.
    const zoneAdjacentRoadTileListRef = { current: [] };
    const isPedWalkableTile = (tx, ty) => {
      const grid = gridRef.current;
      if (!inBounds(tx, ty) || grid[idx(tx, ty)] !== TILE_ROAD) return false;
      const rt = ROAD_TYPES[ROAD_TYPE_KEYS[roadTypeRef.current[idx(tx, ty)]]];
      return !!rt.edgeWalk; // median-only roads (no edge sidewalk) can't be walked at all
    };
    const isNextToZone = (tx, ty) => {
      const grid = gridRef.current;
      return [[0, -1], [1, 0], [0, 1], [-1, 0]].some(([dx, dy]) => {
        const nx = tx + dx, ny = ty + dy;
        return inBounds(nx, ny) && isZoneType(grid[idx(nx, ny)]);
      });
    };
    const rebuildRoadTileList = () => {
      const grid = gridRef.current;
      const list = [];
      const pedList = [];
      const cityList = [];
      const zoneAdjList = [];
      for (let ty = 0; ty < GRID_SIZE; ty++) for (let tx = 0; tx < GRID_SIZE; tx++) {
        if (grid[idx(tx, ty)] === TILE_ROAD) {
          list.push({ tx, ty });
          if (isPedWalkableTile(tx, ty)) pedList.push({ tx, ty });
          const typeKey = ROAD_TYPE_KEYS[roadTypeRef.current[idx(tx, ty)]];
          if (typeKey !== 'highway') {
            cityList.push({ tx, ty });
            if (isNextToZone(tx, ty)) zoneAdjList.push({ tx, ty });
          }
        }
      }
      roadTileListRef.current = list;
      pedTileListRef.current = pedList;
      cityRoadTileListRef.current = cityList;
      zoneAdjacentRoadTileListRef.current = zoneAdjList;
    };
    rebuildRoadTileList();
    threeRef.current.rebuildRoadTileList = rebuildRoadTileList;
    // Part 4: exposed so resolveAnchorTile() (component scope, defined further down) can pick a
    // stable, real, walkable tile for a Workplace/School/'shop' that has no building placement
    // yet — see createWorkplace's buildingId:null (same limitation Part 3 already accepted).
    threeRef.current.pedTileListRef = pedTileListRef;

    // ---- Part 5: camera-range Citizen selection (Simulation is authoritative / Render is a
    // window into it) ----
    // Citizens are ALWAYS simulated regardless of camera position (SimulationManager's event
    // queue in Part 1/3/4 never stops for anyone). What changes here is only which citizens get a
    // walking 3D pedestrian instance right now. To find candidates without ever sweeping the full
    // (potentially 12,000+) citizen population in a single frame (§禁止事項 4), a snapshot of
    // citizen ids is rebuilt only periodically, and each spawn attempt only scans a small bounded
    // window of that snapshot (round-robin, resuming where the previous attempt left off).
    const CITIZEN_PED_RENDER_RADIUS_TILES = 26; // candidates must be within this many tiles of camera focus to spawn
    const CITIZEN_PED_DESPAWN_RADIUS_TILES = 34; // hysteresis margin — despawn only well beyond spawn radius so camera panning near the edge doesn't thrash spawn/despawn every frame
    const CITIZEN_PED_SCAN_CHUNK = 80; // citizens inspected per spawn attempt — bounded, not O(population)
    const CITIZEN_SNAPSHOT_REFRESH_MS = 4000; // how often the id snapshot array is refreshed from citizensRef
    const citizenIdSnapshotRef = { current: [] };
    const citizenSnapshotCursorRef = { current: 0 };
    const citizenSnapshotAgeRef = { current: -Infinity };
    // Citizens already bound to an active ped are skipped by the scan so the same commuter never
    // gets drawn twice, and so the same 45 fast-moving nearby citizens don't starve the rest.
    const boundCitizenIdsRef = { current: new Set() };
    threeRef.current.boundCitizenIdsRef = boundCitizenIdsRef;
    const tileFromWorld = (wx, wz) => ({
      tx: Math.floor((wx + (GRID_SIZE * TILE) / 2) / TILE),
      ty: Math.floor((wz + (GRID_SIZE * TILE) / 2) / TILE),
    });
    const refreshCitizenSnapshotIfStale = (nowMs) => {
      if (citizenIdSnapshotRef.current.length && nowMs - citizenSnapshotAgeRef.current < CITIZEN_SNAPSHOT_REFRESH_MS) return;
      citizenIdSnapshotRef.current = Array.from(citizensRef.current.keys());
      if (citizenSnapshotCursorRef.current >= citizenIdSnapshotRef.current.length) citizenSnapshotCursorRef.current = 0;
      citizenSnapshotAgeRef.current = nowMs;
    };
    // Bounded round-robin scan for a living, city-resident Citizen who is actually mid-travelState
    // (commuting home<->school/work/shop) and currently anchored near the camera. approxAnchorFn is
    // the component's own approxCitizenAnchorTile (bridged in via threeRef.current below) — reused
    // as-is rather than re-deriving a parallel "where is this citizen" heuristic.
    const findTravelingCitizenNearCamera = (approxAnchorFn) => {
      const snapshot = citizenIdSnapshotRef.current;
      if (!snapshot.length) return null;
      const citizens = citizensRef.current;
      const camTile = tileFromWorld(camTargetRef.current.x, camTargetRef.current.z);
      const chunk = Math.min(CITIZEN_PED_SCAN_CHUNK, snapshot.length);
      let best = null, bestDist = Infinity;
      for (let i = 0; i < chunk; i++) {
        const id = snapshot[citizenSnapshotCursorRef.current];
        citizenSnapshotCursorRef.current = (citizenSnapshotCursorRef.current + 1) % snapshot.length;
        if (boundCitizenIdsRef.current.has(id)) continue;
        const c = citizens.get(id);
        if (!c || !c.alive || !c.cityResident || !c.travelState) continue;
        const anchor = approxAnchorFn(c);
        if (!anchor) continue;
        const dx = anchor.tx - camTile.tx, dy = anchor.ty - camTile.ty;
        const d = dx * dx + dy * dy;
        if (d <= CITIZEN_PED_RENDER_RADIUS_TILES * CITIZEN_PED_RENDER_RADIUS_TILES && d < bestDist) { bestDist = d; best = c; }
      }
      return best;
    };
    // Called from applyTool right after a road tile is laid/changed/erased. Only scans the small
    // `cars` array (NUM_CARS ~ 18, cheap every edit) instead of doing this every frame. Fixes cars
    // getting permanently stuck right after an edit: any car whose current segment or next-tile
    // reference touches the edited tile gets its lane re-resolved (with a smooth blend, not a
    // snap) and, if the road it depended on is now gone, either safely despawns (so it can
    // respawn fresh next tick) or is re-routed onto a still-valid neighbor — never left pointing
    // at a tile that no longer exists.
    const revalidateCarsAround = (tx, ty) => {
      const grid = gridRef.current;
      cars.forEach((car) => {
        if (!car.active) return;
        const near = (Math.abs(car.fromTx - tx) <= 1 && Math.abs(car.fromTy - ty) <= 1)
          || (Math.abs(car.toTx - tx) <= 1 && Math.abs(car.toTy - ty) <= 1)
          || (car.nextTx !== null && car.nextTx !== undefined && Math.abs(car.nextTx - tx) <= 1 && Math.abs(car.nextTy - ty) <= 1);
        if (!near) return;
        if (grid[idx(car.fromTx, car.fromTy)] !== TILE_ROAD || grid[idx(car.toTx, car.toTy)] !== TILE_ROAD) {
          car.active = false; // the road it was driving on is gone — safe instant despawn, will respawn cleanly
          return;
        }
        const freshLane = laneOffsetForMove(car.fromTx, car.fromTy, car.toTx, car.toTy, car.laneOffset);
        if (freshLane !== car.laneBlendTo) { car.laneBlendFrom = car.laneOffset; car.laneBlendTo = freshLane; car.laneBlendT = 0; }
        if (car.nextTx !== null && car.nextTx !== undefined) {
          const stillRoad = inBounds(car.nextTx, car.nextTy) && grid[idx(car.nextTx, car.nextTy)] === TILE_ROAD;
          if (!stillRoad) {
            const nb2 = pickForwardNeighborCar(car.toTx, car.toTy, car.fromTx, car.fromTy, car.destTx, car.destTy);
            car.nextTx = nb2 ? nb2.tx : null; car.nextTy = nb2 ? nb2.ty : null;
            car.nextLaneOffset = nb2 ? laneOffsetForMove(car.toTx, car.toTy, nb2.tx, nb2.ty, freshLane) : freshLane;
          }
        }
      });
    };
    threeRef.current.revalidateCarsAround = revalidateCarsAround;
    const randomRoadTile = () => {
      const list = roadTileListRef.current;
      if (!list.length) return null;
      return list[Math.floor(Math.random() * list.length)];
    };
    // picks a fresh in-city destination tile for a car that has already entered the city (never a
    // highway tile — see cityRoadTileListRef), biased toward being reasonably far from where it
    // is now so it actually travels across the map, and preferring tiles that front an actual
    // residential/commercial/industrial building so trips read as "going somewhere" (requirement
    // #8). This is the one spot a future proper home/workplace assignment would plug into.
    const pickCityDestination = (fromTx, fromTy) => {
      const preferred = zoneAdjacentRoadTileListRef.current;
      const fallback = cityRoadTileListRef.current;
      const pickFrom = (list) => {
        if (!list.length) return null;
        for (let tries = 0; tries < 6; tries++) {
          const cand = list[Math.floor(Math.random() * list.length)];
          if (Math.abs(cand.tx - fromTx) + Math.abs(cand.ty - fromTy) >= 6) return cand;
        }
        return list[Math.floor(Math.random() * list.length)];
      };
      if (preferred.length && Math.random() < 0.7) {
        const cand = pickFrom(preferred);
        if (cand) return cand;
      }
      return pickFrom(fallback) || { tx: fromTx, ty: fromTy };
    };
    // picks a highway gate for a car currently in the city to head OUT through — this is what
    // eventually sends every car back out to the outside world instead of roaming forever
    // (requirement #6/#7). Prefers the nearest gate (real trips end near where they started
    // conceptually), with a little randomness so traffic doesn't all funnel through one gate.
    const pickExitGate = (fromTx, fromTy) => {
      const gates = highwayGatesRef.current;
      if (!gates.length) return null;
      if (gates.length === 1 || Math.random() < 0.25) return gates[Math.floor(Math.random() * gates.length)];
      let best = gates[0], bestDist = Infinity;
      gates.forEach((g) => {
        const d = Math.abs(g.inTx - fromTx) + Math.abs(g.inTy - fromTy);
        if (d < bestDist) { bestDist = d; best = g; }
      });
      return best;
    };
    // Assigns a car's NEXT trip once it has arrived at (or is spawning toward) its current
    // destination: most of the time another in-city errand, occasionally a trip back out through
    // a highway gate. Centralizing this (rather than inlining it at each call site) is what keeps
    // the spawn path and the "reached destination" path in updateAgents perfectly consistent.
    const EXIT_TRIP_CHANCE = 0.22;
    const assignNextTrip = (car, fromTx, fromTy) => {
      const gate = (Math.random() < EXIT_TRIP_CHANCE) ? pickExitGate(fromTx, fromTy) : null;
      if (gate) {
        car.exiting = true; car.destTx = gate.tx; car.destTy = gate.ty;
      } else {
        car.exiting = false;
        const dest = pickCityDestination(fromTx, fromTy);
        car.destTx = dest.tx; car.destTy = dest.ty;
      }
    };
    // a segment is safe to spawn/enter if no other active car already occupies it too close to
    // its start (t < margin) — prevents spawning on top of / just behind an existing car.
    const segmentClearForSpawn = (ftx, fty, ttx, tty, margin) => {
      for (let k = 0; k < cars.length; k++) {
        const c = cars[k];
        if (c.active && c.fromTx === ftx && c.fromTy === fty && c.toTx === ttx && c.toTy === tty && c.t < margin) return false;
      }
      return true;
    };
    // ---- external traffic spawn (【追加仕様】 #5/#6/#7/#19/#20) ----
    // Cars no longer appear at a random road tile. Every car is created at a highway gate tile
    // sitting on the map border (see computeHighwayGates) and immediately driven INWARD onto the
    // real road tile just past it (gate.inTx/inTy) — never the reverse, so a spawned car can never
    // be pointed the wrong way down the highway (requirement #20). `car.origin = 'outside'` and
    // `car.exiting = false` mark it as a fresh arrival from outside the city; assignNextTrip then
    // gives it a real in-city errand (or, occasionally, an immediate turnaround back out) so it
    // never just idles at the on-ramp. Throttled by externalSpawnTimerRef so gates don't flood
    // every car in at once the instant a slot opens (requirement #13).
    const trySpawnExternalCar = (car, dt) => {
      if (externalSpawnTimerRef.current > 0) return;
      const gates = highwayGatesRef.current;
      if (!gates.length) return; // no highway reaches the map edge yet — nothing can spawn
      const gate = gates[Math.floor(Math.random() * gates.length)];
      // only enter if this gate's inbound segment isn't already occupied right at the on-ramp —
      // exactly the same "no overlapping spawns" rule normal respawns already used.
      if (!segmentClearForSpawn(gate.tx, gate.ty, gate.inTx, gate.inTy, CAR_FOLLOW_SOFT_GAP * 1.5)) return;
      car.fromTx = gate.tx; car.fromTy = gate.ty;
      car.toTx = gate.inTx; car.toTy = gate.inTy; car.t = 0; car.active = true;
      car.state = 'drive'; car.crashTimer = 0; car.closeFlag = false; car.speed = 0; car.stuckTimer = 0; car.turnCooldown = 0;
      car.origin = 'outside';
      const lane = laneOffsetForMove(car.fromTx, car.fromTy, car.toTx, car.toTy);
      car.laneOffset = lane; car.laneBlendFrom = lane; car.laneBlendTo = lane; car.laneBlendT = 1;
      assignNextTrip(car, car.toTx, car.toTy);
      const nb2 = pickForwardNeighborCar(car.toTx, car.toTy, car.fromTx, car.fromTy, car.destTx, car.destTy);
      car.nextTx = nb2 ? nb2.tx : null; car.nextTy = nb2 ? nb2.ty : null;
      car.nextLaneOffset = nb2 ? laneOffsetForMove(car.toTx, car.toTy, nb2.tx, nb2.ty, lane) : lane;
      externalSpawnTimerRef.current = EXTERNAL_SPAWN_MIN_INTERVAL;
    };
    // Part 5: a ped slot no longer starts life as an anonymous random walker. It is only ever
    // (re)activated by binding it to a REAL, currently-traveling Citizen near the camera (§重要：
    // 本物のCitizen / §禁止事項 7). If no eligible citizen is found this attempt, the slot simply
    // stays empty and is retried next frame — an empty sidewalk is correct when nobody nearby is
    // actually out walking; it is never backfilled with a fabricated pedestrian.
    const trySpawnPed = (p) => {
      const bridge = threeRef.current;
      const approxAnchor = bridge && bridge.approxCitizenAnchorTile;
      if (!approxAnchor) { p.active = false; return; }
      const nowMs = gameClockRef.current.getEpochMs();
      refreshCitizenSnapshotIfStale(nowMs);
      const citizen = findTravelingCitizenNearCamera(approxAnchor);
      if (!citizen) { p.active = false; return; }
      const wp = bridge.getCitizenWorldPos ? bridge.getCitizenWorldPos(citizen) : null;
      if (!wp) { p.active = false; return; }
      p.citizenId = citizen.id;
      boundCitizenIdsRef.current.add(citizen.id);
      p.state = 'sim'; p.active = true; p.closeFlag = false; p.crashTimer = 0;
      p.worldX = wp.worldX; p.worldZ = wp.worldZ;
      p.prevWorldX = wp.worldX; p.prevWorldZ = wp.worldZ;
    };

    const updateAgents = (dt, elapsed) => {
      const grid = gridRef.current;
      const { pedBodyMeshes: bodyM, pedHeadMesh, allChassisMeshes: chassisAll } = threeRef.current;

      vehicleKinds.forEach((kd) => {
        kd.chassisCounts.fill(0); kd.cabinCounts.fill(0); kd.cargoCounts.fill(0);
        kd.driverCount = 0; kd.signCount = 0; kd.lightCount = 0;
      });
      let wheelCount = 0;
      let crashCount = 0;

      // decremented once per frame regardless of how many inactive car slots there are —
      // trySpawnExternalCar only actually spawns once this reaches zero (requirement #13).
      externalSpawnTimerRef.current = Math.max(0, externalSpawnTimerRef.current - dt);

      // ---- car following / intersection queueing ----
      // Group active cars by the exact tile-to-tile segment they're currently driving (this
      // already separates opposite-direction traffic, since they occupy segments with swapped
      // from/to tiles). A car checks two things ahead of it: any other car further along the
      // SAME segment, and any car near the START of the NEXT segment (i.e. already stopped/
      // queued at the intersection this car is approaching) — without the second check, a car
      // would drive straight through a car stopped at a red light instead of queueing behind it.
      const segMap = new Map();
      cars.forEach((c) => {
        if (!c.active) return;
        const key = `${c.fromTx},${c.fromTy}|${c.toTx},${c.toTy}`;
        (segMap.get(key) || segMap.set(key, []).get(key)).push(c);
      });

      cars.forEach((car) => {
        if (!car.active) { trySpawnExternalCar(car, dt); return; }

        if (car.state === 'crashed') {
          car.crashTimer -= dt;
          if (car.crashTimer <= 0) { car.state = 'drive'; car.crashTilt = 0; }
        } else {
          if (grid[idx(car.toTx, car.toTy)] !== TILE_ROAD) { car.active = false; return; }
          const nextTile = (car.nextTx !== null && car.nextTx !== undefined) ? { tx: car.nextTx, ty: car.nextTy } : null;
          // Explicit STRAIGHT/LEFT/RIGHT/UTURN classification (see classifyTurn) instead of the
          // old "did the direction change at all" boolean. This matters because a genuine 90°
          // LEFT/RIGHT bend and a dead-end U-TURN are geometrically nothing alike: the corner
          // Bezier blend below (movePoint) is a fillet built for a 90° bend, and feeding it a
          // 180° reversal used to swing the car through a wide, unnatural loop. U-turns now skip
          // the corner blend entirely and just drive straight to the tile center, matching the
          // (rare, dead-end-only) case they actually occur in.
          let turnType = TURN_STRAIGHT;
          if (nextTile) {
            const d1x = car.toTx - car.fromTx, d1y = car.toTy - car.fromTy;
            const d2x = nextTile.tx - car.toTx, d2y = nextTile.ty - car.toTy;
            const fromDir = dirFromDelta(d1x, d1y), toDir = dirFromDelta(d2x, d2y);
            turnType = classifyTurn(fromDir, toDir);
          }
          const turning = turnType === TURN_LEFT || turnType === TURN_RIGHT;
          const approachingCorner = turning && car.t > CORNER_START - 0.22;
          car.turnCooldown = Math.max(0, (car.turnCooldown || 0) - dt);

          // ---- stop for a red light when the tile ahead is a signaled intersection (T-junction or
          // full crossroad — a T still has a real conflict between its through movement and its branch) ----
          // IMPORTANT: this only ever ENGAGES while the car hasn't already reached the stop line
          // (car.t <= SIGNAL_STOP_T). If the light flips red at the exact moment a car is already
          // past that point (already committed to/through the crossing), it is NOT forced to stop —
          // that is what used to teleport cars BACKWARDS to the stop line. A car past the line
          // just finishes crossing, exactly like a real driver already in the intersection.
          let stopAtLight = false;
          const aheadNode = intersectionTypeRef.current[idx(car.toTx, car.toTy)];
          if ((aheadNode === NODE_CROSS || aheadNode === NODE_T) && car.t <= SIGNAL_STOP_T) {
            const axisIsNS = car.toTy !== car.fromTy;
            const ph = signalPhaseRef.current.phase;
            const axisGreen = axisIsNS ? (ph === 'ns' || ph === 'ns_yellow') : (ph === 'ew' || ph === 'ew_yellow');
            if (!axisGreen && car.t > SIGNAL_BRAKE_T) stopAtLight = true;
          }

          // ---- following distance: find the closest car ahead, in this segment or queued at
          // the start of the next one, and translate that into a speed target / hard position cap.
          // Rather than comparing raw t-distance against one fixed gap, we track "slack" — the
          // ahead distance MINUS the physically-required gap for that specific pair of vehicles —
          // so a following car's own body length, the lead vehicle's body length, and current
          // speed all widen the effective gap. This is what stops long vehicles (pickup/box) from
          // getting nosed into, and stops any pair of cars from visually overlapping. ----
          // the corner bezier (see movePoint/CORNER_START) cuts the physical path shorter than
          // the straight tile-to-tile distance this whole gap system is calibrated in units of,
          // so the same t-gap covers noticeably less real-world space while cornering — without
          // extra padding here, cars queued through/around a curve visually overlap even though
          // their t-gap looks "safe" on a straight road.
          // ---- per-road-type speed (【追加仕様】 #3/#14/#15) ----
          // The car's full-speed target is no longer the flat CAR_SPEED constant — it's derived
          // from the road type(s) of the segment actually being driven, via speedForRoadType().
          // Using the MIN of the tile being left and the tile being entered (rather than just one
          // of them) is what makes the deceleration/acceleration happen exactly where it should:
          // on the segment approaching a highway exit (still nominally "on the highway" but
          // already heading toward a slower tile) speed is already capped low, so the car is
          // slowing down BEFORE it reaches the ordinary road — never "100km/h のまま突っ込む".
          // Symmetrically, entering the highway only reaches the full 100km/h target once BOTH
          // the tile it's leaving and the tile it's entering are highway, so the accel ramp
          // (still handled by the existing CAR_ACCEL easing below) plays out naturally over the
          // on-ramp instead of snapping to speed the instant it touches the highway tile.
          const fromRoadType = ROAD_TYPES[ROAD_TYPE_KEYS[roadTypeRef.current[idx(car.fromTx, car.fromTy)]]] || ROAD_TYPES.two;
          const toRoadType = ROAD_TYPES[ROAD_TYPE_KEYS[roadTypeRef.current[idx(car.toTx, car.toTy)]]] || ROAD_TYPES.two;
          const segFullSpeed = Math.min(speedForRoadType(fromRoadType), speedForRoadType(toRoadType));
          const nearCorner = turning || intersectionTypeRef.current[idx(car.toTx, car.toTy)] === NODE_CURVE;
          const requiredGapT = (leadKindIdx) => {
            // half of each vehicle's own body length (so bumper-to-bumper, not center-to-center)
            // + a fixed safety pad + extra room that grows with how fast THIS car is following.
            const lenHalfSum = (KIND_SPECS[car.kindIdx].bodyLen + KIND_SPECS[leadKindIdx].bodyLen) * 0.5;
            const speedPad = (Math.max(0, car.speed) / CAR_SPEED) * (CAR_FOLLOW_SOFT_GAP * 0.5);
            const cornerPad = nearCorner ? CAR_FOLLOW_HARD_GAP * 0.9 : 0;
            return lenHalfSum + CAR_FOLLOW_HARD_GAP * 0.4 + speedPad + cornerPad;
          };
          let aheadSlackT = Infinity;
          const sameSeg = segMap.get(`${car.fromTx},${car.fromTy}|${car.toTx},${car.toTy}`);
          if (sameSeg) sameSeg.forEach((other) => {
            if (other === car || other.t <= car.t) return;
            // vehicles in a different lane (side-by-side, e.g. the 2 same-direction lanes of a
            // 3-lane road) don't block each other — only treat a car ahead in (about) the SAME
            // lane as a following hazard, so a multi-lane road doesn't grind to a single-file crawl.
            if (Math.abs(other.laneOffset - car.laneOffset) > CAR_LANE * 0.6) return;
            aheadSlackT = Math.min(aheadSlackT, (other.t - car.t) - requiredGapT(other.kindIdx));
          });
          if (nextTile) {
            const nextSeg = segMap.get(`${car.toTx},${car.toTy}|${nextTile.tx},${nextTile.ty}`);
            if (nextSeg) nextSeg.forEach((other) => {
              if (Math.abs(other.laneOffset - car.nextLaneOffset) > CAR_LANE * 0.6) return;
              aheadSlackT = Math.min(aheadSlackT, ((1 - car.t) + other.t) - requiredGapT(other.kindIdx));
            });
          }
          const followBlocked = aheadSlackT < CAR_FOLLOW_SOFT_GAP;
          const followSpeed = aheadSlackT <= 0 ? 0 : segFullSpeed * Math.min(1, aheadSlackT / CAR_FOLLOW_SOFT_GAP);
          // ---- gridlock buster: the extra follow-gap padding around curves (cornerPad above)
          // can make a ring of cars queued around/through a curve each block the one behind them
          // in a closed loop, so nobody's slack ever clears and the whole knot sits there forever
          // (this is the "cars circle/jam at a curve forever" bug). If a car has been essentially
          // stopped AND blocked for several seconds while near a curve, ignore the follow-distance
          // check for a moment so it can creep forward and break the deadlock, instead of waiting
          // on a gap that will never open on its own.
          car.stuckTimer = (nearCorner && followBlocked && car.speed < 0.4) ? (car.stuckTimer || 0) + dt : 0;
          const gridlockBypass = car.stuckTimer > 3.5;

          // ---- downstream/exit blocking: don't let a car push into an intersection if the road
          // segment immediately beyond it is already saturated (e.g. because ITS own downstream
          // light is red). Without this, cars keep leaving an intersection into a short link road
          // that has nowhere left to drain, which jams the intersection itself. ----
          let downstreamBlocked = false;
          if (nextTile && (aheadNode === NODE_CROSS || aheadNode === NODE_T) && car.t > SIGNAL_BRAKE_T && car.t <= SIGNAL_STOP_T) {
            const beyondSeg = segMap.get(`${car.toTx},${car.toTy}|${nextTile.tx},${nextTile.ty}`);
            if (beyondSeg && beyondSeg.length >= 2) downstreamBlocked = true;
          }
          if (downstreamBlocked) stopAtLight = true;

          // ease the speed target back up from turn-speed to full speed over TURN_EXIT_EASE
          // seconds after a turn finishes, instead of snapping straight back to full speed the
          // instant the corner bezier ends (that snap is what caused the burst of acceleration
          // right after every curve).
          const cornerSpeed = segFullSpeed * CAR_TURN_SPEED_MULT;
          const turnExitFrac = Math.max(0, Math.min(1, car.turnCooldown / TURN_EXIT_EASE));
          const easedFullSpeed = cornerSpeed + (segFullSpeed - cornerSpeed) * (1 - turnExitFrac);
          const baseTargetSpeed = stopAtLight ? 0 : approachingCorner ? cornerSpeed : easedFullSpeed;
          const targetSpeed = (followBlocked && !gridlockBypass) ? Math.min(baseTargetSpeed, followSpeed) : (gridlockBypass ? Math.min(baseTargetSpeed, segFullSpeed * 0.25) : baseTargetSpeed);
          const rate = targetSpeed < car.speed ? CAR_BRAKE : CAR_ACCEL;
          car.speed += (targetSpeed - car.speed) * Math.min(1, dt * rate);
          const tBeforeAdvance = car.t;
          car.t += (dt * car.speed) / TILE;
          // Forward-only cap: holds the car at the stop line by limiting how far it can advance
          // THIS frame — it can never reduce car.t below its value at the start of the frame, so
          // this never rewinds/teleports the car, only slows its forward crawl to a halt.
          if (stopAtLight) car.t = Math.min(car.t, Math.max(tBeforeAdvance, SIGNAL_STOP_T));
          // hard cap as a backstop (in case the speed easing above wasn't quite enough this
          // frame): never let this car's position actually reach/overlap (body length included)
          // the car ahead of it.
          if (aheadSlackT < Infinity && !gridlockBypass) car.t = Math.min(car.t, tBeforeAdvance + Math.max(0, aheadSlackT));
          // smoothly blend the lane offset used for rendering/steering from whatever it was
          // before this segment change toward the new segment's target lane, instead of snapping
          // (this is what makes 2<->3 lane road transitions widen/narrow gradually rather than warp)
          if (car.laneBlendT < 1) car.laneBlendT = Math.min(1, car.laneBlendT + dt / LANE_BLEND_DUR);
          const blendedLane = car.laneBlendFrom + (car.laneBlendTo - car.laneBlendFrom) * smoothstep(car.laneBlendT);
          car.laneOffset = blendedLane;
          const p = movePoint({ tx: car.fromTx, ty: car.fromTy }, { tx: car.toTx, ty: car.toTy }, nextTile, blendedLane, car.nextLaneOffset, car.t, turning);
          car.worldX = p.x; car.worldZ = p.z; car.heading = p.heading;
          if (car.t >= 1) {
            if (turning) car.turnCooldown = TURN_EXIT_EASE;
            const oldFromTx = car.fromTx, oldFromTy = car.fromTy;
            car.fromTx = car.toTx; car.fromTy = car.toTy;
            if (nextTile && grid[idx(nextTile.tx, nextTile.ty)] === TILE_ROAD) {
              car.toTx = nextTile.tx; car.toTy = nextTile.ty; car.t = turning ? CORNER_MIRROR : 0;
            } else {
              // road network changed under this car (edited/removed) or it hit a dead end —
              // try to find ANY valid forward neighbor rather than immediately despawning, so a
              // freshly-edited road doesn't strand it; only give up if truly nowhere to go.
              const nb = pickForwardNeighborCar(car.fromTx, car.fromTy, oldFromTx, oldFromTy, car.destTx, car.destTy);
              if (!nb) { car.active = false; return; }
              car.toTx = nb.tx; car.toTy = nb.ty; car.t = 0;
            }
            // new segment -> re-resolve which lane to use (road type / flip may differ ahead);
            // picked once per segment (not every frame), and blended in smoothly rather than
            // snapped (see laneBlend* above) so the car doesn't jitter or warp between lanes.
            // IMPORTANT: seed the blend FROM car.nextLaneOffset, not the old segment's blendedLane.
            // car.nextLaneOffset (via laneNext in movePoint) is the offset that was ACTUALLY used
            // to render the car's position for the final frames of the corner bezier (the p2
            // anchor); blendedLane was the OLD segment's own lane and can differ substantially
            // (different road type/width ahead). Starting the new blend from blendedLane snapped
            // the car sideways the instant it crossed into the new segment — this is what caused
            // the "warp inside the intersection" bug.
            const newLane = laneOffsetForMove(car.fromTx, car.fromTy, car.toTx, car.toTy, car.nextLaneOffset);
            car.laneBlendFrom = car.nextLaneOffset; car.laneBlendTo = newLane; car.laneBlendT = 0;
            car.laneOffset = car.nextLaneOffset;
            // reached (close to) its destination -> either despawn out through the highway gate
            // it was heading for, or pick a new trip so it keeps making purposeful journeys
            // (【追加仕様】 #6/#7: "十分に走行した後、再び高速道路へ到達した車は、街を出る車として
            // 高速道路へ戻り、マップ外へ流出した扱いにしてください"). An exit trip's destination IS
            // the gate tile itself, so it must be physically reached (exact match), not just
            // "close" — an ordinary in-city errand keeps the old within-1-tile arrival check.
            const reachedDest = car.exiting
              ? (car.fromTx === car.destTx && car.fromTy === car.destTy)
              : (Math.abs(car.fromTx - car.destTx) + Math.abs(car.fromTy - car.destTy) <= 1);
            if (reachedDest) {
              if (car.exiting) {
                // drove all the way out through the gate onto the highway tile at the map edge —
                // treat it as having left the map for the outside world (requirement #7, step 10).
                car.active = false;
                return;
              }
              assignNextTrip(car, car.fromTx, car.fromTy);
            }
            const nb2 = pickForwardNeighborCar(car.toTx, car.toTy, car.fromTx, car.fromTy, car.destTx, car.destTy);
            car.nextTx = nb2 ? nb2.tx : null; car.nextTy = nb2 ? nb2.ty : null;
            car.nextLaneOffset = nb2 ? laneOffsetForMove(car.toTx, car.toTy, nb2.tx, nb2.ty, newLane) : newLane;
          }
        }

        // render
        const kd = vehicleKinds[car.kindIdx];
        const ci = car.colorIdx;
        const tiltZ = car.state === 'crashed' ? car.crashTilt : 0;
        const liftY = car.state === 'crashed' ? 0.08 : 0;
        dummy.position.set(car.worldX, CAR_GROUND_Y + liftY, car.worldZ);
        dummy.rotation.set(0, car.heading, tiltZ);
        dummy.scale.set(1, 1, 1);
        dummy.updateMatrix();
        kd.chassisMeshes[ci].setMatrixAt(kd.chassisCounts[ci]++, dummy.matrix);
        if (kd.cabinMeshes) kd.cabinMeshes[ci].setMatrixAt(kd.cabinCounts[ci]++, dummy.matrix);
        if (kd.cargoMeshes) kd.cargoMeshes[ci].setMatrixAt(kd.cargoCounts[ci]++, dummy.matrix);
        kd.driverBodyMesh.setMatrixAt(kd.driverCount, dummy.matrix);
        kd.driverHeadMesh.setMatrixAt(kd.driverCount, dummy.matrix);
        kd.driverCount++;
        if (kd.signMesh) kd.signMesh.setMatrixAt(kd.signCount++, dummy.matrix);
        kd.headlightMesh.setMatrixAt(kd.lightCount, dummy.matrix);
        kd.taillightMesh.setMatrixAt(kd.lightCount, dummy.matrix);
        kd.lightCount++;

        const cosH = Math.cos(car.heading), sinH = Math.sin(car.heading);
        kd.spec.wheel.offsets.forEach(([ox, oz]) => {
          const wx = car.worldX + ox * cosH + oz * sinH;
          const wz = car.worldZ - ox * sinH + oz * cosH;
          wheelDummy.position.set(wx, CAR_GROUND_Y + kd.spec.wheel.r, wz);
          wheelDummy.rotation.set(0, car.heading, 0);
          wheelDummy.scale.set(kd.spec.wheel.w, kd.spec.wheel.r, kd.spec.wheel.r);
          wheelDummy.updateMatrix();
          wheelMesh.setMatrixAt(wheelCount++, wheelDummy.matrix);
        });

        if (car.state === 'crashed' && crashCount < 40) {
          dummy.position.set(car.worldX, 2.2 + Math.sin(elapsed * 6) * 0.15, car.worldZ);
          dummy.rotation.set(elapsed * 2, elapsed * 3, 0); dummy.scale.set(1, 1, 1); dummy.updateMatrix();
          crashMesh.setMatrixAt(crashCount++, dummy.matrix);
        }
      });
      vehicleKinds.forEach((kd) => {
        kd.chassisMeshes.forEach((m, i) => { m.count = kd.chassisCounts[i]; m.instanceMatrix.needsUpdate = true; });
        if (kd.cabinMeshes) kd.cabinMeshes.forEach((m, i) => { m.count = kd.cabinCounts[i]; m.instanceMatrix.needsUpdate = true; });
        if (kd.cargoMeshes) kd.cargoMeshes.forEach((m, i) => { m.count = kd.cargoCounts[i]; m.instanceMatrix.needsUpdate = true; });
        kd.driverBodyMesh.count = kd.driverCount; kd.driverBodyMesh.instanceMatrix.needsUpdate = true;
        kd.driverHeadMesh.count = kd.driverCount; kd.driverHeadMesh.instanceMatrix.needsUpdate = true;
        if (kd.signMesh) { kd.signMesh.count = kd.signCount; kd.signMesh.instanceMatrix.needsUpdate = true; }
        kd.headlightMesh.count = kd.lightCount; kd.headlightMesh.instanceMatrix.needsUpdate = true;
        kd.taillightMesh.count = kd.lightCount; kd.taillightMesh.instanceMatrix.needsUpdate = true;
      });
      wheelMesh.count = wheelCount; wheelMesh.instanceMatrix.needsUpdate = true;

      const bodyCounts = new Array(pedColors.length).fill(0);
      let headCount = 0;
      peds.forEach((p) => {
        if (!p.active) { trySpawnPed(p); return; }

        if (p.state === 'hit') {
          p.crashTimer -= dt;
          if (p.crashTimer <= 0) {
            if (p.citizenId) boundCitizenIdsRef.current.delete(p.citizenId);
            p.citizenId = null; p.active = false; return;
          }
        } else { // 'sim' — the only walking state now: position comes straight from the bound
          // Citizen's real travelState via getCitizenWorldPos (Part 4's simulateCitizenUntil +
          // resolveAnchorTile + computeWalkingPath + interpolatePathToWorld, reused as-is — no
          // parallel movement system). §Step5/6.
          const bridge = threeRef.current;
          const citizen = citizensRef.current.get(p.citizenId);
          if (!citizen || !citizen.alive || !citizen.cityResident) {
            if (p.citizenId) boundCitizenIdsRef.current.delete(p.citizenId);
            p.citizenId = null; p.active = false; return;
          }
          const wp = bridge && bridge.getCitizenWorldPos ? bridge.getCitizenWorldPos(citizen) : null;
          if (!wp) {
            boundCitizenIdsRef.current.delete(p.citizenId); p.citizenId = null; p.active = false; return;
          }
          // Citizen finished traveling (arrived home/school/work/shop) — the pedestrian instance
          // is released; the citizen is still fully simulated, just no longer walking on-screen.
          if (!citizen.travelState) {
            boundCitizenIdsRef.current.delete(p.citizenId); p.citizenId = null; p.active = false; return;
          }
          // Camera moved far enough away — free this slot (hysteresis margin so this doesn't
          // thrash every frame right at the render-radius boundary, §Step4).
          const camTile = tileFromWorld(camTargetRef.current.x, camTargetRef.current.z);
          const wpTile = tileFromWorld(wp.worldX, wp.worldZ);
          const ddx = wpTile.tx - camTile.tx, ddy = wpTile.ty - camTile.ty;
          if (ddx * ddx + ddy * ddy > CITIZEN_PED_DESPAWN_RADIUS_TILES * CITIZEN_PED_DESPAWN_RADIUS_TILES) {
            boundCitizenIdsRef.current.delete(p.citizenId); p.citizenId = null; p.active = false; return;
          }
          p.prevWorldX = p.worldX; p.prevWorldZ = p.worldZ;
          const dxw = wp.worldX - p.worldX, dzw = wp.worldZ - p.worldZ;
          if (dxw * dxw + dzw * dzw > 1e-6) p.heading = Math.atan2(dxw, dzw);
          p.worldX = wp.worldX; p.worldZ = wp.worldZ;
        }

        // render (upright, or fallen if just hit)
        const ci = p.colorIdx;
        if (p.state === 'hit') {
          dummy.position.set(p.worldX, PED_GROUND_Y + 0.32 * PED_SCALE, p.worldZ);
          dummy.rotation.set(Math.PI / 2, p.heading, 0);
        } else {
          dummy.position.set(p.worldX, PED_GROUND_Y, p.worldZ);
          dummy.rotation.set(0, p.heading, 0);
        }
        dummy.scale.set(PED_SCALE, PED_SCALE, PED_SCALE); dummy.updateMatrix();
        bodyM[ci].setMatrixAt(bodyCounts[ci]++, dummy.matrix);
        pedHeadMesh.setMatrixAt(headCount++, dummy.matrix);

        if (p.state === 'hit' && crashCount < 40) {
          dummy.position.set(p.worldX, 1.6 + Math.sin(elapsed * 6) * 0.15, p.worldZ);
          dummy.rotation.set(elapsed * 2, elapsed * 3, 0); dummy.scale.set(0.6, 0.6, 0.6); dummy.updateMatrix();
          crashMesh.setMatrixAt(crashCount++, dummy.matrix);
        }
      });
      bodyM.forEach((m, i) => { m.count = bodyCounts[i]; m.instanceMatrix.needsUpdate = true; });
      pedHeadMesh.count = headCount; pedHeadMesh.instanceMatrix.needsUpdate = true;
      crashMesh.count = crashCount; crashMesh.instanceMatrix.needsUpdate = true;

      // ---- rare car <-> pedestrian accidents ----
      cars.forEach((car) => {
        if (!car.active || car.state !== 'drive') { car.closeFlag = false; return; }
        let nearPed = null;
        for (let k = 0; k < peds.length; k++) {
          const p = peds[k];
          if (!p.active || p.state !== 'sim') continue;
          const dx = car.worldX - p.worldX, dz = car.worldZ - p.worldZ;
          if (dx * dx + dz * dz < ACCIDENT_RADIUS * ACCIDENT_RADIUS) { nearPed = p; break; }
        }
        if (nearPed) {
          if (!car.closeFlag) {
            car.closeFlag = true;
            if (Math.random() < ACCIDENT_CHANCE) {
              car.state = 'crashed'; car.crashTimer = 2.5 + Math.random() * 2; car.crashTilt = 0.22 + Math.random() * 0.18;
              nearPed.state = 'hit'; nearPed.crashTimer = 3 + Math.random() * 3;
              // Part 5: the pedestrian struck here is bound to a REAL Citizen entity (never left
              // as an anonymous pedestrian, §匿名pedestrianだけを事故にする構造にしないでください)
              // and that citizen actually receives INJURED status through the same applyInjury()
              // path a future disaster system will use.
              const injuredCitizen = bindCitizenToPed(nearPed);
              if (injuredCitizen) {
                applyInjury(simManagerRef.current, injuredCitizen, {
                  clock: gameClockRef.current, workplaces: workplacesRef.current, educationFacilities: educationFacilitiesRef.current,
                  findHospitalTile: findHospitalTileImpl,
                }, gameClockRef.current.getEpochMs(), 'pedestrian_accident');
              }
            }
          }
        } else car.closeFlag = false;
      });
    };
    threeRef.current.updateAgents = updateAgents;

    // ---- free camera: WASD pan, Z/X rotate azimuth ----
    const onKeyDown = (e) => {
      const k = e.key.toLowerCase();
      if (['w', 'a', 's', 'd', 'z', 'x'].includes(k)) keysRef.current.add(k);
      // ---- Free Road Network draw controls (K/L curve, O/M elevation, Esc cancel) — only while
      // the 'freeroad' tool is active and a segment is actively being drawn (§K/L/O/Mは必ず実装).
      if (toolRef.current === 'freeroad' && freeRoadDraftRef.current) {
        if (k === 'k') adjustFreeRoadCurve(-1);
        else if (k === 'l') adjustFreeRoadCurve(1);
        else if (k === 'o') adjustFreeRoadElevation(1);
        else if (k === 'm') adjustFreeRoadElevation(-1);
        else if (k === 'escape') cancelFreeRoadDraft();
      }
    };
    const onKeyUp = (e) => { keysRef.current.delete(e.key.toLowerCase()); };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    let raf;
    const clock = new THREE.Clock();
    const animate = () => {
      const dt = Math.min(clock.getDelta(), 0.1);
      const elapsed = clock.getElapsedTime();
      const keys = keysRef.current;
      if (keys.has('z')) azimuthRef.current -= dt * 1.2;
      if (keys.has('x')) azimuthRef.current += dt * 1.2;
      const az = azimuthRef.current;
      const forwardX = -Math.sin(az), forwardZ = -Math.cos(az);
      const rightX = Math.cos(az), rightZ = -Math.sin(az);
      const panSpeed = TILE * 7;
      const camTarget = camTargetRef.current;
      let mx = 0, mz = 0;
      if (keys.has('w')) { mx += forwardX; mz += forwardZ; }
      if (keys.has('s')) { mx -= forwardX; mz -= forwardZ; }
      if (keys.has('d')) { mx += rightX; mz += rightZ; }
      if (keys.has('a')) { mx -= rightX; mz -= rightZ; }
      if (mx || mz) {
        camTargetRef.current = { x: camTarget.x + mx * panSpeed * dt, z: camTarget.z + mz * panSpeed * dt };
      }
      const target = camTargetRef.current;
      const horiz = Math.cos(CAM_ELEV);
      const offset = new THREE.Vector3(Math.sin(az) * horiz, Math.sin(CAM_ELEV), Math.cos(az) * horiz).multiplyScalar(CAM_DIST);
      camera.position.set(target.x + offset.x, offset.y, target.z + offset.z);
      camera.up.set(0, 1, 0);
      camera.lookAt(target.x, 0, target.z);
      camera.zoom = zoomRef.current;
      camera.updateProjectionMatrix();
      sun.target.position.set(target.x, 0, target.z);

      // ---- traffic signal phase cycle: ns green -> ns yellow -> ew green -> ew yellow -> ns ...
      // Each lens mesh's material always exists (red/yellow/green all rendered every frame); only
      // its emissiveIntensity toggles between lit/unlit, which is what makes this look like a real
      // 3-light signal head instead of a single lamp that changes color.
      const sig = signalPhaseRef.current;
      sig.timer += dt;
      const curDur = (sig.phase === 'ns' || sig.phase === 'ew') ? SIGNAL_GREEN_TIME : SIGNAL_YELLOW_TIME;
      if (sig.timer >= curDur) {
        sig.timer -= curDur;
        sig.phase = sig.phase === 'ns' ? 'ns_yellow' : sig.phase === 'ns_yellow' ? 'ew' : sig.phase === 'ew' ? 'ew_yellow' : 'ns';
        const setLens = (redMat, yellowMat, greenMat, state) => {
          redMat.emissiveIntensity = state === 'red' ? SIGNAL_LIT_INTENSITY : SIGNAL_UNLIT_INTENSITY;
          yellowMat.emissiveIntensity = state === 'yellow' ? SIGNAL_LIT_INTENSITY : SIGNAL_UNLIT_INTENSITY;
          greenMat.emissiveIntensity = state === 'green' ? SIGNAL_LIT_INTENSITY : SIGNAL_UNLIT_INTENSITY;
        };
        const nsState = sig.phase === 'ns' ? 'green' : sig.phase === 'ns_yellow' ? 'yellow' : 'red';
        const ewState = sig.phase === 'ew' ? 'green' : sig.phase === 'ew_yellow' ? 'yellow' : 'red';
        setLens(signalNSRedMat, signalNSYellowMat, signalNSGreenMat, nsState);
        setLens(signalEWRedMat, signalEWYellowMat, signalEWGreenMat, ewState);
      }

      updateAgents(dt, elapsed);

      const selCar = selectedCarRef.current;
      if (selCar && selCar.active) {
        carSelectMesh.position.set(selCar.worldX, CAR_GROUND_Y + 0.03, selCar.worldZ);
        carSelectMesh.visible = cameraModeRef.current === 'iso';
      } else {
        carSelectMesh.visible = false;
      }

      const selPed = selectedPedRef.current;
      if (selPed && selPed.active) {
        pedSelectMesh.position.set(selPed.worldX, PED_GROUND_Y + 0.08, selPed.worldZ);
        pedSelectMesh.visible = cameraModeRef.current === 'iso';
      } else {
        pedSelectMesh.visible = false;
      }

      if (cameraModeRef.current === 'driver' && selCar && selCar.active) {
        driverCamera.position.set(selCar.worldX - Math.sin(selCar.heading) * 0.3, 1.6, selCar.worldZ - Math.cos(selCar.heading) * 0.3);
        const lookX = selCar.worldX + Math.sin(selCar.heading) * 8;
        const lookZ = selCar.worldZ + Math.cos(selCar.heading) * 8;
        driverCamera.lookAt(lookX, 1.3, lookZ);
        renderer.render(scene, driverCamera);
      } else if (cameraModeRef.current === 'ped' && selPed && selPed.active) {
        // eye-level view riding along with the pedestrian, facing the direction they're walking
        const eyeY = PED_GROUND_Y + 1.15 * PED_SCALE;
        driverCamera.position.set(selPed.worldX - Math.sin(selPed.heading) * 0.15, eyeY, selPed.worldZ - Math.cos(selPed.heading) * 0.15);
        const lookX = selPed.worldX + Math.sin(selPed.heading) * 6;
        const lookZ = selPed.worldZ + Math.cos(selPed.heading) * 6;
        driverCamera.lookAt(lookX, eyeY - 0.1, lookZ);
        renderer.render(scene, driverCamera);
      } else {
        renderer.render(scene, camera);
      }
      raf = requestAnimationFrame(animate);
    };
    raf = requestAnimationFrame(animate);

    const ro = new ResizeObserver(() => {
      const w = mount.clientWidth, h = mount.clientHeight;
      if (!w || !h) return;
      const asp = w / h;
      camera.left = (-viewSize * asp) / 2; camera.right = (viewSize * asp) / 2;
      camera.top = viewSize / 2; camera.bottom = -viewSize / 2;
      camera.updateProjectionMatrix();
      driverCamera.aspect = asp; driverCamera.updateProjectionMatrix();
      renderer.setSize(w, h);
    });
    ro.observe(mount);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      mount.removeChild(renderer.domElement);
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
          mats.forEach((m) => { if (m.map) m.map.dispose(); m.dispose(); });
        }
      });
      renderer.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ============ industry data + pollution (Phase 1/2) ============
  // Rolls (or re-rolls, on level-up) which INDUSTRY_BUILDINGS entry an industrial tile
  // represents. No resource-node adjacency check yet (see INDUSTRY_BUILDINGS_BY_LEVEL comment).
  const assignIndustryBuilding = useCallback((i, level) => {
    const buildingDefId = pickIndustryBuilding(level);
    const existing = industryDataRef.current.get(i);
    industryDataRef.current.set(i, {
      buildingDefId,
      storage: existing?.storage ?? {},
      employees: { required: (INDUSTRY_BUILDINGS[buildingDefId].jobsPerLevel || 0) * level, filled: 0, eduMix: {} },
      pollutionOutput: { air: 0, soil: 0, noise: 0 },
      profitability: existing?.profitability ?? 0,
    });
  }, []);

  // Batch recompute of the 3 city-wide pollution fields from every industrial tile's
  // buildingDef + level, with a simple radius falloff — see design doc §2. Not run every
  // frame/tick; the growth-tick interval below calls this every POLLUTION_TICK_EVERY ticks.
  const POLLUTION_RADIUS = 5;
  const computePollution = useCallback(() => {
    const { air, soil, noise } = pollutionRef.current;
    air.fill(0); soil.fill(0); noise.fill(0);
    const level = levelRef.current;
    industryDataRef.current.forEach((data, i) => {
      const def = INDUSTRY_BUILDINGS[data.buildingDefId];
      if (!def) return;
      const lvl = Math.max(1, level[i] || 1);
      const mag = 0.32 * lvl;
      const tx = i % GRID_SIZE, ty = Math.floor(i / GRID_SIZE);
      // also record this tile's own (unblended) output on its IndustryLot record, for later
      // phases (rent penalty, UI) — kept separate from the blended city-wide fields above.
      data.pollutionOutput = { air: def.pollution.air * mag, soil: def.pollution.soil * mag, noise: def.pollution.noise * mag };
      for (let dy = -POLLUTION_RADIUS; dy <= POLLUTION_RADIUS; dy++) {
        const ny = ty + dy; if (ny < 0 || ny >= GRID_SIZE) continue;
        for (let dx = -POLLUTION_RADIUS; dx <= POLLUTION_RADIUS; dx++) {
          const nx = tx + dx; if (nx < 0 || nx >= GRID_SIZE) continue;
          const dist = Math.hypot(dx, dy);
          if (dist > POLLUTION_RADIUS) continue;
          const falloff = 1 - dist / POLLUTION_RADIUS;
          const j = idx(nx, ny);
          air[j] += def.pollution.air * mag * falloff;
          soil[j] += def.pollution.soil * mag * falloff;
          noise[j] += def.pollution.noise * mag * falloff;
        }
      }
    });
    // Part 4/4: education facility contributions, added onto the SAME existing air/soil/noise
    // Float32Arrays via the same falloff shape as industry above (§重要：既存公害システムを再利用
    // — no separate education-only pollution map is created). Disabled facilities contribute 0.
    educationFacilitiesRef.current.forEach((instance) => {
      if (!instance.enabled) return;
      const def = EDUCATION_FACILITIES[instance.definitionId];
      if (!def || !def.pollution) return;
      const { air: pa, soil: ps, noise: pn } = def.pollution;
      if (!pa && !ps && !pn) return;
      const cx = Math.round(instance.tx + instance.w / 2), cy = Math.round(instance.ty + instance.h / 2);
      for (let dy = -POLLUTION_RADIUS; dy <= POLLUTION_RADIUS; dy++) {
        const ny = cy + dy; if (ny < 0 || ny >= GRID_SIZE) continue;
        for (let dx = -POLLUTION_RADIUS; dx <= POLLUTION_RADIUS; dx++) {
          const nx = cx + dx; if (nx < 0 || nx >= GRID_SIZE) continue;
          const dist = Math.hypot(dx, dy);
          if (dist > POLLUTION_RADIUS) continue;
          const falloff = 1 - dist / POLLUTION_RADIUS;
          const j = idx(nx, ny);
          air[j] += pa * falloff;
          soil[j] += ps * falloff;
          noise[j] += pn * falloff;
        }
      }
    });
  }, []);

  // pollution -> residential growth: high soil pollution lowers land value/demand, so tiles
  // with heavy nearby industry grow slower (design doc §2 "住宅Lotの地価・需要を下げる").
  const pollutionGrowthFactor = (i) => Math.max(0.15, 1 - pollutionRef.current.soil[i] * 0.55);

  const syncPollutionOverlay = useCallback(() => {
    const t = threeRef.current; if (!t?.pollutionMesh) return;
    const { air, soil, noise } = pollutionRef.current;
    const mesh = t.pollutionMesh;
    const dummyM = new THREE.Object3D();
    const col = new THREE.Color();
    const POLLUTION_COLOR_LOW = new THREE.Color(0x4fd07f);
    const POLLUTION_COLOR_MID = new THREE.Color(0xe0c840);
    const POLLUTION_COLOR_HIGH = new THREE.Color(0xe0544a);
    let count = 0;
    for (let ty = 0; ty < GRID_SIZE; ty++) for (let tx = 0; tx < GRID_SIZE; tx++) {
      const i = idx(tx, ty);
      const score = Math.min(1, air[i] * 0.35 + soil[i] * 0.4 + noise[i] * 0.25);
      if (score < 0.04) continue;
      dummyM.position.set(tileWorldX(tx), ROAD_TOP_Y + 0.06, tileWorldZ(ty));
      dummyM.rotation.set(0, 0, 0); dummyM.scale.set(1, 1, 1); dummyM.updateMatrix();
      mesh.setMatrixAt(count, dummyM.matrix);
      // green (low) -> yellow -> red (high), matching the "suitability" color language in the design doc
      if (score < 0.5) col.lerpColors(POLLUTION_COLOR_LOW, POLLUTION_COLOR_MID, score * 2);
      else col.lerpColors(POLLUTION_COLOR_MID, POLLUTION_COLOR_HIGH, (score - 0.5) * 2);
      mesh.setColorAt(count, col);
      count++;
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, []);

  // ============ Phase 6: cargo hubs / transport distance ============
  const nearestHubDistance = useCallback((tx, ty) => {
    let min = Infinity;
    cargoHubsRef.current.forEach((_, i) => {
      const hx = i % GRID_SIZE, hy = Math.floor(i / GRID_SIZE);
      const d = Math.hypot(hx - tx, hy - ty);
      if (d < min) min = d;
    });
    return min;
  }, []);

  // Real road pathfinding per Lot-pair per tick would be expensive, so distance is a straight-line
  // proxy (design doc §6 explicitly allows this: re-evaluate only on Lot creation/road edits/batch,
  // never every frame) — UNLESS both ends are within reach of the freight-hub network, in which
  // case two hubs anywhere in the city connect for one small fixed cost, per §6.
  const computeTransportDistance = useCallback((ax, ay, bx, by) => {
    const direct = Math.hypot(ax - bx, ay - by);
    if (cargoHubsRef.current.size < 2) return direct;
    const viaHub = nearestHubDistance(ax, ay) + nearestHubDistance(bx, by) + 3 * HUB_DISCOUNT;
    return Math.min(direct, viaHub);
  }, [nearestHubDistance]);

  const nearestProducerDistance = useCallback((resourceId, tx, ty) => {
    let min = Infinity;
    industryDataRef.current.forEach((data, i) => {
      const def = INDUSTRY_BUILDINGS[data.buildingDefId];
      if (!def || !(def.produces || []).some((p) => p.id === resourceId)) return;
      const jx = i % GRID_SIZE, jy = Math.floor(i / GRID_SIZE);
      const d = computeTransportDistance(tx, ty, jx, jy);
      if (d < min) min = d;
    });
    return Number.isFinite(min) ? min : 20; // no local producer -> treat as an import from outside the city
  }, [computeTransportDistance]);

  const syncHubMeshes = useCallback(() => {
    const t = threeRef.current; if (!t?.hubMesh) return;
    const mesh = t.hubMesh; const dummyM = new THREE.Object3D(); let count = 0;
    cargoHubsRef.current.forEach((_, i) => {
      const tx = i % GRID_SIZE, ty = Math.floor(i / GRID_SIZE);
      dummyM.position.set(tileWorldX(tx), 0, tileWorldZ(ty));
      dummyM.rotation.set(0, 0, 0); dummyM.scale.set(1, 1, 1); dummyM.updateMatrix();
      mesh.setMatrixAt(count++, dummyM.matrix);
    });
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
  }, []);

  // ============ Phase 3: industry suitability overlay ============
  // score(tile) = w1*labor + w2*rawResourceRichness + w3*transitBonus, per design doc §3 — shown
  // as a colored overlay on ROAD tiles only, while the industrial zone tool is selected.
  const computeSuitability = useCallback((tx, ty) => {
    const grid = gridRef.current, level = levelRef.current;
    let laborRaw = 0;
    for (let dy = -SUITABILITY_RADIUS; dy <= SUITABILITY_RADIUS; dy++) {
      const ny = ty + dy; if (ny < 0 || ny >= GRID_SIZE) continue;
      for (let dx = -SUITABILITY_RADIUS; dx <= SUITABILITY_RADIUS; dx++) {
        const nx = tx + dx; if (nx < 0 || nx >= GRID_SIZE) continue;
        const dist = Math.hypot(dx, dy); if (dist > SUITABILITY_RADIUS) continue;
        const j = idx(nx, ny);
        if (grid[j] === TILE_RES) laborRaw += (level[j] + 1) * (1 - dist / SUITABILITY_RADIUS);
      }
    }
    let resourceRaw = 0;
    industryDataRef.current.forEach((data, j) => {
      const def = INDUSTRY_BUILDINGS[data.buildingDefId];
      if (!def || def.category !== 'extraction') return;
      const jx = j % GRID_SIZE, jy = Math.floor(j / GRID_SIZE);
      const dist = Math.hypot(jx - tx, jy - ty);
      if (dist > SUITABILITY_RADIUS) return;
      resourceRaw += Math.max(1, level[j] || 1) * (1 - dist / SUITABILITY_RADIUS);
    });
    const transitBonus = nearestHubDistance(tx, ty) <= SUITABILITY_RADIUS ? 1 : 0;
    const labor = laborRaw / (laborRaw + 12);
    const resource = resourceRaw / (resourceRaw + 6);
    return Math.min(1, SUITABILITY_WEIGHTS.labor * labor + SUITABILITY_WEIGHTS.resource * resource + SUITABILITY_WEIGHTS.transit * transitBonus);
  }, [nearestHubDistance]);

  const syncSuitabilityOverlay = useCallback(() => {
    const t = threeRef.current; if (!t?.suitabilityMesh) return;
    const grid = gridRef.current;
    const mesh = t.suitabilityMesh;
    const dummyM = new THREE.Object3D();
    const col = new THREE.Color();
    const LOW = new THREE.Color(0xe0544a), MID = new THREE.Color(0xe0c840), HIGH = new THREE.Color(0x4fd07f);
    let count = 0;
    for (let ty = 0; ty < GRID_SIZE; ty++) for (let tx = 0; tx < GRID_SIZE; tx++) {
      const i = idx(tx, ty);
      if (grid[i] !== TILE_ROAD) continue;
      const score = computeSuitability(tx, ty);
      dummyM.position.set(tileWorldX(tx), ROAD_TOP_Y + 0.07, tileWorldZ(ty));
      dummyM.rotation.set(0, 0, 0); dummyM.scale.set(1, 1, 1); dummyM.updateMatrix();
      mesh.setMatrixAt(count, dummyM.matrix);
      if (score < 0.5) col.lerpColors(LOW, MID, score * 2);
      else col.lerpColors(MID, HIGH, (score - 0.5) * 2);
      mesh.setColorAt(count, col);
      count++;
    }
    mesh.count = count;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
  }, [computeSuitability]);

  // show/hide the suitability overlay purely based on which tool is selected (design doc §3)
  useEffect(() => {
    const t = threeRef.current; if (!t?.suitabilityMesh) return;
    if (tool === 'zone_ind') { syncSuitabilityOverlay(); t.suitabilityMesh.visible = true; }
    else t.suitabilityMesh.visible = false;
  }, [tool, syncSuitabilityOverlay]);

  // ============ Phase 4/5/7: production chains, education matching, profitability ============
  // One combined batch pass (same cadence as pollution, every POLLUTION_TICK_EVERY-equivalent
  // ticks — see the growth tick below) since all three read the same per-lot data and a shared
  // city-wide resourceMarket snapshot; splitting them into separate passes would mean redoing the
  // same industryDataRef.forEach multiple times per tick for no benefit.
  const runProductionTick = useCallback(() => {
    const level = levelRef.current;
    const pool = eduPoolRef.current;
    EDU_TIERS.forEach((tier) => { pool[tier] = Math.round(popRef.current * EDU_TIER_SHARE[tier]); });

    // pass 1: city-wide potential supply/demand per resource (spatial hauling is simplified to
    // "is there enough of this resource anywhere in the city" rather than true per-lot logistics —
    // §6's cargo/transport-distance system prices the input, but doesn't gate availability)
    const market = {};
    Object.keys(RESOURCES).forEach((rid) => { market[rid] = { supply: 0, demand: 0 }; });
    industryDataRef.current.forEach((data, i) => {
      const def = INDUSTRY_BUILDINGS[data.buildingDefId]; if (!def) return;
      const lvl = Math.max(1, level[i] || 1);
      (def.produces || []).forEach((p) => { market[p.id].supply += p.rate * lvl; });
      (def.needs || []).forEach((n) => { market[n.id].demand += n.rate * lvl; });
    });
    Object.keys(market).forEach((rid) => {
      const m = market[rid];
      m.fulfillment = m.demand > 0 ? Math.min(1, m.supply / m.demand) : 1;
      const base = RESOURCES[rid].price;
      m.price = m.demand > 0 ? base * (1.15 - 0.3 * Math.min(1, m.supply / Math.max(0.001, m.demand))) : base * 0.9;
    });
    resourceMarketRef.current = market;

    // pass 2: education/employment fill rate per eduReq tier (city-wide pool, no per-school
    // catchment yet — see design doc §4 note on introducing a school system later)
    const requiredByTier = { none: 0, low: 0, mid: 0, high: 0 };
    industryDataRef.current.forEach((data) => {
      const def = INDUSTRY_BUILDINGS[data.buildingDefId]; if (!def) return;
      requiredByTier[def.eduReq] += data.employees.required;
    });
    const fillRatioByTier = {};
    EDU_TIERS.forEach((tier) => { fillRatioByTier[tier] = requiredByTier[tier] > 0 ? Math.min(1, pool[tier] / requiredByTier[tier]) : 1; });

    // pass 3: per-lot efficiency -> revenue/cost/profit (design doc §5 formula)
    const tax = Math.max(TAX_MIN, Math.min(TAX_MAX, (taxRef.current ?? 10) / 100));
    const utilityBonus = UTILITY_DISCOUNT_MAX_BONUS * 0.5; // no utility-rate slider yet; assumes a mid setting
    let cityIndustryProfit = 0, totalRequired = 0, totalFilled = 0;
    industryDataRef.current.forEach((data, i) => {
      const def = INDUSTRY_BUILDINGS[data.buildingDefId]; if (!def) return;
      const lvl = Math.max(1, level[i] || 1);
      data.employees.filled = Math.round(data.employees.required * fillRatioByTier[def.eduReq]);
      // Prompt 5, Step3: mirror the REAL Citizen ids currently hired at this tile's bound
      // Workplace (Citizen.workplaceId -> Workplace -> this tile) — never a fabricated count.
      // workplaceTileMapRef/workplacesRef stay small (§禁止事項4/5), so this per-lot lookup is
      // cheap (one Map.get + one Set.size), not a citizen scan.
      const boundWpId = workplaceTileMapRef.current.get(i);
      const boundWp = boundWpId ? workplacesRef.current.get(boundWpId) : null;
      data.employees.citizenIds = boundWp ? Array.from(boundWp.employees) : [];
      totalRequired += data.employees.required; totalFilled += data.employees.filled;
      const fillRate = data.employees.required > 0 ? data.employees.filled / data.employees.required : 1;
      let inputFactor = 1;
      (def.needs || []).forEach((n) => { inputFactor = Math.min(inputFactor, market[n.id].fulfillment); });
      const happiness = 0.7; // no worker-happiness model yet; flat placeholder
      const efficiency = Math.max(0, (1 + utilityBonus) * happiness * fillRate * inputFactor);

      const producedVolume = (def.produces || []).reduce((s, p) => s + p.rate * lvl * efficiency, 0);
      const avgPrice = (def.produces || []).length
        ? def.produces.reduce((s, p) => s + (market[p.id]?.price || RESOURCES[p.id].price), 0) / def.produces.length : 0;
      const revenue = producedVolume * avgPrice;

      const soilPenalty = 1 + pollutionRef.current.soil[i] * 0.4; // dirtier land -> lower value -> higher relative rent, per §5
      const rent = 6 * lvl * soilPenalty;
      const tx = i % GRID_SIZE, ty = Math.floor(i / GRID_SIZE);
      let inputCost = 0;
      (def.needs || []).forEach((n) => {
        const price = market[n.id]?.price || RESOURCES[n.id].price;
        const dist = nearestProducerDistance(n.id, tx, ty);
        inputCost += n.rate * lvl * price * 0.4 + n.rate * lvl * dist * TRANSPORT_UNIT_COST;
      });
      const maintenance = 2 * lvl;
      const utilityCost = 3 * lvl * (1 - utilityBonus);
      const cost = rent + inputCost + maintenance + utilityCost;
      const profit = revenue - cost - Math.max(0, revenue - cost) * tax;

      data.profitability = profit;
      // Step5/10: real per-tick financial + logistics detail for the Industrial Inspector — all
      // derived from the SAME revenue/cost numbers just computed above, never a separate model.
      data.revenueToday = revenue;
      data.costToday = cost;
      data.cumulativeProfit = (data.cumulativeProfit || 0) + profit;
      const transport = { inputs: {} };
      (def.needs || []).forEach((n) => {
        const dist = nearestProducerDistance(n.id, tx, ty);
        transport.inputs[n.id] = { distance: Math.round(dist * 10) / 10, cost: Math.round(n.rate * lvl * dist * TRANSPORT_UNIT_COST * 10) / 10 };
      });
      data.transport = transport;
      data.storage = data.storage || {};
      (def.produces || []).forEach((p) => {
        const cap = (def.capacityPerLevel || 9999) * lvl;
        data.storage[p.id] = Math.min(cap, (data.storage[p.id] || 0) + p.rate * lvl * efficiency);
      });
      cityIndustryProfit += profit;
    });
    cityIndustryProfitRef.current = cityIndustryProfit;
    industryJobsRef.current = { required: totalRequired, filled: totalFilled };
  }, [nearestProducerDistance]);

  // ============ Citizen/Household spawning (Part 2) ============
  // Seeds new Citizen+Household entities up to a capacity target. Called once at startup (from
  // the existing population estimate, as the design doc explicitly allows) and incrementally as
  // residential capacity grows — never used to recompute population FROM afterward.
  const spawnCitizens = useCallback((count, homePool) => {
    if (count <= 0) return;
    const now = gameClockRef.current.getEpochMs();
    let created = 0;
    while (created < count) {
      const householdSize = 1 + Math.floor(Math.random() * 4);
      const home = homePool.length ? homePool[Math.floor(Math.random() * homePool.length)] : null;
      const household = createHousehold({ homeId: home });
      const members = [];
      for (let m = 0; m < householdSize && created < count; m++) {
        const ageRoll = Math.random();
        let ageDays;
        if (ageRoll < 0.15) ageDays = Math.random() * AGE_GROUP_START_DAY.Teen;
        else if (ageRoll < 0.30) ageDays = AGE_GROUP_START_DAY.Teen + Math.random() * AGE_STAGE_DAYS.teenToAdult;
        else if (ageRoll < 0.85) ageDays = AGE_GROUP_START_DAY.Adult + Math.random() * AGE_STAGE_DAYS.adultToElderly;
        else ageDays = AGE_GROUP_START_DAY.Elderly + Math.random() * 200;
        const birthTime = now - ageDays * 86400000;
        // Part 3: constrain the initial random education roll to what's plausible for the age
        // group being spawned (a Child can't already hold a university degree) — this only scopes
        // the BOOTSTRAP roll for citizens who "lived a life offscreen" before the game started; it
        // does not touch createCitizen() itself or the ongoing progression logic below, which is
        // entirely event-driven (design doc's "学歴を完全ランダム決定" ban is about that ongoing
        // progression, not this one-time seed).
        const education = pickPlausibleEducationForAge(getAgeGroup(ageDays));
        const citizen = createCitizen({ birthTime, householdId: household.id, homeId: home, education });
        refreshCitizenAgeGroup(citizen, now);
        initializeCitizenLifecycle(gameClockRef.current, simManagerRef.current, householdsRef.current, citizen);
        // Part 4: give bootstrapped Adults/Elderly a job (or Retired/Unemployed status) and a
        // running PLAN_DAY chain right away, exactly like education is bootstrapped above —
        // ongoing occupation changes past this point are entirely event-driven (§Job Matching).
        bootstrapOccupation(gameClockRef.current, simManagerRef.current, citizen, workplacesRef.current);
        // Part 5: every spawned Citizen starts its own recurring HEALTH_CHECK chain right away,
        // exactly like education/occupation are bootstrapped above (§Health/§Migration/§Death all
        // ride on this one chain — nothing here scans citizensRef every tick).
        bootstrapHealth(gameClockRef.current, simManagerRef.current, citizen);
        citizensRef.current.set(citizen.id, citizen);
        livingCitizenCountRef.current++;
        members.push(citizen.id);
        created++;
      }
      household.members = members;
      // Part 4: per-household housing cost — a real function of household size + randomness,
      // never a flat citywide "building数 × 固定値" figure (§Household経済 forbids that).
      household.housingCost = 6 + members.length * 3 + Math.random() * 8;
      householdsRef.current.set(household.id, household);
    }
  }, []);

  // ============ Workplace supply (Part 4) ============
  // Tops up Workplace capacity per jobLevel as the (estimated) population grows — Workplaces are
  // never removed, this is a rough population-share
  // target (not a real census over citizensRef), and a future commercial/industrial building
  // placement tool can replace this wholesale without touching any matching/event logic.
  const ensureWorkplaceSupply = useCallback((targetPopulation) => {
    const targetJobs = targetPopulation * 0.55; // rough city-sim norm: ~55% of population holds a job
    Object.entries(JOB_LEVEL_DEFS).forEach(([jobLevel, def]) => {
      const demand = targetJobs * def.shareOfJobs;
      let totalCap = 0;
      workplacesRef.current.forEach((wp) => { if (wp.jobLevel === jobLevel) totalCap += wp.capacity; });
      if (totalCap < demand) {
        const workplace = createWorkplace({ jobLevel });
        workplacesRef.current.set(workplace.id, workplace);
      }
    });
    // Ground as many Workplace records as possible onto the real COM/IND tiles gathered by this
    // tick's grid scan (§fix: Workplaceが実Buildingタイルに未接続). Population-driven capacity
    // above decides HOW MANY Workplaces exist; this only decides which ones point at a real tile.
    // If there are more candidate tiles than currently-unbound Workplaces, the leftover tiles
    // simply retry next tick (they stay in a fresh pendingJobTilesRef next scan since they're
    // still absent from workplaceTileMapRef) — never a partial/duplicate binding.
    if (pendingJobTilesRef.current.length) {
      const unbound = [];
      workplacesRef.current.forEach((wp) => { if (wp.buildingId == null) unbound.push(wp); });
      let ui = 0;
      pendingJobTilesRef.current.forEach((tileIdx) => {
        if (workplaceTileMapRef.current.has(tileIdx)) return; // already bound (e.g. duplicate entry this tick)
        if (ui >= unbound.length) return; // no unbound Workplace left this tick — retried next tick
        const wp = unbound[ui++];
        wp.buildingId = tileIdx;
        workplaceTileMapRef.current.set(tileIdx, wp.id);
      });
      pendingJobTilesRef.current = [];
    }
  }, []);

  // ============ Lifecycle/School event wiring (Part 3) ============
  // SimulationManager.onEvent is a single slot (see Part 1's class def) — this is where Part 3
  // claims it, exactly as the Part 1 comment anticipated ("Part 2+ registers real logic via
  // sim.onEvent"). Registered once; the closure reads every ref's .current live at CALL time
  // (never captured), so it always sees the current Maps regardless of render timing.
  useEffect(() => {
    // Part 4: handleWorkplaceEvent is wired ALONGSIDE handleLifecycleEvent — both run, in order,
    // off the SAME event (e.g. GRADUATE/BECOME_ELDERLY are read by Part 3 first, then Part 4 acts
    // on whatever Part 3 just decided) — see the comments inside handleWorkplaceEvent itself.
    simManagerRef.current.onEvent = (event) => {
      const ctx = {
        clock: gameClockRef.current,
        sim: simManagerRef.current,
        citizens: citizensRef.current,
        households: householdsRef.current,
        educationFacilities: educationFacilitiesRef.current,
        workplaces: workplacesRef.current,
        // Prompt 2, Step5-7: real Store lookup (see createStore/findStoreForCitizen). Referenced
        // here via closure only — findStoreForCitizen is declared further down in this same
        // component function, but this arrow function isn't actually invoked until a later event
        // fires (well after the whole render body has run), so the binding is always resolved by
        // then. Deliberately NOT added to this effect's dependency array for the same reason
        // `workplaces`/`households` above aren't: they're refs/functions read at call time, not
        // values this effect needs to re-run for.
        stores: commercialDataRef.current,
        findStoreForCitizen: (citizen) => (typeof findStoreForCitizen === 'function' ? findStoreForCitizen(citizen) : null),
        // Part 5 hooks — see getEnvironmentAt/findHospitalTile/findShelterTile/onPopulationChange
        // definitions below (component scope) for what each currently resolves to.
        getEnvironmentAt,
        findHospitalTile: findHospitalTileImpl,
        findShelterTile: findShelterTileImpl,
        onPopulationChange: (delta) => { livingCitizenCountRef.current = Math.max(0, livingCitizenCountRef.current + delta); },
      };
      handleLifecycleEvent(event, ctx);
      handleWorkplaceEvent(event, ctx);
      handleHealthEvent(event, ctx);
    };
  }, [getEnvironmentAt]);

  // ============ Game Clock / Simulation loop (Part 1) ============
  // Its own setInterval — deliberately separate from the Three.js render loop (rAF) AND from the
  // existing growth/economy tick's own interval below. speed/running change the CLOCK's rate
  // (timeScale) and whether it's paused, not how often this interval fires.
  useEffect(() => {
    const clock = gameClockRef.current, sim = simManagerRef.current;
    clock.paused = !running;
    clock.timeScale = speed;
    const id = setInterval(() => {
      clock.advance(performance.now());
      sim.updateTo(clock.gameTimeMs);
      const date = clock.getDate();
      setClockDisplay((prev) => (
        prev.second === date.second && prev.minute === date.minute && prev.hour === date.hour && prev.day === date.day
          ? prev : date
      ));
    }, GAME_CLOCK_INTERVAL_MS);
    return () => clearInterval(id);
  }, [running, speed]);

  // Part 3/4: recompute the education-facility city-effects aggregate whenever a facility is
  // placed, removed, or gets an upgrade installed (all three bump eduFacilityVersion). This is a
  // full from-scratch recompute each time (see computeEducationCityEffects), so it never drifts.
  useEffect(() => {
    const aggregate = computeEducationCityEffects(educationFacilitiesRef.current);
    educationCityEffectsRef.current = aggregate;
    setEduCityEffectsSummary(aggregate);
  }, [eduFacilityVersion]);

  // ============ growth + economy tick ============
  useEffect(() => {
    if (!running) return;
    const intervalMs = speed === 2 ? 220 : 500;
    const id = setInterval(() => {
      recomputeConnectivity();
      const grid = gridRef.current, level = levelRef.current, lotIdGrid = lotIdGridRef.current, tax = taxRef.current;
      let resSum = 0, comSum = 0, indSum = 0, roadCount = 0, buildingCount = 0;
      const resHomePool = []; // tile indices with residential capacity, used to seed new Citizens' homeId (Part 2)
      const effectiveGrowChance = Math.max(0.03, GROW_CHANCE * (1 - tax * 2.2));

      for (let ty = 0; ty < GRID_SIZE; ty++) for (let tx = 0; tx < GRID_SIZE; tx++) {
        const i = idx(tx, ty);
        const v = grid[i];
        if (v === TILE_ROAD) { roadCount++; continue; }
        if (!isZoneType(v)) continue;
        if (lotIdGrid[i] !== -1) continue; // multi-tile lots are grown separately below
        // nearby industrial pollution lowers residential land value/demand (design doc §2) —
        // industrial tiles themselves are unaffected here (rent impact comes in a later phase).
        const localGrowChance = v === TILE_RES ? effectiveGrowChance * pollutionGrowthFactor(i) : effectiveGrowChance;
        if (level[i] < MAX_LEVEL && hasConnectedRoadNeighbor(tx, ty) && Math.random() < localGrowChance) {
          level[i] += 1;
          if (v === TILE_IND) assignIndustryBuilding(i, level[i]);
        }
        if (level[i] > 0) buildingCount += level[i];
        if (v === TILE_RES) { resSum += level[i]; if (level[i] > 0) resHomePool.push(i); }
        else if (v === TILE_COM) {
          comSum += level[i];
          // Prompt 2, Step5-7: this tile IS the real store Building — piggybacked on the grid
          // scan this tick already does, never a second full-grid pass (§禁止事項1).
          if (level[i] > 0) {
            const storeId = `store_${i}`;
            let store = commercialDataRef.current.get(storeId);
            if (!store) { store = createStore({ id: storeId, tx, ty, level: level[i] }); commercialDataRef.current.set(storeId, store); }
            else if (store.level !== level[i]) { store.level = level[i]; store.maxInventory = 200 + (level[i] - 1) * 120; store.capacity = 30 + level[i] * 15; }
            // a built commercial tile is also a real place people can WORK (shop staff/offices),
            // not just shop — see ensureWorkplaceSupply's reconciliation of this list.
            if (!workplaceTileMapRef.current.has(i)) pendingJobTilesRef.current.push(i);
          }
        }
        else if (v === TILE_IND) {
          indSum += level[i];
          // industrial tiles are the other real job-capable Building kind.
          if (level[i] > 0 && !workplaceTileMapRef.current.has(i)) pendingJobTilesRef.current.push(i);
        }
      }
      // daily restock/reset (Step6) — commercialDataRef stays small (one entry per built
      // commercial tile), so a full pass over just this Map every tick is cheap, unlike a
      // per-Citizen scan.
      {
        const today = Math.floor(gameClockRef.current.getEpochMs() / 86400000);
        commercialDataRef.current.forEach((store, storeKey) => {
          if (store.lastRestockDay === today) return;
          // Prompt 5, Step2/6/10: close out yesterday's real finances BEFORE resetting counters —
          // expenses = actual employee wages (real Citizen.salary via the bound Workplace) +
          // actual restock cost (units actually bought back). Never a fixed placeholder.
          const tileIdx = store.tx != null ? idx(store.tx, store.ty) : -1;
          const wpId = tileIdx >= 0 ? workplaceTileMapRef.current.get(tileIdx) : null;
          const wp = wpId ? workplacesRef.current.get(wpId) : null;
          let wageCost = 0;
          if (wp) {
            wp.employees.forEach((cid) => {
              const c = citizensRef.current.get(cid);
              if (c) wageCost += (c.salary || 0);
            });
            if (!store.ownerId && wp.employees.size > 0) store.ownerId = wp.employees.values().next().value;
          }
          const unitsToRestock = Math.max(0, store.maxInventory - store.inventory);
          const restockCost = Math.min(unitsToRestock, Math.round(store.maxInventory * 0.6)) * 2; // ¥2/unit wholesale cost
          store.expensesToday = Math.round(wageCost + restockCost);
          store.profitToday = Math.round(store.revenueToday - store.expensesToday);
          store.money = Math.max(0, store.money + store.profitToday);
          store.lastRestockDay = today;
          store.customerCountToday = 0;
          store.revenueToday = 0;
          store.inventory = Math.min(store.maxInventory, store.inventory + Math.round(store.maxInventory * 0.6));
        });
      }

      // batch-recompute pollution every few ticks rather than every tick (design doc §2). Part 5's
      // household-economy aggregate rides the exact same cadence, for the same reason (design doc
      // §Economy allows connecting to real Household state without a full per-frame census).
      pollutionTickRef.current++;
      if (pollutionTickRef.current >= 8) {
        pollutionTickRef.current = 0;
        computePollution();
        if (showPollutionRef.current) syncPollutionOverlay();
        // production chains / education matching / profitability run on the same cadence,
        // since they read the freshly-recomputed pollution (soil -> rent) and industryDataRef
        runProductionTick();
        if (toolRef.current === 'zone_ind') syncSuitabilityOverlay();
        let hhWealth = 0, hhIncome = 0;
        householdsRef.current.forEach((h) => { hhWealth += h.wealth; hhIncome += h.income; });
        householdEconomyRef.current = { wealth: hhWealth, income: hhIncome };
      }

      let lotPop = 0, lotJobs = 0;
      lotsRef.current.forEach((lot) => {
        const spec = RES_LOT_TYPES[lot.type];
        buildingCount += lot.w * lot.h * Math.max(1, lot.level);
        const unlocked = popRef.current >= spec.unlockPop;
        if (unlocked && lot.level < 3 && lotHasRoadAccess(lot.position.x, lot.position.z, lot.footprint.width, lot.footprint.depth) && Math.random() < effectiveGrowChance) {
          lot.level += 1;
          rebuildLotGroup(lot);
        }
        if (lot.level > 0) {
          const growT = (lot.level - 1) / 2;
          lotPop += Math.round(spec.pop[0] + (spec.pop[1] - spec.pop[0]) * growT);
          lotJobs += Math.round(spec.jobs[0] + (spec.jobs[1] - spec.jobs[0]) * growT);
          resHomePool.push(lot.id);
        }
      });

      // ---- Citizen/Household population (Part 2) ----
      // capacityPopulation is the SAME formula the game used to treat as "the" population before
      // Part 2 — now it's only a capacity target that new Citizens get seeded up to. The actual
      // population stat is always the living Citizen count (see below), never this formula.
      const capacityPopulation = resSum * 4 + lotPop;
      // Part 5: education facilities are never auto-built by population growth (§禁止：教育施設が
      // 勝手に建つ) — only placeEducationFacility (player action) creates them. Citizens simply
      // wait (SEEKING_SCHOOL-equivalent retry loop) if capacity is short; see scheduleSchoolAttempt.
      // Part 4: cheap (iterates workplacesRef, which stays small).
      ensureWorkplaceSupply(capacityPopulation);
      if (!citizenSeedDoneRef.current) {
        citizenSeedDoneRef.current = true;
        if (capacityPopulation > 0) spawnCitizens(capacityPopulation, resHomePool);
      } else if (livingCitizenCountRef.current < capacityPopulation) {
        // capped per tick so a big rezoning doesn't spawn thousands of Citizens in one frame
        spawnCitizens(Math.min(60, capacityPopulation - livingCitizenCountRef.current), resHomePool);
      }

      // ---- Jobs / employment (Part 5): sourced directly from Workplace entities and their real
      // employee Sets, plus the existing industrial jobs tracker — never comSum*3+lotJobs building
      // arithmetic anymore (design doc §Jobs: "既存建物レベルから単純算出する方式をCitizen
      // simulationと矛盾しないよう整理"). workplacesRef stays small (ensureWorkplaceSupply tops it
      // up by job-level share, not by one workplace per citizen), so summing over it every tick is
      // cheap — the same cost class as the workplacesRef iteration ensureWorkplaceSupply
      // already does above.
      let workplaceCapacity = 0, workplaceFilled = 0;
      workplacesRef.current.forEach((wp) => { workplaceCapacity += wp.capacity; workplaceFilled += wp.employees.size; });
      const population = livingCitizenCountRef.current;
      const jobs = workplaceCapacity + industryJobsRef.current.required;
      const employedCitizens = workplaceFilled + industryJobsRef.current.filled;
      popRef.current = population;
      // Phase 7: industrial tax revenue comes from the per-lot profitability sim (runProductionTick)
      // instead of the flat indSum*3 job estimate used before; res/com income formula is unchanged.
      const industrialTax = Math.max(0, cityIndustryProfitRef.current) * 0.15;
      // Part 5 (§Economy): a small additional term derived from real Household wealth, on top of
      // the existing population/jobs-based formula — connects tax revenue to actual Citizen/
      // Household state without replacing the core economic model (§経済モデルを全面的に作り直す
      // 必要はありません).
      const householdTax = Math.max(0, householdEconomyRef.current.wealth) * 0.0008 * tax;
      const income = population * INCOME_PER_POP * tax + jobs * INCOME_PER_JOB * tax + industrialTax + householdTax;
      // Part 4/4: Education Upkeep — sum of enabled education facilities' current monthlyUpkeep
      // (already upgrade-adjusted by recalcEducationFacilityInstance). No per-citizen/per-student
      // dynamic scaling yet (§ただし市民数・学生数に応じた動的維持費計算はまだ行いません) — this is
      // just the defined monthly figures added into the existing treasury, unchanged otherwise.
      let educationUpkeep = 0;
      educationFacilitiesRef.current.forEach((inst) => { if (inst.enabled) educationUpkeep += inst.monthlyUpkeep; });
      const expenses = roadCount * ROAD_UPKEEP + buildingCount * BUILDING_UPKEEP + educationUpkeep;
      setStats((s) => ({ population, jobs, employedCitizens, tick: s.tick + 1 }));
      setBudget((b) => ({ treasury: b.treasury + income - expenses, income: Math.round(income), expenses: Math.round(expenses), net: Math.round(income - expenses), educationUpkeep: Math.round(educationUpkeep) }));
      threeRef.current?.syncInstances();
    }, intervalMs);
    return () => clearInterval(id);
  }, [running, speed, hasConnectedRoadNeighbor, recomputeConnectivity, lotHasRoadAccess, rebuildLotGroup, assignIndustryBuilding, computePollution, syncPollutionOverlay, runProductionTick, syncSuitabilityOverlay, spawnCitizens, ensureWorkplaceSupply]);

  // ============ Citizen display-position resolution (Part 4) ============
  // Resolves a citizen's homeId / workplaceId / schoolId / 'shop' anchor into a real (tx,ty) tile
  // on the actual grid. homeId is always a real placement (a raw tile index from resHomePool, or
  // a multi-tile lot id) — Workplace/School have no building placement yet (§Pathfinding /
  // createWorkplace's buildingId:null), so those get a DETERMINISTIC, stable, hash-picked tile
  // from the live pedestrian-walkable road network instead of a random/fabricated position; the
  // same workplace always resolves to the same spot for the whole game.
  const resolveAnchorTile = useCallback((kind, id) => {
    if (kind === 'home') {
      if (id == null) return null;
      if (typeof id === 'number') return { tx: id % GRID_SIZE, ty: Math.floor(id / GRID_SIZE) };
      const lot = lotsRef.current.get(id);
      return lot ? { tx: lot.gx, ty: lot.gy } : null;
    }
    // Fix (Prompt 2 follow-up): Store / Workplace / School destinations all resolve to their REAL
    // Building tile when one exists, before ever falling back to the hashed placeholder pool.
    // Each check includes a staleness guard (tile must still be the right zone type with
    // level>0) so a bulldozed/rezoned building never silently mis-points a citizen.
    if (typeof id === 'string' && id.startsWith('store_')) {
      const store = commercialDataRef.current.get(id);
      if (store) {
        const i = idx(store.tx, store.ty);
        if (gridRef.current[i] === TILE_COM && levelRef.current[i] > 0) return { tx: store.tx, ty: store.ty };
      }
    } else if (typeof id === 'string' && id.startsWith('wp_')) {
      const wp = workplacesRef.current.get(id);
      if (wp && wp.buildingId != null) {
        const bv = gridRef.current[wp.buildingId];
        if ((bv === TILE_COM || bv === TILE_IND) && levelRef.current[wp.buildingId] > 0) {
          return { tx: wp.buildingId % GRID_SIZE, ty: Math.floor(wp.buildingId / GRID_SIZE) };
        }
      }
    } else if (typeof id === 'number') {
      // Schools are keyed by a plain numeric facility id (facility.numericId) — the only "other"
      // destination kind that is ever a bare number — and have carried a real tx/ty since the
      // facility was first placed (createEducationFacilityInstance), so no staleness guard is
      // needed here: removeEducationFacility already clears citizen.currentSchoolId on demolition.
      const facility = educationFacilitiesRef.current.get(id);
      if (facility) return { tx: facility.tx, ty: facility.ty };
    }
    // Not yet building-backed (e.g. population-target Workplace slots beyond available real
    // tiles) or unresolvable — same stable hashed placeholder as before.
    const pool = threeRef.current?.pedTileListRef?.current;
    if (!pool || !pool.length) return null;
    const key = String(id ?? 'shop');
    const h = hash2(key.length * 97, key.charCodeAt(0) || 1);
    return pool[Math.floor(h * pool.length) % pool.length];
  }, []);

  // ---- Store selection (Prompt 2, Step 5) ----
  // Picks a real, open, in-stock, not-overcrowded store, preferring closer + better-stocked ones.
  // Bounded to a fixed number of candidates per call (§禁止事項1) even though the commercial
  // building count is already a small subset of all zoned tiles in practice.
  const findStoreForCitizen = useCallback((citizen) => {
    const stores = commercialDataRef.current;
    if (!stores.size) return null;
    const homeTile = resolveAnchorTile('home', citizen.homeId);
    if (!homeTile) return null;
    const nowMs = gameClockRef.current.getEpochMs();
    const hourOfDay = (nowMs % 86400000) / 3600000;
    let best = null, bestScore = -Infinity, checked = 0;
    for (const store of stores.values()) {
      if (++checked > 300) break;
      // stale-entry guard: the tile may have been bulldozed/rezoned since this store was created.
      if (gridRef.current[idx(store.tx, store.ty)] !== TILE_COM || levelRef.current[idx(store.tx, store.ty)] <= 0) continue;
      if (!storeIsOpenNow(store, hourOfDay) || !storeHasStock(store) || store.customerCountToday >= store.capacity) continue;
      const dist = Math.abs(store.tx - homeTile.tx) + Math.abs(store.ty - homeTile.ty);
      const score = -dist + (store.inventory / store.maxInventory) * 3 - store.customerCountToday * 0.1;
      if (score > bestScore) { bestScore = score; best = store; }
    }
    return best;
  }, [resolveAnchorTile]);

  // BFS over the pedestrian-walkable road graph (reuses pedRoadNeighbors — the SAME network
  // pedestrians already walk on; §Pathfinding forbids a separate road system). Only ever called
  // lazily, once per travelState, when a citizen actually needs to be displayed — never for all
  // citizens every frame (§禁止事項).
  const computeWalkingPath = useCallback((fromTile, toTile) => {
    if (!fromTile || !toTile) return fromTile ? [fromTile] : (toTile ? [toTile] : []);
    if (fromTile.tx === toTile.tx && fromTile.ty === toTile.ty) return [fromTile];
    const goalKey = `${toTile.tx},${toTile.ty}`;
    const visited = new Set([`${fromTile.tx},${fromTile.ty}`]);
    const cameFrom = new Map();
    const queue = [fromTile];
    let head = 0, found = false;
    while (head < queue.length) {
      const cur = queue[head++];
      if (`${cur.tx},${cur.ty}` === goalKey) { found = true; break; }
      for (const n of pedRoadNeighbors(cur.tx, cur.ty)) {
        const k = `${n.tx},${n.ty}`;
        if (visited.has(k)) continue;
        visited.add(k);
        cameFrom.set(k, cur);
        queue.push(n);
      }
      if (queue.length > GRID_SIZE * GRID_SIZE) break; // safety cap — whole grid is only 64x64
    }
    if (!found) return [fromTile, toTile]; // disconnected sidewalk network — straight-line fallback so display never crashes
    const path = [];
    let curKey = goalKey;
    let cur = { tx: toTile.tx, ty: toTile.ty };
    while (curKey !== `${fromTile.tx},${fromTile.ty}`) {
      path.push(cur);
      const prev = cameFrom.get(curKey);
      if (!prev) break;
      cur = prev; curKey = `${cur.tx},${cur.ty}`;
    }
    path.push(fromTile);
    path.reverse();
    return path;
  }, [pedRoadNeighbors]);

  const interpolatePathToWorld = useCallback((path, frac) => {
    if (!path || !path.length) return null;
    if (path.length === 1) return { worldX: tileWorldX(path[0].tx), worldZ: tileWorldZ(path[0].ty) };
    const segCount = path.length - 1;
    const segF = frac * segCount;
    const segIdx = Math.min(segCount - 1, Math.floor(segF));
    const localT = segF - segIdx;
    const a = path[segIdx], b = path[segIdx + 1];
    const ax = tileWorldX(a.tx), az = tileWorldZ(a.ty), bx = tileWorldX(b.tx), bz = tileWorldZ(b.ty);
    return { worldX: ax + (bx - ax) * localT, worldZ: az + (bz - az) * localT };
  }, [tileWorldX, tileWorldZ]);

  // The component-side binding of simulateCitizenUntil (Part 4 free function) to real
  // grid/road/lot data — this is what a near-camera Citizen's actual on-screen position would be
  // derived from (§Camera近接時 / §simulateCitizenUntil).
  const getCitizenDisplayState = useCallback((citizen) => {
    const now = gameClockRef.current.getEpochMs();
    const resolve = (anchor) => {
      if (anchor == null) return resolveAnchorTile('home', citizen.homeId);
      if (anchor === citizen.homeId) return resolveAnchorTile('home', anchor);
      return resolveAnchorTile('other', anchor) || resolveAnchorTile('home', citizen.homeId);
    };
    return simulateCitizenUntil(citizen, now, {
      resolveTile: resolve,
      computeWalkingPath: (fromAnchor, toAnchor) => computeWalkingPath(resolve(fromAnchor), resolve(toAnchor)),
      interpolatePath: interpolatePathToWorld,
    });
  }, [resolveAnchorTile, computeWalkingPath, interpolatePathToWorld]);

  // Cheap (no pathfinding, no simulateCitizenUntil) approximation of "where is this citizen right
  // now" used ONLY for nearest-citizen binding below — a real display position (with a walked
  // path) is exactly what getCitizenDisplayState already provides, but calling that for every
  // candidate citizen on every click would mean BFS pathfinding for anyone mid-commute, which
  // §禁止事項 rules out. This mirrors simulateCitizenUntil's own anchor fallback, just without
  // interpolating the in-transit fraction.
  const worldToTile = useCallback((point) => ({
    tx: Math.floor((point.x + (GRID_SIZE * TILE) / 2) / TILE),
    ty: Math.floor((point.z + (GRID_SIZE * TILE) / 2) / TILE),
  }), []);

  const approxCitizenAnchorTile = useCallback((citizen) => {
    const anchor = citizen.travelState ? citizen.travelState.from
      : (citizen.currentActivity === 'work' || citizen.currentActivity === 'shopping' || citizen.currentActivity === 'school')
        ? citizen.destinationId
        : citizen.homeId;
    if (anchor == null) return resolveAnchorTile('home', citizen.homeId);
    if (anchor === citizen.homeId) return resolveAnchorTile('home', anchor);
    return resolveAnchorTile('other', anchor) || resolveAnchorTile('home', citizen.homeId);
  }, [resolveAnchorTile]);

  // Binds a rendered pedestrian visual to a REAL, nearby Citizen entity instead of a fabricated
  // random profile (§カメラが近づいた場合 — "ランダムなPedestrianを作って...禁止" / §重要：本物の
  // Citizen). The binding is cached on the ped object (ped.citizenId) so re-clicking the same
  // pedestrian slot — or following it in §Follow Citizen camera mode — keeps showing the SAME
  // citizen, never a re-roll. A stale binding (the bound citizen died or migrated away) is
  // detected and rebound to the nearest still-resident living citizen instead.
  const bindCitizenToPed = useCallback((ped) => {
    const citizens = citizensRef.current;
    if (ped.citizenId) {
      const existing = citizens.get(ped.citizenId);
      if (existing && existing.alive && existing.cityResident) return existing;
      ped.citizenId = null; // previous binding died/migrated away — rebind below
    }
    const { tx: ptx, ty: pty } = worldToTile({ x: ped.worldX, z: ped.worldZ });
    let best = null, bestDist = Infinity;
    for (const c of citizens.values()) {
      if (!c.alive || !c.cityResident) continue;
      const anchor = approxCitizenAnchorTile(c);
      if (!anchor) continue;
      const dx = anchor.tx - ptx, dy = anchor.ty - pty;
      const d = dx * dx + dy * dy;
      if (d < bestDist) { bestDist = d; best = c; if (d === 0) break; }
    }
    if (best) ped.citizenId = best.id;
    return best;
  }, [worldToTile, approxCitizenAnchorTile]);

  // Part 5: normalizes getCitizenDisplayState's result — which is either a stationary tile
  // {tx,ty} (home/work/school/shop) or an in-transit world point {worldX,worldZ} produced by
  // interpolatePathToWorld — into a single world-space position. This is the ONE function the
  // pedestrian render loop uses to find out "where is this citizen right now"; it does no
  // pathfinding of its own, it only reads simulateCitizenUntil's already-computed answer.
  const getCitizenWorldPos = useCallback((citizen) => {
    const state = getCitizenDisplayState(citizen);
    if (!state) return null;
    if (typeof state.worldX === 'number') return { worldX: state.worldX, worldZ: state.worldZ };
    if (typeof state.tx === 'number') return { worldX: tileWorldX(state.tx), worldZ: tileWorldZ(state.ty) };
    return null;
  }, [getCitizenDisplayState, tileWorldX, tileWorldZ]);

  // The pedestrian spawn/update logic lives inside the big mount-time Three.js effect (a
  // separate closure created once on mount), while getCitizenWorldPos/approxCitizenAnchorTile are
  // recreated by React each render. Bridging them onto threeRef.current (the same pattern already
  // used elsewhere in this file, e.g. pedTileListRef/rebuildRoadTileList) keeps the mount effect
  // itself untouched while always giving it the latest, correctly-closed-over versions.
  useEffect(() => {
    if (!threeRef.current) return;
    threeRef.current.getCitizenWorldPos = getCitizenWorldPos;
    threeRef.current.approxCitizenAnchorTile = approxCitizenAnchorTile;
  }, [getCitizenWorldPos, approxCitizenAnchorTile]);

  // ---- Building-side occupancy query (Prompt 2, Step 10) ----
  // "誰が今この建物にいるか" for any of the three Building kinds this game has real entities for.
  // Workplace/School already track this as employees/enrolledStudents (an existing citizen there
  // is, in practice, there during their shift/school day — Part 3/4's own event chain is what
  // keeps activityStartTime/activityEndTime accurate); Store tracks it live via visitors
  // (added/removed exactly on GO_SHOPPING/LEAVE_SHOPPING above). None of these require scanning
  // the Citizen population — each Building's own Set is already the answer.
  const getBuildingOccupantsNow = useCallback((kind, id) => {
    if (kind === 'workplace') {
      const wp = workplacesRef.current.get(id);
      return wp ? Array.from(wp.employees) : [];
    }
    if (kind === 'school') {
      const facility = educationFacilitiesRef.current.get(id);
      return facility ? Array.from(facility.enrolledStudents) : [];
    }
    if (kind === 'store') {
      const store = commercialDataRef.current.get(id);
      return store ? Array.from(store.visitors) : [];
    }
    return [];
  }, []);

  // ---- Store/Workplace Inspector opener (fix: getBuildingOccupantsNow now actually feeds a UI
  // panel, not just internal logic) ----
  // A COM tile can be BOTH a real Store (shopping) and a real Workplace (jobs) at once — same
  // building, two roles — so this shows whichever of the two are actually bound to the clicked
  // tile. An IND tile can only be a Workplace (no Store system for industrial output).
  // Real Citizen -> employee-card shape, used by both Commercial and Industrial Inspectors
  // (§Step4: 名前/年齢/学歴/職種/給与/シフト/現在のActivity, all read off the real entity).
  const describeEmployeeForInspector = useCallback((citizenId) => {
    const c = citizensRef.current.get(citizenId);
    if (!c) return { id: citizenId, name: citizenId, age: '—', education: '—', jobLevel: '—', salary: 0, shift: '—', currentActivity: '—' };
    const now = gameClockRef.current.getEpochMs();
    const ageYears = Math.floor(getCitizenAgeDays(c, now) / 365);
    return {
      id: c.id, name: c.name, age: ageYears,
      education: EDUCATION_LABEL_JA[c.education] || c.education,
      jobLevel: c.actualJobLevel || '—',
      salary: c.salary || 0,
      shift: c.shift || '—',
      currentActivity: ACTIVITY_LABEL_JA[c.currentActivity] || c.currentActivity || '—',
    };
  }, []);

  const openStoreOrWorkplaceInspector = useCallback((tx, ty) => {
    const i = idx(tx, ty);
    const tv = gridRef.current[i];
    const storeId = `store_${i}`;
    const store = commercialDataRef.current.get(storeId);
    const wpId = workplaceTileMapRef.current.get(i);
    const workplace = wpId ? workplacesRef.current.get(wpId) : null;
    const employeeCards = workplace ? Array.from(workplace.employees).slice(0, 12).map(describeEmployeeForInspector) : [];

    if (tv === TILE_IND) {
      const industryData = industryDataRef.current.get(i);
      if (!industryData) { setStorePanel(null); return; }
      const def = INDUSTRY_BUILDINGS[industryData.buildingDefId];
      const lvl = Math.max(1, levelRef.current[i] || 1);
      const citizenIds = industryData.employees.citizenIds || [];
      setStorePanel({
        tx, ty, buildingKind: 'industrial',
        industrial: {
          buildingId: i, name: industryData.buildingDefId, category: def?.category || '—', level: lvl,
          status: citizenIds.length > 0 ? '稼働中' : '稼働停止（従業員不足）',
          requiredEmployees: industryData.employees.required, currentEmployees: citizenIds.length,
          deficit: Math.max(0, industryData.employees.required - citizenIds.length),
          employees: citizenIds.slice(0, 12).map(describeEmployeeForInspector),
          produces: (def?.produces || []).map((p) => ({ id: p.id, name: RESOURCES[p.id]?.name || p.id, rate: Math.round(p.rate * lvl * 100) / 100 })),
          needs: (def?.needs || []).map((n) => ({ id: n.id, name: RESOURCES[n.id]?.name || n.id, rate: Math.round(n.rate * lvl * 100) / 100 })),
          storage: Object.entries(industryData.storage || {}).map(([rid, qty]) => ({
            id: rid, name: RESOURCES[rid]?.name || rid, qty: Math.round(qty * 10) / 10,
            capacity: def?.capacityPerLevel ? def.capacityPerLevel * lvl : null,
          })),
          assetValue: Math.round(4000 * lvl + Math.max(0, industryData.cumulativeProfit || 0) * 0.1),
          cash: Math.round(Math.max(0, industryData.cumulativeProfit || 0)),
          revenueToday: Math.round(industryData.revenueToday || 0),
          expensesToday: Math.round(industryData.costToday || 0),
          profitToday: Math.round(industryData.profitability || 0),
          cumulativeProfit: Math.round(industryData.cumulativeProfit || 0),
          pollution: industryData.pollutionOutput,
          logistics: Object.entries((industryData.transport && industryData.transport.inputs) || {}).map(([rid, t]) => ({
            id: rid, name: RESOURCES[rid]?.name || rid, distance: t.distance, cost: t.cost,
          })),
          shipsTo: (def?.produces || []).map((p) => {
            const m = resourceMarketRef.current[p.id];
            return { id: p.id, name: RESOURCES[p.id]?.name || p.id, fulfillment: m ? Math.round(m.fulfillment * 100) : null };
          }),
        },
        commercial: null,
      });
      return;
    }

    if (!store && !workplace) { setStorePanel(null); return; }
    setStorePanel({
      tx, ty, buildingKind: 'commercial',
      commercial: store ? {
        businessId: store.businessId, buildingId: store.buildingId, shopType: store.shopType,
        shopTypeName: SHOP_TYPES[store.shopType]?.name || store.shopType,
        businessName: store.businessName, level: store.level,
        status: (storeIsOpenNow(store, gameClockRef.current.getDate().hour)) ? '営業中' : '営業時間外',
        openTime: store.openHour, closeTime: store.closeHour,
        requiredEmployees: store.requiredEmployees,
        currentEmployees: workplace ? workplace.employees.size : 0,
        deficit: Math.max(0, store.requiredEmployees - (workplace ? workplace.employees.size : 0)),
        employees: employeeCards,
        ownerName: store.ownerId ? (citizensRef.current.get(store.ownerId)?.name || store.ownerId) : '—',
        ownerId: store.ownerId,
        products: getStoreProductLines(store),
        inventory: store.inventory, maxInventory: store.maxInventory,
        customerCountToday: store.customerCountToday, currentVisitors: store.visitors.size, capacity: store.capacity,
        revenueToday: Math.round(store.revenueToday), expensesToday: Math.round(store.expensesToday),
        profitToday: Math.round(store.profitToday), revenueTotal: Math.round(store.revenueTotal),
        money: Math.round(store.money), assetValue: computeStoreAssetValue(store),
        visitorNames: getBuildingOccupantsNow('store', store.id).slice(0, 8).map(describeEmployeeForInspector),
      } : null,
      workplace: (!store && workplace) ? {
        id: workplace.id, jobLevel: workplace.jobLevel, salary: workplace.salary,
        filled: workplace.employees.size, capacity: workplace.capacity,
        employees: employeeCards,
      } : null,
    });
  }, [getBuildingOccupantsNow, describeEmployeeForInspector]);

  // §Step7/8: opens whichever Inspector owns a given tile — used by the Citizen Inspector's
  // "勤務先" back-link (a Workplace's buildingId is a real tile index, see ensureWorkplaceSupply).
  const openBuildingInspectorByTile = useCallback((tileIdx) => {
    if (tileIdx == null) return;
    const tx = tileIdx % GRID_SIZE, ty = Math.floor(tileIdx / GRID_SIZE);
    const eduId = eduFacilityIdGridRef.current[tileIdx];
    if (eduId !== -1) { openEducationFacilityInspector(eduId); setPedPanel(null); return; }
    setPedPanel(null);
    openStoreOrWorkplaceInspector(tx, ty);
  }, [openEducationFacilityInspector, openStoreOrWorkplaceInspector]);

  // §Step8: opens the Citizen Inspector for a given id from inside a Building Inspector
  // (employee/visitor list click) — reuses describeCitizenForPanel, never a fabricated profile.
  // (defined further below, right after describeCitizenForPanel itself — see that spot.)

  const OCCUPATION_LABEL_JA = { Employee: '会社員', Student: '学生', Unemployed: '求職中', Retired: '退職者' };


  const ACTIVITY_LABEL_JA = {
    home: '自宅にいる', commute: '移動中', work: '仕事中', school: '登校中', shopping: '買い物中', idle: '待機中',
    job_search: '求職中', hospital: '入院中', hospital_outside_city: '市外の病院で療養中', moved_away: '転出済み', deceased: '故人',
  };
  const STATUS_LABEL_JA = { SICK: '病気', WEAKENED: '衰弱', INJURED: '負傷', HOMELESS: 'ホームレス', ANXIETY: '不安' };
  const AGE_GROUP_LABEL_JA = { Child: '子供', Teen: 'ティーン', Adult: '成人', Elderly: '高齢者' };
  const EDUCATION_LABEL_JA = { NONE: 'なし', LOW: '低学歴', AVERAGE: '平均', HIGH: '高学歴', VERY_HIGH: '最高学歴' };
  // Peeks (never removes) the earliest still-queued SimulationManager event for this citizen —
  // used only by the Inspector's "Next Event" field, an O(queue length) scan done at most once
  // per panel-open, never per frame.
  const peekNextEventForCitizen = useCallback((citizenId) => {
    const queue = simManagerRef.current.eventQueue;
    let best = null;
    for (let i = 0; i < queue.length; i++) {
      if (queue[i].citizenId === citizenId && (!best || queue[i].time < best.time)) best = queue[i];
    }
    return best;
  }, []);
  // §Citizen Inspector — a real Citizen entity's full life state, never randomProfile() (§重要：
  // 本物のCitizen). Every field here reads directly off the actual entity/household/workplace/
  // school records, exactly as they exist right now.
  const describeCitizenForPanel = useCallback((citizen) => {
    const now = gameClockRef.current.getEpochMs();
    const ageYears = Math.floor(getCitizenAgeDays(citizen, now) / 365);
    const occLabel = citizen.alive
      ? (citizen.cityResident ? (OCCUPATION_LABEL_JA[citizen.occupation] || '無職') : '転出済み')
      : '故人';
    let destLabel = ACTIVITY_LABEL_JA[citizen.currentActivity] || citizen.currentActivity || '不明';
    if (citizen.travelState) {
      const remainMin = Math.max(0, Math.round((citizen.travelState.arrivalTime - now) / 60000));
      destLabel += `（あと${remainMin}分）`;
    }
    getCitizenDisplayState(citizen); // resolves/caches this citizen's current display position (§simulateCitizenUntil) — position not shown in this text panel, but exercised here so it's always warm for a future on-map marker
    const household = citizen.householdId ? householdsRef.current.get(citizen.householdId) : null;
    const workplace = citizen.workplaceId ? workplacesRef.current.get(citizen.workplaceId) : null;
    const school = citizen.currentSchoolId != null ? educationFacilitiesRef.current.get(citizen.currentSchoolId) : null;
    const schoolDef = school ? EDUCATION_FACILITIES[school.definitionId] : null;
    const statusLabels = citizen.statuses.map((s) => STATUS_LABEL_JA[s.type] || s.type);
    const nextEvent = citizen.alive && citizen.cityResident ? peekNextEventForCitizen(citizen.id) : null;
    const nextEventLabel = nextEvent
      ? `${nextEvent.type}（あと${Math.max(0, Math.round((nextEvent.time - now) / 60000))}分）`
      : 'なし';
    return {
      id: citizen.id,
      name: citizen.name,
      age: ageYears,
      ageGroup: AGE_GROUP_LABEL_JA[citizen.ageGroup] || citizen.ageGroup,
      education: EDUCATION_LABEL_JA[citizen.education] || citizen.education,
      occupation: occLabel,
      jobLevel: citizen.actualJobLevel || '—',
      householdId: household ? household.id : '—',
      householdWealth: household ? Math.round(household.wealth) : null,
      home: citizen.homeId != null ? String(citizen.homeId) : (hasStatus(citizen, STATUS_TYPES.HOMELESS) ? '(ホームレス)' : '—'),
      workplaceOrSchool: workplace ? `${workplace.id}（${workplace.jobLevel}）` : (school ? `${school.numericId}（${schoolDef ? schoolDef.name : school.definitionId}）` : '—'),
      // §Step8: raw IDs for the Inspector's back-link buttons (workplace.buildingId is a real
      // tile index — see ensureWorkplaceSupply — so it can be routed straight to openBuildingInspectorByTile).
      workplaceTileId: workplace && workplace.buildingId != null ? workplace.buildingId : null,
      schoolNumericId: school ? school.numericId : null,
      status: statusLabels.length ? statusLabels.join('・') : '健康',
      currentActivity: destLabel,
      destination: citizen.destinationId != null ? String(citizen.destinationId) : '—',
      health: Math.round(citizen.health),
      salary: citizen.salary || 0,
      nextEvent: nextEventLabel,
      // legacy shape kept for the compact 歩行者視点 header, which only ever showed name/dest
      dest: `${occLabel}・${destLabel}`,
    };
  }, [getCitizenDisplayState, peekNextEventForCitizen]);

  // §Step8: opens the Citizen Inspector for a given id from inside a Building Inspector
  // (employee/visitor list click) — reuses describeCitizenForPanel, never a fabricated profile.
  // Declared here (after describeCitizenForPanel) so its dependency is already initialized.
  const openCitizenInspectorById = useCallback((citizenId) => {
    const c = citizensRef.current.get(citizenId);
    if (!c) return;
    setStorePanel(null);
    setEduFacilityPanel(null);
    setPedPanel(describeCitizenForPanel(c));
  }, [describeCitizenForPanel]);

  // ============ pointer interaction ============
  const raycastGround = useCallback((clientX, clientY) => {
    const t = threeRef.current;
    if (!t) return null;
    const rect = t.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    t.raycaster.setFromCamera(ndc, t.camera);
    const point = new THREE.Vector3();
    return t.raycaster.ray.intersectPlane(t.groundPlane, point) ? point : null;
  }, []);

  const raycastCar = useCallback((clientX, clientY) => {
    const t = threeRef.current;
    if (!t) return null;
    const rect = t.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    t.raycaster.setFromCamera(ndc, t.camera);
    for (const mesh of t.allChassisMeshes) {
      const hits = t.raycaster.intersectObject(mesh);
      if (hits.length) {
        const hitPoint = hits[0].point;
        let best = null, bestDist = Infinity;
        t.cars.forEach((c) => {
          if (!c.active) return;
          const d = (c.worldX - hitPoint.x) ** 2 + (c.worldZ - hitPoint.z) ** 2;
          if (d < bestDist) { bestDist = d; best = c; }
        });
        if (best) return best;
      }
    }
    return null;
  }, []);

  const raycastPed = useCallback((clientX, clientY) => {
    const t = threeRef.current;
    if (!t) return null;
    const rect = t.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    t.raycaster.setFromCamera(ndc, t.camera);
    for (const mesh of t.pedBodyMeshes) {
      const hits = t.raycaster.intersectObject(mesh);
      if (hits.length) {
        const hitPoint = hits[0].point;
        let best = null, bestDist = Infinity;
        t.peds.forEach((p) => {
          if (!p.active) return;
          const d = (p.worldX - hitPoint.x) ** 2 + (p.worldZ - hitPoint.z) ** 2;
          if (d < bestDist) { bestDist = d; best = p; }
        });
        if (best) return best;
      }
    }
    return null;
  }, []);

  const applyTool = useCallback((tx, ty) => {
    if (!inBounds(tx, ty)) return;
    const grid = gridRef.current, level = levelRef.current, lotIdGrid = lotIdGridRef.current;
    const roadType = roadTypeRef.current;
    const i = idx(tx, ty), cur = grid[i], t = toolRef.current;
    if (lotIdGrid[i] !== -1) { if (t === 'dezone') removeLot(lotIdGrid[i]); return; }
    // Education facility cells are off-limits to every zone/road/erase tool except the dedicated
    // removal tool — mirrors the lotIdGrid early-return above (§禁止事項: don't let zone painting
    // silently eat a placed facility).
    const eduGrid = eduFacilityIdGridRef.current;
    if (eduGrid[i] !== -1) { if (t === 'edu_remove') removeEducationFacility(eduGrid[i]); return; }
    let changed = false, roadChanged = false, roadCost = 0;
    if (t.startsWith('road_')) {
      const typeKey = t.slice(5);
      const typeIdx = ROAD_TYPE_KEYS.indexOf(typeKey);
      if (typeIdx !== -1 && (cur === TILE_EMPTY || isZoneType(cur) || (cur === TILE_ROAD && roadType[i] !== typeIdx))) {
        grid[i] = TILE_ROAD; level[i] = 0; roadType[i] = typeIdx; changed = true; roadChanged = true;
        roadCost = ROAD_TYPES[typeKey].cost; // 敷設費: charged once per tile laid/upgraded
        // 3+ lane roads remember which way has 2 lanes at paint time; this persists per-tile
        // until the tile is repainted or replaced, so a straight run stays consistent through
        // curves and only resets at a branch/repaint (see threeLaneDirRef + pickForwardLaneOffset).
        // If this new tile connects to an EXISTING 3-lane tile of the same type, inherit that
        // neighbor's flip bit instead of the current UI toggle — this is what keeps one continuous
        // 3-lane road from suddenly flipping its 2-lane side mid-run just because the player
        // extended it while the toolbar toggle happened to be in the other state.
        //
        // IMPORTANT: a plain copy of the neighbor's raw bit is only correct when the new tile
        // continues on the SAME axis (straight ahead). The flip bit's 0/1 meaning ("2-lane side
        // is south/east" vs "north/west") is defined per-axis, so reusing the exact same bit
        // across a 90° bend silently reassigns which physical direction gets the 2-lane group —
        // this is what made the "up" side of a loop road suddenly drop to 1 lane partway around
        // (the loop necessarily turns 90° at some point, and the naive copy didn't compensate).
        // bendInverts(dh, dv) says whether the bit must be toggled (rather than copied as-is)
        // when a horizontal arm dh∈{E,W} and a vertical arm dv∈{N,S} meet at a bend, derived so
        // that whichever travel direction had 2 lanes before the bend still has 2 lanes after it.
        if (ROAD_TYPES[typeKey].lanes >= 3) {
          const DIRS4 = [['N', 0, -1], ['E', 1, 0], ['S', 0, 1], ['W', -1, 0]];
          const OPP4 = { N: 'S', S: 'N', E: 'W', W: 'E' };
          const isHorizD = (d) => d === 'E' || d === 'W';
          const bendInverts = (fromDir, otherDir) => {
            // fromDir = the direction of the arm a tile's bit is already anchored to;
            // otherDir = the perpendicular direction of the arm being derived from it.
            // NOT symmetric — which specific direction pair meets matters, not just
            // horizontal-vs-vertical — so this must always be called as (established, new).
            return isHorizD(fromDir) ? (otherDir === 'S') : (otherDir === 'W');
          };
          const sameTypeAt = (px, py) => {
            if (!inBounds(px, py)) return -1;
            const pi = idx(px, py);
            return (grid[pi] === TILE_ROAD && roadType[pi] === typeIdx) ? pi : -1;
          };
          const sameTypeNbs = [];
          for (const [d, dx, dy] of DIRS4) {
            const ni = sameTypeAt(tx + dx, ty + dy);
            if (ni !== -1) sameTypeNbs.push({ d, ni });
          }
          if (!sameTypeNbs.length) {
            threeLaneDirRef.current[i] = threeLaneFlipRef.current ? 1 : 0;
          } else {
            // Recompute the flip bit for the WHOLE connected same-type network in a single BFS
            // walked out from an EXISTING neighbor (whose bit is already correct), rather than
            // patching just the one or two tiles this paint action touches. Patching locally
            // kept leaving some far part of a closed loop — wherever it happened to close, or
            // whichever corner was opposite the tile the player started drawing from — with the
            // lane split still backwards, because a local patch can only ever look one tile in
            // each direction and can't see the whole ring at once. Walking the entire connected
            // group from one anchor point, with each tile's bit derived from whichever neighbor
            // reaches it first, fixes every bend consistently in one pass, all the way around.
            const anchor = sameTypeNbs[0].ni;
            const dirFromAnchorToI = OPP4[sameTypeNbs[0].d];
            const anchorX = anchor % GRID_SIZE, anchorY = Math.floor(anchor / GRID_SIZE);
            // anchor is an existing tile, so find whichever OTHER connection it already had
            // (if any) — that's the arm its current bit is actually anchored to; ignore the
            // brand-new connection toward i when looking for it.
            let anchorArrival = null;
            for (const [d, dx, dy] of DIRS4) {
              if (d === dirFromAnchorToI) continue;
              if (sameTypeAt(anchorX + dx, anchorY + dy) !== -1) { anchorArrival = d; break; }
            }
            const arrivalDir = new Map([[anchor, anchorArrival]]);
            const seen = new Set([anchor]);
            const queue = [anchor];
            while (queue.length) {
              const curI = queue.shift();
              const curX = curI % GRID_SIZE, curY = Math.floor(curI / GRID_SIZE);
              const fromDir = arrivalDir.get(curI);
              for (const [d, dx, dy] of DIRS4) {
                const ni = sameTypeAt(curX + dx, curY + dy);
                if (ni === -1 || seen.has(ni)) continue;
                seen.add(ni);
                if (fromDir && isHorizD(fromDir) !== isHorizD(d) && bendInverts(fromDir, d)) {
                  threeLaneDirRef.current[ni] = threeLaneDirRef.current[curI] ? 0 : 1;
                } else {
                  threeLaneDirRef.current[ni] = threeLaneDirRef.current[curI];
                }
                arrivalDir.set(ni, OPP4[d]);
                queue.push(ni);
              }
            }
          }
        }
        // 'small' roads are one-way: recompute the whole connected network's flow (this tile plus
        // any neighbors) from scratch so it stays one consistent direction through curves,
        // branches, and loops — see recomputeOneWayNetwork.
        refreshOneWayNetworkAround(tx, ty);
      }
    }
    else if (t === 'erase') { if (cur === TILE_ROAD) { grid[i] = TILE_EMPTY; changed = true; roadChanged = true; refreshOneWayNetworkAround(tx, ty); } }
    else if (t === 'dezone') { if (isZoneType(cur)) { grid[i] = TILE_EMPTY; level[i] = 0; changed = true; industryDataRef.current.delete(i); evictHouseholdsAtHome(i); } }
    else if (t === 'cargo_hub') {
      // Phase 6: freight hub marker — must sit on existing connected road; two hubs anywhere
      // in the city are treated as linked by a fixed discounted cost (see computeTransportDistance).
      if (cur === TILE_ROAD && !cargoHubsRef.current.has(i)) {
        cargoHubsRef.current.set(i, { type: 'rail' });
        setBudget((b) => ({ ...b, treasury: b.treasury - HUB_TYPES.rail.cost }));
        syncHubMeshes();
      }
    }
    else if (t === 'zone_res' || t === 'zone_com' || t === 'zone_ind') {
      // newly zoning an EMPTY tile must respect wide-road pavement overhang, same as lot
      // placement (requirement #10/#12) — a tile already zoned is left alone here (re-tinting an
      // existing zone doesn't change its footprint).
      const overhangBlocked = cur === TILE_EMPTY && tileBlockedByRoadFootprint(tx, ty);
      if (!overhangBlocked && (cur === TILE_EMPTY || isZoneType(cur))) {
        const target = t === 'zone_res' ? TILE_RES : t === 'zone_com' ? TILE_COM : TILE_IND;
        if (cur !== target) { grid[i] = target; level[i] = 0; changed = true; }
      }
    }
    if (roadCost > 0) setBudget((b) => ({ ...b, treasury: b.treasury - roadCost }));
    if (roadChanged) {
      recomputeConnectivity();
      // the highway-gate list depends on the connected road network (a gate must be a connected
      // border highway tile with real road just inland of it), so any road edit near a highway or
      // the map edge can add/remove a valid external entry point — recompute it here rather than
      // only at map init (requirement #4/#18: gates stay in sync with what the player builds).
      highwayGatesRef.current = computeHighwayGates();
      threeRef.current?.rebuildRoadTileList?.();
      // also refresh the 8 neighbors so their road pattern (hub/arm) updates immediately
      // and re-validate any car whose route touches this tile RIGHT NOW, so laying/erasing/
      // retyping a road never leaves an existing car pointed at a stale/nonexistent segment.
      threeRef.current?.revalidateCarsAround?.(tx, ty);
    }
    if (changed) threeRef.current?.syncInstances();
  }, [recomputeConnectivity, computeHighwayGates, removeLot, syncHubMeshes, evictHouseholdsAtHome, removeEducationFacility]);

  const updateHoverMesh = useCallback((tx, ty) => {
    const t = threeRef.current; if (!t) return;
    if (inBounds(tx, ty)) { t.hoverMesh.position.set(tileWorldX(tx), ROAD_TOP_Y + 0.05, tileWorldZ(ty)); t.hoverMesh.visible = true; }
    else t.hoverMesh.visible = false;
  }, []);

  const onPointerDown = useCallback((e) => {
    const point = raycastGround(e.clientX, e.clientY);
    if (!point) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    // ---- Free Road Network tool (World Space, Prompt 3) — bypasses worldToTile()/applyTool()
    // entirely: click #1 places the start RoadNode at the raw raycast point, click #2 finalizes
    // the RoadSegment (and immediately starts the next one, chained, until Escape/tool switch).
    if (toolRef.current === 'freeroad') {
      const t = threeRef.current;
      if (!freeRoadDraftRef.current) t.startFreeRoadDraft(point);
      else t.finalizeFreeRoadDraft();
      return;
    }
    const { tx, ty } = worldToTile(point);
    if (RES_LOT_TYPES[toolRef.current]) {
      // anchor is a raw World Space point (never a Tile index) — see updateLotPreview.
      dragRef.current = { mode: 'lot', anchorX: point.x, anchorZ: point.z, startX: e.clientX, startY: e.clientY };
      updateLotPreview(toolRef.current, point.x, point.z, point.x, point.z);
    } else if (toolRef.current.startsWith('edu_place_')) {
      // fixed-footprint "stamp" placement (like cargo_hub) rather than a drag-to-size lot — the
      // facility's size comes entirely from its definition, so a single click is enough.
      placeEducationFacility(toolRef.current.slice('edu_place_'.length), tx, ty);
      dragRef.current = { dragging: false, painting: false, anchor: null, startX: e.clientX, startY: e.clientY };
    } else if (toolRef.current !== 'select') {
      dragRef.current = { dragging: false, painting: true, anchor: null, startX: e.clientX, startY: e.clientY };
      applyTool(tx, ty);
    } else {
      dragRef.current = { dragging: true, painting: false, anchor: point.clone(), startX: e.clientX, startY: e.clientY };
    }
  }, [raycastGround, worldToTile, applyTool, updateLotPreview, placeEducationFacility]);

  const onPointerMove = useCallback((e) => {
    const point = raycastGround(e.clientX, e.clientY);
    if (!point) return;
    if (toolRef.current === 'freeroad') {
      if (freeRoadDraftRef.current) threeRef.current.updateFreeRoadDraftEnd(point);
      return;
    }
    const { tx, ty } = worldToTile(point);
    if (dragRef.current.mode === 'lot') {
      updateLotPreview(toolRef.current, dragRef.current.anchorX, dragRef.current.anchorZ, point.x, point.z);
    } else if (toolRef.current.startsWith('edu_place_')) {
      updateEducationFacilityPreview(toolRef.current.slice('edu_place_'.length), tx, ty);
    } else if (dragRef.current.painting) applyTool(tx, ty);
    else if (dragRef.current.dragging && dragRef.current.anchor) {
      const current = raycastGround(e.clientX, e.clientY);
      if (current) {
        const anchor = dragRef.current.anchor;
        const delta = new THREE.Vector3().subVectors(anchor, current);
        camTargetRef.current = { x: camTargetRef.current.x + delta.x, z: camTargetRef.current.z + delta.z };
      }
    }
    hoverTileRef.current = { tx, ty };
    updateHoverMesh(tx, ty);
    setHud((h) => ({ ...h, tileX: inBounds(tx, ty) ? tx : null, tileY: inBounds(tx, ty) ? ty : null }));
  }, [raycastGround, worldToTile, applyTool, updateHoverMesh, updateLotPreview]);

  const onPointerUp = useCallback((e) => {
    if (dragRef.current.mode === 'lot') {
      const t = threeRef.current;
      if (t?.lotPreviewMesh) t.lotPreviewMesh.visible = false;
      const rect = dragRef.current.rect;
      if (rect && dragRef.current.rectValid) finalizeLot(toolRef.current, rect.x, rect.z, rect.w, rect.h, rect.frontSign);
      dragRef.current = { dragging: false, painting: false, anchor: null, startX: 0, startY: 0 };
      return;
    }
    const dx = e.clientX - dragRef.current.startX, dy = e.clientY - dragRef.current.startY;
    const wasClick = Math.hypot(dx, dy) < 5;
    const wasPainting = dragRef.current.painting;
    dragRef.current.dragging = false; dragRef.current.painting = false;

    if (wasClick && !wasPainting && toolRef.current === 'select') {
      const car = raycastCar(e.clientX, e.clientY);
      if (car) {
        selectedCarRef.current = car;
        setDriverPanel({ ...car.profile });
        return;
      }
      const ped = raycastPed(e.clientX, e.clientY);
      if (ped) {
        selectedPedRef.current = ped;
        // Part 5: always a real, currently-existing Citizen entity's data (§重要：本物のCitizen)
        // — never a fabricated random profile. If the city has no citizens at all yet (very early
        // game), there is simply nothing to bind, and no panel is shown.
        const citizen = bindCitizenToPed(ped);
        if (citizen) setPedPanel(describeCitizenForPanel(citizen));
        return;
      }
      const point = raycastGround(e.clientX, e.clientY);
      if (point) {
        const { tx, ty } = worldToTile(point);
        if (inBounds(tx, ty)) {
          // §施設選択: clicking a tile that belongs to a placed education facility opens its
          // Inspector instead of (or in addition to) the generic tile-select highlight.
          const eduId = eduFacilityIdGridRef.current[idx(tx, ty)];
          if (eduId !== -1) { openEducationFacilityInspector(eduId); setStorePanel(null); }
          else {
            setEduFacilityPanel(null);
            const tv = gridRef.current[idx(tx, ty)];
            if ((tv === TILE_COM || tv === TILE_IND) && levelRef.current[idx(tx, ty)] > 0) openStoreOrWorkplaceInspector(tx, ty);
            else setStorePanel(null);
          }
          setSelected({ tx, ty });
          const t = threeRef.current;
          t.selectMesh.position.set(tileWorldX(tx), ROAD_TOP_Y + 0.02, tileWorldZ(ty));
          t.selectMesh.visible = true;
        }
      }
    }
  }, [raycastGround, raycastCar, raycastPed, worldToTile, finalizeLot, bindCitizenToPed, describeCitizenForPanel, openEducationFacilityInspector, openStoreOrWorkplaceInspector]);

  const onWheel = useCallback((e) => {
    e.preventDefault();
    const factor = Math.exp(-e.deltaY * 0.001);
    zoomRef.current = Math.min(2000, Math.max(0.4, zoomRef.current * factor));
    setHud((h) => ({ ...h, zoom: zoomRef.current }));
  }, []);

  const zoomStep = useCallback((mult) => {
    zoomRef.current = Math.min(2000, Math.max(0.4, zoomRef.current * mult));
    setHud((h) => ({ ...h, zoom: zoomRef.current }));
  }, []);

  const enterDriverView = () => { cameraModeRef.current = 'driver'; setCameraMode('driver'); };
  const exitDriverView = () => { cameraModeRef.current = 'iso'; setCameraMode('iso'); };
  const closeDriverPanel = () => { setDriverPanel(null); selectedCarRef.current = null; if (cameraModeRef.current === 'driver') exitDriverView(); };

  const enterPedView = () => { cameraModeRef.current = 'ped'; setCameraMode('ped'); };
  const exitPedView = () => { cameraModeRef.current = 'iso'; setCameraMode('iso'); };
  const closePedPanel = () => { setPedPanel(null); selectedPedRef.current = null; if (cameraModeRef.current === 'ped') exitPedView(); };

  const resToolIds = ['zone_res', 'res_terrace', 'res_mid', 'res_lowrent', 'res_mixed', 'res_high'];
  const roadToolIds = ROAD_TYPE_KEYS.map((k) => `road_${k}`);
  const eduToolIds = Object.keys(EDUCATION_FACILITIES).map((k) => `edu_place_${k}`);
  const submenuToolIds = [...resToolIds, ...roadToolIds, ...eduToolIds];

  const toolBtn = (id, label, color, locked) => (
    <button onClick={() => { if (locked) return; setTool(id); if (!submenuToolIds.includes(id)) setToolCategory(null); }} style={{ padding: '7px 12px', background: tool === id ? `${color}33` : 'rgba(15, 21, 18, 0.85)', border: `1px solid ${tool === id ? color : 'rgba(120, 200, 160, 0.25)'}`, borderRadius: 4, color: locked ? '#5a6a5f' : tool === id ? color : '#a8d8bc', fontSize: 12, cursor: locked ? 'not-allowed' : 'pointer', fontFamily: "'Courier New', monospace", whiteSpace: 'nowrap', opacity: locked ? 0.55 : 1 }}>
      {locked ? `🔒${label}` : label}
    </button>
  );

  const treasuryColor = budget.treasury < 0 ? '#e05a4f' : budget.net < 0 ? '#e0a84f' : '#7fe0a8';

  return (
    <div style={{ position: 'relative', width: '100%', height: '100vh', background: '#0f1512', fontFamily: "'Courier New', monospace" }}>
      <div ref={mountRef} onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerLeave={onPointerUp} onWheel={onWheel}
        style={{ width: '100%', height: '100%', cursor: tool === 'select' ? 'grab' : 'crosshair', touchAction: 'none' }} />

      {cameraMode !== 'driver' && cameraMode !== 'ped' && (
        <>
          <div style={{ position: 'absolute', top: 16, left: 16, padding: '10px 14px', background: 'rgba(15, 21, 18, 0.85)', border: '1px solid rgba(120, 200, 160, 0.25)', borderRadius: 4, color: '#a8d8bc', fontSize: 12, lineHeight: 1.6, minWidth: 168 }}>
            <div style={{ color: '#e0a84f', fontSize: 13, marginBottom: 4 }}>CITY GRID — ISO 3D</div>
            <div>zoom: {(hud.zoom * 100).toFixed(0)}% / tile: {hud.tileX !== null ? `${hud.tileX},${hud.tileY}` : '--'}</div>
            <div>roads: {hud.roadCount}</div>
            <div>信号交差点: {hud.signalCount}</div>
            <div style={{ marginTop: 6, color: '#5a90d8' }}>population: {stats.population}</div>
            <div style={{ color: '#e0b060' }}>jobs: {stats.jobs}（就業者 {stats.employedCitizens}）</div>
            <div style={{ color: '#7fa892', fontSize: 11, marginTop: 2 }}>tick: {stats.tick}</div>
            <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid rgba(120,200,160,0.2)' }}>
              <div style={{ color: treasuryColor, fontSize: 14 }}>treasury: {Math.round(budget.treasury).toLocaleString()}</div>
              <div style={{ fontSize: 11, color: '#7fe0a8' }}>+income {budget.income}</div>
              <div style={{ fontSize: 11, color: '#e0857a' }}>-upkeep {budget.expenses}</div>
              <div style={{ fontSize: 11, color: '#e0a860' }}>教育施設維持費: ¥{(budget.educationUpkeep || 0).toLocaleString()}/月</div>
              <div style={{ fontSize: 11, color: '#7fa892' }}>教育施設数: {educationFacilityCount}</div>
            </div>
            <div style={{ marginTop: 8 }}>
              <div style={{ fontSize: 11, marginBottom: 3 }}>tax rate: {(taxRate * 100).toFixed(0)}%</div>
              <input type="range" min={3} max={25} value={Math.round(taxRate * 100)} onChange={(e) => setTaxRate(Number(e.target.value) / 100)} style={{ width: '100%' }} />
            </div>
            {eduCityEffectsSummary && (eduCityEffectsSummary.industryEfficiency !== 0 || eduCityEffectsSummary.officeEfficiency !== 0 || eduCityEffectsSummary.treatmentFailureRate !== 0 || eduCityEffectsSummary.hospitalEfficiency !== 0 || eduCityEffectsSummary.patientCapacity !== 0 || eduCityEffectsSummary.universityInterest !== 0 || eduCityEffectsSummary.universityGraduationRate !== 0 || eduCityEffectsSummary.comprehensiveUniversityGraduationRate !== 0 || eduCityEffectsSummary.softwareDemand !== 0 || eduCityEffectsSummary.electronicsDemand !== 0 || eduCityEffectsSummary.softwareProductionEfficiency !== 0 || eduCityEffectsSummary.electronicsProductionEfficiency !== 0 || eduCityEffectsSummary.oreDeposit !== 0 || eduCityEffectsSummary.oilDeposit !== 0 || eduCityEffectsSummary.attractiveness !== 0 || eduCityEffectsSummary.outdoorRecreation !== 0) && (
              // Part 3/4: display-only readout of educationCityEffectsRef — NOT applied to
              // industry/office/hospital/resource sim yet (that stays out of scope per §禁止事項).
              <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid rgba(120,200,160,0.2)', fontSize: 11, color: '#7fa892' }}>
                <div style={{ color: '#a8d8bc', marginBottom: 2 }}>教育施設 都市効果（未適用）</div>
                {eduCityEffectsSummary.industryEfficiency !== 0 && <div>industryEfficiency: {(eduCityEffectsSummary.industryEfficiency * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.officeEfficiency !== 0 && <div>officeEfficiency: {(eduCityEffectsSummary.officeEfficiency * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.treatmentFailureRate !== 0 && <div>treatmentFailureRate: {(eduCityEffectsSummary.treatmentFailureRate * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.hospitalEfficiency !== 0 && <div>hospitalEfficiency: {(eduCityEffectsSummary.hospitalEfficiency * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.patientCapacity !== 0 && <div>patientCapacity: +{eduCityEffectsSummary.patientCapacity}</div>}
                {eduCityEffectsSummary.universityInterest !== 0 && <div>universityInterest: +{(eduCityEffectsSummary.universityInterest * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.universityGraduationRate !== 0 && <div>universityGraduationRate: +{(eduCityEffectsSummary.universityGraduationRate * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.comprehensiveUniversityGraduationRate !== 0 && <div>comprehensiveUniversityGraduationRate: +{(eduCityEffectsSummary.comprehensiveUniversityGraduationRate * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.softwareDemand !== 0 && <div>softwareDemand: +{(eduCityEffectsSummary.softwareDemand * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.electronicsDemand !== 0 && <div>electronicsDemand: +{(eduCityEffectsSummary.electronicsDemand * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.softwareProductionEfficiency !== 0 && <div>softwareProductionEfficiency: +{(eduCityEffectsSummary.softwareProductionEfficiency * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.electronicsProductionEfficiency !== 0 && <div>electronicsProductionEfficiency: +{(eduCityEffectsSummary.electronicsProductionEfficiency * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.oreDeposit !== 0 && <div>oreDeposit: +{(eduCityEffectsSummary.oreDeposit * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.oilDeposit !== 0 && <div>oilDeposit: +{(eduCityEffectsSummary.oilDeposit * 100).toFixed(0)}%</div>}
                {eduCityEffectsSummary.attractiveness !== 0 && <div>attractiveness: +{eduCityEffectsSummary.attractiveness}</div>}
                {eduCityEffectsSummary.outdoorRecreation !== 0 && <div>outdoorRecreation: +{eduCityEffectsSummary.outdoorRecreation}</div>}
                {eduCityEffectsSummary.radiusEffects && eduCityEffectsSummary.radiusEffects.length > 0 && (
                  <div style={{ marginTop: 2 }}>welfare/health (radius): {eduCityEffectsSummary.radiusEffects.length}件</div>
                )}
              </div>
            )}
          </div>

          <div style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
            <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 460, justifyContent: 'center' }}>
              {toolBtn('select', 'SELECT', '#7fe0e0')}
              <button
                onClick={() => { setToolCategory((c) => (c === 'road' ? null : 'road')); if (!roadToolIds.includes(tool)) setTool('road_two'); }}
                style={{ padding: '7px 12px', background: roadToolIds.includes(tool) ? '#c9b25a33' : 'rgba(15, 21, 18, 0.85)', border: `1px solid ${roadToolIds.includes(tool) || toolCategory === 'road' ? '#c9b25a' : 'rgba(120, 200, 160, 0.25)'}`, borderRadius: 4, color: roadToolIds.includes(tool) ? '#c9b25a' : '#a8d8bc', fontSize: 12, cursor: 'pointer', fontFamily: "'Courier New', monospace", whiteSpace: 'nowrap' }}
              >
                道路 {toolCategory === 'road' ? '▴' : '▾'}
              </button>
              {toolBtn('erase', 'ERASE', '#e05a4f')}
              <button
                onClick={() => { setToolCategory((c) => (c === 'res' ? null : 'res')); if (!resToolIds.includes(tool)) setTool('zone_res'); }}
                style={{ padding: '7px 12px', background: resToolIds.includes(tool) ? '#5a90d833' : 'rgba(15, 21, 18, 0.85)', border: `1px solid ${resToolIds.includes(tool) || toolCategory === 'res' ? '#5a90d8' : 'rgba(120, 200, 160, 0.25)'}`, borderRadius: 4, color: resToolIds.includes(tool) ? '#5a90d8' : '#a8d8bc', fontSize: 12, cursor: 'pointer', fontFamily: "'Courier New', monospace", whiteSpace: 'nowrap' }}
              >
                住宅 {toolCategory === 'res' ? '▴' : '▾'}
              </button>
              {toolBtn('zone_com', '商業', '#e0b060')}
              {toolBtn('zone_ind', '工業', '#9b6fdc')}
              <button
                onClick={() => { setToolCategory((c) => (c === 'edu' ? null : 'edu')); if (!eduToolIds.includes(tool)) setTool(eduToolIds[0]); }}
                style={{ padding: '7px 12px', background: eduToolIds.includes(tool) ? '#7fe0e033' : 'rgba(15, 21, 18, 0.85)', border: `1px solid ${eduToolIds.includes(tool) || toolCategory === 'edu' ? '#7fe0e0' : 'rgba(120, 200, 160, 0.25)'}`, borderRadius: 4, color: eduToolIds.includes(tool) ? '#7fe0e0' : '#a8d8bc', fontSize: 12, cursor: 'pointer', fontFamily: "'Courier New', monospace", whiteSpace: 'nowrap' }}
              >
                教育 {toolCategory === 'edu' ? '▴' : '▾'}
              </button>
              {toolBtn('edu_remove', '教育施設削除', '#e05a4f')}
              {toolBtn('cargo_hub', '貨物ハブ', '#d9a441')}
              {toolBtn('dezone', 'DEZONE', '#e05a4f')}
            </div>
            {toolCategory === 'edu' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: 480, padding: '8px', background: 'rgba(15, 21, 18, 0.92)', border: '1px solid rgba(127, 224, 224, 0.4)', borderRadius: 4 }}>
                {/* Part 4/4: §最終的な教育施設カテゴリ — 小学校/高校/大学/総合大学/特殊大学/研究施設 tabs */}
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'center' }}>
                  {EDU_UI_GROUPS.map((g) => (
                    <button key={g.key} onClick={() => setEduGroupFilter(g.key)}
                      style={{ padding: '4px 8px', background: eduGroupFilter === g.key ? '#7fe0e033' : 'rgba(15,21,18,0.85)', border: `1px solid ${eduGroupFilter === g.key ? '#7fe0e0' : 'rgba(120,200,160,0.25)'}`, borderRadius: 4, color: eduGroupFilter === g.key ? '#7fe0e0' : '#a8d8bc', fontSize: 11, cursor: 'pointer', fontFamily: "'Courier New', monospace" }}>
                      {g.label}
                    </button>
                  ))}
                </div>
                {/* Part 4/4: §Packフィルタ — Packのない施設はBASEとして扱う */}
                <div style={{ display: 'flex', gap: 4, alignItems: 'center', justifyContent: 'center', fontSize: 11 }}>
                  <span style={{ color: '#7fa892' }}>Pack:</span>
                  <select value={eduPackFilter} onChange={(e) => setEduPackFilter(e.target.value)}
                    style={{ background: 'rgba(15,21,18,0.9)', color: '#a8d8bc', border: '1px solid rgba(120,200,160,0.3)', borderRadius: 4, fontSize: 11, fontFamily: "'Courier New', monospace", padding: '2px 4px' }}>
                    <option value="ALL">すべて</option>
                    <option value="STANDARD">標準</option>
                    {EDUCATION_FACILITY_PACKS.filter((p) => p !== 'BASE').map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </div>
                <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', justifyContent: 'center' }}>
                  {Object.values(EDUCATION_FACILITIES)
                    .filter((def) => (EDU_UI_GROUPS.find((g) => g.key === eduGroupFilter) || EDU_UI_GROUPS[0]).categories.includes(def.category))
                    .filter((def) => {
                      const pack = def.pack || 'BASE'; // Packのない施設はBASEとして扱う
                      if (eduPackFilter === 'ALL') return true;
                      if (eduPackFilter === 'STANDARD') return pack === 'BASE';
                      return pack === eduPackFilter;
                    })
                    .map((def) => (
                      <React.Fragment key={def.id}>
                        {toolBtn(`edu_place_${def.id}`, `${def.name} (¥${def.cost.toLocaleString()}・${def.size.w}x${def.size.h})`, '#7fe0e0', budget.treasury < def.cost)}
                      </React.Fragment>
                    ))}
                </div>
              </div>
            )}
            {toolCategory === 'res' && (
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 460, justifyContent: 'center', padding: '8px', background: 'rgba(15, 21, 18, 0.92)', border: '1px solid rgba(90, 144, 216, 0.4)', borderRadius: 4 }}>
                {toolBtn('zone_res', '低密度住宅', '#5a90d8')}
                {toolBtn('res_terrace', 'テラスハウス', '#b08a5a')}
                {toolBtn('res_mid', '中密度住宅', '#8fa8c8', stats.population < RES_LOT_TYPES.res_mid.unlockPop)}
                {toolBtn('res_lowrent', '低家賃住宅', '#8a8a82', stats.population < RES_LOT_TYPES.res_lowrent.unlockPop)}
                {toolBtn('res_mixed', '複合住宅', '#d8b878', stats.population < RES_LOT_TYPES.res_mixed.unlockPop)}
                {toolBtn('res_high', '高密度住宅', '#9fd0e0', stats.population < RES_LOT_TYPES.res_high.unlockPop)}
              </div>
            )}
            {toolCategory === 'road' && (
              <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', maxWidth: 460, justifyContent: 'center', padding: '8px', background: 'rgba(15, 21, 18, 0.92)', border: '1px solid rgba(201, 178, 90, 0.4)', borderRadius: 4 }}>
                {toolBtn('road_small', `${ROAD_TYPES.small.label} (¥${ROAD_TYPES.small.cost}/1車線/${ROAD_TYPES.small.maxSpeed}km)`, '#c9b25a')}
                {toolBtn('road_two', `${ROAD_TYPES.two.label} (¥${ROAD_TYPES.two.cost}/2車線/${ROAD_TYPES.two.maxSpeed}km)`, '#c9b25a')}
                {toolBtn('road_four', `${ROAD_TYPES.four.label} (¥${ROAD_TYPES.four.cost}/4車線/${ROAD_TYPES.four.maxSpeed}km)`, '#c9b25a')}
                {toolBtn('road_four_median', `${ROAD_TYPES.four_median.label} (¥${ROAD_TYPES.four_median.cost}/4車線/${ROAD_TYPES.four_median.maxSpeed}km)`, '#c9b25a')}
                {toolBtn('road_six', `${ROAD_TYPES.six.label} (¥${ROAD_TYPES.six.cost}/6車線/${ROAD_TYPES.six.maxSpeed}km)`, '#c9b25a')}
                {toolBtn('road_six_median', `${ROAD_TYPES.six_median.label} (¥${ROAD_TYPES.six_median.cost}/6車線/${ROAD_TYPES.six_median.maxSpeed}km)`, '#c9b25a')}
                {toolBtn('road_eight_median', `${ROAD_TYPES.eight_median.label} (¥${ROAD_TYPES.eight_median.cost}/8車線/${ROAD_TYPES.eight_median.maxSpeed}km)`, '#c9b25a')}
                {toolBtn('road_dirt', `${ROAD_TYPES.dirt.label} (¥${ROAD_TYPES.dirt.cost}/1車線/${ROAD_TYPES.dirt.maxSpeed}km)`, '#b08a5a')}
                {toolBtn('road_highway', `${ROAD_TYPES.highway.label} (¥${ROAD_TYPES.highway.cost}/4車線/${ROAD_TYPES.highway.maxSpeed}km・外部接続)`, '#5ad0e0')}
                {tool === 'road_small' && (
                  <button
                    onClick={() => { oneWayFlipRef.current = !oneWayFlipRef.current; setOneWayFlipState(oneWayFlipRef.current); }}
                    title="この小さな道路(一方通行)ネットワークの通行方向を反転する"
                    style={{ padding: '7px 12px', background: 'rgba(15, 21, 18, 0.85)', border: '1px solid #7fe0a8', borderRadius: 4, color: '#7fe0a8', fontSize: 12, cursor: 'pointer', fontFamily: "'Courier New', monospace", whiteSpace: 'nowrap' }}
                  >
                    通行方向: {oneWayFlip ? '反転' : '標準'} (切替)
                  </button>
                )}
                <div style={{ width: '100%', borderTop: '1px solid rgba(106, 208, 255, 0.3)', margin: '4px 0' }} />
                <button
                  onClick={() => setTool('freeroad')}
                  title="タイル格子に縛られない自由な道路(RoadNode+RoadSegment)を、クリックで始点/終点を置いて作成します"
                  style={{ padding: '7px 12px', background: tool === 'freeroad' ? '#6ad0ff33' : 'rgba(15, 21, 18, 0.85)', border: `1px solid ${tool === 'freeroad' ? '#6ad0ff' : 'rgba(106, 208, 255, 0.4)'}`, borderRadius: 4, color: '#6ad0ff', fontSize: 12, cursor: 'pointer', fontFamily: "'Courier New', monospace", whiteSpace: 'nowrap' }}
                >
                  自由道路 (Free Road)
                </button>
                {tool === 'freeroad' && (
                  <>
                    <select
                      value={freeRoadType}
                      onChange={(e) => setFreeRoadTypeState(e.target.value)}
                      style={{ padding: '6px 8px', background: 'rgba(15, 21, 18, 0.85)', border: '1px solid #6ad0ff', borderRadius: 4, color: '#6ad0ff', fontSize: 12, fontFamily: "'Courier New', monospace" }}
                    >
                      {ROAD_TYPE_KEYS.map((k) => <option key={k} value={k}>{ROAD_TYPES[k].label}</option>)}
                    </select>
                    <div style={{ width: '100%', fontSize: 11, color: '#6ad0ff', padding: '2px 4px' }}>
                      クリック: 始点/終点を設置(連続作図) ・ K/L: カーブ左右 ・ O/M: 高さ上下 ・ Esc: 作図キャンセル
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div style={{ position: 'absolute', bottom: 16, left: 16, padding: '8px 12px', background: 'rgba(15, 21, 18, 0.85)', border: '1px solid rgba(120, 200, 160, 0.25)', borderRadius: 4, color: '#7fa892', fontSize: 11, lineHeight: 1.6 }}>
            <div>select: drag pan / click select / click car for driver info / click pedestrian for walk info</div>
            <div>road / zone / erase: drag to paint — roads auto-connect into crossroads, T-junctions, curves + sidewalks</div>
            <div>住宅ロット(テラス〜高密度): ドラッグで区画サイズを指定して配置(道路に面している必要あり)</div>
            <div>road must reach the map edge (cyan beacon = gate)</div>
            <div>高速道路(highway)=外部都市への接続。車は高速道路ゲートから流入・流出します — 住宅地への直接接続は不可(ICで一般道へ接続)</div>
            <div style={{ color: '#ffd35a' }}>camera: WASD move / Z X rotate view / wheel zoom</div>
          </div>

          <div style={{ position: 'absolute', bottom: 16, right: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button onClick={() => zoomStep(1.25)} style={{ width: 36, height: 36, background: 'rgba(15, 21, 18, 0.85)', border: '1px solid rgba(120, 200, 160, 0.25)', borderRadius: 4, color: '#a8d8bc', fontSize: 16, cursor: 'pointer' }}>+</button>
            <button onClick={() => zoomStep(0.8)} style={{ width: 36, height: 36, background: 'rgba(15, 21, 18, 0.85)', border: '1px solid rgba(120, 200, 160, 0.25)', borderRadius: 4, color: '#a8d8bc', fontSize: 16, cursor: 'pointer' }}>−</button>
          </div>

          <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 6 }}>
            <button onClick={() => setRunning((r) => !r)} style={{ padding: '8px 14px', background: 'rgba(15, 21, 18, 0.85)', border: `1px solid ${running ? '#7fe0a8' : 'rgba(120,200,160,0.25)'}`, borderRadius: 4, color: running ? '#7fe0a8' : '#a8d8bc', fontSize: 12, cursor: 'pointer' }}>{running ? 'pause' : 'play'}</button>
            <button onClick={() => setSpeed((s) => (s === 1 ? 2 : s === 2 ? 4 : 1))} style={{ padding: '8px 14px', background: 'rgba(15, 21, 18, 0.85)', border: '1px solid rgba(120, 200, 160, 0.25)', borderRadius: 4, color: '#a8d8bc', fontSize: 12, cursor: 'pointer' }}>{running ? `${speed}x` : 'PAUSE'}</button>
            <div style={{ padding: '8px 14px', background: 'rgba(15, 21, 18, 0.85)', border: '1px solid rgba(120, 200, 160, 0.25)', borderRadius: 4, color: '#cfe8da', fontSize: 12, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
              {clockDisplay.year}/{String(clockDisplay.month).padStart(2, '0')}/{String(clockDisplay.day).padStart(2, '0')}({clockDisplay.weekday}) {String(clockDisplay.hour).padStart(2, '0')}:{String(clockDisplay.minute).padStart(2, '0')}:{String(clockDisplay.second).padStart(2, '0')}
            </div>
            <button
              onClick={() => {
                setShowPollution((v) => {
                  const next = !v;
                  showPollutionRef.current = next;
                  const t = threeRef.current;
                  if (t?.pollutionMesh) {
                    if (next) { computePollution(); syncPollutionOverlay(); t.pollutionMesh.visible = true; }
                    else { t.pollutionMesh.visible = false; }
                  }
                  return next;
                });
              }}
              title="汚染オーバーレイ(大気・土壌・騒音)"
              style={{ padding: '8px 14px', background: 'rgba(15, 21, 18, 0.85)', border: `1px solid ${showPollution ? '#e0544a' : 'rgba(120,200,160,0.25)'}`, borderRadius: 4, color: showPollution ? '#e0544a' : '#a8d8bc', fontSize: 12, cursor: 'pointer' }}
            >汚染{showPollution ? 'ON' : 'OFF'}</button>
            <button
              onClick={() => {
                setShowRoadsideLand((v) => {
                  const next = !v;
                  showRoadsideLandRef.current = next;
                  const t = threeRef.current;
                  if (t?.roadsideLandGroup) {
                    if (next) { t.rebuildRoadsideLandOverlay(); t.roadsideLandGroup.visible = true; }
                    else { t.roadsideLandGroup.visible = false; }
                  }
                  return next;
                });
              }}
              title="自由道路の沿道土地オーバーレイ(道路端からの8段階距離帯)"
              style={{ padding: '8px 14px', background: 'rgba(15, 21, 18, 0.85)', border: `1px solid ${showRoadsideLand ? '#6ad0ff' : 'rgba(120,200,160,0.25)'}`, borderRadius: 4, color: showRoadsideLand ? '#6ad0ff' : '#a8d8bc', fontSize: 12, cursor: 'pointer' }}
            >沿道土地{showRoadsideLand ? 'ON' : 'OFF'}</button>
          </div>
        </>
      )}

      {driverPanel && cameraMode !== 'driver' && cameraMode !== 'ped' && (
        <div style={{ position: 'absolute', bottom: 70, left: '50%', transform: 'translateX(-50%)', padding: '12px 16px', background: 'rgba(15, 21, 18, 0.92)', border: '1px solid #ffd35a', borderRadius: 6, color: '#e8e8e8', fontSize: 12, minWidth: 220 }}>
          <div style={{ color: '#ffd35a', fontSize: 13, marginBottom: 6 }}>運転者情報</div>
          <div>名前: {driverPanel.name}（{driverPanel.age}歳）</div>
          <div style={{ marginBottom: 8 }}>状況: {driverPanel.dest}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={enterDriverView} style={{ flex: 1, padding: '6px 10px', background: 'rgba(255,211,90,0.15)', border: '1px solid #ffd35a', borderRadius: 4, color: '#ffd35a', fontSize: 12, cursor: 'pointer' }}>運転視点で見る</button>
            <button onClick={closeDriverPanel} style={{ padding: '6px 10px', background: 'rgba(224,90,79,0.15)', border: '1px solid #e05a4f', borderRadius: 4, color: '#e05a4f', fontSize: 12, cursor: 'pointer' }}>閉じる</button>
          </div>
        </div>
      )}

      {pedPanel && cameraMode !== 'driver' && cameraMode !== 'ped' && (
        <div style={{ position: 'absolute', bottom: 70, left: '50%', transform: 'translateX(-50%)', padding: '12px 16px', background: 'rgba(15, 21, 18, 0.92)', border: '1px solid #7fe0e0', borderRadius: 6, color: '#e8e8e8', fontSize: 12, minWidth: 260, maxWidth: 320 }}>
          <div style={{ color: '#7fe0e0', fontSize: 13, marginBottom: 6 }}>Citizen Inspector — {pedPanel.id}</div>
          <div>名前: {pedPanel.name}（{pedPanel.age}歳・{pedPanel.ageGroup}）</div>
          <div>学歴: {pedPanel.education}</div>
          <div>職業: {pedPanel.occupation}{pedPanel.jobLevel !== '—' ? `（${pedPanel.jobLevel}）` : ''}</div>
          <div>世帯: {pedPanel.householdId}{pedPanel.householdWealth != null ? `（資産 ${pedPanel.householdWealth}）` : ''}</div>
          <div>自宅: {pedPanel.home}</div>
          <div>
            勤務先/学校: {pedPanel.workplaceOrSchool}
            {pedPanel.workplaceTileId != null && (
              <button onClick={() => openBuildingInspectorByTile(pedPanel.workplaceTileId)}
                style={{ marginLeft: 6, padding: '1px 6px', background: 'rgba(127,224,168,0.15)', border: '1px solid #7fe0a8', borderRadius: 4, color: '#7fe0a8', fontSize: 10, cursor: 'pointer' }}>建物へ</button>
            )}
            {pedPanel.schoolNumericId != null && (
              <button onClick={() => openEducationFacilityInspector(pedPanel.schoolNumericId)}
                style={{ marginLeft: 6, padding: '1px 6px', background: 'rgba(127,224,224,0.15)', border: '1px solid #7fe0e0', borderRadius: 4, color: '#7fe0e0', fontSize: 10, cursor: 'pointer' }}>学校へ</button>
            )}
          </div>
          <div>健康: {pedPanel.health} / {HEALTH_MAX}</div>
          <div>状態: {pedPanel.status}</div>
          <div>現在の活動: {pedPanel.currentActivity}</div>
          <div>目的地: {pedPanel.destination}</div>
          <div>給与: {pedPanel.salary}</div>
          <div style={{ marginBottom: 8 }}>次のイベント: {pedPanel.nextEvent}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={enterPedView} style={{ flex: 1, padding: '6px 10px', background: 'rgba(127,224,224,0.15)', border: '1px solid #7fe0e0', borderRadius: 4, color: '#7fe0e0', fontSize: 12, cursor: 'pointer' }}>歩行者視点で見る</button>
            <button onClick={closePedPanel} style={{ padding: '6px 10px', background: 'rgba(224,90,79,0.15)', border: '1px solid #e05a4f', borderRadius: 4, color: '#e05a4f', fontSize: 12, cursor: 'pointer' }}>閉じる</button>
          </div>
        </div>
      )}

      {eduFacilityPanel && cameraMode !== 'driver' && cameraMode !== 'ped' && (
        <div style={{ position: 'absolute', bottom: 70, left: '50%', transform: 'translateX(-50%)', padding: '12px 16px', background: 'rgba(15, 21, 18, 0.92)', border: '1px solid #7fe0e0', borderRadius: 6, color: '#e8e8e8', fontSize: 12, minWidth: 260, maxWidth: 320 }}>
          <div style={{ color: '#7fe0e0', fontSize: 13, marginBottom: 6 }}>教育施設 Inspector — {eduFacilityPanel.instanceId}</div>
          <div>名称: {eduFacilityPanel.name}</div>
          <div>分類: {eduFacilityPanel.category}</div>
          <div>Pack: {eduFacilityPanel.pack}</div>
          {!eduFacilityPanel.isResearch && <div>教育段階: {eduFacilityPanel.educationOutputLabel}（{eduFacilityPanel.educationOutput}）</div>}
          <div>建設費: ¥{eduFacilityPanel.cost.toLocaleString()}</div>
          <div>月間維持費: ¥{eduFacilityPanel.monthlyUpkeep.toLocaleString()}</div>
          <div>区画サイズ: {eduFacilityPanel.size.w} x {eduFacilityPanel.size.h}</div>
          {/* Part 4/4: Research施設は学生数より研究施設効果を優先表示（§教育施設Inspector） */}
          {eduFacilityPanel.isResearch ? (
            <div style={{ marginTop: 4, marginBottom: 4 }}>
              <div style={{ color: '#5ad0e0' }}>研究施設効果:</div>
              {eduFacilityPanel.researchEffects ? Object.entries(eduFacilityPanel.researchEffects).map(([k, v]) => (
                <div key={k} style={{ fontSize: 11, color: '#a8d8bc' }}>
                  {typeof v === 'object' ? `${k}: 半径${v.radius} +${v.amount}` : `${k}: +${typeof v === 'number' && v < 1 && v > -1 ? `${(v * 100).toFixed(0)}%` : v}`}
                </div>
              )) : <div style={{ fontSize: 11, color: '#7fa892' }}>なし</div>}
            </div>
          ) : (
            <>
              <div>現在capacity: {eduFacilityPanel.currentCapacity}</div>
              <div>最大capacity: {eduFacilityPanel.maxCapacity}</div>
              <div>現在staff: {eduFacilityPanel.currentStaff}</div>
              <div>生徒数: {eduFacilityPanel.enrolledStudents} / {eduFacilityPanel.currentCapacity}</div>
              <div>空席: {eduFacilityPanel.availableSeats}</div>
            </>
          )}
          <div style={{ marginTop: 4 }}>公害: air {eduFacilityPanel.pollution.air} / soil {eduFacilityPanel.pollution.soil} / noise {eduFacilityPanel.pollution.noise}</div>
          {!eduFacilityPanel.isResearch && eduFacilityPanel.cityEffects && (
            <div style={{ marginTop: 4 }}>
              <div style={{ color: '#7fa892' }}>都市効果:</div>
              {Object.entries(eduFacilityPanel.cityEffects).map(([k, v]) => (
                <div key={k} style={{ fontSize: 11, color: '#a8d8bc' }}>
                  {typeof v === 'object' ? `${k}: 半径${v.radius} +${v.amount}` : `${k}: +${typeof v === 'number' && v < 1 && v > -1 ? `${(v * 100).toFixed(0)}%` : v}`}
                </div>
              ))}
            </div>
          )}
          <div style={{ marginTop: 4 }}>
            有効: {eduFacilityPanel.enabled ? '有効' : '無効'}
            <button onClick={() => { toggleEducationFacilityEnabled(eduFacilityPanel.numericId); openEducationFacilityInspector(eduFacilityPanel.numericId); }}
              style={{ marginLeft: 8, padding: '2px 8px', background: 'rgba(127,224,224,0.1)', border: '1px solid #7fe0e0', borderRadius: 4, color: '#7fe0e0', fontSize: 11, cursor: 'pointer' }}>
              {eduFacilityPanel.enabled ? '無効化' : '有効化'}
            </button>
          </div>
          <div style={{ marginBottom: 4 }}>アップグレード数: {eduFacilityPanel.upgradeCount}</div>
          {eduFacilityPanel.availableUpgrades && eduFacilityPanel.availableUpgrades.length > 0 && (
            <div style={{ marginBottom: 8, borderTop: '1px solid rgba(127,224,224,0.2)', paddingTop: 6 }}>
              {eduFacilityPanel.availableUpgrades.map((u) => (
                <div key={u.id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4, gap: 6 }}>
                  <div style={{ fontSize: 11 }}>
                    {u.name}{u.installedCount > 0 ? ` ×${u.installedCount}` : ''}
                    <div style={{ color: '#7fa892', fontSize: 10 }}>¥{u.cost.toLocaleString()} / +¥{u.monthlyUpkeep.toLocaleString()}月{u.capacityBonus ? ` / 収容+${u.capacityBonus}` : ''}{u.size ? ` / ${u.size.w}x${u.size.h}` : ''} / 配置: 本体隣接 / 複数設置: {u.multiInstance ? '可' : '不可'}</div>
                    {u.cityEffects && (
                      <div style={{ color: '#7fa892', fontSize: 10 }}>
                        都市効果: {Object.entries(u.cityEffects).map(([k, v]) => `${k}+${typeof v === 'object' ? v.amount : v}`).join(', ')}
                      </div>
                    )}
                  </div>
                  <button
                    onClick={() => { addEducationFacilityUpgrade(eduFacilityPanel.numericId, u.id); openEducationFacilityInspector(eduFacilityPanel.numericId); }}
                    disabled={u.installedCount > 0 && !u.multiInstance}
                    style={{ padding: '4px 8px', background: 'rgba(127,224,168,0.15)', border: '1px solid #7fe0a8', borderRadius: 4, color: '#7fe0a8', fontSize: 11, cursor: (u.installedCount > 0 && !u.multiInstance) ? 'not-allowed' : 'pointer', opacity: (u.installedCount > 0 && !u.multiInstance) ? 0.4 : 1 }}
                  >{u.multiInstance ? '追加' : '設置'}</button>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={() => { removeEducationFacility(eduFacilityPanel.numericId); }} style={{ flex: 1, padding: '6px 10px', background: 'rgba(224,90,79,0.15)', border: '1px solid #e05a4f', borderRadius: 4, color: '#e05a4f', fontSize: 12, cursor: 'pointer' }}>削除</button>
            <button onClick={() => setEduFacilityPanel(null)} style={{ padding: '6px 10px', background: 'rgba(127,224,224,0.1)', border: '1px solid #7fe0e0', borderRadius: 4, color: '#7fe0e0', fontSize: 12, cursor: 'pointer' }}>閉じる</button>
          </div>
        </div>
      )}

      {storePanel && cameraMode !== 'driver' && cameraMode !== 'ped' && (
        <div style={{ position: 'absolute', top: 16, right: 16, width: 300, maxHeight: '80vh', overflowY: 'auto', padding: '10px 14px', background: 'rgba(15, 21, 18, 0.92)', border: '1px solid #7fe0a8', borderRadius: 4, color: '#e8e8e8', fontSize: 12 }}>
          <div style={{ color: '#7fe0a8', fontSize: 13, marginBottom: 6 }}>
            {storePanel.buildingKind === 'industrial' ? '工業 Inspector' : '商業 Inspector'} — ({storePanel.tx}, {storePanel.ty})
          </div>

          {storePanel.commercial && (() => { const c = storePanel.commercial; return (
            <div style={{ marginBottom: 8, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.15)' }}>
              <div style={{ color: '#ffd35a', fontWeight: 'bold' }}>{c.businessName}（Lv.{c.level}）</div>
              <div>業種: {c.shopTypeName}</div>
              <div>営業状態: {c.status}（{c.openTime}:00–{c.closeTime}:00）</div>
              <div style={{ marginTop: 4, color: '#7fa892' }}>雇用</div>
              <div>必要人数: {c.requiredEmployees} / 現在人数: {c.currentEmployees} / 欠員: {c.deficit}</div>
              {c.employees.map((e) => (
                <div key={e.id} style={{ marginLeft: 6, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => openCitizenInspectorById(e.id)} style={{ background: 'none', border: 'none', color: '#7fe0e0', cursor: 'pointer', padding: 0, fontSize: 11, textDecoration: 'underline' }}>{e.name}</button>
                  <span style={{ color: '#a8d8bc' }}>{e.age}歳・{e.jobLevel}・給与¥{e.salary}・{e.shift !== '—' ? e.shift : ''}・{e.currentActivity}</span>
                </div>
              ))}
              <div style={{ marginTop: 4, color: '#7fa892' }}>商品</div>
              {c.products.map((p) => (
                <div key={p.id} style={{ fontSize: 11 }}>{p.name}: ¥{p.price} / 在庫 {p.stock} / 最大 {p.maxStock}</div>
              ))}
              <div style={{ marginTop: 4, color: '#7fa892' }}>客</div>
              <div>本日来客数: {c.customerCountToday} / 店内: {c.currentVisitors} / 容量 {c.capacity}</div>
              <div style={{ marginTop: 4, color: '#7fa892' }}>財務</div>
              <div>現金: ¥{c.money.toLocaleString()} / 資産: ¥{c.assetValue.toLocaleString()}</div>
              <div>本日売上: ¥{c.revenueToday.toLocaleString()} / 経費: ¥{c.expensesToday.toLocaleString()} / 利益: ¥{c.profitToday.toLocaleString()}</div>
              <div>累計売上: ¥{c.revenueTotal.toLocaleString()}</div>
              <div>
                店長: {c.ownerName}
                {c.ownerId && <button onClick={() => openCitizenInspectorById(c.ownerId)} style={{ marginLeft: 6, padding: '1px 6px', background: 'rgba(127,224,224,0.15)', border: '1px solid #7fe0e0', borderRadius: 4, color: '#7fe0e0', fontSize: 10, cursor: 'pointer' }}>詳細</button>}
              </div>
              {c.visitorNames.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <div style={{ color: '#7fa892' }}>現在店内にいる人</div>
                  {c.visitorNames.map((v) => (
                    <button key={v.id} onClick={() => openCitizenInspectorById(v.id)} style={{ display: 'block', background: 'none', border: 'none', color: '#7fe0e0', cursor: 'pointer', padding: 0, fontSize: 11, textDecoration: 'underline' }}>{v.name}</button>
                  ))}
                </div>
              )}
            </div>
          ); })()}

          {storePanel.workplace && !storePanel.commercial && (
            <div>
              <div style={{ color: '#ffd35a' }}>職場 {storePanel.workplace.id}（{storePanel.workplace.jobLevel}）</div>
              <div>給与: ¥{storePanel.workplace.salary.toLocaleString()}/月</div>
              <div>従業員数: {storePanel.workplace.filled} / {storePanel.workplace.capacity}</div>
              {storePanel.workplace.employees.map((e) => (
                <button key={e.id} onClick={() => openCitizenInspectorById(e.id)} style={{ display: 'block', background: 'none', border: 'none', color: '#7fe0e0', cursor: 'pointer', padding: 0, fontSize: 11, textDecoration: 'underline' }}>{e.name}</button>
              ))}
            </div>
          )}

          {storePanel.industrial && (() => { const d = storePanel.industrial; return (
            <div>
              <div style={{ color: '#ffd35a', fontWeight: 'bold' }}>{d.name}（Lv.{d.level}）</div>
              <div>種類: {d.category} / 稼働状態: {d.status} / Building ID: {d.buildingId}</div>
              <div style={{ marginTop: 4, color: '#7fa892' }}>雇用</div>
              <div>必要人数: {d.requiredEmployees} / 現在人数: {d.currentEmployees} / 欠員: {d.deficit}</div>
              {d.employees.map((e) => (
                <div key={e.id} style={{ marginLeft: 6, fontSize: 11, display: 'flex', alignItems: 'center', gap: 4 }}>
                  <button onClick={() => openCitizenInspectorById(e.id)} style={{ background: 'none', border: 'none', color: '#7fe0e0', cursor: 'pointer', padding: 0, fontSize: 11, textDecoration: 'underline' }}>{e.name}</button>
                  <span style={{ color: '#a8d8bc' }}>{e.age}歳・{e.jobLevel}・給与¥{e.salary}</span>
                </div>
              ))}
              <div style={{ marginTop: 4, color: '#7fa892' }}>生産</div>
              {d.produces.map((p) => <div key={p.id} style={{ fontSize: 11 }}>生産: {p.name} ×{p.rate}/tick</div>)}
              {d.needs.map((n) => <div key={n.id} style={{ fontSize: 11 }}>原材料: {n.name} ×{n.rate}/tick</div>)}
              <div style={{ marginTop: 4, color: '#7fa892' }}>在庫</div>
              {d.storage.map((s) => <div key={s.id} style={{ fontSize: 11 }}>{s.name}: {s.qty}{s.capacity != null ? ` / ${s.capacity}` : ''}</div>)}
              <div style={{ marginTop: 4, color: '#7fa892' }}>財務</div>
              <div>資産: ¥{d.assetValue.toLocaleString()} / 現金: ¥{d.cash.toLocaleString()}</div>
              <div>本日売上: ¥{d.revenueToday.toLocaleString()} / 経費: ¥{d.expensesToday.toLocaleString()}</div>
              <div>本日利益: ¥{d.profitToday.toLocaleString()} / 累積利益: ¥{d.cumulativeProfit.toLocaleString()}</div>
              <div style={{ marginTop: 4, color: '#7fa892' }}>環境</div>
              <div>大気: {d.pollution.air.toFixed(2)} / 土壌: {d.pollution.soil.toFixed(2)} / 騒音: {d.pollution.noise.toFixed(2)}</div>
              <div style={{ marginTop: 4, color: '#7fa892' }}>物流</div>
              {d.logistics.length > 0 ? d.logistics.map((l) => (
                <div key={l.id} style={{ fontSize: 11 }}>{l.name} 供給元まで {l.distance} / 輸送コスト ¥{l.cost}</div>
              )) : <div style={{ fontSize: 11, color: '#7fa892' }}>原材料調達なし（一次産業）</div>}
              {d.shipsTo.map((s) => (
                <div key={s.id} style={{ fontSize: 11 }}>{s.name} 市場出荷（充足率 {s.fulfillment != null ? `${s.fulfillment}%` : '—'}）</div>
              ))}
            </div>
          ); })()}

          <button onClick={() => setStorePanel(null)} style={{ marginTop: 8, padding: '6px 10px', background: 'rgba(127,224,224,0.1)', border: '1px solid #7fe0e0', borderRadius: 4, color: '#7fe0e0', fontSize: 12, cursor: 'pointer' }}>閉じる</button>
        </div>
      )}

      {cameraMode === 'driver' && (
        <div style={{ position: 'absolute', top: 16, left: 16, padding: '10px 14px', background: 'rgba(15, 21, 18, 0.85)', border: '1px solid #ffd35a', borderRadius: 4, color: '#e8e8e8', fontSize: 12 }}>
          <div style={{ color: '#ffd35a', marginBottom: 4 }}>運転視点 — {driverPanel?.name}</div>
          <div style={{ marginBottom: 8 }}>{driverPanel?.dest}</div>
          <button onClick={exitDriverView} style={{ padding: '6px 12px', background: 'rgba(255,211,90,0.15)', border: '1px solid #ffd35a', borderRadius: 4, color: '#ffd35a', fontSize: 12, cursor: 'pointer' }}>俯瞰視点に戻る</button>
        </div>
      )}

      {cameraMode === 'ped' && (
        <div style={{ position: 'absolute', top: 16, left: 16, padding: '10px 14px', background: 'rgba(15, 21, 18, 0.85)', border: '1px solid #7fe0e0', borderRadius: 4, color: '#e8e8e8', fontSize: 12 }}>
          <div style={{ color: '#7fe0e0', marginBottom: 4 }}>歩行者視点 — {pedPanel?.name}</div>
          <div style={{ marginBottom: 8 }}>{pedPanel?.dest}</div>
          <button onClick={exitPedView} style={{ padding: '6px 12px', background: 'rgba(127,224,224,0.15)', border: '1px solid #7fe0e0', borderRadius: 4, color: '#7fe0e0', fontSize: 12, cursor: 'pointer' }}>俯瞰視点に戻る</button>
        </div>
      )}
    </div>
  );
}
