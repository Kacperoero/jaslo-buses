import { TripTime } from '../../shared/models/transit.models';
import { stopsBetween } from './ride-path';

const trip = (...ids: string[]): TripTime[] =>
  ids.map((place_id, index) => ({ stop_name: place_id, external: false, designator: 0, place_id, departure_time: '08:00', index }));

describe('stopsBetween', () => {
  it('returns the stops from boarding to getting off, in order', () => {
    expect(stopsBetween(trip('a', 'b', 'c', 'd'), 1, 'b', 'd')).toEqual(['b', 'c', 'd']);
  });

  it('uses the boarding position on loop lines that pass a stop twice', () => {
    // a → b → c → a → d: boarding at the second visit of "a" goes straight to "d"
    expect(stopsBetween(trip('a', 'b', 'c', 'a', 'd'), 3, 'a', 'd')).toEqual(['a', 'd']);
  });

  it('falls back to the first visit when the position does not match', () => {
    expect(stopsBetween(trip('a', 'b', 'c'), 7, 'a', 'c')).toEqual(['a', 'b', 'c']);
  });

  it('returns nothing when the bus does not go there after boarding', () => {
    expect(stopsBetween(trip('a', 'b', 'c'), 2, 'c', 'a')).toEqual([]);
    expect(stopsBetween(trip('a', 'b', 'c'), 0, 'x', 'c')).toEqual([]);
  });
});
