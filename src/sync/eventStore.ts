import { PrismaClient, Prisma } from '@prisma/client';
import type { EventInput, SyncResponse } from './schemas.js';
import { projectEvent } from './projections.js';

export interface EventStoreResult {
  accepted: string[];
  duplicated: string[];
  rejected: Array<{ event_id: string; reason: string }>;
}

/**
 * Checks which event IDs already exist in the store
 */
async function findExistingEventIds(
  prisma: PrismaClient,
  eventIds: string[]
): Promise<Set<string>> {
  const existing = await prisma.event.findMany({
    where: {
      eventId: { in: eventIds },
    },
    select: { eventId: true },
  });
  return new Set(existing.map((e) => e.eventId));
}

/**
 * Inserts events into the event store and projects them to read models.
 *
 * Design: Event storage and projection are separated into two phases.
 * Phase 1 inserts events atomically. Phase 2 projects each event
 * individually so a projection failure doesn't roll back the event store.
 *
 * Behavior:
 * - Duplicate events (by event_id) are skipped but not rejected
 * - Projection errors are logged but don't prevent event storage
 * - All accepted events are inserted atomically
 */
export async function ingestEvents(
  prisma: PrismaClient,
  edgeId: string,
  events: EventInput[],
  logger?: { info: (...args: unknown[]) => void; error: (...args: unknown[]) => void }
): Promise<EventStoreResult> {
  const result: EventStoreResult = {
    accepted: [],
    duplicated: [],
    rejected: [],
  };

  if (events.length === 0) {
    return result;
  }

  // Validate that all events belong to the claimed edge_id
  for (const event of events) {
    if (event.edge_id !== edgeId) {
      result.rejected.push({
        event_id: event.event_id,
        reason: `Event edge_id '${event.edge_id}' does not match request edge_id '${edgeId}'`,
      });
    }
  }

  // Filter out rejected events for further processing
  const validEvents = events.filter(
    (e) => !result.rejected.some((r) => r.event_id === e.event_id)
  );

  if (validEvents.length === 0) {
    return result;
  }

  // Phase 1: Deduplicate and insert events atomically
  const eventIds = validEvents.map((e) => e.event_id);
  const existingIds = await findExistingEventIds(prisma, eventIds);

  const newEvents: EventInput[] = [];
  for (const event of validEvents) {
    if (existingIds.has(event.event_id)) {
      result.duplicated.push(event.event_id);
    } else {
      newEvents.push(event);
    }
  }

  if (newEvents.length === 0) {
    return result;
  }

  // Insert all new events in one transaction
  await prisma.event.createMany({
    data: newEvents.map((event) => ({
      eventId: event.event_id,
      edgeId: event.edge_id,
      aggregateType: event.aggregate_type,
      aggregateId: event.aggregate_id,
      type: event.type,
      occurredAt: new Date(event.occurred_at),
      payload: event.payload as Prisma.JsonObject,
    })),
  });

  // All new events are now stored - mark as accepted
  for (const event of newEvents) {
    result.accepted.push(event.event_id);
  }

  // Phase 2: Project each event individually (failures don't affect event storage)
  for (const event of newEvents) {
    try {
      const projectionResult = await projectEvent(prisma as unknown as Prisma.TransactionClient, event, logger);
      if (!projectionResult.success) {
        logger?.error({
          event_id: event.event_id,
          type: event.type,
          error: projectionResult.error,
        }, 'Projection failed for event');
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : 'Unknown error';
      logger?.error({
        event_id: event.event_id,
        type: event.type,
        error: errorMessage,
      }, 'Exception during projection');
    }
  }

  logger?.info({
    edge_id: edgeId,
    accepted: result.accepted.length,
    duplicated: result.duplicated.length,
    rejected: result.rejected.length,
  }, 'Events ingested');

  return result;
}

/**
 * Builds the sync response from the event store result
 */
export function buildSyncResponse(
  storeResult: EventStoreResult,
  cursor?: string
): SyncResponse {
  return {
    accepted: storeResult.accepted.length,
    duplicated: storeResult.duplicated.length,
    rejected: storeResult.rejected,
    last_cursor: cursor,
  };
}
