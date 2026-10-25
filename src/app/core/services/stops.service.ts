import { Injectable, computed, inject, signal } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of, shareReplay, tap } from 'rxjs';
import { Stop } from '../../shared/models/transit.models';
import { normalizeName } from '../../shared/utils/text.utils';

/** All stops (public/assets/data/stops-base.json, built from the MKS GTFS) and search over them. */
@Injectable({
  providedIn: 'root'
})
export class StopsService {
  private http = inject(HttpClient);

  readonly stops = signal<Stop[]>([]);
  readonly loading = signal(true);
  readonly byId = computed(() => new Map(this.stops().map(s => [s.id, s])));

  /** Names without case, Polish letters and punctuation – "jaslo 3 maja" finds "JASŁO,ul.3 MAJA 01" */
  private readonly searchable = computed(() => this.stops().map(s => ({ stop: s, key: normalizeName(s.name) })));

  private readonly loaded$ = this.http.get<Stop[]>('assets/data/stops-base.json').pipe(
    tap(stops => this.stops.set(stops)),
    catchError(err => {
      console.error('Failed to load stops', err);
      return of([] as Stop[]);
    }),
    tap(() => this.loading.set(false)),
    shareReplay(1)
  );

  /** Loads the stops once (later calls get the same result). */
  load(): Observable<Stop[]> {
    return this.loaded$;
  }

  /**
   * Stops whose name contains every word of the query, in any order (ignoring case, Polish
   * letters and punctuation) – "jaslo 3 maja" finds "JASŁO,ul.3 MAJA 01".
   */
  search(query: string, limit: number): Stop[] {
    const words = query.split(/\s+/).map(normalizeName).filter(Boolean);
    if (words.length === 0) return [];
    const result: Stop[] = [];
    for (const { stop, key } of this.searchable()) {
      if (words.every(w => key.includes(w))) {
        result.push(stop);
        if (result.length >= limit) break;
      }
    }
    return result;
  }
}
