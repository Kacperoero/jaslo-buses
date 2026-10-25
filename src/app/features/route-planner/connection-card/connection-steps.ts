import { Connection, RideLeg, rides } from '../route-planner.models';

/** One line of the step-by-step description on a connection card. */
export type Step =
  | { kind: 'walk'; text: string; minutes: number; meters: number }
  | { kind: 'ride'; ride: RideLeg; stopCount: number }
  | { kind: 'change'; text: string; wait: number };

/**
 * Step-by-step instructions: walk to the first stop, each ride, each change (walking to
 * another stop and/or waiting), and the walk to the destination.
 */
export function connectionSteps(conn: Connection): Step[] {
  const steps: Step[] = [];
  const legs = conn.legs;
  let lastRide: RideLeg | null = null;

  legs.forEach((leg, i) => {
    if (leg.kind === 'walk') {
      const nextRide = legs.slice(i + 1).find((l): l is RideLeg => l.kind === 'ride');
      const text = !lastRide
        ? nextRide ? `Dojdź do przystanku ${leg.to.name}` : `Dojdź do celu`
        : nextRide ? `Przejdź na przystanek ${leg.to.name}` : `Dojdź do celu`;
      steps.push({ kind: 'walk', text, minutes: leg.minutes, meters: leg.meters });
      if (lastRide && nextRide) {
        const wait = nextRide.departureMin - lastRide.arrivalMin - leg.minutes;
        if (wait > 0) steps.push({ kind: 'change', text: `Zaczekaj na przystanku ${leg.to.name}`, wait });
      }
      return;
    }
    if (lastRide && legs[i - 1]?.kind === 'ride') {
      steps.push({ kind: 'change', text: `Przesiadka na przystanku ${leg.from.name}`, wait: leg.departureMin - lastRide.arrivalMin });
    }
    steps.push({ kind: 'ride', ride: leg, stopCount: leg.stops.length - 1 });
    lastRide = leg;
  });
  return steps;
}

/** "1 przesiadka", "2 przesiadki", "5 przesiadek" */
export function transfersLabel(count: number): string {
  if (count === 1) return '1 przesiadka';
  const lastDigit = count % 10;
  const teens = count % 100 >= 12 && count % 100 <= 14;
  return `${count} ${lastDigit >= 2 && lastDigit <= 4 && !teens ? 'przesiadki' : 'przesiadek'}`;
}

export function lineBadges(conn: Connection): string[] {
  return rides(conn).map(r => r.line);
}
