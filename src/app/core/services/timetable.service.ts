import { Injectable, inject } from '@angular/core';
import { Observable, map } from 'rxjs';
import {
  Departure,
  DeparturesResponse,
  StopDirection,
  TripExecutionResponse
} from '../../shared/models/transit.models';
import { GtfsIndex, GtfsService } from './gtfs.service';

/**
 * Trip ids are "trip:<trip>:<stop position>". The planner treats them as opaque ids and
 * groups by "trip:<trip>" (one bus run), see RoutePlannerService.
 */
const TRIP_PREFIX = 'trip:';

/** How far ahead (minutes) and how many departures a departure board shows. */
const WINDOW_MIN = 180;
const MAX_ROWS = 15;

/** Shown instead of a line number when the timetable doesn't say which line a trip is. */
export const UNKNOWN_LINE = '–';

/**
 * Departures, lines and trip details from the official MKS timetable (GTFS), computed in
 * the browser. There is no live data (delays, GPS): every time is the planned one.
 */
@Injectable({
  providedIn: 'root'
})
export class TimetableService {
  private gtfs = inject(GtfsService);

  /**
   * Departures from a stop in the next 3 hours after `at` (now when null), soonest first.
   * `time` is "N min" relative to `at`, `static_time` is "HH:MM". `lines` limits the lines.
   */
  getDepartures(stopId: string, at: Date | null, lines?: Iterable<string>): Observable<DeparturesResponse> {
    return this.gtfs.index().pipe(map(index => departures(index, stopId, at ?? new Date(), lines)));
  }

  /**
   * Lines (and their directions) calling at a stop on a date ("YYYY-MM-DD", today when omitted),
   * including lines that end there.
   */
  getDirectionsForStop(stopId: string, date?: string): Observable<StopDirection[]> {
    return this.gtfs.index().pipe(map(index => directions(index, stopId, date ? parseDate(date) : new Date())));
  }

  /** Stop sequence and planned times of a trip, by an id from a departure row. */
  getTripExecution(tripExecutionId: string, _index = 0): Observable<TripExecutionResponse> {
    return this.gtfs.index().pipe(map(index => tripDetails(index, tripExecutionId)));
  }
}

export function departures(index: GtfsIndex, stopId: string, at: Date, lines?: Iterable<string>): DeparturesResponse {
  const empty: DeparturesResponse = {
    timestamp: at.getTime(), designator: 0, station_name: '', only_disembarking: false, rows: [], directions: {}
  };
  const stop = index.stopPosition(stopId);
  if (stop === undefined) return empty;

  const wanted = lines ? new Set(lines) : null;
  const nowMin = at.getHours() * 60 + at.getMinutes();
  const found: { rel: number; trip: number; pos: number; minute: number; dayOffset: number }[] = [];

  // Trips of yesterday (running past midnight), today and tomorrow (when the window passes midnight)
  for (const dayOffset of [-1, 0, 1]) {
    const day = new Date(at.getFullYear(), at.getMonth(), at.getDate() + dayOffset);
    for (const call of index.callsByStop[stop]) {
      const rel = call.minute + dayOffset * 1440 - nowMin;
      if (rel < 0 || rel > WINDOW_MIN) continue;
      const trip = index.trips[call.trip];
      if (call.pos === trip.times.length - 1) continue; // last stop – the bus only arrives here
      if (wanted && !wanted.has(lineOf(trip.variant.line))) continue;
      if (!index.runsOn(trip.service, day)) continue;
      found.push({ rel, trip: call.trip, pos: call.pos, minute: call.minute, dayOffset });
    }
  }
  found.sort((a, b) => a.rel - b.rel);

  const rows: Departure[] = found.slice(0, MAX_ROWS).map(f => {
    const variant = index.trips[f.trip].variant;
    return {
      line_name: lineOf(variant.line),
      time: `${f.rel} min`,
      static_time: hhmm(f.minute),
      minutes_to_departure: f.rel,
      direction_id: variant.headsign,
      direction: variant.headsign,
      is_estimated: false,
      trip_execution_id: `${TRIP_PREFIX}${f.trip}:${f.pos}`,
      trip_index: f.pos,
      trip: f.trip,
      day_offset: f.dayOffset
    };
  });

  const directionsMap: Record<string, string> = {};
  for (const r of rows) directionsMap[r.direction!] = r.direction!;
  return { ...empty, station_name: index.stopName(stop), rows, directions: directionsMap };
}

export function directions(index: GtfsIndex, stopId: string, date: Date): StopDirection[] {
  const stop = index.stopPosition(stopId);
  if (stop === undefined) return [];
  const seen = new Map<string, StopDirection>();
  for (const call of index.callsByStop[stop]) {
    const trip = index.trips[call.trip];
    if (!index.runsOn(trip.service, date)) continue;
    const line = lineOf(trip.variant.line);
    const key = `${line}|${trip.variant.headsign}`;
    if (!seen.has(key)) seen.set(key, { line, direction: trip.variant.headsign, show_name: true, active: true });
  }
  return [...seen.values()];
}

export function tripDetails(index: GtfsIndex, tripExecutionId: string): TripExecutionResponse {
  const [, tripStr, posStr] = tripExecutionId.split(':');
  const trip = tripExecutionId.startsWith(TRIP_PREFIX) ? index.trips[Number(tripStr)] : undefined;
  if (!trip) throw new Error(`Unknown trip ${tripExecutionId}`);

  return {
    trip: {
      times: trip.variant.stops.map((stop, i) => ({
        stop_name: index.stopName(stop),
        external: false,
        designator: 0,
        place_id: index.stopId(stop),
        departure_time: hhmm(trip.times[i]),
        index: i
      })),
      direction: trip.variant.headsign,
      current_station_id: 0,
      line: { name: lineOf(trip.variant.line), type: 'bus', show_name: true }
    },
    canceled: [],
    vehicle_type: 0,
    estimated: false,
    at_stop: false,
    next_departure_index: Number(posStr) || 0,
    estimates: [],
    vehicle_trip_index: -1
  };
}

function lineOf(line: string | null): string {
  return line ?? UNKNOWN_LINE;
}

/** Minutes after midnight (may pass 24 h) → "HH:MM" on the clock */
function hhmm(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function parseDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}
