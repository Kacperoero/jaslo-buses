import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TimetableService } from '../../core/services/timetable.service';
import { TravelTimeService, toDateInputValue } from '../../core/services/travel-time.service';
import {
  Departure,
  DeparturesResponse,
  Stop,
  StopDirection,
  TripExecutionResponse
} from '../../shared/models/transit.models';
import { getDistance, getNearestStops } from '../../shared/utils/geo.utils';
import { namesMatch, normalizeName } from '../../shared/utils/text.utils';
import {
  getAbsoluteTimeString,
  minutesBetween,
  parseDepartureTimeToMinutes
} from '../../shared/utils/time.utils';
import { Connection, ConnectionLeg, ConnectionPoint, StopCandidate } from './route-planner.models';

/** Walking speed in metres per minute (straight line). */
const WALK_M_PER_MIN = 80;
/** Rough bus speed used when the trip's timetable is unknown. */
const BUS_M_PER_MIN = 400;
/** Nearest stops considered around a map point. */
const CANDIDATE_STOPS = 10;
/** Nearest stops on each side considered for transfer connections. */
const TRANSFER_CANDIDATE_STOPS = 3;
/** Minimum time to change buses. */
const MIN_TRANSFER_MIN = 2;
/** Look for transfers only when there are fewer direct connections than this. */
const TRANSFER_SEARCH_BELOW = 5;
const MAX_RESULTS = 6;
/**
 * Look-ahead for stage 2: while checking one ride / transfer stop, the data for the next few
 * is already being fetched. Fetching everything up front would waste requests, because the
 * search usually stops early once it has MAX_RESULTS connections.
 */
const RIDE_LOOKAHEAD = 3;
const TRANSFER_STOP_LOOKAHEAD = 2;

/** Departures of everything we need for one search, shared by its steps. */
interface SearchContext {
  stops: Stop[];
  stopById: Map<string, Stop>;
  /** Moment all times are calculated from (now, or the time picked by the user) */
  ref: Date;
}

/** A pair of start/end stops served by at least one common line. */
interface DirectPair {
  s: StopCandidate;
  e: StopCandidate;
  sDirs: StopDirection[];
  eDirs: StopDirection[];
  shared: string[];
}

/** A transfer connection found before its second leg's trip details are loaded. */
interface TransferDraft {
  sCand: StopCandidate;
  eCand: StopCandidate;
  dep1: Departure;
  line1: string;
  tStop: Stop;
  line2: string;
  dep2: Departure;
  minToDep1: number;
  busTime1: number;
  arrivalTime1Min: number;
}

