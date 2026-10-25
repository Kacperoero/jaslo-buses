import { GtfsData, GtfsIndex } from '../../core/services/gtfs.service';
import { busDetails, busesAt, parseTripKey, pointAlong, tripKey, tripState } from './scheduled-buses';

// Every day from 2026-10-01 for 64 days
const everyDay = btoa(String.fromCharCode(...new Array(8).fill(255)));

function index(trips: number[][]): GtfsIndex {
  const data: GtfsData = {
    feed: { file: '', publisher: '', validFrom: '2026-10-01', validTo: '2026-12-03', builtAt: '' },
    stops: [['a', 'A', 49.7, 21.4], ['b', 'B', 49.7, 21.41], ['c', 'C', 49.71, 21.41]],
    variants: [{ line: '3', headsign: 'C', stops: [0, 1, 2] }],
    trips,
    services: { start: '2026-10-01', days: 64, bitmaps: [everyDay] }
  };
  return new GtfsIndex(data);
}

// Straight lines between stops
const straight = (ix: GtfsIndex) => (a: number, b: number): [number, number][] =>
  [[ix.stops[a][2], ix.stops[a][3]], [ix.stops[b][2], ix.stops[b][3]]];

describe('busesAt', () => {
  // Leaves A 8:00, B 8:10, reaches C 8:20
  const ix = index([[0, 0, 480, 10, 10]]);

  it('places a bus between stops in proportion to the time', () => {
    const [bus] = busesAt(ix, new Date(2026, 9, 25, 8, 5), straight(ix));
    expect(bus.line).toBe('3');
    expect(bus.waiting).toBe(false);
    expect(bus.lat).toBeCloseTo(49.7, 6);
    expect(bus.lng).toBeCloseTo(21.405, 6);  // half way A → B
    expect(bus.bearing).toBeCloseTo(90, 0); // heading east
    expect(bus.nextStop).toBe(1);
    expect(bus.nextIndex).toBe(1);
    expect(bus.nextMinute).toBe(490);
  });

  it('counts seconds and moves to the next pair of stops', () => {
    const [bus] = busesAt(ix, new Date(2026, 9, 25, 8, 12, 30), straight(ix));
    expect(bus.lat).toBeCloseTo(49.7025, 6); // a quarter of B → C
    expect(bus.nextStop).toBe(2);
  });

  it('shows a bus waiting at the first stop shortly before it leaves', () => {
    expect(busesAt(ix, new Date(2026, 9, 25, 7, 50), straight(ix))).toEqual([]);
    const [bus] = busesAt(ix, new Date(2026, 9, 25, 7, 58), straight(ix));
    expect(bus.waiting).toBe(true);
    expect([bus.lat, bus.lng]).toEqual([49.7, 21.4]);
  });

  it('drops the bus once it reaches the last stop', () => {
    expect(busesAt(ix, new Date(2026, 9, 25, 8, 20), straight(ix))).toEqual([]);
  });

  it("includes yesterday's trips running after midnight", () => {
    const late = index([[0, 0, 1435, 10, 10]]); // 23:55 → 0:05 → 0:15
    const [bus] = busesAt(late, new Date(2026, 9, 26, 0, 10), straight(late));
    expect(bus.key).toBe('0@-1');
    expect(bus.nextStop).toBe(2);
    expect(bus.nextMinute).toBe(15);
  });

  it('skips days the trip does not run', () => {
    expect(busesAt(ix, new Date(2027, 0, 5, 8, 5), straight(ix))).toEqual([]); // outside the calendar
  });
});

describe('pointAlong', () => {
  it('walks along a line by distance', () => {
    const line: [number, number][] = [[0, 0], [0, 1], [1, 1]];
    const [lat, lng] = pointAlong(line, 0.75);
    expect(lat).toBeCloseTo(0.5, 2);
    expect(lng).toBeCloseTo(1, 6);
  });
});

describe('tripState and busDetails', () => {
  // Leaves A 8:00, B 8:10, reaches C 8:20
  const ix = index([[0, 0, 480, 10, 10]]);
  const at = (h: number, m: number) => new Date(2026, 9, 25, h, m);

  it('tells whether the trip has not started, runs or has finished', () => {
    expect(tripState(ix, at(7, 0), 0, 0, straight(ix))).toMatchObject({ key: '0@0', status: 'before', bus: null, nextIndex: 0 });
    expect(tripState(ix, at(7, 58), 0, 0, straight(ix)).status).toBe('waiting');
    const running = tripState(ix, at(8, 5), 0, 0, straight(ix));
    expect(running.status).toBe('running');
    expect(running.bus?.nextIndex).toBe(1);
    expect(tripState(ix, at(9, 0), 0, 0, straight(ix))).toMatchObject({ status: 'after', bus: null, nextIndex: 3 });
    // Tomorrow's trip (a departure listed after midnight)
    expect(tripState(ix, at(23, 0), 0, 1, straight(ix)).status).toBe('before');
  });

  it('lists all stops with times, marking passed ones and the next one', () => {
    const details = busDetails(ix, tripState(ix, at(8, 5), 0, 0, straight(ix)));
    expect(details).toMatchObject({ line: '3', headsign: 'C', status: 'running', passed: 1, total: 3 });
    expect(details.stops).toEqual([
      { id: 'a', name: 'A', time: '08:00', passed: true, next: false },
      { id: 'b', name: 'B', time: '08:10', passed: false, next: true },
      { id: 'c', name: 'C', time: '08:20', passed: false, next: false }
    ]);
  });

  it('round-trips trip keys', () => {
    expect(parseTripKey(tripKey(12, -1))).toEqual({ trip: 12, dayOffset: -1 });
  });
});
