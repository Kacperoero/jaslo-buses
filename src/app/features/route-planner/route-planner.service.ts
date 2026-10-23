import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TimetableService } from '../../core/services/timetable.service';
import { TravelTimeService, toDateInputValue } from '../../core/services/travel-time.service';
import {
  Departure,
  DeparturesResponse,
  Stop,
  StopDirection,
  TripExecutionResponse,
  TripTime
} from '../../shared/models/transit.models';
import { getDistance, getNearestStops } from '../../shared/utils/geo.utils';
import { namesMatch, normalizeName } from '../../shared/utils/text.utils';
import {
  getAbsoluteTimeString,
  minutesBetween,
  parseDepartureTimeToMinutes,
  parseTimeToMinutesOfDay
} from '../../shared/utils/time.utils';
import { Connection, ConnectionLeg, ConnectionPoint, StopCandidate } from './route-planner.models';

/** Walking speed in metres per minute (straight line). */
const WALK_M_PER_MIN = 80;
/** Rough bus speed used when the trip's timetable is unknown. */
const BUS_M_PER_MIN = 400;
/** Nearest stops considered around a map point. */
const CANDIDATE_STOPS = 10;
/** Other platforms of a selected stop (same name) closer than this are considered too. */
const SIBLING_STOP_MAX_M = 400;
/** Nearest stops on each side considered for transfer connections. */
const TRANSFER_CANDIDATE_STOPS = 3;
/** Departures per line & direction checked at each start stop (earliest first). */
const MAX_ROWS_PER_LINE = 3;
/** Second-leg departures checked per line at a transfer stop. */
const MAX_SECOND_LEG_OPTIONS = 2;
/** Minimum time to change buses. */
const MIN_TRANSFER_MIN = 2;
/** Look for transfers when there are fewer direct connections than this… */
const TRANSFER_IF_FEWER_DIRECT = 3;
/** …or when the best direct connection means waiting longer than this. */
const TRANSFER_IF_WAIT_OVER_MIN = 20;
const MAX_TRANSFERS = 6;
const MAX_RESULTS = 8;
/** While checking one transfer stop, the departures of the next few are already being fetched. */
const TRANSFER_STOP_LOOKAHEAD = 2;

/** Everything one search needs, shared by its steps. */
interface SearchContext {
  stops: Stop[];
  stopById: Map<string, Stop>;
  /** Moment all times are calculated from (now, or the time picked by the user) */
  ref: Date;
}

/** One bus run boarded at a stop, with its full stop sequence. */
interface Ride {
  from: StopCandidate;
  departure: Departure;
  line: string;
  times: TripTime[];
  /** Position of the boarding stop in `times` */
  boardIndex: number;
  minToDep: number;
  /** Identifies the physical bus run (same for every stop it serves) */
  runKey: string;
}

/**
 * Finds bus connections between two points: direct ones, and ones with a single transfer.
 *
 * Whether a bus gets from A to B is decided on its real stop sequence (trip details),
 * not on direction names – many lines here are loops whose sign changes on the way
 * (e.g. E4 "to Rynek" continues past Rynek to the hospital) or end at the destination.
 *
 * Performance: before each step, everything that step will read is requested in parallel.
 * Caches hold promises, so the same request is never sent twice, even while in flight.
 */
@Injectable({
  providedIn: 'root'
})
export class RoutePlannerService {
  private timetable = inject(TimetableService);
  private travelTime = inject(TravelTimeService);

  /** Lines per stop – stable for a given day, kept between searches. */
  private directionsCache = new Map<string, Promise<StopDirection[]>>();
  /** Departures and trips – refreshed for every search (live data changes). */
  private departuresCache = new Map<string, Promise<DeparturesResponse>>();
  private tripCache = new Map<string, Promise<TripExecutionResponse | null>>();

