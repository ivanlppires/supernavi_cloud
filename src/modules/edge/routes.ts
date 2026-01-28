import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import type { RawData } from 'ws';
import { randomUUID } from 'crypto';
import config from '../../config/index.js';
import {
  registerEdge,
  unregisterEdge,
  updateLastSeen,
  isAgentConnected,
  sendHttpRequest,
  handleHttpResponse,
  getWebSocket,
  getConnectedAgents,
  getConnectionInfo,
  type TunnelHttpResponse,
} from './connectionManager.js';

// Headers to filter out when proxying
const FILTERED_REQUEST_HEADERS = new Set([
  'host',
  'connection',
  'transfer-encoding',
  'upgrade',
  'proxy-connection',
  'keep-alive',
  'te',
  'trailer',
]);

const FILTERED_RESPONSE_HEADERS = new Set([
  'connection',
  'transfer-encoding',
  'keep-alive',
  'proxy-connection',
  'upgrade',
  'trailer',
]);

/**
 * Validate the edge tunnel token
 */
function validateTunnelToken(token: string | undefined): boolean {
  if (!config.EDGE_TUNNEL_TOKEN) {
    // If no token configured, reject all connections (more secure default)
    console.warn('[EdgeRoutes] EDGE_TUNNEL_TOKEN not configured, rejecting connection');
    return false;
  }
  return token === config.EDGE_TUNNEL_TOKEN;
}

/**
 * Extract token from request (header or query param)
 */
function extractToken(request: FastifyRequest): string | undefined {
  // Try Authorization header first
  const authHeader = request.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    return authHeader.slice(7);
  }
  // Fall back to query param
  const query = request.query as { token?: string };
  return query.token;
}

