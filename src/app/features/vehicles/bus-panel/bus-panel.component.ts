import { Component, HostListener, inject } from '@angular/core';
import { ScheduledBusesService } from '../scheduled-buses.service';

/** Side panel (right) with the clicked bus: line, direction and the stops still ahead. */
@Component({
  selector: 'app-bus-panel',
  standalone: true,
  templateUrl: './bus-panel.component.html',
  styleUrl: './bus-panel.component.scss'
})
export class BusPanelComponent {
  readonly buses = inject(ScheduledBusesService);

  close(): void {
    this.buses.select(null);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.close();
  }
}
