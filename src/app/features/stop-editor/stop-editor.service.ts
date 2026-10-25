import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { ShapesService } from '../../core/services/shapes.service';
import { StopsService } from '../../core/services/stops.service';
import { Stop } from '../../shared/models/transit.models';

/** One checked stop, as in scripts/gtfs/stop-overrides.json */
export interface StopOverride {
  name: string;
  directions: 1 | 2;
  /** Where the stop really is (moved by hand) */
  lat?: number;
  lng?: number;
  /** Where buses stop on the road, per direction: [lat, lng, travel bearing] (moved by hand) */
  roadPoints?: RoadPoint[];
}
export type RoadPoint = [number, number, number | null];
export type StopOverrides = Record<string, StopOverride>;
export type EditorFilter = 'all' | 'unchecked' | 'changed';

const STORAGE_KEY = 'autobusy.stopEditor';
/** scripts/gtfs/stop-overrides.json, served by the dev server (angular.json, development) */
const OVERRIDES_URL = 'assets/dev/stop-overrides.json';

/** Whether the app was opened with ?dev – shows the stop editor. */
export function stopEditorEnabled(search = location.search): boolean {
  return new URLSearchParams(search).has('dev');
}

/**
 * State of the developer stop editor: walking through the stops one by one, marking each as
 * one-direction or both-direction and moving the stop or its road points where they really are. Checked stops are kept in the browser until exported as
 * stop-overrides.json and applied with `npm run gtfs:stops -- --import <file>`.
 */
@Injectable({
  providedIn: 'root'
})
export class StopEditorService {
  private http = inject(HttpClient);
  private stopsService = inject(StopsService);
  private shapes = inject(ShapesService);

  /** Checked stops already in scripts/gtfs/stop-overrides.json */
  readonly saved = signal<StopOverrides>({});
  /** Checked here, not yet exported and applied */
  readonly local = signal<StopOverrides>({});
  readonly filter = signal<EditorFilter>('unchecked');
  readonly currentId = signal<string | null>(null);

  readonly entries = computed<StopOverrides>(() => ({ ...this.saved(), ...this.local() }));

  /** All stops in name order (same-named posts next to each other) */
  readonly ordered = computed(() =>
    [...this.stopsService.stops()].sort((a, b) => a.name.localeCompare(b.name, 'pl') || a.id.localeCompare(b.id)));

  /** Stops shown by the current filter (the current stop always stays, so it doesn't vanish once checked) */
  readonly list = computed(() => {
    const entries = this.entries();
    const current = this.currentId();
    const keep = (s: Stop) => {
      switch (this.filter()) {
        case 'unchecked': return !entries[s.id];
        case 'changed': return !!entries[s.id] && entries[s.id].directions !== timetableDirections(s);
        default: return true;
      }
    };
    return this.ordered().filter(s => s.id === current || keep(s));
  });

  readonly current = computed(() => this.stopsService.byId().get(this.currentId() ?? '') ?? null);
  readonly position = computed(() => this.list().findIndex(s => s.id === this.currentId()));
  readonly checkedCount = computed(() => this.ordered().filter(s => this.entries()[s.id]).length);
  /** Local changes not in stop-overrides.json yet */
  readonly pendingCount = computed(() => Object.keys(this.local()).length);

  /** Directions of the current stop: as checked, or from the timetable */
  readonly currentDirections = computed(() => {
    const stop = this.current();
    return stop ? (this.entries()[stop.id]?.directions ?? timetableDirections(stop)) : null;
  });

  /** Where the current stop is: moved by hand, or the GTFS position */
  readonly currentPosition = computed<[number, number] | null>(() => {
    const stop = this.current();
    if (!stop) return null;
    const entry = this.entries()[stop.id];
    if (entry?.lat != null && entry.lng != null) return [entry.lat, entry.lng];
    return stop.gtfsPosition ?? [stop.lat, stop.lng];
  });

  /** Road points of the current stop: moved by hand, or as last computed (shapes.json) */
  readonly currentRoadPoints = computed<RoadPoint[]>(() => {
    const stop = this.current();
    this.shapes.loaded();
    if (!stop) return [];
    return this.entries()[stop.id]?.roadPoints
      ?? this.shapes.roadPoints(stop.id).map(p => [p.lat, p.lng, p.bearing] as RoadPoint);
  });

  /** Whether the current stop's position or road points were moved by hand */
  readonly currentMoved = computed(() => {
    const entry = this.entries()[this.currentId() ?? ''];
    return { stop: entry?.lat != null, roadPoints: !!entry?.roadPoints };
  });

  private started = false;

