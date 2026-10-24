/** Represents a bus stop from the local stops registry */
export interface Stop {
  /** Unique ID matching the MKS/KiedyPrzyjedzie system (e.g. "1332005:1392084") */
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
}

/** Single departure row from the API */
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

/** Response from the departures API endpoint */
export interface DeparturesResponse {
  timestamp: number;
  designator: number;
  station_name: string;
  only_disembarking: boolean;
  rows?: Departure[];
  directions?: Record<string, string>;
}

/** Represents a stop in a trip execution sequence */
export interface TripTime {
  stop_name: string;
  external: boolean;
  designator: number;
  place_id: string;
  departure_time: string;
  index: number;
}

/** Response from the trip execution API endpoint */
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

/** Response from GET /api/departures?places=a,b,c (live departures of up to 6 stops) */
export interface MultiDeparturesResponse {
  status: string;
  departures: { designator: number; rows: Departure[] }[];
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

/** Response from the directions API endpoint */
export interface DirectionsResponse {
  directions: StopDirection[];
}

// ─── Static timetable (planned schedule for a chosen date) ───

/** One planned departure from GET /api/timetable/{stopId}/{line}?date=YYYY-MM-DD */
export interface ScheduledDeparture {
  /** Departure time in seconds after midnight of the requested date */
  departure: number;
  line?: string;
  /** Symbols of non-default directions/notes for this departure (e.g. "B") */
  symbols: string;
  trip_id: number;
  /** Index of this stop within the trip – needed by GET /api/trip/{tripId}/{index} */
  index: number;
}

/** Response from GET /api/timetable/{stopId}/{base64url(line)}?date=YYYY-MM-DD */
export interface LineTimetableResponse {
  departures: ScheduledDeparture[];
  /** Alternative directions, referenced by `symbols` on a departure */
  directions: { name: string; symbol: string }[];
  /** Default direction for departures without a direction symbol */
  main_direction: { name: string; count: number; symbol: string | null };
  show_line_name?: boolean;
}

/** Response from GET /api/trip/{tripId}/{index} (planned stop sequence of a trip) */
export interface TripResponse {
  times: TripTime[];
  direction: string;
  current_station_id: number;
  line: { name: string; type: string; show_name: boolean };
  vehicle_type: number;
}
