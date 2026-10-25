import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { GtfsIndex, GtfsService } from '../../core/services/gtfs.service';
import { ShapesService } from '../../core/services/shapes.service';
import { TravelTimeService } from '../../core/services/travel-time.service';
import { Stop } from '../../shared/models/transit.models';
import { BusDetails, ScheduledBus, TripState, busDetails, busesAt, parseTripKey, tripState } from './scheduled-buses';

const STORAGE_KEY = 'autobusy.scheduledBuses';
/** How often positions are recalculated while showing "now" */
export const REFRESH_MS = 5000;

/**
 * "Autobusy wg rozkładu" layer state: where buses should be now (or at the time chosen in the
 * time picker) according to the timetable. Computed in the browser, no requests.
 */
@Injectable({
  providedIn: 'root'
})
export class ScheduledBusesService {
  private gtfs = inject(GtfsService);
  private shapes = inject(ShapesService);
  private travelTime = inject(TravelTimeService);

  readonly enabled = signal(readEnabled());
  readonly buses = signal<ScheduledBus[]>([]);
  /** The moment the positions are for */
  readonly at = signal<Date | null>(null);

  /**
   * The selected trip (key from tripKey()) – a clicked bus or a departure clicked in the stop
   * panel. Shown in the side panel with its route, also when the bus layer is off.
   */
  readonly selectedKey = signal<string | null>(null);
  /** The selected trip now: not started, on its way (with the bus position) or finished */
  readonly selectedTrip = signal<TripState | null>(null);
  /** The selected trip's bus while it runs */
  readonly selected = computed(() => this.selectedTrip()?.bus ?? null);
  /** Set by select(…, true): the map should show the whole route of this trip */
  readonly focusKey = signal<string | null>(null);
  /** Side panel contents: rebuilt only when the bus reaches another stop */
  readonly details = computed<BusDetails | null>(() => {
    const state = this.selectedTrip();
    const index = this.indexLoaded();
    return state && index ? busDetails(index, state) : null;
  }, { equal: (a, b) => JSON.stringify(a) === JSON.stringify(b) });

  private readonly indexLoaded = signal<GtfsIndex | null>(null);
  private index: GtfsIndex | null = null;
  private paths = new Map<string, [number, number][]>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    this.gtfs.index().subscribe({
      next: index => {
        this.index = index;
        this.indexLoaded.set(index);
        this.refresh();
      },
      error: () => {} // no timetable – no buses (MainMapComponent reports the error)
    });
    effect(() => {
      const enabled = this.enabled();
      const selected = this.selectedKey() !== null;
      const chosen = this.travelTime.selected();
      this.shapes.loaded(); // road lines arrived: recompute along roads
      untracked(() => {
        this.paths.clear();
        this.stopTimer();
        this.refresh();
        if ((enabled || selected) && !chosen) this.timer = setInterval(() => this.refresh(), REFRESH_MS);
      });
    });
    inject(DestroyRef).onDestroy(() => this.stopTimer());
  }

  /** Selects a trip (null: none); `focus` asks the map to show its whole route. */
  select(key: string | null, focus = false): void {
    this.selectedKey.set(key);
    this.focusKey.set(focus ? key : null);
    this.refresh();
  }

  toggle(): void {
    this.enabled.update(v => !v);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.enabled()));
    } catch {
      // storage unavailable – the setting lasts for this visit only
    }
  }

  private refresh(): void {
    const index = this.index;
    if (!index) return;
    const key = this.selectedKey();
    if (!this.enabled() && !key) {
      this.buses.set([]);
      this.selectedTrip.set(null);
      return;
    }
    const background = typeof document !== 'undefined' && document.hidden;
    if (background && (this.buses().length || this.selectedTrip())) return;
    const at = this.travelTime.referenceTime();
    const path = (a: number, b: number) => this.path(index, a, b);
    this.at.set(at);
    this.buses.set(this.enabled() ? busesAt(index, at, path) : []);
    if (key) {
      const { trip, dayOffset } = parseTripKey(key);
      this.selectedTrip.set(index.trips[trip] ? tripState(index, at, trip, dayOffset, path) : null);
    } else {
      this.selectedTrip.set(null);
    }
  }

  private path(index: GtfsIndex, a: number, b: number): [number, number][] {
    const key = `${a}>${b}`;
    let points = this.paths.get(key);
    if (!points) {
      points = this.shapes.path([stopAt(index, a), stopAt(index, b)]);
      this.paths.set(key, points);
    }
    return points;
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

function stopAt(index: GtfsIndex, pos: number): Stop {
  const [id, name, lat, lng] = index.stops[pos];
  return { id, name, lat, lng, designator: pos + 1, onlyDisembarking: false };
}

function readEnabled(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    return false;
  }
}
