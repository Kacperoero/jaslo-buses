import { GtfsIndex } from '../../core/services/gtfs.service';
import { UNKNOWN_LINE } from '../../core/services/timetable.service';
import { getDistance } from '../../shared/utils/geo.utils';

/** Buses are shown at the first stop this long before they leave it */
export const WAITING_MIN = 3;

/** Where a bus should be according to the timetable (no GPS – MKS has no public live data). */
export interface ScheduledBus {
  /** Unique while the bus runs: trip index and service day ("12@0", "40@-1" = yesterday's trip after midnight) */
  key: string;
  trip: number;
  line: string;
  headsign: string;
  lat: number;
  lng: number;
  /** Direction of travel in degrees (null while waiting at the first stop) */
  bearing: number | null;
  /** Waiting at the first stop for its departure */
  waiting: boolean;
  /** Stop position (in GtfsIndex.stops) the bus heads to next – or waits at */
  nextStop: number;
  /** Index of that stop within the trip (trip.variant.stops / trip.times) */
  nextIndex: number;
  /** Service day of the trip relative to `at`'s day: 0 today, -1 yesterday (after midnight) */
  dayOffset: number;
  /** When it leaves / reaches that stop, minutes after midnight of `at`'s day (may be < 0 or ≥ 1440) */
  nextMinute: number;
}

/** Road line between two consecutive stops (by stop position), first point at the first stop. */
export type PathBetween = (from: number, to: number) => [number, number][];

/**
 * Positions of all buses running at `at`: each trip runs between its timetabled times at
 * consecutive stops, at a steady pace along the road line between them.
 */
export function busesAt(index: GtfsIndex, at: Date, pathBetween: PathBetween): ScheduledBus[] {
  const now = at.getHours() * 60 + at.getMinutes() + at.getSeconds() / 60;
  const buses: ScheduledBus[] = [];

  // Yesterday's trips may still run after midnight
  for (const dayOffset of [-1, 0]) {
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() + dayOffset);
    const t = now - dayOffset * 1440; // minutes after midnight of the trip's service day
    for (const trip of index.trips) {
      const times = trip.times;
      if (t < times[0] - WAITING_MIN || t >= times[times.length - 1]) continue;
      if (!index.runsOn(trip.service, day)) continue;

      const stops = trip.variant.stops;
      const base = {
        key: `${trip.index}@${dayOffset}`,
        trip: trip.index,
        dayOffset,
        line: trip.variant.line ?? UNKNOWN_LINE,
        headsign: trip.variant.headsign
      };

      if (t < times[0]) {
        const [, , lat, lng] = index.stops[stops[0]];
        buses.push({ ...base, lat, lng, bearing: null, waiting: true, nextStop: stops[0], nextIndex: 0, nextMinute: times[0] + dayOffset * 1440 });
        continue;
      }

      // Between stop i (left at times[i]) and stop i + 1 (reached at times[i + 1])
      let i = 0;
      while (i < times.length - 2 && times[i + 1] <= t) i++;
      const span = times[i + 1] - times[i];
      const fraction = span > 0 ? (t - times[i]) / span : 1;
      const [lat, lng, bearing] = pointAlong(pathBetween(stops[i], stops[i + 1]), fraction);
      buses.push({ ...base, lat, lng, bearing, waiting: false, nextStop: stops[i + 1], nextIndex: i + 1, nextMinute: times[i + 1] + dayOffset * 1440 });
    }
  }
  return buses;
}

/** The point `fraction` (0–1) of the way along a line, with the direction of travel there. */
export function pointAlong(points: [number, number][], fraction: number): [number, number, number | null] {
  if (points.length === 0) return [0, 0, null];
  if (points.length === 1) return [points[0][0], points[0][1], null];
  const lengths = points.slice(1).map((p, k) => getDistance(points[k][0], points[k][1], p[0], p[1]));
  const total = lengths.reduce((a, b) => a + b, 0);
  let left = Math.min(1, Math.max(0, fraction)) * total;
  for (let k = 0; k < lengths.length; k++) {
    const [a, b] = [points[k], points[k + 1]];
    if (left <= lengths[k] || k === lengths.length - 1) {
      const f = lengths[k] > 0 ? Math.min(1, left / lengths[k]) : 0;
      return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, bearing(a, b)];
    }
    left -= lengths[k];
  }
  return [points[points.length - 1][0], points[points.length - 1][1], null];
}

function bearing(a: [number, number], b: [number, number]): number {
  const r = Math.PI / 180;
  const y = Math.sin((b[1] - a[1]) * r) * Math.cos(b[0] * r);
  const x = Math.cos(a[0] * r) * Math.sin(b[0] * r) - Math.sin(a[0] * r) * Math.cos(b[0] * r) * Math.cos((b[1] - a[1]) * r);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