  async findConnections(start: ConnectionPoint, end: ConnectionPoint, stops: Stop[]): Promise<Connection[]> {
    this.departuresCache.clear();
    this.tripCache.clear();

    const ctx: SearchContext = {
      stops,
      stopById: new Map(stops.map(s => [s.id, s])),
      ref: this.travelTime.referenceTime()
    };

    const startCandidates = this.resolveCandidates(start, ctx);
    const endCandidates = this.resolveCandidates(end, ctx);
    if (startCandidates.length === 0 || endCandidates.length === 0) return [];

    // Direct: only lines that may reach one of the end stops (saves most requests)
    await Promise.all(unique([...startCandidates, ...endCandidates].map(c => c.stop.id)).map(id => this.directions(id)));
    const endLines = await this.endLineSets(endCandidates);
    const directRides = await this.ridesFrom(startCandidates, ctx, async s =>
      linesTowardsAny(await this.directions(s.stop.id), endCandidates, endLines));
    const direct = this.findDirect(directRides, endCandidates, ctx);

    let transfers: Connection[] = [];
    const bestWait = Math.min(...direct.map(c => c.waitingTimeAtStop ?? 0));
    if (direct.length < TRANSFER_IF_FEWER_DIRECT || bestWait > TRANSFER_IF_WAIT_OVER_MIN) {
      // Transfers: any line from the nearest start stops can be the first leg
      const transferRides = await this.ridesFrom(startCandidates.slice(0, TRANSFER_CANDIDATE_STOPS), ctx);
      const bestDirect = Math.min(...direct.map(c => c.totalTime));
      transfers = await this.findWithTransfer(
        transferRides, startCandidates, endCandidates.slice(0, TRANSFER_CANDIDATE_STOPS), endLines, bestDirect, ctx
      );
    }

    let result = [...direct, ...transfers];
    if (result.length === 0) {
      // Nothing running soon – still show which lines connect the stops
      result = await this.findLinesWithoutTrips(startCandidates, endCandidates, ctx);
    }
    return result.sort((a, b) => a.totalTime - b.totalTime).slice(0, MAX_RESULTS);
  }

  // ─── Rides from the start stops ──────────────────────

  /**
   * Upcoming bus runs from the start stops, with their stop sequences loaded in parallel.
   * `linesFor` optionally limits which lines are considered at each stop.
   */
  private async ridesFrom(
    starts: StopCandidate[], ctx: SearchContext,
    linesFor?: (s: StopCandidate) => Promise<Set<string>>
  ): Promise<Ride[]> {
    const lines = await Promise.all(starts.map(s => (linesFor ? linesFor(s) : Promise.resolve(undefined))));
    const usable = starts.map((from, i) => ({ from, lines: lines[i] })).filter(x => !x.lines || x.lines.size > 0);
    await Promise.all(usable.map(x => this.departures(x.from.stop.id, x.lines)));

    const picked: { from: StopCandidate; row: Departure }[] = [];
    for (const { from, lines: only } of usable) {
      const perLine = new Map<string, number>();
      for (const row of (await this.departures(from.stop.id, only)).rows || []) {
        const key = `${row.line_name || row.line}|${row.direction_id ?? ''}`;
        const n = perLine.get(key) ?? 0;
        if (n >= MAX_ROWS_PER_LINE) continue;
        perLine.set(key, n + 1);
        picked.push({ from, row });
      }
    }

    await Promise.all(unique(picked.map(p => p.row.trip_execution_id).filter(isString)).map(id => this.trip(id)));

    const rides: Ride[] = [];
    for (const { from, row } of picked) {
      const ride = await this.toRide(from, row, ctx);
      if (ride) rides.push(ride);
    }
    return rides;
  }

  /** Loads a departure's trip and finds where on it the passenger boards. */
  private async toRide(from: StopCandidate, row: Departure, ctx: SearchContext): Promise<Ride | null> {
    const line = row.line_name || row.line;
    if (!line || !row.trip_execution_id) return null;
    const times = (await this.trip(row.trip_execution_id))?.trip?.times;
    if (!times) return null;

    const minToDep = parseDepartureTimeToMinutes(row.time, ctx.ref);
    const boardIndex = findBoardIndex(times, from.stop.id, row, minToDep, ctx.ref);
    if (boardIndex === -1) return null;

    return { from, departure: row, line, times, boardIndex, minToDep, runKey: tripKey(row.trip_execution_id) };
  }

  // ─── Direct connections ──────────────────────────────

