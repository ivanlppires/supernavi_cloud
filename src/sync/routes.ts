import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { syncRequestSchema, type EventInput } from './schemas.js';
import { ingestEvents, buildSyncResponse } from './eventStore.js';
import prisma from '../db/index.js';

// Edge sync format (from supernavi_edge)
interface EdgeSyncRequest {
  agentId: string;
  labId: string;
  events: Array<{
    eventId: string;
    entityType: string;
    entityId: string;
    op: string;
    createdAt: string;
    payload: Record<string, unknown>;
  }>;
}

export async function syncRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * POST /v1/sync/push
   * Adapter endpoint for Edge sync format
   * Transforms Edge format to Cloud format and calls the main sync logic
   */
  fastify.post('/v1/sync/push', async (request: FastifyRequest, reply: FastifyReply) => {
    const body = request.body as EdgeSyncRequest;
    const agentId = request.headers['x-agent-id'] as string || body.agentId || 'unknown';

    request.log.info({
      agentId,
      labId: body.labId,
      event_count: body.events?.length || 0,
    }, 'Received Edge sync push');

    if (!body.events || body.events.length === 0) {
      return reply.status(200).send({ accepted: [], rejected: [] });
    }

    try {
      // Transform Edge format to Cloud format
      const transformedEvents: EventInput[] = body.events.map(e => {
        // Map entityType to aggregate_type
        let aggregateType: 'case' | 'slide' | 'annotation' | 'thread' | 'message' | 'preview' = 'slide';
        if (e.entityType === 'preview') aggregateType = 'preview';
        else if (e.entityType === 'case') aggregateType = 'case';
        else if (e.entityType === 'slide') aggregateType = 'slide';

        // Map op to type
        let type = e.op;
        if (e.op === 'published') type = 'PreviewPublished';
        else if (e.op === 'registered') type = 'SlideRegistered';
        else if (e.op === 'upserted') type = 'CaseUpserted';

        // Extract aggregate_id from entity_id (format: "type:id")
        const aggregateId = e.entityId.includes(':') ? e.entityId.split(':')[1] : e.entityId;

        return {
          event_id: e.eventId,
          edge_id: agentId,
          aggregate_type: aggregateType,
          aggregate_id: aggregateId,
          type,
          occurred_at: e.createdAt,
          payload: e.payload,
        };
      });

      const storeResult = await ingestEvents(prisma, agentId, transformedEvents, request.log);

      // Transform response to Edge format
      return reply.status(200).send({
        accepted: storeResult.accepted.map(id => id),
        rejected: storeResult.rejected.map(r => ({
          eventId: r.event_id,
          reason: r.reason,
        })),
      });
    } catch (err) {
      request.log.error({ error: err }, 'Failed to process Edge sync push');
      return reply.status(500).send({
        error: 'Internal server error during sync',
      });
    }
  });

  /**
   * POST /sync/v1/events
   * Ingests events from edge devices
   */
  fastify.post('/sync/v1/events', async (request: FastifyRequest, reply: FastifyReply) => {
    // Parse and validate request body
    const parseResult = syncRequestSchema.safeParse(request.body);

    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parseResult.error.format(),
      });
    }

    const { edge_id, cursor, events } = parseResult.data;

    request.log.info({
      edge_id,
      event_count: events.length,
      cursor,
    }, 'Received sync request');

    try {
      const storeResult = await ingestEvents(prisma, edge_id, events, request.log);
      const response = buildSyncResponse(storeResult, cursor);

      return reply.status(200).send(response);
    } catch (err) {
      request.log.error({ error: err }, 'Failed to ingest events');
      return reply.status(500).send({
        error: 'Internal server error during event ingestion',
      });
    }
  });
}

export default syncRoutes;
