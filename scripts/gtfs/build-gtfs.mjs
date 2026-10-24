#!/usr/bin/env node
/**
 * Builds the app's timetable data from the official MKS Jasło GTFS feed.
 *
 *   npm run gtfs:build -- --zip path/to/GTFS_1389_….zip
 *   npm run gtfs:build -- --download      (fetches the current file from mksjaslo.pl)
 *
 * Writes (all served from public/assets/data):
 *   gtfs.json             stops, route variants with line numbers, trips, service calendar
 *   stops-base.json       stops for the map (same shape the app used before)
 *   legacy-stop-ids.json  old stop IDs (kiedyprzyjedzie) → GTFS IDs, to migrate saved favourites
 *
 * Line numbers come from scripts/gtfs/line-assignments.json (see assign_lines.py) and
 * scripts/gtfs/line-overrides.json (manual fixes, they win). No dependencies – Node ≥ 18.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const OUT = join(ROOT, 'public', 'assets', 'data');
const GTFS_PAGE = 'https://www.mksjaslo.pl/strefa-pasazera/gtfs';

// ── Command line ─────────────────────────────────────────────────────
const args = process.argv.slice(2);
const zipArg = args[args.indexOf('--zip') + 1];
let zipName;
let zipBytes;
if (args.includes('--download')) {
  const page = await (await fetch(GTFS_PAGE)).text();
  const href = page.match(/href="([^"]*\/media\/GTFS\/[^"]+\.zip)"/i)?.[1];
  if (!href) throw new Error(`No GTFS link found on ${GTFS_PAGE}`);
  const url = new URL(href, GTFS_PAGE).toString();
  console.log(`Downloading ${url}`);
  zipBytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  zipName = basename(new URL(url).pathname);
} else if (args.includes('--zip') && zipArg) {
  zipBytes = readFileSync(zipArg);
  zipName = basename(zipArg);
} else {
  console.error('Usage: build-gtfs.mjs --zip <GTFS.zip> | --download');
  process.exit(1);
}

// ── Minimal ZIP + CSV readers ────────────────────────────────────────
function unzip(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('Not a ZIP file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files[name] = method === 0 ? raw : inflateRawSync(raw);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

function parseCsv(text) {
  text = text.replace(/^﻿/, '');
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map(r => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

const files = unzip(zipBytes);
const table = name => {
  if (!files[name]) throw new Error(`${name} missing in ${zipName}`);
  return parseCsv(files[name].toString('utf8'));
};

const stops = table('stops.txt');
const trips = table('trips.txt');
const stopTimes = table('stop_times.txt');
const calendar = table('calendar.txt');
const calendarDates = files['calendar_dates.txt'] ? table('calendar_dates.txt') : [];
const feedInfo = files['feed_info.txt'] ? table('feed_info.txt')[0] : {};

// ── Stops ────────────────────────────────────────────────────────────
const stopIndex = new Map();
const outStops = stops.map((s, i) => {
  stopIndex.set(s.stop_id, i);
  return [s.stop_id, s.stop_name.trim(), round6(+s.stop_lat), round6(+s.stop_lon)];
});

// ── Trips grouped into route variants (same stop sequence) ───────────
const minutes = t => {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
};
const signature = names => createHash('sha1').update(names.join('|'), 'utf8').digest('hex').slice(0, 16);

const byTrip = new Map();
for (const r of stopTimes) {
  if (!byTrip.has(r.trip_id)) byTrip.set(r.trip_id, []);
  byTrip.get(r.trip_id).push(r);
}

const assignments = readJson(join(HERE, 'line-assignments.json'), {});
const overrides = readJson(join(HERE, 'line-overrides.json'), {});
const tripById = new Map(trips.map(t => [t.trip_id, t]));

// Service calendar → one bitmap per distinct day pattern
const allDates = [
  ...calendar.flatMap(c => [c.start_date, c.end_date]),
  ...calendarDates.map(d => d.date)
].sort();
const firstDate = toDate(allDates[0]);
const lastDate = toDate(allDates[allDates.length - 1]);
const dayCount = Math.round((lastDate - firstDate) / 86400000) + 1;
const weekdays = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const exceptions = new Map();
for (const d of calendarDates) {
  if (!exceptions.has(d.service_id)) exceptions.set(d.service_id, new Map());
  exceptions.get(d.service_id).set(d.date, d.exception_type);
}
const calById = new Map(calendar.map(c => [c.service_id, c]));
const serviceBitmaps = [];
const bitmapIndex = new Map();
function serviceIndex(serviceId) {
  const bits = Buffer.alloc(Math.ceil(dayCount / 8));
  const cal = calById.get(serviceId);
  for (let i = 0; i < dayCount; i++) {
    const day = new Date(firstDate.getTime() + i * 86400000);
    const key = ymd(day);
    const e = exceptions.get(serviceId)?.get(key);
    const regular = !!cal && cal[weekdays[day.getUTCDay()]] === '1' && cal.start_date <= key && key <= cal.end_date;
    if (e === '1' || (e !== '2' && regular)) bits[i >> 3] |= 1 << (i & 7);
  }
  const b64 = bits.toString('base64');
  if (!bitmapIndex.has(b64)) {
    bitmapIndex.set(b64, serviceBitmaps.length);
    serviceBitmaps.push(b64);
  }
  return bitmapIndex.get(b64);
}

const variants = [];
const variantIndex = new Map(); // `${signature}|${line}|${headsign}` -> index
const outTrips = [];
const stats = { trips: 0, withLine: 0, unknownVariants: new Set() };
for (const [tripId, rows] of byTrip) {
  rows.sort((a, b) => Number(a.stop_sequence) - Number(b.stop_sequence));
  const trip = tripById.get(tripId);
  const names = rows.map(r => stops[stopIndex.get(r.stop_id)].stop_name.trim());
  const sig = signature(rows.map(r => stops[stopIndex.get(r.stop_id)].stop_name));
  const t = rows.map(r => minutes(r.departure_time || r.arrival_time));
  const start = `${String(Math.floor(t[0] / 60) % 24).padStart(2, '0')}:${String(t[0] % 60).padStart(2, '0')}`;

  // Line: automatic assignment, then manual overrides; per-trip entries ("byStart") win, null = unknown
  const auto = assignments[sig] ?? {};
  const override = overrides[sig] ?? {};
  let line = auto.line ?? null;
  if (auto.byStart && start in auto.byStart) line = auto.byStart[start];
  if ('line' in override) line = override.line;
  if (override.byStart && start in override.byStart) line = override.byStart[start];
  if (!assignments[sig]) stats.unknownVariants.add(`${names[0]} → ${names[names.length - 1]}`);
  stats.trips++;
  if (line) stats.withLine++;

  const headsign = (trip?.trip_headsign || names[names.length - 1]).trim();
  const vKey = `${sig}|${line}|${headsign}`;
  if (!variantIndex.has(vKey)) {
    variantIndex.set(vKey, variants.length);
    variants.push({ line, headsign, stops: rows.map(r => stopIndex.get(r.stop_id)) });
  }
  // [variant, service, first departure (minutes after midnight), minutes to each next stop…]
  outTrips.push([variantIndex.get(vKey), serviceIndex(trip.service_id), t[0], ...t.slice(1).map((m, i) => m - t[i])]);
}
outTrips.sort((a, b) => a[2] - b[2]);

const feed = {
  file: zipName,
  publisher: feedInfo.feed_publisher_name || '',
  validFrom: iso(firstDate),
  validTo: iso(lastDate),
  builtAt: new Date().toISOString()
};
const gtfs = {
  feed,
  stops: outStops,
  variants,
  trips: outTrips,
  services: { start: iso(firstDate), days: dayCount, bitmaps: serviceBitmaps }
};
writeFileSync(join(OUT, 'gtfs.json'), JSON.stringify(gtfs));

// ── stops-base.json + migration of old stop IDs ──────────────────────
const stopsBasePath = join(OUT, 'stops-base.json');
const legacyPath = join(OUT, 'legacy-stop-ids.json');
const oldStops = readJson(stopsBasePath, []);
if (oldStops.some(s => String(s.id).includes(':'))) {
  // Old file still has kiedyprzyjedzie IDs: map each to the GTFS stop with the same name nearby
  const legacy = {};
  for (const old of oldStops) {
    let best = null;
    for (const [id, name, lat, lng] of outStops) {
      const d = distanceM(old.lat, old.lng, lat, lng) + (name === old.name ? 0 : 1000);
      if (!best || d < best.d) best = { id, d };
    }
    if (best && best.d < 300) legacy[old.id] = best.id;
  }
  writeFileSync(legacyPath, JSON.stringify(legacy, null, 1) + '\n');
  console.log(`legacy-stop-ids.json: ${Object.keys(legacy).length} of ${oldStops.length} old stop IDs mapped`);
}
const servedStops = new Set(variants.flatMap(v => v.stops));
writeFileSync(stopsBasePath, JSON.stringify(outStops
  .map(([id, name, lat, lng], i) => ({ id, designator: i + 1, name, lat, lng, onlyDisembarking: false, _i: i }))
  .filter(s => servedStops.has(s._i))
  .map(({ _i, ...s }) => s), null, 2) + '\n');

console.log(`${zipName}: valid ${feed.validFrom} – ${feed.validTo}`);
console.log(`${outStops.length} stops, ${variants.length} route variants, ${stats.trips} trips ` +
  `(${stats.withLine} with a line number), ${serviceBitmaps.length} distinct service calendars`);
if (stats.unknownVariants.size) {
  console.log(`\n⚠ ${stats.unknownVariants.size} route variants are not in line-assignments.json ` +
    `(new timetable?) – run assign_lines.py again:`);
  [...stats.unknownVariants].slice(0, 15).forEach(v => console.log(`   ${v}`));
}

// ── helpers ──────────────────────────────────────────────────────────
function readJson(path, fallback) {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback;
}
function round6(x) { return Math.round(x * 1e6) / 1e6; }
function toDate(s) { return new Date(Date.UTC(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8))); }
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ''); }
function iso(d) { return d.toISOString().slice(0, 10); }
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371e3, r = Math.PI / 180;
  const a = Math.sin((lat2 - lat1) * r / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin((lng2 - lng1) * r / 2) ** 2;
  return 2 * R * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