  /** Rides that pass one of the end stops after boarding; one result (the best) per bus run. */
  private findDirect(rides: Ride[], ends: StopCandidate[], ctx: SearchContext): Connection[] {
    const endById = new Map(ends.map(e => [e.stop.id, e]));
    const best = new Map<string, Connection>();

    for (const ride of rides) {
      for (let k = ride.boardIndex + 1; k < ride.times.length; k++) {
        const e = endById.get(ride.times[k].place_id);
        if (!e || e.stop.id === ride.from.stop.id) continue;

        const busTime = minutesBetween(ride.times[ride.boardIndex].departure_time, ride.times[k].departure_time);
        const conn = this.directConnection(ride, e, busTime, ctx);
        const prev = best.get(ride.runKey);
        if (!prev || conn.totalTime < prev.totalTime) best.set(ride.runKey, conn);
      }
    }
    return [...best.values()];
  }

  private directConnection(ride: Ride, e: StopCandidate, busTime: number, ctx: SearchContext): Connection {
    const walkTimeStart = Math.round(ride.from.distance / WALK_M_PER_MIN);
    const walkTimeEnd = Math.round(e.distance / WALK_M_PER_MIN);
    const waitingTimeAtStop = Math.max(0, ride.minToDep - walkTimeStart);
    return {
      startStop: ride.from.stop,
      endStop: e.stop,
      line: ride.line,
      nextDeparture: ride.departure,
      walkTimeStart,
      walkTimeEnd,
      busTime,
      totalTime: walkTimeStart + waitingTimeAtStop + busTime + walkTimeEnd,
      departureTimeAbs: getAbsoluteTimeString(ride.minToDep, ctx.ref),
      arrivalTimeAbs: getAbsoluteTimeString(ride.minToDep + busTime, ctx.ref),
      waitingTimeAtStop
    };
  }

  // ─── Connections with one transfer ───────────────────

  /**
   * Ride from a start stop → get off at a stop on the way → a second bus that reaches an end stop.
   * One result per second-leg bus run (the best way to catch it).
   */
  private async findWithTransfer(
    rides: Ride[], allStarts: StopCandidate[], ends: StopCandidate[],
    endLines: Map<string, Set<string>>, bestDirect: number, ctx: SearchContext
  ): Promise<Connection[]> {
    const startIds = new Set(allStarts.map(s => s.stop.id));
    const endIds = new Set(ends.map(e => e.stop.id));

    const best = new Map<string, Connection>();
    const sortedRides = [...rides].sort((a, b) => a.minToDep - b.minToDep);
    /** Minutes from now until the passenger sits on this ride's bus */
    const onBoard = (r: Ride) => Math.max(Math.round(r.from.distance / WALK_M_PER_MIN), r.minToDep);
    /** Shortest possible rest of the trip after a transfer: change, ≥1 min ride, walk to the end */
    const minAfterTransfer = MIN_TRANSFER_MIN + 1 + Math.min(...ends.map(e => Math.round(e.distance / WALK_M_PER_MIN)));

    for (const ride of sortedRides) {
      if (best.size >= MAX_TRANSFERS) break;
      // A transfer only makes sense if it can arrive sooner than the best direct connection
      if (onBoard(ride) >= bestDirect) break;

      // Lines at every stop of this ride (one small request each, in parallel)
      const onTheWay = ride.times
        .map((t, k) => ({ t, k }))
        .filter(({ t, k }) => k > ride.boardIndex && ctx.stopById.has(t.place_id)
          && !startIds.has(t.place_id) && !endIds.has(t.place_id));
      await Promise.all(onTheWay.map(({ t }) => this.directions(t.place_id)));

      // Stops where a line towards one of the end stops can be caught
      const options: { tStop: Stop; k: number; e: StopCandidate; lines: Set<string> }[] = [];
      for (const { t, k } of onTheWay) {
        const atStop = onBoard(ride) + minutesBetween(ride.times[ride.boardIndex].departure_time, t.departure_time);
        if (atStop + minAfterTransfer >= bestDirect) break; // later stops only get later
        const tDirs = await this.directions(t.place_id);
        for (const e of ends) {
          const lines = linesTowards(tDirs, e, endLines.get(e.stop.id)!);
          if (lines.size > 0) options.push({ tStop: ctx.stopById.get(t.place_id)!, k, e, lines });
        }
      }

      for (let i = 0; i < options.length; i++) {
        if (best.size >= MAX_TRANSFERS) break;
        const { tStop, k, e, lines } = options[i];
        for (const next of options.slice(i, i + TRANSFER_STOP_LOOKAHEAD)) this.departures(next.tStop.id, next.lines);

        const busTime1 = minutesBetween(ride.times[ride.boardIndex].departure_time, ride.times[k].departure_time);
        const arrival1 = ride.minToDep + busTime1;
        const tCand: StopCandidate = { stop: tStop, distance: 0 };

        const rows = ((await this.departures(tStop.id, lines)).rows || [])
          .filter(r => lines.has(r.line_name || r.line || '')
            && parseDepartureTimeToMinutes(r.time, ctx.ref) >= arrival1 + MIN_TRANSFER_MIN);

        for (const line2 of lines) {
          const tries = rows.filter(r => (r.line_name || r.line) === line2).slice(0, MAX_SECOND_LEG_OPTIONS);
          await Promise.all(tries.map(r => r.trip_execution_id && this.trip(r.trip_execution_id)));

          for (const row of tries) {
            const ride2 = await this.toRide(tCand, row, ctx);
            const endIndex = ride2 ? indexAfter(ride2.times, e.stop.id, ride2.boardIndex) : -1;
            if (!ride2 || endIndex === -1) continue;

            const conn = this.transferConnection(ride, k, ride2, endIndex, e, ctx);
            if (conn.totalTime >= bestDirect) break; // slower than going direct
            const prev = best.get(ride2.runKey);
            if (!prev || conn.totalTime < prev.totalTime) best.set(ride2.runKey, conn);
            break; // earliest catchable run of this line is enough
          }
        }
      }
    }
    return [...best.values()];
  }

