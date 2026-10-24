import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, shareReplay, tap } from 'rxjs';

/** Where the timetable comes from (shown to users, used for date limits). */
export interface GtfsFeedInfo {
  /** Source file published by MKS, e.g. "GTFS_1389_20260312125003.zip" */
  file: string;
  publisher: string;
  /** "YYYY-MM-DD" */
  validFrom: string;
  validTo: string;
  builtAt: string;
}

/** Shape of public/assets/data/gtfs.json (written by scripts/gtfs/build-gtfs.mjs). */
export interface GtfsData {
  feed: GtfsFeedInfo;
  /** [GTFS stop_id, name, lat, lng] */
  stops: [string, string, number, number][];
  /** Route variants: same stop sequence, line number (null when unknown) and headsign */
  variants: { line: string | null; headsign: string; stops: number[] }[];
  /** [variant, service, first departure (minutes after midnight), minutes to each next stop…] */
  trips: number[][];
  /** One bitmap per distinct service calendar: bit i = runs on day `start + i` */
  services: { start: string; days: number; bitmaps: string[] };
}

export interface GtfsVariant {
  line: string | null;
  headsign: string;
  stops: number[];
}

export interface GtfsTrip {
  index: number;
  variant: GtfsVariant;
  service: number;
  /** Departure at each stop of the variant, minutes after midnight of the service day (may pass 1440) */
  times: number[];
}

/** A trip calling at a stop. */
export interface StopCall {
  trip: number;
  /** Position of the stop in the trip */
  pos: number;
  /** Minutes after midnight of the service day */
  minute: number;
}

/** Timetable with lookups built once after loading. Pure TypeScript – easy to test. */
export class GtfsIndex {
  readonly feed: GtfsFeedInfo;
  readonly stops: GtfsData['stops'];
  readonly trips: GtfsTrip[];
  /** Calls at each stop (by stop position in `stops`), sorted by time */
  readonly callsByStop: StopCall[][];
  private readonly stopIndex = new Map<string, number>();
  private readonly serviceStart: number;
  private readonly serviceDays: number;
  private readonly bitmaps: Uint8Array[];

  constructor(data: GtfsData) {
    this.feed = data.feed;
    this.stops = data.stops;
    data.stops.forEach(([id], i) => this.stopIndex.set(id, i));

    this.trips = data.trips.map(([variant, service, first, ...gaps], index) => {
      const times = [first];
      for (const g of gaps) times.push(times[times.length - 1] + g);
      return { index, variant: data.variants[variant], service, times };
    });

    this.callsByStop = data.stops.map(() => []);
    for (const trip of this.trips) {
      trip.variant.stops.forEach((stop, pos) => {
        this.callsByStop[stop].push({ trip: trip.index, pos, minute: trip.times[pos] });
      });
    }
    this.callsByStop.forEach(calls => calls.sort((a, b) => a.minute - b.minute));

    this.serviceStart = localMidnight(parseIsoDate(data.services.start));
    this.serviceDays = data.services.days;
    this.bitmaps = data.services.bitmaps.map(b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
  }

  stopPosition(stopId: string): number | undefined {
    return this.stopIndex.get(stopId);
  }

  stopId(position: number): string {
    return this.stops[position][0];
  }

  stopName(position: number): string {
    return this.stops[position][1];
  }

  /** Does a service (calendar) run on the given local date? */
  runsOn(service: number, date: Date): boolean {
    const day = Math.round((localMidnight(date) - this.serviceStart) / 86_400_000);
    if (day < 0 || day >= this.serviceDays) return false;
    return (this.bitmaps[service][day >> 3] & (1 << (day & 7))) !== 0;
  }
}

/**
 * Loads the official MKS timetable (GTFS converted by scripts/gtfs/build-gtfs.mjs) once
 * and shares the index. Everything is computed in the browser – no requests to other servers.
 */
@Injectable({
  providedIn: 'root'
})
export class GtfsService {
  private http = inject(HttpClient);

  /** Feed information once loaded (validity dates, source file) */
  readonly feed = signal<GtfsFeedInfo | null>(null);

  private readonly index$ = this.http.get<GtfsData>('assets/data/gtfs.json').pipe(
    map(data => new GtfsIndex(data)),
    tap(index => this.feed.set(index.feed)),
    shareReplay(1)
  );

  index(): Observable<GtfsIndex> {
    return this.index$;
  }
}

function parseIsoDate(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Local midnight as a day number in ms (DST-safe when divided by a day and rounded). */
function localMidnight(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}
