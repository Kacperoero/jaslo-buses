import { Component, computed, inject, signal } from '@angular/core';
import { FavoritesService } from '../../../core/services/favorites.service';
import { GeolocationService } from '../../../core/services/geolocation.service';
import { TimePickerComponent } from '../../../shared/components/time-picker/time-picker.component';
import { ConnectionCardComponent } from '../connection-card/connection-card.component';
import { PlannerStateService } from '../planner-state.service';
import { RecentRoutesComponent } from '../recent-routes/recent-routes.component';
import { StopInputComponent } from '../stop-input/stop-input.component';

/** Route planner side panel: points A/B, time, search button, results and recent routes. */
@Component({
  selector: 'app-planner-panel',
  standalone: true,
  imports: [StopInputComponent, ConnectionCardComponent, RecentRoutesComponent, TimePickerComponent],
  templateUrl: './planner-panel.component.html',
  styleUrl: './planner-panel.component.scss'
})
export class PlannerPanelComponent {
  readonly planner = inject(PlannerStateService);
  private favorites = inject(FavoritesService);
  private geolocation = inject(GeolocationService);

  readonly locating = signal(false);
  readonly locationError = signal<string | null>(null);

  readonly showRecentRoutes = computed(() =>
    !this.planner.searching() && this.planner.connections().length === 0 && this.favorites.recentRoutes().length > 0);

  async useMyLocation(): Promise<void> {
    this.locating.set(true);
    this.locationError.set(null);
    try {
      const p = await this.geolocation.locate();
      this.planner.setUserLocation('start', p.lat, p.lng);
    } catch (err) {
      this.locationError.set(err instanceof Error ? err.message : 'Nie udało się ustalić lokalizacji');
    } finally {
      this.locating.set(false);
    }
  }
}
