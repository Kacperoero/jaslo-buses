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

  it('joins a straight part to the road points of the neighbouring road lines', () => {
    const D = stop('d', 45, -128);
    service.load();
    http.expectOne('assets/data/shapes.json').flush({
      source: '', builtAt: '', shapes: {
        'a>b': encode([[38.6, -120.3], [43.2, -126.4]]),  // road point at A → road point at B
        'c>d': encode([[44.1, -127.1], [45.1, -128.1]])   // road point at C → road point at D
      }
    });

    expect(service.parts([A, B, C, D])).toEqual([
      { known: true, points: [[38.6, -120.3], [43.2, -126.4]] },
      { known: false, points: [[43.2, -126.4], [44.1, -127.1]] }, // no gap at either end
      { known: true, points: [[44.1, -127.1], [45.1, -128.1]] }
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

/** Google polyline encoder (same as scripts/gtfs/build-shapes.mjs) for test data. */
function encode(points: [number, number][]): string {
  let out = '', plat = 0, plng = 0;
  const enc = (v: number) => {
    v = v < 0 ? ~(v << 1) : v << 1;
    let s = '';
    while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return s + String.fromCharCode(v + 63);
  };
  for (const [la, ln] of points) {
    const ilat = Math.round(la * 1e5), ilng = Math.round(ln * 1e5);
    out += enc(ilat - plat) + enc(ilng - plng);
    plat = ilat; plng = ilng;
  }
  return out;
}

describe('ShapesService road points', () => {
  it('gives the road points of a stop and the road lines touching it', () => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    const service = TestBed.inject(ShapesService);
    service.load();
    TestBed.inject(HttpTestingController).expectOne('assets/data/shapes.json').flush({
      source: '', builtAt: '',
      shapes: { 'a>b': encode([[1, 1], [2, 2]]), 'b>c': encode([[2, 2], [3, 3]]), 'c>d': encode([[3, 3], [4, 4]]) },
      roadPoints: { b: [[2, 2, 45], [2.0001, 2.0001, 225]] }
    });

    expect(service.roadPoints('b')).toEqual([{ lat: 2, lng: 2, bearing: 45 }, { lat: 2.0001, lng: 2.0001, bearing: 225 }]);
    expect(service.roadPoints('x')).toEqual([]);
    expect(service.linesAt('b').map(l => `${l.from}>${l.to}`)).toEqual(['a>b', 'b>c']);
  });
});
