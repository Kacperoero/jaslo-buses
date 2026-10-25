import { Injectable, inject } from '@angular/core';
import * as L from 'leaflet';
import { ShapesService } from '../../../core/services/shapes.service';
import { Stop } from '../../../shared/models/transit.models';
import { escapeHtml } from '../../../shared/utils/text.utils';
import { Connection, ConnectionPoint, rides } from '../../route-planner/route-planner.models';

const WALK_STYLE: L.PolylineOptions = { color: '#f43f5e', weight: 5, dashArray: '5, 10', opacity: 0.85 };
/** Width of the planner panel on wide screens (.planner-sidebar max-width) */
const PANEL_WIDTH_PX = 440;
/** Colours of the 1st, 2nd, 3rd… ride */
const LEG_COLORS = ['#10b981', '#06b6d4', '#8b5cf6', '#f59e0b'];

/**
 * Draws the planner on the map: points A/B and the selected connection – walks as dashed
 * straight lines, bus rides along the roads between the stops they pass (precomputed in
 * shapes.json, each ride in its own colour), dots at intermediate stops and markers where to
 * change. No external routing service is used.
 */
@Injectable({
  providedIn: 'root'
})
export class RouteLayerService {
  private shapes = inject(ShapesService);
  private map: L.Map | null = null;
  private readonly pointsLayer = L.layerGroup();
  private readonly routeLayer = L.layerGroup();

  attach(map: L.Map): void {
    this.map = map;
    this.routeLayer.addTo(map);
    this.pointsLayer.addTo(map);
  }

  detach(): void {
    this.routeLayer.remove();
    this.pointsLayer.remove();
    this.map = null;
  }

  drawPoints(start: ConnectionPoint | null, end: ConnectionPoint | null): void {
    this.pointsLayer.clearLayers();
    if (start) this.pointMarker(start, 'start', 'A', 'Punkt startowy').addTo(this.pointsLayer);
    if (end) this.pointMarker(end, 'end', 'B', 'Punkt docelowy').addTo(this.pointsLayer);
  }

  clearRoute(): void {
    this.routeLayer.clearLayers();
  }

  drawConnection(conn: Connection): void {
    this.routeLayer.clearLayers();
    if (!this.map) return;

    const all: L.LatLng[] = [];
    let rideNo = 0;
    for (const leg of conn.legs) {
      if (leg.kind === 'walk') {
        const line: L.LatLngTuple[] = [[leg.from.lat, leg.from.lng], [leg.to.lat, leg.to.lng]];
        L.polyline(line, WALK_STYLE)
          .bindPopup(`🚶‍♂️ ${escapeHtml(leg.to.stop ? `Dojście do: ${leg.to.name}` : 'Dojście do celu')} (${leg.minutes} min)`)
          .addTo(this.routeLayer);
        all.push(...line.map(p => L.latLng(p)));
        continue;
      }
      const color = LEG_COLORS[rideNo++ % LEG_COLORS.length];
      const path = this.shapes.path(leg.stops) as L.LatLngTuple[]; // along roads where known
      L.polyline(path, { color, weight: 7, opacity: 0.95 })
        .bindPopup(`🚌 Linia ${escapeHtml(leg.line)}: ${leg.departure} ${escapeHtml(leg.from.name)} → ${leg.arrival} ${escapeHtml(leg.to.name)}`)
        .addTo(this.routeLayer);
      for (const stop of leg.stops.slice(1, -1)) {
        L.circleMarker([stop.lat, stop.lng], { radius: 3.5, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1 })
          .bindTooltip(escapeHtml(stop.name))
          .addTo(this.routeLayer);
      }
      all.push(...path.map(p => L.latLng(p)));
    }

    // First / last stop and every change on top
    const rideLegs = rides(conn);
    rideLegs.forEach((ride, i) => {
      if (i === 0) this.stopMarker(ride.from, 'planned-start', 'Przystanek początkowy').addTo(this.routeLayer);
      else this.stopMarker(ride.from, 'planned-transfer', 'Przesiadka').addTo(this.routeLayer);
      if (i === rideLegs.length - 1) this.stopMarker(ride.to, 'planned-end', 'Przystanek końcowy').addTo(this.routeLayer);
      else if (rideLegs[i + 1].from.id !== ride.to.id) this.stopMarker(ride.to, 'planned-transfer', 'Przesiadka').addTo(this.routeLayer);
    });

    if (all.length) {
      // On wide screens the planner panel covers the left 440 px of the map – keep the route clear of it
      const left = window.innerWidth >= 768 ? PANEL_WIDTH_PX + 40 : 40;
      this.map.fitBounds(L.latLngBounds(all), { paddingTopLeft: [left, 40], paddingBottomRight: [40, 40] });
    }
  }

  private stopMarker(stop: Stop, cssClass: string, label: string): L.Marker {
    return L.marker([stop.lat, stop.lng], {
      icon: L.divIcon({
        className: 'bus-stop-marker planned',
        html: `<div class="marker-dot ${cssClass}"></div>`,
        iconSize: [16, 16],
        iconAnchor: [8, 8]
      })
    }).bindPopup(`<b>${label}:</b><br>${escapeHtml(stop.name)}`);
  }

  private pointMarker(point: ConnectionPoint, kind: 'start' | 'end', letter: string, label: string): L.Marker {
    return L.marker([point.lat, point.lng], {
      icon: L.divIcon({
        className: `user-point-marker ${kind}`,
        html: `<div class="pulse-ring"></div><div class="marker-pin ${kind}-pin"><span class="pin-text">${letter}</span></div>`,
        iconSize: [30, 30],
        iconAnchor: [15, 15]
      })
    }).bindPopup(`<b>${label}:</b><br>${escapeHtml(point.name)}`);
  }
}
