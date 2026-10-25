import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Stop } from '../../shared/models/transit.models';
import { ShapesService, decodePolyline } from './shapes.service';

const stop = (id: string, lat: number, lng: number): Stop => ({ id, name: id, lat, lng, designator: 0, onlyDisembarking: false });

describe('decodePolyline', () => {
  it('decodes the example from the Google polyline documentation', () => {
    expect(decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@')).toEqual([
      [38.5, -120.2], [40.7, -120.95], [43.252, -126.453]
    ]);
  });
});

describe('ShapesService', () => {
  let service: ShapesService;
  let http: HttpTestingController;
  const A = stop('a', 38.5, -120.2);
  const B = stop('b', 43.252, -126.453);
  const C = stop('c', 44, -127);

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    service = TestBed.inject(ShapesService);
    http = TestBed.inject(HttpTestingController);
  });

  it('draws straight lines before the road lines are loaded', () => {
    expect(service.path([A, B])).toEqual([[38.5, -120.2], [43.252, -126.453]]);
  });

  it('follows the road between stops where known, straight elsewhere', () => {
    service.load();
    http.expectOne('assets/data/shapes.json').flush({ source: '', builtAt: '', shapes: { 'a>b': '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } });

    expect(service.loaded()).toBe(true);
    expect(service.path([A, B, C])).toEqual([
      [38.5, -120.2], [40.7, -120.95], [43.252, -126.453], // road a → b
      [44, -127]                                           // no road b → c: straight
    ]);
  });

  it('splits a ride into parts along roads and straight parts where the route is unknown', () => {
    service.load();
    http.expectOne('assets/data/shapes.json').flush({ source: '', builtAt: '', shapes: { 'a>b': '_p~iF~ps|U_ulLnnqC_mqNvxq`@' } });

    expect(service.parts([A, B, C])).toEqual([
      { known: true, points: [[38.5, -120.2], [40.7, -120.95], [43.252, -126.453]] },
      { known: false, points: [[43.252, -126.453], [44, -127]] }
    ]);
  });

  it('treats everything as known until the road lines are loaded', () => {
    expect(service.parts([A, B, C]).map(p => p.known)).toEqual([true]);
  });

  it('keeps drawing straight lines when the file is missing', () => {
    service.load();
    http.expectOne('assets/data/shapes.json').flush('', { status: 404, statusText: 'Not Found' });
    expect(service.loaded()).toBe(false);
    expect(service.path([A, B]).length).toBe(2);
  });
});
