import { TestBed } from '@angular/core/testing';
import { Stop } from '../../../shared/models/transit.models';
import { Connection } from '../route-planner.models';
import { ConnectionCardComponent } from './connection-card.component';

const stop = (id: string, name: string): Stop => ({ id, name, lat: 49.7, lng: 21.4, designator: 0, onlyDisembarking: false });
const A = stop('a', '3 MAJA 01');
const T = stop('t', 'RYNEK');
const B = stop('b', 'KAUFLAND');
const dep = { time: '5 min', is_estimated: false };

const direct: Connection = {
  startStop: A, endStop: B, line: '22', nextDeparture: dep,
  walkTimeStart: 2, walkTimeEnd: 3, busTime: 7, totalTime: 17, waitingTimeAtStop: 5,
  departureTimeAbs: '07:35', arrivalTimeAbs: '07:42'
};

const transfer: Connection = {
  ...direct, line: 'K ➔ A', isTransfer: true, transferStop: T, walkTimeTransfer: 4,
  legs: [
    { startStop: A, endStop: T, line: 'K', nextDeparture: dep, busTime: 6, departureTimeAbs: '07:35', arrivalTimeAbs: '07:41', waitingTimeAtStop: 5 },
    { startStop: T, endStop: B, line: 'A', nextDeparture: dep, busTime: 8, departureTimeAbs: '07:45', arrivalTimeAbs: '07:53', waitingTimeAtStop: 4 }
  ]
};

function render(conn: Connection, selected = false) {
  const fixture = TestBed.createComponent(ConnectionCardComponent);
  fixture.componentRef.setInput('conn', conn);
  fixture.componentRef.setInput('selected', selected);
  fixture.detectChanges();
  return fixture;
}

describe('ConnectionCardComponent', () => {
  it('shows a direct connection', () => {
    const el: HTMLElement = render(direct).nativeElement;
    expect(el.querySelector('.line-badge')!.textContent).toBe('22');
    expect(el.querySelector('.time-range')!.textContent).toContain('07:35 - 07:42');
    expect(el.textContent).toContain('Jedź do: KAUFLAND (7 min)');
    expect(el.textContent).toContain('Odjazd: 07:35 (za 5 min)');
  });

  it('shows both lines and the transfer stop', () => {
    const el: HTMLElement = render(transfer).nativeElement;
    expect([...el.querySelectorAll('.line-badge')].map(b => b.textContent)).toEqual(['K', 'A']);
    expect(el.querySelector('.transfer-divider')!.textContent).toContain('RYNEK');
    expect(el.textContent).toContain('czas na przesiadkę: 4 min');
  });

  it('says when there is no trip soon', () => {
    const el: HTMLElement = render({ ...direct, nextDeparture: null, departureTimeAbs: 'Brak kursu' }).nativeElement;
    expect(el.querySelector('.departure-time.missing')).not.toBeNull();
    expect(el.querySelector('.time-range')).toBeNull();
  });

  it('can be chosen with a click or the keyboard', () => {
    const fixture = render(direct, true);
    let chosen = 0;
    fixture.componentInstance.chosen.subscribe(() => chosen++);
    const host: HTMLElement = fixture.nativeElement;
    host.click();
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));

    expect(chosen).toBe(2);
    expect(host.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.connection-card.selected')).not.toBeNull();
  });
});