  /** Loads the saved corrections and the work in progress; starts at the first unchecked stop. */
  start(): void {
    if (this.started) return;
    this.started = true;
    const stored = readStorage();
    this.filter.set(stored.filter ?? 'unchecked');
    this.http.get<StopOverrides>(OVERRIDES_URL).subscribe({
      next: saved => this.init(saved ?? {}, stored),
      error: () => this.init({}, stored) // production build: no file served
    });
  }

  private init(saved: StopOverrides, stored: Stored): void {
    this.saved.set(saved);
    // Drop local entries that are already saved in the file (exported and applied)
    const local = Object.fromEntries(Object.entries(stored.local ?? {})
      .filter(([id, o]) => !sameEntry(saved[id], o)));
    this.local.set(local);
    this.stopsService.load().subscribe(() => {
      const first = this.list()[0];
      this.currentId.set(stored.currentId && this.stopsService.byId().has(stored.currentId) ? stored.currentId : first?.id ?? null);
      this.persist();
    });
  }

  go(stopId: string): void {
    this.currentId.set(stopId);
    this.persist();
  }

  next(): void { this.step(1); }
  prev(): void { this.step(-1); }

  private step(delta: number): void {
    const list = this.list();
    if (list.length === 0) return;
    const i = this.position();
    const target = list[Math.min(list.length - 1, Math.max(0, i + delta))];
    if (target) this.go(target.id);
  }

  /** Marks the current stop as checked with the given number of directions. */
  setDirections(directions: 1 | 2): void {
    this.update({ directions });
  }

  /** Moves the current stop (marks it as checked). */
  moveStop(lat: number, lng: number): void {
    this.update({ lat: round6(lat), lng: round6(lng) });
  }

  /** Moves one road point of the current stop (marks it as checked). */
  moveRoadPoint(index: number, lat: number, lng: number): void {
    const points = this.currentRoadPoints().map(p => [...p] as RoadPoint);
    if (!points[index]) return;
    points[index] = [round6(lat), round6(lng), points[index][2]];
    this.update({ roadPoints: points });
  }

  /** Back to the GTFS position and automatic road points (directions stay). */
  resetPosition(): void {
    this.update({ lat: undefined, lng: undefined, roadPoints: undefined });
  }

  private update(patch: Partial<StopOverride>): void {
    const stop = this.current();
    const directions = this.currentDirections();
    if (!stop || !directions) return;
    const entry = clean({ ...this.entries()[stop.id], name: stop.name, directions, ...patch });
    const local = { ...this.local() };
    if (sameEntry(this.saved()[stop.id], entry)) delete local[stop.id];
    else local[stop.id] = entry;
    this.local.set(local);
    this.persist();
  }

  /** Checks the current stop as it is now and moves on. */
  confirmAndNext(): void {
    const d = this.currentDirections();
    if (d) this.setDirections(d);
    this.next();
  }

  /** Forgets the local check of the current stop. */
  undoCurrent(): void {
    const id = this.currentId();
    if (!id || !this.local()[id]) return;
    const { [id]: _, ...rest } = this.local();
    this.local.set(rest);
    this.persist();
  }

  setFilter(filter: EditorFilter): void {
    this.filter.set(filter);
    this.persist();
  }

  /** Contents of stop-overrides.json: saved + local checks, ordered by stop name. */
  exportJson(): string {
    const entries = this.entries();
    const ordered = Object.keys(entries).sort((a, b) =>
      entries[a].name.localeCompare(entries[b].name, 'pl') || a.localeCompare(b));
    return JSON.stringify(Object.fromEntries(ordered.map(id => [id, clean(entries[id])])), null, 2) + '\n';
  }

  private persist(): void {
    try {
      const data: Stored = { local: this.local(), filter: this.filter(), currentId: this.currentId() ?? undefined };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // storage unavailable – the editor still works for this visit
    }
  }
}

interface Stored {
  local?: StopOverrides;
  filter?: EditorFilter;
  currentId?: string;
}

function readStorage(): Stored {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}') as Stored;
  } catch {
    return {};
  }
}

/** Entry with fields in a fixed order and without empty ones (for the file and comparisons). */
function clean(o: Partial<StopOverride>): StopOverride {
  const out: StopOverride = { name: o.name ?? '', directions: o.directions ?? 1 };
  if (o.lat != null && o.lng != null) {
    out.lat = o.lat;
    out.lng = o.lng;
  }
  if (o.roadPoints?.length) out.roadPoints = o.roadPoints;
  return out;
}

function sameEntry(a: StopOverride | undefined, b: StopOverride): boolean {
  return !!a && JSON.stringify(clean(a)) === JSON.stringify(clean(b));
}

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

/** Number of directions according to the timetable (before any manual correction). */
export function timetableDirections(stop: Stop): 1 | 2 {
  return stop.timetableDirections ?? stop.directions ?? 1;
}
