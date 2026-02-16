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
import { getUserEdgeIds, edgeFilter, getAuthUserId } from './tenant.js';

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

    // Tenant isolation: resolve allowed edges for this user
    const userId = getAuthUserId(request);
    const allowedEdges = userId ? await getUserEdgeIds(userId) : null;
    const edgeWhere = edgeFilter(allowedEdges);

    // Find the internal case ID (if exists) so we also find slides linked via viewer
    const internalCase = await prisma.caseRead.findFirst({
      where: { patientRef: caseBase },
      select: { caseId: true },
    });

    // Find confirmed slides for this case (by externalCaseBase OR by caseId)
    const confirmedSlides = await prisma.slideRead.findMany({
      where: {
        confirmedCaseLink: true,
        ...edgeWhere,
        OR: [
          { externalCaseBase: caseBase },
          ...(internalCase ? [{ caseId: internalCase.caseId }] : []),
        ],
      },
      include: {
        previewAsset: true,
      },
      orderBy: { updatedAt: 'desc' },
    });

    const readySlides = confirmedSlides
      .filter(s => s.hasPreview)
      .map((s, i) => ({
        slideId: s.slideId,
        label: s.externalSlideLabel || null,
        filename: s.svsFilename,
        index: i + 1,
        thumbUrl: signThumb(s.slideId),
        width: s.width,
        height: s.height,
      }));

    const processingSlides = confirmedSlides
      .filter(s => !s.hasPreview)
      .map((s, i) => ({
        slideId: s.slideId,
        label: s.externalSlideLabel || null,
        filename: s.svsFilename,
        index: readySlides.length + i + 1,
      }));

    // Find unconfirmed candidates (recent slides without confirmed link)
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const recentUnlinked = await prisma.slideRead.findMany({
      where: {
        ...edgeWhere,
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

    // Tenant isolation
    const userId = getAuthUserId(request);
    const allowedEdges = userId ? await getUserEdgeIds(userId) : null;

    const recentSlides = await prisma.slideRead.findMany({
      where: {
        ...edgeFilter(allowedEdges),
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

    // Tenant isolation
    const userId = getAuthUserId(request);
    const allowedEdges = userId ? await getUserEdgeIds(userId) : null;

    const slides = await prisma.slideRead.findMany({
      where: {
        caseId: null,
        ...edgeFilter(allowedEdges),
        OR: [
          { externalCaseBase: null },
          { confirmedCaseLink: false },
        ],
        updatedAt: { gte: since },
      },
      orderBy: { updatedAt: 'desc' },
      take: limit,
    });

    return reply.send({
      slides: slides.map(s => ({
        slideId: s.slideId,
        filename: s.svsFilename,
        thumbUrl: s.hasPreview ? signThumb(s.slideId) : null,
        width: s.width,
        height: s.height,
        hasPreview: s.hasPreview,
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

    // Tenant isolation: verify slide belongs to user's edges
    const userId = getAuthUserId(request);
    const allowedEdges = userId ? await getUserEdgeIds(userId) : null;
    if (allowedEdges && slide.edgeId && !allowedEdges.includes(slide.edgeId)) {
      return reply.status(404).send({ error: 'Slide not found' });
    }

    // Find existing case for this caseBase (if any sibling slide already has one)
    const siblingWithCase = await prisma.slideRead.findFirst({
      where: { externalCaseBase: caseBase, caseId: { not: null }, ...edgeFilter(allowedEdges) },
      select: { caseId: true },
    });
    const resolvedCaseId = siblingWithCase?.caseId ?? null;

    await prisma.slideRead.update({
      where: { slideId },
      data: {
        externalCaseId,
        externalCaseBase: caseBase,
        confirmedCaseLink: true,
        ...(resolvedCaseId && !slide.caseId ? { caseId: resolvedCaseId } : {}),
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

    request.log.info({ slideId, caseBase, caseId: resolvedCaseId }, 'Slide attached to case via UI-Bridge');

    return reply.send({ ok: true, slideId, caseBase, externalCaseId, caseId: resolvedCaseId });
  });

  // --------------------------------------------------------------------------
  // POST /api/ui-bridge/cases/:caseBase/detach
  // --------------------------------------------------------------------------
  fastify.post<{
    Params: { caseBase: string };
    Body: { slideId: string };
  }>('/api/ui-bridge/cases/:caseBase/detach', {
    preHandler: authenticateApiKey,
  }, async (request, reply) => {
    const caseBase = normalizeCaseBase(request.params.caseBase);
    const { slideId } = request.body;

    if (!slideId) {
      return reply.status(400).send({ error: 'slideId is required' });
    }

    const slide = await prisma.slideRead.findUnique({ where: { slideId } });
    if (!slide) {
      return reply.status(404).send({ error: 'Slide not found' });
    }

    await prisma.slideRead.update({
      where: { slideId },
      data: {
        externalCaseId: null,
        externalCaseBase: null,
        confirmedCaseLink: false,
      },
    });

    await prisma.viewerAuditLog.create({
      data: {
        slideId,
        externalCaseId: null,
        action: 'case_detached',
        ipAddress: request.ip,
        userAgent: request.headers['user-agent'] || null,
        metadata: { source: 'pathoweb-extension', previousCaseBase: caseBase },
      },
    });

    request.log.info({ slideId, caseBase }, 'Slide detached from case via UI-Bridge');

    return reply.send({ ok: true, slideId });
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
        edgeAgentId: null,
      });
    }

    // Fetch the user who owns this device (clinicId === user.id)
    const user = await prisma.user.findUnique({
      where: { id: device.clinicId },
      select: { id: true, name: true, email: true, avatarUrl: true },
    });

    // Resolve edge agent ID from user_edges (explicit) or fallback to heuristic
    let edgeAgentId: string | null = null;
    const userEdges = await prisma.userEdge.findMany({
      where: { userId: device.clinicId },
      select: { edgeId: true, isPrimary: true },
      orderBy: { createdAt: 'asc' },
    });

    if (userEdges.length > 0) {
      const primary = userEdges.find(e => e.isPrimary);
      edgeAgentId = primary ? primary.edgeId : userEdges[0].edgeId;
    } else if (user) {
      // Legacy fallback: derive from slides (will be removed once all users have user_edges)
      const edgeResult = await prisma.$queryRaw<Array<{ edge_id: string }>>`
        SELECT sr.edge_id
        FROM slides_read sr
        JOIN cases_read cr ON sr.case_id = cr.case_id
        WHERE cr.owner_id = ${device.clinicId}::uuid
          AND sr.edge_id IS NOT NULL
        GROUP BY sr.edge_id
        ORDER BY COUNT(*) DESC
        LIMIT 1
      `;
      edgeAgentId = edgeResult.length > 0 ? edgeResult[0].edge_id : null;
    }

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
      edgeAgentId,
      edges: userEdges.map(e => ({ edgeId: e.edgeId, isPrimary: e.isPrimary })),
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
