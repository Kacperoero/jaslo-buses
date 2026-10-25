import { Injectable, inject } from '@angular/core';
import * as L from 'leaflet';
import { ShapesService } from '../../core/services/shapes.service';
import { StopsService } from '../../core/services/stops.service';
import { Stop } from '../../shared/models/transit.models';
import { escapeHtml } from '../../shared/utils/text.utils';
import { RoadPoint } from './stop-editor.service';

const ARRIVING = '#f59e0b';
const LEAVING = '#10b981';
/** Width of the editor panel (.editor-overlay max-width) */
const PANEL_WIDTH_PX = 400;

/** What the editor shows for the current stop */
export interface EditorView {
  stop: Stop;
  position: [number, number];
  roadPoints: RoadPoint[];
  onMoveStop: (lat: number, lng: number) => void;
  onMoveRoadPoint: (index: number, lat: number, lng: number) => void;
}

/**
 * Map drawing of the stop editor: the stop being checked (draggable blue marker), its road points
 * (draggable red arrows pointing the direction of travel) and the road lines arriving at it
 * (orange) and leaving it (green).
 */
@Injectable({
  providedIn: 'root'
})
export class StopEditorLayerService {
  private shapes = inject(ShapesService);
  private stops = inject(StopsService);
  private map: L.Map | null = null;
  private readonly layer = L.layerGroup();
  private shownId: string | null = null;

  attach(map: L.Map): void {
    this.map = map;
    this.layer.addTo(map);
  }

  detach(): void {
    this.layer.remove();
    this.map = null;
    this.shownId = null;
  }

  show(view: EditorView | null): void {
    this.layer.clearLayers();
    if (!view || !this.map) return;
    const { stop, position } = view;
    const byId = this.stops.byId();

    for (const line of this.shapes.linesAt(stop.id)) {
      const leaving = line.from === stop.id;
      const other = byId.get(leaving ? line.to : line.from)?.name ?? '';
      L.polyline(line.points, { color: leaving ? LEAVING : ARRIVING, weight: 5, opacity: 0.8 })
        .bindTooltip(escapeHtml(leaving ? `→ ${other}` : `${other} →`), { sticky: true })
        .addTo(this.layer);
    }

    view.roadPoints.forEach(([lat, lng, bearing], i) => {
      L.polyline([position, [lat, lng]], { color: '#dc2626', weight: 2, dashArray: '3, 4', interactive: false })
        .addTo(this.layer);
      L.marker([lat, lng], {
        draggable: true,
        zIndexOffset: 1000,
        title: 'Punkt zatrzymania na drodze – przeciągnij',
        icon: L.divIcon({
          className: 'editor-road-point',
          html: `<div style="transform: rotate(${bearing ?? 0}deg)">${bearing === null ? '●' : '▲'}</div>`,
          iconSize: [22, 22],
          iconAnchor: [11, 11]
        })
      })
        .on('dragend', e => {
          const p = (e.target as L.Marker).getLatLng();
          view.onMoveRoadPoint(i, p.lat, p.lng);
        })
        .addTo(this.layer);
    });

    L.marker(position, {
      draggable: true,
      zIndexOffset: 900,
      title: 'Przystanek – przeciągnij tam, gdzie stoi wiata',
      icon: L.divIcon({ className: 'editor-stop', html: '<div></div>', iconSize: [26, 26], iconAnchor: [13, 13] })
    })
      .on('dragend', e => {
        const p = (e.target as L.Marker).getLatLng();
        view.onMoveStop(p.lat, p.lng);
      })
      .addTo(this.layer);

    // Centre on a newly chosen stop (not after every drag)
    if (this.shownId !== stop.id) {
      this.shownId = stop.id;
      this.map.setView(position, Math.max(this.map.getZoom(), 18), { animate: false });
      // Keep the stop clear of the editor panel on wide screens
      if (this.map.getSize().x > PANEL_WIDTH_PX * 2) this.map.panBy([-PANEL_WIDTH_PX / 2, 0], { animate: false });
    }
  }
}
