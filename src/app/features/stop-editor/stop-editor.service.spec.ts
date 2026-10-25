import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Stop } from '../../shared/models/transit.models';
import { StopEditorService, stopEditorEnabled } from './stop-editor.service';

const stop = (id: string, name: string, directions: 1 | 2, timetableDirections?: 1 | 2): Stop =>
  ({ id, name, lat: 49.7, lng: 21.4, designator: 0, onlyDisembarking: false, directions, timetableDirections });

describe('StopEditorService', () => {
  let editor: StopEditorService;
  let http: HttpTestingController;

  function start(saved: object, stops: Stop[]) {
    editor.start();
    http.expectOne('assets/dev/stop-overrides.json').flush(saved);
    http.expectOne('assets/data/stops-base.json').flush(stops);
  }

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    editor = TestBed.inject(StopEditorService);
    http = TestBed.inject(HttpTestingController);
  });

  it('is enabled with ?dev', () => {
    expect(stopEditorEnabled('?dev')).toBe(true);
    expect(stopEditorEnabled('?x=1')).toBe(false);
  });

  it('walks through unchecked stops in name order and records checks', () => {
    start({ b: { name: 'B', directions: 2 } }, [stop('c', 'C', 1), stop('a', 'A', 2), stop('b', 'B', 2)]);

    expect(editor.currentId()).toBe('a');            // B is checked already
    expect(editor.list().map(s => s.id)).toEqual(['a', 'c']);

    editor.confirmAndNext();                          // A as in the timetable: both directions
    expect(editor.currentId()).toBe('c');
    editor.setDirections(2);                          // C: timetable says one, really both
    expect(editor.checkedCount()).toBe(3);
    expect(editor.pendingCount()).toBe(2);
    expect(JSON.parse(editor.exportJson())).toEqual({
      a: { name: 'A', directions: 2 },
      b: { name: 'B', directions: 2 },
      c: { name: 'C', directions: 2 }
    });

    editor.setFilter('changed');
    expect(editor.list().map(s => s.id)).toEqual(['c']);
  });

  it('keeps work in progress in the browser and drops what is already saved', () => {
    localStorage.setItem('autobusy.stopEditor', JSON.stringify({
      local: { a: { name: 'A', directions: 1 }, b: { name: 'B', directions: 1 } }, currentId: 'b'
    }));
    // A was exported and applied since; B not
    start({ a: { name: 'A', directions: 1 } }, [stop('a', 'A', 1, 2), stop('b', 'B', 2)]);

    expect(editor.local()).toEqual({ b: { name: 'B', directions: 1 } });
    expect(editor.currentId()).toBe('b');
    expect(editor.currentDirections()).toBe(1);
  });
});

describe('StopEditorService moving stops', () => {
  let editor: StopEditorService;
  let http: HttpTestingController;

  beforeEach(() => {
    localStorage.clear();
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    editor = TestBed.inject(StopEditorService);
    http = TestBed.inject(HttpTestingController);
    editor.start();
    http.expectOne('assets/dev/stop-overrides.json').flush({});
    http.expectOne('assets/data/stops-base.json').flush([stop('a', 'A', 2)]);
  });

  it('records a moved stop and moved road points, and can go back to the GTFS position', () => {
    // road points as last computed come from shapes.json – none loaded here
    expect(editor.currentRoadPoints()).toEqual([]);
    editor.moveStop(49.71234567, 21.41);
    expect(editor.currentPosition()).toEqual([49.712346, 21.41]);
    expect(editor.local()['a']).toEqual({ name: 'A', directions: 2, lat: 49.712346, lng: 21.41 });

    editor.setDirections(1);                 // keeps the position
    expect(editor.local()['a'].lat).toBe(49.712346);

    editor.resetPosition();
    expect(editor.currentPosition()).toEqual([49.7, 21.4]);
    expect(editor.local()['a']).toEqual({ name: 'A', directions: 1 });
  });
});
