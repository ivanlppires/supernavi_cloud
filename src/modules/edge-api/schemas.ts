import { z } from 'zod';

export const slideInitSchema = z.object({
  filename: z.string().min(1),
  sha256: z.string().min(64).max(64),
  width: z.number().int().nonnegative(),
  height: z.number().int().nonnegative(),
  mpp: z.number().nonnegative().optional(),
  scanner: z.string().nullable().optional(),
  tileSize: z.number().int().default(256),
  expectedTileCount: z.number().int().positive(),
  maxLevel: z.number().int().nonnegative(),
});

export const slideReadySchema = z.object({
  tileCount: z.number().int().positive(),
  levelCounts: z.record(z.string(), z.number().int().nonnegative()).optional(),
});
