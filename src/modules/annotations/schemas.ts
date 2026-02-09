import { z } from 'zod';

// Annotation types
export const annotationTypeSchema = z.enum(['rectangle', 'arrow', 'freehand']);
export type AnnotationType = z.infer<typeof annotationTypeSchema>;

export const annotationStatusSchema = z.enum(['open', 'pending_review', 'resolved']);
export type AnnotationStatus = z.infer<typeof annotationStatusSchema>;

export const annotationPrioritySchema = z.enum(['low', 'normal', 'high', 'urgent']);
export type AnnotationPriority = z.infer<typeof annotationPrioritySchema>;

// Coordinates schema
export const coordinatesSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nullable().optional(),
  height: z.number().nullable().optional(),
  points: z.array(z.object({ x: z.number(), y: z.number() })).nullable().optional(),
});

export type Coordinates = z.infer<typeof coordinatesSchema>;

// Create annotation request
export const createAnnotationSchema = z.object({
  name: z.string().min(1).max(255),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#FF0000'),
  type: annotationTypeSchema.default('rectangle'),
  coordinates: coordinatesSchema,
  status: annotationStatusSchema.default('open'),
  priority: annotationPrioritySchema.default('normal'),
  createdBy: z.string().uuid().nullable().optional(),
});

export type CreateAnnotationRequest = z.infer<typeof createAnnotationSchema>;

// Update annotation request
export const updateAnnotationSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  color: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  coordinates: coordinatesSchema.optional(),
  status: annotationStatusSchema.optional(),
  priority: annotationPrioritySchema.optional(),
});

export type UpdateAnnotationRequest = z.infer<typeof updateAnnotationSchema>;

// Annotation response
export const annotationResponseSchema = z.object({
  id: z.number(),
  slideId: z.string(),
  name: z.string(),
  color: z.string(),
  type: z.string(),
  coordinates: coordinatesSchema,
  status: z.string(),
  priority: z.string(),
  createdBy: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type AnnotationResponse = z.infer<typeof annotationResponseSchema>;

// Annotations list response
export const annotationsListResponseSchema = z.object({
  annotations: z.array(annotationResponseSchema),
  total: z.number(),
});

export type AnnotationsListResponse = z.infer<typeof annotationsListResponseSchema>;
