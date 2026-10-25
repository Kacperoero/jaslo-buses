import { Component, ElementRef, HostListener, computed, inject, input, model, output, signal } from '@angular/core';
import { FavoritesService } from '../../../core/services/favorites.service';
import { StopsService } from '../../../core/services/stops.service';
import { Stop } from '../../../shared/models/transit.models';

let nextId = 0;

/**
 * A text field for a stop with suggestions: matching stops while typing, favourite and
 * recent stops when empty. Extra buttons (pick on map, my location) go in as content.
 */
@Component({
  selector: 'app-stop-input',
  standalone: true,
  templateUrl: './stop-input.component.html',
  styleUrl: './stop-input.component.scss'
})
export class StopInputComponent {
  readonly favorites = inject(FavoritesService);
  private stops = inject(StopsService);
  private host = inject(ElementRef<HTMLElement>);

  readonly label = input.required<string>();
  readonly placeholder = input('Wpisz przystanek lub wybierz z mapy…');
  /** Text in the field (two-way) */
  readonly text = model('');
  readonly selected = output<Stop>();

  readonly inputId = `stop-input-${nextId++}`;
  readonly open = signal(false);
  readonly suggestions = computed(() =>
    this.text().trim() ? this.stops.search(this.text(), 8) : this.favorites.quickStops());

  onInput(value: string): void {
    this.text.set(value);
    this.open.set(true);
  }

  pick(stop: Stop): void {
    this.open.set(false);
    this.selected.emit(stop);
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
