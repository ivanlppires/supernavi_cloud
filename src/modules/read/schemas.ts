import { z } from 'zod';

// Pagination query params
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export type PaginationParams = z.infer<typeof paginationSchema>;

// Case list item response
export const caseListItemSchema = z.object({
  case_id: z.string(),
  title: z.string(),
  patient_ref: z.string(),
  status: z.string(),
  updated_at: z.string(),
  slides_count: z.number(),
});

export type CaseListItem = z.infer<typeof caseListItemSchema>;

// Case list response
export const caseListResponseSchema = z.object({
  cases: z.array(caseListItemSchema),
  total: z.number(),
  limit: z.number(),
  offset: z.number(),
});

export type CaseListResponse = z.infer<typeof caseListResponseSchema>;

// Slide info in case detail
export const slideInfoSchema = z.object({
  slide_id: z.string(),
  svs_filename: z.string(),
  width: z.number(),
  height: z.number(),
  mpp: z.number(),
  scanner: z.string().nullable(),
  has_preview: z.boolean(),
  updated_at: z.string(),
});

export type SlideInfo = z.infer<typeof slideInfoSchema>;

// Case detail response
export const caseDetailSchema = z.object({
  case_id: z.string(),
  title: z.string(),
  patient_ref: z.string(),
  status: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  slides: z.array(slideInfoSchema),
});

export type CaseDetail = z.infer<typeof caseDetailSchema>;

// Preview response
export const previewResponseSchema = z.object({
  slide_id: z.string(),
  case_id: z.string().nullable(),
  thumb_url: z.string(),
  manifest_url: z.string(),
  tiles: z.object({
    strategy: z.literal('signed-per-tile'),
    max_preview_level: z.number(),
    tile_size: z.number(),
    format: z.string(),
    endpoint: z.string(),
  }),
});

export type PreviewResponse = z.infer<typeof previewResponseSchema>;

// Tile sign request
export const tileSignRequestSchema = z.object({
  key: z.string().min(1),
  expires_seconds: z.coerce.number().int().min(10).max(3600).default(120),
});

export type TileSignRequest = z.infer<typeof tileSignRequestSchema>;

// Tile sign response
export const tileSignResponseSchema = z.object({
  url: z.string(),
});

export type TileSignResponse = z.infer<typeof tileSignResponseSchema>;
