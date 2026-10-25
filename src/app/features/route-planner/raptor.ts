import { GtfsIndex, GtfsTrip, GtfsVariant } from '../../core/services/gtfs.service';
import { UNKNOWN_LINE } from '../../core/services/timetable.service';
import { Stop } from '../../shared/models/transit.models';
import { Connection, Leg, Place, RideLeg, TimeMode, WalkLeg } from './route-planner.models';

/**
 * Journey planning with RAPTOR (Round-bAsed Public Transit Optimized Router, Delling et al.).
 * Round k finds the earliest arrival at every stop using k bus rides; between rounds
 * passengers may walk to a nearby stop. Several runs with different departure times give a
 * choice of journeys, also for "arrive by" questions. Everything runs on the local timetable.
 */

/** Walking speed (metres per minute, straight line) – same as the rest of the app. */
export const WALK_M_PER_MIN = 80;
/** Changing buses at the same stop takes at least this long. */
export const MIN_CHANGE_MIN = 2;
/** Stops this close can be walked between when changing buses. */
export const MAX_TRANSFER_WALK_M = 500;
/** At most this many bus rides (3 changes). */
export const MAX_RIDES = 4;

/** Walking from a point to a stop (or from a stop to a point). */
export interface Access {
  stop: number;
  minutes: number;
  meters: number;
}

interface Footpath {
  to: number;
  minutes: number;
  meters: number;
}

interface DayTrip {
  trip: GtfsTrip;
  /** Minutes to add to the trip's times (−1440 yesterday, 0 today, 1440 tomorrow) */
  offset: number;
}

type Parent =
  | { kind: 'access'; access: Access }
  | { kind: 'ride'; trip: DayTrip; boardPos: number; alightPos: number; boardStop: number }
  | { kind: 'walk'; from: number; path: Footpath };

/** One RAPTOR result: arriving at `stop` (an end stop) after `rides` rides. */
interface Arrival {
  rides: number;
  stop: number;
  time: number;
}

export function walkMinutes(meters: number): number {
  return Math.ceil(meters / WALK_M_PER_MIN);
}

/** The timetable as RAPTOR needs it, built once per loaded GTFS. */
export class RaptorNetwork {
  readonly variants: GtfsVariant[] = [];
  readonly tripsByVariant: GtfsTrip[][] = [];
  /** Route variants calling at each stop, with the stop's position in the variant */
  readonly routesAtStop: { route: number; pos: number }[][];
  readonly footpaths: Footpath[][];
  private readonly stopObjects: Stop[];
  private readonly dayCache = new Map<string, DayTrip[][]>();

  constructor(readonly index: GtfsIndex) {
    const variantIndex = new Map<GtfsVariant, number>();
    for (const trip of index.trips) {
      let v = variantIndex.get(trip.variant);
      if (v === undefined) {
        v = this.variants.length;
        variantIndex.set(trip.variant, v);
        this.variants.push(trip.variant);
        this.tripsByVariant.push([]);
      }
      this.tripsByVariant[v].push(trip);
    }

    this.routesAtStop = index.stops.map(() => []);
    this.variants.forEach((variant, route) =>
      variant.stops.forEach((stop, pos) => this.routesAtStop[stop].push({ route, pos })));

    this.footpaths = index.stops.map(() => []);
    for (let a = 0; a < index.stops.length; a++) {
      for (let b = a + 1; b < index.stops.length; b++) {
        const meters = distanceM(index.stops[a][2], index.stops[a][3], index.stops[b][2], index.stops[b][3]);
        if (meters > MAX_TRANSFER_WALK_M) continue;
        const minutes = Math.max(1, walkMinutes(meters));
        this.footpaths[a].push({ to: b, minutes, meters });
        this.footpaths[b].push({ to: a, minutes, meters });
      }
    }

    this.stopObjects = index.stops.map(([id, name, lat, lng], i) => ({
      id, name, lat, lng, designator: i + 1, onlyDisembarking: false
    }));
  }

  stop(position: number): Stop {
    return this.stopObjects[position];
  }

