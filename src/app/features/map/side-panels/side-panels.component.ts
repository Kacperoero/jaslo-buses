import { Component, HostListener, computed, effect, inject, signal, untracked } from '@angular/core';
import { StopsService } from '../../../core/services/stops.service';
import { BusPanelComponent } from '../../vehicles/bus-panel/bus-panel.component';
import { ScheduledBusesService } from '../../vehicles/scheduled-buses.service';
import { MapMarkerService } from '../services/map-marker.service';
import { StopPanelComponent } from '../stop-panel/stop-panel.component';

/**
 * The selected stop and the selected trip, stacked on the right (bottom sheet on phones). Both
 * can be open: the one picked last is expanded, the other collapses to its header (click it to
 * switch). Esc closes the expanded one.
 */
@Component({
  selector: 'app-side-panels',
  standalone: true,
  imports: [StopPanelComponent, BusPanelComponent],
  template: `
    @if (stopOpen() || busOpen()) {
      <div class="side-panels">
        <app-stop-panel [collapsed]="busOpen() && expanded() === 'bus'" (expand)="expanded.set('stop')" />
        <app-bus-panel [collapsed]="stopOpen() && expanded() === 'stop'" (expand)="expanded.set('bus')" />
      </div>
    }
  `
})
export class SidePanelsComponent {
  private markers = inject(MapMarkerService);
  private stops = inject(StopsService);
  private buses = inject(ScheduledBusesService);

  readonly expanded = signal<'stop' | 'bus'>('stop');
  readonly stopOpen = computed(() => this.stops.byId().has(this.markers.selectedStopId() ?? ''));
  readonly busOpen = computed(() => this.buses.details() !== null);

  constructor() {
    // Whatever was picked last is expanded
    effect(() => {
      if (this.markers.selectedStopId()) untracked(() => this.expanded.set('stop'));
    });
    effect(() => {
      if (this.buses.selectedKey()) untracked(() => this.expanded.set('bus'));
    });
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    const closeStop = this.stopOpen() && (this.expanded() === 'stop' || !this.busOpen());
    if (closeStop) {
      this.markers.selectStop(null);
      this.expanded.set('bus');
    } else if (this.busOpen()) {
      this.buses.select(null);
      this.expanded.set('stop');
    }
  }
}
