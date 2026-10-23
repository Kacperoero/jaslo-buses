import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, catchError, of, forkJoin, shareReplay, switchMap } from 'rxjs';
import {
  Departure,
  DeparturesResponse,
  DirectionsResponse,
  LineTimetableResponse,
  StopDirection,
  TripExecutionResponse,
  TripResponse
} from '../../shared/models/transit.models';
import { toDateInputValue, toTimeInputValue } from './travel-time.service';

/**
 * Trip ids of scheduled departures are encoded as "trip:<tripId>:<stopIndex>",
 * so the planner can treat them like live `trip_execution_id`s (see getTripExecution).
 */
const SCHEDULED_TRIP_PREFIX = 'trip:';

/** How far ahead (minutes) and how many departures a scheduled board shows. */
const SCHEDULE_WINDOW_MIN = 180;
const SCHEDULE_MAX_ROWS = 15;

@Injectable({
  providedIn: 'root'
})
export class TimetableService {
  /**
   * Use relative /api path — in dev mode this is proxied to kiedyprzyjedzie.pl.
   * In production, configure the same proxy at the reverse-proxy level.
   */
  private readonly baseUrl = '/api';

  /** Full-day timetables never change during a session, so cache them per stop + date. */
  private dayTimetableCache = new Map<string, Observable<Departure[]>>();

  constructor(private http: HttpClient) {}

  /**
   * Departures for a stop: live ones when `at` is null ("now"),
   * otherwise planned ones from the timetable, starting at `at`.
   */
  getDepartures(stopId: string, at: Date | null): Observable<DeparturesResponse> {
    return at ? this.getScheduledDepartures(stopId, at) : this.getDeparturesForStop(stopId);
  }

  /**
   * Fetch live departures for a given stop by its placeId.
   * The placeId must be URL-encoded since it contains a colon.
   */
  getDeparturesForStop(stopId: string): Observable<DeparturesResponse> {
    const encodedId = encodeURIComponent(stopId);
    return this.http.get<DeparturesResponse>(
      `${this.baseUrl}/departures/${encodedId}`
    );
  }

  /**
   * Planned departures from a stop starting at `at`, in the same shape as live departures:
   * `time` is "N min" relative to `at`, `static_time` is "HH:MM", `is_estimated` is false.
   */
  getScheduledDepartures(stopId: string, at: Date): Observable<DeparturesResponse> {
    const fromSec = at.getHours() * 3600 + at.getMinutes() * 60;
    const toSec = fromSec + SCHEDULE_WINDOW_MIN * 60;

    return this.getDayTimetable(stopId, toDateInputValue(at)).pipe(
      map(all => {
        const rows = all
          .filter(d => {
            const sec = (d as ScheduledRow)._sec;
            return sec >= fromSec && sec <= toSec;
          })
          .slice(0, SCHEDULE_MAX_ROWS)
          .map(d => {
            const minutes = Math.round(((d as ScheduledRow)._sec - fromSec) / 60);
            return { ...d, time: `${minutes} min`, minutes_to_departure: minutes };
          });

        // Directions are passed by name, so the map is name → name
        const directions: Record<string, string> = {};
        for (const r of rows) {
          if (r.direction) directions[r.direction] = r.direction;
        }

        return {
          timestamp: at.getTime(),
          designator: 0,
          station_name: '',
          only_disembarking: false,
          rows,
          directions
        };
      })
    );
  }

  /**
   * Fetch which bus lines/directions serve a given stop.
   * Pass `date` ("YYYY-MM-DD") to get the lines running on that day.
   */
  getDirectionsForStop(stopId: string, date?: string): Observable<StopDirection[]> {
    const encodedId = encodeURIComponent(stopId);
    const params: Record<string, string> = date ? { date } : {};
    return this.http.get<DirectionsResponse>(
      `${this.baseUrl}/directions/${encodedId}`, { params }
    ).pipe(
      map(res => res.directions || []),
      catchError(() => of([]))
    );
  }

