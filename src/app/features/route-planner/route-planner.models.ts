import { Departure, Stop } from '../../shared/models/transit.models';

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

/** One bus ride within a transfer connection. */
export interface ConnectionLeg {
  startStop: Stop;
  endStop: Stop;
  line: string;
  nextDeparture: Departure | null;
  busTime: number;
  departureTimeAbs: string;
  arrivalTimeAbs: string;
  waitingTimeAtStop: number;
}

/** A suggested trip from A to B: walk → bus (→ transfer → bus) → walk. */
export interface Connection {
  startStop: Stop;
  endStop: Stop;
  /** Line name, or "10 ➔ A" for transfers */
  line: string;
  /** Next departure from the start stop; null when the line has no trip coming up */
  nextDeparture: Departure | null;
  walkTimeStart: number; // minutes
  walkTimeEnd: number;   // minutes
  busTime: number;       // minutes
  totalTime: number;     // minutes
  /** "HH:MM", or "Brak kursu" when there is no upcoming trip */
  departureTimeAbs?: string;
  arrivalTimeAbs?: string;
  waitingTimeAtStop?: number;

  // Transfer support
  isTransfer?: boolean;
  legs?: ConnectionLeg[];
  transferStop?: Stop;
  walkTimeTransfer?: number; // Wait/walk at transfer point in minutes
}

/** A stop together with its distance (metres) from some point. */
export interface StopCandidate {
  stop: Stop;
  distance: number;
}