  /** Lines stopping at each end stop. */
  private async endLineSets(ends: StopCandidate[]): Promise<Map<string, Set<string>>> {
    const result = new Map<string, Set<string>>();
    for (const e of ends) {
      result.set(e.stop.id, new Set((await this.directions(e.stop.id)).map(d => d.line)));
    }
    return result;
  }

  private transferConnection(
    ride1: Ride, transferIndex: number, ride2: Ride, endIndex: number, e: StopCandidate, ctx: SearchContext
  ): Connection {
    const tStop = ride2.from.stop;
    const busTime1 = minutesBetween(ride1.times[ride1.boardIndex].departure_time, ride1.times[transferIndex].departure_time);
    const busTime2 = minutesBetween(ride2.times[ride2.boardIndex].departure_time, ride2.times[endIndex].departure_time);
    const arrival1 = ride1.minToDep + busTime1;
    const arrival2 = ride2.minToDep + busTime2;
    const walkTimeTransfer = ride2.minToDep - arrival1;
    const walkTimeStart = Math.round(ride1.from.distance / WALK_M_PER_MIN);
    const walkTimeEnd = Math.round(e.distance / WALK_M_PER_MIN);
    const waitingTimeAtStop = Math.max(0, ride1.minToDep - walkTimeStart);
    const departureTimeAbs = getAbsoluteTimeString(ride1.minToDep, ctx.ref);
    const arrivalTimeAbs = getAbsoluteTimeString(arrival2, ctx.ref);

    const leg1: ConnectionLeg = {
      startStop: ride1.from.stop,
      endStop: tStop,
      line: ride1.line,
      nextDeparture: ride1.departure,
      busTime: busTime1,
      departureTimeAbs,
      arrivalTimeAbs: getAbsoluteTimeString(arrival1, ctx.ref),
      waitingTimeAtStop
    };
    const leg2: ConnectionLeg = {
      startStop: tStop,
      endStop: e.stop,
      line: ride2.line,
      nextDeparture: ride2.departure,
      busTime: busTime2,
      departureTimeAbs: getAbsoluteTimeString(ride2.minToDep, ctx.ref),
      arrivalTimeAbs,
      waitingTimeAtStop: walkTimeTransfer
    };

    return {
      startStop: ride1.from.stop,
      endStop: e.stop,
      line: `${ride1.line} ➔ ${ride2.line}`,
      nextDeparture: ride1.departure,
      walkTimeStart,
      walkTimeEnd,
      busTime: busTime1 + busTime2,
      totalTime: walkTimeStart + waitingTimeAtStop + busTime1 + walkTimeTransfer + busTime2 + walkTimeEnd,
      departureTimeAbs,
      arrivalTimeAbs,
      waitingTimeAtStop,
      isTransfer: true,
      legs: [leg1, leg2],
      transferStop: tStop,
      walkTimeTransfer
    };
  }

