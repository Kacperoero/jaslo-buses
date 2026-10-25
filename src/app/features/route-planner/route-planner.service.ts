import { Injectable, inject } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { GtfsIndex, GtfsService } from '../../core/services/gtfs.service';
import { Access, RaptorNetwork, clock, distanceM, pickBest, plan, walkMinutes } from './raptor';
import { Connection, ConnectionPoint, Place, TimeMode } from './route-planner.models';

/** Stops this close to a map point are considered for walking to / from it. */
const ACCESS_RADIUS_M = 1000;
/** …but at most this many (nearest first). */
const MAX_ACCESS_STOPS = 12;
/** Other platforms of a selected stop (same name) closer than this are considered too. */
const SIBLING_STOP_MAX_M = 400;
/** Offer walking all the way when it takes at most this long. */
const MAX_WALK_ONLY_MIN = 25;
const MAX_RESULTS = 6;

export interface PlanOptions {
  /** Leave at (depart) or arrive by (arrive) this moment */
  time: Date;
  mode: TimeMode;
}

/**
 * Finds journeys between two points on the official timetable with RAPTOR: any number of
 * changes up to 3, walking between nearby stops when changing, "leave at" or "arrive by".
 */
@Injectable({
  providedIn: 'root'
})
export class RoutePlannerService {
  private gtfs = inject(GtfsService);
  private network: RaptorNetwork | null = null;

  async findConnections(start: ConnectionPoint, end: ConnectionPoint, options: PlanOptions): Promise<Connection[]> {
    const net = this.networkFor(await firstValueFrom(this.gtfs.index()));
    const t = options.time;
    const date = new Date(t.getFullYear(), t.getMonth(), t.getDate());
    const timeMin = t.getHours() * 60 + t.getMinutes();

    const found = plan(net, {
      access: this.accessFor(start, net),
      egress: this.accessFor(end, net),
      origin: toPlace(start),
      destination: toPlace(end),
      date,
      timeMin,
      mode: options.mode,
      limit: MAX_RESULTS
    });

    const walking = walkOnly(start, end, timeMin, options.mode);
    return pickBest(walking ? [...found, walking] : found, options.mode, MAX_RESULTS);
  }

  private networkFor(index: GtfsIndex): RaptorNetwork {
    if (!this.network || this.network.index !== index) this.network = new RaptorNetwork(index);
    return this.network;
  }

  /**
   * Stops to walk to from a point: a selected stop and its other platforms (same name, nearby),
   * or the stops around a map point.
   */
  private accessFor(point: ConnectionPoint, net: RaptorNetwork): Access[] {
    const stops = net.index.stops;
    const near = (lat: number, lng: number) => stops
      .map(([, , sLat, sLng], stop) => ({ stop, meters: distanceM(lat, lng, sLat, sLng) }));

    if (point.isStop && point.stopId) {
      const selected = net.index.stopPosition(point.stopId);
      if (selected !== undefined) {
        const [, name, lat, lng] = stops[selected];
        return near(lat, lng)
          .filter(c => c.stop === selected || (stops[c.stop][1] === name && c.meters <= SIBLING_STOP_MAX_M))
          .map(c => ({ stop: c.stop, meters: c.stop === selected ? 0 : c.meters, minutes: c.stop === selected ? 0 : walkMinutes(c.meters) }));
      }
    }

    const sorted = near(point.lat, point.lng).sort((a, b) => a.meters - b.meters);
    const inRadius = sorted.filter(c => c.meters <= ACCESS_RADIUS_M).slice(0, MAX_ACCESS_STOPS);
    return (inRadius.length > 0 ? inRadius : sorted.slice(0, 3))
      .map(c => ({ stop: c.stop, meters: c.meters, minutes: walkMinutes(c.meters) }));
  }
}

function toPlace(p: ConnectionPoint): Place {
  return { name: p.name, lat: p.lat, lng: p.lng };
}

/** Walking from A to B, when they are close enough. */
function walkOnly(start: ConnectionPoint, end: ConnectionPoint, timeMin: number, mode: TimeMode): Connection | null {
  const meters = distanceM(start.lat, start.lng, end.lat, end.lng);
  const minutes = walkMinutes(meters);
  if (minutes > MAX_WALK_ONLY_MIN || minutes === 0) return null;
  const leaveMin = mode === 'depart' ? timeMin : timeMin - minutes;
  return {
    legs: [{ kind: 'walk', from: toPlace(start), to: toPlace(end), minutes, meters: Math.round(meters) }],
    leaveAt: clock(leaveMin),
    arriveAt: clock(leaveMin + minutes),
    totalMinutes: minutes,
    waitMinutes: 0,
    transfers: -1,
    leaveMin,
    arriveMin: leaveMin + minutes
  };
}
