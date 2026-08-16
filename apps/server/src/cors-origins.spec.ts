import { describe, expect, it } from 'vitest';

import { DEFAULT_CORS_ORIGIN, parseCorsOrigins } from './cors-origins';

describe('parseCorsOrigins', () => {
  it('falls back to the dev origin when unset', () => {
    expect(parseCorsOrigins(undefined)).toEqual([DEFAULT_CORS_ORIGIN]);
  });

  it('falls back to the dev origin when the value is blank or only separators', () => {
    expect(parseCorsOrigins('')).toEqual([DEFAULT_CORS_ORIGIN]);
    expect(parseCorsOrigins('   ')).toEqual([DEFAULT_CORS_ORIGIN]);
    expect(parseCorsOrigins(' , ,')).toEqual([DEFAULT_CORS_ORIGIN]);
  });

  it('parses a single origin', () => {
    expect(parseCorsOrigins('https://last-signal.example')).toEqual([
      'https://last-signal.example',
    ]);
  });

  it('parses a comma-separated list, trimming whitespace and dropping duplicates', () => {
    expect(parseCorsOrigins(' https://a.example , https://b.example ,https://a.example')).toEqual([
      'https://a.example',
      'https://b.example',
    ]);
  });
});
