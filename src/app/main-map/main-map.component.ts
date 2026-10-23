import { Component, OnInit, OnDestroy, signal, computed, effect } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as L from 'leaflet';
import { MapMarkerService } from '../features/map/services/map-marker.service';
import { TimetableService } from '../core/services/timetable.service';
import { Stop, Departure, DeparturesResponse, TripExecutionResponse, StopDirection } from '../shared/models/transit.models';
import { firstValueFrom } from 'rxjs';
import { escapeHtml, namesMatch, normalizeName } from '../shared/utils/text.utils';
import { TravelTimeService, toDateInputValue } from '../core/services/travel-time.service';
import { TimePickerComponent } from '../shared/components/time-picker/time-picker.component';

interface ConnectionPoint {
  lat: number;
  lng: number;
  name: string;
  isStop?: boolean;
  stopId?: string;
}

interface ConnectionLeg {
  startStop: Stop;
  endStop: Stop;
  line: string;
  nextDeparture: Departure | null;
  busTime: number;
  departureTimeAbs: string;
  arrivalTimeAbs: string;
  waitingTimeAtStop: number;
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
  
  // Transfer support
  isTransfer?: boolean;
  legs?: ConnectionLeg[];
  transferStop?: Stop;
  walkTimeTransfer?: number; // Wait/walk at transfer point in minutes
}

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

  private directionsCache = new Map<string, StopDirection[]>();
  private departuresCache = new Map<string, DeparturesResponse>();
  private tripExecutionsCache = new Map<string, TripExecutionResponse>();

  private async getCachedDirections(stopId: string): Promise<StopDirection[]> {
    // Lines differ between days (e.g. weekends), so cache per stop + chosen date
    const selected = this.travelTime.selected();
    const date = selected ? toDateInputValue(selected) : undefined;
    const key = `${stopId}|${date ?? 'now'}`;
    if (this.directionsCache.has(key)) {
      return this.directionsCache.get(key)!;
    }
    try {
      const dirs = await firstValueFrom(this.timetableService.getDirectionsForStop(stopId, date));
      this.directionsCache.set(key, dirs);
      return dirs;
    } catch (e) {
      console.error(`Failed to fetch directions for stop ${stopId}`, e);
      return [];
    }
  }

  private async getCachedDepartures(stopId: string): Promise<DeparturesResponse> {
    if (this.departuresCache.has(stopId)) {
      return this.departuresCache.get(stopId)!;
    }
    try {
      const deps = await firstValueFrom(this.timetableService.getDepartures(stopId, this.travelTime.selected()));
      this.departuresCache.set(stopId, deps);
      return deps;
    } catch (e) {
      console.error(`Failed to fetch departures for stop ${stopId}`, e);
      return { timestamp: Date.now(), designator: 0, station_name: '', only_disembarking: false };
    }
  }

  private async getCachedTripExecution(tripExecId: string): Promise<TripExecutionResponse | null> {
    if (this.tripExecutionsCache.has(tripExecId)) {
      return this.tripExecutionsCache.get(tripExecId)!;
    }
    try {
      const exec = await firstValueFrom(this.timetableService.getTripExecution(tripExecId));
      if (exec) {
        this.tripExecutionsCache.set(tripExecId, exec);
        return exec;
      }
    } catch (e) {
      console.error(`Failed to fetch trip execution ${tripExecId}`, e);
    }
    return null;
  }

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
    private timetableService: TimetableService,
    readonly travelTime: TravelTimeService
  ) {
    // Results are calculated for a specific moment – drop them when the user changes the time
    effect(() => {
      this.travelTime.selected();
      this.connections.set([]);
      this.selectedConnectionIndex.set(null);
      this.routeLayerGroup.clearLayers();
    });
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

    // Clear runtime cache for this search request to get fresh departures
    this.departuresCache.clear();
    this.tripExecutionsCache.clear();

    try {
      // 1. Resolve candidates, prioritizing explicitly selected stops, otherwise top 10 nearest
      let startCandidates: { stop: Stop, distance: number }[] = [];
      if (start.isStop && start.stopId) {
        const stopObj = this.allStops().find(s => s && s.id === start.stopId);
        if (stopObj) {
          startCandidates = [{ stop: stopObj, distance: 0 }];
        }
      }
      if (startCandidates.length === 0) {
        startCandidates = this.getNearestStops(start.lat, start.lng, 10);
      }

      let endCandidates: { stop: Stop, distance: number }[] = [];
      if (end.isStop && end.stopId) {
        const stopObj = this.allStops().find(s => s && s.id === end.stopId);
        if (stopObj) {
          endCandidates = [{ stop: stopObj, distance: 0 }];
        }
      }
      if (endCandidates.length === 0) {
        endCandidates = this.getNearestStops(end.lat, end.lng, 10);
      }

      if (startCandidates.length === 0 || endCandidates.length === 0) {
        return;
      }

      // Resolve midpoint candidates for transfer stops (top 25 nearest to geographic midpoint)
      const midLat = (start.lat + end.lat) / 2;
      const midLng = (start.lng + end.lng) / 2;
      const midpointCandidates = this.getNearestStops(midLat, midLng, 25);

      const foundConnections: Connection[] = [];

    // ─── STAGE 1: SEARCH FOR DIRECT CONNECTIONS ───
    for (const sCand of startCandidates) {
      for (const eCand of endCandidates) {
        if (sCand.stop.id === eCand.stop.id) continue;

        try {
          const sDirs = await this.getCachedDirections(sCand.stop.id);
          const eDirs = await this.getCachedDirections(eCand.stop.id);

          const sLines = sDirs.map(d => d.line);
          const eLines = eDirs.map(d => d.line);
          const shared = sLines.filter(line => eLines.includes(line));

          if (shared.length > 0) {
            // Fetch live departures with caching
            const departuresRes = await this.getCachedDepartures(sCand.stop.id);
            const liveRows = departuresRes.rows || [];
            const directionsMap = departuresRes.directions || {};

            for (const line of shared) {
              // Get all departures matching this line
              const lineDepartures = liveRows.filter((r: Departure) => (r.line_name || r.line) === line);

              // Filter departures heading in the correct direction geographically
              const correctDirectionDepartures = lineDepartures.filter((r: Departure) => {
                if (!r.direction_id) return true;
                const depDest = directionsMap[r.direction_id];
                if (!depDest) return true;

                const isSharedDirection = eDirs.some(ed => {
                  if (ed.line !== line) return false;
                  return namesMatch(ed.direction, depDest);
                });
                if (!isSharedDirection) return false;

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
                const candidateDep = correctDirectionDepartures[0];
                minutesToDeparture = this.parseDepartureTimeToMinutes(candidateDep.time);

                if (candidateDep.trip_execution_id) {
                  try {
                    const tripExec = await this.getCachedTripExecution(candidateDep.trip_execution_id);
                    const times = tripExec?.trip?.times || [];
                    const startIndex = times.findIndex(t => t.place_id === sCand.stop.id);
                    const endIndex = times.findIndex(t => t.place_id === eCand.stop.id);

                    if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
                      nextDep = candidateDep;
                      isConnectionValid = true;

                      const schedStartStr = times[startIndex].departure_time;
                      const schedEndStr = times[endIndex].departure_time;
                      
                      let schedDuration = this.parseTimeToMinutesOfDay(schedEndStr) - this.parseTimeToMinutesOfDay(schedStartStr);
                      if (schedDuration < 0) schedDuration += 1440;
                      
                      actualBusTime = schedDuration;
                    } else {
                      nextDep = null;
                      isConnectionValid = false;
                    }
                  } catch (err) {
                    console.error('Failed real-time stop sequence check, falling back to geographic baseline', err);
                    nextDep = candidateDep;
                    isConnectionValid = true;
                  }
                } else {
                  nextDep = candidateDep;
                  isConnectionValid = true;
                }

                if (isConnectionValid) {
                  departureTimeAbs = this.getAbsoluteTimeString(minutesToDeparture);
                  
                  if (actualBusTime === 0) {
                    const stopDist = this.getDistance(sCand.stop.lat, sCand.stop.lng, eCand.stop.lat, eCand.stop.lng);
                    actualBusTime = Math.max(2, Math.round(stopDist / 400));
                  }

                  arrivalTimeAbs = this.getAbsoluteTimeString(minutesToDeparture + actualBusTime);
                  
                  const walkTimeStart = Math.round(sCand.distance / 80);
                  waitingTimeAtStop = Math.max(0, minutesToDeparture - walkTimeStart);
                }
              } else {
                const hasValidStaticDirection = sDirs.some(sd => {
                  if (sd.line !== line) return false;
                  const hasEd = eDirs.some(ed => {
                    if (ed.line !== line) return false;
                    return namesMatch(sd.direction, ed.direction);
                  });
                  if (!hasEd) return false;
                  return this.isEndStopAfterStartStopGeographically(sCand.stop, eCand.stop, sd.direction);
                });

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
                const walkTimeStart = Math.round(sCand.distance / 80);
                const walkTimeEnd = Math.round(eCand.distance / 80);
                
                if (actualBusTime === 0) {
                  const stopDist = this.getDistance(sCand.stop.lat, sCand.stop.lng, eCand.stop.lat, eCand.stop.lng);
                  actualBusTime = Math.max(2, Math.round(stopDist / 400));
                }

                const totalTime = walkTimeStart + waitingTimeAtStop + actualBusTime + walkTimeEnd;

                const startMarker = L.marker([sCand.stop.lat, sCand.stop.lng], {
                  icon: L.divIcon({
                    className: 'bus-stop-marker planned',
                    html: `<div class="marker-dot planned-start"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                  })
                }).bindPopup(`<b>Przystanek początkowy:</b><br>${escapeHtml(sCand.stop.name)}`);

                const endMarker = L.marker([eCand.stop.lat, eCand.stop.lng], {
                  icon: L.divIcon({
                    className: 'bus-stop-marker planned',
                    html: `<div class="marker-dot planned-end"></div>`,
                    iconSize: [16, 16],
                    iconAnchor: [8, 8]
                  })
                }).bindPopup(`<b>Przystanek końcowy:</b><br>${escapeHtml(eCand.stop.name)}`);

                foundConnections.push({
                  startStop: sCand.stop,
                  endStop: eCand.stop,
                  line,
                  nextDeparture: nextDep,
                  walkTimeStart,
                  walkTimeEnd,
                  busTime: actualBusTime,
                  totalTime,
                  polylineLayers: [],
                  startMarker,
                  endMarker,
                  departureTimeAbs,
                  arrivalTimeAbs,
                  waitingTimeAtStop
                });
              }
            }
          }
        } catch (err) {
          console.error(`Failed direct candidate lookup for ${sCand.stop.name} and ${eCand.stop.name}`, err);
        }
      }
    }

    // ─── STAGE 2: SEARCH FOR TRANSFER CONNECTIONS (if we have fewer than 5 direct options) ───
    if (foundConnections.length < 5) {
      // Limit candidate stop lists for the multi-leg transfer loop to optimize iterations
      const startCandidatesTransfer = startCandidates.slice(0, 3);
      const endCandidatesTransfer = endCandidates.slice(0, 3);

      for (const sCand of startCandidatesTransfer) {
        for (const eCand of endCandidatesTransfer) {
          if (sCand.stop.id === eCand.stop.id) continue;
          if (foundConnections.length >= 6) break;

          try {
            // Get all departures for the start stop
            const sDeps = await this.getCachedDepartures(sCand.stop.id);
            const sRows = sDeps.rows || [];
            const sDirsMap = sDeps.directions || {};

            // Evaluate departures from sCand as Leg 1
            for (const dep1 of sRows) {
              if (foundConnections.length >= 6) break;
              if (!dep1.line_name && !dep1.line) continue;
              const line1 = dep1.line_name || dep1.line!;

              // Let's get the actual stops of this ride to find where the user can physically get off
              if (!dep1.trip_execution_id) continue;

              const tripExec = await this.getCachedTripExecution(dep1.trip_execution_id);
              if (!tripExec || !tripExec.trip || !tripExec.trip.times) continue;

              const times = tripExec.trip.times;
              const startIndex = times.findIndex(t => t.place_id === sCand.stop.id);
              if (startIndex === -1) continue;

              // The subsequent stops along the actual ride of Leg 1
              const rideStops = times.slice(startIndex + 1);

              // Check if we can transfer at any subsequent stop of the ride
              for (const rideStop of rideStops) {
                if (foundConnections.length >= 6) break;
                if (rideStop.place_id === eCand.stop.id) continue; // Direct connection, already handled in Stage 1

                const tStopObj = this.allStops().find(s => s && s.id === rideStop.place_id);
                if (!tStopObj) continue;

                // Check if this transfer stop has any lines that can take us to eCand
                const tDirs = await this.getCachedDirections(tStopObj.id);
                const eDirs = await this.getCachedDirections(eCand.stop.id);

                const tLines = tDirs.map(d => d.line);
                const eLines = eDirs.map(d => d.line);
                const shared2 = tLines.filter(line => eLines.includes(line));

                if (shared2.length === 0) continue;

                // Let's get departures from this transfer stop
                const tDeps = await this.getCachedDepartures(tStopObj.id);
                const tRows = tDeps.rows || [];
                const tDirsMap = tDeps.directions || {};

                // Calculate arrival time of Leg 1 (in minutes from departure)
                const minToDep1 = this.parseDepartureTimeToMinutes(dep1.time);
                
                const schedStart1 = times[startIndex].departure_time;
                const schedEnd1 = rideStop.departure_time;
                let busTime1 = this.parseTimeToMinutesOfDay(schedEnd1) - this.parseTimeToMinutesOfDay(schedStart1);
                if (busTime1 < 0) busTime1 += 1440;

                const arrivalTime1Min = minToDep1 + busTime1;

                // Check departures for Leg 2 from this transfer stop
                for (const line2 of shared2) {
                  if (foundConnections.length >= 6) break;

                  const tLineDeps = tRows.filter((r: Departure) => (r.line_name || r.line) === line2);
                  const correctTLineDeps = tLineDeps.filter((r: Departure) => {
                    if (!r.direction_id) return true;
                    const depDest = tDirsMap[r.direction_id];
                    if (!depDest) return true;
                    const isShared = eDirs.some(ed => {
                      if (ed.line !== line2) return false;
                      return namesMatch(ed.direction, depDest);
                    });
                    if (!isShared) return false;
                    return this.isEndStopAfterStartStopGeographically(tStopObj, eCand.stop, depDest);
                  });

                  // We need a departure at tStopObj that leaves at least 2 minutes after Leg 1 arrives (buffer)
                  const eligibleDeps = correctTLineDeps.filter((r: Departure) => {
                    const minToDep2 = this.parseDepartureTimeToMinutes(r.time);
                    return minToDep2 >= arrivalTime1Min + 2;
                  });

                  if (eligibleDeps.length === 0) continue;

                  const dep2 = eligibleDeps[0];
                  const minToDep2 = this.parseDepartureTimeToMinutes(dep2.time);
                  let busTime2 = 0;

                  if (dep2.trip_execution_id) {
                    try {
                      const tripExec2 = await this.getCachedTripExecution(dep2.trip_execution_id);
                      const times2 = tripExec2?.trip?.times || [];
                      const startIndex2 = times2.findIndex(t => t.place_id === tStopObj.id);
                      const endIndex2 = times2.findIndex(t => t.place_id === eCand.stop.id);
                      if (startIndex2 !== -1 && endIndex2 !== -1 && startIndex2 < endIndex2) {
                        const schedStart = times2[startIndex2].departure_time;
                        const schedEnd = times2[endIndex2].departure_time;
                        let schedDuration = this.parseTimeToMinutesOfDay(schedEnd) - this.parseTimeToMinutesOfDay(schedStart);
                        if (schedDuration < 0) schedDuration += 1440;
                        busTime2 = schedDuration;
                      }
                    } catch (e) {}
                  }
                  if (busTime2 === 0) {
                    const stopDist = this.getDistance(tStopObj.lat, tStopObj.lng, eCand.stop.lat, eCand.stop.lng);
                    busTime2 = Math.max(2, Math.round(stopDist / 400));
                  }

                  const arrivalTime2Min = minToDep2 + busTime2;
                  const walkTimeTransfer = minToDep2 - arrivalTime1Min;

                  const walkTimeStart = Math.round(sCand.distance / 80);
                  const walkTimeEnd = Math.round(eCand.distance / 80);
                  const waitingTimeAtStop = Math.max(0, minToDep1 - walkTimeStart);

                  const totalTime = walkTimeStart + waitingTimeAtStop + busTime1 + walkTimeTransfer + busTime2 + walkTimeEnd;

                  const startMarker = L.marker([sCand.stop.lat, sCand.stop.lng], {
                    icon: L.divIcon({
                      className: 'bus-stop-marker planned',
                      html: `<div class="marker-dot planned-start"></div>`,
                      iconSize: [16, 16],
                      iconAnchor: [8, 8]
                    })
                  }).bindPopup(`<b>Przystanek początkowy:</b><br>${escapeHtml(sCand.stop.name)}`);

                  const endMarker = L.marker([eCand.stop.lat, eCand.stop.lng], {
                    icon: L.divIcon({
                      className: 'bus-stop-marker planned',
                      html: `<div class="marker-dot planned-end"></div>`,
                      iconSize: [16, 16],
                      iconAnchor: [8, 8]
                    })
                  }).bindPopup(`<b>Przystanek końcowy:</b><br>${escapeHtml(eCand.stop.name)}`);

                  const departureTimeAbs = this.getAbsoluteTimeString(minToDep1);
                  const arrivalTimeAbs = this.getAbsoluteTimeString(arrivalTime2Min);

                  const leg1: ConnectionLeg = {
                    startStop: sCand.stop,
                    endStop: tStopObj,
                    line: line1,
                    nextDeparture: dep1,
                    busTime: busTime1,
                    departureTimeAbs,
                    arrivalTimeAbs: this.getAbsoluteTimeString(arrivalTime1Min),
                    waitingTimeAtStop
                  };

                  const leg2: ConnectionLeg = {
                    startStop: tStopObj,
                    endStop: eCand.stop,
                    line: line2,
                    nextDeparture: dep2,
                    busTime: busTime2,
                    departureTimeAbs: this.getAbsoluteTimeString(minToDep2),
                    arrivalTimeAbs,
                    waitingTimeAtStop: walkTimeTransfer
                  };

                  foundConnections.push({
                    startStop: sCand.stop,
                    endStop: eCand.stop,
                    line: `${line1} ➔ ${line2}`,
                    nextDeparture: dep1,
                    walkTimeStart,
                    walkTimeEnd,
                    busTime: busTime1 + busTime2,
                    totalTime,
                    polylineLayers: [],
                    startMarker,
                    endMarker,
                    departureTimeAbs,
                    arrivalTimeAbs,
                    waitingTimeAtStop,
                    isTransfer: true,
                    legs: [leg1, leg2],
                    transferStop: tStopObj,
                    walkTimeTransfer
                  });
                }
              }
            }
          } catch (err) {
            console.error(`Failed transfer ride-based candidate lookup`, err);
          }
        }
      }
    }

    // Now, split into active (has a real departure upcoming) and inactive (currently no bus)
    const activeConnections = foundConnections.filter(c => c.nextDeparture !== null);
    
    // Sort and choose the appropriate set
    let finalConnections = [];
    if (activeConnections.length > 0) {
      activeConnections.sort((a, b) => a.totalTime - b.totalTime);
      finalConnections = activeConnections;
    } else {
      foundConnections.sort((a, b) => a.totalTime - b.totalTime);
      finalConnections = foundConnections;
    }

      this.connections.set(finalConnections);

      if (finalConnections.length > 0) {
        this.selectConnection(0);
      }
    } catch (globalErr) {
      console.error("Global routing search error:", globalErr);
    } finally {
      this.searchingConnections.set(false);
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

    let walk1Coords: L.LatLng[] = [];
    let bus1Coords: L.LatLng[] = [];
    let bus2Coords: L.LatLng[] = [];
    let walk2Coords: L.LatLng[] = [];

    if (!conn.isTransfer) {
      // Direct connection
      walk1Coords = await this.getOSRMRoute([[start.lat, start.lng], [conn.startStop.lat, conn.startStop.lng]], 'foot');
      bus1Coords = await this.getOSRMRoute([[conn.startStop.lat, conn.startStop.lng], [conn.endStop.lat, conn.endStop.lng]], 'driving');
      walk2Coords = await this.getOSRMRoute([[conn.endStop.lat, conn.endStop.lng], [end.lat, end.lng]], 'foot');

      // Create Polylines
      const walk1Poly = L.polyline(walk1Coords, {
        color: '#f43f5e',
        weight: 5,
        dashArray: '5, 10',
        opacity: 0.85
      }).bindPopup('🚶‍♂️ Dojście do przystanku');

      const busPoly = L.polyline(bus1Coords, {
        color: '#10b981',
        weight: 7,
        opacity: 0.95
      }).bindPopup(`🚌 Linia ${escapeHtml(conn.line)}`);

      const walk2Poly = L.polyline(walk2Coords, {
        color: '#f43f5e',
        weight: 5,
        dashArray: '5, 10',
        opacity: 0.85
      }).bindPopup('🚶‍♂️ Dojście do celu');

      walk1Poly.addTo(this.routeLayerGroup);
      busPoly.addTo(this.routeLayerGroup);
      walk2Poly.addTo(this.routeLayerGroup);

      const bounds = L.latLngBounds([...walk1Coords, ...bus1Coords, ...walk2Coords]);
      this.map.fitBounds(bounds, { padding: [40, 40] });
    } else {
      // Transfer connection
      const transferStop = conn.transferStop!;
      walk1Coords = await this.getOSRMRoute([[start.lat, start.lng], [conn.startStop.lat, conn.startStop.lng]], 'foot');
      bus1Coords = await this.getOSRMRoute([[conn.startStop.lat, conn.startStop.lng], [transferStop.lat, transferStop.lng]], 'driving');
      bus2Coords = await this.getOSRMRoute([[transferStop.lat, transferStop.lng], [conn.endStop.lat, conn.endStop.lng]], 'driving');
      walk2Coords = await this.getOSRMRoute([[conn.endStop.lat, conn.endStop.lng], [end.lat, end.lng]], 'foot');

      // Create transfer stop marker and add to map
      const transferMarker = L.marker([transferStop.lat, transferStop.lng], {
        icon: L.divIcon({
          className: 'bus-stop-marker planned transfer',
          html: `<div class="marker-dot planned-transfer" style="background-color: #f59e0b; width: 14px; height: 14px; border-radius: 50%; border: 2px solid white; box-shadow: 0 0 4px rgba(0,0,0,0.5);"></div>`,
          iconSize: [14, 14],
          iconAnchor: [7, 7]
        })
      }).bindPopup(`<b>Punkt przesiadkowy:</b><br>${escapeHtml(transferStop.name)}`);
      transferMarker.addTo(this.routeLayerGroup);

      // Create Polylines
      const walk1Poly = L.polyline(walk1Coords, {
        color: '#f43f5e',
        weight: 5,
        dashArray: '5, 10',
        opacity: 0.85
      }).bindPopup('🚶‍♂️ Dojście do przystanku początkowego');

      const bus1Poly = L.polyline(bus1Coords, {
        color: '#10b981', // Leg 1 is Emerald
        weight: 7,
        opacity: 0.95
      }).bindPopup(`🚌 Linia ${escapeHtml(conn.legs?.[0]?.line)} (Etap 1)`);

      const bus2Poly = L.polyline(bus2Coords, {
        color: '#06b6d4', // Leg 2 is Cyan/Teal
        weight: 7,
        opacity: 0.95
      }).bindPopup(`🚌 Linia ${escapeHtml(conn.legs?.[1]?.line)} (Etap 2)`);

      const walk2Poly = L.polyline(walk2Coords, {
        color: '#f43f5e',
        weight: 5,
        dashArray: '5, 10',
        opacity: 0.85
      }).bindPopup('🚶‍♂️ Dojście do celu');

      walk1Poly.addTo(this.routeLayerGroup);
      bus1Poly.addTo(this.routeLayerGroup);
      bus2Poly.addTo(this.routeLayerGroup);
      walk2Poly.addTo(this.routeLayerGroup);

      const bounds = L.latLngBounds([...walk1Coords, ...bus1Coords, ...bus2Coords, ...walk2Coords]);
      this.map.fitBounds(bounds, { padding: [40, 40] });
    }
  }

  // ─── OSRM Geocoding / Routing Helpers ──────────────────
  private async getOSRMRoute(coords: [number, number][], profile: 'foot' | 'driving'): Promise<L.LatLng[]> {
    try {
      const coordsStr = coords.map(c => `${c[1]},${c[0]}`).join(';');
      let url = '';
      if (profile === 'foot') {
        url = `https://routing.openstreetmap.de/routed-foot/route/v1/foot/${coordsStr}?overview=full&geometries=geojson`;
      } else {
        url = `https://routing.openstreetmap.de/routed-car/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;
      }
      
      const res = await fetch(url);
      const data = await res.json();
      if (data.routes && data.routes[0]) {
        const geojson = data.routes[0].geometry;
        return geojson.coordinates.map((c: any) => new L.LatLng(c[1], c[0]));
      }
    } catch (e) {
      console.error('FOSSGIS OSM route fetch failed, falling back to public OSRM demo', e);
      try {
        const coordsStr = coords.map(c => `${c[1]},${c[0]}`).join(';');
        const res = await fetch(`https://router.project-osrm.org/route/v1/${profile}/${coordsStr}?overview=full&geometries=geojson`);
        const data = await res.json();
        if (data.routes && data.routes[0]) {
          const geojson = data.routes[0].geometry;
          return geojson.coordinates.map((c: any) => new L.LatLng(c[1], c[0]));
        }
      } catch (err) {
        console.error('Public OSRM demo also failed, falling back to direct line', err);
      }
    }
    return coords.map(c => new L.LatLng(c[0], c[1]));
  }

  private getNearestStops(lat: number, lng: number, count: number = 3): { stop: Stop, distance: number }[] {
    return this.allStops()
      .filter(stop => stop && typeof stop.lat === 'number' && typeof stop.lng === 'number')
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
    if (!normalizeName(directionName)) return true; // fallback

    // Find stops whose name contains/matches the direction (the line's final destination)
    const targetStops = this.allStops().filter(s => namesMatch(s.name, directionName));

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
      
      const now = this.travelTime.referenceTime();
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
    const now = this.travelTime.referenceTime();
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
    this.connections.set([]);
    this.selectedConnectionIndex.set(null);
    this.routeLayerGroup.clearLayers();
    this.userPointsLayerGroup.clearLayers();
  }
}
