import { Injectable, computed, signal } from '@angular/core';

/**
 * Holds the date & time the user wants to travel at.
 * `null` means "now" – the app then uses live departures (with GPS estimates).
 * A set date switches popups and the route planner to the static timetable for that moment.
 */
@Injectable({
  providedIn: 'root'
})
export class TravelTimeService {
  readonly selected = signal<Date | null>(null);

  readonly isScheduled = computed(() => this.selected() !== null);

  /** Human-readable label, e.g. "Teraz" or "pon. 26.10, 07:30" */
  readonly label = computed(() => {
    const d = this.selected();
    return d ? formatTravelTime(d) : 'Teraz';
  });

  /** The moment all departure/arrival times are calculated from. */
  referenceTime(): Date {
    return this.selected() ?? new Date();
  }

  setTime(date: Date | null): void {
    this.selected.set(date);
  }

  resetToNow(): void {
    this.selected.set(null);
  }
}

/** "pon. 26.10, 07:30" */
export function formatTravelTime(d: Date): string {
  const weekday = d.toLocaleDateString('pl-PL', { weekday: 'short' });
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${weekday} ${day}.${month}, ${toTimeInputValue(d)}`;
}

/** Local date as "YYYY-MM-DD" (format used by the API and by <input type="date">). */
export function toDateInputValue(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local time as "HH:MM" (format used by <input type="time">). */
export function toTimeInputValue(d: Date): string {
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
