import { TripTime } from '../../shared/models/transit.models';

/**
 * Stop IDs a bus passes between boarding at `fromStopId` and getting off at `toStopId`
 * (both included), in order. `boardIndex` is the boarding stop's position in the trip
 * (`trip_index` of the departure) – it matters for loop lines that pass a stop twice.
 * Returns [] when the trip doesn't go from one stop to the other.
 */
export function stopsBetween(times: TripTime[], boardIndex: number, fromStopId: string, toStopId: string): string[] {
  let start = times.findIndex(t => t.index === boardIndex && t.place_id === fromStopId);
  if (start === -1) start = times.findIndex(t => t.place_id === fromStopId);
  if (start === -1) return [];

  for (let end = start + 1; end < times.length; end++) {
    if (times[end].place_id === toStopId) {
      return times.slice(start, end + 1).map(t => t.place_id);
    }
  }
  return [];
}
