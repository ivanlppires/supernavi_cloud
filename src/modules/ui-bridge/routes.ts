import { createHash } from 'crypto';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import jwt, { SignOptions } from 'jsonwebtoken';
import { prisma } from '../../db/index.js';
import config from '../../config/index.js';
import { getSignedUrlForKey } from '../wasabi/wasabiSigner.js';
import { calculateMatchScore } from './matching.js';
import {
  normalizeCaseBase,
  toExternalCaseId,
  signThumbUrl,
  verifyThumbSignature,
  findOrCreateCase,
  linkSiblingSlides,
} from './helpers.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * Dual-mode API authentication for Chrome Extension.
 *
 * 1. x-supernavi-key header (legacy) — direct comparison with env var
 * 2. x-device-token header (paired device) — SHA-256 hash lookup in extension_devices
 *
 * If a paired device is found, updates last_seen_at fire-and-forget.
 */
async function authenticateApiKey(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  // 1. Legacy: x-supernavi-key header
  const apiKey = request.headers['x-supernavi-key'] as string | undefined;
  if (apiKey && config.UI_BRIDGE_API_KEY && apiKey === config.UI_BRIDGE_API_KEY) {
    return; // authenticated via legacy key
  }

  // 2. Paired device: x-device-token header
  const deviceToken = request.headers['x-device-token'] as string | undefined;
  if (deviceToken) {
    const tokenHash = createHash('sha256').update(deviceToken).digest('hex');
    const device = await prisma.extensionDevice.findFirst({
      where: { tokenHash, revokedAt: null },
    });

    if (device) {
      // Fire-and-forget last_seen_at update
      prisma.extensionDevice
        .update({ where: { id: device.id }, data: { lastSeenAt: new Date() } })
        .catch(() => {}); // ignore errors
      (request as any).extensionDevice = device;
      return; // authenticated via device token
    }
  }

  return reply.status(401).send({ error: 'Invalid or missing API key' });
}

// ---- Config-bound wrappers for helpers that need secrets -------------------

function getThumbSecret(): string {
  return config.THUMB_SIGN_SECRET || config.MAGIC_LINK_SECRET || config.JWT_SECRET;
}

function signThumb(slideId: string): string {
  return signThumbUrl(slideId, getThumbSecret(), config.THUMB_SIGN_TTL_SECONDS);
}

function verifyThumb(slideId: string, exp: string, sig: string): boolean {
  return verifyThumbSignature(slideId, exp, sig, getThumbSecret());
}

// ============================================================================
// Routes
// ============================================================================

