import { z } from 'zod';

// Base event schema
export const eventSchema = z.object({
  event_id: z.string().uuid(),
  edge_id: z.string().min(1),
  aggregate_type: z.enum(['case', 'slide', 'annotation', 'thread', 'message', 'preview']),
  aggregate_id: z.string().min(1),
  type: z.string().min(1),
  occurred_at: z.string().datetime({ offset: true }),
  payload: z.record(z.unknown()),
});

export type EventInput = z.infer<typeof eventSchema>;

// Sync request schema
export const syncRequestSchema = z.object({
  edge_id: z.string().min(1),
  cursor: z.string().optional(),
  events: z.array(eventSchema).min(1).max(1000),
});

export type SyncRequest = z.infer<typeof syncRequestSchema>;

// Sync response schema
export const syncResponseSchema = z.object({
  accepted: z.number(),
  duplicated: z.number(),
  rejected: z.array(z.object({
    event_id: z.string(),
    reason: z.string(),
  })),
  last_cursor: z.string().optional(),
});

export type SyncResponse = z.infer<typeof syncResponseSchema>;

// Payload schemas for projections
export const caseUpsertedPayloadSchema = z.object({
  case_id: z.string().min(1),
  title: z.string(),
  patient_ref: z.string(),
  status: z.enum(['active', 'archived']).default('active'),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});

export type CaseUpsertedPayload = z.infer<typeof caseUpsertedPayloadSchema>;

export const slideRegisteredPayloadSchema = z.object({
  slide_id: z.string().min(1),
  case_id: z.string().min(1),
  svs_filename: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  mpp: z.number().positive(),
  scanner: z.string().optional(),
});

export type SlideRegisteredPayload = z.infer<typeof slideRegisteredPayloadSchema>;

export const previewPublishedPayloadSchema = z
  .object({
    slide_id: z.string().min(1),
    case_id: z.string().min(1),
    wasabi_bucket: z.string().min(1),
    wasabi_region: z.string().min(1),
    wasabi_endpoint: z.string().url(),
    wasabi_prefix: z.string().min(1),
    thumb_key: z.string().min(1),
    manifest_key: z.string().min(1),
    // Accept both tiles_prefix (new) and low_tiles_prefix (legacy)
    tiles_prefix: z.string().min(1).optional(),
    low_tiles_prefix: z.string().min(1).optional(),
    max_preview_level: z.number().int().nonnegative(),
    tile_size: z.number().int().positive(),
    format: z.string().min(1),
  })
  .refine(
    (data) => data.tiles_prefix !== undefined || data.low_tiles_prefix !== undefined,
    {
      message: 'Either tiles_prefix or low_tiles_prefix must be provided',
      path: ['tiles_prefix'],
    }
  );

export type PreviewPublishedPayload = z.infer<typeof previewPublishedPayloadSchema>;
