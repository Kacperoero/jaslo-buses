#!/usr/bin/env node
/**
 * Computes road-following lines between consecutive bus stops, so the map draws buses along
 * roads instead of straight lines. Runs at build time – the app makes no routing requests.
 *
 *   npm run gtfs:shapes                 (uses scripts/gtfs/.cache/osm-roads.json when present)
 *   npm run gtfs:shapes -- --refresh    (downloads the road network again)
 *
 * 1. Road network from OpenStreetMap (one Overpass API request for the area of all stops,
 *    cached in scripts/gtfs/.cache/ – not committed).
 * 2. Every stop is snapped to the nearest point on a road (major roads preferred).
 * 3. For every pair of consecutive stops a bus drives between, the shortest road path (A*,
 *    respecting one-way streets for buses). Suspiciously long paths keep a straight line.
 * 4. public/assets/data/shapes.json: simplified lines as encoded polylines.
 *
 * Road data © OpenStreetMap contributors, ODbL – shapes.json is derived from it.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const CACHE = join(HERE, '.cache');
const OSM_FILE = join(CACHE, 'osm-roads.json');
const OUT = join(ROOT, 'public', 'assets', 'data', 'shapes.json');
const REPORT = join(HERE, 'shapes-report.json');
const OVERPASS = 'https://overpass-api.de/api/interpreter';

const MARGIN_DEG = 0.01;          // ~1 km around the stops
const SNAP_MAX_M = 150;           // stops further from any road keep straight lines
const SIMPLIFY_M = 4;             // Douglas–Peucker tolerance
const MAX_DETOUR_RATIO = 3;       // road path longer than this × straight line …
const MAX_DETOUR_EXTRA_M = 1000;  // … and longer by more than this → keep straight

/** Cost factor per road type – buses prefer bigger roads; service roads only when needed. */
const ROAD_COST = {
  motorway: 1, trunk: 1, primary: 1, secondary: 1, tertiary: 1,
  motorway_link: 1, trunk_link: 1, primary_link: 1, secondary_link: 1, tertiary_link: 1,
  busway: 1, unclassified: 1.05, residential: 1.1, road: 1.2, living_street: 1.4, service: 1.8
};

/** Binary min-heap for A*. */
class MinHeap {
  items = []; prio = [];
  get size() { return this.items.length; }
  push(item, p) {
    this.items.push(item); this.prio.push(p);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.prio[parent] <= this.prio[i]) break;
      this.swap(i, parent); i = parent;
    }
  }
  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop(), lastPrio = this.prio.pop();
    if (this.items.length) {
      this.items[0] = lastItem; this.prio[0] = lastPrio;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < this.items.length && this.prio[l] < this.prio[m]) m = l;
        if (r < this.items.length && this.prio[r] < this.prio[m]) m = r;
        if (m === i) break;
        this.swap(i, m); i = m;
      }
    }
    return top;
  }
  swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.prio[a], this.prio[b]] = [this.prio[b], this.prio[a]];
  }
}

// ── Data ─────────────────────────────────────────────────────────────
const gtfs = JSON.parse(readFileSync(join(ROOT, 'public', 'assets', 'data', 'gtfs.json'), 'utf8'));
const stops = gtfs.stops.map(([id, name, lat, lng]) => ({ id, name, lat, lng }));
const pairs = new Map(); // "a>b" (stop positions) -> [a, b]
for (const v of gtfs.variants) {
  for (let i = 1; i < v.stops.length; i++) {
    const a = v.stops[i - 1], b = v.stops[i];
    if (a !== b) pairs.set(`${a}>${b}`, [a, b]);
  }
}

const osm = await loadRoads();
console.log(`OSM: ${osm.elements.length} elements`);

// ── Graph ────────────────────────────────────────────────────────────
const nodeIndex = new Map();   // OSM node id -> graph node
const lat = [], lng = [];
const adj = [];                // graph node -> [{to, cost, len}]
for (const el of osm.elements) {
  if (el.type === 'node') {
    nodeIndex.set(el.id, lat.length);
    lat.push(el.lat);
    lng.push(el.lon);
    adj.push([]);
  }
}
const segments = []; // { a, b, factor, forward, backward, rank } for snapping
for (const way of osm.elements) {
  if (way.type !== 'way') continue;
  const t = way.tags ?? {};
  const factor = ROAD_COST[t.highway];
  if (!factor || !busMayUse(t)) continue;
  const { forward, backward } = directions(t);
  const ids = way.nodes.map(n => nodeIndex.get(n)).filter(n => n !== undefined);
  for (let i = 1; i < ids.length; i++) {
    const a = ids[i - 1], b = ids[i];
    const len = dist(lat[a], lng[a], lat[b], lng[b]);
    if (forward) adj[a].push({ to: b, cost: len * factor, len });
    if (backward) adj[b].push({ to: a, cost: len * factor, len });
    segments.push({ a, b, factor, forward, backward });
  }
}
console.log(`graph: ${lat.length} nodes, ${segments.length} road segments`);

