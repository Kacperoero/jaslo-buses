import { TestBed } from '@angular/core/testing';
import { Stop } from '../../../shared/models/transit.models';
import { Connection, RideLeg, WalkLeg } from '../route-planner.models';
import { ConnectionCardComponent } from './connection-card.component';
import { connectionSteps, transfersLabel } from './connection-steps';

const stop = (id: string, name: string): Stop => ({ id, name, lat: 49.7, lng: 21.4, designator: 0, onlyDisembarking: false });
const A = stop('a', '3 MAJA 01');
const T = stop('t', 'RYNEK');
const T2 = stop('t2', 'RYNEK 02');
const B = stop('b', 'KAUFLAND');

const ride = (line: string, from: Stop, to: Stop, dep: number, arr: number): RideLeg => ({
  kind: 'ride', line, headsign: to.name, from, to,
  departure: `0${Math.floor(dep / 60)}:${String(dep % 60).padStart(2, '0')}`,
  arrival: `0${Math.floor(arr / 60)}:${String(arr % 60).padStart(2, '0')}`,
  departureMin: dep, arrivalMin: arr, minutes: arr - dep, stops: [from, to], tripId: 'trip:1:0'
});
const walk = (from: string, to: string, minutes: number, toStop?: Stop): WalkLeg => ({
  kind: 'walk', from: { name: from, lat: 0, lng: 0 }, to: { name: to, lat: 0, lng: 0, stop: toStop }, minutes, meters: minutes * 80
});

const direct: Connection = {
  legs: [walk('dom', A.name, 2, A), ride('22', A, B, 455, 462), walk(B.name, 'cel', 3)],
  leaveAt: '07:33', arriveAt: '07:45', totalMinutes: 12, waitMinutes: 3, transfers: 0, leaveMin: 453, arriveMin: 465
};

// K to Rynek, walk to Rynek 02, A to Kaufland
const withWalkTransfer: Connection = {
  legs: [ride('K', A, T, 455, 461), walk(T.name, T2.name, 2, T2), ride('A', T2, B, 466, 474)],
  leaveAt: '07:35', arriveAt: '07:54', totalMinutes: 19, waitMinutes: 0, transfers: 1, leaveMin: 455, arriveMin: 474
};

function render(conn: Connection, selected = false) {
  const fixture = TestBed.createComponent(ConnectionCardComponent);
  fixture.componentRef.setInput('conn', conn);
  fixture.componentRef.setInput('selected', selected);
  fixture.detectChanges();
  return fixture;
}

describe('connectionSteps', () => {
  it('describes a walk, the ride and the walk to the destination', () => {
    expect(connectionSteps(direct).map(s => s.kind === 'ride' ? `ride ${s.ride.line}` : s.text)).toEqual([
      'Dojdź do przystanku 3 MAJA 01', 'ride 22', 'Dojdź do celu'
    ]);
  });

  it('describes a change with a walk to another stop and the waiting time', () => {
    const steps = connectionSteps(withWalkTransfer);
    expect(steps.map(s => s.kind === 'ride' ? `ride ${s.ride.line}` : s.text)).toEqual([
      'ride K', 'Przejdź na przystanek RYNEK 02', 'Zaczekaj na przystanku RYNEK 02', 'ride A'
    ]);
    expect(steps[2].kind === 'change' && steps[2].wait).toBe(3); // arrive 07:41 + 2 min walk, bus 07:46
  });

  it('describes a change at the same stop', () => {
    const conn: Connection = { ...withWalkTransfer, legs: [ride('K', A, T, 455, 461), ride('A', T, B, 465, 474)] };
    const change = connectionSteps(conn)[1];
    expect(change.kind === 'change' && [change.text, change.wait]).toEqual(['Przesiadka na przystanku RYNEK', 4]);
  });

  it('names the number of changes in Polish', () => {
    expect([1, 2, 3, 5, 12, 22].map(transfersLabel)).toEqual(
      ['1 przesiadka', '2 przesiadki', '3 przesiadki', '5 przesiadek', '12 przesiadek', '22 przesiadki']);
  });
});

describe('ConnectionCardComponent', () => {
  it('shows a direct connection with when to leave', () => {
    const el: HTMLElement = render(direct).nativeElement;
    expect(el.querySelector('.line-badge')!.textContent).toBe('22');
    expect(el.querySelector('.time-range')!.textContent).toContain('07:33 – 07:45');
    expect(el.querySelector('.leave-info')!.textContent).toContain('Wyjdź o 07:33 (za 3 min)');
    expect(el.querySelector('.transfers')).toBeNull();
  });

  it('shows all lines and the number of changes', () => {
    const el: HTMLElement = render(withWalkTransfer).nativeElement;
    expect([...el.querySelectorAll('.line-badge')].map(b => b.textContent)).toEqual(['K', 'A']);
    expect(el.querySelector('.transfers')!.textContent).toBe('1 przesiadka');
    expect(el.textContent).toContain('Przejdź na przystanek RYNEK 02');
  });

  it('shows a walking-only suggestion', () => {
    const onlyWalk: Connection = { ...direct, legs: [walk('dom', 'cel', 9)], transfers: -1, totalMinutes: 9 };
    const el: HTMLElement = render(onlyWalk).nativeElement;
    expect(el.querySelector('.line-badge.walk')).not.toBeNull();
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
  });
});
