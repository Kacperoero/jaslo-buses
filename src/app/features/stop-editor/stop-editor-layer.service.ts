import { Injectable, inject } from '@angular/core';
import * as L from 'leaflet';
import { ShapesService } from '../../core/services/shapes.service';
import { StopsService } from '../../core/services/stops.service';
import { Stop } from '../../shared/models/transit.models';
import { escapeHtml } from '../../shared/utils/text.utils';

const ARRIVING = '#f59e0b';
const LEAVING = '#10b981';
/** Width of the editor panel (.editor-overlay max-width) */
const PANEL_WIDTH_PX = 400;

/**
 * Map drawing of the stop editor: the stop being checked, its road points (arrow = direction of
 * travel) and the road lines arriving at it (orange) and leaving it (green).
 */
@Injectable({
  providedIn: 'root'
})
export class StopEditorLayerService {
  private shapes = inject(ShapesService);
  private stops = inject(StopsService);
  private map: L.Map | null = null;
  private readonly layer = L.layerGroup();

  attach(map: L.Map): void {
    this.map = map;
    this.layer.addTo(map);
  }

  detach(): void {
    this.layer.remove();
    this.map = null;
  }

  show(stop: Stop | null): void {
    this.layer.clearLayers();
    if (!stop || !this.map) return;
    const byId = this.stops.byId();

    for (const line of this.shapes.linesAt(stop.id)) {
      const leaving = line.from === stop.id;
      const other = byId.get(leaving ? line.to : line.from)?.name ?? '';
      L.polyline(line.points, { color: leaving ? LEAVING : ARRIVING, weight: 5, opacity: 0.8 })
        .bindTooltip(escapeHtml(leaving ? `→ ${other}` : `${other} →`), { sticky: true })
        .addTo(this.layer);
    }

    L.circleMarker([stop.lat, stop.lng], { radius: 14, color: '#2563eb', weight: 3, fill: false, interactive: false })
      .addTo(this.layer);

    for (const p of this.shapes.roadPoints(stop.id)) {
      L.polyline([[stop.lat, stop.lng], [p.lat, p.lng]], { color: '#dc2626', weight: 2, dashArray: '3, 4', interactive: false })
        .addTo(this.layer);
      const arrow = p.bearing === null ? '●' : '▲';
      L.marker([p.lat, p.lng], {
        interactive: false,
        zIndexOffset: 1000,
        icon: L.divIcon({
          className: 'editor-road-point',
          html: `<div style="transform: rotate(${p.bearing ?? 0}deg)">${arrow}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        })
      }).addTo(this.layer);
    }

    this.map.setView([stop.lat, stop.lng], Math.max(this.map.getZoom(), 18), { animate: false });
    // Keep the stop clear of the editor panel on wide screens
    if (this.map.getSize().x > PANEL_WIDTH_PX * 2) this.map.panBy([-PANEL_WIDTH_PX / 2, 0], { animate: false });
  }
}
