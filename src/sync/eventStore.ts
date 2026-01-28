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
  tx: Prisma.TransactionClient,
  eventIds: string[]
): Promise<Set<string>> {
  const existing = await tx.event.findMany({
    where: {
      eventId: { in: eventIds },
    },
    select: { eventId: true },
  });
  return new Set(existing.map((e) => e.eventId));
}

/**
 * Inserts events into the event store and projects them to read models.
 * Uses a single transaction for consistency.
 *
 * Behavior:
 * - Duplicate events (by event_id) are skipped but not rejected
 * - Events with invalid payloads for projection are rejected
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

  await prisma.$transaction(async (tx) => {
    // Find duplicates
    const eventIds = validEvents.map((e) => e.event_id);
    const existingIds = await findExistingEventIds(tx, eventIds);

    // Separate duplicates from new events
    const newEvents: EventInput[] = [];
    for (const event of validEvents) {
      if (existingIds.has(event.event_id)) {
        result.duplicated.push(event.event_id);
      } else {
        newEvents.push(event);
      }
    }

    if (newEvents.length === 0) {
      return;
    }

    // Insert new events
    await tx.event.createMany({
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

    // Project each event
    for (const event of newEvents) {
      try {
        const projectionResult = await projectEvent(tx, event, logger);
        if (projectionResult.success) {
          result.accepted.push(event.event_id);
        } else {
          // Projection failed - we still accepted the event in the store
          // but log the projection error
          logger?.error({
            event_id: event.event_id,
            type: event.type,
            error: projectionResult.error,
          }, 'Projection failed for event');
          // Still mark as accepted since event is stored
          result.accepted.push(event.event_id);
        }
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        logger?.error({
          event_id: event.event_id,
          type: event.type,
          error: errorMessage,
        }, 'Exception during projection');
        // Event is still in the store, mark as accepted
        result.accepted.push(event.event_id);
      }
    }
  });

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
