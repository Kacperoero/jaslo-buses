import { TestBed } from '@angular/core/testing';
import { FavoritesService } from '../../core/services/favorites.service';
import { StopsService } from '../../core/services/stops.service';
import { TravelTimeService } from '../../core/services/travel-time.service';
import { Stop } from '../../shared/models/transit.models';
import { PlannerStateService } from './planner-state.service';
import { Connection, ConnectionPoint } from './route-planner.models';
import { RoutePlannerService } from './route-planner.service';

const A: Stop = { id: 'a', name: 'PIERWSZY', lat: 49.70, lng: 21.40, designator: 0, onlyDisembarking: false };
const B: Stop = { id: 'b', name: 'DRUGI', lat: 49.72, lng: 21.42, designator: 0, onlyDisembarking: false };

const conn = (line: string): Connection => ({
  startStop: A, endStop: B, line, nextDeparture: null,
  walkTimeStart: 0, walkTimeEnd: 0, busTime: 5, totalTime: 5
});

describe('PlannerStateService', () => {
  let state: PlannerStateService;
  let favorites: FavoritesService;
  let calls: { start: ConnectionPoint; end: ConnectionPoint }[];
  let answer: () => Promise<Connection[]>;

  beforeEach(() => {
    localStorage.clear();
    calls = [];
    answer = async () => [conn('10'), conn('22')];
    TestBed.configureTestingModule({
      providers: [{
        provide: RoutePlannerService,
        useValue: { findConnections: (start: ConnectionPoint, end: ConnectionPoint) => { calls.push({ start, end }); return answer(); } }
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

    expect(state.connections().map(c => c.line)).toEqual(['10', '22']);
    expect(state.selected()?.line).toBe('10');
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

  it('closing the panel clears everything', async () => {
    state.toggle();
    state.setStop('start', A);
    state.toggle();
    expect(state.open()).toBe(false);
    expect(state.start()).toBeNull();
    expect(state.startText()).toBe('');
  });
});
