import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { syncRequestSchema } from './schemas.js';
import { ingestEvents, buildSyncResponse } from './eventStore.js';
import prisma from '../db/index.js';

export async function syncRoutes(fastify: FastifyInstance): Promise<void> {
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
