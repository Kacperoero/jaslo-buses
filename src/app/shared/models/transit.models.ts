/** A bus stop (public/assets/data/stops-base.json, built from the MKS GTFS) */
export interface Stop {
  /** GTFS stop_id from the MKS timetable (e.g. "13890365_1") */
  id: string;
  /** Numeric designator used internally */
  designator: number;
  /** Human-readable stop name */
  name: string;
  /** Latitude (geographic) */
  lat: number;
  /** Longitude (geographic) */
  lng: number;
  /** Whether the stop is only for disembarking */
  onlyDisembarking: boolean;
  /** 1: buses stop here in one direction only (one side of the road), 2: in both directions */
  directions?: 1 | 2;
  /** One-direction stops: the next stop buses usually go to from here */
  towards?: string;
}

/**
 * One departure from a stop. The shape follows the departure boards the app used before the
 * switch to GTFS, so the planner and popups work unchanged; live-only fields stay optional.
 */
export interface Departure {
  /** Bus line number/name */
  line_name?: string;
  line?: string;
  /** Departure time (formatted string, e.g., "7 min") */
  time: string;
  static_time?: string;
  /** Direction / destination id */
  direction_id?: number | string;
  /** Resolved direction / destination (for internal mapping) */
  direction?: string;
  /** Whether the time is estimated (real-time) or scheduled */
  is_estimated: boolean;
  /** Minutes until departure */
  minutes_to_departure?: number;
  /** Vehicle attributes (e.g. low-floor) */
  vehicle_attributes?: string[];
  /** Execution ID for real-time tracking of the specific trip */
  trip_execution_id?: string;
  /** Position of this stop in the trip's stop list (live departures) */
  trip_index?: number;
  /** The trip was cancelled (live departures) */
  canceled?: boolean;
  /** Bus is standing at the stop right now (live departures) */
  at_stop?: boolean;
}

/** Departure board of a stop */
export interface DeparturesResponse {
  timestamp: number;
  designator: number;
  station_name: string;
  only_disembarking: boolean;
  rows?: Departure[];
  directions?: Record<string, string>;
}

/** A stop on a trip, with its planned time */
export interface TripTime {
  stop_name: string;
  external: boolean;
  designator: number;
  place_id: string;
  departure_time: string;
  index: number;
}

/** A trip with its stop sequence (live fields like `vehicle` are not available from GTFS) */
export interface TripExecutionResponse {
  trip: {
    times: TripTime[];
    direction: string;
    current_station_id: number;
    line: {
      name: string;
      type: string;
      show_name: boolean;
    };
  };
  canceled: any[];
  vehicle_type: number;
  estimated: boolean;
  at_stop: boolean;
  vehicle?: {
    lon: number;
    lat: number;
  };
  next_departure_index: number;
  /** Expected arrivals, starting at the vehicle's next stop (`times[vehicle_trip_index]`) */
  estimates: TripEstimate[];
  vehicle_trip_index: number;
}

/** Expected arrival at one of the next stops of a live trip */
export interface TripEstimate {
  /** "HH:MM" */
  arrival_abs: string | null;
  time_abs: string | null;
  /** Minutes until arrival */
  to_go: number;
}

/** A direction/line serving a stop */
export interface StopDirection {
  /** Line number */
  line: string;
  /** Whether to show the line name */
  show_name: boolean;
  /** Direction name (destination) */
  direction: string;
  /** Whether this line is currently active */
  active: boolean;
}

