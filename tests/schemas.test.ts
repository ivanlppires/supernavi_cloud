import { describe, it, expect } from 'vitest';
import {
  syncRequestSchema,
  eventSchema,
  caseUpsertedPayloadSchema,
  slideRegisteredPayloadSchema,
  previewPublishedPayloadSchema,
} from '../src/sync/schemas.js';

describe('Sync Schemas', () => {
  describe('eventSchema', () => {
    it('should validate a valid event', () => {
      const event = {
        event_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        edge_id: 'edge-001',
        aggregate_type: 'case',
        aggregate_id: 'case-123',
        type: 'CaseUpserted',
        occurred_at: '2024-01-15T10:30:00Z',
        payload: { case_id: 'case-123', title: 'Test Case' },
      };

      const result = eventSchema.safeParse(event);
      expect(result.success).toBe(true);
    });

    it('should reject invalid event_id', () => {
      const event = {
        event_id: 'not-a-uuid',
        edge_id: 'edge-001',
        aggregate_type: 'case',
        aggregate_id: 'case-123',
        type: 'CaseUpserted',
        occurred_at: '2024-01-15T10:30:00Z',
        payload: {},
      };

      const result = eventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });

    it('should reject invalid aggregate_type', () => {
      const event = {
        event_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
        edge_id: 'edge-001',
        aggregate_type: 'invalid',
        aggregate_id: 'case-123',
        type: 'CaseUpserted',
        occurred_at: '2024-01-15T10:30:00Z',
        payload: {},
      };

      const result = eventSchema.safeParse(event);
      expect(result.success).toBe(false);
    });
  });

  describe('syncRequestSchema', () => {
    it('should validate a valid sync request', () => {
      const request = {
        edge_id: 'edge-001',
        cursor: 'cursor-123',
        events: [
          {
            event_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            edge_id: 'edge-001',
            aggregate_type: 'case',
            aggregate_id: 'case-123',
            type: 'CaseUpserted',
            occurred_at: '2024-01-15T10:30:00Z',
            payload: {},
          },
        ],
      };

      const result = syncRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });

    it('should reject empty events array', () => {
      const request = {
        edge_id: 'edge-001',
        events: [],
      };

      const result = syncRequestSchema.safeParse(request);
      expect(result.success).toBe(false);
    });

    it('should allow optional cursor', () => {
      const request = {
        edge_id: 'edge-001',
        events: [
          {
            event_id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
            edge_id: 'edge-001',
            aggregate_type: 'case',
            aggregate_id: 'case-123',
            type: 'CaseUpserted',
            occurred_at: '2024-01-15T10:30:00Z',
            payload: {},
          },
        ],
      };

      const result = syncRequestSchema.safeParse(request);
      expect(result.success).toBe(true);
    });
  });

  describe('caseUpsertedPayloadSchema', () => {
    it('should validate a valid CaseUpserted payload', () => {
      const payload = {
        case_id: 'case-123',
        title: 'Test Case',
        patient_ref: 'patient-abc',
        status: 'active',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
      };

      const result = caseUpsertedPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('should default status to active', () => {
      const payload = {
        case_id: 'case-123',
        title: 'Test Case',
        patient_ref: 'patient-abc',
        created_at: '2024-01-15T10:30:00Z',
        updated_at: '2024-01-15T10:30:00Z',
      };

      const result = caseUpsertedPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.status).toBe('active');
      }
    });
  });

  describe('slideRegisteredPayloadSchema', () => {
    it('should validate a valid SlideRegistered payload', () => {
      const payload = {
        slide_id: 'slide-123',
        case_id: 'case-123',
        svs_filename: 'sample.svs',
        width: 100000,
        height: 80000,
        mpp: 0.25,
        scanner: 'Aperio GT450',
      };

      const result = slideRegisteredPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('should allow optional scanner', () => {
      const payload = {
        slide_id: 'slide-123',
        case_id: 'case-123',
        svs_filename: 'sample.svs',
        width: 100000,
        height: 80000,
        mpp: 0.25,
      };

      const result = slideRegisteredPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });

    it('should reject negative dimensions', () => {
      const payload = {
        slide_id: 'slide-123',
        case_id: 'case-123',
        svs_filename: 'sample.svs',
        width: -100,
        height: 80000,
        mpp: 0.25,
      };

      const result = slideRegisteredPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });
  });

  describe('previewPublishedPayloadSchema', () => {
    const basePayload = {
      slide_id: 'slide-123',
      case_id: 'case-123',
      wasabi_bucket: 'supernavi',
      wasabi_region: 'us-east-1',
      wasabi_endpoint: 'https://s3.us-east-1.wasabisys.com',
      wasabi_prefix: 'previews/slide-123/',
      thumb_key: 'previews/slide-123/thumb.jpg',
      manifest_key: 'previews/slide-123/manifest.json',
      max_preview_level: 6,
      tile_size: 256,
      format: 'jpg',
    };

    it('should validate payload with low_tiles_prefix only (legacy)', () => {
      const payload = {
        ...basePayload,
        low_tiles_prefix: 'previews/slide-123/tiles/',
      };

      const result = previewPublishedPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.low_tiles_prefix).toBe('previews/slide-123/tiles/');
        expect(result.data.tiles_prefix).toBeUndefined();
      }
    });

    it('should validate payload with tiles_prefix only (new)', () => {
      const payload = {
        ...basePayload,
        tiles_prefix: 'previews/slide-123/tiles/',
      };

      const result = previewPublishedPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tiles_prefix).toBe('previews/slide-123/tiles/');
        expect(result.data.low_tiles_prefix).toBeUndefined();
      }
    });

    it('should validate payload with both tiles_prefix and low_tiles_prefix', () => {
      const payload = {
        ...basePayload,
        tiles_prefix: 'previews/slide-123/tiles/',
        low_tiles_prefix: 'previews/slide-123/old_tiles/',
      };

      const result = previewPublishedPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.tiles_prefix).toBe('previews/slide-123/tiles/');
        expect(result.data.low_tiles_prefix).toBe('previews/slide-123/old_tiles/');
      }
    });

    it('should reject payload with neither tiles_prefix nor low_tiles_prefix', () => {
      const payload = {
        ...basePayload,
        // Neither tiles_prefix nor low_tiles_prefix
      };

      const result = previewPublishedPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain('tiles_prefix or low_tiles_prefix');
      }
    });

    it('should reject invalid wasabi_endpoint URL', () => {
      const payload = {
        ...basePayload,
        wasabi_endpoint: 'not-a-url',
        low_tiles_prefix: 'previews/slide-123/tiles/',
      };

      const result = previewPublishedPayloadSchema.safeParse(payload);
      expect(result.success).toBe(false);
    });

    it('should validate payload with eu-central-1 region', () => {
      const payload = {
        ...basePayload,
        wasabi_region: 'eu-central-1',
        wasabi_endpoint: 'https://s3.eu-central-1.wasabisys.com',
        wasabi_bucket: 'supernavi-eu',
        tiles_prefix: 'previews/slide-123/tiles/',
      };

      const result = previewPublishedPayloadSchema.safeParse(payload);
      expect(result.success).toBe(true);
    });
  });
});
