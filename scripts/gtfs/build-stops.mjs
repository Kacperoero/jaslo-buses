#!/usr/bin/env node
/**
 * Applies the manual corrections in scripts/gtfs/stop-overrides.json: moved stops get their new
 * position in gtfs.json (the GTFS position is kept in its `originalPositions`, so a correction
 * can be undone), and public/assets/data/stops-base.json (stops for the map) is written.
 * Runs as part of build-gtfs.mjs; on its own:
 *
 *   npm run gtfs:stops                                       (also redraws road shapes)
 *   npm run gtfs:stops -- --import ~/Pobrane/stop-overrides.json
 *        (first copies the file exported from the stop editor to scripts/gtfs/)
 */
import { spawnSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stopDirections } from './stop-directions.mjs';
import { OVERRIDES_FILE, stopOverrides, withOverride } from './stop-overrides.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA = join(HERE, '..', '..', 'public', 'assets', 'data');

/**
 * stops-base.json entries for the stops some route serves (and how many stops have a manual check):
 *   directions           1: one side of the road / one direction, 2: both directions
 *   towards              one-direction stops: the usual next stop
 *   timetableDirections  only when a manual override changed `directions`: what the timetable says
 *   gtfsPosition         only for moved stops: [lat, lng] from the GTFS file
 */
export function buildStops({ stops, variants }, overrides, originalPositions = {}) {
  const groups = stopDirections(stops, variants);
  const served = new Set(variants.flatMap(v => v.stops));
  const nextVotes = stops.map(() => new Map());
  for (const v of variants) {
    v.stops.slice(0, -1).forEach((s, i) => {
      const next = stops[v.stops[i + 1]][1];
      nextVotes[s].set(next, (nextVotes[s].get(next) ?? 0) + 1);
    });
  }
  const towardsOf = i => [...nextVotes[i].entries()].sort((a, b) => b[1] - a[1])[0]?.[0];

  const out = stops.flatMap(([id, name, lat, lng], i) => {
    if (!served.has(i)) return [];
    const timetable = Math.min(2, groups[i].length || 1);
    const directions = overrides[i]?.directions ?? Math.min(2, withOverride(groups[i], overrides[i]).length || 1);
    const towards = directions === 1 ? towardsOf(i) : undefined;
    return [{
      id, designator: i + 1, name, lat, lng, onlyDisembarking: false,
      directions,
      ...(towards ? { towards } : {}),
      ...(directions !== timetable ? { timetableDirections: timetable } : {}),
      ...(originalPositions[id] ? { gtfsPosition: originalPositions[id] } : {})
    }];
  });
  return { stops: out, checked: overrides.filter(Boolean).length };
}

/** Applies the corrections to `gtfs` (and gtfs.json) and writes stops-base.json. */
export function writeStops(gtfs) {
  // Start from the GTFS positions, then move the corrected stops
  const original = gtfs.originalPositions ?? {};
  for (const s of gtfs.stops) {
    if (original[s[0]]) [s[2], s[3]] = original[s[0]];
  }
  const overrides = stopOverrides(gtfs.stops);
  const moved = {};
  gtfs.stops.forEach((s, i) => {
    const o = overrides[i];
    if (typeof o?.lat !== 'number' || typeof o?.lng !== 'number') return;
    moved[s[0]] = [s[2], s[3]];
    [s[2], s[3]] = [o.lat, o.lng];
  });
  delete gtfs.originalPositions;
  if (Object.keys(moved).length) gtfs.originalPositions = moved;
  writeFileSync(join(DATA, 'gtfs.json'), JSON.stringify(gtfs));

  const { stops: out, checked } = buildStops(gtfs, overrides, moved);
  writeFileSync(join(DATA, 'stops-base.json'), JSON.stringify(out, null, 2) + '\n');
  const changed = out.filter(s => s.timetableDirections).length;
  const roadPoints = overrides.filter(o => o?.roadPoints?.length).length;
  console.log(`stops-base.json: ${out.length} stops; ${checked} checked by hand – ${changed} with directions changed, ` +
    `${Object.keys(moved).length} moved, ${roadPoints} with road points set by hand`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const imported = args[args.indexOf('--import') + 1];
  if (args.includes('--import')) {
    JSON.parse(readFileSync(imported, 'utf8')); // must be valid JSON
    copyFileSync(imported, OVERRIDES_FILE);
    console.log(`${imported} → scripts/gtfs/stop-overrides.json`);
  }
  writeStops(JSON.parse(readFileSync(join(DATA, 'gtfs.json'), 'utf8')));
  // Road points depend on the directions – redraw the road lines too
  const shapes = spawnSync(process.execPath, [join(HERE, 'build-shapes.mjs')], { stdio: 'inherit' });
  process.exit(shapes.status ?? 1);
}