/**
 * Finds bus connections between two points: direct ones first, then (if there are few)
 * ones with a single transfer.
 *
 * Performance: the search needs many API calls (lines per stop, departures, trip details).
 * Before each step, everything that step will read is requested in parallel; the step then
 * runs in the original order on cached results. Caches hold promises, so the same request
 * is never sent twice, even while it is still in flight.
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

    // Explicitly selected stop, otherwise the nearest stops around the point
    const startCandidates = this.resolveCandidates(start, ctx);
    const endCandidates = this.resolveCandidates(end, ctx);
    if (startCandidates.length === 0 || endCandidates.length === 0) return [];

    const found = await this.findDirect(startCandidates, endCandidates, ctx);

    if (found.length < TRANSFER_SEARCH_BELOW) {
      found.push(...await this.findWithTransfer(
        startCandidates.slice(0, TRANSFER_CANDIDATE_STOPS),
        endCandidates.slice(0, TRANSFER_CANDIDATE_STOPS),
        found.length,
        ctx
      ));
    }

    // Prefer connections with a real upcoming departure; show the rest only if there is nothing else
    const active = found.filter(c => c.nextDeparture !== null);
    const result = active.length > 0 ? active : found;
    return result.sort((a, b) => a.totalTime - b.totalTime);
  }

  // ─── Stage 1: direct connections ─────────────────────

  private async findDirect(starts: StopCandidate[], ends: StopCandidate[], ctx: SearchContext): Promise<Connection[]> {
    // Lines serving every candidate stop
    await Promise.all(unique([...starts, ...ends].map(c => c.stop.id)).map(id => this.directions(id)));

    const pairs: DirectPair[] = [];
    for (const s of starts) {
      for (const e of ends) {
        if (s.stop.id === e.stop.id) continue;
        const sDirs = await this.directions(s.stop.id);
        const eDirs = await this.directions(e.stop.id);
        const eLines = new Set(eDirs.map(d => d.line));
        const shared = unique(sDirs.map(d => d.line).filter(line => eLines.has(line)));
        if (shared.length > 0) pairs.push({ s, e, sDirs, eDirs, shared });
      }
    }

    // Departures from every start stop that has a common line with some end stop
    await Promise.all(unique(pairs.map(p => p.s.stop.id)).map(id => this.departures(id)));

    // Trip details of the first suitable departure for each pair & line
    const tripIds: string[] = [];
    for (const p of pairs) {
      const deps = await this.departures(p.s.stop.id);
      for (const line of p.shared) {
        const first = this.correctDirectionDepartures(deps, line, p.eDirs, p.s.stop, p.e.stop, ctx)[0];
        if (first?.trip_execution_id) tripIds.push(first.trip_execution_id);
      }
    }
    await Promise.all(unique(tripIds).map(id => this.trip(id)));

    const result: Connection[] = [];
    for (const p of pairs) {
      try {
        for (const line of p.shared) {
          const conn = await this.evaluateDirect(p, line, ctx);
          if (conn) result.push(conn);
        }
      } catch (err) {
        console.error(`Failed direct candidate lookup for ${p.s.stop.name} and ${p.e.stop.name}`, err);
      }
    }
    return result;
  }

  private async evaluateDirect(p: DirectPair, line: string, ctx: SearchContext): Promise<Connection | null> {
    const { s, e } = p;
    const deps = await this.departures(s.stop.id);
    const correct = this.correctDirectionDepartures(deps, line, p.eDirs, s.stop, e.stop, ctx);

    let nextDep: Departure | null = null;
    let isValid = false;
    let departureTimeAbs = '';
    let arrivalTimeAbs = '';
    let waitingTimeAtStop = 0;
    let busTime = 0;
    const walkTimeStart = Math.round(s.distance / WALK_M_PER_MIN);
    const walkTimeEnd = Math.round(e.distance / WALK_M_PER_MIN);

    if (correct.length > 0) {
      const candidate = correct[0];
      const minutesToDeparture = parseDepartureTimeToMinutes(candidate.time, ctx.ref);

      if (candidate.trip_execution_id) {
        // Confirm on the trip's real stop sequence that it reaches the end stop after the start stop
        const exec = await this.trip(candidate.trip_execution_id);
        const times = exec?.trip?.times || [];
        const startIndex = times.findIndex(t => t.place_id === s.stop.id);
        const endIndex = times.findIndex(t => t.place_id === e.stop.id);
        if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
          nextDep = candidate;
          isValid = true;
          busTime = minutesBetween(times[startIndex].departure_time, times[endIndex].departure_time);
        }
      } else {
        nextDep = candidate;
        isValid = true;
      }

      if (isValid) {
        if (busTime === 0) busTime = this.estimateBusTime(s.stop, e.stop);
        departureTimeAbs = getAbsoluteTimeString(minutesToDeparture, ctx.ref);
        arrivalTimeAbs = getAbsoluteTimeString(minutesToDeparture + busTime, ctx.ref);
        waitingTimeAtStop = Math.max(0, minutesToDeparture - walkTimeStart);
      }
    } else {
      // No trip coming up – still show the line if its static directions fit
      const fits = p.sDirs.some(sd => {
        if (sd.line !== line) return false;
        const hasEd = p.eDirs.some(ed => ed.line === line && namesMatch(sd.direction, ed.direction));
        return hasEd && this.isEndStopAfterStartStop(s.stop, e.stop, sd.direction, ctx);
      });
      if (fits) {
        isValid = true;
        departureTimeAbs = 'Brak kursu';
        arrivalTimeAbs = 'Brak kursu';
      }
    }

    if (!isValid) return null;
    if (busTime === 0) busTime = this.estimateBusTime(s.stop, e.stop);

    return {
      startStop: s.stop,
      endStop: e.stop,
      line,
      nextDeparture: nextDep,
      walkTimeStart,
      walkTimeEnd,
      busTime,
      totalTime: walkTimeStart + waitingTimeAtStop + busTime + walkTimeEnd,
      departureTimeAbs,
      arrivalTimeAbs,
      waitingTimeAtStop
    };
  }

  // ─── Stage 2: connections with one transfer ──────────

  private async findWithTransfer(
    starts: StopCandidate[], ends: StopCandidate[], alreadyFound: number, ctx: SearchContext
  ): Promise<Connection[]> {
    const drafts: TransferDraft[] = [];
    const full = () => alreadyFound + drafts.length >= MAX_RESULTS;

    for (const sCand of starts) {
      for (const eCand of ends) {
        if (sCand.stop.id === eCand.stop.id) continue;
        if (full()) break;
        try {
          await this.collectTransferDrafts(sCand, eCand, drafts, full, ctx);
        } catch (err) {
          console.error('Failed transfer ride-based candidate lookup', err);
        }
      }
    }

    // Trip details of every second leg, in parallel
    await Promise.all(unique(drafts.map(d => d.dep2.trip_execution_id).filter(isString)).map(id => this.trip(id)));

    const result: Connection[] = [];
    for (const d of drafts) result.push(await this.finalizeTransfer(d, ctx));
    return result;
  }

  /** Rides from sCand → get off at a stop on the way → line to eCand. */
  private async collectTransferDrafts(
    sCand: StopCandidate, eCand: StopCandidate,
    drafts: TransferDraft[], full: () => boolean, ctx: SearchContext
  ): Promise<void> {
    const rows = (await this.departures(sCand.stop.id)).rows || [];
    const eDirs = await this.directions(eCand.stop.id);
    const eLines = new Set(eDirs.map(d => d.line));

    for (let i = 0; i < rows.length; i++) {
      if (full()) break;
      const dep1 = rows[i];
      const line1 = dep1.line_name || dep1.line;
      if (!line1 || !dep1.trip_execution_id) continue;

      // Start loading the next rides while this one is checked
      for (const next of rows.slice(i, i + RIDE_LOOKAHEAD)) {
        if (next.trip_execution_id) this.trip(next.trip_execution_id);
      }

      const times = (await this.trip(dep1.trip_execution_id))?.trip?.times;
      if (!times) continue;
      const startIndex = times.findIndex(t => t.place_id === sCand.stop.id);
      if (startIndex === -1) continue;
      const rideStops = times.slice(startIndex + 1);

      // Lines at every stop of this ride (one small request each, in parallel)
      await Promise.all(rideStops
        .filter(rs => ctx.stopById.has(rs.place_id))
        .map(rs => this.directions(rs.place_id)));

      // Stops on this ride where we could change to a line that reaches the destination
      const transferStops: { stop: Stop; arrival: string; shared: string[] }[] = [];
      for (const rs of rideStops) {
        if (rs.place_id === eCand.stop.id) continue; // direct connection, handled in stage 1
        const tStop = ctx.stopById.get(rs.place_id);
        if (!tStop) continue;
        const tDirs = await this.directions(tStop.id);
        const shared = unique(tDirs.map(d => d.line).filter(line => eLines.has(line)));
        if (shared.length > 0) transferStops.push({ stop: tStop, arrival: rs.departure_time, shared });
      }

      const minToDep1 = parseDepartureTimeToMinutes(dep1.time, ctx.ref);

      for (let k = 0; k < transferStops.length; k++) {
        if (full()) break;
        const { stop: tStop, arrival, shared: shared2 } = transferStops[k];

        for (const next of transferStops.slice(k, k + TRANSFER_STOP_LOOKAHEAD)) {
          this.departures(next.stop.id);
        }
        const tDeps = await this.departures(tStop.id);

        const busTime1 = minutesBetween(times[startIndex].departure_time, arrival);
        const arrivalTime1Min = minToDep1 + busTime1;

        for (const line2 of shared2) {
          if (full()) break;
          // A departure towards the destination, leaving after we arrive plus time to change
          const dep2 = this.correctDirectionDepartures(tDeps, line2, eDirs, tStop, eCand.stop, ctx)
            .find(r => parseDepartureTimeToMinutes(r.time, ctx.ref) >= arrivalTime1Min + MIN_TRANSFER_MIN);
          if (!dep2) continue;

          drafts.push({ sCand, eCand, dep1, line1, tStop, line2, dep2, minToDep1, busTime1, arrivalTime1Min });
        }
      }
    }
  }

  private async finalizeTransfer(d: TransferDraft, ctx: SearchContext): Promise<Connection> {
    const { sCand, eCand, tStop, dep2 } = d;
    const minToDep2 = parseDepartureTimeToMinutes(dep2.time, ctx.ref);

    let busTime2 = 0;
    if (dep2.trip_execution_id) {
      const times2 = (await this.trip(dep2.trip_execution_id))?.trip?.times || [];
      const i = times2.findIndex(t => t.place_id === tStop.id);
      const j = times2.findIndex(t => t.place_id === eCand.stop.id);
      if (i !== -1 && j !== -1 && i < j) {
        busTime2 = minutesBetween(times2[i].departure_time, times2[j].departure_time);
      }
    }
    if (busTime2 === 0) busTime2 = this.estimateBusTime(tStop, eCand.stop);

    const arrivalTime2Min = minToDep2 + busTime2;
    const walkTimeTransfer = minToDep2 - d.arrivalTime1Min;
    const walkTimeStart = Math.round(sCand.distance / WALK_M_PER_MIN);
    const walkTimeEnd = Math.round(eCand.distance / WALK_M_PER_MIN);
    const waitingTimeAtStop = Math.max(0, d.minToDep1 - walkTimeStart);
    const departureTimeAbs = getAbsoluteTimeString(d.minToDep1, ctx.ref);
    const arrivalTimeAbs = getAbsoluteTimeString(arrivalTime2Min, ctx.ref);

    const leg1: ConnectionLeg = {
      startStop: sCand.stop,
      endStop: tStop,
      line: d.line1,
      nextDeparture: d.dep1,
      busTime: d.busTime1,
      departureTimeAbs,
      arrivalTimeAbs: getAbsoluteTimeString(d.arrivalTime1Min, ctx.ref),
      waitingTimeAtStop
    };
    const leg2: ConnectionLeg = {
      startStop: tStop,
      endStop: eCand.stop,
      line: d.line2,
      nextDeparture: dep2,
      busTime: busTime2,
      departureTimeAbs: getAbsoluteTimeString(minToDep2, ctx.ref),
      arrivalTimeAbs,
      waitingTimeAtStop: walkTimeTransfer
    };

    return {
      startStop: sCand.stop,
      endStop: eCand.stop,
      line: `${d.line1} ➔ ${d.line2}`,
      nextDeparture: d.dep1,
      walkTimeStart,
      walkTimeEnd,
      busTime: d.busTime1 + busTime2,
      totalTime: walkTimeStart + waitingTimeAtStop + d.busTime1 + walkTimeTransfer + busTime2 + walkTimeEnd,
      departureTimeAbs,
      arrivalTimeAbs,
      waitingTimeAtStop,
      isTransfer: true,
      legs: [leg1, leg2],
      transferStop: tStop,
      walkTimeTransfer
    };
  }

  // ─── Helpers ─────────────────────────────────────────

  private resolveCandidates(point: ConnectionPoint, ctx: SearchContext): StopCandidate[] {
    if (point.isStop && point.stopId) {
      const stop = ctx.stopById.get(point.stopId);
      if (stop) return [{ stop, distance: 0 }];
    }
    return getNearestStops(ctx.stops, point.lat, point.lng, CANDIDATE_STOPS);
  }

  /**
   * Departures of `line` from `from` that head towards `to`: same direction name as one of the
   * line's directions at `to`, and `to` lies closer to that direction's terminus than `from`.
   */
  private correctDirectionDepartures(
    deps: DeparturesResponse, line: string, toDirs: StopDirection[], from: Stop, to: Stop, ctx: SearchContext
  ): Departure[] {
    const directionsMap = deps.directions || {};
    return (deps.rows || []).filter(r => {
      if ((r.line_name || r.line) !== line) return false;
      if (!r.direction_id) return true;
      const depDest = directionsMap[r.direction_id];
      if (!depDest) return true;
      const sameDirection = toDirs.some(d => d.line === line && namesMatch(d.direction, depDest));
      return sameDirection && this.isEndStopAfterStartStop(from, to, depDest, ctx);
    });
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

  private departures(stopId: string): Promise<DeparturesResponse> {
    return cached(this.departuresCache, stopId, () =>
      firstValueFrom(this.timetable.getDepartures(stopId, this.travelTime.selected())).catch(err => {
        console.error(`Failed to fetch departures for stop ${stopId}`, err);
        return { timestamp: Date.now(), designator: 0, station_name: '', only_disembarking: false };
      })
    );
  }

  private trip(tripExecId: string): Promise<TripExecutionResponse | null> {
    return cached(this.tripCache, tripExecId, () =>
      firstValueFrom(this.timetable.getTripExecution(tripExecId)).catch(err => {
        console.error(`Failed to fetch trip execution ${tripExecId}`, err);
        return null;
      })
    );
  }
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