// ── Snapping stops to roads ──────────────────────────────────────────
const CELL = 0.002; // ~200 m grid for finding nearby segments
const grid = new Map();
segments.forEach((s, i) => {
  const [x0, x1] = [Math.min(lng[s.a], lng[s.b]), Math.max(lng[s.a], lng[s.b])];
  const [y0, y1] = [Math.min(lat[s.a], lat[s.b]), Math.max(lat[s.a], lat[s.b])];
  for (let x = Math.floor(x0 / CELL); x <= Math.floor(x1 / CELL); x++) {
    for (let y = Math.floor(y0 / CELL); y <= Math.floor(y1 / CELL); y++) {
      const k = `${x},${y}`;
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(i);
    }
  }
});

const snapOf = new Map(); // stop position -> { node, distance, segment }
const bySegment = new Map(); // segment -> [{ t, node }]
const report = { farFromRoad: [], straightPairs: [] };
stops.forEach((stop, pos) => {
  let best = null;
  const cx = Math.floor(stop.lng / CELL), cy = Math.floor(stop.lat / CELL);
  for (let x = cx - 1; x <= cx + 1; x++) {
    for (let y = cy - 1; y <= cy + 1; y++) {
      for (const i of grid.get(`${x},${y}`) ?? []) {
        const s = segments[i];
        const p = project(stop.lat, stop.lng, lat[s.a], lng[s.a], lat[s.b], lng[s.b]);
        const score = p.d * s.factor; // prefer bigger roads a little
        if (p.d <= SNAP_MAX_M && (!best || score < best.score)) best = { ...p, segment: i, score };
      }
    }
  }
  if (!best) {
    report.farFromRoad.push({ id: stop.id, name: stop.name });
    return;
  }
  // A new graph node at the snapped point
  const node = lat.length;
  lat.push(best.lat);
  lng.push(best.lng);
  adj.push([]);
  snapOf.set(pos, { node, distance: Math.round(best.d) });
  if (!bySegment.has(best.segment)) bySegment.set(best.segment, []);
  bySegment.get(best.segment).push({ t: best.t, node });
});

// Insert snapped points into their segments: a → p1 → p2 → … → b (keeps one-way rules)
for (const [i, points] of bySegment) {
  const s = segments[i];
  const chain = [s.a, ...points.sort((x, y) => x.t - y.t).map(p => p.node), s.b];
  for (let k = 1; k < chain.length; k++) {
    const a = chain[k - 1], b = chain[k];
    const len = dist(lat[a], lng[a], lat[b], lng[b]);
    if (s.forward) adj[a].push({ to: b, cost: len * s.factor, len });
    if (s.backward) adj[b].push({ to: a, cost: len * s.factor, len });
  }
}

// ── Paths between consecutive stops ──────────────────────────────────
const shapes = {};
let roadPairs = 0;
const t0 = Date.now();
for (const [a, b] of pairs.values()) {
  const sa = snapOf.get(a), sb = snapOf.get(b);
  if (!sa || !sb) continue;
  const path = astar(sa.node, sb.node);
  const straight = dist(stops[a].lat, stops[a].lng, stops[b].lat, stops[b].lng);
  if (!path) {
    report.straightPairs.push({ from: stops[a].name, to: stops[b].name, reason: 'no road path' });
    continue;
  }
  if (path.len > straight * MAX_DETOUR_RATIO && path.len > straight + MAX_DETOUR_EXTRA_M) {
    report.straightPairs.push({ from: stops[a].name, to: stops[b].name, reason: `detour ${Math.round(path.len)} m vs ${Math.round(straight)} m` });
    continue;
  }
  const points = [[stops[a].lat, stops[a].lng], ...path.nodes.map(n => [lat[n], lng[n]]), [stops[b].lat, stops[b].lng]];
  shapes[`${stops[a].id}>${stops[b].id}`] = encodePolyline(simplify(points, SIMPLIFY_M));
  roadPairs++;
}
console.log(`paths: ${roadPairs} of ${pairs.size} stop pairs follow roads (${((Date.now() - t0) / 1000).toFixed(1)} s)`);

writeFileSync(OUT, JSON.stringify({
  source: 'Road geometry © OpenStreetMap contributors (ODbL), computed by scripts/gtfs/build-shapes.mjs',
  timetable: gtfs.feed.file,
  builtAt: new Date().toISOString(),
  shapes
}));
report.snappedFarStops = [...snapOf.entries()]
  .filter(([, s]) => s.distance > 40)
  .map(([pos, s]) => ({ id: stops[pos].id, name: stops[pos].name, metersFromRoad: s.distance }))
  .sort((x, y) => y.metersFromRoad - x.metersFromRoad);
writeFileSync(REPORT, JSON.stringify(report, null, 1) + '\n');
console.log(`shapes.json: ${(JSON.stringify(shapes).length / 1024).toFixed(0)} KB, ` +
  `${report.straightPairs.length} straight pairs, ${report.farFromRoad.length} stops > ${SNAP_MAX_M} m from roads, ` +
  `${report.snappedFarStops.length} stops 40–${SNAP_MAX_M} m from roads (see shapes-report.json)`);

