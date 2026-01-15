import { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { checkDatabaseHealth } from '../db/index.js';

export async function healthRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /health
   * Basic liveness check - always returns 200 if server is running
   */
  fastify.get('/health', async (_request: FastifyRequest, reply: FastifyReply) => {
    return reply.send({
      status: 'ok',
      timestamp: new Date().toISOString(),
    });
  });

  /**
   * GET /ready
   * Readiness check - verifies database connectivity
   */
  fastify.get('/ready', async (_request: FastifyRequest, reply: FastifyReply) => {
    const dbHealthy = await checkDatabaseHealth();

    if (!dbHealthy) {
      return reply.status(503).send({
        status: 'not_ready',
        timestamp: new Date().toISOString(),
        checks: {
          database: 'unhealthy',
        },
      });
    }

    return reply.send({
      status: 'ready',
      timestamp: new Date().toISOString(),
      checks: {
        database: 'healthy',
      },
    });
  });
}

export default healthRoutes;
