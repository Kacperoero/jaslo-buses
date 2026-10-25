import { Component, DestroyRef, computed, effect, inject, input, output, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { FavoritesService } from '../../../core/services/favorites.service';
import { StopsService } from '../../../core/services/stops.service';
import { TimetableService } from '../../../core/services/timetable.service';
import { TravelTimeService } from '../../../core/services/travel-time.service';
import { DeparturesResponse } from '../../../shared/models/transit.models';
import { tripKey } from '../../vehicles/scheduled-buses';
import { ScheduledBusesService } from '../../vehicles/scheduled-buses.service';
import { MapMarkerService } from '../services/map-marker.service';

/** How often "in N min" is recalculated while showing "now" */
const REFRESH_MS = 30_000;
/** Departures listed */
const MAX_ROWS = 15;

interface Row {
  /** Trip key (tripKey()) – clicking the row shows this trip */
  key: string | null;
  line: string;
  direction: string;
  time: string;
  canceled: boolean;
}

/**
 * Side panel with the selected stop's next departures. Clicking a departure shows that trip
 * (route, where the bus is) in the bus panel; this panel then collapses to its header.
 */
@Component({
  selector: 'app-stop-panel',
  standalone: true,
  templateUrl: './stop-panel.component.html',
  styleUrl: './stop-panel.component.scss',
  host: { '[class.collapsed]': 'collapsed()' }
})
export class StopPanelComponent {
  private markers = inject(MapMarkerService);
  private stops = inject(StopsService);
  private timetable = inject(TimetableService);
  private favorites = inject(FavoritesService);
  readonly travelTime = inject(TravelTimeService);
  readonly buses = inject(ScheduledBusesService);

  readonly collapsed = input(false);
  readonly expand = output<void>();

  readonly stop = computed(() => this.stops.byId().get(this.markers.selectedStopId() ?? '') ?? null);
  readonly favorite = computed(() => {
    const stop = this.stop();
    return !!stop && this.favorites.favoriteStopIds().includes(stop.id);
  });
  readonly state = signal<'loading' | 'error' | 'ready'>('loading');
  readonly rows = signal<Row[]>([]);
  /** Which stop the rows are for – a new stop shows "loading" instead of the old stop's rows */
  private rowsFor: string | null = null;
  private tick = signal(0);

  /** "↔ oba kierunki" / "→ jeden kierunek w stronę: …" */
  readonly direction = computed(() => {
    const stop = this.stop();
    if (stop?.directions === 2) return '↔ oba kierunki';
    if (stop?.directions === 1) {
      return `→ jeden kierunek${stop.towards ? ` w stronę: ${stop.towards.replace('JASŁO,ul.', '')}` : ''}`;
    }
    return '';
  });

  constructor() {
    let request: Subscription | null = null;
    effect(() => {
      const stop = this.stop();
      const at = this.travelTime.selected();
      this.tick();
      untracked(() => {
        request?.unsubscribe();
        if (!stop) return;
        if (this.rowsFor !== stop.id) this.state.set('loading');
        this.rowsFor = stop.id;
        request = this.timetable.getDepartures(stop.id, at).subscribe({
          next: data => {
            this.rows.set(toRows(data, at !== null));
            this.state.set('ready');
          },
          error: () => this.state.set('error')
        });
      });
    });
    const timer = setInterval(() => {
      if (this.stop() && !this.travelTime.selected()) this.tick.update(t => t + 1);
    }, REFRESH_MS);
    inject(DestroyRef).onDestroy(() => {
      clearInterval(timer);
      request?.unsubscribe();
    });
  }

  toggleFavorite(): void {
    const stop = this.stop();
    if (stop) this.favorites.toggleFavorite(stop.id);
  }

  showTrip(row: Row): void {
    if (row.key) this.buses.select(row.key, true);
  }

  onHeaderClick(): void {
    if (this.collapsed()) this.expand.emit();
  }

  toggleFavoriteClick(event: Event): void {
    event.stopPropagation();
    this.toggleFavorite();
  }

  close(event?: Event): void {
    event?.stopPropagation();
    this.markers.selectStop(null);
  }
}

function toRows(data: DeparturesResponse, scheduled: boolean): Row[] {
  const directions = data.directions ?? {};
  return (data.rows ?? []).slice(0, MAX_ROWS).map(row => ({
    key: row.trip != null ? tripKey(row.trip, row.day_offset ?? 0) : null,
    line: row.line_name || row.line || '?',
    direction: (row.direction_id != null && directions[row.direction_id]) || row.direction || 'Brak kierunku',
    // A chosen time: clock times are more useful than "in N min" from a future moment
    time: scheduled && row.static_time
      ? row.static_time
      : row.minutes_to_departure != null ? `${row.minutes_to_departure} min` : row.time || '—',
    canceled: !!row.canceled
  }));
}
