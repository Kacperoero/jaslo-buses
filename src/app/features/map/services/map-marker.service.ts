import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import * as L from 'leaflet';
import { Stop } from '../../../shared/models/transit.models';
import { TimetableService } from '../../../core/services/timetable.service';

@Injectable({
  providedIn: 'root'
})
export class MapMarkerService {
  private markers: L.Marker[] = [];
  private stops: Stop[] = [];

  /** Whether markers are draggable (dev mode for position correction) */
  devMode = false;

  constructor(
    private http: HttpClient,
    private timetableService: TimetableService
  ) {}

  /**
   * Load stops from local JSON and render markers on the map.
   * Returns the loaded stops array for use elsewhere.
   */
  renderStops(map: L.Map): Promise<Stop[]> {
    return new Promise((resolve) => {
      this.http.get<Stop[]>('assets/data/stops-base.json').subscribe({
        next: (stops) => {
          this.stops = stops;
          this.clearMarkers();

          const busIcon = L.divIcon({
            className: 'bus-stop-marker',
            html: `<div class="marker-dot"></div>`,
            iconSize: [14, 14],
            iconAnchor: [7, 7]
          });

          for (const stop of stops) {
            const marker = L.marker([stop.lat, stop.lng], {
              icon: busIcon,
              draggable: this.devMode,
              title: stop.name
            });

            marker.on('click', () => {
              this.onStopClick(map, marker, stop);
            });

            if (this.devMode) {
              marker.on('dragend', (e: L.LeafletEvent) => {
                const m = e.target as L.Marker;
                const pos = m.getLatLng();
                console.log(
                  `[DEV] Stop "${stop.name}" (${stop.id}) moved to:`,
                  JSON.stringify({
                    ...stop,
                    lat: pos.lat,
                    lng: pos.lng
                  }, null, 2)
                );
              });
            }

            marker.addTo(map);
            this.markers.push(marker);
          }
          resolve(stops);
        },
        error: (err) => {
          console.error('Failed to load stops:', err);
          resolve([]);
        }
      });
    });
  }

  getStops(): Stop[] {
    return this.stops;
  }

  private clearMarkers(): void {
    this.markers.forEach(m => m.remove());
    this.markers = [];
  }

  private onStopClick(map: L.Map, marker: L.Marker, stop: Stop): void {
    // Create a loading popup
    const popup = L.popup({
      maxWidth: 340,
      minWidth: 280,
      className: 'departure-popup'
    })
      .setLatLng(marker.getLatLng())
      .setContent(this.buildLoadingPopup(stop))
      .openOn(map);

    // Fetch both departures and directions
    this.timetableService.getDeparturesForStop(stop.id).subscribe({
      next: (data) => {
        popup.setContent(this.buildDeparturePopup(stop, data));
      },
      error: () => {
        popup.setContent(this.buildErrorPopup(stop));
      }
    });
  }

  private buildLoadingPopup(stop: Stop): string {
    return `
      <div class="popup-content">
        <div class="popup-header">
          <span class="popup-icon">🚏</span>
          <h3 class="popup-title">${stop.name}</h3>
        </div>
        <div class="popup-loading">
          <div class="loading-spinner"></div>
          <span>Ładowanie odjazdów…</span>
        </div>
      </div>
    `;
  }

  private buildDeparturePopup(stop: Stop, data: any): string {
    const rows = data.rows || [];
    const directions = data.directions || {};
    let departures = '';

    if (rows.length === 0) {
      departures = `
        <div class="popup-empty">
          <span class="empty-icon">🌙</span>
          <p>Brak najbliższych odjazdów</p>
          <p class="empty-hint">Sprawdź ponownie w godzinach kursowania</p>
        </div>
      `;
    } else {
      departures = `<div class="popup-departures">`;
      for (const row of rows.slice(0, 8)) {
        const estimatedBadge = row.is_estimated
          ? '<span class="badge-live">LIVE</span>'
          : '';
        const timeDisplay = row.minutes_to_departure != null
          ? `${row.minutes_to_departure} min`
          : row.time || '—';

        const line = row.line_name || row.line || '?';
        const direction = (row.direction_id && directions[row.direction_id]) || row.direction || 'Brak kierunku';

        departures += `
          <div class="departure-row">
            <span class="dep-line">${line}</span>
            <span class="dep-direction">${direction}</span>
            <span class="dep-time">${timeDisplay}${estimatedBadge}</span>
          </div>
        `;
      }
      departures += `</div>`;
    }

    return `
      <div class="popup-content">
        <div class="popup-header">
          <span class="popup-icon">🚏</span>
          <h3 class="popup-title">${stop.name}</h3>
          ${stop.onlyDisembarking ? '<span class="badge-warn">Tylko wysiadanie</span>' : ''}
        </div>
        ${departures}
      </div>
    `;
  }

  private buildErrorPopup(stop: Stop): string {
    return `
      <div class="popup-content">
        <div class="popup-header">
          <span class="popup-icon">🚏</span>
          <h3 class="popup-title">${stop.name}</h3>
        </div>
        <div class="popup-error">
          <span>⚠️</span>
          <p>Nie udało się pobrać odjazdów</p>
        </div>
      </div>
    `;
  }
}