  // ─── No buses running soon ───────────────────────────

  /**
   * Lines serving both a start and an end stop in the right direction (by direction names and
   * position) – shown as "Brak kursu" so the user knows which line to take later.
   */
  private async findLinesWithoutTrips(starts: StopCandidate[], ends: StopCandidate[], ctx: SearchContext): Promise<Connection[]> {
    await Promise.all(unique([...starts, ...ends].map(c => c.stop.id)).map(id => this.directions(id)));

    const result: Connection[] = [];
    for (const s of starts) {
      for (const e of ends) {
        if (s.stop.id === e.stop.id) continue;
        const sDirs = await this.directions(s.stop.id);
        const eDirs = await this.directions(e.stop.id);
        for (const line of unique(sDirs.map(d => d.line))) {
          const fits = sDirs.some(sd => sd.line === line
            && eDirs.some(ed => ed.line === line && namesMatch(sd.direction, ed.direction))
            && this.isEndStopAfterStartStop(s.stop, e.stop, sd.direction, ctx));
          if (!fits) continue;

          const walkTimeStart = Math.round(s.distance / WALK_M_PER_MIN);
          const walkTimeEnd = Math.round(e.distance / WALK_M_PER_MIN);
          const busTime = this.estimateBusTime(s.stop, e.stop);
          result.push({
            startStop: s.stop,
            endStop: e.stop,
            line,
            nextDeparture: null,
            walkTimeStart,
            walkTimeEnd,
            busTime,
            totalTime: walkTimeStart + busTime + walkTimeEnd,
            departureTimeAbs: 'Brak kursu',
            arrivalTimeAbs: 'Brak kursu',
            waitingTimeAtStop: 0
          });
        }
      }
    }
    return result;
  }

  // ─── Helpers ─────────────────────────────────────────

  /**
   * A selected stop plus its other platforms (same name, nearby) – the right one depends
   * on the direction. A map point: the nearest stops around it.
   */
  private resolveCandidates(point: ConnectionPoint, ctx: SearchContext): StopCandidate[] {
    if (point.isStop && point.stopId) {
      const stop = ctx.stopById.get(point.stopId);
      if (stop) {
        const siblings = ctx.stops
          .filter(s => s.id !== stop.id && s.name === stop.name)
          .map(s => ({ stop: s, distance: getDistance(stop.lat, stop.lng, s.lat, s.lng) }))
          .filter(c => c.distance <= SIBLING_STOP_MAX_M);
        return [{ stop, distance: 0 }, ...siblings];
      }
    }
    return getNearestStops(ctx.stops, point.lat, point.lng, CANDIDATE_STOPS);
  }

  /** True if `end` is closer than `start` to the stop(s) named like the direction (line terminus). */
  private isEndStopAfterStartStop(start: Stop, end: Stop, directionName: string, ctx: SearchContext): boolean {
    if (!normalizeName(directionName)) return true;
    const targets = ctx.stops.filter(s => namesMatch(s.name, directionName));
    if (targets.length === 0) return true;

    let minStart = Infinity;
    let minEnd = Infinity;
    for (const t of targets) {
      minStart = Math.min(minStart, getDistance(start.lat, start.lng, t.lat, t.lng));
      minEnd = Math.min(minEnd, getDistance(end.lat, end.lng, t.lat, t.lng));
    }
    return minEnd < minStart;
  }

  private estimateBusTime(a: Stop, b: Stop): number {
    return Math.max(2, Math.round(getDistance(a.lat, a.lng, b.lat, b.lng) / BUS_M_PER_MIN));
  }

  // ─── Cached API access ───────────────────────────────

