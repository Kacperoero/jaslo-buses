import { GtfsData, GtfsIndex } from './gtfs.service';
import { UNKNOWN_LINE, departures, directions, tripDetails } from './timetable.service';

/**
 * Tiny timetable: stops A → B → C.
 *  trip 0: line 10, weekdays, A 07:40, B 07:45, C 07:55
 *  trip 1: line unknown, every day, A 23:50, B 00:05 (next day), C 00:10
 *  trip 2: line 10, weekdays, A 09:00 … C 09:20
 * Service calendar starts Mon 2026-10-19 and lasts 14 days.
 */
const WEEKDAYS = bitmap(14, d => d % 7 < 5);
const EVERY_DAY = bitmap(14, () => true);

const DATA: GtfsData = {
  feed: { file: 'test.zip', publisher: '', validFrom: '2026-10-19', validTo: '2026-11-01', builtAt: '' },
  stops: [['a', 'A', 49.7, 21.4], ['b', 'B', 49.71, 21.41], ['c', 'C', 49.72, 21.42]],
  variants: [
    { line: '10', headsign: 'C', stops: [0, 1, 2] },
    { line: null, headsign: 'C', stops: [0, 1, 2] }
  ],
  trips: [
    [0, 0, 7 * 60 + 40, 5, 10],
    [1, 1, 23 * 60 + 50, 15, 5],
    [0, 0, 9 * 60, 10, 10]
  ],
  services: { start: '2026-10-19', days: 14, bitmaps: [WEEKDAYS, EVERY_DAY] }
};

const index = new GtfsIndex(DATA);
const at = (d: number, h: number, m: number) => new Date(2026, 9, d, h, m);

describe('GtfsIndex', () => {
  it('knows on which days a service runs', () => {
    expect(index.runsOn(0, at(19, 12, 0))).toBe(true);   // Monday
    expect(index.runsOn(0, at(24, 12, 0))).toBe(false);  // Saturday
    expect(index.runsOn(1, at(24, 12, 0))).toBe(true);
    expect(index.runsOn(1, at(2, 12, 0))).toBe(false);   // before the calendar starts
  });
});

describe('departures', () => {
  it('lists departures in the next 3 hours, soonest first, with planned times', () => {
    const res = departures(index, 'a', at(19, 7, 30));
    expect(res.rows!.map(r => [r.line_name, r.static_time, r.time, r.direction])).toEqual([
      ['10', '07:40', '10 min', 'C'],
      ['10', '09:00', '90 min', 'C']
    ]);
    expect(res.rows![0].is_estimated).toBe(false);
    expect(res.rows![0].trip_execution_id).toBe('trip:0:0');
  });

  it('respects the service calendar', () => {
    expect(departures(index, 'a', at(24, 7, 30)).rows).toEqual([]); // Saturday: no weekday trips
  });

  it('includes trips that run past midnight', () => {
    // Tuesday 00:00 – the Monday 23:50 trip reaches B at 00:05
    const res = departures(index, 'b', at(20, 0, 0));
    expect(res.rows!.map(r => [r.line_name, r.static_time])).toEqual([[UNKNOWN_LINE, '00:05']]);
  });

  it('looks into the next day when the window passes midnight', () => {
    const res = departures(index, 'a', at(19, 23, 45));
    expect(res.rows!.map(r => r.static_time)).toEqual(['23:50']);
  });

  it('does not list the last stop of a trip (the bus only arrives there)', () => {
    expect(departures(index, 'c', at(19, 7, 30)).rows).toEqual([]);
  });

  it('can limit the result to some lines', () => {
    expect(departures(index, 'b', at(19, 23, 0), ['10']).rows).toEqual([]);
  });
});

describe('directions', () => {
  it('lists lines calling at a stop that day, including where they end', () => {
    expect(directions(index, 'c', at(19, 12, 0)).map(d => d.line).sort()).toEqual(['10', UNKNOWN_LINE]);
    expect(directions(index, 'c', at(24, 12, 0)).map(d => d.line)).toEqual([UNKNOWN_LINE]);
  });
});

describe('tripDetails', () => {
  it('gives the stop sequence with clock times', () => {
    const res = tripDetails(index, 'trip:1:1');
    expect(res.trip.times.map(t => [t.place_id, t.departure_time, t.index])).toEqual([
      ['a', '23:50', 0], ['b', '00:05', 1], ['c', '00:10', 2]
    ]);
    expect(res.trip.line.name).toBe(UNKNOWN_LINE);
    expect(res.next_departure_index).toBe(1);
  });
});

function bitmap(days: number, on: (day: number) => boolean): string {
  const bytes = new Uint8Array(Math.ceil(days / 8));
  for (let d = 0; d < days; d++) if (on(d)) bytes[d >> 3] |= 1 << (d & 7);
  return btoa(String.fromCharCode(...bytes));
}
