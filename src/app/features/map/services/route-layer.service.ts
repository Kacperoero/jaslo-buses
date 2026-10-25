import { Injectable, inject } from '@angular/core';
import * as L from 'leaflet';
import { firstValueFrom } from 'rxjs';
import { StopsService } from '../../../core/services/stops.service';
import { TimetableService } from '../../../core/services/timetable.service';
import { Departure, Stop } from '../../../shared/models/transit.models';
import { escapeHtml } from '../../../shared/utils/text.utils';
import { Connection, ConnectionPoint } from '../../route-planner/route-planner.models';
import { stopsBetween } from '../../route-planner/ride-path';

const WALK_STYLE: L.PolylineOptions = { color: '#f43f5e', weight: 5, dashArray: '5, 10', opacity: 0.85 };
const LEG_COLORS = ['#10b981', '#06b6d4'];

/**
 * Draws the planner on the map: points A/B and the selected connection – walks as dashed
 * straight lines, bus rides along the stops the bus actually passes (from the timetable),
 * with small dots at intermediate stops. No external routing service is used.
 */
@Injectable({
  providedIn: 'root'
})
export class RouteLayerService {
  private timetable = inject(TimetableService);
  private stops = inject(StopsService);

  private map: L.Map | null = null;
  private readonly pointsLayer = L.layerGroup();
  private readonly routeLayer = L.layerGroup();
  /** Incremented per drawn route, so a slower earlier draw can't overwrite a newer one */
  private drawCounter = 0;

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
    this.drawCounter++;
    this.routeLayer.clearLayers();
  }

  async drawConnection(conn: Connection, start: ConnectionPoint, end: ConnectionPoint): Promise<void> {
    this.routeLayer.clearLayers();
    const drawId = ++this.drawCounter;

    const rides: { dep: Departure | null; from: Stop; to: Stop; line: string; label: string }[] =
      conn.isTransfer && conn.legs?.length === 2 && conn.transferStop
        ? [
            { dep: conn.legs[0].nextDeparture, from: conn.startStop, to: conn.transferStop, line: conn.legs[0].line, label: ' (etap 1)' },
            { dep: conn.legs[1].nextDeparture, from: conn.transferStop, to: conn.endStop, line: conn.legs[1].line, label: ' (etap 2)' }
          ]
        : [{ dep: conn.nextDeparture, from: conn.startStop, to: conn.endStop, line: conn.line, label: '' }];

    const paths = await Promise.all(rides.map(r => this.ridePath(r.dep, r.from, r.to)));
    if (drawId !== this.drawCounter || !this.map) return; // another route was drawn meanwhile

    const all: L.LatLng[] = [];
    const walk = (a: L.LatLngTuple, b: L.LatLngTuple, label: string) => {
      L.polyline([a, b], WALK_STYLE).bindPopup(`🚶‍♂️ ${label}`).addTo(this.routeLayer);
      all.push(L.latLng(a), L.latLng(b));
    };

    walk([start.lat, start.lng], [conn.startStop.lat, conn.startStop.lng], 'Dojście do przystanku');
    rides.forEach((ride, i) => {
      const color = LEG_COLORS[i];
      const path = paths[i];
      L.polyline(path.map(s => [s.lat, s.lng] as L.LatLngTuple), { color, weight: 7, opacity: 0.95 })
        .bindPopup(`🚌 Linia ${escapeHtml(ride.line)}${ride.label}`)
        .addTo(this.routeLayer);
      for (const stop of path.slice(1, -1)) {
        L.circleMarker([stop.lat, stop.lng], { radius: 3.5, color: '#fff', weight: 1.5, fillColor: color, fillOpacity: 1 })
          .bindTooltip(escapeHtml(stop.name))
          .addTo(this.routeLayer);
      }
      all.push(...path.map(s => L.latLng(s.lat, s.lng)));
    });
    walk([conn.endStop.lat, conn.endStop.lng], [end.lat, end.lng], 'Dojście do celu');

    // Start, transfer and end stop markers on top
    this.stopMarker(conn.startStop, 'planned-start', 'Przystanek początkowy').addTo(this.routeLayer);
    if (conn.isTransfer && conn.transferStop) {
      this.stopMarker(conn.transferStop, 'planned-transfer', 'Punkt przesiadkowy').addTo(this.routeLayer);
    }
    this.stopMarker(conn.endStop, 'planned-end', 'Przystanek końcowy').addTo(this.routeLayer);

    this.map.fitBounds(L.latLngBounds(all), { padding: [40, 40] });
  }

  /** Stops the bus passes from `from` to `to` on this departure's trip (straight line if unknown). */
  private async ridePath(dep: Departure | null, from: Stop, to: Stop): Promise<Stop[]> {
    if (dep?.trip_execution_id) {
      try {
        const exec = await firstValueFrom(this.timetable.getTripExecution(dep.trip_execution_id));
        const byId = this.stops.byId();
        const stops = stopsBetween(exec.trip.times, dep.trip_index ?? 0, from.id, to.id)
          .map(id => byId.get(id))
          .filter((s): s is Stop => !!s);
        if (stops.length >= 2) return stops;
      } catch {
        // fall through to a straight line
      }
    }
    return [from, to];
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
