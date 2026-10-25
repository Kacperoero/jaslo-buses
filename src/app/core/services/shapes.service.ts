import { Injectable, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Stop } from '../../shared/models/transit.models';

/** Part of a ride: along known roads, or straight where the route between stops is unknown. */
export interface PathPart {
  points: [number, number][];
  /** false: no road line between these stops (e.g. a gap in OpenStreetMap) – drawn straight */
  known: boolean;
}

interface ShapesFile {
  source: string;
  builtAt: string;
  /** "fromStopId>toStopId" → encoded polyline of the road between two consecutive stops */
  shapes: Record<string, string>;
  /** Where buses stop on the road: per stop id, one [lat, lng, travel bearing] per direction */
  roadPoints?: Record<string, [number, number, number | null][]>;
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

  /**
   * A ride through `stops` split into parts along known roads and straight parts where the
   * route is unknown. Before the road lines are loaded everything counts as known (drawn
   * straight for a moment, then redrawn), so the map doesn't flash "unknown" everywhere.
   */
  parts(stops: Stop[]): PathPart[] {
    // Road lines run from the road point at one stop to the road point at the next; a straight
    // (unknown) part joins the end of the previous road line to the start of the next one
    const roads = stops.slice(1).map((b, i) => this.between(stops[i].id, b.id));
    const parts: PathPart[] = [];
    roads.forEach((road, i) => {
      const known = !!road || !this.loaded();
      const points: [number, number][] = road ?? [
        roads[i - 1]?.at(-1) ?? [stops[i].lat, stops[i].lng],
        roads[i + 1]?.[0] ?? [stops[i + 1].lat, stops[i + 1].lng]
      ];
      const last = parts[parts.length - 1];
      if (last && last.known === known) last.points.push(...points.slice(samePoint(last.points.at(-1), points[0]) ? 1 : 0));
      else parts.push({ known, points: [...points] });
    });
    return parts;
  }

  /** All points of a ride through `stops` (along roads where known). */
  path(stops: Stop[]): [number, number][] {
    if (stops.length === 0) return [];
    const parts = this.parts(stops);
    if (parts.length === 0) return [[stops[0].lat, stops[0].lng]];
    return [parts[0].points[0], ...parts.flatMap(p => p.points.slice(1))];
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

function samePoint(p?: [number, number], q?: [number, number]): boolean {
  return !!p && !!q && p[0] === q[0] && p[1] === q[1];
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
