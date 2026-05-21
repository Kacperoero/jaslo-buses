import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as L from 'leaflet';
import { MapMarkerService } from '../features/map/services/map-marker.service';
import { TimetableService } from '../core/services/timetable.service';
import { Stop, Departure, TripExecutionResponse, StopDirection } from '../shared/models/transit.models';
import { firstValueFrom } from 'rxjs';

interface ConnectionPoint {
  lat: number;
  lng: number;
  name: string;
  isStop?: boolean;
  stopId?: string;
}

interface Connection {
  startStop: Stop;
  endStop: Stop;
  line: string;
  nextDeparture: Departure | null;
  walkTimeStart: number; // minutes
  walkTimeEnd: number;   // minutes
  busTime: number;        // minutes
  totalTime: number;      // minutes
  polylineLayers: L.Polyline[];
  startMarker: L.Marker;
  endMarker: L.Marker;
  departureTimeAbs?: string;
  arrivalTimeAbs?: string;
  waitingTimeAtStop?: number;
}

@Component({
  selector: 'app-main-map',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './main-map.component.html',
  styleUrl: './main-map.component.scss'
})
export class MainMapComponent implements OnInit, OnDestroy {
  private map!: L.Map;

  // Layer groups for route planning to easily clear/redraw
  private routeLayerGroup = L.layerGroup();
  private userPointsLayerGroup = L.layerGroup();

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
    private timetableService: TimetableService
  ) {}

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

  onSearchFocus(): void {
    if (this.searchQuery().trim()) {
      this.searchOpen.set(true);
    }
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
      this.setPointFromCoords(e.latlng.lat, e.latlng.lng, 'start', 'Moja lokalizacja');
    });
  }

  private setPointFromCoords(lat: number, lng: number, type: 'start' | 'end', customName?: string): void {
    // Find nearest stop for name, or use coords
    const nearest = this.getNearestStops(lat, lng, 1)[0];
    const name = customName || (nearest && nearest.distance < 100 
      ? `Blisko: ${nearest.stop.name}` 
      : `Punkt na mapie (${lat.toFixed(4)}, ${lng.toFixed(4)})`);

    const point: ConnectionPoint = { lat, lng, name };

    if (type === 'start') {
      this.startPoint.set(point);
      this.searchQueryStart.set(name);
    } else {
      this.endPoint.set(point);
      this.searchQueryEnd.set(name);
    }

    // Clear old route when points change
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();

    this.updateUserPointMarkers();
  }

  selectStartStop(stop: Stop): void {
    this.startPoint.set({ lat: stop.lat, lng: stop.lng, name: stop.name, isStop: true, stopId: stop.id });
    this.searchQueryStart.set(stop.name);
    this.startSuggestionsOpen.set(false);

    // Clear old route when points change
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();

    this.updateUserPointMarkers();
  }

  selectEndStop(stop: Stop): void {
    this.endPoint.set({ lat: stop.lat, lng: stop.lng, name: stop.name, isStop: true, stopId: stop.id });
    this.searchQueryEnd.set(stop.name);
    this.endSuggestionsOpen.set(false);

    // Clear old route when points change
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();

    this.updateUserPointMarkers();
  }

  swapPoints(): void {
    const s = this.startPoint();
    const e = this.endPoint();
    this.startPoint.set(e);
    this.endPoint.set(s);
    this.searchQueryStart.set(e ? e.name : '');
    this.searchQueryEnd.set(s ? s.name : '');

    // Clear old route when points change
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();

    this.updateUserPointMarkers();
  }

  async findConnection(): Promise<void> {
    const start = this.startPoint();
    const end = this.endPoint();
    if (!start || !end) return;

    this.searchingConnections.set(true);
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();

    // 1. Resolve candidates, prioritizing explicitly selected stops, otherwise top 10 nearest
    let startCandidates: { stop: Stop, distance: number }[] = [];
    if (start.isStop && start.stopId) {
      const stopObj = this.allStops().find(s => s.id === start.stopId);
      if (stopObj) {
        startCandidates = [{ stop: stopObj, distance: 0 }];
      }
    }
    if (startCandidates.length === 0) {
      startCandidates = this.getNearestStops(start.lat, start.lng, 10);
    }

    let endCandidates: { stop: Stop, distance: number }[] = [];
    if (end.isStop && end.stopId) {
      const stopObj = this.allStops().find(s => s.id === end.stopId);
      if (stopObj) {
        endCandidates = [{ stop: stopObj, distance: 0 }];
      }
    }
    if (endCandidates.length === 0) {
      endCandidates = this.getNearestStops(end.lat, end.lng, 10);
    }

    if (startCandidates.length === 0 || endCandidates.length === 0) {
      this.searchingConnections.set(false);
      return;
    }

    const foundConnections: Connection[] = [];
    let foundPair = false;

    // Loop through candidates up to 10th stop to find the closest pair sharing a line and yielding valid connections
    for (const sCand of startCandidates) {
      for (const eCand of endCandidates) {
        if (sCand.stop.id === eCand.stop.id) continue;

        try {
          const sDirs = await firstValueFrom(this.timetableService.getDirectionsForStop(sCand.stop.id));
          const eDirs = await firstValueFrom(this.timetableService.getDirectionsForStop(eCand.stop.id));

          const sLines = sDirs.map(d => d.line);
          const eLines = eDirs.map(d => d.line);
          const shared = sLines.filter(line => eLines.includes(line));

          if (shared.length > 0) {
            // Fetch live departures for the candidate start stop
            const departuresRes = await firstValueFrom(this.timetableService.getDeparturesForStop(sCand.stop.id));
            const liveRows = departuresRes.rows || [];
            const directionsMap = departuresRes.directions || {};

            let pairHasValidConnection = false;

            for (const line of shared) {
              // Get all departures matching this line
              const lineDepartures = liveRows.filter(r => (r.line_name || r.line) === line);

              // Baseline check: Filter departures heading in the correct direction geographically
              const correctDirectionDepartures = lineDepartures.filter(r => {
                if (!r.direction_id) return true; // fallback
                const depDest = directionsMap[r.direction_id];
                if (!depDest) return true; // fallback

                // Check if this direction serves the end stop
                const isSharedDirection = eDirs.some(ed => ed.line === line && ed.direction === depDest);
                if (!isSharedDirection) return false;

                // Check if end stop is closer to destination than start stop
                return this.isEndStopAfterStartStopGeographically(sCand.stop, eCand.stop, depDest);
              });

              let nextDep: Departure | null = null;
              let isConnectionValid = false;
              let departureTimeAbs = '';
              let arrivalTimeAbs = '';
              let waitingTimeAtStop = 0;
              let minutesToDeparture = 0;
              let actualBusTime = 0;

              if (correctDirectionDepartures.length > 0) {
                // We have active departures in the correct direction. Let's take the first one
                const candidateDep = correctDirectionDepartures[0];
                minutesToDeparture = this.parseDepartureTimeToMinutes(candidateDep.time);

                if (candidateDep.trip_execution_id) {
                  try {
                    // Try real-time trip execution stop sequence check
                    const tripExec = await firstValueFrom(
                      this.timetableService.getTripExecution(candidateDep.trip_execution_id)
                    );
                    const times = tripExec?.trip?.times || [];
                    const startIndex = times.findIndex(t => t.place_id === sCand.stop.id);
                    const endIndex = times.findIndex(t => t.place_id === eCand.stop.id);

                    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
                      nextDep = candidateDep;
                      isConnectionValid = true;

                      // Parse the scheduled times to get precise travel duration
                      const schedStartStr = times[startIndex].departure_time;
                      const schedEndStr = times[endIndex].departure_time;
                      
                      let schedDuration = this.parseTimeToMinutesOfDay(schedEndStr) - this.parseTimeToMinutesOfDay(schedStartStr);
                      if (schedDuration < 0) schedDuration += 1440;
                      
                      actualBusTime = schedDuration;
                    } else {
                      // Discard this departure because the sequence is incorrect
                      nextDep = null;
                      isConnectionValid = false;
                    }
                  } catch (err) {
                    console.error('Failed real-time stop sequence check, falling back to geographic baseline', err);
                    nextDep = candidateDep;
                    isConnectionValid = true; // fallback to geographic which passed
                  }
                } else {
                  // No trip execution ID, fallback to geographic check which passed
                  nextDep = candidateDep;
                  isConnectionValid = true;
                }

                if (isConnectionValid) {
                  // Calculate absolute times
                  departureTimeAbs = this.getAbsoluteTimeString(minutesToDeparture);
                  
                  if (actualBusTime === 0) {
                    // Fallback to straight distance calculation (~400m/min bus speed)
                    const stopDist = this.getDistance(sCand.stop.lat, sCand.stop.lng, eCand.stop.lat, eCand.stop.lng);
                    actualBusTime = Math.max(2, Math.round(stopDist / 400));
                  }

                  arrivalTimeAbs = this.getAbsoluteTimeString(minutesToDeparture + actualBusTime);
                  
                  // Calculate walking time to start stop
                  const walkTimeStart = Math.round(sCand.distance / 80); // 80m/min walking speed
                  waitingTimeAtStop = Math.max(0, minutesToDeparture - walkTimeStart);
                }
              } else {
                // No active departures. Check if this line statically serves stops in the correct direction
                const hasValidStaticDirection = sDirs.some(sd =>
                  sd.line === line &&
                  eDirs.some(ed => ed.line === line && ed.direction === sd.direction) &&
                  this.isEndStopAfterStartStopGeographically(sCand.stop, eCand.stop, sd.direction)
                );

                if (hasValidStaticDirection) {
                  nextDep = null;
                  isConnectionValid = true;
                  departureTimeAbs = 'Brak kursu';
                  arrivalTimeAbs = 'Brak kursu';
                  waitingTimeAtStop = 0;
                } else {
                  isConnectionValid = false;
                }
              }

              if (isConnectionValid) {
                // Calculate walking & driving times
                const walkTimeStart = Math.round(sCand.distance / 80); // 80m/min walking speed
                const walkTimeEnd = Math.round(eCand.distance / 80);
                
                if (actualBusTime === 0) {
                  const stopDist = this.getDistance(sCand.stop.lat, sCand.stop.lng, eCand.stop.lat, eCand.stop.lng);
                  actualBusTime = Math.max(2, Math.round(stopDist / 400));
                }

                // Total connection details (walk + wait + bus + walk)
                const totalTime = walkTimeStart + waitingTimeAtStop + actualBusTime + walkTimeEnd;

                // Prepare Leaflet Markers & Geometries
                const startMarker = L.marker([sCand.stop.lat, sCand.stop.lng], {
                  icon: L.divIcon({
                    className: 'bus-stop-marker planned',
                    html: `<div class="marker-dot planned-start"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                  })
                }).bindPopup(`<b>Przystanek początkowy:</b><br>${sCand.stop.name}`);

                const endMarker = L.marker([eCand.stop.lat, eCand.stop.lng], {
                  icon: L.divIcon({
                    className: 'bus-stop-marker planned',
                    html: `<div class="marker-dot planned-end"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                  })
                }).bindPopup(`<b>Przystanek końcowy:</b><br>${eCand.stop.name}`);

                foundConnections.push({
                  startStop: sCand.stop,
                  endStop: eCand.stop,
                  line,
                  nextDeparture: nextDep,
                  walkTimeStart,
                  walkTimeEnd,
                  busTime: actualBusTime,
                  totalTime,
                  polylineLayers: [], // will load on demand/selection
                  startMarker,
                  endMarker,
                  departureTimeAbs,
                  arrivalTimeAbs,
                  waitingTimeAtStop
                });

                pairHasValidConnection = true;
              }
            }

            // Keep searching and accumulating options until we have at least 5 valid connections!
            if (foundConnections.length >= 5) {
              foundPair = true;
              break;
            }
          }
        } catch (err) {
          console.error(`Failed candidate lookup for ${sCand.stop.name} and ${eCand.stop.name}`, err);
        }
      }
      if (foundConnections.length >= 5) break;
    }

    // Now, split into active (has a real departure upcoming) and inactive (currently no bus)
    const activeConnections = foundConnections.filter(c => c.nextDeparture !== null);
    
    // Sort and choose the appropriate set
    let finalConnections = [];
    if (activeConnections.length > 0) {
      activeConnections.sort((a, b) => a.totalTime - b.totalTime);
      finalConnections = activeConnections;
    } else {
      // Fallback: show inactive connections if absolutely no active buses exist (e.g. night testing)
      foundConnections.sort((a, b) => a.totalTime - b.totalTime);
      finalConnections = foundConnections;
    }

    this.connections.set(finalConnections);
    this.searchingConnections.set(false);

    if (finalConnections.length > 0) {
      this.selectConnection(0);
    }
  }

  async selectConnection(index: number): Promise<void> {
    this.selectedConnectionIndex.set(index);
    this.routeLayerGroup.clearLayers();

    const conn = this.connections()[index];
    if (!conn) return;

    const start = this.startPoint()!;
    const end = this.endPoint()!;

    // Add candidate start & end stop markers
    conn.startMarker.addTo(this.routeLayerGroup);
    conn.endMarker.addTo(this.routeLayerGroup);

    // Fetch street-aligned routes from OSRM
    const walk1Coords = await this.getOSRMRoute([[start.lat, start.lng], [conn.startStop.lat, conn.startStop.lng]], 'foot');
    const busCoords = await this.getOSRMRoute([[conn.startStop.lat, conn.startStop.lng], [conn.endStop.lat, conn.endStop.lng]], 'driving');
    const walk2Coords = await this.getOSRMRoute([[conn.endStop.lat, conn.endStop.lng], [end.lat, end.lng]], 'foot');

    // Create Polylines
    const walk1Poly = L.polyline(walk1Coords, {
      color: '#f43f5e',
      weight: 5,
      dashArray: '5, 10',
      opacity: 0.85
    });

    const busPoly = L.polyline(busCoords, {
      color: '#10b981',
      weight: 7,
      opacity: 0.95
    });

    const walk2Poly = L.polyline(walk2Coords, {
      color: '#f43f5e',
      weight: 5,
      dashArray: '5, 10',
      opacity: 0.85
    });

    // Add to group
    walk1Poly.addTo(this.routeLayerGroup);
    busPoly.addTo(this.routeLayerGroup);
    walk2Poly.addTo(this.routeLayerGroup);

    // Zoom map to fit the route bounds
    const bounds = L.latLngBounds([...walk1Coords, ...busCoords, ...walk2Coords]);
    this.map.fitBounds(bounds, { padding: [40, 40] });
  }

  // ─── OSRM Geocoding / Routing Helpers ──────────────────
  private async getOSRMRoute(coords: [number, number][], profile: 'foot' | 'driving'): Promise<L.LatLng[]> {
    try {
      const coordsStr = coords.map(c => `${c[1]},${c[0]}`).join(';');
      const res = await fetch(`https://router.project-osrm.org/route/v1/${profile}/${coordsStr}?overview=full&geometries=geojson`);
      const data = await res.json();
      if (data.routes && data.routes[0]) {
        const geojson = data.routes[0].geometry;
        return geojson.coordinates.map((c: any) => new L.LatLng(c[1], c[0]));
      }
    } catch (e) {
      console.error('OSRM fetch failed, falling back to direct line', e);
    }
    return coords.map(c => new L.LatLng(c[0], c[1]));
  }

  private getNearestStops(lat: number, lng: number, count: number = 3): { stop: Stop, distance: number }[] {
    return this.allStops()
      .map(stop => ({
        stop,
        distance: this.getDistance(lat, lng, stop.lat, stop.lng)
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, count);
  }

  private getDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
    const R = 6371e3; // meters
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLng / 2) * Math.sin(dLng / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }

  private isEndStopAfterStartStopGeographically(startStop: Stop, endStop: Stop, directionName: string): boolean {
    if (!directionName) return true; // fallback

    // 1. Find the final destination stop in all loaded stops
    const normalizedDir = directionName.toLowerCase().trim();

    // Find stops whose name contains/matches the direction
    const targetStops = this.allStops().filter(s =>
      s.name.toLowerCase().includes(normalizedDir)
    );

    if (targetStops.length === 0) {
      return true; // fallback to true if destination stop not found
    }

    // Compute the minimum distance from start and end stops to any of the matching destination stops
    let minDistStart = Infinity;
    let minDistEnd = Infinity;

    for (const destStop of targetStops) {
      const distStart = this.getDistance(startStop.lat, startStop.lng, destStop.lat, destStop.lng);
      const distEnd = this.getDistance(endStop.lat, endStop.lng, destStop.lat, destStop.lng);

      if (distStart < minDistStart) minDistStart = distStart;
      if (distEnd < minDistEnd) minDistEnd = distEnd;
    }

    // If the end stop is closer to the destination than the start stop,
    // it is highly likely that the bus moves from start to end!
    return minDistEnd < minDistStart;
  }

  private parseDepartureTimeToMinutes(timeStr: string): number {
    if (!timeStr) return 0;
    const normalized = timeStr.toLowerCase().trim();
    if (normalized === 'now' || normalized === 'odjeżdża' || normalized === '0 min') {
      return 0;
    }
    const match = normalized.match(/(\d+)\s*min/);
    if (match) {
      return parseInt(match[1], 10);
    }
    // Check if it is HH:MM format
    const hhmm = normalized.match(/(\d{1,2}):(\d{2})/);
    if (hhmm) {
      const hours = parseInt(hhmm[1], 10);
      const minutes = parseInt(hhmm[2], 10);
      
      const now = new Date();
      const depDate = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hours, minutes);
      let diffMs = depDate.getTime() - now.getTime();
      if (diffMs < -12 * 60 * 60 * 1000) {
        // Probably next day
        diffMs += 24 * 60 * 60 * 1000;
      }
      return Math.max(0, Math.round(diffMs / 60000));
    }
    return 0;
  }

  private getAbsoluteTimeString(minutesFromNow: number): string {
    const now = new Date();
    const futureDate = new Date(now.getTime() + minutesFromNow * 60 * 1000);
    const hours = String(futureDate.getHours()).padStart(2, '0');
    const mins = String(futureDate.getMinutes()).padStart(2, '0');
    return `${hours}:${mins}`;
  }

  private parseTimeToMinutesOfDay(timeStr: string): number {
    const parts = timeStr.split(':');
    if (parts.length < 2) return 0;
    return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
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
        .bindPopup(`<b>Punkt startowy:</b><br>${start.name}`)
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
        .bindPopup(`<b>Punkt docelowy:</b><br>${end.name}`)
        .addTo(this.userPointsLayerGroup);
    }
  }

  clearAllRoutes(): void {
    this.startPoint.set(null);
    this.endPoint.set(null);
    this.searchQueryStart.set('');
    this.searchQueryEnd.set('');
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();
    this.userPointsLayerGroup.clearLayers();
  }
}
