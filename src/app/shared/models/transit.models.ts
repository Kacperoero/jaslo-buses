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
  line: string;
  /** Departure time (formatted string) */
  time: string;
  /** Direction / destination */
  direction: string;
  /** Whether the time is estimated (real-time) or scheduled */
  is_estimated: boolean;
  /** Minutes until departure */
  minutes_to_departure?: number;
  /** Vehicle attributes (e.g. low-floor) */
  vehicle_attributes?: string[];
}

/** Response from the departures API endpoint */
export interface DeparturesResponse {
  timestamp: number;
  designator: number;
  station_name: string;
  only_disembarking: boolean;
  rows?: Departure[];
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
