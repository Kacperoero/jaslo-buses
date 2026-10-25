import { Injectable } from '@angular/core';

export interface Position {
  lat: number;
  lng: number;
}

/** The user's position from the browser (asks for permission the first time). */
@Injectable({
  providedIn: 'root'
})
export class GeolocationService {
  locate(): Promise<Position> {
    return new Promise((resolve, reject) => {
      if (!('geolocation' in navigator)) {
        reject(new Error('Przeglądarka nie udostępnia lokalizacji'));
        return;
      }
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
        err => reject(new Error(err.code === err.PERMISSION_DENIED
          ? 'Brak zgody na użycie lokalizacji'
          : 'Nie udało się ustalić lokalizacji')),
        { enableHighAccuracy: true, timeout: 10_000, maximumAge: 60_000 }
      );
    });
  }
}
