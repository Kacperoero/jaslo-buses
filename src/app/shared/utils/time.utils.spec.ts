import { getAbsoluteTimeString, minutesBetween, parseDepartureTimeToMinutes } from './time.utils';

const ref = new Date(2026, 9, 26, 7, 30);

describe('parseDepartureTimeToMinutes', () => {
  it('reads "N min" and "now"', () => {
    expect(parseDepartureTimeToMinutes('7 min', ref)).toBe(7);
    expect(parseDepartureTimeToMinutes('odjeżdża', ref)).toBe(0);
    expect(parseDepartureTimeToMinutes('', ref)).toBe(0);
  });

  it('reads clock times relative to the reference moment', () => {
    expect(parseDepartureTimeToMinutes('08:15', ref)).toBe(45);
  });

  it('treats a clock time far in the past as the next day', () => {
    const lateEvening = new Date(2026, 9, 26, 23, 50);
    expect(parseDepartureTimeToMinutes('00:10', lateEvening)).toBe(20);
  });
});

describe('getAbsoluteTimeString', () => {
  it('formats the moment N minutes after the reference', () => {
    expect(getAbsoluteTimeString(45, ref)).toBe('08:15');
  });
});

describe('minutesBetween', () => {
  it('counts minutes between clock times, wrapping past midnight', () => {
    expect(minutesBetween('07:35', '07:42')).toBe(7);
    expect(minutesBetween('23:55', '00:05')).toBe(10);
  });
});
