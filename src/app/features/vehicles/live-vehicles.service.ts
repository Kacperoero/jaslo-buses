import { Injectable, OnDestroy, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { MAX_STOPS_PER_MULTI_REQUEST, TimetableService } from '../../core/services/timetable.service';
import { Stop, TripExecutionResponse } from '../../shared/models/transit.models';
import { getDistance } from '../../shared/utils/geo.utils';
import { parseDepartureTimeToMinutes, parseTimeToMinutesOfDay } from '../../shared/utils/time.utils';

/** A bus on the road, as shown on the map. */
export interface LiveVehicle {
  /** trip_execution_id of the run */
  id: string;
  line: string;
  direction: string;
  lat: number;
  lng: number;
  nextStop?: string;
  /** Expected arrival at the next stop, "HH:MM" */
  nextStopEta?: string;
  /** Minutes behind (+) or ahead of (−) the timetable at the next stop */
  delayMin?: number;
  atStop: boolean;
}

export interface MapBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

/** How often bus positions are refreshed. */
const REFRESH_MS = 20_000;
/** Stops asked right after switching on or moving the map (nearest to the centre first; /6 = requests). */
const FIRST_ROUND_STOPS = 72;
/** Stops asked in each following refresh, continuing the sweep through the visible area. */
const ROUND_STOPS = 24;
/** A departure arriving within this many minutes means its bus is on the road nearby. */
const ON_THE_ROAD_WITHIN_MIN = 15;
/** Upper limit of tracked buses (1 request each per refresh). */
const MAX_TRACKED = 40;
/** The visible area is extended by this fraction on each side when sampling stops. */
const BOUNDS_PADDING = 0.2;

interface TrackedRun {
  id: string;
  index: number;
  line: string;
}

/**
 * Live positions of buses in (and around) the visible part of the map.
 *
 * The public API has no "all vehicles" endpoint (/api/vehicles needs a login), so buses are
 * found through departures: stops in view are asked which buses arrive soon (6 stops per
 * request), and each such bus run's trip details carry its GPS position. Stops are swept
 * gradually from the centre of the view outwards – a bigger first round, then a few requests
 * per refresh – so every bus in view is found within a few minutes at a small, steady cost.
 * The layer is off by default, refreshes every 20 s and pauses while the browser tab is hidden.
 */
@Injectable({
  providedIn: 'root'
})
export class LiveVehiclesService implements OnDestroy {
  private timetable = inject(TimetableService);

  readonly enabled = signal(false);
  readonly vehicles = signal<LiveVehicle[]>([]);
  /** True while the first round after switching on is loading */
  readonly loading = signal(false);

  private stops: Stop[] = [];
  private getBounds: () => MapBounds = () => ({ south: -90, west: -180, north: 90, east: 180 });
  private tracked = new Map<string, TrackedRun>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** Stops in view, nearest to the centre first, and how far the sweep has got */
  private sweep: Stop[] = [];
  private sweepPos = 0;
  private needsDiscovery = true;
  private inFlight = false;
  private onVisibility = () => {
    if (document.visibilityState === 'visible' && this.enabled()) this.refresh();
  };

  /** Stops to sample and a way to read the visible map area. */
  configure(stops: Stop[], getBounds: () => MapBounds): void {
    this.stops = stops;
    this.getBounds = getBounds;
  }

  toggle(): void {
    this.enabled() ? this.stop() : this.start();
  }

  start(): void {
    if (this.enabled()) return;
    this.enabled.set(true);
    this.loading.set(true);
    this.needsDiscovery = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.timer = setInterval(() => {
      if (document.visibilityState === 'visible') this.refresh();
    }, REFRESH_MS);
    this.refresh();
  }

  stop(): void {
    this.enabled.set(false);
    this.loading.set(false);
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.tracked.clear();
    this.vehicles.set([]);
  }

  /** The map moved – look for buses in the new area on the next refresh. */
  boundsChanged(): void {
    this.needsDiscovery = true;
  }

  ngOnDestroy(): void {
    this.stop();
  }

  /** One round: find new buses (sometimes) and update the positions of tracked ones. */
  async refresh(): Promise<void> {
    if (this.inFlight || !this.enabled()) return;
    this.inFlight = true;
    try {
      await this.discover();
      await this.updatePositions();
    } finally {
      this.inFlight = false;
      this.loading.set(false);
    }
  }

  /** Asks the next stops of the sweep which buses arrive soon, and starts tracking those runs. */
  private async discover(): Promise<void> {
    let count = ROUND_STOPS;
    if (this.needsDiscovery) {
      this.needsDiscovery = false;
      this.sweep = stopsFromCentre(this.stops, padBounds(this.getBounds(), BOUNDS_PADDING));
      this.sweepPos = 0;
      count = FIRST_ROUND_STOPS;
    }
    if (this.sweep.length === 0) return;

    const sample: Stop[] = [];
    for (let i = 0; i < Math.min(count, this.sweep.length); i++) {
      sample.push(this.sweep[(this.sweepPos + i) % this.sweep.length]);
    }
    this.sweepPos = (this.sweepPos + sample.length) % this.sweep.length;

    const groups: string[][] = [];
    for (let i = 0; i < sample.length; i += MAX_STOPS_PER_MULTI_REQUEST) {
      groups.push(sample.slice(i, i + MAX_STOPS_PER_MULTI_REQUEST).map(s => s.id));
    }

    const now = new Date();
    const responses = await Promise.all(groups.map(ids =>
      firstValueFrom(this.timetable.getDeparturesForStops(ids)).catch(() => null)));

    for (const res of responses) {
      for (const group of res?.departures ?? []) {
        for (const row of group.rows ?? []) {
          if (!row.trip_execution_id || row.canceled || !row.is_estimated) continue;
          if (this.tracked.size >= MAX_TRACKED) return;
          if (parseDepartureTimeToMinutes(row.time, now) > ON_THE_ROAD_WITHIN_MIN) continue;
          if (!this.tracked.has(row.trip_execution_id)) {
            this.tracked.set(row.trip_execution_id, {
              id: row.trip_execution_id,
              index: row.trip_index ?? 0,
              line: row.line_name || row.line || '?'
            });
          }
        }
      }
    }
  }

  /** Fetches each tracked run; buses without a position or past their last stop are dropped. */
  private async updatePositions(): Promise<void> {
    const runs = [...this.tracked.values()];
    const results = await Promise.all(runs.map(run =>
      firstValueFrom(this.timetable.getTripExecution(run.id, run.index)).catch(() => null)));
    if (!this.enabled()) return; // switched off meanwhile

    const vehicles: LiveVehicle[] = [];
    runs.forEach((run, i) => {
      const vehicle = results[i] ? toVehicle(run, results[i]!) : null;
      if (vehicle) vehicles.push(vehicle);
      else if (results[i]) this.tracked.delete(run.id); // finished or not started – stop asking
    });
    this.vehicles.set(vehicles);
  }
}

/** Map entry for a run, or null when the bus has no live position or finished its trip. */
export function toVehicle(run: TrackedRun, exec: TripExecutionResponse): LiveVehicle | null {
  const times = exec.trip?.times ?? [];
  if (!exec.estimated || !exec.vehicle || exec.next_departure_index >= times.length) return null;

  // Before its first stop (waiting at the terminus) the vehicle index is -1 – then the next stop
  // is the first departure; estimates always start at that next stop
  const nextIndex = exec.vehicle_trip_index >= 0 ? exec.vehicle_trip_index : exec.next_departure_index;
  const next = times[nextIndex];
  const eta = exec.estimates?.[0]?.arrival_abs ?? undefined;
  let delayMin: number | undefined;
  if (next && eta) {
    delayMin = parseTimeToMinutesOfDay(eta) - parseTimeToMinutesOfDay(next.departure_time);
    if (delayMin > 720) delayMin -= 1440;
    if (delayMin < -720) delayMin += 1440;
  }

  return {
    id: run.id,
    line: exec.trip.line?.name || run.line,
    direction: exec.trip.direction,
    lat: exec.vehicle.lat,
    lng: exec.vehicle.lon,
    nextStop: next?.stop_name,
    nextStopEta: eta,
    delayMin,
    atStop: exec.at_stop
  };
}

/** Stops inside `bounds` where passengers board, nearest to the centre of `bounds` first. */
export function stopsFromCentre(stops: Stop[], bounds: MapBounds): Stop[] {
  const midLat = (bounds.south + bounds.north) / 2;
  const midLng = (bounds.west + bounds.east) / 2;
  return stops
    .filter(s => s.lat >= bounds.south && s.lat <= bounds.north && s.lng >= bounds.west && s.lng <= bounds.east)
    .filter(s => !s.onlyDisembarking)
    .map(s => ({ s, d: getDistance(midLat, midLng, s.lat, s.lng) }))
    .sort((a, b) => a.d - b.d)
    .map(x => x.s);
}

function padBounds(b: MapBounds, f: number): MapBounds {
  const dLat = (b.north - b.south) * f;
  const dLng = (b.east - b.west) * f;
  return { south: b.south - dLat, north: b.north + dLat, west: b.west - dLng, east: b.east + dLng };
}
