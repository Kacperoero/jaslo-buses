import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { StopsService } from '../../core/services/stops.service';
import { Stop } from '../../shared/models/transit.models';

/** One checked stop, as in scripts/gtfs/stop-overrides.json */
export interface StopOverride {
  name: string;
  directions: 1 | 2;
}
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
 * State of the developer stop editor: walking through the stops one by one and marking each
 * as one-direction or both-direction. Checked stops are kept in the browser until exported as
 * stop-overrides.json and applied with `npm run gtfs:stops -- --import <file>`.
 */
@Injectable({
  providedIn: 'root'
})
export class StopEditorService {
  private http = inject(HttpClient);
  private stopsService = inject(StopsService);

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
      .filter(([id, o]) => saved[id]?.directions !== o.directions));
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
    const stop = this.current();
    if (!stop) return;
    const local = { ...this.local() };
    if (this.saved()[stop.id]?.directions === directions) delete local[stop.id];
    else local[stop.id] = { name: stop.name, directions };
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
    return JSON.stringify(Object.fromEntries(ordered.map(id => [id, entries[id]])), null, 2) + '\n';
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

/** Number of directions according to the timetable (before any manual correction). */
export function timetableDirections(stop: Stop): 1 | 2 {
  return stop.timetableDirections ?? stop.directions ?? 1;
}
