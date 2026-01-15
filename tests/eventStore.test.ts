import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildSyncResponse, type EventStoreResult } from '../src/sync/eventStore.js';

describe('eventStore', () => {
  describe('buildSyncResponse', () => {
    it('should build response with all counts', () => {
      const result: EventStoreResult = {
        accepted: ['event-1', 'event-2', 'event-3'],
        duplicated: ['event-4'],
        rejected: [{ event_id: 'event-5', reason: 'Invalid payload' }],
      };

      const response = buildSyncResponse(result, 'cursor-123');

      expect(response).toEqual({
        accepted: 3,
        duplicated: 1,
        rejected: [{ event_id: 'event-5', reason: 'Invalid payload' }],
        last_cursor: 'cursor-123',
      });
    });

    it('should handle empty result', () => {
      const result: EventStoreResult = {
        accepted: [],
        duplicated: [],
        rejected: [],
      };

      const response = buildSyncResponse(result);

      expect(response).toEqual({
        accepted: 0,
        duplicated: 0,
        rejected: [],
        last_cursor: undefined,
      });
    });

    it('should preserve cursor value', () => {
      const result: EventStoreResult = {
        accepted: ['event-1'],
        duplicated: [],
        rejected: [],
      };

      const response = buildSyncResponse(result, 'opaque-cursor-value');

      expect(response.last_cursor).toBe('opaque-cursor-value');
    });

    it('should include all rejected events with reasons', () => {
      const result: EventStoreResult = {
        accepted: [],
        duplicated: [],
        rejected: [
          { event_id: 'event-1', reason: 'Reason 1' },
          { event_id: 'event-2', reason: 'Reason 2' },
        ],
      };

      const response = buildSyncResponse(result);

      expect(response.rejected).toHaveLength(2);
      expect(response.rejected[0]).toEqual({ event_id: 'event-1', reason: 'Reason 1' });
      expect(response.rejected[1]).toEqual({ event_id: 'event-2', reason: 'Reason 2' });
    });
  });

  // Note: Integration tests for ingestEvents would require a database connection
  // and are better suited for integration test suites with test containers
});
