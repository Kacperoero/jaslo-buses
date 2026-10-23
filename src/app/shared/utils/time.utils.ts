/**
 * Minutes from `ref` until a departure given as "7 min", "now"/"odjeżdża" or "HH:MM".
 * Unknown formats count as 0 (departing now).
 */
export function parseDepartureTimeToMinutes(timeStr: string, ref: Date): number {
  if (!timeStr) return 0;
  const normalized = timeStr.toLowerCase().trim();
  if (normalized === 'now' || normalized === 'odjeżdża' || normalized === '0 min') {
    return 0;
  }
  const match = normalized.match(/(\d+)\s*min/);
  if (match) {
    return parseInt(match[1], 10);
  }
  const hhmm = normalized.match(/(\d{1,2}):(\d{2})/);
  if (hhmm) {
    const depDate = new Date(ref.getFullYear(), ref.getMonth(), ref.getDate(),
      parseInt(hhmm[1], 10), parseInt(hhmm[2], 10));
    let diffMs = depDate.getTime() - ref.getTime();
    if (diffMs < -12 * 60 * 60 * 1000) {
      diffMs += 24 * 60 * 60 * 1000; // probably next day
    }
    return Math.max(0, Math.round(diffMs / 60000));
  }
  return 0;
}

/** "HH:MM" of the moment `minutesFromRef` after `ref`. */
export function getAbsoluteTimeString(minutesFromRef: number, ref: Date): string {
  const future = new Date(ref.getTime() + minutesFromRef * 60 * 1000);
  return `${String(future.getHours()).padStart(2, '0')}:${String(future.getMinutes()).padStart(2, '0')}`;
}

/** "HH:MM" → minutes after midnight. */
export function parseTimeToMinutesOfDay(timeStr: string): number {
  const parts = timeStr.split(':');
  if (parts.length < 2) return 0;
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

/** Minutes between two "HH:MM" clock times, wrapping past midnight. */
export function minutesBetween(fromHHMM: string, toHHMM: string): number {
  let d = parseTimeToMinutesOfDay(toHHMM) - parseTimeToMinutesOfDay(fromHHMM);
  if (d < 0) d += 1440;
  return d;
}
