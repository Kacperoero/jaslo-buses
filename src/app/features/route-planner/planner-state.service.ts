import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { FavoritesService, RecentRoute } from '../../core/services/favorites.service';
import { StopsService } from '../../core/services/stops.service';
import { TravelTimeService } from '../../core/services/travel-time.service';
import { Stop } from '../../shared/models/transit.models';
import { getNearestStops } from '../../shared/utils/geo.utils';
import { Connection, ConnectionPoint } from './route-planner.models';
import { RoutePlannerService } from './route-planner.service';

export type PointType = 'start' | 'end';

/** A map point this close to a stop is named after it ("Blisko: …"). */
const NAME_AFTER_STOP_M = 100;

/**
 * State of the route planner panel: points A and B, the search and its results.
 * Shared by the panel components and the map (which draws the points and the selected route).
 */
@Injectable({
  providedIn: 'root'
})
export class PlannerStateService {
  private planner = inject(RoutePlannerService);
  private favorites = inject(FavoritesService);
  private stops = inject(StopsService);
  private travelTime = inject(TravelTimeService);

  /** Whether the planner panel is shown (instead of the stop search) */
  readonly open = signal(false);

  readonly start = signal<ConnectionPoint | null>(null);
  readonly end = signal<ConnectionPoint | null>(null);
  /** Text in the A / B fields (a stop name, or what the user is typing) */
  readonly startText = signal('');
  readonly endText = signal('');

  /** Which point the next map click sets */
  readonly picking = signal<PointType | null>(null);

  readonly searching = signal(false);
  /** True once a search finished for the current points & time (for the "nothing found" message) */
  readonly searchDone = signal(false);
  readonly connections = signal<Connection[]>([]);
  readonly selectedIndex = signal<number | null>(null);
  readonly selected = computed(() => {
    const i = this.selectedIndex();
    return i === null ? null : this.connections()[i] ?? null;
  });

  readonly canSearch = computed(() => !!this.start() && !!this.end());

  /** Incremented per search, so a slow search can't overwrite results of a newer one */
  private searchCounter = 0;

  constructor() {
    // Results are calculated for a specific moment – drop them when the user changes the time
    effect(() => {
      this.travelTime.selected();
      untracked(() => this.clearResults());
    });
  }

  toggle(): void {
    if (this.open()) {
      this.open.set(false);
      this.clearAll();
    } else {
      this.open.set(true);
    }
  }

  setStop(type: PointType, stop: Stop): void {
    this.setPoint(type, { lat: stop.lat, lng: stop.lng, name: stop.name, isStop: true, stopId: stop.id });
  }

  /** Sets the point being picked from a map click; returns false when no point is being picked. */
  setPointFromMap(lat: number, lng: number): boolean {
    const type = this.picking();
    if (!type) return false;
    this.picking.set(null);
    const nearest = getNearestStops(this.stops.stops(), lat, lng, 1)[0];
    const name = nearest && nearest.distance < NAME_AFTER_STOP_M
      ? `Blisko: ${nearest.stop.name}`
      : `Punkt na mapie (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
    this.setPoint(type, { lat, lng, name });
    return true;
  }

  /** The user's GPS position – never saved to recent routes. */
  setUserLocation(type: PointType, lat: number, lng: number): void {
    this.setPoint(type, { lat, lng, name: 'Moja lokalizacja', isUserLocation: true });
  }

  startPicking(type: PointType): void {
    this.picking.set(this.picking() === type ? null : type);
  }

  swap(): void {
    const s = this.start();
    const e = this.end();
    this.start.set(e);
    this.end.set(s);
    this.startText.set(e?.name ?? '');
    this.endText.set(s?.name ?? '');
    this.clearResults();
  }

  clearAll(): void {
    this.start.set(null);
    this.end.set(null);
    this.startText.set('');
    this.endText.set('');
    this.picking.set(null);
    this.clearResults();
  }

  /** Fills A and B from a recent route and searches again. */
  useRecentRoute(route: RecentRoute): void {
    this.start.set({ ...route.from });
    this.end.set({ ...route.to });
    this.startText.set(route.from.name);
    this.endText.set(route.to.name);
    this.clearResults();
    void this.search();
  }

  async search(): Promise<void> {
    const start = this.start();
    const end = this.end();
    if (!start || !end) return;

    if (!start.isUserLocation && !end.isUserLocation) {
      this.favorites.addRecentRoute(start, end);
    }

    const searchId = ++this.searchCounter;
    this.searching.set(true);
    this.searchDone.set(false);
    this.connections.set([]);
    this.selectedIndex.set(null);

    try {
      const found = await this.planner.findConnections(start, end, this.stops.stops());
      if (searchId !== this.searchCounter) return; // points or time changed meanwhile
      this.connections.set(found);
      this.searchDone.set(true);
      this.selectedIndex.set(found.length > 0 ? 0 : null);
    } catch (err) {
      console.error('Route search failed', err);
    } finally {
      if (searchId === this.searchCounter) this.searching.set(false);
    }
  }

  select(index: number): void {
    this.selectedIndex.set(index);
  }

  private setPoint(type: PointType, point: ConnectionPoint): void {
    (type === 'start' ? this.start : this.end).set(point);
    (type === 'start' ? this.startText : this.endText).set(point.name);
    this.clearResults();
  }

  /** Drop found connections (and cancel a running search) after the points or time change. */
  private clearResults(): void {
    this.searchCounter++;
    this.searching.set(false);
    this.searchDone.set(false);
    this.connections.set([]);
    this.selectedIndex.set(null);
  }
}
