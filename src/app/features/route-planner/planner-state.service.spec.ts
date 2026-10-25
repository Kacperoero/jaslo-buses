import { TestBed } from '@angular/core/testing';
import { FavoritesService } from '../../core/services/favorites.service';
import { StopsService } from '../../core/services/stops.service';
import { TravelTimeService } from '../../core/services/travel-time.service';
import { Stop } from '../../shared/models/transit.models';
import { PlannerStateService } from './planner-state.service';
import { Connection, ConnectionPoint, rides } from './route-planner.models';
import { PlanOptions, RoutePlannerService } from './route-planner.service';

const A: Stop = { id: 'a', name: 'PIERWSZY', lat: 49.70, lng: 21.40, designator: 0, onlyDisembarking: false };
const B: Stop = { id: 'b', name: 'DRUGI', lat: 49.72, lng: 21.42, designator: 0, onlyDisembarking: false };

const conn = (line: string): Connection => ({
  legs: [{
    kind: 'ride', line, headsign: 'B', from: A, to: B, departure: '08:00', arrival: '08:05',
    departureMin: 480, arrivalMin: 485, minutes: 5, stops: [A, B], tripId: 'trip:0:0'
  }],
  leaveAt: '08:00', arriveAt: '08:05', totalMinutes: 5, waitMinutes: 0, transfers: 0, leaveMin: 480, arriveMin: 485
});

const lineOf = (c: Connection) => rides(c)[0].line;

describe('PlannerStateService', () => {
  let state: PlannerStateService;
  let favorites: FavoritesService;
  let calls: { start: ConnectionPoint; end: ConnectionPoint; options: PlanOptions }[];
  let answer: () => Promise<Connection[]>;

  beforeEach(() => {
    localStorage.clear();
    calls = [];
    answer = async () => [conn('10'), conn('22')];
    TestBed.configureTestingModule({
      providers: [{
        provide: RoutePlannerService,
        useValue: {
          findConnections: (start: ConnectionPoint, end: ConnectionPoint, options: PlanOptions) => {
            calls.push({ start, end, options });
            return answer();
          }
        }
      }]
    });
    TestBed.inject(StopsService).stops.set([A, B]);
    state = TestBed.inject(PlannerStateService);
    favorites = TestBed.inject(FavoritesService);
  });

  it('fills a point and its text from a stop', () => {
    state.setStop('start', A);
    expect(state.start()).toEqual({ lat: A.lat, lng: A.lng, name: 'PIERWSZY', isStop: true, stopId: 'a' });
    expect(state.startText()).toBe('PIERWSZY');
    expect(state.canSearch()).toBe(false);
  });

  it('searches, selects the first result and remembers the route', async () => {
    state.setStop('start', A);
    state.setStop('end', B);
    await state.search();

    expect(state.connections().map(lineOf)).toEqual(['10', '22']);
    expect(lineOf(state.selected()!)).toBe('10');
    expect(state.searchDone()).toBe(true);
    expect(favorites.recentRoutes().length).toBe(1);
  });

  it('does not remember routes from the user location', async () => {
    state.setUserLocation('start', 49.7, 21.4);
    state.setStop('end', B);
    await state.search();
    expect(favorites.recentRoutes()).toEqual([]);
  });

  it('drops results when a point changes', async () => {
    state.setStop('start', A);
    state.setStop('end', B);
    await state.search();
    state.swap();

    expect(state.connections()).toEqual([]);
    expect(state.start()?.stopId).toBe('b');
    expect(state.endText()).toBe('PIERWSZY');
  });

  it('drops results when the travel time changes', async () => {
    state.setStop('start', A);
    state.setStop('end', B);
    await state.search();
    TestBed.inject(TravelTimeService).setTime(new Date(2026, 9, 26, 7, 30));
    TestBed.tick();

    expect(state.connections()).toEqual([]);
  });

  it('ignores a slow search when the points changed meanwhile', async () => {
    let finish!: (c: Connection[]) => void;
    answer = () => new Promise(r => (finish = r));
    state.setStop('start', A);
    state.setStop('end', B);
    const pending = state.search();
    state.setStop('end', A);
    finish([conn('10')]);
    await pending;

    expect(state.connections()).toEqual([]);
    expect(state.searching()).toBe(false);
  });

  it('sets a point from a map click only while picking, named after a nearby stop', () => {
    expect(state.setPointFromMap(49.7, 21.4)).toBe(false);

    state.startPicking('end');
    expect(state.setPointFromMap(49.7001, 21.4001)).toBe(true);
    expect(state.end()?.name).toBe('Blisko: PIERWSZY');
    expect(state.picking()).toBeNull();

    state.startPicking('start');
    state.setPointFromMap(49.8, 21.6);
    expect(state.start()?.name).toBe('Punkt na mapie (49.8000, 21.6000)');
  });

  it('passes the time and mode to the planner', async () => {
    TestBed.inject(TravelTimeService).setTime(new Date(2026, 9, 26, 7, 30));
    TestBed.tick();
    state.setStop('start', A);
    state.setStop('end', B);
    await state.search();
    expect(calls[0].options.mode).toBe('depart');
    expect(calls[0].options.time.getHours()).toBe(7);
  });

  it('switching to "arrive by" picks a time when it was "now", and back', () => {
    const travel = TestBed.inject(TravelTimeService);
    state.setTimeMode('arrive');
    expect(state.timeMode()).toBe('arrive');
    expect(travel.isScheduled()).toBe(true);
    expect(travel.selected()!.getTime()).toBeGreaterThan(Date.now() + 50 * 60_000);

    travel.resetToNow();
    TestBed.tick();
    expect(state.timeMode()).toBe('depart'); // "arrive by now" makes no sense
  });

  it('closing the panel clears everything', async () => {
    state.toggle();
    state.setStop('start', A);
    state.toggle();
    expect(state.open()).toBe(false);
    expect(state.start()).toBeNull();
    expect(state.startText()).toBe('');
  });
});
