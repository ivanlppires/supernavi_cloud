import { PrismaClient, Prisma } from '@prisma/client';
import type { EventInput } from './schemas.js';
import {
  caseUpsertedPayloadSchema,
  slideRegisteredPayloadSchema,
  previewPublishedPayloadSchema,
} from './schemas.js';

export interface ProjectionResult {
  success: boolean;
  error?: string;
}

/**
 * Projects a CaseUpserted event to cases_read table
 */
async function projectCaseUpserted(
  tx: Prisma.TransactionClient,
  event: EventInput
): Promise<ProjectionResult> {
  const parseResult = caseUpsertedPayloadSchema.safeParse(event.payload);
  if (!parseResult.success) {
    return {
      success: false,
      error: `Invalid CaseUpserted payload: ${parseResult.error.message}`,
    };
  }

  const payload = parseResult.data;

  await tx.caseRead.upsert({
    where: { caseId: payload.case_id },
    create: {
      caseId: payload.case_id,
      title: payload.title,
      patientRef: payload.patient_ref,
      status: payload.status,
      createdAt: new Date(payload.created_at),
      updatedAt: new Date(payload.updated_at),
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
    update: {
      title: payload.title,
      patientRef: payload.patient_ref,
      status: payload.status,
      updatedAt: new Date(payload.updated_at),
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
  });

  return { success: true };
}

/**
 * Projects a SlideRegistered event to slides_read table
 */
async function projectSlideRegistered(
  tx: Prisma.TransactionClient,
  event: EventInput
): Promise<ProjectionResult> {
  const parseResult = slideRegisteredPayloadSchema.safeParse(event.payload);
  if (!parseResult.success) {
    return {
      success: false,
      error: `Invalid SlideRegistered payload: ${parseResult.error.message}`,
    };
  }

  const payload = parseResult.data;

  await tx.slideRead.upsert({
    where: { slideId: payload.slide_id },
    create: {
      slideId: payload.slide_id,
      caseId: payload.case_id,
      svsFilename: payload.svs_filename,
      width: payload.width,
      height: payload.height,
      mpp: payload.mpp,
      scanner: payload.scanner ?? null,
      hasPreview: false,
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
    update: {
      caseId: payload.case_id,
      svsFilename: payload.svs_filename,
      width: payload.width,
      height: payload.height,
      mpp: payload.mpp,
      scanner: payload.scanner ?? null,
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
  });

  return { success: true };
}

/**
 * Projects a PreviewPublished event to preview_assets and updates slides_read
 */
async function projectPreviewPublished(
  tx: Prisma.TransactionClient,
  event: EventInput
): Promise<ProjectionResult> {
  const parseResult = previewPublishedPayloadSchema.safeParse(event.payload);
  if (!parseResult.success) {
    return {
      success: false,
      error: `Invalid PreviewPublished payload: ${parseResult.error.message}`,
    };
  }

  const payload = parseResult.data;

  // Ensure the slide exists (create minimal record if not)
  const existingSlide = await tx.slideRead.findUnique({
    where: { slideId: payload.slide_id },
  });

  if (!existingSlide) {
    // Create a minimal slide record - the full data should come from SlideRegistered
    await tx.slideRead.create({
      data: {
        slideId: payload.slide_id,
        caseId: payload.case_id,
        svsFilename: 'unknown', // Will be updated by SlideRegistered event
        width: 0,
        height: 0,
        mpp: 0,
        hasPreview: true,
        lastEventId: event.event_id,
        lastOccurredAt: new Date(event.occurred_at),
      },
    });
  } else {
    // Update slide to mark it has preview
    await tx.slideRead.update({
      where: { slideId: payload.slide_id },
      data: {
        hasPreview: true,
        lastEventId: event.event_id,
        lastOccurredAt: new Date(event.occurred_at),
      },
    });
  }

  // Upsert preview asset
  await tx.previewAsset.upsert({
    where: { slideId: payload.slide_id },
    create: {
      slideId: payload.slide_id,
      caseId: payload.case_id,
      wasabiBucket: payload.wasabi_bucket,
      wasabiRegion: payload.wasabi_region,
      wasabiEndpoint: payload.wasabi_endpoint,
      wasabiPrefix: payload.wasabi_prefix,
      thumbKey: payload.thumb_key,
      manifestKey: payload.manifest_key,
      lowTilesPrefix: payload.low_tiles_prefix,
      maxPreviewLevel: payload.max_preview_level,
      tileSize: payload.tile_size,
      format: payload.format,
      publishedAt: new Date(event.occurred_at),
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
    update: {
      caseId: payload.case_id,
      wasabiBucket: payload.wasabi_bucket,
      wasabiRegion: payload.wasabi_region,
      wasabiEndpoint: payload.wasabi_endpoint,
      wasabiPrefix: payload.wasabi_prefix,
      thumbKey: payload.thumb_key,
      manifestKey: payload.manifest_key,
      lowTilesPrefix: payload.low_tiles_prefix,
      maxPreviewLevel: payload.max_preview_level,
      tileSize: payload.tile_size,
      format: payload.format,
      publishedAt: new Date(event.occurred_at),
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
  });

  return { success: true };
}

/**
 * Projects a single event to the appropriate read model
 */
export async function projectEvent(
  tx: Prisma.TransactionClient,
  event: EventInput
): Promise<ProjectionResult> {
  switch (event.type) {
    case 'CaseUpserted':
      return projectCaseUpserted(tx, event);
    case 'SlideRegistered':
      return projectSlideRegistered(tx, event);
    case 'PreviewPublished':
      return projectPreviewPublished(tx, event);
    default:
      // Unknown event types are accepted but not projected
      return { success: true };
  }
}

/**
 * Projects multiple events within a transaction
 * Returns results for each event
 */
export async function projectEvents(
  prisma: PrismaClient,
  events: EventInput[]
): Promise<Map<string, ProjectionResult>> {
  const results = new Map<string, ProjectionResult>();

  await prisma.$transaction(async (tx) => {
    for (const event of events) {
      const result = await projectEvent(tx, event);
      results.set(event.event_id, result);
    }
  });

  return results;
}