  private directions(stopId: string): Promise<StopDirection[]> {
    // Lines differ between days (e.g. weekends), so cache per stop + chosen date
    const selected = this.travelTime.selected();
    const date = selected ? toDateInputValue(selected) : undefined;
    return cached(this.directionsCache, `${stopId}|${date ?? 'now'}`, () =>
      firstValueFrom(this.timetable.getDirectionsForStop(stopId, date)).catch(err => {
        console.error(`Failed to fetch directions for stop ${stopId}`, err);
        return [];
      })
    );
  }

  /** Departures from a stop, optionally only of some lines (fewer requests for planned times). */
  private departures(stopId: string, lines?: Set<string>): Promise<DeparturesResponse> {
    if (lines && !this.travelTime.isScheduled()) {
      // Live departures come in one request for all lines – fetch once, filter here
      return this.departures(stopId).then(res => ({
        ...res, rows: (res.rows || []).filter(r => lines.has(r.line_name || r.line || ''))
      }));
    }
    const key = `${stopId}|${lines ? [...lines].sort().join(',') : '*'}`;
    return cached(this.departuresCache, key, () =>
      firstValueFrom(this.timetable.getDepartures(stopId, this.travelTime.selected(), lines)).catch(err => {
        console.error(`Failed to fetch departures for stop ${stopId}`, err);
        return { timestamp: Date.now(), designator: 0, station_name: '', only_disembarking: false };
      })
    );
  }

  private trip(tripExecId: string): Promise<TripExecutionResponse | null> {
    // One request per bus run, whichever stop it was looked up from
    return cached(this.tripCache, tripKey(tripExecId), () =>
      firstValueFrom(this.timetable.getTripExecution(tripExecId)).catch(err => {
        console.error(`Failed to fetch trip execution ${tripExecId}`, err);
        return null;
      })
    );
  }
}

/**
 * Scheduled ids are "trip:<tripId>:<stopIndex>"; the stop index doesn't change the trip's
 * stop list, so the run is identified by "trip:<tripId>". Live ids already identify the run.
 */
function tripKey(tripExecId: string): string {
  return tripExecId.startsWith('trip:') ? tripExecId.split(':').slice(0, 2).join(':') : tripExecId;
}

/**
 * Position of the boarding stop in a trip. Loop lines can pass the same stop twice, so use the
 * stop index from a scheduled id, or else the visit whose time is closest to the departure.
 */
function findBoardIndex(times: TripTime[], stopId: string, row: Departure, minToDep: number, ref: Date): number {
  const id = row.trip_execution_id ?? '';
  if (id.startsWith('trip:')) {
    const index = Number(id.split(':')[2]);
    const i = times.findIndex(t => t.index === index && t.place_id === stopId);
    if (i !== -1) return i;
  }

  const visits = times.map((t, i) => (t.place_id === stopId ? i : -1)).filter(i => i !== -1);
  if (visits.length <= 1) return visits[0] ?? -1;

  const dep = new Date(ref.getTime() + minToDep * 60000);
  const depMin = dep.getHours() * 60 + dep.getMinutes();
  const gap = (i: number) => {
    const d = Math.abs(parseTimeToMinutesOfDay(times[i].departure_time) - depMin);
    return Math.min(d, 1440 - d);
  };
  return visits.reduce((a, b) => (gap(b) < gap(a) ? b : a));
}

/**
 * Lines at a stop (given its `dirs`) that may reach end stop `e`: lines that also stop at `e`,
 * or whose direction is `e` itself (a line is not listed at the stop where it ends).
 */
function linesTowards(dirs: StopDirection[], e: StopCandidate, eLines: Set<string>): Set<string> {
  return new Set(dirs.filter(d => eLines.has(d.line) || namesMatch(d.direction, e.stop.name)).map(d => d.line));
}

function linesTowardsAny(dirs: StopDirection[], ends: StopCandidate[], endLines: Map<string, Set<string>>): Set<string> {
  const result = new Set<string>();
  for (const e of ends) linesTowards(dirs, e, endLines.get(e.stop.id)!).forEach(l => result.add(l));
  return result;
}

/** First position of `stopId` in `times` after `after`, or -1. */
function indexAfter(times: TripTime[], stopId: string, after: number): number {
  for (let k = after + 1; k < times.length; k++) {
    if (times[k].place_id === stopId) return k;
  }
  return -1;
}

function cached<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key);
  if (!p) {
    p = load();
    cache.set(key, p);
  }
  return p;
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function isString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}
