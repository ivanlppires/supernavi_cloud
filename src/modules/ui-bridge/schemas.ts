import { z } from 'zod';

export const caseStatusParamsSchema = z.object({
  caseBase: z.string().min(1),
});

export const unassignedQuerySchema = z.object({
  hours: z.coerce.number().int().min(1).max(168).default(24),
});

export const attachBodySchema = z.object({
  slideId: z.string().min(1),
});

export const viewerLinkBodySchema = z.object({
  slideId: z.string().min(1),
  externalCaseId: z.string().optional(),
});

export const thumbParamsSchema = z.object({
  slideId: z.string().min(1),
});
