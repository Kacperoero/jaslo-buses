import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, map, catchError, of } from 'rxjs';
import {
  DeparturesResponse,
  DirectionsResponse,
  StopDirection,
  TripExecutionResponse
} from '../../shared/models/transit.models';

@Injectable({
  providedIn: 'root'
})
export class TimetableService {
  /**
   * Use relative /api path — in dev mode this is proxied to kiedyprzyjedzie.pl.
   * In production, configure the same proxy at the reverse-proxy level.
   */
  private readonly baseUrl = '/api';

  constructor(private http: HttpClient) {}

  /**
   * Fetch departures for a given stop by its placeId.
   * The placeId must be URL-encoded since it contains a colon.
   */
  getDeparturesForStop(stopId: string): Observable<DeparturesResponse> {
    const encodedId = encodeURIComponent(stopId);
    return this.http.get<DeparturesResponse>(
      `${this.baseUrl}/departures/${encodedId}`
    );
  }

  /**
   * Fetch which bus lines/directions serve a given stop.
   */
  getDirectionsForStop(stopId: string): Observable<StopDirection[]> {
    const encodedId = encodeURIComponent(stopId);
    return this.http.get<DirectionsResponse>(
      `${this.baseUrl}/directions/${encodedId}`
    ).pipe(
      map(res => res.directions || []),
      catchError(() => of([]))
    );
  }

  /**
   * Fetch details of a specific trip by its execution ID.
   * Encodes the ID in Base64 (using btoa) as required by the API.
   */
  getTripExecution(tripExecutionId: string): Observable<TripExecutionResponse> {
    const encodedId = encodeURIComponent(btoa(tripExecutionId));
    return this.http.get<TripExecutionResponse>(
      `${this.baseUrl}/trip_execution/${encodedId}`
    );
  }
}
