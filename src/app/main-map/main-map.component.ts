import { Component, OnInit, OnDestroy, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as L from 'leaflet';
import { MapMarkerService } from '../features/map/services/map-marker.service';
import { Departure, Stop } from '../shared/models/transit.models';
import { escapeHtml } from '../shared/utils/text.utils';
import { getNearestStops } from '../shared/utils/geo.utils';
import { TravelTimeService } from '../core/services/travel-time.service';
import { FavoritesService, RecentRoute } from '../core/services/favorites.service';
import { GtfsService } from '../core/services/gtfs.service';
import { TimePickerComponent } from '../shared/components/time-picker/time-picker.component';
import { RoutePlannerService } from '../features/route-planner/route-planner.service';
import { stopsBetween } from '../features/route-planner/ride-path';
import { TimetableService } from '../core/services/timetable.service';
import { firstValueFrom } from 'rxjs';
import { Connection, ConnectionPoint } from '../features/route-planner/route-planner.models';

@Component({
  selector: 'app-main-map',
  standalone: true,
  imports: [CommonModule, FormsModule, TimePickerComponent],
  templateUrl: './main-map.component.html',
  styleUrl: './main-map.component.scss'
})
export class MainMapComponent implements OnInit, OnDestroy {
  private map!: L.Map;

  // Layer groups for route planning to easily clear/redraw
  private routeLayerGroup = L.layerGroup();
  private userPointsLayerGroup = L.layerGroup();


  /** Incremented per search, so a slow search can't overwrite results of a newer one */
  private searchCounter = 0;

  /** All loaded stops */
  allStops = signal<Stop[]>([]);

  /** Search query for single stop view */
  searchQuery = signal('');
  searchOpen = signal(false);

  /** Route Planner Panel state */
  routePlannerOpen = signal(false);
  
  // Start point selection
  startPoint = signal<ConnectionPoint | null>(null);
  searchQueryStart = signal('');
  startSuggestionsOpen = signal(false);

  // End point selection
  endPoint = signal<ConnectionPoint | null>(null);
  searchQueryEnd = signal('');
  endSuggestionsOpen = signal(false);

  // Active picking modes
  isPickingStart = signal(false);
  isPickingEnd = signal(false);

  // Connection search results
  searchingConnections = signal(false);
  connections = signal<Connection[]>([]);
  selectedConnectionIndex = signal<number | null>(null);

  /** Filtered stops for single search */
  filteredStops = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return [];
    return this.allStops()
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 20);
  });

  /** Filtered stops for start input */
  filteredStopsStart = computed(() => {
    const q = this.searchQueryStart().toLowerCase().trim();
    if (!q) return [];
    return this.allStops()
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 8);
  });

  /** Filtered stops for end input */
  /** Stops by id, for the favourite and recent lists */
  private stopById = computed(() => new Map(this.allStops().map(s => [s.id, s])));

  /** Favourite stops (in the order they were added) */
  favoriteStops = computed(() => this.favorites.favoriteStopIds()
    .map(id => this.stopById().get(id))
    .filter((s): s is Stop => !!s));

  /** Recently viewed stops that are not favourites already */
  recentStops = computed(() => this.favorites.recentStopIds()
    .filter(id => !this.favorites.isFavorite(id))
    .map(id => this.stopById().get(id))
    .filter((s): s is Stop => !!s));

  /** Planner fields: matching stops while typing, favourites and recent stops when empty */
  startSuggestions = computed(() => this.searchQueryStart().trim() ? this.filteredStopsStart() : this.quickStops());
  endSuggestions = computed(() => this.searchQueryEnd().trim() ? this.filteredStopsEnd() : this.quickStops());
  private quickStops = computed(() => [...this.favoriteStops(), ...this.recentStops()].slice(0, 8));

  /** True once a search finished for the current points & time (for the "nothing found" message) */
  searchDone = signal(false);

  filteredStopsEnd = computed(() => {
    const q = this.searchQueryEnd().toLowerCase().trim();
    if (!q) return [];
    return this.allStops()
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 8);
  });

  /** Whether the app is loading stops initially */
  loading = signal(true);

  constructor(
    private mapMarkerService: MapMarkerService,
    private routePlanner: RoutePlannerService,
    readonly travelTime: TravelTimeService,
    readonly favorites: FavoritesService,
    private gtfs: GtfsService,
    private timetable: TimetableService
  ) {
    // Start loading the timetable right away, so the first popup / search doesn't wait
    this.gtfs.index().subscribe({ error: err => console.error('Failed to load the timetable', err) });

    // Results are calculated for a specific moment – drop them when the user changes the time
    effect(() => {
      this.travelTime.selected();
      this.clearResults();
    });
  }

  /** Drop found connections (and cancel a running search) after the points or time change. */
  private clearResults(): void {
    this.searchCounter++;
    this.searchingConnections.set(false);
    this.searchDone.set(false);
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();
  }

  ngOnInit(): void {
    this.initMap();
  }

  ngOnDestroy(): void {
    if (this.map) {
      this.map.remove();
    }
  }

  private initMap(): void {
    // Fix Leaflet default icon paths
    delete (L.Icon.Default.prototype as any)._getIconUrl;
    L.Icon.Default.mergeOptions({
      iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
      iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
      shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png'
    });

    this.map = L.map('map', {
      center: [49.745, 21.472],
      zoom: 14,
      zoomControl: false
    });

    // Add layer groups to map
    this.routeLayerGroup.addTo(this.map);
    this.userPointsLayerGroup.addTo(this.map);

    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(this.map);

    // Click handler for picking points on map
    this.map.on('click', (e: L.LeafletMouseEvent) => {
      this.handleMapClick(e);
    });

    // Load and render stops
    this.mapMarkerService.renderStops(this.map).then((stops) => {
      this.allStops.set(stops);
      this.loading.set(false);
    });
  }

  // ─── Single Search Box Handlers ────────────────────────
  onSearchInput(event: Event): void {
    const value = (event.target as HTMLInputElement).value;
    this.searchQuery.set(value);
    if (value.trim()) {
      this.searchOpen.set(true);
    }
  }

  /** Opens the list – with an empty query it shows favourite and recent stops. */
  onSearchFocus(): void {
    this.searchOpen.set(true);
  }

  /** Star / unstar a stop from a list without selecting it. */
  toggleFavorite(stop: Stop, event: Event): void {
    event.stopPropagation();
    this.favorites.toggleFavorite(stop.id);
  }

  clearSearch(): void {
    this.searchQuery.set('');
    this.searchOpen.set(false);
  }

  selectStop(stop: Stop): void {
    this.searchOpen.set(false);
    this.searchQuery.set(stop.name);
    this.map.flyTo([stop.lat, stop.lng], 17, { duration: 1 });

    setTimeout(() => {
      this.map.eachLayer((layer: any) => {
        if (layer instanceof L.Marker) {
          const pos = layer.getLatLng();
          if (Math.abs(pos.lat - stop.lat) < 0.00001 && Math.abs(pos.lng - stop.lng) < 0.00001) {
            layer.fire('click');
          }
        }
      });
    }, 1100);
  }

  locateUser(): void {
    this.map.locate({ setView: true, maxZoom: 16 });
  }

  // ─── Route Planner State Handlers ───────────────────────
  toggleRoutePlanner(): void {
    const current = this.routePlannerOpen();
    this.routePlannerOpen.set(!current);
    if (current) {
      this.clearAllRoutes();
    } else {
      this.searchOpen.set(false);
    }
  }

  // Pick Mode handlers
  startPickingStart(): void {
    this.isPickingStart.set(true);
    this.isPickingEnd.set(false);
  }

  startPickingEnd(): void {
    this.isPickingEnd.set(true);
    this.isPickingStart.set(false);
  }

  private handleMapClick(e: L.LeafletMouseEvent): void {
    // Clicking the map closes open lists
    this.searchOpen.set(false);
    this.startSuggestionsOpen.set(false);
    this.endSuggestionsOpen.set(false);

    if (this.isPickingStart()) {
      this.setPointFromCoords(e.latlng.lat, e.latlng.lng, 'start');
      this.isPickingStart.set(false);
    } else if (this.isPickingEnd()) {
      this.setPointFromCoords(e.latlng.lat, e.latlng.lng, 'end');
      this.isPickingEnd.set(false);
    }
  }

  // Locate shortcuts for inputs
  async useMyLocationForStart(): Promise<void> {
    this.map.locate({ setView: false });
    this.map.once('locationfound', (e: L.LocationEvent) => {
      this.setPointFromCoords(e.latlng.lat, e.latlng.lng, 'start', 'Moja lokalizacja', true);
    });
  }

  private setPointFromCoords(
    lat: number, lng: number, type: 'start' | 'end', customName?: string, isUserLocation = false
  ): void {
    // Find nearest stop for name, or use coords
    const nearest = getNearestStops(this.allStops(), lat, lng, 1)[0];
    const name = customName || (nearest && nearest.distance < 100 
      ? `Blisko: ${nearest.stop.name}` 
      : `Punkt na mapie (${lat.toFixed(4)}, ${lng.toFixed(4)})`);

    const point: ConnectionPoint = isUserLocation ? { lat, lng, name, isUserLocation } : { lat, lng, name };

    if (type === 'start') {
      this.startPoint.set(point);
      this.searchQueryStart.set(name);
    } else {
      this.endPoint.set(point);
      this.searchQueryEnd.set(name);
    }

    this.clearResults();

    this.updateUserPointMarkers();
  }

  selectStartStop(stop: Stop): void {
    this.startPoint.set({ lat: stop.lat, lng: stop.lng, name: stop.name, isStop: true, stopId: stop.id });
    this.searchQueryStart.set(stop.name);
    this.startSuggestionsOpen.set(false);

    this.clearResults();

    this.updateUserPointMarkers();
  }

  selectEndStop(stop: Stop): void {
    this.endPoint.set({ lat: stop.lat, lng: stop.lng, name: stop.name, isStop: true, stopId: stop.id });
    this.searchQueryEnd.set(stop.name);
    this.endSuggestionsOpen.set(false);

    this.clearResults();

    this.updateUserPointMarkers();
  }

  swapPoints(): void {
    const s = this.startPoint();
    const e = this.endPoint();
    this.startPoint.set(e);
    this.endPoint.set(s);
    this.searchQueryStart.set(e ? e.name : '');
    this.searchQueryEnd.set(s ? s.name : '');

    this.clearResults();

    this.updateUserPointMarkers();
  }

  async findConnection(): Promise<void> {
    const start = this.startPoint();
    const end = this.endPoint();
    if (!start || !end) return;

    if (!start.isUserLocation && !end.isUserLocation) {
      this.favorites.addRecentRoute(start, end);
    }

    const searchId = ++this.searchCounter;
    this.searchingConnections.set(true);
    this.searchDone.set(false);
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();

    try {
      const found = await this.routePlanner.findConnections(start, end, this.allStops());
      if (searchId !== this.searchCounter) return; // points or time changed meanwhile

      this.connections.set(found);
      this.searchDone.set(true);
      if (found.length > 0) {
        this.selectConnection(0);
      }
    } catch (err) {
      console.error('Global routing search error:', err);
    } finally {
      if (searchId === this.searchCounter) this.searchingConnections.set(false);
    }
  }

  /** Fills A and B from a recent route and searches again. */
  useRecentRoute(route: RecentRoute): void {
    this.startPoint.set({ ...route.from });
    this.endPoint.set({ ...route.to });
    this.searchQueryStart.set(route.from.name);
    this.searchQueryEnd.set(route.to.name);
    this.startSuggestionsOpen.set(false);
    this.endSuggestionsOpen.set(false);
    this.clearResults();
    this.updateUserPointMarkers();
    this.findConnection();
  }

  removeRecentRoute(route: RecentRoute, event: Event): void {
    event.stopPropagation();
    this.favorites.removeRecentRoute(route);
  }

  /** Incremented per drawn route, so a slower earlier draw can't overwrite a newer one */
  private drawCounter = 0;

  /**
   * Draws the selected connection: walks as dashed straight lines, bus rides along the stops
   * the bus actually passes (from the timetable), with small dots at intermediate stops.
   * No external routing service is used.
   */
  async selectConnection(index: number): Promise<void> {
    this.selectedConnectionIndex.set(index);
    this.routeLayerGroup.clearLayers();
    const drawId = ++this.drawCounter;

    const conn = this.connections()[index];
    const start = this.startPoint();
    const end = this.endPoint();
    if (!conn || !start || !end) return;

    const rides: { dep: Departure | null; from: Stop; to: Stop; line: string; color: string; label: string }[] =
      conn.isTransfer && conn.legs?.length === 2
        ? [
            { dep: conn.legs[0].nextDeparture, from: conn.startStop, to: conn.transferStop!, line: conn.legs[0].line, color: '#10b981', label: ' (etap 1)' },
            { dep: conn.legs[1].nextDeparture, from: conn.transferStop!, to: conn.endStop, line: conn.legs[1].line, color: '#06b6d4', label: ' (etap 2)' }
          ]
        : [{ dep: conn.nextDeparture, from: conn.startStop, to: conn.endStop, line: conn.line, color: '#10b981', label: '' }];

    const paths = await Promise.all(rides.map(r => this.ridePath(r.dep, r.from, r.to)));
    if (drawId !== this.drawCounter) return; // another connection was selected meanwhile

    const all: L.LatLng[] = [];
    const walk = (a: L.LatLngExpression, b: L.LatLngExpression, label: string) => {
      const line = L.polyline([a, b], { color: '#f43f5e', weight: 5, dashArray: '5, 10', opacity: 0.85 })
        .bindPopup(`🚶‍♂️ ${label}`);
      line.addTo(this.routeLayerGroup);
      all.push(...line.getLatLngs() as L.LatLng[]);
    };

    walk([start.lat, start.lng], [conn.startStop.lat, conn.startStop.lng], 'Dojście do przystanku');
    rides.forEach((ride, i) => {
      const path = paths[i];
      L.polyline(path.map(s => [s.lat, s.lng] as L.LatLngTuple), { color: ride.color, weight: 7, opacity: 0.95 })
        .bindPopup(`🚌 Linia ${escapeHtml(ride.line)}${ride.label}`)
        .addTo(this.routeLayerGroup);
      for (const stop of path.slice(1, -1)) {
        L.circleMarker([stop.lat, stop.lng], { radius: 3.5, color: '#fff', weight: 1.5, fillColor: ride.color, fillOpacity: 1 })
          .bindTooltip(escapeHtml(stop.name))
          .addTo(this.routeLayerGroup);
      }
      all.push(...path.map(s => L.latLng(s.lat, s.lng)));
    });
    walk([conn.endStop.lat, conn.endStop.lng], [end.lat, end.lng], 'Dojście do celu');

    // Start, transfer and end stop markers on top
    this.plannedStopMarker(conn.startStop, 'planned-start', 'Przystanek początkowy').addTo(this.routeLayerGroup);
    if (conn.isTransfer && conn.transferStop) {
      this.plannedStopMarker(conn.transferStop, 'planned-transfer', 'Punkt przesiadkowy').addTo(this.routeLayerGroup);
    }
    this.plannedStopMarker(conn.endStop, 'planned-end', 'Przystanek końcowy').addTo(this.routeLayerGroup);

    this.map.fitBounds(L.latLngBounds(all), { padding: [40, 40] });
  }

  /** Stops the bus passes from `from` to `to` on this departure's trip (straight line if unknown). */
  private async ridePath(dep: Departure | null, from: Stop, to: Stop): Promise<Stop[]> {
    if (dep?.trip_execution_id) {
      try {
        const exec = await firstValueFrom(this.timetable.getTripExecution(dep.trip_execution_id));
        const stops = stopsBetween(exec.trip.times, dep.trip_index ?? 0, from.id, to.id)
          .map(id => this.stopById().get(id))
          .filter((s): s is Stop => !!s);
        if (stops.length >= 2) return stops;
      } catch {
        // fall through to a straight line
      }
    }
    return [from, to];
  }

  private plannedStopMarker(stop: Stop, cssClass: string, label: string): L.Marker {
    return L.marker([stop.lat, stop.lng], {
      icon: L.divIcon({
        className: 'bus-stop-marker planned',
        html: `<div class="marker-dot ${cssClass}"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      })
    }).bindPopup(`<b>${label}:</b><br>${escapeHtml(stop.name)}`);
  }

  // ─── Rendering Helpers ─────────────────────────────────
  private updateUserPointMarkers(): void {
    this.userPointsLayerGroup.clearLayers();
    
    const start = this.startPoint();
    const end = this.endPoint();

    if (start) {
      const greenIcon = L.divIcon({
        className: 'user-point-marker start',
        html: `<div class="pulse-ring"></div><div class="marker-pin start-pin"><span class="pin-text">A</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      L.marker([start.lat, start.lng], { icon: greenIcon })
        .bindPopup(`<b>Punkt startowy:</b><br>${escapeHtml(start.name)}`)
        .addTo(this.userPointsLayerGroup);
    }

    if (end) {
      const redIcon = L.divIcon({
        className: 'user-point-marker end',
        html: `<div class="pulse-ring"></div><div class="marker-pin end-pin"><span class="pin-text">B</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      });
      L.marker([end.lat, end.lng], { icon: redIcon })
        .bindPopup(`<b>Punkt docelowy:</b><br>${escapeHtml(end.name)}`)
        .addTo(this.userPointsLayerGroup);
    }
  }

  clearAllRoutes(): void {
    this.startPoint.set(null);
    this.endPoint.set(null);
    this.searchQueryStart.set('');
    this.searchQueryEnd.set('');
    this.clearResults();
    this.userPointsLayerGroup.clearLayers();
  }
}