  /** Trips of yesterday, today and tomorrow that run, per route variant, by first departure. */
  dayTrips(date: Date): DayTrip[][] {
    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    let day = this.dayCache.get(key);
    if (!day) {
      day = this.tripsByVariant.map(trips => {
        const list: DayTrip[] = [];
        for (const offsetDays of [-1, 0, 1]) {
          const d = new Date(date.getFullYear(), date.getMonth(), date.getDate() + offsetDays);
          for (const trip of trips) {
            if (this.index.runsOn(trip.service, d)) list.push({ trip, offset: offsetDays * 1440 });
          }
        }
        return list.sort((a, b) => a.trip.times[0] + a.offset - (b.trip.times[0] + b.offset));
      });
      this.dayCache.set(key, day);
    }
    return day;
  }
}

/**
 * One RAPTOR run: leaving at `departMin` (minutes after the reference midnight), walking to
 * any of the `access` stops. Returns the best arrival at an end stop for each number of rides
 * (only when it improves on fewer rides – a Pareto set).
 */
function run(
  net: RaptorNetwork, day: DayTrip[][], access: Access[], egress: Map<number, Access>, departMin: number
): { arrivals: Arrival[]; parents: (Parent | undefined)[][] } {
  const n = net.index.stops.length;
  const labels: Float64Array[] = [];
  const parents: (Parent | undefined)[][] = [];
  for (let k = 0; k <= MAX_RIDES; k++) {
    labels.push(new Float64Array(n).fill(Infinity));
    parents.push(new Array(n));
  }
  const best = new Float64Array(n).fill(Infinity);
  let bestTarget = Infinity;
  const arrivals: Arrival[] = [];

  let marked = new Set<number>();
  for (const a of access) {
    const t = departMin + a.minutes;
    if (t < labels[0][a.stop]) {
      labels[0][a.stop] = t;
      best[a.stop] = t;
      parents[0][a.stop] = { kind: 'access', access: a };
      marked.add(a.stop);
    }
  }

  for (let k = 1; k <= MAX_RIDES && marked.size > 0; k++) {
    // Routes to scan, each from the earliest marked stop on it
    const queue = new Map<number, number>();
    for (const s of marked) {
      for (const { route, pos } of net.routesAtStop[s]) {
        const p = queue.get(route);
        if (p === undefined || pos < p) queue.set(route, pos);
      }
    }

    const reached = new Set<number>();
    for (const [route, startPos] of queue) {
      const stops = net.variants[route].stops;
      const trips = day[route];
      let current: DayTrip | null = null;
      let boardPos = -1;

      for (let i = startPos; i < stops.length; i++) {
        const s = stops[i];
        if (current) {
          const arrival = current.trip.times[i] + current.offset;
          if (arrival < best[s] && arrival < bestTarget) {
            labels[k][s] = arrival;
            best[s] = arrival;
            parents[k][s] = { kind: 'ride', trip: current, boardPos, alightPos: i, boardStop: stops[boardPos] };
            reached.add(s);
            const e = egress.get(s);
            if (e) bestTarget = Math.min(bestTarget, arrival + e.minutes);
          }
        }
        // Could an earlier trip of this route be caught here?
        const previous = labels[k - 1][s];
        if (previous < Infinity && i < stops.length - 1) {
          const ready = previous + (parents[k - 1][s]?.kind === 'ride' ? MIN_CHANGE_MIN : 0);
          if (!current || ready <= current.trip.times[i] + current.offset) {
            const candidate = earliestTrip(trips, i, ready);
            if (candidate && (!current || candidate.trip.times[i] + candidate.offset < current.trip.times[i] + current.offset)) {
              current = candidate;
              boardPos = i;
            }
          }
        }
      }
    }

    // Walking to nearby stops after getting off
    for (const s of [...reached]) {
      for (const path of net.footpaths[s]) {
        const t = labels[k][s] + path.minutes;
        if (t < best[path.to] && t < bestTarget) {
          labels[k][path.to] = t;
          best[path.to] = t;
          parents[k][path.to] = { kind: 'walk', from: s, path };
          reached.add(path.to);
          const e = egress.get(path.to);
          if (e) bestTarget = Math.min(bestTarget, t + e.minutes);
        }
      }
    }

    // Best arrival at the destination using exactly k rides
    let arrival: Arrival | null = null;
    for (const [stop, e] of egress) {
      const t = labels[k][stop] + e.minutes;
      if (t < Infinity && (!arrival || t < arrival.time)) arrival = { rides: k, stop, time: t };
    }
    if (arrival && (arrivals.length === 0 || arrival.time < arrivals[arrivals.length - 1].time)) arrivals.push(arrival);

    marked = reached;
  }
  return { arrivals, parents };
}

