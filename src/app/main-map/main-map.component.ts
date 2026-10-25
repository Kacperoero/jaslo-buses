import { Component, OnDestroy, OnInit, effect, inject, untracked } from '@angular/core';
import * as L from 'leaflet';
import { GeolocationService } from '../core/services/geolocation.service';
import { GtfsService } from '../core/services/gtfs.service';
import { ShapesService } from '../core/services/shapes.service';
import { StopsService } from '../core/services/stops.service';
import { MapMarkerService } from '../features/map/services/map-marker.service';
import { RouteLayerService } from '../features/map/services/route-layer.service';
import { PlannerPanelComponent } from '../features/route-planner/planner-panel/planner-panel.component';
import { PlannerStateService } from '../features/route-planner/planner-state.service';
import { StopSearchComponent } from '../features/stop-search/stop-search.component';
import { Stop } from '../shared/models/transit.models';

const JASLO_CENTRE: L.LatLngTuple = [49.745, 21.472];

/**
 * The map view: Leaflet map with stop markers, the planner's points and selected route,
 * and the controls drawn over it (stop search or planner panel, planner toggle, locate me).
 */
@Component({
  selector: 'app-main-map',
  standalone: true,
  imports: [StopSearchComponent, PlannerPanelComponent],
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
  }

  ngOnInit(): void {
    this.map = L.map('map', { center: JASLO_CENTRE, zoom: 14, zoomControl: false });
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(this.map);

    this.routeLayer.attach(this.map);
    this.map.on('click', (e: L.LeafletMouseEvent) => this.planner.setPointFromMap(e.latlng.lat, e.latlng.lng));
    this.stops.load().subscribe(stops => this.markers.renderStops(this.map, stops));
  }

  ngOnDestroy(): void {
    this.routeLayer.detach();
    this.map?.remove();
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
