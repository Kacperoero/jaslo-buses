import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TimetableService } from '../../core/services/timetable.service';
import { Departure, Stop, TripExecutionResponse, TripTime } from '../../shared/models/transit.models';
import { LiveVehiclesService, MapBounds, stopsFromCentre, toVehicle } from './live-vehicles.service';

const stop = (id: string, lat: number, lng: number, onlyDisembarking = false): Stop =>
  ({ id, name: id, lat, lng, designator: 0, onlyDisembarking });

const time = (name: string, departure_time: string, index: number): TripTime =>
  ({ stop_name: name, external: false, designator: 0, place_id: name, departure_time, index });

function exec(over: Partial<TripExecutionResponse> = {}): TripExecutionResponse {
  return {
    trip: {
      times: [time('A', '12:00', 0), time('B', '12:05', 1), time('C', '12:10', 2)],
      direction: 'C', current_station_id: 0, line: { name: '10', type: 'bus', show_name: true }
    },
    canceled: [], vehicle_type: 0, estimated: true, at_stop: false,
    vehicle: { lat: 49.7, lon: 21.4 },
    next_departure_index: 1, vehicle_trip_index: 1,
    estimates: [{ arrival_abs: '12:07', time_abs: null, to_go: 2 }],
    ...over
  };
}

const run = { id: 'Z1:1:1', index: 1, line: '10' };

describe('toVehicle', () => {
  it('reads position, next stop and delay', () => {
    expect(toVehicle(run, exec())).toEqual({
      id: 'Z1:1:1', line: '10', direction: 'C', lat: 49.7, lng: 21.4,
      nextStop: 'B', nextStopEta: '12:07', delayMin: 2, atStop: false
    });
  });

  it('reports buses ahead of time with a negative delay, also around midnight', () => {
    const e = exec({
      trip: { ...exec().trip, times: [time('A', '23:58', 0), time('B', '00:01', 1)] },
      estimates: [{ arrival_abs: '23:59', time_abs: null, to_go: 1 }]
    });
    expect(toVehicle(run, e)?.delayMin).toBe(-2);
  });

  it('uses the first stop while the bus waits at the terminus', () => {
    const v = toVehicle(run, exec({ vehicle_trip_index: -1, next_departure_index: 0 }));
    expect(v?.nextStop).toBe('A');
  });

  it('skips buses without a live position or past their last stop', () => {
    expect(toVehicle(run, exec({ estimated: false }))).toBeNull();
    expect(toVehicle(run, exec({ vehicle: undefined }))).toBeNull();
    expect(toVehicle(run, exec({ next_departure_index: 3 }))).toBeNull();
  });
});

describe('stopsFromCentre', () => {
  it('keeps boarding stops inside the area, nearest to the centre first', () => {
    const bounds: MapBounds = { south: 49.0, north: 50.0, west: 21.0, east: 22.0 };
    const stops = [
      stop('edge', 49.1, 21.1),
      stop('centre', 49.5, 21.5),
      stop('outside', 51, 21.5),
      stop('drop-off', 49.5, 21.51, true),
      stop('near', 49.6, 21.5)
    ];
    expect(stopsFromCentre(stops, bounds).map(s => s.id)).toEqual(['centre', 'near', 'edge']);
  });
});

describe('LiveVehiclesService', () => {
  // 100 stops in a 10×10 grid
  const STOPS = Array.from({ length: 100 }, (_, i) => stop(`s${i}`, 49.70 + Math.floor(i / 10) * 0.002, 21.40 + (i % 10) * 0.002));
  const BOUNDS: MapBounds = { south: 49.69, north: 49.73, west: 21.39, east: 21.43 };

  let service: LiveVehiclesService;
  let multiCalls: string[][];
  let trips: Record<string, TripExecutionResponse>;
  let rows: Departure[];

  beforeEach(() => {
    multiCalls = [];
    rows = [
      { line_name: '10', time: '3 min', is_estimated: true, trip_execution_id: 'run-near', trip_index: 1 },
      { line_name: '4', time: '40 min', is_estimated: true, trip_execution_id: 'run-later', trip_index: 0 },
      { line_name: 'A', time: '5 min', is_estimated: false, trip_execution_id: 'run-not-live', trip_index: 0 },
      { line_name: 'E', time: '2 min', is_estimated: true, canceled: true, trip_execution_id: 'run-canceled', trip_index: 0 }
    ];
    trips = { 'run-near': exec() };

    const fake: Partial<TimetableService> = {
      getDeparturesForStops: (ids: string[]) => {
        multiCalls.push(ids);
        return of({ status: 'ok', departures: [{ designator: 1, rows }] });
      },
      getTripExecution: (id: string) => of(trips[id] ?? exec({ vehicle: undefined }))
    };
    TestBed.configureTestingModule({ providers: [{ provide: TimetableService, useValue: fake }] });
    service = TestBed.inject(LiveVehiclesService);
    service.configure(STOPS, () => BOUNDS);
  });

  afterEach(() => service.stop());

  it('first asks the 72 stops nearest the centre, 6 per request, and tracks buses arriving soon', async () => {
    service.start();
    await service.refresh(); // the first round started by start() may still be running
    await new Promise(r => setTimeout(r));

    expect(multiCalls.slice(0, 12).every(ids => ids.length === 6)).toBe(true);
    expect(service.vehicles().map(v => v.id)).toEqual(['run-near']); // not: later, not live, cancelled
  });

  it('continues the sweep with 24 stops per refresh', async () => {
    service.start();
    await new Promise(r => setTimeout(r));
    const afterFirst = multiCalls.length;
    await service.refresh();

    const next = multiCalls.slice(afterFirst);
    expect(next.length).toBe(4);
    expect(new Set(next.flat()).size).toBe(24);
  });

  it('stops tracking a bus that finished its trip', async () => {
    service.start();
    await new Promise(r => setTimeout(r));
    expect(service.vehicles().length).toBe(1);

    trips['run-near'] = exec({ next_departure_index: 3 });
    rows = [];
    await service.refresh();
    expect(service.vehicles()).toEqual([]);
  });

  it('clears everything when switched off', async () => {
    service.start();
    await new Promise(r => setTimeout(r));
    service.stop();

    expect(service.enabled()).toBe(false);
    expect(service.vehicles()).toEqual([]);
  });
});
