import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TimetableService } from '../../core/services/timetable.service';
import { TravelTimeService } from '../../core/services/travel-time.service';
import {
  DeparturesResponse,
  Stop,
  StopDirection,
  TripExecutionResponse,
  TripTime
} from '../../shared/models/transit.models';
import { RoutePlannerService } from './route-planner.service';
import { ConnectionPoint } from './route-planner.models';

// A small fake network:
//   line 1: S1 → S2 → S3 → KONIEC (heading east)
//   line 2: S2 → X → IKS
const stop = (id: string, name: string, lat: number, lng: number): Stop =>
  ({ id, name, lat, lng, designator: 0, onlyDisembarking: false });

const S1 = stop('s1', 'PIERWSZY', 49.70, 21.40);
const S2 = stop('s2', 'DRUGI', 49.70, 21.41);
const S3 = stop('s3', 'TRZECI', 49.70, 21.42);
const KONIEC = stop('k', 'KONIEC', 49.70, 21.45);
const X = stop('x', 'CEL', 49.71, 21.50);
const IKS = stop('i', 'IKS', 49.71, 21.55);
// Second area (cases the old direction-name matching got wrong):
//   line E4 is a loop: from P its sign says "PĘTLA", but it continues past PĘTLA to RYNEK
//   line 22 ends at RYNEK and leaves only from the other platform of POCZĄTEK (P2)
const P = stop('p', 'POCZĄTEK', 49.80, 21.40);
const P2 = stop('p2', 'POCZĄTEK', 49.8005, 21.4005); // ~65 m away
const Q = stop('q', 'PĘTLA', 49.80, 21.42);
const R = stop('r', 'RYNEK', 49.80, 21.44);
const STOPS = [S1, S2, S3, KONIEC, X, IKS, P, P2, Q, R];

const dir = (line: string, direction: string): StopDirection => ({ line, direction, show_name: true, active: true });

const DIRECTIONS: Record<string, StopDirection[]> = {
  s1: [dir('1', 'KONIEC')],
  s2: [dir('1', 'KONIEC'), dir('2', 'IKS')],
  s3: [dir('1', 'KONIEC')],
  k: [],
  x: [dir('2', 'IKS')],
  i: [],
  p: [dir('E4', 'PĘTLA')],
  p2: [dir('22', 'RYNEK')],
  q: [dir('E4', 'RYNEK')],
  r: [dir('E4', 'DALEJ')] // 22 ends here, so the API doesn't list it
};

const DEPARTURES: Record<string, DeparturesResponse> = {
  s1: board([{ line: '1', time: '5 min', dir: 'd1', trip: 't1' }], { d1: 'KONIEC' }),
  s2: board([{ line: '2', time: '15 min', dir: 'd2', trip: 't2' }], { d2: 'IKS' }),
  s3: board([{ line: '1', time: '9 min', dir: 'd1', trip: 't1' }], { d1: 'KONIEC' }),
  k: board([], {}),
  x: board([], {}),
  i: board([], {}),
  p: board([{ line: 'E4', time: '30 min', dir: 'e', trip: 'e4' }], { e: 'PĘTLA' }),
  p2: board([{ line: '22', time: '32 min', dir: 'r', trip: 't22' }], { r: 'RYNEK' }),
  q: board([], {}),
  r: board([], {})
};

const TRIPS: Record<string, TripTime[]> = {
  t1: [time(S1, '07:35', 0), time(S2, '07:38', 1), time(S3, '07:42', 2), time(KONIEC, '07:50', 3)],
  t2: [time(S2, '07:45', 0), time(X, '07:52', 1), time(IKS, '07:58', 2)],
  e4: [time(P, '08:00', 0), time(Q, '08:05', 1), time(R, '08:10', 2)],
  t22: [time(P2, '08:02', 0), time(R, '08:06', 1)]
};

function board(rows: { line: string; time: string; dir: string; trip: string }[], directions: Record<string, string>): DeparturesResponse {
  return {
    timestamp: 0, designator: 0, station_name: '', only_disembarking: false, directions,
    rows: rows.map(r => ({ line_name: r.line, time: r.time, direction_id: r.dir, is_estimated: false, trip_execution_id: r.trip }))
  };
}

function time(s: Stop, departure_time: string, index: number): TripTime {
  return { stop_name: s.name, external: false, designator: 0, place_id: s.id, departure_time, index };
}

function execution(times: TripTime[]): TripExecutionResponse {
  return {
    trip: { times, direction: '', current_station_id: 0, line: { name: '', type: 'bus', show_name: true } },
    canceled: [], vehicle_type: 0, estimated: false, at_stop: false,
    next_departure_index: 0, estimates: [], vehicle_trip_index: 0
  };
}

