import { GtfsData, GtfsIndex } from '../../core/services/gtfs.service';
import { Access, RaptorNetwork, plan, PlanRequest } from './raptor';
import { Connection } from './route-planner.models';

/**
 * Test network (all trips every day):
 *
 *   line 1:  A 08:00 → B 08:05 → C 08:10        (again at 08:30, and 23:50 → C 00:00)
 *   walk:    C → C2 about 220 m (3 min)
 *   line 2:  C2 08:15 → D 08:25                 (again 08:45 → 08:55)
 *   line 3:  D 08:28 → E 08:40                  (also 08:56 → 09:05 and 09:10 → 09:20)
 *   line 4:  A 08:00 → F 08:40 → E 09:30        (direct, but slow)
 */
const h = (hh: number, mm: number) => hh * 60 + mm;
const allDays = btoa(String.fromCharCode(255, 255));

const DATA: GtfsData = {
  feed: { file: 't.zip', publisher: '', validFrom: '2026-10-19', validTo: '2026-11-01', builtAt: '' },
  stops: [
    ['a', 'A', 49.700, 21.40],
    ['b', 'B', 49.700, 21.41],
    ['c', 'C', 49.700, 21.42],
    ['c2', 'C2', 49.702, 21.42],
    ['d', 'D', 49.710, 21.43],
    ['e', 'E', 49.720, 21.44],
    ['f', 'F', 49.750, 21.50]
  ],
  variants: [
    { line: '1', headsign: 'C', stops: [0, 1, 2] },
    { line: '2', headsign: 'D', stops: [3, 4] },
    { line: '3', headsign: 'E', stops: [4, 5] },
    { line: '4', headsign: 'E', stops: [0, 6, 5] }
  ],
  trips: [
    [0, 0, h(8, 0), 5, 5],
    [1, 0, h(8, 15), 10],
    [2, 0, h(8, 28), 12],
    [3, 0, h(8, 0), 40, 50],
    [0, 0, h(8, 30), 5, 5],
    [1, 0, h(8, 45), 10],
    [2, 0, h(8, 56), 9],
    [2, 0, h(9, 10), 10],
    [0, 0, h(23, 50), 5, 5]
  ],
  services: { start: '2026-10-19', days: 14, bitmaps: [allDays] }
};

const net = new RaptorNetwork(new GtfsIndex(DATA));
const at = (stop: number, minutes = 0, meters = 0): Access => ({ stop, minutes, meters });
const place = (name: string) => ({ name, lat: 49.7, lng: 21.4 });

function request(over: Partial<PlanRequest>): PlanRequest {
  return {
    access: [at(0)], egress: [at(5)], origin: place('start'), destination: place('cel'),
    date: new Date(2026, 9, 21), timeMin: h(7, 55), mode: 'depart', ...over
  };
}

const lines = (c: Connection) => c.legs.flatMap(l => (l.kind === 'ride' ? [l.line] : []));

describe('RAPTOR planner', () => {
  it('finds the fastest journey with two changes and a walk between platforms', () => {
    const [best] = plan(net, request({}));

    expect(best.legs.map(l => l.kind)).toEqual(['ride', 'walk', 'ride', 'ride']);
    expect(lines(best)).toEqual(['1', '2', '3']);
    expect(best.leaveAt).toBe('08:00');
    expect(best.arriveAt).toBe('08:40');
    expect(best.transfers).toBe(2);
    const walk = best.legs[1];
    expect(walk.kind === 'walk' && walk.from.name === 'C' && walk.to.name === 'C2' && walk.minutes).toBe(3);
  });

  it('also offers the slower journey without changes', () => {
    const direct = plan(net, request({})).find(c => c.transfers === 0);
    expect(direct && lines(direct)).toEqual(['4']);
    expect(direct?.arriveAt).toBe('09:30');
  });

  it('keeps the minimum time for changing buses at the same stop', () => {
    // Leaving at 08:30: D at 08:55, the 08:56 bus is too soon (1 min), so the 09:10 one
    const later = plan(net, request({ timeMin: h(8, 20) }));
    const viaD = later.find(c => lines(c).join() === '1,2,3')!;
    expect(viaD.leaveAt).toBe('08:30');
    expect(viaD.arriveAt).toBe('09:20');
  });

  it('answers "arrive by": the latest departures that still arrive in time', () => {
    const res = plan(net, request({ mode: 'arrive', timeMin: h(9, 25) }));
    expect(res.every(c => c.arriveMin <= h(9, 25))).toBe(true);
    expect(res[0].leaveAt).toBe('08:30');
    expect(res[0].arriveAt).toBe('09:20');
  });

  it('finds nothing when no bus arrives in time', () => {
    expect(plan(net, request({ mode: 'arrive', timeMin: h(8, 30) }))).toEqual([]);
  });

  it('counts the walk to the first stop and the wait there', () => {
    const [best] = plan(net, request({ access: [at(0, 2, 150)], origin: place('dom') }));
    expect(best.legs[0].kind).toBe('walk');
    expect(best.leaveAt).toBe('07:58');
    expect(best.waitMinutes).toBe(3); // asked to leave at 07:55
    expect(best.totalMinutes).toBe(42);
  });

  it('merges walking to a nearby stop and on to the destination into one walk', () => {
    // Destination point next to C2: get off at C, walk to C2 (3 min), then to the point (1 min)
    const [best] = plan(net, request({ egress: [at(3, 1, 60)], timeMin: h(7, 55) }));
    expect(best.legs.map(l => l.kind)).toEqual(['ride', 'walk']);
    const last = best.legs[1];
    expect(last.kind === 'walk' && [last.from.name, last.to.name, last.minutes]).toEqual(['C', 'cel', 4]);
  });

  it('handles trips running past midnight', () => {
    const [late] = plan(net, request({ egress: [at(2)], timeMin: h(23, 45) }));
    expect(late.arriveAt).toBe('00:00');
    expect(late.totalMinutes).toBe(10);
  });
});
