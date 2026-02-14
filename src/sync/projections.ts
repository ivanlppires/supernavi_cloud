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

export type Logger = {
  info: (obj: object, msg?: string) => void;
  warn?: (obj: object, msg?: string) => void;
  error: (obj: object, msg?: string) => void;
};

/**
 * Ensures a path ends with a trailing slash
 */
function ensureTrailingSlash(path: string): string {
  return path.endsWith('/') ? path : `${path}/`;
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
      caseId: payload.case_id ?? null,
      svsFilename: payload.svs_filename,
      width: payload.width,
      height: payload.height,
      mpp: payload.mpp || 0.25,
      scanner: payload.scanner ?? null,
      hasPreview: false,
      externalCaseId: payload.external_case_id ?? null,
      externalCaseBase: payload.external_case_base ?? null,
      externalSlideLabel: payload.external_slide_label ?? null,
      confirmedCaseLink: !!payload.external_case_id,
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
    update: {
      ...(payload.case_id && { caseId: payload.case_id }),
      svsFilename: payload.svs_filename,
      ...(payload.width > 0 && { width: payload.width }),
      ...(payload.height > 0 && { height: payload.height }),
      ...(payload.mpp > 0 && { mpp: payload.mpp }),
      scanner: payload.scanner ?? null,
      ...(payload.external_case_id !== undefined && { externalCaseId: payload.external_case_id }),
      ...(payload.external_case_base !== undefined && { externalCaseBase: payload.external_case_base }),
      ...(payload.external_slide_label !== undefined && { externalSlideLabel: payload.external_slide_label }),
      ...(payload.external_case_id && { confirmedCaseLink: true }),
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
  event: EventInput,
  logger?: Logger
): Promise<ProjectionResult> {
  const parseResult = previewPublishedPayloadSchema.safeParse(event.payload);
  if (!parseResult.success) {
    return {
      success: false,
      error: `Invalid PreviewPublished payload: ${parseResult.error.message}`,
    };
  }

  const payload = parseResult.data;

  // Determine tiles prefix: prefer tiles_prefix (new) over low_tiles_prefix (legacy)
  // Schema validation ensures at least one is present
  const usedField = payload.tiles_prefix ? 'tiles_prefix' : 'low_tiles_prefix';
  const rawTilesPrefix = payload.tiles_prefix ?? payload.low_tiles_prefix;

  // This should never happen due to schema validation, but TypeScript needs the check
  if (!rawTilesPrefix) {
    return {
      success: false,
      error: 'PreviewPublished payload missing both tiles_prefix and low_tiles_prefix',
    };
  }

  // Normalize to ensure trailing slash
  const tilesPrefix = ensureTrailingSlash(rawTilesPrefix);

  logger?.info({
    event_id: event.event_id,
    slide_id: payload.slide_id,
    used_field: usedField,
    tiles_prefix: tilesPrefix,
    wasabi_endpoint: payload.wasabi_endpoint,
    wasabi_region: payload.wasabi_region,
    wasabi_bucket: payload.wasabi_bucket,
  }, `PreviewPublished: using ${usedField} for tiles prefix`);

  // Try to find existing slide by ID first
  let existingSlide = await tx.slideRead.findUnique({
    where: { slideId: payload.slide_id },
  });

  // If not found by Edge ID, try to find by filename (for slides created via frontend)
  // The filename in the event payload can be extracted from thumb_key or manifest_key
  if (!existingSlide) {
    // Try to extract filename from thumb_key (format: previews/{slideId}/thumb.jpg)
    // Or check for slides with matching case_id that don't have preview yet
    const slidesWithoutPreview = await tx.slideRead.findMany({
      where: {
        hasPreview: false,
        ...(payload.case_id ? { caseId: payload.case_id } : {}),
      },
      take: 10,
    });

    // If there's only one slide without preview for this case, assume it's the match
    if (slidesWithoutPreview.length === 1) {
      existingSlide = slidesWithoutPreview[0];
      logger?.info({
        event_id: event.event_id,
        edge_slide_id: payload.slide_id,
        matched_slide_id: existingSlide.slideId,
        case_id: payload.case_id,
      }, 'Matched PreviewPublished to existing slide by case');
    }
  }

  if (!existingSlide) {
    // No matching slide found - skip creating new slide and preview asset
    // This can happen when preview events arrive before slide registration
    // or for slides that were created in Edge but not synced to Cloud
    logger?.warn?.({
      event_id: event.event_id,
      edge_slide_id: payload.slide_id,
      case_id: payload.case_id,
    }, 'PreviewPublished: no matching slide found, skipping');
    return { success: true };
  }

  // Determine the case_id to use: from payload or existing slide
  const caseId = payload.case_id ?? existingSlide.caseId;

  // Update slide to mark it has preview
  await tx.slideRead.update({
    where: { slideId: existingSlide.slideId },
    data: {
      hasPreview: true,
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
  });

  // Use the actual slide ID for preview asset
  const actualSlideId = existingSlide.slideId;

  // Upsert preview asset with normalized tiles prefix
  await tx.previewAsset.upsert({
    where: { slideId: actualSlideId },
    create: {
      slideId: actualSlideId,
      caseId,
      wasabiBucket: payload.wasabi_bucket,
      wasabiRegion: payload.wasabi_region,
      wasabiEndpoint: payload.wasabi_endpoint,
      wasabiPrefix: payload.wasabi_prefix,
      thumbKey: payload.thumb_key,
      manifestKey: payload.manifest_key,
      lowTilesPrefix: tilesPrefix,
      maxPreviewLevel: payload.max_preview_level,
      previewWidth: payload.preview_width ?? null,
      previewHeight: payload.preview_height ?? null,
      tileSize: payload.tile_size,
      format: payload.format,
      publishedAt: new Date(event.occurred_at),
      lastEventId: event.event_id,
      lastOccurredAt: new Date(event.occurred_at),
    },
    update: {
      caseId,
      wasabiBucket: payload.wasabi_bucket,
      wasabiRegion: payload.wasabi_region,
      wasabiEndpoint: payload.wasabi_endpoint,
      wasabiPrefix: payload.wasabi_prefix,
      thumbKey: payload.thumb_key,
      manifestKey: payload.manifest_key,
      lowTilesPrefix: tilesPrefix,
      maxPreviewLevel: payload.max_preview_level,
      previewWidth: payload.preview_width ?? null,
      previewHeight: payload.preview_height ?? null,
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
  event: EventInput,
  logger?: Logger
): Promise<ProjectionResult> {
  switch (event.type) {
    case 'CaseUpserted':
      return projectCaseUpserted(tx, event);
    case 'SlideRegistered':
      return projectSlideRegistered(tx, event);
    case 'PreviewPublished':
      return projectPreviewPublished(tx, event, logger);
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
