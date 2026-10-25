import { Injectable, inject } from '@angular/core';
import * as L from 'leaflet';
import { GtfsIndex, GtfsService } from '../../core/services/gtfs.service';
import { ShapesService } from '../../core/services/shapes.service';
import { Stop } from '../../shared/models/transit.models';
import { escapeHtml } from '../../shared/utils/text.utils';
import { ScheduledBus } from './scheduled-buses';

const AHEAD_COLOR = '#10b981';
const PASSED_COLOR = '#94a3b8';

/**
 * Draws the timetable-based bus positions: a badge with the line number and an arrow for the
 * direction. Markers are reused between refreshes, so they glide (CSS transition) instead of jumping.
 * Clicking a bus draws its route (the part still ahead in green) with the stops it calls at, and
 * lists the stops still ahead with their times.
 */
@Injectable({
  providedIn: 'root'
})
export class VehicleLayerService {
  private gtfs = inject(GtfsService);
  private shapes = inject(ShapesService);
  private readonly routeLayer = L.layerGroup();
  private readonly layer = L.layerGroup();
  private readonly markers = new Map<string, L.Marker>();
  private readonly latest = new Map<string, ScheduledBus>();
  /** What each marker's icon shows – swapped only when this changes (a new icon would stop the glide) */
  private readonly looks = new Map<string, string>();
  /** Popup contents shown – rebuilt only when the next stop changes (keeps the list's scroll) */
  private readonly popupLooks = new Map<string, string>();
  private index: GtfsIndex | null = null;
  /** The clicked bus and the next stop its route was drawn for */
  private selected: { key: string; nextIndex: number } | null = null;

  constructor() {
    this.gtfs.index().subscribe(index => (this.index = index));
  }

  attach(map: L.Map): void {
    this.routeLayer.addTo(map);
    this.layer.addTo(map);
  }

  detach(): void {
    this.routeLayer.remove();
    this.layer.remove();
    this.routeLayer.clearLayers();
    this.layer.clearLayers();
    this.markers.clear();
    this.latest.clear();
    this.looks.clear();
    this.popupLooks.clear();
    this.selected = null;
  }

  update(buses: ScheduledBus[]): void {
    const seen = new Set<string>();
    for (const bus of buses) {
      seen.add(bus.key);
      this.latest.set(bus.key, bus);
      let marker = this.markers.get(bus.key);
      if (!marker) {
        marker = this.createMarker(bus);
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

      const popupLook = `${bus.nextIndex}|${bus.waiting}`;
      if (this.popupLooks.get(bus.key) !== popupLook) {
        marker.setPopupContent(this.popup(bus));
        this.popupLooks.set(bus.key, popupLook);
      }
      if (this.selected?.key === bus.key && this.selected.nextIndex !== bus.nextIndex) this.drawRoute(bus);
    }

    for (const [key, marker] of this.markers) {
      if (seen.has(key)) continue;
      marker.remove();
      this.markers.delete(key);
      this.latest.delete(key);
      this.looks.delete(key);
      this.popupLooks.delete(key);
      if (this.selected?.key === key) this.clearRoute();
    }
  }

  private createMarker(bus: ScheduledBus): L.Marker {
    const marker = L.marker([bus.lat, bus.lng], { zIndexOffset: 2000, keyboard: false })
      .bindPopup('', { className: 'vehicle-popup', offset: [0, -6], maxWidth: 300, autoPanPaddingTopLeft: [20, 80] })
      .addTo(this.layer);
    marker.on('popupopen', () => {
      const current = this.latest.get(bus.key);
      if (current) this.drawRoute(current);
    });
    marker.on('popupclose', () => {
      if (this.selected?.key === bus.key) this.clearRoute();
    });
    return marker;
  }

  /** The bus's whole route: the part already driven in grey, the rest in green, with its stops. */
  private drawRoute(bus: ScheduledBus): void {
    this.routeLayer.clearLayers();
    this.selected = { key: bus.key, nextIndex: bus.nextIndex };
    const index = this.index;
    if (!index) return;
    const trip = index.trips[bus.trip];
    const stops = trip.variant.stops.map(pos => stopAt(index, pos));
    // The stop it last left: the part ahead starts there (it is on its way to `nextIndex`)
    const split = Math.max(0, bus.nextIndex - 1);

    this.drawLine(stops.slice(0, split + 1), PASSED_COLOR, 4, 0.7);
    this.drawLine(stops.slice(split), AHEAD_COLOR, 6, 0.9);

    stops.forEach((stop, i) => {
      const ahead = i >= bus.nextIndex;
      L.circleMarker([stop.lat, stop.lng], ahead
        ? { radius: 5, color: AHEAD_COLOR, weight: 3, fillColor: '#fff', fillOpacity: 1 }
        : { radius: 3.5, color: '#fff', weight: 1.5, fillColor: PASSED_COLOR, fillOpacity: 1 })
        .bindTooltip(`${clock(trip.times[i] + bus.dayOffset * 1440)} ${escapeHtml(stop.name)}`, { direction: 'top' })
        .addTo(this.routeLayer);
    });
  }

  private drawLine(stops: Stop[], color: string, weight: number, opacity: number): void {
    if (stops.length < 2) return;
    for (const part of this.shapes.parts(stops)) {
      L.polyline(part.points, { color, weight, opacity, interactive: false, ...(part.known ? {} : { dashArray: '2, 12' }) })
        .addTo(this.routeLayer);
    }
  }

  private clearRoute(): void {
    this.routeLayer.clearLayers();
    this.selected = null;
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
    const index = this.index;
    if (!index) return '';
    const trip = index.trips[bus.trip];
    const stops = trip.variant.stops;
    const rows = stops.slice(bus.nextIndex).map((pos, k) => {
      const i = bus.nextIndex + k;
      return `<li${k === 0 ? ' class="next"' : ''}><span class="time">${clock(trip.times[i] + bus.dayOffset * 1440)}</span>` +
        `<span>${escapeHtml(index.stopName(pos))}</span></li>`;
    }).join('');
    const status = bus.waiting ? 'Czeka na odjazd' : 'Następne przystanki';
    const passed = bus.nextIndex > 0 ? ` <span class="passed">(minął ${bus.nextIndex} z ${stops.length})</span>` : '';
    return `<div class="vehicle-info">
      <div><strong>Linia ${escapeHtml(bus.line)}</strong> → ${escapeHtml(bus.headsign)}</div>
      <div class="vehicle-status">${status}${passed}</div>
      <ol class="vehicle-stops">${rows}</ol>
      <div class="vehicle-note">Położenie według rozkładu jazdy, nie GPS – autobus może być opóźniony.</div>
    </div>`;
  }
}

function stopAt(index: GtfsIndex, pos: number): Stop {
  const [id, name, lat, lng] = index.stops[pos];
  return { id, name, lat, lng, designator: pos + 1, onlyDisembarking: false };
}

/** Minutes after midnight (may be negative or pass 24 h) → "HH:MM" */
function clock(minutes: number): string {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}
