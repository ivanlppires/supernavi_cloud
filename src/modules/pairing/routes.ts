import { randomBytes, createHash } from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/index.js';
import { authenticate } from '../auth/routes.js';
import {
  startPairingSchema,
  claimPairingSchema,
  revokePairingSchema,
  type StartPairingBody,
  type ClaimPairingBody,
  type RevokePairingBody,
} from './schemas.js';

// Unambiguous alphabet: no 0/O, 1/I/L
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;
const CODE_TTL_MINUTES = 10;

function generateCode(): string {
  const bytes = randomBytes(CODE_LENGTH);
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  }
  return code;
}

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function generateDeviceName(): string {
  const adjectives = ['Chrome', 'Lab', 'Desk', 'Main', 'Ext'];
  const nouns = ['Device', 'Station', 'Terminal', 'Browser', 'Client'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)];
  const noun = nouns[Math.floor(Math.random() * nouns.length)];
  const num = Math.floor(Math.random() * 100);
  return `${adj}-${noun}-${num}`;
}

export async function pairingRoutes(fastify: FastifyInstance): Promise<void> {
  // --------------------------------------------------------------------------
  // POST /api/ui-bridge/pairing/start
  //
  // Authenticated user required. Generates a 6-char pairing code.
  // Invalidates any previous unused codes from the same user.
  // --------------------------------------------------------------------------
  fastify.post<{ Body: StartPairingBody }>(
    '/api/ui-bridge/pairing/start',
    { preHandler: authenticate },
    async (request, reply) => {
      const parsed = startPairingSchema.safeParse(request.body || {});
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
      }

      const user = (request as any).user;
      const clinicId = user.id; // clinic_id = user.id (no multi-tenant yet)

      // Invalidate previous unused codes from this admin
      await prisma.pairingCode.updateMany({
        where: {
          clinicId,
          usedAt: null,
        },
        data: {
          expiresAt: new Date(), // expire immediately
        },
      });

      const code = generateCode();
      const expiresAt = new Date(Date.now() + CODE_TTL_MINUTES * 60 * 1000);

      await prisma.pairingCode.create({
        data: {
          code,
          clinicId,
          expiresAt,
        },
      });

      const qrPayload = JSON.stringify({ code, baseUrl: `${request.protocol}://${request.hostname}` });

      request.log.info({ code, clinicId }, 'Pairing code generated');

      return reply.send({
        code,
        expiresAt: expiresAt.toISOString(),
        expiresInSeconds: CODE_TTL_MINUTES * 60,
        qrPayload,
      });
    }
  );

  // --------------------------------------------------------------------------
  // POST /api/ui-bridge/pairing/claim
  //
  // No auth required. Receives { code }, returns device token.
  // Rate limited: 5 req/min per IP.
  // --------------------------------------------------------------------------
  fastify.post<{ Body: ClaimPairingBody }>(
    '/api/ui-bridge/pairing/claim',
    {
      config: {
        rateLimit: {
          max: 5,
          timeWindow: '1 minute',
        },
      },
    },
    async (request, reply) => {
      const parsed = claimPairingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
      }

      const { code } = parsed.data;
      const upperCode = code.toUpperCase();

      // Find code in a transaction to prevent race conditions
      const result = await prisma.$transaction(async (tx) => {
        const pairingCode = await tx.pairingCode.findUnique({
          where: { code: upperCode },
        });

        if (!pairingCode) {
          return { error: 'not_found' as const };
        }

        if (pairingCode.usedAt) {
          return { error: 'already_used' as const };
        }

        if (pairingCode.expiresAt < new Date()) {
          return { error: 'expired' as const };
        }

        // Generate device token
        const rawToken = randomBytes(32).toString('hex');
        const tokenHash = hashToken(rawToken);
        const deviceName = generateDeviceName();

        // Create device
        const device = await tx.extensionDevice.create({
          data: {
            clinicId: pairingCode.clinicId,
            name: deviceName,
            tokenHash,
          },
        });

        // Mark code as used
        await tx.pairingCode.update({
          where: { id: pairingCode.id },
          data: {
            usedAt: new Date(),
            deviceId: device.id,
          },
        });

        return {
          ok: true as const,
          deviceToken: rawToken,
          deviceId: device.id,
          deviceName: device.name,
        };
      });

      if ('error' in result) {
        if (result.error === 'not_found') {
          return reply.status(404).send({ error: 'Invalid pairing code' });
        }
        // Both expired and already_used return 410 Gone
        return reply.status(410).send({ error: 'Pairing code expired or already used' });
      }

      request.log.info({ deviceId: result.deviceId, deviceName: result.deviceName }, 'Device paired');

      return reply.send({
        deviceToken: result.deviceToken,
        deviceId: result.deviceId,
        deviceName: result.deviceName,
      });
    }
  );

  // --------------------------------------------------------------------------
  // POST /api/ui-bridge/pairing/revoke
  //
  // Admin JWT required. Revokes a device by setting revokedAt.
  // --------------------------------------------------------------------------
  fastify.post<{ Body: RevokePairingBody }>(
    '/api/ui-bridge/pairing/revoke',
    { preHandler: authenticate },
    async (request, reply) => {
      const parsed = revokePairingSchema.safeParse(request.body);
      if (!parsed.success) {
        return reply.status(400).send({ error: 'Invalid request body', details: parsed.error.flatten() });
      }

      const { deviceId } = parsed.data;
      const user = (request as any).user;

      const device = await prisma.extensionDevice.findUnique({
        where: { id: deviceId },
      });

      if (!device || device.clinicId !== user.id) {
        return reply.status(404).send({ error: 'Device not found' });
      }

      if (device.revokedAt) {
        return reply.status(409).send({ error: 'Device already revoked' });
      }

      await prisma.extensionDevice.update({
        where: { id: deviceId },
        data: { revokedAt: new Date() },
      });

      request.log.info({ deviceId }, 'Device revoked');

      return reply.send({ ok: true, deviceId });
    }
  );

  // --------------------------------------------------------------------------
  // GET /api/ui-bridge/pairing/devices
  //
  // Admin JWT required. Lists all devices for the admin's clinic.
  // --------------------------------------------------------------------------
  fastify.get(
    '/api/ui-bridge/pairing/devices',
    { preHandler: authenticate },
    async (request, reply) => {
      const user = (request as any).user;
      const clinicId = user.id;

      const devices = await prisma.extensionDevice.findMany({
        where: { clinicId },
        orderBy: { createdAt: 'desc' },
      });

      return reply.send(
        devices.map((d) => ({
          id: d.id,
          name: d.name,
          createdAt: d.createdAt.toISOString(),
          revokedAt: d.revokedAt?.toISOString() ?? null,
          lastSeenAt: d.lastSeenAt?.toISOString() ?? null,
          isActive: !d.revokedAt,
        }))
      );
    }
  );
}
