import { Component, OnDestroy, OnInit, effect, inject, untracked } from '@angular/core';
import * as L from 'leaflet';
import { GeolocationService } from '../core/services/geolocation.service';
import { GtfsService } from '../core/services/gtfs.service';
import { ShapesService } from '../core/services/shapes.service';
import { StopsService } from '../core/services/stops.service';
import { MapMarkerService } from '../features/map/services/map-marker.service';
import { RouteLayerService } from '../features/map/services/route-layer.service';
import { StopPanelComponent } from '../features/map/stop-panel/stop-panel.component';
import { PlannerPanelComponent } from '../features/route-planner/planner-panel/planner-panel.component';
import { PlannerStateService } from '../features/route-planner/planner-state.service';
import { StopEditorLayerService } from '../features/stop-editor/stop-editor-layer.service';
import { StopEditorComponent } from '../features/stop-editor/stop-editor.component';
import { stopEditorEnabled } from '../features/stop-editor/stop-editor.service';
import { StopSearchComponent } from '../features/stop-search/stop-search.component';
import { BusPanelComponent } from '../features/vehicles/bus-panel/bus-panel.component';
import { ScheduledBusesService } from '../features/vehicles/scheduled-buses.service';
import { VehicleLayerService } from '../features/vehicles/vehicle-layer.service';
import { Stop } from '../shared/models/transit.models';

const JASLO_CENTRE: L.LatLngTuple = [49.745, 21.472];
/** Width of the bus side panel on wide screens (bus-panel.component.scss) */
const BUS_PANEL_WIDTH_PX = 320;

/**
 * The map view: Leaflet map with stop markers, the planner's points and selected route,
 * and the controls drawn over it (stop search or planner panel, planner toggle, locate me).
 */
@Component({
  selector: 'app-main-map',
  standalone: true,
  imports: [StopSearchComponent, PlannerPanelComponent, StopEditorComponent, BusPanelComponent, StopPanelComponent],
  templateUrl: './main-map.component.html',
  styleUrl: './main-map.component.scss'
})
export class MainMapComponent implements OnInit, OnDestroy {
  readonly planner = inject(PlannerStateService);
  readonly stops = inject(StopsService);
  private markers = inject(MapMarkerService);
  private routeLayer = inject(RouteLayerService);
  private geolocation = inject(GeolocationService);
  private gtfs = inject(GtfsService);
  private shapes = inject(ShapesService);
  private editorLayer = inject(StopEditorLayerService);
  readonly buses = inject(ScheduledBusesService);
  private vehicleLayer = inject(VehicleLayerService);

  /** Developer stop editor instead of the search and planner (app opened with ?dev) */
  readonly editing = stopEditorEnabled();

  private map!: L.Map;

  constructor() {
    // Start loading the timetable right away, so the first popup / search doesn't wait
    this.gtfs.index().subscribe({ error: err => console.error('Failed to load the timetable', err) });
    this.shapes.load();

    // Draw the planner's points A/B and the selected connection
    effect(() => {
      const start = this.planner.start();
      const end = this.planner.end();
      untracked(() => this.routeLayer.drawPoints(start, end));
    });
    effect(() => {
      const conn = this.planner.selected();
      this.shapes.loaded(); // redraw along roads once the road lines arrive
      untracked(() => (conn ? this.routeLayer.drawConnection(conn) : this.routeLayer.clearRoute()));
    });
    // One side panel at a time: a stop or a bus
    effect(() => {
      if (this.markers.selectedStopId()) untracked(() => this.buses.select(null));
    });
    effect(() => {
      if (this.buses.selectedKey()) untracked(() => this.markers.selectStop(null));
    });

    // Buses where the timetable says they are
    effect(() => {
      const buses = this.buses.buses();
      const selected = this.buses.selectedKey();
      untracked(() => this.vehicleLayer.update(buses, selected));
    });
  }

  ngOnInit(): void {
    this.map = L.map('map', { center: JASLO_CENTRE, zoom: 14, zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(this.map);

    this.routeLayer.attach(this.map);
    if (this.editing) this.editorLayer.attach(this.map);
    else {
      this.vehicleLayer.attach(this.map);
      this.vehicleLayer.onSelect = key => this.selectBus(key);
    }
    this.map.on('click', (e: L.LeafletMouseEvent) => this.planner.setPointFromMap(e.latlng.lat, e.latlng.lng));
    this.stops.load().subscribe(stops => this.markers.renderStops(this.map, stops));
  }

  ngOnDestroy(): void {
    this.routeLayer.detach();
    this.editorLayer.detach();
    this.vehicleLayer.detach();
    this.map?.remove();
  }

  /** Shows a clicked bus in the side panel, moving the map so the panel doesn't cover it. */
  private selectBus(key: string): void {
    this.buses.select(key);
    const bus = this.buses.selected();
    const size = this.map.getSize();
    if (!bus || size.x < 768) return; // phones: the panel is a bottom sheet
    const x = this.map.latLngToContainerPoint([bus.lat, bus.lng]).x;
    const panelLeft = size.x - BUS_PANEL_WIDTH_PX - 32;
    if (x > panelLeft - 40) this.map.panBy([x - (panelLeft - 40) + 80, 0]);
  }

  /** Flies to a stop picked in the search box and opens its departures. */
  showStop(stop: Stop): void {
    this.map.once('moveend', () => this.markers.openStop(stop.id));
    this.map.flyTo([stop.lat, stop.lng], 17, { duration: 1 });
  }

  async locateUser(): Promise<void> {
    try {
      const p = await this.geolocation.locate();
      this.map.flyTo([p.lat, p.lng], 16);
    } catch (err) {
      console.warn(err);
    }
  }
}
