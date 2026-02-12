import { z } from 'zod';

export const startPairingSchema = z.object({
  name: z.string().min(1).max(100).optional(),
});

export const claimPairingSchema = z.object({
  code: z.string().length(6),
});

export const revokePairingSchema = z.object({
  deviceId: z.string().uuid(),
});

export type StartPairingBody = z.infer<typeof startPairingSchema>;
export type ClaimPairingBody = z.infer<typeof claimPairingSchema>;
export type RevokePairingBody = z.infer<typeof revokePairingSchema>;
