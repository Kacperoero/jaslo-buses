import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { TimetableService, encodeLineName } from './timetable.service';

const STOP = '1332055:1392178';
const STOP_URL = encodeURIComponent(STOP);

describe('encodeLineName', () => {
  it('uses URL-safe Base64 without padding, like the official site', () => {
    expect(encodeLineName('10')).toBe('MTA');
    expect(encodeLineName('E4')).toBe('RTQ');
    expect(encodeLineName('Ż')).toBe('xbs');
  });
});

describe('TimetableService scheduled departures', () => {
  let service: TimetableService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideHttpClient(), provideHttpClientTesting()]
    });
    service = TestBed.inject(TimetableService);
    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => http.verify());

  it('merges line timetables into departures starting at the chosen time', async () => {
    const at = new Date(2026, 9, 26, 7, 30); // Mon 26.10.2026, 07:30
    const result = firstValueFrom(service.getScheduledDepartures(STOP, at));

    http.expectOne(r => r.url === `/api/directions/${STOP_URL}` && r.params.get('date') === '2026-10-26')
      .flush({ directions: [
        { line: '10', direction: 'A', show_name: true, active: true },
        { line: '34', direction: 'B', show_name: true, active: true },
        { line: '34', direction: 'C', show_name: true, active: true }
      ] });

    // One request per unique line
    http.expectOne(`/api/timetable/${STOP_URL}/MTA?date=2026-10-26`).flush({
      departures: [
        { departure: 7 * 3600, line: '10', symbols: '', trip_id: 1, index: 3 },           // 07:00 – before
        { departure: 8 * 3600 + 15 * 60, line: '10', symbols: '', trip_id: 2, index: 3 }  // 08:15
      ],
      directions: [],
      main_direction: { name: 'KAUFLAND', count: 2, symbol: null }
    });
    http.expectOne(`/api/timetable/${STOP_URL}/MzQ?date=2026-10-26`).flush({
      departures: [
        { departure: 7 * 3600 + 40 * 60, symbols: 'B', trip_id: 3, index: 8 },           // 07:40, alt direction
        { departure: 12 * 3600, symbols: '', trip_id: 4, index: 8 }                       // 12:00 – after 3h window
      ],
      directions: [{ name: 'WARZYCE', symbol: 'B' }],
      main_direction: { name: 'RYNEK', count: 1, symbol: null }
    });

    const res = await result;
    expect(res.rows?.map(r => [r.line_name, r.static_time, r.time, r.direction])).toEqual([
      ['34', '07:40', '10 min', 'WARZYCE'],
      ['10', '08:15', '45 min', 'KAUFLAND']
    ]);
    expect(res.rows?.[0].is_estimated).toBe(false);
    expect(res.rows?.[0].trip_execution_id).toBe('trip:3:8');
    expect(res.directions?.['WARZYCE']).toBe('WARZYCE');
  });

  it('reuses the cached day timetable for another time on the same day', async () => {
    const first = firstValueFrom(service.getScheduledDepartures(STOP, new Date(2026, 9, 26, 7, 0)));
    http.expectOne(r => r.url === `/api/directions/${STOP_URL}`).flush({ directions: [] });
    await first;

    await firstValueFrom(service.getScheduledDepartures(STOP, new Date(2026, 9, 26, 15, 0)));
    http.expectNone(r => r.url.startsWith('/api/'));
  });

  it('asks for a live trip by Base64 id and stop position', async () => {
    const result = firstValueFrom(service.getTripExecution('Z22:739913:5', 14));
    http.expectOne('/api/trip_execution/WjIyOjczOTkxMzo1/14').flush({
      trip: { times: [], direction: '', current_station_id: 0, line: { name: 'OG', type: 'bus', show_name: true } },
      canceled: [], vehicle_type: 0, estimated: true, at_stop: false,
      next_departure_index: 0, estimates: [], vehicle_trip_index: 0
    });
    expect((await result).trip.line.name).toBe('OG');
  });

  it('loads scheduled trips from the planned trip endpoint', async () => {
    const result = firstValueFrom(service.getTripExecution('trip:46084089:35'));
    http.expectOne('/api/trip/46084089/35').flush({
      times: [{ stop_name: 'A', external: false, designator: 1, place_id: 'x', departure_time: '04:40', index: 0 }],
      direction: 'RYNEK',
      current_station_id: 1,
      line: { name: '34', type: 'bus', show_name: true },
      vehicle_type: 0
    });

    const res = await result;
    expect(res.trip.times.length).toBe(1);
    expect(res.trip.line.name).toBe('34');
    expect(res.estimated).toBe(false);
  });
});
