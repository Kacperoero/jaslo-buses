import { DestroyRef, Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { GtfsIndex, GtfsService } from '../../core/services/gtfs.service';
import { ShapesService } from '../../core/services/shapes.service';
import { TravelTimeService } from '../../core/services/travel-time.service';
import { Stop } from '../../shared/models/transit.models';
import { BusDetails, ScheduledBus, busDetails, busesAt } from './scheduled-buses';

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

  /** The clicked bus (its key) – shown in the side panel with its route */
  readonly selectedKey = signal<string | null>(null);
  /** The clicked bus while it still runs (null once it reached its last stop) */
  readonly selected = computed(() => this.buses().find(b => b.key === this.selectedKey()) ?? null);
  /** Side panel contents: rebuilt only when the bus reaches another stop */
  readonly details = computed<BusDetails | null>(() => {
    const bus = this.selected();
    const index = this.indexLoaded();
    return bus && index ? busDetails(index, bus) : null;
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
      const chosen = this.travelTime.selected();
      this.shapes.loaded(); // road lines arrived: recompute along roads
      untracked(() => {
        this.paths.clear();
        this.stopTimer();
        if (!enabled) {
          this.buses.set([]);
          this.selectedKey.set(null);
          return;
        }
        this.refresh();
        if (!chosen) this.timer = setInterval(() => this.refresh(), REFRESH_MS);
      });
    });
    inject(DestroyRef).onDestroy(() => this.stopTimer());
  }

  select(key: string | null): void {
    this.selectedKey.set(key);
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
    if (!this.index || !this.enabled()) return;
    if (typeof document !== 'undefined' && document.hidden && this.buses().length) return; // background tab
    const at = this.travelTime.referenceTime();
    const index = this.index;
    this.at.set(at);
    this.buses.set(busesAt(index, at, (a, b) => this.path(index, a, b)));
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
