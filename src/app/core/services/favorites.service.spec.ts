import { TestBed } from '@angular/core/testing';
import { FavoritesService, SavedPoint } from './favorites.service';

const KEY = 'jakdojade-jaslo:favorites:v1';
const stopPoint = (id: string): SavedPoint => ({ lat: 49.7, lng: 21.4, name: id.toUpperCase(), isStop: true, stopId: id });

describe('FavoritesService', () => {
  const create = () => {
    TestBed.resetTestingModule();
    return TestBed.inject(FavoritesService);
  };

  beforeEach(() => localStorage.clear());

  it('adds and removes favourite stops and keeps them after a reload', () => {
    const fav = create();
    expect(fav.toggleFavorite('a')).toBe(true);
    expect(fav.toggleFavorite('b')).toBe(true);
    expect(fav.toggleFavorite('a')).toBe(false);

    expect(create().favoriteStopIds()).toEqual(['b']);
    expect(create().isFavorite('b')).toBe(true);
  });

  it('keeps recent stops newest first, without duplicates, at most 6', () => {
    const fav = create();
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'b'].forEach(id => fav.addRecentStop(id));

    expect(fav.recentStopIds()).toEqual(['b', 'g', 'f', 'e', 'd', 'c']);
  });

  it('keeps recent routes newest first, without duplicates, at most 5', () => {
    const fav = create();
    for (const id of ['1', '2', '3', '4', '5', '6']) fav.addRecentRoute(stopPoint('a'), stopPoint(id));
    fav.addRecentRoute(stopPoint('a'), stopPoint('3'));

    expect(fav.recentRoutes().map(r => r.to.stopId)).toEqual(['3', '6', '5', '4', '2']);
  });

  it('stores only the needed fields of a point', () => {
    const fav = create();
    fav.addRecentRoute({ ...stopPoint('a'), extra: 'x' } as SavedPoint, { lat: 49.75, lng: 21.48, name: 'Punkt' });

    const stored = JSON.parse(localStorage.getItem(KEY)!);
    expect(stored.recentRoutes[0]).toEqual({
      from: { lat: 49.7, lng: 21.4, name: 'A', isStop: true, stopId: 'a' },
      to: { lat: 49.75, lng: 21.48, name: 'Punkt' }
    });
  });

  it('removes a recent route', () => {
    const fav = create();
    fav.addRecentRoute(stopPoint('a'), stopPoint('b'));
    fav.addRecentRoute(stopPoint('a'), stopPoint('c'));
    fav.removeRecentRoute(fav.recentRoutes()[0]);

    expect(fav.recentRoutes().map(r => r.to.stopId)).toEqual(['b']);
  });

  it('starts empty when storage holds something broken', () => {
    localStorage.setItem(KEY, '{not json');
    expect(create().favoriteStopIds()).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify({ favoriteStopIds: ['a', 5], recentRoutes: [{ from: 1 }] }));
    const fav = create();
    expect(fav.favoriteStopIds()).toEqual(['a']);
    expect(fav.recentRoutes()).toEqual([]);
  });
});

describe('FavoritesService – migration to GTFS stop IDs', () => {
  beforeEach(() => localStorage.clear());

  it('translates old stop IDs and drops the ones without a match', () => {
    TestBed.resetTestingModule();
    const fav = TestBed.inject(FavoritesService);
    fav.toggleFavorite('1332055:1392178');
    fav.toggleFavorite('1332999:1399999');
    fav.addRecentStop('1332055:1392178');
    fav.addRecentRoute(
      { lat: 1, lng: 2, name: '3 Maja 01', isStop: true, stopId: '1332055:1392178' },
      { lat: 3, lng: 4, name: 'Gone', isStop: true, stopId: '1332999:1399999' }
    );

    fav.migrateStopIds({ '1332055:1392178': '13890048_1' });

    expect(fav.favoriteStopIds()).toEqual(['13890048_1']);
    expect(fav.recentStopIds()).toEqual(['13890048_1']);
    expect(fav.recentRoutes()[0].from.stopId).toBe('13890048_1');
    expect(fav.recentRoutes()[0].to).toEqual({ lat: 3, lng: 4, name: 'Gone' }); // kept as a map point
  });
});
