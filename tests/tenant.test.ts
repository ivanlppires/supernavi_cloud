import { describe, it, expect } from 'vitest';
import { edgeFilter, getAuthUserId } from '../src/modules/ui-bridge/tenant.js';

describe('edgeFilter', () => {
  it('should return empty object when edgeIds is null (backward compat)', () => {
    expect(edgeFilter(null)).toEqual({});
  });

  it('should return edgeId IN filter for single edge', () => {
    expect(edgeFilter(['lab01'])).toEqual({ edgeId: { in: ['lab01'] } });
  });

  it('should return edgeId IN filter for multiple edges', () => {
    expect(edgeFilter(['lab01', 'lab02'])).toEqual({
      edgeId: { in: ['lab01', 'lab02'] },
    });
  });

  it('should return edgeId IN filter for empty array', () => {
    expect(edgeFilter([])).toEqual({ edgeId: { in: [] } });
  });
});

describe('getAuthUserId', () => {
  it('should return clinicId from extensionDevice', () => {
    const request = { extensionDevice: { clinicId: 'user-123' } };
    expect(getAuthUserId(request)).toBe('user-123');
  });

  it('should return null when no extensionDevice (legacy API key)', () => {
    const request = {};
    expect(getAuthUserId(request)).toBeNull();
  });

  it('should return null when extensionDevice has no clinicId', () => {
    const request = { extensionDevice: {} };
    expect(getAuthUserId(request)).toBeNull();
  });
});
