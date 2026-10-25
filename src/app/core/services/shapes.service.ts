import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Stop } from '../../shared/models/transit.models';

interface ShapesFile {
  source: string;
  builtAt: string;
  /** "fromStopId>toStopId" → encoded polyline of the road between two consecutive stops */
  shapes: Record<string, string>;
}

/**
 * Road-following lines between consecutive stops (public/assets/data/shapes.json, computed by
 * scripts/gtfs/build-shapes.mjs from OpenStreetMap roads). Without a line for a pair of stops
 * – or before the file is loaded – rides are drawn straight from stop to stop.
 */
@Injectable({
  providedIn: 'root'
})
export class ShapesService {
  private http = inject(HttpClient);
  private encoded: Record<string, string> = {};
  private decoded = new Map<string, [number, number][]>();

  /** Becomes true once the lines are loaded – drawings can then be redone along roads */
  readonly loaded = signal(false);

  load(): void {
    this.http.get<ShapesFile>('assets/data/shapes.json').subscribe({
      next: file => {
        this.encoded = file.shapes ?? {};
        this.decoded.clear();
        this.loaded.set(true);
      },
      error: err => console.warn('Road shapes not available, drawing straight lines', err)
    });
  }

  /** Points of a ride through `stops`, along roads where known. */
  path(stops: Stop[]): [number, number][] {
    if (stops.length === 0) return [];
    const points: [number, number][] = [[stops[0].lat, stops[0].lng]];
    for (let i = 1; i < stops.length; i++) {
      const road = this.between(stops[i - 1].id, stops[i].id);
      if (road) points.push(...road.slice(1));
      else points.push([stops[i].lat, stops[i].lng]);
    }
    return points;
  }

  private between(from: string, to: string): [number, number][] | null {
    const key = `${from}>${to}`;
    let points = this.decoded.get(key);
    if (!points) {
      const enc = this.encoded[key];
      if (!enc) return null;
      points = decodePolyline(enc);
      this.decoded.set(key, points);
    }
    return points;
  }
}

/** Google encoded polyline (precision 5) → [lat, lng] points. */
export function decodePolyline(str: string): [number, number][] {
  const points: [number, number][] = [];
  let i = 0, lat = 0, lng = 0;
  while (i < str.length) {
    for (let k = 0; k < 2; k++) {
      let b: number, shift = 0, result = 0;
      do {
        b = str.charCodeAt(i++) - 63;
        result |= (b & 0x1f) << shift;
        shift += 5;
      } while (b >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (k === 0) lat += delta;
      else lng += delta;
    }
    points.push([lat / 1e5, lng / 1e5]);
  }
  return points;
}
