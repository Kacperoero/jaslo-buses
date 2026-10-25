import { Component, DestroyRef, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { Subscription } from 'rxjs';
import { FavoritesService } from '../../../core/services/favorites.service';
import { StopsService } from '../../../core/services/stops.service';
import { TimetableService } from '../../../core/services/timetable.service';
import { TravelTimeService } from '../../../core/services/travel-time.service';
import { DeparturesResponse } from '../../../shared/models/transit.models';
import { MapMarkerService } from '../services/map-marker.service';

/** How often "in N min" is recalculated while showing "now" */
const REFRESH_MS = 30_000;
/** Departures listed */
const MAX_ROWS = 15;

interface Row {
  line: string;
  direction: string;
  time: string;
  canceled: boolean;
}

/** Side panel (right; bottom sheet on phones) with the selected stop's next departures. */
@Component({
  selector: 'app-stop-panel',
  standalone: true,
  templateUrl: './stop-panel.component.html',
  styleUrl: './stop-panel.component.scss'
})
export class StopPanelComponent {
  private markers = inject(MapMarkerService);
  private stops = inject(StopsService);
  private timetable = inject(TimetableService);
  private favorites = inject(FavoritesService);
  readonly travelTime = inject(TravelTimeService);

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

  close(): void {
    this.markers.selectStop(null);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }
}

function toRows(data: DeparturesResponse, scheduled: boolean): Row[] {
  const directions = data.directions ?? {};
  return (data.rows ?? []).slice(0, MAX_ROWS).map(row => ({
    line: row.line_name || row.line || '?',
    direction: (row.direction_id != null && directions[row.direction_id]) || row.direction || 'Brak kierunku',
    // A chosen time: clock times are more useful than "in N min" from a future moment
    time: scheduled && row.static_time
      ? row.static_time
      : row.minutes_to_departure != null ? `${row.minutes_to_departure} min` : row.time || '—',
    canceled: !!row.canceled
  }));
}
