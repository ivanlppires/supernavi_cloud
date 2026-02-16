import 'dotenv/config';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import Fastify, { FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import config from '../config/index.js';
import { connectDatabase, disconnectDatabase } from '../db/index.js';
import { healthRoutes } from './health.js';
import { syncRoutes } from '../sync/routes.js';
import { readRoutes } from '../modules/read/routes.js';
import { edgeRoutes } from '../modules/edge/routes.js';
import { previewRoutes } from '../modules/preview/routes.js';
import { authRoutes } from '../modules/auth/routes.js';
import { annotationRoutes } from '../modules/annotations/routes.js';
import { uiBridgeRoutes } from '../modules/ui-bridge/routes.js';
import { pairingRoutes } from '../modules/pairing/routes.js';
import { adminRoutes } from '../modules/admin/routes.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

  // CORS - restrict to allowed origins in production
  const allowedOrigins = config.ALLOWED_ORIGINS
    ? config.ALLOWED_ORIGINS.split(',').map(o => o.trim())
    : true; // Allow all in dev when ALLOWED_ORIGINS is not set

  await fastify.register(cors, {
    origin: allowedOrigins,
    credentials: true,
  });

  // Content type parser for binary uploads (SVS, TIFF, etc.)
  fastify.addContentTypeParser('*', function (request, payload, done) {
    // For upload endpoints, just pass through the raw stream
    if (request.url.startsWith('/api/upload-stub/')) {
      done(null, payload);
    } else {
      // For other endpoints, let default parser handle it
      done(null, undefined);
    }
  });

  // WebSocket support for edge tunnel
  await fastify.register(websocket);

  // Serve static files from public folder (for preview viewer)
  await fastify.register(fastifyStatic, {
    root: join(__dirname, '../../public'),
    prefix: '/preview/',
    decorateReply: false, // Avoid conflicts if other static plugins used
  });

  // Redirect /preview to /preview/preview.html
  fastify.get('/preview', async (_request, reply) => {
    return reply.redirect('/preview/preview.html');
  });

  // Rate limiting with route-specific limits
  await fastify.register(rateLimit, {
    max: 100, // Default: 100 requests per minute per IP
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    // Skip rate limiting for high-throughput endpoints (handled by route-specific config)
    allowList: (request) => {
      const url = request.url.split('?')[0]; // Remove query string
      // Skip rate limiting for tile endpoints and edge tunnel (viewer needs many tiles)
      return url === '/api/v1/tiles/sign' ||
             url === '/api/v1/tiles/proxy' ||
             url.startsWith('/edge/') ||
             url.startsWith('/preview/') ||
             /^\/api\/slides\/[^/]+\/tiles\//.test(url);
    },
  });

  // Separate higher rate limit for tile and edge endpoints
  await fastify.register(rateLimit, {
    max: 2000, // 2000 requests per minute for tiles/edge
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
    onExceeding: () => {},
    onExceeded: () => {},
    // Only apply to tile and edge endpoints
    allowList: (request) => {
      const url = request.url.split('?')[0];
      const isHighThroughput = url === '/api/v1/tiles/sign' ||
                               url === '/api/v1/tiles/proxy' ||
                               url.startsWith('/edge/') ||
                               url.startsWith('/preview/') ||
                               /^\/api\/slides\/[^/]+\/tiles\//.test(url);
      return !isHighThroughput;
    },
  });

  // Register routes
  await fastify.register(healthRoutes);
  await fastify.register(syncRoutes);
  await fastify.register(readRoutes);
  await fastify.register(edgeRoutes);
  await fastify.register(previewRoutes);
  await fastify.register(authRoutes);
  await fastify.register(annotationRoutes);
  await fastify.register(uiBridgeRoutes);
  await fastify.register(pairingRoutes);
  await fastify.register(adminRoutes);

  // Global error handler
  fastify.setErrorHandler((error: FastifyError, request, reply) => {
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
