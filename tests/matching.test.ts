import { describe, it, expect } from 'vitest';
import { calculateMatchScore, findCandidates, type MatchableSlide } from '../src/modules/ui-bridge/matching.js';

describe('calculateMatchScore', () => {
  it('should return 1.0 for exact externalCaseBase match', () => {
    const slide: MatchableSlide = {
      externalCaseBase: 'AP26000230',
      externalCaseId: 'pathoweb:AP26000230',
      svsFilename: 'AP26000230A2.svs',
    };
    expect(calculateMatchScore('AP26000230', slide)).toBe(1.0);
  });

  it('should return 1.0 regardless of case and separators', () => {
    const slide: MatchableSlide = {
      externalCaseBase: 'ap26000230',
      externalCaseId: 'pathoweb:AP26000230',
      svsFilename: 'AP26000230.svs',
    };
    expect(calculateMatchScore('AP-260.002.30', slide)).toBe(1.0);
  });

  it('should return 0.95 when filename starts with case base', () => {
    const slide: MatchableSlide = {
      externalCaseBase: null,
      externalCaseId: null,
      svsFilename: 'AP26000230A2.svs',
    };
    expect(calculateMatchScore('AP26000230', slide)).toBe(0.95);
  });

  it('should return 0.92 for digit-only match', () => {
    const slide: MatchableSlide = {
      externalCaseBase: null,
      externalCaseId: null,
      svsFilename: 'CASE_26000230_B1.svs',
    };
    expect(calculateMatchScore('AP26000230', slide)).toBe(0.92);
  });

  it('should return 0.88 for O/0 confusion match', () => {
    // Filename has O where case has 0
    const slide: MatchableSlide = {
      externalCaseBase: null,
      externalCaseId: null,
      svsFilename: 'AP26OOO230A2.svs',
    };
    expect(calculateMatchScore('AP26000230', slide)).toBe(0.88);
  });

  it('should return 0 for non-matching slide', () => {
    const slide: MatchableSlide = {
      externalCaseBase: null,
      externalCaseId: null,
      svsFilename: 'random_tissue.svs',
    };
    expect(calculateMatchScore('AP26000230', slide)).toBe(0);
  });

  it('should return 0 for completely different AP number', () => {
    const slide: MatchableSlide = {
      externalCaseBase: 'AP99999999',
      externalCaseId: 'pathoweb:AP99999999',
      svsFilename: 'AP99999999.svs',
    };
    expect(calculateMatchScore('AP26000230', slide)).toBe(0);
  });

  it('should handle filename with underscores and dashes', () => {
    const slide: MatchableSlide = {
      externalCaseBase: null,
      externalCaseId: null,
      svsFilename: 'AP_26000230_A2.svs',
    };
    expect(calculateMatchScore('AP26000230', slide)).toBe(0.95);
  });
});

describe('findCandidates', () => {
  const slides: MatchableSlide[] = [
    { externalCaseBase: 'AP26000230', externalCaseId: 'pathoweb:AP26000230', svsFilename: 'AP26000230A2.svs' },
    { externalCaseBase: null, externalCaseId: null, svsFilename: 'AP26000230B1.svs' },
    { externalCaseBase: null, externalCaseId: null, svsFilename: 'random_tissue.svs' },
    { externalCaseBase: null, externalCaseId: null, svsFilename: 'AP99999999.svs' },
  ];

  it('should return only candidates above minScore', () => {
    const results = findCandidates('AP26000230', slides);
    expect(results.length).toBe(2);
    expect(results[0].score).toBe(1.0);
    expect(results[1].score).toBe(0.95);
  });

  it('should sort by score descending', () => {
    const results = findCandidates('AP26000230', slides);
    for (let i = 1; i < results.length; i++) {
      expect(results[i].score).toBeLessThanOrEqual(results[i - 1].score);
    }
  });

  it('should return empty array when no matches', () => {
    const results = findCandidates('AP11111111', slides);
    expect(results.length).toBe(0);
  });

  it('should respect custom minScore', () => {
    const results = findCandidates('AP26000230', slides, 0.96);
    expect(results.length).toBe(1);
    expect(results[0].score).toBe(1.0);
  });
});