  /**
   * Fetch details (stop sequence and times) of a specific trip.
   * Live ids are Base64-encoded as required by the API; scheduled ids
   * ("trip:<id>:<index>") are fetched from the planned trip endpoint instead.
   */
  getTripExecution(tripExecutionId: string): Observable<TripExecutionResponse> {
    if (tripExecutionId.startsWith(SCHEDULED_TRIP_PREFIX)) {
      const [tripId, index] = tripExecutionId.slice(SCHEDULED_TRIP_PREFIX.length).split(':');
      return this.getTrip(tripId, Number(index)).pipe(
        map(trip => ({
          trip: {
            times: trip.times,
            direction: trip.direction,
            current_station_id: trip.current_station_id,
            line: trip.line
          },
          canceled: [],
          vehicle_type: trip.vehicle_type,
          estimated: false,
          at_stop: false,
          next_departure_index: Number(index),
          estimates: [],
          vehicle_trip_index: 0
        }))
      );
    }

    const encodedId = encodeURIComponent(btoa(tripExecutionId));
    return this.http.get<TripExecutionResponse>(
      `${this.baseUrl}/trip_execution/${encodedId}`
    );
  }

  /** Planned stop sequence of a trip. `index` is the position of the boarding stop. */
  getTrip(tripId: string | number, index: number): Observable<TripResponse> {
    return this.http.get<TripResponse>(`${this.baseUrl}/trip/${tripId}/${index}`);
  }

  /** Timetable of one line at a stop for a date ("YYYY-MM-DD"). */
  getLineTimetable(stopId: string, line: string, date: string): Observable<LineTimetableResponse> {
    const encodedId = encodeURIComponent(stopId);
    return this.http.get<LineTimetableResponse>(
      `${this.baseUrl}/timetable/${encodedId}/${encodeLineName(line)}`, { params: { date } }
    );
  }

  /**
   * All planned departures from a stop on a date, sorted by time.
   * The API has no per-stop endpoint that includes line names, so this asks
   * for the day's lines and then fetches each line's timetable in parallel.
   */
  private getDayTimetable(stopId: string, date: string): Observable<Departure[]> {
    const key = `${stopId}|${date}`;
    const cached = this.dayTimetableCache.get(key);
    if (cached) return cached;

    const request = this.getDirectionsForStop(stopId, date).pipe(
      switchMap(dirs => {
        const lines = [...new Set(dirs.map(d => d.line))];
        if (lines.length === 0) return of([] as Departure[][]);
        return forkJoin(lines.map(line =>
          this.getLineTimetable(stopId, line, date).pipe(
            map(tt => toDepartures(tt, line)),
            catchError(() => of([] as Departure[]))
          )
        ));
      }),
      map(perLine => perLine.flat().sort((a, b) => (a as ScheduledRow)._sec - (b as ScheduledRow)._sec)),
      catchError(() => of([] as Departure[])),
      shareReplay(1)
    );

    this.dayTimetableCache.set(key, request);
    return request;
  }
}

/** Departure with the raw seconds-after-midnight kept for filtering. */
type ScheduledRow = Departure & { _sec: number };

function toDepartures(tt: LineTimetableResponse, line: string): ScheduledRow[] {
  const altDirections = tt.directions || [];
  return (tt.departures || []).map(dep => {
    const alt = altDirections.find(d => d.symbol && dep.symbols?.includes(d.symbol));
    const direction = alt?.name ?? tt.main_direction?.name ?? '';
    const hhmm = toTimeInputValue(new Date(2000, 0, 1, 0, 0, dep.departure));
    return {
      _sec: dep.departure,
      line_name: dep.line ?? line,
      time: hhmm,
      static_time: hhmm,
      direction_id: direction,
      direction,
      is_estimated: false,
      trip_execution_id: `${SCHEDULED_TRIP_PREFIX}${dep.trip_id}:${dep.index}`
    };
  });
}

/** Line names go into the URL as URL-safe Base64 without padding (same as the official site). */
export function encodeLineName(line: string): string {
  const bytes = new TextEncoder().encode(line);
  let binary = '';
  bytes.forEach(b => (binary += String.fromCharCode(b)));
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
