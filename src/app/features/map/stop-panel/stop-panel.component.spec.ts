import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { StopsService } from '../../../core/services/stops.service';
import { TimetableService } from '../../../core/services/timetable.service';
import { Stop } from '../../../shared/models/transit.models';
import { MapMarkerService } from '../services/map-marker.service';
import { StopPanelComponent } from './stop-panel.component';

describe('StopPanelComponent', () => {
  const stop: Stop = { id: 's1', name: 'JASŁO,ul.RYNEK 02', lat: 49.7, lng: 21.4, designator: 1, onlyDisembarking: false, directions: 1, towards: 'JASŁO,ul.3 MAJA Poczta' };

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({
      providers: [
        provideHttpClient(), provideHttpClientTesting(),
        { provide: TimetableService, useValue: { getDepartures: () => of({
          timestamp: 0, designator: 0, station_name: '', only_disembarking: false,
          directions: { d1: 'Bierówka' },
          rows: [{ line_name: '3', direction_id: 'd1', time: '08:10', static_time: '08:10', is_estimated: false, minutes_to_departure: 4 }]
        }) } }
      ]
    });
    TestBed.inject(StopsService).stops.set([stop]);
  });

  it('shows nothing until a stop is selected, then its departures', () => {
    const fixture = TestBed.createComponent(StopPanelComponent);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.side-panel')).toBeNull();

    TestBed.inject(MapMarkerService).selectStop('s1');
    fixture.detectChanges();
    TestBed.tick();
    fixture.detectChanges();
    const el: HTMLElement = fixture.nativeElement;
    expect(el.querySelector('.title strong')?.textContent).toBe('JASŁO,ul.RYNEK 02');
    expect(el.textContent).toContain('w stronę: 3 MAJA Poczta');
    expect(el.querySelector('.dep-line')?.textContent).toBe('3');
    expect(el.querySelector('.dep-direction')?.textContent).toBe('Bierówka');
    expect(el.querySelector('.dep-time')?.textContent?.trim()).toBe('4 min');

    (el.querySelector('.side-panel-close') as HTMLButtonElement).click();
    fixture.detectChanges();
    expect(el.querySelector('.side-panel')).toBeNull();
  });
});
