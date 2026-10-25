import { Injectable, effect, inject, signal } from '@angular/core';
import * as L from 'leaflet';
import { FavoritesService } from '../../../core/services/favorites.service';
import { StopsService } from '../../../core/services/stops.service';
import { Stop } from '../../../shared/models/transit.models';

/**
 * Stop markers on the map. Clicking one selects the stop: its departures are shown in the side
 * panel (StopPanelComponent), and the stop editor (?dev) follows the selection.
 */
@Injectable({
  providedIn: 'root'
})
export class MapMarkerService {
  private markers: L.Marker[] = [];
  private markerById = new Map<string, L.Marker>();
  private map: L.Map | null = null;

  private readonly stopIcon = L.divIcon({
    className: 'bus-stop-marker',
    html: `<div class="marker-dot"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
  private readonly favoriteIcon = L.divIcon({
    className: 'bus-stop-marker favorite',
    html: `<div class="marker-dot"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  private favorites = inject(FavoritesService);
  private stops = inject(StopsService);
  private readonly highlightLayer = L.layerGroup();

  /** The clicked stop (shown in the side panel; the stop editor follows it) */
  readonly selectedStopId = signal<string | null>(null);

  constructor() {
    effect(() => {
      const id = this.selectedStopId();
      this.highlight(id ? this.stops.byId().get(id) ?? null : null);
    });

    // Favourite stops get a different marker – also when starred from the search list
    let shown = new Set<string>();
    effect(() => {
      const now = new Set(this.favorites.favoriteStopIds());
      for (const id of new Set([...shown, ...now])) {
        if (shown.has(id) === now.has(id)) continue;
        this.markerById.get(id)?.setIcon(this.iconFor(id)).setZIndexOffset(now.has(id) ? 500 : 0);
      }
      shown = now;
    });
  }

  private iconFor(stopId: string): L.DivIcon {
    return this.favorites.isFavorite(stopId) ? this.favoriteIcon : this.stopIcon;
  }

  /** Draws a marker for every stop; clicking one selects it. */
  renderStops(map: L.Map, stops: Stop[]): void {
    this.map = map;
    this.clearMarkers();

    for (const stop of stops) {
      const marker = L.marker([stop.lat, stop.lng], {
        icon: this.iconFor(stop.id),
        // Favourites drawn above other stops
        zIndexOffset: this.favorites.isFavorite(stop.id) ? 500 : 0,
        title: stop.name
      });

      marker.on('click', () => this.onStopClick(stop));

      marker.addTo(map);
      this.markers.push(marker);
      this.markerById.set(stop.id, marker);
    }
  }

  /** Shows a stop's departures (as if its marker was clicked). */
  openStop(stopId: string): void {
    const marker = this.markerById.get(stopId);
    if (marker && this.map) marker.fire('click');
  }

  selectStop(stopId: string | null): void {
    this.selectedStopId.set(stopId);
  }

  private clearMarkers(): void {
    this.markers.forEach(m => m.remove());
    this.markers = [];
    this.markerById.clear();
  }

  private onStopClick(stop: Stop): void {
    this.favorites.addRecentStop(stop.id);
    this.selectedStopId.set(stop.id);
  }

  /** Ring around the selected stop */
  private highlight(stop: Stop | null): void {
    this.highlightLayer.clearLayers();
    if (!stop || !this.map) return;
    this.highlightLayer.addTo(this.map);
    L.circleMarker([stop.lat, stop.lng], { radius: 13, color: '#2563eb', weight: 3, fill: false, interactive: false })
      .addTo(this.highlightLayer);
  }
}
