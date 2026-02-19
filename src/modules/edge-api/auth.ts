import { createHash } from 'crypto';
import { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/index.js';

/**
 * Authenticate edge devices via X-EDGE-KEY header.
 *
 * Hashes the raw key with SHA-256, looks up in edge_keys table.
 * On success, attaches edgeKey, labId, labName to the request.
 */
export async function authenticateEdgeKey(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const rawKey = request.headers['x-edge-key'] as string | undefined;
  if (!rawKey) {
    reply.code(401).send({ error: 'Missing X-EDGE-KEY header' });
    return;
  }

  const keyHash = createHash('sha256').update(rawKey).digest('hex');

  const edgeKey = await prisma.edgeKey.findFirst({
    where: { keyHash, isActive: true },
    include: { lab: true },
  });

  if (!edgeKey) {
    reply.code(401).send({ error: 'Invalid or inactive edge key' });
    return;
  }

  (request as any).edgeKey = edgeKey;
  (request as any).labId = edgeKey.labId;
  (request as any).labName = edgeKey.lab.name;
}
