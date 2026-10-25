/**
 * Directions in which buses pass each stop, worked out from the timetable: for every visit of a
 * stop the travel bearing (previous stop → next stop) is taken, and the bearings are grouped –
 * opposite directions (> 90° apart) form separate groups.
 *
 *  1 group  → a one-direction stop (buses stop on one side of the road only)
 *  2 groups → a stop used in both directions (buses stop on both sides)
 *
 * Used by build-gtfs.mjs (stop info for the app) and build-shapes.mjs (a road point per direction).
 */

/**
 * @param {[string, string, number, number][]} stops  gtfs.json stops ([id, name, lat, lng])
 * @param {{ stops: number[] }[]} variants             gtfs.json route variants
 * @returns {{ bearing: number, visits: number }[][]}  direction groups per stop position
 */
export function stopDirections(stops, variants) {
  const bearings = stops.map(() => []);
  for (const v of variants) {
    const s = v.stops;
    for (let i = 0; i < s.length; i++) {
      const prev = s[Math.max(0, i - 1)];
      const next = s[Math.min(s.length - 1, i + 1)];
      if (prev === next) continue;
      bearings[s[i]].push(bearing(stops[prev][2], stops[prev][3], stops[next][2], stops[next][3]));
    }
  }
  return bearings.map(groupBearings);
}

/** Groups bearings so that each group holds directions less than 90° apart. Largest first. */
export function groupBearings(list) {
  const groups = []; // { x, y, visits } – sum of unit vectors
  for (const b of list) {
    const r = (b * Math.PI) / 180;
    const g = groups.find(g => angleDiff(meanOf(g), b) < 90);
    if (g) {
      g.x += Math.sin(r);
      g.y += Math.cos(r);
      g.visits++;
    } else {
      groups.push({ x: Math.sin(r), y: Math.cos(r), visits: 1 });
    }
  }
  return groups
    .sort((a, b) => b.visits - a.visits)
    .map(g => ({ bearing: Math.round(meanOf(g)), visits: g.visits }));
}

/** Index of the group whose bearing is closest to `b`. */
export function nearestGroup(groups, b) {
  let best = 0;
  groups.forEach((g, i) => {
    if (angleDiff(g.bearing, b) < angleDiff(groups[best].bearing, b)) best = i;
  });
  return best;
}

export function bearing(lat1, lng1, lat2, lng2) {
  const r = Math.PI / 180;
  const y = Math.sin((lng2 - lng1) * r) * Math.cos(lat2 * r);
  const x = Math.cos(lat1 * r) * Math.sin(lat2 * r) - Math.sin(lat1 * r) * Math.cos(lat2 * r) * Math.cos((lng2 - lng1) * r);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

export function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function meanOf(g) {
  return ((Math.atan2(g.x, g.y) * 180) / Math.PI + 360) % 360;
}
