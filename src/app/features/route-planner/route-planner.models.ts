import { Stop } from '../../shared/models/transit.models';

/** Start or end point chosen by the user: a stop, a map click or their location. */
export interface ConnectionPoint {
  lat: number;
  lng: number;
  name: string;
  isStop?: boolean;
  stopId?: string;
  /** The user's GPS position – never saved to recent routes */
  isUserLocation?: boolean;
}

/** "Wyjeżdżam o…" (leave at) or "Chcę być na miejscu o…" (arrive by) */
export type TimeMode = 'depart' | 'arrive';

/** A place a walk starts or ends at: a stop, or the user's point A / B. */
export interface Place {
  name: string;
  lat: number;
  lng: number;
  stop?: Stop;
}

/** Walking: to the first stop, between stops when changing buses, or to the destination. */
export interface WalkLeg {
  kind: 'walk';
  from: Place;
  to: Place;
  minutes: number;
  meters: number;
}

/** A bus ride from boarding to getting off. */
export interface RideLeg {
  kind: 'ride';
  /** Line number, "–" when the timetable doesn't say */
  line: string;
  headsign: string;
  from: Stop;
  to: Stop;
  /** "HH:MM" */
  departure: string;
  arrival: string;
  /** The same as minutes after the reference midnight */
  departureMin: number;
  arrivalMin: number;
  minutes: number;
  /** Every stop of the ride, from boarding to getting off (for drawing the route) */
  stops: Stop[];
  /** Trip id ("trip:<trip>:<boarding position>") */
  tripId: string;
}

export type Leg = WalkLeg | RideLeg;

/** A suggested journey from A to B: walks and bus rides in order. */
export interface Connection {
  legs: Leg[];
  /** When to leave point A, "HH:MM" */
  leaveAt: string;
  /** Arrival at point B, "HH:MM" */
  arriveAt: string;
  /** From leaving A to arriving at B */
  totalMinutes: number;
  /** Waiting at the first stop after walking there */
  waitMinutes: number;
  /** Number of bus changes (rides − 1) */
  transfers: number;
  /** Minutes after the reference midnight – for sorting and comparing */
  leaveMin: number;
  arriveMin: number;
}

/** Rides of a connection (helper for templates and drawing). */
export function rides(conn: Connection): RideLeg[] {
  return conn.legs.filter((l): l is RideLeg => l.kind === 'ride');
}
