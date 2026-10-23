import { escapeHtml, namesMatch, normalizeName } from './text.utils';

describe('normalizeName', () => {
  it('folds Polish letters to ASCII', () => {
    expect(normalizeName('Jasło, Kościuszki')).toBe('jaslokosciuszki');
    expect(normalizeName('ŻÓŁĆ Gęślą Jaźń')).toBe('zolcgeslajazn');
  });

  it('returns an empty string for missing values', () => {
    expect(normalizeName(undefined)).toBe('');
    expect(normalizeName(null)).toBe('');
    expect(normalizeName(' - ')).toBe('');
  });
});

describe('namesMatch', () => {
  it('matches names that differ only by case, accents or punctuation', () => {
    expect(namesMatch('JASŁO Dworzec', 'Jaslo-dworzec')).toBe(true);
  });

  it('matches when one name contains the other', () => {
    expect(namesMatch('Bierówka', 'BIERÓWKA 1')).toBe(true);
  });

  it('does not treat names with Polish letters as equal to everything', () => {
    // Before the fix "Łęg" normalized to "g" and "Żółć" to "" (matching any stop)
    expect(namesMatch('Żółć', 'Bierówka')).toBe(false);
    expect(namesMatch('Łęg', 'Gorlice')).toBe(false);
  });

  it('never matches empty names', () => {
    expect(namesMatch('', 'Bierówka')).toBe(false);
    expect(namesMatch('Bierówka', undefined)).toBe(false);
  });
});

describe('escapeHtml', () => {
  it('escapes HTML special characters', () => {
    expect(escapeHtml('<img src=x onerror="alert(1)">')).toBe(
      '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;'
    );
    expect(escapeHtml("A & B's")).toBe('A &amp; B&#39;s');
  });

  it('handles missing values', () => {
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(null)).toBe('');
  });
});
