import { Component, ElementRef, afterRenderEffect, computed, inject, input, output } from '@angular/core';
import { MapMarkerService } from '../../map/services/map-marker.service';
import { ScheduledBusesService } from '../scheduled-buses.service';

/**
 * Side panel with the selected trip (a clicked bus, or a departure clicked in the stop panel):
 * line, direction, where it is and all its stops with times. Collapses to its header when the
 * stop panel is expanded.
 */
@Component({
  selector: 'app-bus-panel',
  standalone: true,
  templateUrl: './bus-panel.component.html',
  styleUrl: './bus-panel.component.scss',
  host: { '[class.collapsed]': 'collapsed()' }
})
export class BusPanelComponent {
  readonly buses = inject(ScheduledBusesService);
  private markers = inject(MapMarkerService);
  private host = inject<ElementRef<HTMLElement>>(ElementRef);

  readonly collapsed = input(false);
  readonly expand = output<void>();

  /** The stop open in the stop panel – marked in the list */
  readonly hereId = computed(() => this.markers.selectedStopId());

  constructor() {
    // Keep the next stop in view when the list changes or the panel expands
    afterRenderEffect(() => {
      this.buses.details();
      if (this.collapsed()) return;
      const next = this.host.nativeElement.querySelector<HTMLElement>('.stops li.next, .stops li.here');
      next?.scrollIntoView({ block: 'nearest' });
    });
  }

  onHeaderClick(): void {
    if (this.collapsed()) this.expand.emit();
  }

  showStop(stopId: string, event: Event): void {
    event.stopPropagation();
    this.markers.selectStop(stopId);
  }

  close(event?: Event): void {
    event?.stopPropagation();
    this.buses.select(null);
  }
}