export async function edgeRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * WebSocket endpoint for edge agents to connect
   * GET /edge/connect?agentId=xxx
   * Authorization: Bearer <token>
   */
  fastify.get('/edge/connect', { websocket: true }, (socket, request) => {
    const query = request.query as { agentId?: string };
    const agentId = query.agentId;
    const token = extractToken(request);

    // Validate token
    if (!validateTunnelToken(token)) {
      request.log.warn({ agentId }, 'Edge connection rejected: invalid token');
      socket.close(4001, 'Unauthorized: Invalid token');
      return;
    }

    // Validate agentId
    if (!agentId || typeof agentId !== 'string' || agentId.length === 0) {
      request.log.warn('Edge connection rejected: missing agentId');
      socket.close(4002, 'Bad Request: Missing agentId');
      return;
    }

    // Validate agentId format (alphanumeric, dash, underscore, 1-64 chars)
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(agentId)) {
      request.log.warn({ agentId }, 'Edge connection rejected: invalid agentId format');
      socket.close(4003, 'Bad Request: Invalid agentId format');
      return;
    }

    request.log.info({ agentId }, 'Edge agent connected');
    registerEdge(agentId, socket);

    // Set up ping interval for keep-alive
    const pingInterval = setInterval(() => {
      const ws = getWebSocket(agentId);
      if (ws && ws.readyState === 1) { // WebSocket.OPEN
        ws.ping();
      }
    }, 30000); // Ping every 30 seconds

    // Handle pong response
    socket.on('pong', () => {
      updateLastSeen(agentId);
    });

    // Handle incoming messages
    socket.on('message', (data: RawData) => {
      try {
        const message = JSON.parse(data.toString());

        if (message.type === 'http_response') {
          handleHttpResponse(agentId, message as TunnelHttpResponse);
        } else {
          request.log.warn({ agentId, type: message.type }, 'Unknown message type from edge');
        }
      } catch (err) {
        request.log.error({ agentId, error: err }, 'Failed to parse message from edge');
      }
    });

    // Handle connection close
    socket.on('close', (code: number, reason: Buffer) => {
      clearInterval(pingInterval);
      unregisterEdge(agentId);
      request.log.info({ agentId, code, reason: reason?.toString() }, 'Edge agent disconnected');
    });

    // Handle errors
    socket.on('error', (err: Error) => {
      request.log.error({ agentId, error: err }, 'Edge WebSocket error');
    });
  });

  /**
   * GET /edge/status
   * Returns status of connected edge agents (for debugging)
   */
  fastify.get('/edge/status', async (_request: FastifyRequest, reply: FastifyReply) => {
    const agents = getConnectedAgents().map((agentId) => {
      const info = getConnectionInfo(agentId);
      return {
        agentId,
        connectedAt: info?.connectedAt.toISOString(),
        lastSeen: info?.lastSeen.toISOString(),
      };
    });

    return reply.send({
      connectedAgents: agents.length,
      agents,
    });
  });

  /**
   * Reverse proxy for edge requests
   * ANY /edge/:agentId/*
   *
   * Forwards HTTP requests through the WebSocket tunnel to the edge agent
   */
  fastify.all('/edge/:agentId/*', async (request: FastifyRequest, reply: FastifyReply) => {
    const params = request.params as { agentId: string; '*': string };
    const agentId = params.agentId;
    const path = '/' + (params['*'] || '');

    // Skip /edge/connect and /edge/status
    if (agentId === 'connect' || agentId === 'status') {
      return; // Let the specific handlers above handle these
    }

    // Check if agent is connected
    if (!isAgentConnected(agentId)) {
      return reply.status(503).send({
        error: 'Edge Offline',
        message: `Agent ${agentId} is not connected`,
        agentId,
      });
    }

    // Build the URL with query string
    const queryString = request.url.includes('?')
      ? request.url.substring(request.url.indexOf('?'))
      : '';
    const url = path + queryString;

    // Filter headers
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(request.headers)) {
      const lowerKey = key.toLowerCase();
      if (!FILTERED_REQUEST_HEADERS.has(lowerKey) && value) {
        headers[key] = Array.isArray(value) ? value[0] : value;
      }
    }

    // Determine timeout based on request type
    const isHealthCheck = url.includes('/health');
    const timeoutMs = isHealthCheck
      ? config.EDGE_TUNNEL_HEALTH_TIMEOUT_MS
      : config.EDGE_TUNNEL_TILE_TIMEOUT_MS;

    // Prepare body (if any)
    let bodyBase64: string | undefined;
    if (request.body && typeof request.body !== 'undefined') {
      if (Buffer.isBuffer(request.body)) {
        bodyBase64 = request.body.toString('base64');
      } else if (typeof request.body === 'string') {
        bodyBase64 = Buffer.from(request.body).toString('base64');
      } else {
        bodyBase64 = Buffer.from(JSON.stringify(request.body)).toString('base64');
      }
    }

    const requestId = randomUUID();

    try {
      const response = await sendHttpRequest(
        agentId,
        {
          requestId,
          method: request.method,
          url,
          headers,
          bodyBase64,
        },
        timeoutMs
      );

      // Set response headers
      for (const [key, value] of Object.entries(response.headers || {})) {
        const lowerKey = key.toLowerCase();
        if (!FILTERED_RESPONSE_HEADERS.has(lowerKey)) {
          reply.header(key, value);
        }
      }

      // Set status code
      reply.status(response.statusCode);

      // Send body
      if (response.bodyBase64) {
        const body = Buffer.from(response.bodyBase64, 'base64');
        return reply.send(body);
      }

      return reply.send();
    } catch (err) {
      const error = err as Error;

      if (error.message.includes('timeout')) {
        return reply.status(504).send({
          error: 'Gateway Timeout',
          message: `Request to edge agent ${agentId} timed out after ${timeoutMs}ms`,
          agentId,
          requestId,
        });
      }

      if (error.message.includes('disconnected') || error.message.includes('replaced')) {
        return reply.status(503).send({
          error: 'Edge Offline',
          message: `Agent ${agentId} disconnected during request`,
          agentId,
          requestId,
        });
      }

      request.log.error({ error: err, agentId, requestId }, 'Failed to proxy request to edge');
      return reply.status(502).send({
        error: 'Bad Gateway',
        message: 'Failed to communicate with edge agent',
        agentId,
        requestId,
      });
    }
  });
}

export default edgeRoutes;
