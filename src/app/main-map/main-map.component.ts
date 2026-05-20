import { Component, OnInit, OnDestroy, signal, computed } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import * as L from 'leaflet';
import { MapMarkerService } from '../features/map/services/map-marker.service';
import { Stop } from '../shared/models/transit.models';

@Component({
  selector: 'app-main-map',
  standalone: true,
  imports: [CommonModule, FormsModule],
  templateUrl: './main-map.component.html',
  styleUrl: './main-map.component.scss'
})
export class MainMapComponent implements OnInit, OnDestroy {
  private map!: L.Map;

  /** All loaded stops */
  allStops = signal<Stop[]>([]);

  /** Search query */
  searchQuery = signal('');

  /** Whether the search panel is open */
  searchOpen = signal(false);

  /** Filtered stops based on search query */
  filteredStops = computed(() => {
    const q = this.searchQuery().toLowerCase().trim();
    if (!q) return [];
    return this.allStops()
      .filter(s => s.name.toLowerCase().includes(q))
      .slice(0, 20);
  });

  /** Whether the app is loading stops */
  loading = signal(true);

  constructor(private mapMarkerService: MapMarkerService) {}

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

    // Add zoom control to bottom-right
    L.control.zoom({ position: 'bottomright' }).addTo(this.map);

    // OpenStreetMap tiles
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      maxZoom: 19
    }).addTo(this.map);

    // Load and render stops
    this.mapMarkerService.renderStops(this.map).then((stops) => {
      this.allStops.set(stops);
      this.loading.set(false);
    });
  }

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

    // Fly to stop and simulate a marker click
    this.map.flyTo([stop.lat, stop.lng], 17, {
      duration: 1
    });

    // After flying, open the popup
    setTimeout(() => {
      // Find and click the marker for this stop
      this.map.eachLayer((layer: any) => {
        if (layer instanceof L.Marker) {
          const pos = layer.getLatLng();
          if (
            Math.abs(pos.lat - stop.lat) < 0.00001 &&
            Math.abs(pos.lng - stop.lng) < 0.00001
          ) {
            layer.fire('click');
          }
        }
      });
    }, 1100);
  }

  locateUser(): void {
    this.map.locate({ setView: true, maxZoom: 16 });
  }
}
