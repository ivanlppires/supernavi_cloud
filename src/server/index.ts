import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import config from '../config/index.js';
import { connectDatabase, disconnectDatabase } from '../db/index.js';
import { healthRoutes } from './health.js';
import { syncRoutes } from '../sync/routes.js';
import { readRoutes } from '../modules/read/routes.js';

async function buildServer() {
  const fastify = Fastify({
    logger: {
      level: config.NODE_ENV === 'production' ? 'info' : 'debug',
      transport: config.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
    // Request body size limit (10MB default)
    bodyLimit: 10 * 1024 * 1024,
  });

  // CORS - disabled/restricted by default for API
  await fastify.register(cors, {
    origin: false, // Disable CORS by default
  });

  // Rate limiting
  await fastify.register(rateLimit, {
    max: 100, // Max 100 requests per minute per IP
    timeWindow: '1 minute',
    // Higher limit for sync endpoint since edge may batch events
    keyGenerator: (request) => request.ip,
  });

  // Register routes
  await fastify.register(healthRoutes);
  await fastify.register(syncRoutes);
  await fastify.register(readRoutes);

  // Global error handler
  fastify.setErrorHandler((error, request, reply) => {
    request.log.error({ error }, 'Unhandled error');

    // Don't expose internal errors in production
    const message = config.NODE_ENV === 'production'
      ? 'Internal Server Error'
      : error.message;

    return reply.status(error.statusCode ?? 500).send({
      error: message,
    });
  });

  return fastify;
}

async function main() {
  const fastify = await buildServer();

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    fastify.log.info(`Received ${signal}, shutting down gracefully...`);
    await fastify.close();
    await disconnectDatabase();
    process.exit(0);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  try {
    // Connect to database
    fastify.log.info('Connecting to database...');
    await connectDatabase();
    fastify.log.info('Database connected');

    // Start server
    await fastify.listen({
      port: config.PORT,
      host: config.HOST,
    });

    fastify.log.info(`Server listening on ${config.HOST}:${config.PORT}`);
  } catch (err) {
    fastify.log.error(err);
    await disconnectDatabase();
    process.exit(1);
  }
}

main();

export { buildServer };
