import { TestBed } from '@angular/core/testing';
import { FavoritesService } from '../../core/services/favorites.service';
import { StopsService } from '../../core/services/stops.service';
import { Stop } from '../../shared/models/transit.models';
import { StopSearchComponent } from './stop-search.component';

const stop = (id: string, name: string): Stop => ({ id, name, lat: 49.7, lng: 21.4, designator: 0, onlyDisembarking: false });

describe('StopSearchComponent', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.inject(StopsService).stops.set([stop('a', 'JASŁO,ul.RYNEK 02'), stop('b', 'JASŁO,ul.3 MAJA 01')]);
  });

  function render() {
    const fixture = TestBed.createComponent(StopSearchComponent);
    fixture.detectChanges();
    return fixture;
  }

  it('lists matching stops and emits the picked one', () => {
    const fixture = render();
    let picked: Stop | undefined;
    fixture.componentInstance.stopSelected.subscribe(s => (picked = s));
    fixture.componentInstance.onInput('3 maja');
    fixture.detectChanges();

    const rows = fixture.nativeElement.querySelectorAll('.search-results li');
    expect(rows.length).toBe(1);
    rows[0].click();
    expect(picked?.id).toBe('b');
  });

  it('says when nothing matches', () => {
    const fixture = render();
    fixture.componentInstance.onInput('xyz');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.search-empty').textContent).toContain('xyz');
  });

  it('shows favourites and recently viewed stops for an empty query', () => {
    const favorites = TestBed.inject(FavoritesService);
    favorites.toggleFavorite('a');
    favorites.addRecentStop('b');
    const fixture = render();
    fixture.componentInstance.open.set(true);
    fixture.detectChanges();

    const headings = [...fixture.nativeElement.querySelectorAll('.list-heading')].map((h: Element) => h.textContent);
    expect(headings).toEqual(['★ Ulubione', 'Ostatnio oglądane']);
  });

  it('stars a stop from the list without picking it', () => {
    const fixture = render();
    let picked = false;
    fixture.componentInstance.stopSelected.subscribe(() => (picked = true));
    fixture.componentInstance.onInput('rynek');
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.row-fav').click();

    expect(TestBed.inject(FavoritesService).isFavorite('a')).toBe(true);
    expect(picked).toBe(false);
  });
});