export async function uiBridgeRoutes(fastify: FastifyInstance): Promise<void> {

  // --------------------------------------------------------------------------
  // GET /api/ui-bridge/cases/:caseBase/status
  //
  // Accepts:  /cases/AP26000230/status  OR  /cases/pathoweb:AP26000230/status
  // Returns:  { caseBase, externalCaseId, readySlides, processingSlides, ... }
  // --------------------------------------------------------------------------
  fastify.get<{
    Params: { caseBase: string };
  }>('/api/ui-bridge/cases/:caseBase/status', {
    preHandler: authenticateApiKey,
  }, async (request, reply) => {
    const caseBase = normalizeCaseBase(request.params.caseBase);
    const externalCaseId = toExternalCaseId(caseBase);

    // Find confirmed slides for this case
    const confirmedSlides = await prisma.slideRead.findMany({
      where: {
        externalCaseBase: caseBase,
        confirmedCaseLink: true,
      },
      include: {
        previewAsset: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const readySlides = confirmedSlides
      .filter(s => s.hasPreview)
      .map(s => ({
        slideId: s.slideId,
        label: s.externalSlideLabel || '1',
        thumbUrl: signThumb(s.slideId),
        width: s.width,
        height: s.height,
      }));

    const processingSlides = confirmedSlides
      .filter(s => !s.hasPreview)
      .map(s => ({
        slideId: s.slideId,
        label: s.externalSlideLabel || '1',
      }));

    // Find unconfirmed candidates (recent slides without confirmed link)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentUnlinked = await prisma.slideRead.findMany({
      where: {
        OR: [
          { externalCaseBase: null },
          { confirmedCaseLink: false },
        ],
        updatedAt: { gte: since },
      },
      take: 50,
    });

    const unconfirmedCandidates = recentUnlinked
      .map(s => {
        const score = calculateMatchScore(caseBase, {
          externalCaseBase: s.externalCaseBase,
          externalCaseId: s.externalCaseId,
          svsFilename: s.svsFilename,
        });
        return {
          slideId: s.slideId,
          label: s.externalSlideLabel || s.svsFilename,
          thumbUrl: s.hasPreview ? signThumb(s.slideId) : null,
          score,
          filename: s.svsFilename,
          createdAt: s.updatedAt.toISOString(),
        };
      })
      .filter(c => c.score >= 0.85)
      .sort((a, b) => b.score - a.score)
      .slice(0, 5);

    const lastUpdated = confirmedSlides.length > 0
      ? confirmedSlides[0].updatedAt.toISOString()
      : null;

    return reply.send({
      caseBase,
      externalCaseId,
      readySlides,
      processingSlides,
      unconfirmedCandidates,
      lastUpdated,
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/ui-bridge/cases/:caseBase/unassigned?hours=24
  // --------------------------------------------------------------------------
  fastify.get<{
    Params: { caseBase: string };
    Querystring: { hours?: string };
  }>('/api/ui-bridge/cases/:caseBase/unassigned', {
    preHandler: authenticateApiKey,
  }, async (request, reply) => {
    const caseBase = normalizeCaseBase(request.params.caseBase);
    const externalCaseId = toExternalCaseId(caseBase);
    const hours = Math.min(Math.max(parseInt(request.query.hours || '24', 10) || 24, 1), 168);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const recentSlides = await prisma.slideRead.findMany({
      where: {
        OR: [
          { externalCaseBase: null },
          { confirmedCaseLink: false },
        ],
        updatedAt: { gte: since },
      },
      take: 100,
    });

    const candidates = recentSlides
      .map(s => {
        const score = calculateMatchScore(caseBase, {
          externalCaseBase: s.externalCaseBase,
          externalCaseId: s.externalCaseId,
          svsFilename: s.svsFilename,
        });
        return {
          slideId: s.slideId,
          label: s.externalSlideLabel || s.svsFilename,
          thumbUrl: s.hasPreview ? signThumb(s.slideId) : null,
          score,
          filename: s.svsFilename,
          createdAt: s.updatedAt.toISOString(),
        };
      })
      .filter(c => c.score >= 0.85)
      .sort((a, b) => b.score - a.score)
      .slice(0, 10);

    return reply.send({ caseBase, externalCaseId, candidates });
  });

  // --------------------------------------------------------------------------
  // GET /api/ui-bridge/slides/unlinked?hours=168&limit=50
  //
  // Returns all slides not linked to any case (for manual association).
  // --------------------------------------------------------------------------
  fastify.get<{
    Querystring: { hours?: string; limit?: string };
  }>('/api/ui-bridge/slides/unlinked', {
    preHandler: authenticateApiKey,
  }, async (request, reply) => {
    const hours = Math.min(Math.max(parseInt(request.query.hours || '168', 10) || 168, 1), 720);
    const limit = Math.min(Math.max(parseInt(request.query.limit || '50', 10) || 50, 1), 100);
    const since = new Date(Date.now() - hours * 60 * 60 * 1000);

    const slides = await prisma.slideRead.findMany({
      where: {
        OR: [
          { externalCaseBase: null },
          { confirmedCaseLink: false },
        ],
        hasPreview: true,
        updatedAt: { gte: since },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return reply.send({
      slides: slides.map(s => ({
        slideId: s.slideId,
        filename: s.svsFilename,
        thumbUrl: signThumb(s.slideId),
        width: s.width,
        height: s.height,
        createdAt: s.updatedAt.toISOString(),
      })),
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/ui-bridge/cases/:caseBase/attach
  // --------------------------------------------------------------------------
  fastify.post<{
    Params: { caseBase: string };
    Body: { slideId: string };
  }>('/api/ui-bridge/cases/:caseBase/attach', {
    preHandler: authenticateApiKey,
  }, async (request, reply) => {
    const caseBase = normalizeCaseBase(request.params.caseBase);
    const externalCaseId = toExternalCaseId(caseBase);
    const { slideId } = request.body;

    if (!slideId) {
      return reply.status(400).send({ error: 'slideId is required' });
    }

    const slide = await prisma.slideRead.findUnique({
      where: { slideId },
    });

    if (!slide) {
      return reply.status(404).send({ error: 'Slide not found' });
    }

    await prisma.slideRead.update({
      where: { slideId },
      data: {
        externalCaseId,
        externalCaseBase: caseBase,
        confirmedCaseLink: true,
      },
    });

    await prisma.viewerAuditLog.create({
      data: {
        slideId,
        externalCaseId,
        action: 'case_attached',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
        metadata: { source: 'pathoweb-extension', previousCaseBase: slide.externalCaseBase },
      },
    });

    request.log.info({ slideId, caseBase }, 'Slide attached to case via UI-Bridge');

    return reply.send({ ok: true, slideId, caseBase, externalCaseId });
  });

  // --------------------------------------------------------------------------
  // POST /api/ui-bridge/viewer-link
  //
  // JWT binds: slideId + externalCaseId + purpose + exp
  // --------------------------------------------------------------------------
  fastify.post<{
    Body: {
      slideId: string;
      externalCaseId?: string;
      patientData?: {
        patientName?: string;
        patientId?: string;
        age?: string;
        doctor?: string;
      };
    };
  }>('/api/ui-bridge/viewer-link', {
    preHandler: authenticateApiKey,
  }, async (request, reply) => {
    const { slideId, externalCaseId, patientData } = request.body;

    if (!slideId) {
      return reply.status(400).send({ error: 'slideId is required' });
    }

    const slide = await prisma.slideRead.findUnique({
      where: { slideId },
    });

    if (!slide) {
      return reply.status(404).send({ error: 'Slide not found' });
    }

    const resolvedExternalCaseId = externalCaseId || slide.externalCaseId;
    const secret = config.MAGIC_LINK_SECRET || config.JWT_SECRET;
    const ttl = config.MAGIC_LINK_TTL_SECONDS;

    // Resolve user from paired device (if available)
    const device = (request as any).extensionDevice as
      | { id: string; clinicId: string } | undefined;
    let userPayload: { userId?: string; userName?: string; userAvatar?: string } = {};
    let resolvedOwnerId: string | null = null;
    if (device) {
      const user = await prisma.user.findUnique({
        where: { id: device.clinicId },
        select: { id: true, name: true, avatarUrl: true },
      });
      if (user) {
        resolvedOwnerId = user.id;
        userPayload = {
          userId: user.id,
          userName: user.name ?? undefined,
          userAvatar: user.avatarUrl ?? undefined,
        };
      }
    }

    // Auto-create or update case from PathoWeb patient data
    let resolvedCaseId = slide.caseId;
    const caseBase = slide.externalCaseBase
      || (resolvedExternalCaseId ? normalizeCaseBase(resolvedExternalCaseId) : null);

    if (caseBase && patientData) {
      try {
        const caseRecord = await findOrCreateCase(prisma, {
          caseBase,
          patientData,
          ownerId: resolvedOwnerId,
        });
        resolvedCaseId = caseRecord.caseId;

        await linkSiblingSlides(prisma, { caseBase, caseId: resolvedCaseId });
        request.log.info({ caseId: resolvedCaseId, caseBase }, 'Auto-created/updated case from PathoWeb data');
      } catch (err: any) {
        // If duplicate key (race condition), find the existing one
        if (err.code === 'P2002') {
          const existing = await prisma.caseRead.findFirst({ where: { patientRef: caseBase } });
          if (existing) resolvedCaseId = existing.caseId;
        } else {
          request.log.error({ err, caseBase }, 'Failed to auto-create case');
        }
      }
    }

    const token = jwt.sign(
      {
        sub: 'magic-link',
        slideId,
        caseId: resolvedCaseId,
        externalCaseId: resolvedExternalCaseId,
        purpose: 'viewer',
        ...userPayload,
        ...(patientData ? { patientData } : {}),
      },
      secret,
      { expiresIn: ttl } as SignOptions
    );

    await prisma.viewerAuditLog.create({
      data: {
        slideId,
        externalCaseId: resolvedExternalCaseId,
        action: 'magic_link_created',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
      },
    });

    const url = `${config.FRONTEND_URL}/viewer?slideId=${slideId}&t=${token}`;

    return reply.send({
      url,
      token,
      expiresIn: ttl,
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/ui-bridge/me
  //
  // Returns device + owner info for the authenticated extension.
  // --------------------------------------------------------------------------
  fastify.get('/api/ui-bridge/me', {
    preHandler: authenticateApiKey,
  }, async (request, reply) => {
    const device = (request as any).extensionDevice as
      | { id: string; clinicId: string; name: string; createdAt: Date } | undefined;

    // Legacy API key — no device or user info available
    if (!device) {
      return reply.send({
        authenticated: true,
        mode: 'api-key',
        device: null,
        user: null,
      });
    }

    // Fetch the user who owns this device (clinicId === user.id)
    const user = await prisma.user.findUnique({
      where: { id: device.clinicId },
      select: { id: true, name: true, email: true, avatarUrl: true },
    });

    return reply.send({
      authenticated: true,
      mode: 'device-token',
      device: {
        id: device.id,
        name: device.name,
      },
      user: user ? {
        name: user.name,
        email: user.email,
        avatarUrl: user.avatarUrl,
      } : null,
    });
  });

  // --------------------------------------------------------------------------
  // GET /api/ui-bridge/thumb/:slideId?exp=...&sig=...
  //
  // No auth headers required — signed via HMAC query params so <img> works.
  // Returns 302 redirect to signed Wasabi URL with proper cache headers.
  // --------------------------------------------------------------------------
  fastify.get<{
    Params: { slideId: string };
    Querystring: { exp?: string; sig?: string };
  }>('/api/ui-bridge/thumb/:slideId', async (request, reply) => {
    const { slideId } = request.params;
    const { exp, sig } = request.query;

    // Validate HMAC signature
    if (!exp || !sig || !verifyThumb(slideId, exp, sig)) {
      return reply.status(403).send({ error: 'Invalid or expired thumb signature' });
    }

    const previewAsset = await prisma.previewAsset.findUnique({
      where: { slideId },
    });

    if (!previewAsset || !previewAsset.thumbKey) {
      return reply.status(404).send({ error: 'Thumbnail not found' });
    }

    try {
      const signedUrl = await getSignedUrlForKey(
        previewAsset.thumbKey,
        120,
        previewAsset.wasabiBucket,
        {
          endpoint: previewAsset.wasabiEndpoint,
          region: previewAsset.wasabiRegion,
        }
      );

      return reply
        .header('Cache-Control', 'private, max-age=300')
        .redirect(signedUrl);
    } catch (err: any) {
      request.log.error({ err, slideId }, 'Failed to sign thumb URL');
      return reply.status(500).send({ error: 'Failed to generate thumbnail URL' });
    }
  });
}
