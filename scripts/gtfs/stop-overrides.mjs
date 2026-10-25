/**
 * Manual corrections of stops (scripts/gtfs/stop-overrides.json), made in the app's stop editor
 * (open the app with ?dev). Every entry is a stop someone has checked:
 *
 *   "13890048_1": { "name": "JASŁO,ul.3 MAJA 01", "directions": 1 }
 *
 *   directions 1 – buses stop on one side of the road only (one road point for all of them)
 *   directions 2 – buses stop on both sides
 *   lat, lng     – (optional) where the stop really is, instead of the GTFS position
 *   roadPoints   – (optional) where buses stop on the road: [lat, lng, travel bearing] per
 *                  direction; build-shapes.mjs snaps each to the nearest road
 *
 * Entries are matched by stop id and name; when a new GTFS file renumbers stops, by name and
 * position (within MATCH_M). Used by build-stops.mjs and build-shapes.mjs.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const OVERRIDES_FILE = join(dirname(fileURLToPath(import.meta.url)), 'stop-overrides.json');
const MATCH_M = 150;

/**
 * @param {[string, string, number, number][]} stops  gtfs.json stops
 * @returns {({ directions?: 1 | 2 } | null)[]}       override per stop position
 */
export function stopOverrides(stops, file = OVERRIDES_FILE) {
  const out = stops.map(() => null);
  if (!existsSync(file)) return out;
  const entries = JSON.parse(readFileSync(file, 'utf8'));
  const byId = new Map(stops.map((s, i) => [s[0], i]));
  for (const [id, o] of Object.entries(entries)) {
    let pos = byId.get(id);
    if (pos === undefined || stops[pos][1] !== o.name) {
      // Renumbered stop: same name, close to where it was
      const was = pos === undefined ? null : stops[pos];
      pos = stops.findIndex(s => s[1] === o.name && (!was || distanceM(s[2], s[3], was[2], was[3]) < MATCH_M));
      if (pos < 0) {
        console.warn(`⚠ stop-overrides.json: no stop "${o.name}" (${id}) in the timetable – skipped`);
        continue;
      }
    }
    out[pos] = o;
  }
  return out;
}

/** Direction groups of a stop (from stop-directions.mjs) with a manual override applied. */
export function withOverride(groups, override) {
  if (override?.directions === 1 && groups.length > 1) {
    // One stopping place for every direction: snapped along the main direction
    return [{ bearing: groups[0].bearing, visits: groups.reduce((n, g) => n + g.visits, 0) }];
  }
  return groups;
}

function distanceM(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const x = (lng2 - lng1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}
