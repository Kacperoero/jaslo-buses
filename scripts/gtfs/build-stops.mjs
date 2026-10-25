#!/usr/bin/env node
/**
 * Writes public/assets/data/stops-base.json (stops for the map) from gtfs.json and the manual
 * corrections in scripts/gtfs/stop-overrides.json. Runs as part of build-gtfs.mjs; on its own:
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
 */
export function buildStops({ stops, variants }) {
  const overrides = stopOverrides(stops);
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
      ...(directions !== timetable ? { timetableDirections: timetable } : {})
    }];
  });
  return { stops: out, checked: overrides.filter(Boolean).length };
}

export function writeStops(gtfs) {
  const { stops: out, checked } = buildStops(gtfs);
  writeFileSync(join(DATA, 'stops-base.json'), JSON.stringify(out, null, 2) + '\n');
  const changed = out.filter(s => s.timetableDirections).length;
  console.log(`stops-base.json: ${out.length} stops; ${checked} checked by hand, ${changed} with directions changed by hand`);
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
