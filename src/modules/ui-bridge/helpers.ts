import { createHmac, timingSafeEqual } from 'crypto';
import type { PrismaClient } from '@prisma/client';

// ============================================================================
// Pure helpers (no DB, no config dependency)
// ============================================================================

/**
 * Normalize case input.
 * Accepts "AP26000230", "pathoweb:AP26000230", or "pathoweb:ap26000230".
 * Returns raw caseBase (e.g. "AP26000230").
 */
export function normalizeCaseBase(input: string): string {
  return input.replace(/^pathoweb:/i, '').toUpperCase();
}

/**
 * Build the full externalCaseId from a caseBase.
 */
export function toExternalCaseId(caseBase: string): string {
  return `pathoweb:${caseBase}`;
}

// ---- Signed thumb URLs (HMAC, no auth headers needed for <img>) ----------

/**
 * Sign a thumb URL: /api/ui-bridge/thumb/:slideId?exp=EPOCH&sig=HEX
 */
export function signThumbUrl(slideId: string, secret: string, ttlSeconds: number): string {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const data = `${slideId}:${exp}`;
  const sig = createHmac('sha256', secret).update(data).digest('hex');
  return `/api/ui-bridge/thumb/${slideId}?exp=${exp}&sig=${sig}`;
}

/**
 * Verify exp+sig on a thumb request. Returns true if valid.
 */
export function verifyThumbSignature(slideId: string, exp: string, sig: string, secret: string): boolean {
  const expNum = parseInt(exp, 10);
  if (!expNum || expNum < Math.floor(Date.now() / 1000)) return false; // expired
  const data = `${slideId}:${expNum}`;
  const expected = createHmac('sha256', secret).update(data).digest('hex');
  try {
    return timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ============================================================================
// DB helpers
// ============================================================================

export interface PatientData {
  patientName?: string;
  patientId?: string;
  age?: string;
  doctor?: string;
}

/**
 * Find or create a case from PathoWeb patient data.
 * Uses deterministic ID: `pathoweb-{caseBase.toLowerCase()}`.
 * Returns the case record (existing or new).
 */
export async function findOrCreateCase(
  prisma: PrismaClient,
  opts: { caseBase: string; patientData: PatientData; ownerId: string | null },
) {
  const { caseBase, patientData, ownerId } = opts;
  const now = new Date();
  const deterministicCaseId = `pathoweb-${caseBase.toLowerCase()}`;

  let existingCase = await prisma.caseRead.findFirst({
    where: { patientRef: caseBase },
  });

  if (!existingCase) {
    existingCase = await prisma.caseRead.create({
      data: {
        caseId: deterministicCaseId,
        title: patientData.patientName || caseBase,
        patientRef: caseBase,
        patientAge: patientData.age ? parseInt(patientData.age, 10) || null : null,
        doctor: patientData.doctor || null,
        ownerId,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
  } else {
    // Update existing case with fresh patient data
    const updateData: Record<string, any> = { updatedAt: now };
    if (patientData.patientName) updateData.title = patientData.patientName;
    if (patientData.age) updateData.patientAge = parseInt(patientData.age, 10) || null;
    if (patientData.doctor) updateData.doctor = patientData.doctor;
    if (ownerId && !existingCase.ownerId) updateData.ownerId = ownerId;

    await prisma.caseRead.update({
      where: { caseId: existingCase.caseId },
      data: updateData,
    });
  }

  return existingCase;
}

/**
 * Link all sibling slides with the same externalCaseBase to this case.
 * Only updates slides that don't already have a caseId.
 */
export async function linkSiblingSlides(
  prisma: PrismaClient,
  opts: { caseBase: string; caseId: string },
) {
  return prisma.slideRead.updateMany({
    where: { externalCaseBase: opts.caseBase, caseId: null },
    data: { caseId: opts.caseId },
  });
}