/** Trip of a route leaving position `pos` at or after `ready`, the earliest such. */
function earliestTrip(trips: DayTrip[], pos: number, ready: number): DayTrip | null {
  let best: DayTrip | null = null;
  for (const t of trips) {
    const dep = t.trip.times[pos] + t.offset;
    if (dep >= ready && (!best || dep < best.trip.times[pos] + best.offset)) best = t;
  }
  return best;
}

export interface PlanRequest {
  access: Access[];
  egress: Access[];
  origin: Place;
  destination: Place;
  /** Reference day (local) */
  date: Date;
  /** Minutes after the reference midnight: leave at (depart) or arrive by (arrive) */
  timeMin: number;
  mode: TimeMode;
  /** How far from `timeMin` to look (minutes) */
  windowMin?: number;
  limit?: number;
}

/**
 * Several good journeys: in "depart" mode the ones arriving soonest after leaving at the
 * requested time, in "arrive" mode the ones leaving latest that still arrive in time.
 * Journeys worse in every respect (later/earlier, more changes) than another are dropped.
 */
export function plan(net: RaptorNetwork, req: PlanRequest): Connection[] {
  const window = req.windowMin ?? 180;
  const limit = req.limit ?? 6;
  const day = net.dayTrips(req.date);
  const egress = new Map(req.egress.map(e => [e.stop, e]));

  // Moments worth leaving at: just in time for a departure from one of the access stops
  const moments = new Set<number>();
  for (const a of req.access) {
    for (const { route, pos } of net.routesAtStop[a.stop]) {
      if (pos === net.variants[route].stops.length - 1) continue;
      for (const t of day[route]) {
        const leave = t.trip.times[pos] + t.offset - a.minutes;
        const inWindow = req.mode === 'depart'
          ? leave >= req.timeMin && leave <= req.timeMin + window
          : leave <= req.timeMin && leave >= req.timeMin - window;
        if (inWindow) moments.add(leave);
      }
    }
  }
  const order = [...moments].sort((a, b) => (req.mode === 'depart' ? a - b : b - a));

  const found = new Map<string, Connection>();
  for (const departMin of order) {
    const { arrivals, parents } = run(net, day, req.access, egress, departMin);
    for (const a of arrivals) {
      const conn = rebuild(net, parents, a, req, departMin);
      if (req.mode === 'arrive' && conn.arriveMin > req.timeMin) continue;
      const key = conn.legs.map(l => (l.kind === 'ride' ? l.tripId.split(':').slice(0, 2).join(':') : 'w')).join('>');
      if (!found.has(key)) found.set(key, conn);
    }
    if (found.size >= limit * 3) break;
  }

  return pickBest([...found.values()], req.mode, limit);
}

/** Drops dominated journeys and sorts the rest for the mode. */
export function pickBest(list: Connection[], mode: TimeMode, limit: number): Connection[] {
  const dominated = (j: Connection) => list.some(o => o !== j
    && o.leaveMin >= j.leaveMin && o.arriveMin <= j.arriveMin && o.transfers <= j.transfers
    && (o.leaveMin > j.leaveMin || o.arriveMin < j.arriveMin || o.transfers < j.transfers));
  return list
    .filter(j => !dominated(j))
    .sort((a, b) => mode === 'depart'
      ? a.arriveMin - b.arriveMin || a.transfers - b.transfers || b.leaveMin - a.leaveMin
      : b.leaveMin - a.leaveMin || a.transfers - b.transfers || a.arriveMin - b.arriveMin)
    .slice(0, limit);
}

