import { TestBed } from '@angular/core/testing';
import { FavoritesService } from '../../../core/services/favorites.service';
import { StopsService } from '../../../core/services/stops.service';
import { Stop } from '../../../shared/models/transit.models';
import { StopInputComponent } from './stop-input.component';

const stop = (id: string, name: string): Stop => ({ id, name, lat: 49.7, lng: 21.4, designator: 0, onlyDisembarking: false });

describe('StopInputComponent', () => {
  beforeEach(() => {
    localStorage.clear();
    TestBed.inject(StopsService).stops.set([stop('a', 'JASŁO,ul.RYNEK 02'), stop('b', 'JASŁO,ul.3 MAJA 01'), stop('c', 'WARZYCE Kościół')]);
  });

  function render() {
    const fixture = TestBed.createComponent(StopInputComponent);
    fixture.componentRef.setInput('label', 'Punkt startowy A');
    fixture.detectChanges();
    return fixture;
  }

  const items = (el: HTMLElement) => [...el.querySelectorAll('.suggestion-list li')].map(li => li.textContent!.trim());

  it('suggests matching stops while typing', () => {
    const fixture = render();
    const input: HTMLInputElement = fixture.nativeElement.querySelector('input');
    input.value = 'rynek';
    input.dispatchEvent(new Event('input'));
    fixture.detectChanges();

    expect(items(fixture.nativeElement)).toEqual(['JASŁO,ul.RYNEK 02']);
    expect(fixture.componentInstance.text()).toBe('rynek');
  });

  it('suggests favourite stops when empty and marks them with a star', () => {
    TestBed.inject(FavoritesService).toggleFavorite('c');
    const fixture = render();
    fixture.nativeElement.querySelector('input').dispatchEvent(new Event('focus'));
    fixture.detectChanges();

    expect(items(fixture.nativeElement)).toEqual(['★ WARZYCE Kościół']);
  });

  it('emits the picked stop and closes the list', () => {
    const fixture = render();
    let picked: Stop | undefined;
    fixture.componentInstance.selected.subscribe(s => (picked = s));
    fixture.componentInstance.onInput('maja');
    fixture.detectChanges();
    fixture.nativeElement.querySelector('.suggestion-list li').click();
    fixture.detectChanges();

    expect(picked?.id).toBe('b');
    expect(fixture.nativeElement.querySelector('.suggestion-list')).toBeNull();
  });

  it('labels the field', () => {
    const fixture = render();
    const label: HTMLLabelElement = fixture.nativeElement.querySelector('label');
    expect(label.textContent).toBe('Punkt startowy A');
    expect(fixture.nativeElement.querySelector(`#${label.htmlFor}`)).not.toBeNull();
  });
});
