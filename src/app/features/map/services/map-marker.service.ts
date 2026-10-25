import { Injectable, effect } from '@angular/core';
import * as L from 'leaflet';
import { Stop } from '../../../shared/models/transit.models';
import { TimetableService } from '../../../core/services/timetable.service';
import { escapeHtml } from '../../../shared/utils/text.utils';
import { TravelTimeService } from '../../../core/services/travel-time.service';
import { FavoritesService } from '../../../core/services/favorites.service';

@Injectable({
  providedIn: 'root'
})
export class MapMarkerService {
  private markers: L.Marker[] = [];
  private markerById = new Map<string, L.Marker>();
  private map: L.Map | null = null;

  private readonly stopIcon = L.divIcon({
    className: 'bus-stop-marker',
    html: `<div class="marker-dot"></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7]
  });
  private readonly favoriteIcon = L.divIcon({
    className: 'bus-stop-marker favorite',
    html: `<div class="marker-dot"></div>`,
    iconSize: [16, 16],
    iconAnchor: [8, 8]
  });

  /** Whether markers are draggable (dev mode for position correction) */
  devMode = false;

  constructor(
    private timetableService: TimetableService,
    private travelTime: TravelTimeService,
    private favorites: FavoritesService
  ) {
    // Favourite stops get a different marker – also when starred from the search list
    let shown = new Set<string>();
    effect(() => {
      const now = new Set(this.favorites.favoriteStopIds());
      for (const id of new Set([...shown, ...now])) {
        if (shown.has(id) === now.has(id)) continue;
        this.markerById.get(id)?.setIcon(this.iconFor(id)).setZIndexOffset(now.has(id) ? 500 : 0);
      }
      shown = now;
    });
  }

  private iconFor(stopId: string): L.DivIcon {
    return this.favorites.isFavorite(stopId) ? this.favoriteIcon : this.stopIcon;
  }

  /** Draws a marker for every stop; clicking one opens its departures. */
  renderStops(map: L.Map, stops: Stop[]): void {
    this.map = map;
    this.clearMarkers();

    for (const stop of stops) {
      const marker = L.marker([stop.lat, stop.lng], {
        icon: this.iconFor(stop.id),
        // Favourites drawn above other stops
        zIndexOffset: this.favorites.isFavorite(stop.id) ? 500 : 0,
        draggable: this.devMode,
        title: stop.name
      });

      marker.on('click', () => this.onStopClick(map, marker, stop));

      if (this.devMode) {
        marker.on('dragend', (e: L.LeafletEvent) => {
          const pos = (e.target as L.Marker).getLatLng();
          console.log(`[DEV] Stop "${stop.name}" (${stop.id}) moved to:`,
            JSON.stringify({ ...stop, lat: pos.lat, lng: pos.lng }, null, 2));
        });
      }

      marker.addTo(map);
      this.markers.push(marker);
      this.markerById.set(stop.id, marker);
    }
  }

  /** Opens the departures popup of a stop (as if its marker was clicked). */
  openStop(stopId: string): void {
    const marker = this.markerById.get(stopId);
    if (marker && this.map) marker.fire('click');
  }

  private clearMarkers(): void {
    this.markers.forEach(m => m.remove());
    this.markers = [];
    this.markerById.clear();
  }

  private onStopClick(map: L.Map, marker: L.Marker, stop: Stop): void {
    this.favorites.addRecentStop(stop.id);

    // Create a loading popup
    const popup = L.popup({
      maxWidth: 340,
      minWidth: 280,
      className: 'departure-popup'
    })
      .setLatLng(marker.getLatLng())
      .setContent(this.buildLoadingPopup(stop))
      .openOn(map);
    this.bindFavoriteButton(popup, stop);

    // Live departures for "now", planned ones from the timetable for a chosen time
    this.timetableService.getDepartures(stop.id, this.travelTime.selected()).subscribe({
      next: (data) => {
        popup.setContent(this.buildDeparturePopup(stop, data));
        this.bindFavoriteButton(popup, stop);
      },
      error: () => {
        popup.setContent(this.buildErrorPopup(stop));
        this.bindFavoriteButton(popup, stop);
      }
    });
  }

  private buildHeader(stop: Stop): string {
    const fav = this.favorites.isFavorite(stop.id);
    return `
      <div class="popup-header">
        <span class="popup-icon">🚏</span>
        <h3 class="popup-title">${escapeHtml(stop.name)}</h3>
        ${stop.onlyDisembarking ? '<span class="badge-warn">Tylko wysiadanie</span>' : ''}
        ${directionBadge(stop)}
        <button type="button" class="popup-fav${fav ? ' active' : ''}"
                aria-pressed="${fav}" title="${fav ? 'Usuń z ulubionych' : 'Dodaj do ulubionych'}">
          ${fav ? '★' : '☆'}
        </button>
      </div>
    `;
  }

  /** The popup is plain HTML, so the star's click handler is attached after each content update. */
  private bindFavoriteButton(popup: L.Popup, stop: Stop): void {
    const button = popup.getElement()?.querySelector<HTMLButtonElement>('.popup-fav');
    if (!button) return;
    L.DomEvent.disableClickPropagation(button);
    button.addEventListener('click', () => {
      const fav = this.favorites.toggleFavorite(stop.id);
      button.classList.toggle('active', fav);
      button.textContent = fav ? '★' : '☆';
      button.title = fav ? 'Usuń z ulubionych' : 'Dodaj do ulubionych';
      button.setAttribute('aria-pressed', String(fav));
    });
  }

  private buildLoadingPopup(stop: Stop): string {
    return `
      <div class="popup-content">
        ${this.buildHeader(stop)}
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
    const scheduled = this.travelTime.isScheduled();
    let departures = '';

    if (rows.length === 0) {
      departures = `
        <div class="popup-empty">
          <span class="empty-icon">🌙</span>
          <p>${scheduled ? 'Brak odjazdów w ciągu 3 godzin' : 'Brak najbliższych odjazdów'}</p>
          <p class="empty-hint">${scheduled ? 'Wybierz inną godzinę lub dzień' : 'Sprawdź ponownie w godzinach kursowania'}</p>
        </div>
      `;
    } else {
      departures = `<div class="popup-departures">`;
      for (const row of rows.slice(0, 8)) {
        const estimatedBadge = row.canceled
          ? '<span class="badge-canceled">ODWOŁANY</span>'
          : row.is_estimated
            ? '<span class="badge-live">LIVE</span>'
            : '';
        // Scheduled mode: clock time is more useful than "in N min" from a future moment
        const timeDisplay = scheduled && row.static_time
          ? row.static_time
          : row.minutes_to_departure != null
            ? `${row.minutes_to_departure} min`
            : row.time || '—';

        const line = row.line_name || row.line || '?';
        const direction = (row.direction_id && directions[row.direction_id]) || row.direction || 'Brak kierunku';

        departures += `
          <div class="departure-row${row.canceled ? ' canceled' : ''}">
            <span class="dep-line">${escapeHtml(line)}</span>
            <span class="dep-direction">${escapeHtml(direction)}</span>
            <span class="dep-time">${escapeHtml(timeDisplay)}${estimatedBadge}</span>
          </div>
        `;
      }
      departures += `</div>`;
    }

    return `
      <div class="popup-content">
        ${this.buildHeader(stop)}
        <div class="popup-schedule-note">🕒 ${scheduled
          ? `Rozkład: ${escapeHtml(this.travelTime.label())}`
          : 'Według rozkładu jazdy (bez opóźnień)'}</div>
        ${departures}
      </div>
    `;
  }

  private buildErrorPopup(stop: Stop): string {
    return `
      <div class="popup-content">
        ${this.buildHeader(stop)}
        <div class="popup-error">
          <span>⚠️</span>
          <p>Nie udało się pobrać odjazdów</p>
        </div>
      </div>
    `;
  }
}

/** "↔ oba kierunki" / "→ w stronę: …" under the stop name. */
function directionBadge(stop: Stop): string {
  if (stop.directions === 2) {
    return '<span class="badge-direction" title="Autobusy zatrzymują się tu w obu kierunkach">↔ oba kierunki</span>';
  }
  if (stop.directions === 1) {
    const towards = stop.towards ? ` w stronę: ${escapeHtml(stop.towards.replace('JASŁO,ul.', ''))}` : '';
    return `<span class="badge-direction" title="Autobusy zatrzymują się tu tylko w jednym kierunku">→ jeden kierunek${towards}</span>`;
  }
  return '';
}
