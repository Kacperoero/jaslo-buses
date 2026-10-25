import { Injectable, inject } from '@angular/core';
import * as L from 'leaflet';
import { GtfsIndex, GtfsService } from '../../core/services/gtfs.service';
import { ShapesService } from '../../core/services/shapes.service';
import { Stop } from '../../shared/models/transit.models';
import { escapeHtml } from '../../shared/utils/text.utils';
import { ScheduledBus, TripState, clock } from './scheduled-buses';

const AHEAD_COLOR = '#10b981';
const PASSED_COLOR = '#94a3b8';

/**
 * Draws the timetable-based bus positions: a badge with the line number and an arrow for the
 * direction. Markers are reused between refreshes, so they glide (CSS transition) instead of jumping.
 * The selected (clicked) bus gets its route drawn – the part still ahead in green – with the
 * stops it calls at; its details are in the side panel (BusPanelComponent).
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
  /** What each marker's icon shows – swapped only when this changes (a new icon would stop the glide) */
  private readonly looks = new Map<string, string>();
  private index: GtfsIndex | null = null;
  /** The clicked bus and the next stop its route was drawn for */
  private selected: { key: string; nextIndex: number } | null = null;

  constructor() {
    this.gtfs.index().subscribe({ next: index => (this.index = index), error: () => {} });
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
    this.looks.clear();
    this.selected = null;
  }

  /** Called with the key of a clicked bus */
  onSelect: (key: string) => void = () => {};

  /**
   * Moves the buses and draws the selected trip's route. The selected trip's bus is shown also
   * when it isn't among `buses` (the layer is off).
   */
  update(buses: ScheduledBus[], selectedTrip: TripState | null): void {
    const seen = new Set<string>();
    const selectedKey = selectedTrip?.key ?? null;
    const all = selectedTrip?.bus && !buses.some(b => b.key === selectedKey) ? [...buses, selectedTrip.bus] : buses;
    for (const bus of all) {
      seen.add(bus.key);
      let marker = this.markers.get(bus.key);
      if (!marker) {
        marker = L.marker([bus.lat, bus.lng], { zIndexOffset: 2000, keyboard: false })
          .on('click', () => this.onSelect(bus.key))
          .addTo(this.layer);
        this.markers.set(bus.key, marker);
      } else {
        marker.setLatLng([bus.lat, bus.lng]);
      }

      const isSelected = bus.key === selectedKey;
      const look = `${bus.line}|${bus.waiting}|${bus.bearing === null}|${isSelected}`;
      if (this.looks.get(bus.key) !== look) {
        marker.setIcon(this.icon(bus, isSelected)).setZIndexOffset(isSelected ? 3000 : 2000);
        this.looks.set(bus.key, look);
      } else if (bus.bearing !== null) {
        const arrow = marker.getElement()?.querySelector<HTMLElement>('.vehicle-arrow');
        if (arrow) arrow.style.transform = `rotate(${Math.round(bus.bearing)}deg)`;
      }
    }

    for (const [key, marker] of this.markers) {
      if (seen.has(key)) continue;
      marker.remove();
      this.markers.delete(key);
      this.looks.delete(key);
    }

    if (!selectedTrip) this.clearRoute();
    else if (this.selected?.key !== selectedTrip.key || this.selected.nextIndex !== selectedTrip.nextIndex) this.drawRoute(selectedTrip);
  }

  /** The trip's whole route: the part already driven in grey, the rest in green, with its stops. */
  private drawRoute(bus: TripState): void {
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

  private icon(bus: ScheduledBus, selected: boolean): L.DivIcon {
    const arrow = bus.bearing === null ? '' :
      `<span class="vehicle-arrow" style="transform: rotate(${Math.round(bus.bearing)}deg)"></span>`;
    return L.divIcon({
      className: 'vehicle-marker',
      html: `${arrow}<div class="vehicle-badge${bus.waiting ? ' waiting' : ''}${selected ? ' selected' : ''}">${escapeHtml(bus.line)}</div>`,
      iconSize: [40, 40],
      iconAnchor: [20, 20]
    });
  }
}

function stopAt(index: GtfsIndex, pos: number): Stop {
  const [id, name, lat, lng] = index.stops[pos];
  return { id, name, lat, lng, designator: pos + 1, onlyDisembarking: false };
}