const at = (s: Stop): ConnectionPoint => ({ lat: s.lat, lng: s.lng, name: s.name, isStop: true, stopId: s.id });

describe('RoutePlannerService', () => {
  let planner: RoutePlannerService;
  let calls: { departures: string[]; trips: string[] };

  beforeEach(() => {
    calls = { departures: [], trips: [] };
    const fakeTimetable: Partial<TimetableService> = {
      getDirectionsForStop: (id: string) => of(DIRECTIONS[id] ?? []),
      getDepartures: (id: string) => {
        calls.departures.push(id);
        return of(DEPARTURES[id]);
      },
      getTripExecution: (id: string) => {
        calls.trips.push(id);
        return of(execution(TRIPS[id]));
      }
    };

    TestBed.configureTestingModule({
      providers: [{ provide: TimetableService, useValue: fakeTimetable }]
    });
    TestBed.inject(TravelTimeService).setTime(new Date(2026, 9, 26, 7, 30));
    planner = TestBed.inject(RoutePlannerService);
  });

  it('finds a direct connection with bus time from the trip timetable', async () => {
    const [conn, ...rest] = await planner.findConnections(at(S1), at(S3), STOPS);

    expect(rest).toEqual([]);
    expect(conn.line).toBe('1');
    expect(conn.departureTimeAbs).toBe('07:35');
    expect(conn.busTime).toBe(7);              // 07:35 → 07:42 on trip t1
    expect(conn.arrivalTimeAbs).toBe('07:42');
    expect(conn.waitingTimeAtStop).toBe(5);
    expect(conn.totalTime).toBe(12);
  });

  it('ignores a line going the opposite way', async () => {
    // Line 1 runs S1 → S3, so there is no ride from S3 back to S1
    expect(await planner.findConnections(at(S3), at(S1), STOPS)).toEqual([]);
  });

  it('finds a connection with one transfer when no line serves both stops', async () => {
    const [conn] = await planner.findConnections(at(S1), at(X), STOPS);

    expect(conn.isTransfer).toBe(true);
    expect(conn.line).toBe('1 ➔ 2');
    expect(conn.transferStop?.id).toBe('s2');
    expect(conn.departureTimeAbs).toBe('07:35');
    expect(conn.arrivalTimeAbs).toBe('07:52');
    expect(conn.walkTimeTransfer).toBe(7);    // arrive at S2 07:38, line 2 leaves 07:45
    expect(conn.totalTime).toBe(22);
    expect(conn.legs?.map(l => [l.line, l.startStop.id, l.endStop.id])).toEqual([['1', 's1', 's2'], ['2', 's2', 'x']]);
  });

  it('follows the real route of a loop line, even when its sign names another stop', async () => {
    const conns = await planner.findConnections(at(P), at(R), STOPS);
    const e4 = conns.find(c => c.line === 'E4');

    expect(e4?.startStop.id).toBe('p');
    expect(e4?.busTime).toBe(10); // 08:00 → 08:10
  });

  it('finds a line that ends at the destination, from the other platform of the start stop', async () => {
    const conns = await planner.findConnections(at(P), at(R), STOPS);

    expect(conns[0].line).toBe('22');
    expect(conns[0].startStop.id).toBe('p2');
    expect(conns[0].walkTimeStart).toBe(1);   // ~65 m to the other platform
    expect(conns[0].arrivalTimeAbs).toBe('08:06');
  });

  it('shows each bus run once, boarded at the best nearby stop', async () => {
    const point = (s: Stop): ConnectionPoint => ({ lat: s.lat, lng: s.lng, name: 'punkt' });
    // From a map point at S1: run t1 can be boarded at S1, S2 or S3
    const conns = await planner.findConnections(point(S1), point(S3), STOPS);

    expect(conns.filter(c => c.line === '1').length).toBe(1);
  });

  it('never requests the same departures or trip twice in one search', async () => {
    await planner.findConnections(at(S1), at(X), STOPS);

    expect(calls.departures.length).toBe(new Set(calls.departures).size);
    expect(calls.trips.length).toBe(new Set(calls.trips).size);
  });

  it('asks for fresh departures on every search', async () => {
    await planner.findConnections(at(S1), at(S3), STOPS);
    const firstSearch = calls.departures.filter(id => id === 's1').length;
    await planner.findConnections(at(S1), at(S3), STOPS);

    expect(firstSearch).toBeGreaterThan(0);
    expect(calls.departures.filter(id => id === 's1').length).toBe(2 * firstSearch);
  });

  it('fetches live departures of a stop only once per search', async () => {
    TestBed.inject(TravelTimeService).resetToNow();
    await planner.findConnections(at(S1), at(X), STOPS); // runs both direct and transfer search

    expect(calls.departures.filter(id => id === 's1').length).toBe(1);
  });
});