// ── helpers ──────────────────────────────────────────────────────────
async function loadRoads() {
  if (existsSync(OSM_FILE) && !process.argv.includes('--refresh')) {
    return JSON.parse(readFileSync(OSM_FILE, 'utf8'));
  }
  const s = Math.min(...stops.map(x => x.lat)) - MARGIN_DEG;
  const n = Math.max(...stops.map(x => x.lat)) + MARGIN_DEG;
  const w = Math.min(...stops.map(x => x.lng)) - MARGIN_DEG;
  const e = Math.max(...stops.map(x => x.lng)) + MARGIN_DEG;
  const types = Object.keys(ROAD_COST).join('|');
  const query = `[out:json][timeout:300];way["highway"~"^(${types})$"](${s},${w},${n},${e});out body;>;out skel qt;`;
  console.log(`Downloading roads from Overpass (${s.toFixed(3)},${w.toFixed(3)} – ${n.toFixed(3)},${e.toFixed(3)})…`);
  const res = await fetch(OVERPASS, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'jakdojade-jaslo-build/1.0 (bus timetable app, one-off build)' },
    body: 'data=' + encodeURIComponent(query)
  });
  if (!res.ok) throw new Error(`Overpass: HTTP ${res.status}`);
  const text = await res.text();
  mkdirSync(CACHE, { recursive: true });
  writeFileSync(OSM_FILE, text);
  console.log(`saved ${(text.length / 1048576).toFixed(1)} MB to ${OSM_FILE}`);
  return JSON.parse(text);
}

function busMayUse(t) {
  if (t.bus === 'yes' || t.psv === 'yes' || t.bus === 'designated' || t.psv === 'designated') return true;
  if (['no', 'private'].includes(t.access) || ['no', 'private'].includes(t.motor_vehicle)) return false;
  if (t.highway === 'service' && ['parking_aisle', 'driveway', 'drive-through'].includes(t.service)) return false;
  return true;
}

function directions(t) {
  const busTwoWay = t['oneway:bus'] === 'no' || t['oneway:psv'] === 'no';
  const oneway = t.oneway === 'yes' || t.oneway === '1' || t.oneway === 'true' || t.junction === 'roundabout';
  if (t.oneway === '-1') return { forward: busTwoWay, backward: true };
  if (oneway && !busTwoWay) return { forward: true, backward: false };
  return { forward: true, backward: true };
}

function dist(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const x = (lng2 - lng1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371e3;
}

/** Nearest point on segment AB to P: distance (m), position t (0..1) and coordinates. */
function project(plat, plng, alat, alng, blat, blng) {
  const kx = Math.cos(plat * Math.PI / 180);
  const ax = alng * kx, ay = alat, bx = blng * kx, by = blat, px = plng * kx, py = plat;
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  const qlat = alat + t * (blat - alat), qlng = alng + t * (blng - alng);
  return { t, lat: qlat, lng: qlng, d: dist(plat, plng, qlat, qlng) };
}

/** A* over the road graph; returns the node path (without start/end) and its length. */
function astar(from, to) {
  const g = new Map([[from, 0]]);
  const len = new Map([[from, 0]]);
  const prev = new Map();
  const heap = new MinHeap();
  const h = n => dist(lat[n], lng[n], lat[to], lng[to]);
  heap.push(from, h(from));
  const closed = new Set();
  while (heap.size) {
    const n = heap.pop();
    if (n === to) {
      const nodes = [];
      for (let c = prev.get(to); c !== undefined && c !== from; c = prev.get(c)) nodes.push(c);
      return { nodes: nodes.reverse(), len: len.get(to) };
    }
    if (closed.has(n)) continue;
    closed.add(n);
    for (const e of adj[n]) {
      const ng = g.get(n) + e.cost;
      if (ng < (g.get(e.to) ?? Infinity)) {
        g.set(e.to, ng);
        len.set(e.to, len.get(n) + e.len);
        prev.set(e.to, n);
        heap.push(e.to, ng + h(e.to));
      }
    }
  }
  return null;
}

/** Douglas–Peucker simplification (tolerance in metres). */
function simplify(points, tol) {
  if (points.length <= 2) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0, idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = project(points[i][0], points[i][1], points[s][0], points[s][1], points[e][0], points[e][1]).d;
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > tol) {
      keep[idx] = 1;
      stack.push([s, idx], [idx, e]);
    }
  }
  return points.filter((_, i) => keep[i]);
}

/** Google encoded polyline, precision 5. */
function encodePolyline(points) {
  let out = '', plat = 0, plng = 0;
  for (const [la, ln] of points) {
    const ilat = Math.round(la * 1e5), ilng = Math.round(ln * 1e5);
    out += enc(ilat - plat) + enc(ilng - plng);
    plat = ilat; plng = ilng;
  }
  return out;
  function enc(v) {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  }
}