/** Turns the RAPTOR labels back into walks and rides. */
function rebuild(
  net: RaptorNetwork, parents: (Parent | undefined)[][], arrival: Arrival, req: PlanRequest, departMin: number
): Connection {
  const legs: Leg[] = [];
  const egress = req.egress.find(e => e.stop === arrival.stop)!;
  if (egress.meters > 0) legs.push(walk(placeOf(net, arrival.stop), req.destination, egress.minutes, egress.meters));

  let stop = arrival.stop;
  let round = arrival.rides;
  for (;;) {
    const p = parents[round][stop];
    if (!p) throw new Error('Broken RAPTOR path');
    if (p.kind === 'access') {
      if (p.access.meters > 0) legs.unshift(walk(req.origin, placeOf(net, stop), p.access.minutes, p.access.meters));
      break;
    }
    if (p.kind === 'walk') {
      legs.unshift(walk(placeOf(net, p.from), placeOf(net, stop), p.path.minutes, p.path.meters));
      stop = p.from;
      continue;
    }
    legs.unshift(ride(net, p));
    stop = p.boardStop;
    round--;
  }

  mergeWalks(legs);
  const rideLegs = legs.filter((l): l is RideLeg => l.kind === 'ride');
  const accessWalk = legs[0]?.kind === 'walk' ? legs[0].minutes : 0;
  const leaveMin = (rideLegs[0]?.departureMin ?? departMin) - accessWalk;
  return {
    legs,
    leaveAt: clock(leaveMin),
    arriveAt: clock(arrival.time),
    totalMinutes: arrival.time - leaveMin,
    waitMinutes: req.mode === 'depart' ? Math.max(0, leaveMin - req.timeMin) : 0,
    transfers: rideLegs.length - 1,
    leaveMin,
    arriveMin: arrival.time
  };
}

function ride(net: RaptorNetwork, p: Extract<Parent, { kind: 'ride' }>): RideLeg {
  const { trip, offset } = p.trip;
  const stops = trip.variant.stops.slice(p.boardPos, p.alightPos + 1).map(s => net.stop(s));
  const dep = trip.times[p.boardPos] + offset;
  const arr = trip.times[p.alightPos] + offset;
  return {
    kind: 'ride',
    line: trip.variant.line ?? UNKNOWN_LINE,
    headsign: trip.variant.headsign,
    from: stops[0],
    to: stops[stops.length - 1],
    departure: clock(dep),
    arrival: clock(arr),
    departureMin: dep,
    arrivalMin: arr,
    minutes: arr - dep,
    stops,
    tripId: `trip:${trip.index}:${p.boardPos}`
  };
}

/** A walk to a nearby stop followed by the walk to the destination becomes one walk. */
function mergeWalks(legs: Leg[]): void {
  for (let i = legs.length - 1; i > 0; i--) {
    const a = legs[i - 1];
    const b = legs[i];
    if (a.kind === 'walk' && b.kind === 'walk') {
      legs.splice(i - 1, 2, walk(a.from, b.to, a.minutes + b.minutes, a.meters + b.meters));
    }
  }
}

function walk(from: Place, to: Place, minutes: number, meters: number): WalkLeg {
  return { kind: 'walk', from, to, minutes, meters: Math.round(meters) };
}

function placeOf(net: RaptorNetwork, stop: number): Place {
  const s = net.stop(stop);
  return { name: s.name, lat: s.lat, lng: s.lng, stop: s };
}

/** "HH:MM" of minutes after the reference midnight (wraps past 24 h). */
export function clock(minutes: number): string {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

export function distanceM(lat1: number, lng1: number, lat2: number, lng2: number): number {
  // Equirectangular approximation – accurate to centimetres over a few kilometres
  const r = Math.PI / 180;
  const x = (lng2 - lng1) * r * Math.cos(((lat1 + lat2) / 2) * r);
  const y = (lat2 - lat1) * r;
  return Math.sqrt(x * x + y * y) * 6371e3;
}
