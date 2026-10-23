import { Component, ElementRef, HostListener, inject, input, signal } from '@angular/core';
import { NgTemplateOutlet } from '@angular/common';
import {
  TravelTimeService,
  toDateInputValue,
  toTimeInputValue
} from '../../../core/services/travel-time.service';

/** How many days ahead the user can pick (timetables further out may still change). */
const MAX_DAYS_AHEAD = 60;

/**
 * Lets the user choose when they travel: "Teraz" (live data) or a specific date & time.
 * `variant="chip"` – compact button that opens a popover (map view),
 * `variant="inline"` – always-visible controls (route planner panel).
 */
@Component({
  selector: 'app-time-picker',
  standalone: true,
  imports: [NgTemplateOutlet],
  templateUrl: './time-picker.component.html',
  styleUrl: './time-picker.component.scss'
})
export class TimePickerComponent {
  readonly travelTime = inject(TravelTimeService);
  private host = inject(ElementRef<HTMLElement>);

  variant = input<'chip' | 'inline'>('inline');

  popoverOpen = signal(false);

  readonly minDate = toDateInputValue(new Date());
  readonly maxDate = toDateInputValue(new Date(Date.now() + MAX_DAYS_AHEAD * 86400000));

  dateValue(): string {
    return toDateInputValue(this.travelTime.referenceTime());
  }

  timeValue(): string {
    return toTimeInputValue(this.travelTime.referenceTime());
  }

  useNow(): void {
    this.travelTime.resetToNow();
    this.popoverOpen.set(false);
  }

  /** Switch to a chosen time, starting from now rounded up to the next 5 minutes. */
  useCustom(): void {
    if (this.travelTime.isScheduled()) return;
    const d = new Date();
    d.setSeconds(0, 0);
    d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5);
    this.travelTime.setTime(d);
  }

  /** Quick presets: today/tomorrow at a given hour. */
  usePreset(daysFromToday: number, hour: number): void {
    const d = new Date();
    d.setDate(d.getDate() + daysFromToday);
    d.setHours(hour, 0, 0, 0);
    this.travelTime.setTime(d);
  }

  onDateChange(value: string): void {
    if (!value) return;
    const [y, m, day] = value.split('-').map(Number);
    const d = new Date(this.travelTime.referenceTime());
    d.setFullYear(y, m - 1, day);
    this.travelTime.setTime(d);
  }

  onTimeChange(value: string): void {
    if (!value) return;
    const [h, min] = value.split(':').map(Number);
    const d = new Date(this.travelTime.referenceTime());
    d.setHours(h, min, 0, 0);
    this.travelTime.setTime(d);
  }

  togglePopover(): void {
    this.popoverOpen.update(v => !v);
  }

  @HostListener('document:click', ['$event'])
  onDocumentClick(event: MouseEvent): void {
    if (this.popoverOpen() && !this.host.nativeElement.contains(event.target as Node)) {
      this.popoverOpen.set(false);
    }
  }
}
