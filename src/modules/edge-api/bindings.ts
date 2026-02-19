import { createHash } from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/index.js';
import config from '../../config/index.js';

/**
 * Device/extension auth - reuses the same dual-mode auth as ui-bridge.
 * Supports x-supernavi-key (legacy) and x-device-token (paired device).
 */
async function authenticateDevice(
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const apiKey = request.headers['x-supernavi-key'] as string | undefined;
  if (apiKey && config.UI_BRIDGE_API_KEY && apiKey === config.UI_BRIDGE_API_KEY) {
    return;
  }

  const deviceToken = request.headers['x-device-token'] as string | undefined;
  if (deviceToken) {
    const tokenHash = createHash('sha256').update(deviceToken).digest('hex');
    const device = await prisma.extensionDevice.findFirst({
      where: { tokenHash, revokedAt: null },
    });
    if (device) {
      prisma.extensionDevice
        .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {});
      (request as any).extensionDevice = device;
      return;
    }
  }

  return reply.status(401).send({ error: 'Invalid or missing API key' });
}

export async function bindingsRoutes(fastify: FastifyInstance) {
  // POST /api/v1/bindings
  // Create a binding between a pathowebRef and a slideId
  fastify.post<{ Body: { pathowebRef: string; slideId: string } }>(
    '/api/v1/bindings',
    { preHandler: authenticateDevice },
    async (request, reply) => {
      const { pathowebRef, slideId } = request.body;
      if (!pathowebRef || !slideId) {
        return reply.code(400).send({ error: 'pathowebRef and slideId are required' });
      }

      const slide = await prisma.slideRead.findUnique({ where: { slideId } });
      if (!slide || slide.cloudStatus !== 'READY') {
        return reply.code(400).send({ error: 'Slide not found or not READY' });
      }

      const binding = await prisma.caseBinding.upsert({
        where: {
          pathowebRef_slideId: { pathowebRef: pathowebRef.toUpperCase(), slideId },
        },
        create: {
          labId: slide.labId!,
          pathowebRef: pathowebRef.toUpperCase(),
          slideId,
          boundByUserId: (request as any).extensionDevice?.clinicId ?? null,
        },
        update: {},
      });

      return { ok: true, bindingId: binding.id };
    },
  );

  // GET /api/v1/bindings/:pathowebRef
  // Get all slides bound to a pathowebRef
  fastify.get<{ Params: { pathowebRef: string } }>(
    '/api/v1/bindings/:pathowebRef',
    { preHandler: authenticateDevice },
    async (request, reply) => {
      const { pathowebRef } = request.params;

      const bindings = await prisma.caseBinding.findMany({
        where: { pathowebRef: pathowebRef.toUpperCase() },
      });

      if (bindings.length === 0) {
        return reply.code(404).send({ error: 'No bindings found' });
      }

      const results = await Promise.all(
        bindings.map(async (b) => {
          const slide = await prisma.slideRead.findUnique({
            where: { slideId: b.slideId },
          });
          return {
            slideId: b.slideId,
            status: slide?.cloudStatus ?? 'UNKNOWN',
            filename: slide?.svsFilename,
            width: slide?.width,
            height: slide?.height,
            boundAt: b.boundAt,
          };
        }),
      );

      return { pathowebRef: pathowebRef.toUpperCase(), bindings: results };
    },
  );

  // GET /api/v1/slides/ready
  // List READY slides (for extension to bind from)
  fastify.get(
    '/api/v1/slides/ready',
    { preHandler: authenticateDevice },
    async (request, reply) => {
      const slides = await prisma.slideRead.findMany({
        where: { cloudStatus: 'READY' },
        orderBy: { updatedAt: 'desc' },
        take: 50,
      });

      return {
        slides: slides.map((s) => ({
          slideId: s.slideId,
          filename: s.svsFilename,
          width: s.width,
          height: s.height,
          status: s.cloudStatus,
          updatedAt: s.updatedAt,
        })),
      };
    },
  );
}
