import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { firstValueFrom } from 'rxjs';
import { Stop } from '../../shared/models/transit.models';
import { StopsService } from './stops.service';

const stop = (id: string, name: string): Stop => ({ id, name, lat: 49.7, lng: 21.4, designator: 0, onlyDisembarking: false });

describe('StopsService', () => {
  let service: StopsService;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(StopsService);
    http = TestBed.inject(HttpTestingController);
  });

  it('loads the stops once and keeps them in a signal', async () => {
    const first = firstValueFrom(service.load());
    http.expectOne('assets/data/stops-base.json').flush([stop('a', 'JASŁO,ul.3 MAJA 01')]);
    await first;
    await firstValueFrom(service.load());
    http.expectNone('assets/data/stops-base.json');

    expect(service.stops().length).toBe(1);
    expect(service.loading()).toBe(false);
    expect(service.byId().get('a')?.name).toBe('JASŁO,ul.3 MAJA 01');
  });

  it('searches ignoring case, Polish letters and punctuation', () => {
    service.stops.set([stop('a', 'JASŁO,ul.3 MAJA 01'), stop('b', 'ŁĘKI Szkoła'), stop('c', 'JASŁO,ul.RYNEK 02')]);

    expect(service.search('jaslo 3 maja', 10).map(s => s.id)).toEqual(['a']);
    expect(service.search('leki', 10).map(s => s.id)).toEqual(['b']);
    expect(service.search('jasło', 1).map(s => s.id)).toEqual(['a']); // limit
    expect(service.search('  ', 10)).toEqual([]);
  });
});
