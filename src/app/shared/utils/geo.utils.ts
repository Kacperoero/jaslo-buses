import { Stop } from '../models/transit.models';

/** Great-circle distance in metres (haversine formula). */
export function getDistance(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371e3;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
            Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

/** The `count` stops closest to a point, nearest first. */
export function getNearestStops(
  stops: Stop[], lat: number, lng: number, count = 3
): { stop: Stop; distance: number }[] {
  return stops
    .filter(stop => stop && typeof stop.lat === 'number' && typeof stop.lng === 'number')
    .map(stop => ({ stop, distance: getDistance(lat, lng, stop.lat, stop.lng) }))
    .sort((a, b) => a.distance - b.distance)
    .slice(0, count);
}
