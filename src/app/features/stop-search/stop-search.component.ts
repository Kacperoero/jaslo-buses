import { Component, ElementRef, HostListener, computed, inject, output, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import { FavoritesService } from '../../core/services/favorites.service';
import { StopsService } from '../../core/services/stops.service';
import { Stop } from '../../shared/models/transit.models';
import { TimePickerComponent } from '../../shared/components/time-picker/time-picker.component';

/**
 * Stop search box in the map view (top left). With an empty query it lists favourite and
 * recently viewed stops. Picking a stop emits `stopSelected` – the map flies there.
 */
@Component({
  selector: 'app-stop-search',
  standalone: true,
  imports: [NgTemplateOutlet, TimePickerComponent],
  templateUrl: './stop-search.component.html',
  styleUrl: './stop-search.component.scss'
})
export class StopSearchComponent {
  readonly favorites = inject(FavoritesService);
  private stops = inject(StopsService);
  private host = inject(ElementRef<HTMLElement>);

  readonly stopSelected = output<Stop>();

  readonly query = signal('');
  readonly open = signal(false);
  readonly hasQuery = computed(() => this.query().trim().length > 0);
  readonly results = computed(() => this.stops.search(this.query(), 20));

  onInput(value: string): void {
    this.query.set(value);
    this.open.set(true);
  }

  clear(): void {
    this.query.set('');
    this.open.set(false);
  }

  select(stop: Stop): void {
    this.open.set(false);
    this.query.set(stop.name);
    this.stopSelected.emit(stop);
  }

  /** Star / unstar a stop from the list without selecting it. */
  toggleFavorite(stop: Stop, event: Event): void {
    event.stopPropagation();
    this.favorites.toggleFavorite(stop.id);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.open() && !this.host.nativeElement.contains(event.target as Node)) this.open.set(false);
  }

  @HostListener('document:keydown.escape')
  onEscape(): void {
    this.open.set(false);
  }
}
