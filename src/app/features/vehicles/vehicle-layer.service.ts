import { Injectable, inject } from '@angular/core';
import * as L from 'leaflet';
import { GtfsService } from '../../core/services/gtfs.service';
import { escapeHtml } from '../../shared/utils/text.utils';
import { ScheduledBus } from './scheduled-buses';

/**
 * Draws the timetable-based bus positions: a badge with the line number and an arrow for the
 * direction. Markers are reused between refreshes, so they glide (CSS transition) instead of jumping.
 */
@Injectable({
  providedIn: 'root'
})
export class VehicleLayerService {
  private gtfs = inject(GtfsService);
  private readonly layer = L.layerGroup();
  private readonly markers = new Map<string, L.Marker>();
  /** What each marker's icon shows – swapped only when this changes (a new icon would stop the glide) */
  private readonly looks = new Map<string, string>();
  private stopNames: (pos: number) => string = () => '';

  constructor() {
    this.gtfs.index().subscribe(index => (this.stopNames = pos => index.stopName(pos)));
  }

  attach(map: L.Map): void {
    this.layer.addTo(map);
  }

  detach(): void {
    this.layer.remove();
    this.layer.clearLayers();
    this.markers.clear();
    this.looks.clear();
  }

  update(buses: ScheduledBus[]): void {
    const seen = new Set<string>();
    for (const bus of buses) {
      seen.add(bus.key);
      let marker = this.markers.get(bus.key);
      if (!marker) {
        marker = L.marker([bus.lat, bus.lng], { zIndexOffset: 2000, keyboard: false })
          .bindPopup('', { className: 'vehicle-popup', offset: [0, -6] })
          .addTo(this.layer);
        this.markers.set(bus.key, marker);
      } else {
        marker.setLatLng([bus.lat, bus.lng]);
      }
      const look = `${bus.line}|${bus.waiting}|${bus.bearing === null}`;
      if (this.looks.get(bus.key) !== look) {
        marker.setIcon(this.icon(bus));
        this.looks.set(bus.key, look);
      } else if (bus.bearing !== null) {
        const arrow = marker.getElement()?.querySelector<HTMLElement>('.vehicle-arrow');
        if (arrow) arrow.style.transform = `rotate(${Math.round(bus.bearing)}deg)`;
      }
      marker.setPopupContent(this.popup(bus));
    }
    for (const [key, marker] of this.markers) {
      if (seen.has(key)) continue;
      marker.remove();
      this.markers.delete(key);
      this.looks.delete(key);
    }
  }

  private icon(bus: ScheduledBus): L.DivIcon {
    const arrow = bus.bearing === null ? '' :
      `<span class="vehicle-arrow" style="transform: rotate(${Math.round(bus.bearing)}deg)"></span>`;
    return L.divIcon({
      className: 'vehicle-marker',
      html: `${arrow}<div class="vehicle-badge${bus.waiting ? ' waiting' : ''}">${escapeHtml(bus.line)}</div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
  }

  private popup(bus: ScheduledBus): string {
    const stop = escapeHtml(this.stopNames(bus.nextStop));
    const time = clock(bus.nextMinute);
    const next = bus.waiting
      ? `Czeka na odjazd z <strong>${stop}</strong> o ${time}`
      : `Następny przystanek: <strong>${stop}</strong> o ${time}`;
    return `<div class="vehicle-info">
      <div><strong>Linia ${escapeHtml(bus.line)}</strong> → ${escapeHtml(bus.headsign)}</div>
      <div>${next}</div>
      <div class="vehicle-note">Położenie według rozkładu jazdy, nie GPS – autobus może być opóźniony.</div>
    </div>`;
  }
}

/** Minutes after midnight (may be negative or pass 24 h) → "HH:MM" */
function clock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
