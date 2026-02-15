import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import jwt, { SignOptions } from 'jsonwebtoken';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from '../../db/index.js';
import config from '../../config/index.js';

// S3 client cache (shared with preview routes pattern)
const s3ClientCache = new Map<string, S3Client>();
function getS3Client(endpoint: string, region: string): S3Client {
  const cacheKey = `${endpoint}|${region}`;
  let client = s3ClientCache.get(cacheKey);
  if (!client) {
    client = new S3Client({
      endpoint, region,
      credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
    s3ClientCache.set(cacheKey, client);
  }
  return client;
}

// Google OAuth client
const googleClient = config.GOOGLE_CLIENT_ID
  ? new OAuth2Client(config.GOOGLE_CLIENT_ID)
  : null;

// JWT helper functions
function signToken(userId: string): string {
  return jwt.sign({ sub: userId }, config.JWT_SECRET, {
    expiresIn: config.JWT_EXPIRES_IN,
  } as SignOptions);
}

function verifyToken(token: string): { sub: string } | null {
  try {
    return jwt.verify(token, config.JWT_SECRET) as { sub: string };
  } catch {
    return null;
  }
}

// Response types
interface AuthResponse {
  accessToken: string;
  user: {
    id: string;
    email: string;
    name: string;
    role: string;
    avatarUrl: string | null;
    crm: string | null;
    specialization: string | null;
    createdAt: string;
  };
}

interface UserResponse {
  id: string;
  email: string;
  name: string;
  role: string;
  avatarUrl: string | null;
  crm: string | null;
  specialization: string | null;
  createdAt: string;
}

// Transform user to response format
function userToResponse(user: any): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    avatarUrl: user.avatarUrl,
    crm: user.crm,
    specialization: user.specialization,
    createdAt: user.createdAt.toISOString(),
  };
}

// Auth middleware - exported for use in other routes
export async function authenticate(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  const authHeader = request.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return reply.status(401).send({ error: 'Missing authorization header' });
  }

  const token = authHeader.slice(7);
  const payload = verifyToken(token);
  if (!payload) {
    return reply.status(401).send({ error: 'Invalid or expired token' });
  }

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
  });

  if (!user) {
    return reply.status(401).send({ error: 'User not found' });
  }

  // Attach user to request
  (request as any).user = user;
}

export async function authRoutes(fastify: FastifyInstance): Promise<void> {
  // OAuth status endpoint
  fastify.get('/api/auth/oauth/status', async (_request, reply) => {
    return reply.send({
      google: !!googleClient,
      apple: false, // Not implemented
    });
  });

  // List cases for current user
  fastify.get('/api/cases', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const currentUser = (request as any).user;

    // Get cases where user is owner or collaborator
    const ownedCases = await prisma.caseRead.findMany({
      where: { ownerId: currentUser.id },
      orderBy: { createdAt: 'desc' },
      include: {
        slides: {
          include: {
            previewAsset: true,
          },
        },
        collaborators: {
          where: { status: 'accepted' },
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });

    const collaboratingCases = await prisma.caseRead.findMany({
      where: {
        collaborators: {
          some: { userId: currentUser.id, status: 'accepted' },
        },
      },
      orderBy: { createdAt: 'desc' },
      include: {
        slides: {
          include: {
            previewAsset: true,
          },
        },
        collaborators: {
          where: { status: 'accepted' },
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });

    // Also get cases without owner (legacy data) - they should be visible to everyone
    const legacyCases = await prisma.caseRead.findMany({
      where: { ownerId: null },
      orderBy: { createdAt: 'desc' },
      include: {
        slides: {
          include: {
            previewAsset: true,
          },
        },
        collaborators: {
          where: { status: 'accepted' },
          include: {
            user: { select: { id: true, name: true, avatarUrl: true } },
          },
        },
      },
    });

    // Combine and deduplicate
    const allCasesMap = new Map<string, typeof ownedCases[0] & { isOwner: boolean }>();
    for (const c of ownedCases) {
      allCasesMap.set(c.caseId, { ...c, isOwner: true });
    }
    for (const c of collaboratingCases) {
      if (!allCasesMap.has(c.caseId)) {
        allCasesMap.set(c.caseId, { ...c, isOwner: false });
      }
    }
    for (const c of legacyCases) {
      if (!allCasesMap.has(c.caseId)) {
        allCasesMap.set(c.caseId, { ...c, isOwner: true }); // Treat legacy as owned
      }
    }

    const cases = Array.from(allCasesMap.values()).sort(
      (a, b) => b.createdAt.getTime() - a.createdAt.getTime()
    );

    // Transform to frontend expected format
    const result = cases.map(c => {
      // Find first slide with preview for thumbnail
      const slideWithPreview = c.slides.find(s => s.hasPreview && s.previewAsset);
      const thumbnailUrl = slideWithPreview
        ? `/preview/${slideWithPreview.slideId}/thumb.jpg`
        : null;

      // Determine case status based on slides
      const allSlidesReady = c.slides.length > 0 && c.slides.every(s => s.hasPreview);

      // Map status: active -> novo, but if all slides ready -> em_analise
      let status = 'novo';
      if (c.status === 'archived') status = 'archived';
      else if (c.status === 'deleted') status = 'deleted';
      else if (allSlidesReady) status = 'em_analise';

      // Map location from status
      let location: 'inbox' | 'archived' | 'trash' = 'inbox';
      if (c.status === 'archived') location = 'archived';
      else if (c.status === 'deleted') location = 'trash';

      return {
        id: c.caseId,
        caseNumber: c.patientRef || c.caseId,
        patientName: c.title,
        patientAge: c.patientAge,
        patientSex: c.patientSex as 'M' | 'F' | null,
        doctor: c.doctor || null,
        status,
        location,
        ownerId: c.ownerId || '',
        isOwner: c.isOwner,
        description: null,
        clinicalNotes: null,
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
        slidesCount: c.slides.length,
        thumbnailUrl,
        collaborators: c.collaborators.map(collab => ({
          id: collab.user.id,
          name: collab.user.name,
          avatarUrl: collab.user.avatarUrl,
        })),
        slides: c.slides.map(s => ({
          id: s.slideId,
          caseId: s.caseId,
          name: s.svsFilename,
          originalFilename: s.svsFilename,
          fileFormat: 'svs',
          fileSize: '0',
          storagePath: null,
          dziPath: s.hasPreview ? `/preview/${s.slideId}/slide.dzi` : null,
          thumbnailUrl: s.hasPreview ? `/preview/${s.slideId}/thumb.jpg` : null,
          mpp: s.mpp ? String(s.mpp) : null,
          width: s.width,
          height: s.height,
          processingStatus: s.hasPreview ? 'ready' : 'processing',
          processingError: null,
          uploadedAt: s.updatedAt.toISOString(),
          processedAt: s.hasPreview ? s.updatedAt.toISOString() : null,
          externalCaseBase: s.externalCaseBase || null,
        })),
      };
    });

    return reply.send(result);
  });

  // Create case
  fastify.post<{
    Body: {
      caseNumber: string;
      patientName: string;
      patientAge?: number | null;
      patientSex?: 'M' | 'F' | null;
      description?: string | null;
      clinicalNotes?: string | null;
    };
  }>('/api/cases', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const currentUser = (request as any).user;
    const { caseNumber, patientName, patientAge, patientSex } = request.body;
    const now = new Date();
    const caseId = `case-${Date.now()}`;

    const newCase = await prisma.caseRead.create({
      data: {
        caseId,
        title: patientName,
        patientRef: caseNumber,
        patientAge: patientAge ?? null,
        patientSex: patientSex ?? null,
        ownerId: currentUser.id,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });

    request.log.info({ caseId: newCase.caseId, patientName, ownerId: currentUser.id }, 'Case created');

    return reply.status(201).send({
      id: newCase.caseId,
      caseNumber: newCase.patientRef,
      patientName: newCase.title,
      patientAge: newCase.patientAge,
      patientSex: newCase.patientSex,
      ownerId: newCase.ownerId,
      isOwner: true,
      status: 'novo',
      location: 'inbox',
      createdAt: newCase.createdAt.toISOString(),
      updatedAt: newCase.updatedAt.toISOString(),
    });
  });

  // Get single case with slides
  fastify.get<{
    Params: { id: string };
  }>('/api/cases/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;

    try {
      const caseData = await prisma.caseRead.findUnique({
        where: { caseId: id },
        include: {
          slides: {
            orderBy: { updatedAt: 'desc' },
          },
        },
      });

      if (!caseData) {
        return reply.status(404).send({ error: 'Case not found' });
      }

      // Map to frontend format
      return reply.send({
        id: caseData.caseId,
        caseNumber: caseData.patientRef,
        patientName: caseData.title,
        patientAge: caseData.patientAge,
        patientSex: caseData.patientSex as 'M' | 'F' | null,
        doctor: caseData.doctor || null,
        status: caseData.status === 'active' ? 'novo' : caseData.status,
        location: caseData.status === 'archived' ? 'archived' : caseData.status === 'deleted' ? 'trash' : 'inbox',
        ownerId: caseData.ownerId || '',
        description: null,
        clinicalNotes: null,
        createdAt: caseData.createdAt.toISOString(),
        updatedAt: caseData.updatedAt.toISOString(),
        slidesCount: caseData.slides.length,
        slides: caseData.slides.map(s => ({
          id: s.slideId,
          caseId: s.caseId,
          name: s.svsFilename,
          originalFilename: s.svsFilename,
          fileFormat: 'svs',
          fileSize: '0',
          storagePath: null,
          dziPath: s.hasPreview ? `/preview/${s.slideId}/slide.dzi` : null,
          thumbnailUrl: s.hasPreview ? `/preview/${s.slideId}/thumb.jpg` : null,
          mpp: s.mpp ? String(s.mpp) : null,
          width: s.width,
          height: s.height,
          processingStatus: s.hasPreview ? 'ready' : 'processing',
          processingError: null,
          uploadedAt: s.updatedAt.toISOString(),
          processedAt: s.hasPreview ? s.updatedAt.toISOString() : null,
          externalCaseBase: s.externalCaseBase || null,
        })),
      });
    } catch (error) {
      request.log.error({ error, caseId: id }, 'Failed to get case');
      return reply.status(500).send({ error: 'Failed to get case' });
    }
  });

  // Update case (move to location, change status)
  fastify.patch<{
    Params: { id: string };
    Body: {
      location?: 'inbox' | 'archived' | 'trash';
      status?: string;
      patientName?: string;
    };
  }>('/api/cases/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;
    const { location, status, patientName } = request.body;

    // Map location to status for our simplified model
    let newStatus = status;
    if (location === 'archived') newStatus = 'archived';
    else if (location === 'trash') newStatus = 'deleted';
    else if (location === 'inbox') newStatus = 'active';

    try {
      const updated = await prisma.caseRead.update({
        where: { caseId: id },
        data: {
          ...(newStatus && { status: newStatus }),
          ...(patientName && { title: patientName }),
          updatedAt: new Date(),
        },
      });

      request.log.info({ caseId: id, status: newStatus }, 'Case updated');

      return reply.send({
        id: updated.caseId,
        caseNumber: updated.patientRef,
        patientName: updated.title,
        status: updated.status === 'active' ? 'pendente' : updated.status,
        location: updated.status === 'archived' ? 'archived' : updated.status === 'deleted' ? 'trash' : 'inbox',
        createdAt: updated.createdAt.toISOString(),
        updatedAt: updated.updatedAt.toISOString(),
      });
    } catch (error) {
      request.log.error({ error, caseId: id }, 'Failed to update case');
      return reply.status(404).send({ error: 'Case not found' });
    }
  });

  // Delete case permanently
  fastify.delete<{
    Params: { id: string };
  }>('/api/cases/:id', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { id } = request.params;

    try {
      await prisma.caseRead.delete({
        where: { caseId: id },
      });

      request.log.info({ caseId: id }, 'Case deleted permanently');
      return reply.status(204).send();
    } catch (error) {
      request.log.error({ error, caseId: id }, 'Failed to delete case');
      return reply.status(404).send({ error: 'Case not found' });
    }
  });

  // Get slides for a case
  fastify.get('/api/cases/:caseId/slides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { caseId } = request.params as { caseId: string };

    const slides = await prisma.slideRead.findMany({
      where: { caseId },
      include: { previewAsset: true },
    });

    const result = slides.map(s => ({
      id: s.slideId,
      caseId: s.caseId || '',
      name: s.svsFilename.replace(/\.[^/.]+$/, ''),
      originalFilename: s.svsFilename,
      fileFormat: s.svsFilename.split('.').pop()?.toLowerCase() || 'svs',
      fileSize: '0',
      storagePath: null,
      dziPath: s.previewAsset ? `slides/${s.slideId}/${s.slideId}.dzi` : null,
      thumbnailUrl: s.previewAsset ? `/preview/${s.slideId}/thumb.jpg` : null,
      mpp: s.mpp?.toString() || null,
      width: s.width,
      height: s.height,
      processingStatus: s.hasPreview ? 'ready' : 'processing',
      processingError: null,
      uploadedAt: s.updatedAt.toISOString(),
      processedAt: s.hasPreview ? s.updatedAt.toISOString() : null,
      externalCaseBase: s.externalCaseBase || null,
    }));

    return reply.send(result);
  });

  // Get slides by externalCaseBase (for edge slides without a cloud caseId)
  fastify.get<{
    Params: { caseBase: string };
  }>('/api/slides/by-case-base/:caseBase', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const caseBase = request.params.caseBase.toUpperCase();

    const slides = await prisma.slideRead.findMany({
      where: { externalCaseBase: caseBase, confirmedCaseLink: true },
      include: { previewAsset: true },
      orderBy: { updatedAt: 'desc' },
    });

    const result = slides.map(s => ({
      id: s.slideId,
      caseId: s.caseId || '',
      name: s.svsFilename.replace(/\.[^/.]+$/, ''),
      originalFilename: s.svsFilename,
      fileFormat: s.svsFilename.split('.').pop()?.toLowerCase() || 'svs',
      fileSize: '0',
      storagePath: null,
      dziPath: s.previewAsset ? `slides/${s.slideId}/${s.slideId}.dzi` : null,
      thumbnailUrl: s.previewAsset ? `/preview/${s.slideId}/thumb.jpg` : null,
      mpp: s.mpp?.toString() || null,
      width: s.width,
      height: s.height,
      processingStatus: s.hasPreview ? 'ready' : 'processing',
      processingError: null,
      uploadedAt: s.updatedAt.toISOString(),
      processedAt: s.hasPreview ? s.updatedAt.toISOString() : null,
      externalCaseBase: s.externalCaseBase || null,
    }));

    return reply.send(result);
  });

  // Add slide to a case
  fastify.post<{
    Params: { caseId: string };
    Body: {
      name: string;
      originalFilename: string;
      fileFormat: string;
      fileSize: string;
      storagePath?: string | null;
      mpp?: string | null;
      width?: number | null;
      height?: number | null;
    };
  }>('/api/cases/:caseId/slides', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { caseId } = request.params;
    const { originalFilename, width, height } = request.body;

    const slideId = `slide-${Date.now()}`;
    const now = new Date();

    const newSlide = await prisma.slideRead.create({
      data: {
        slideId,
        caseId,
        svsFilename: originalFilename,
        width: width || 0,
        height: height || 0,
        mpp: 0.25, // Default MPP
        hasPreview: false,
        updatedAt: now,
      },
    });

    request.log.info({ slideId: newSlide.slideId, caseId, originalFilename }, 'Slide created');

    return reply.status(201).send({
      id: newSlide.slideId,
      caseId: newSlide.caseId,
      name: originalFilename.replace(/\.[^/.]+$/, ''),
      originalFilename,
      processingStatus: 'processing',
    });
  });

  // Get single slide (supports both normal auth and magic link tokens)
  fastify.get<{
    Params: { slideId: string };
  }>('/api/slides/:slideId', async (request, reply) => {
    const { slideId } = request.params;

    // Try to authenticate: normal JWT or magic link JWT
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization header' });
    }

    const token = authHeader.slice(7);
    const secret = config.MAGIC_LINK_SECRET || config.JWT_SECRET;
    let payload: any;
    try {
      payload = jwt.verify(token, secret);
    } catch {
      // Try fallback with JWT_SECRET if MAGIC_LINK_SECRET is set and different
      if (config.MAGIC_LINK_SECRET && config.MAGIC_LINK_SECRET !== config.JWT_SECRET) {
        try {
          payload = jwt.verify(token, config.JWT_SECRET);
        } catch {
          return reply.status(401).send({ error: 'Invalid or expired token' });
        }
      } else {
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }
    }

    // If magic link, verify the slideId matches
    if (payload.sub === 'magic-link' && payload.purpose === 'viewer') {
      if (payload.slideId !== slideId) {
        return reply.status(403).send({ error: 'Token not valid for this slide' });
      }
    } else if (payload.sub) {
      // Normal user token — verify user exists
      const user = await prisma.user.findUnique({ where: { id: payload.sub } });
      if (!user) {
        return reply.status(401).send({ error: 'User not found' });
      }
    } else {
      return reply.status(401).send({ error: 'Invalid token' });
    }

    const slide = await prisma.slideRead.findUnique({
      where: { slideId },
      include: { previewAsset: true },
    });

    if (!slide) {
      return reply.status(404).send({ error: 'Slide not found' });
    }

    // Map to the Slide shape the frontend expects
    return reply.send({
      id: slide.slideId,
      caseId: slide.caseId || '',
      name: slide.svsFilename.replace(/\.[^/.]+$/, ''),
      originalFilename: slide.svsFilename,
      fileFormat: slide.svsFilename.split('.').pop()?.toLowerCase() || 'svs',
      fileSize: '0',
      storagePath: null,
      dziPath: slide.previewAsset ? `slides/${slide.slideId}/${slide.slideId}.dzi` : null,
      thumbnailUrl: slide.previewAsset ? `/preview/${slide.slideId}/thumb.jpg` : null,
      mpp: slide.mpp?.toString() || null,
      width: slide.width,
      height: slide.height,
      processingStatus: slide.hasPreview ? 'ready' : 'processing',
      processingError: null,
      uploadedAt: slide.updatedAt.toISOString(),
      processedAt: slide.hasPreview ? slide.updatedAt.toISOString() : null,
      externalCaseBase: slide.externalCaseBase || null,
    });
  });

  // DZI metadata proxy — generates DZI XML from preview manifest
  fastify.get<{
    Params: { slideId: string };
  }>('/api/slides/:slideId/dzi', async (request, reply) => {
    const { slideId } = request.params;

    // Authenticate: normal JWT or magic link JWT
    const authHeader = request.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Missing authorization header' });
    }

    const token = authHeader.slice(7);
    const secret = config.MAGIC_LINK_SECRET || config.JWT_SECRET;
    try {
      const payload: any = jwt.verify(token, secret);
      if (payload.sub === 'magic-link' && payload.purpose === 'viewer' && payload.slideId !== slideId) {
        return reply.status(403).send({ error: 'Token not valid for this slide' });
      }
    } catch {
      if (config.MAGIC_LINK_SECRET && config.MAGIC_LINK_SECRET !== config.JWT_SECRET) {
        try { jwt.verify(token, config.JWT_SECRET); } catch {
          return reply.status(401).send({ error: 'Invalid or expired token' });
        }
      } else {
        return reply.status(401).send({ error: 'Invalid or expired token' });
      }
    }

    const previewAsset = await prisma.previewAsset.findUnique({ where: { slideId } });
    if (!previewAsset) {
      return reply.status(404).send({ error: 'Preview not found' });
    }

    // Fetch manifest from S3 to get preview dimensions (not original slide dimensions)
    const client = getS3Client(previewAsset.wasabiEndpoint, previewAsset.wasabiRegion);
    const manifestResp = await client.send(new GetObjectCommand({
      Bucket: previewAsset.wasabiBucket,
      Key: previewAsset.manifestKey,
    }));

    if (!manifestResp.Body) {
      return reply.status(404).send({ error: 'Manifest not found in storage' });
    }

    const manifest = JSON.parse(await manifestResp.Body.transformToString());
    const width = manifest.width;
    const height = manifest.height;
    const tileSize = manifest.tileSize || 256;
    const overlap = manifest.overlap || 0;
    const format = manifest.format || 'jpg';

    // Generate DZI XML using preview dimensions so OpenSeadragon only requests existing tiles
    const dziXml = `<?xml version="1.0" encoding="UTF-8"?>
<Image xmlns="http://schemas.microsoft.com/deepzoom/2008"
  Format="${format}"
  Overlap="${overlap}"
  TileSize="${tileSize}">
  <Size Width="${width}" Height="${height}"/>
</Image>`;

    reply.header('Content-Type', 'application/xml');
    reply.header('Cache-Control', 'public, max-age=3600');
    return reply.send(dziXml);
  });

  // Tile proxy — redirects to /preview/:slideId/tiles/:level/:file
  fastify.get<{
    Params: { slideId: string; level: string; file: string };
  }>('/api/slides/:slideId/tiles/:level/:file', async (request, reply) => {
    const { slideId, level, file } = request.params;
    return reply.redirect(`/preview/${slideId}/tiles/${level}/${file}`);
  });

  // Get slide processing progress
  fastify.get<{
    Params: { slideId: string };
  }>('/api/slides/:slideId/progress', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { slideId } = request.params;

    // Try to find the slide
    const slide = await prisma.slideRead.findUnique({
      where: { slideId },
    });

    if (!slide) {
      return reply.status(404).send({ error: 'Slide not found' });
    }

    // Return progress based on hasPreview status
    return reply.send({
      slideId: slide.slideId,
      status: slide.hasPreview ? 'ready' : 'processing',
      progress: slide.hasPreview ? 100 : 50,
      stage: slide.hasPreview ? 'complete' : 'processing',
      message: slide.hasPreview ? 'Pronto' : 'Processando...',
    });
  });

  // Add collaborator to a case
  fastify.post<{
    Params: { caseId: string };
    Body: { userId: string; role?: 'viewer' | 'collaborator' };
  }>('/api/cases/:caseId/collaborators', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { caseId } = request.params;
    const { userId, role = 'collaborator' } = request.body;
    const currentUser = (request as any).user;

    // Check if case exists
    const caseData = await prisma.caseRead.findUnique({
      where: { caseId },
    });

    if (!caseData) {
      return reply.status(404).send({ error: 'Case not found' });
    }

    // Check if user to invite exists
    const userToInvite = await prisma.user.findUnique({
      where: { id: userId },
    });

    if (!userToInvite) {
      return reply.status(404).send({ error: 'User not found' });
    }

    // Check if already a collaborator
    const existing = await prisma.caseCollaborator.findUnique({
      where: { caseId_userId: { caseId, userId } },
    });

    if (existing) {
      return reply.status(409).send({ error: 'User is already a collaborator' });
    }

    // Create collaboration
    const collaborator = await prisma.caseCollaborator.create({
      data: {
        caseId,
        userId,
        role,
        invitedBy: currentUser.id,
        status: 'pending',
      },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true },
        },
      },
    });

    return reply.status(201).send({
      id: collaborator.id,
      userId: collaborator.userId,
      role: collaborator.role,
      status: collaborator.status,
      invitedAt: collaborator.invitedAt.toISOString(),
      user: collaborator.user,
    });
  });

  // Get collaborators for a case
  fastify.get<{
    Params: { caseId: string };
  }>('/api/cases/:caseId/collaborators', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { caseId } = request.params;

    const collaborators = await prisma.caseCollaborator.findMany({
      where: { caseId },
      include: {
        user: {
          select: { id: true, name: true, email: true, avatarUrl: true, specialization: true },
        },
      },
      orderBy: { invitedAt: 'desc' },
    });

    return reply.send(collaborators.map(c => ({
      id: c.id,
      userId: c.userId,
      role: c.role,
      status: c.status,
      invitedAt: c.invitedAt.toISOString(),
      user: c.user,
    })));
  });

  // Remove collaborator from a case
  fastify.delete<{
    Params: { caseId: string; collaboratorId: string };
  }>('/api/cases/:caseId/collaborators/:collaboratorId', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { caseId, collaboratorId } = request.params;

    try {
      await prisma.caseCollaborator.delete({
        where: { id: collaboratorId, caseId },
      });
      return reply.status(204).send();
    } catch {
      return reply.status(404).send({ error: 'Collaborator not found' });
    }
  });

  // Accept/decline collaboration invitation
  fastify.patch<{
    Params: { caseId: string };
    Body: { status: 'accepted' | 'declined' };
  }>('/api/cases/:caseId/collaboration', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { caseId } = request.params;
    const { status } = request.body;
    const currentUser = (request as any).user;

    const collaboration = await prisma.caseCollaborator.findUnique({
      where: { caseId_userId: { caseId, userId: currentUser.id } },
    });

    if (!collaboration) {
      return reply.status(404).send({ error: 'Collaboration not found' });
    }

    const updated = await prisma.caseCollaborator.update({
      where: { id: collaboration.id },
      data: { status },
    });

    return reply.send({
      id: updated.id,
      status: updated.status,
    });
  });

  // Get pending collaboration invitations for current user
  fastify.get('/api/collaborations/pending', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const currentUser = (request as any).user;

    const invitations = await prisma.caseCollaborator.findMany({
      where: {
        userId: currentUser.id,
        status: 'pending',
      },
      include: {
        case: {
          select: { caseId: true, title: true, patientRef: true },
        },
      },
      orderBy: { invitedAt: 'desc' },
    });

    return reply.send(invitations.map(inv => ({
      id: inv.id,
      caseId: inv.caseId,
      role: inv.role,
      invitedAt: inv.invitedAt.toISOString(),
      case: {
        id: inv.case.caseId,
        title: inv.case.title,
        patientRef: inv.case.patientRef,
      },
    })));
  });

  // S3 presigned URL for upload
  fastify.post<{
    Body: {
      key: string;
      contentType: string;
      expires?: number;
    };
  }>('/api/s3/sign-put', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const { key, contentType, expires: _expires = 3600 } = request.body;

    // For now, return a stub URL - in production this would use AWS SDK
    // to generate a real presigned URL
    const stubUrl = `http://localhost:3002/api/upload-stub/${encodeURIComponent(key)}`;

    request.log.info({ key, contentType }, 'Generated presigned URL (stub)');
    return reply.send({ url: stubUrl });
  });

  // Stub upload endpoint (receives the file) - accepts any content type
  fastify.put('/api/upload-stub/*', {
    config: {
      rawBody: true,
    },
  }, async (request, reply) => {
    const url = request.url;
    const key = decodeURIComponent(url.replace('/api/upload-stub/', ''));
    const contentLength = request.headers['content-length'];
    request.log.info({ key, contentLength }, 'File upload received (stub)');
    return reply.status(200).send({ success: true });
  });

  fastify.get('/api/notifications', {
    preHandler: authenticate,
  }, async (_request, reply) => {
    return reply.send({
      notifications: [],
      unreadCount: 0,
    });
  });

  // Google OAuth login/register
  fastify.post<{
    Body: { idToken: string };
  }>('/api/auth/google', async (request, reply) => {
    const { idToken } = request.body;

    if (!googleClient) {
      return reply.status(501).send({
        error: 'Google OAuth not configured',
      });
    }

    try {
      // Verify the Google ID token
      const ticket = await googleClient.verifyIdToken({
        idToken,
        audience: config.GOOGLE_CLIENT_ID,
      });

      const payload = ticket.getPayload();
      if (!payload || !payload.email) {
        return reply.status(400).send({ error: 'Invalid Google token' });
      }

      const { email, name, picture, sub: googleId } = payload;

      // Find or create user
      let user = await prisma.user.findFirst({
        where: {
          OR: [{ googleId }, { email }],
        },
      });

      if (user) {
        // Update existing user - always refresh avatar from Google
        user = await prisma.user.update({
          where: { id: user.id },
          data: {
            googleId: user.googleId || googleId,
            avatarUrl: picture || user.avatarUrl,
            lastLoginAt: new Date(),
          },
        });
      } else {
        // Create new user
        user = await prisma.user.create({
          data: {
            email,
            name: name || email.split('@')[0],
            googleId,
            avatarUrl: picture,
            role: 'pathologist',
            lastLoginAt: new Date(),
          },
        });

        // Create default settings
        await prisma.userSettings.create({
          data: { userId: user.id },
        });
      }

      // Generate JWT
      const accessToken = signToken(user.id);

      const response: AuthResponse = {
        accessToken,
        user: userToResponse(user),
      };

      return reply.send(response);
    } catch (error: any) {
      request.log.error({ error }, 'Google auth failed');
      return reply.status(401).send({
        error: 'Google authentication failed',
      });
    }
  });

  // Get current user
  fastify.get('/api/auth/me', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const user = (request as any).user;
    const response = userToResponse(user);
    request.log.info({ avatarUrl: response.avatarUrl, name: response.name }, 'Returning user data');
    return reply.send(response);
  });

  // Update current user
  fastify.patch<{
    Body: {
      name?: string;
      avatarUrl?: string | null;
      crm?: string;
      specialization?: string;
    };
  }>('/api/users/me', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const user = (request as any).user;
    const { name, avatarUrl, crm, specialization } = request.body;

    const updated = await prisma.user.update({
      where: { id: user.id },
      data: {
        ...(name !== undefined && { name }),
        ...(avatarUrl !== undefined && { avatarUrl }),
        ...(crm !== undefined && { crm }),
        ...(specialization !== undefined && { specialization }),
      },
    });

    return reply.send(userToResponse(updated));
  });

  // Get user settings
  fastify.get('/api/users/me/settings', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const user = (request as any).user;

    let settings = await prisma.userSettings.findUnique({
      where: { userId: user.id },
    });

    if (!settings) {
      settings = await prisma.userSettings.create({
        data: { userId: user.id },
      });
    }

    return reply.send({
      theme: settings.theme,
      language: settings.language,
      defaultZoom: settings.defaultZoom,
      showNavigator: settings.showNavigator,
      showScale: settings.showScale,
      autoRotate: settings.autoRotate,
      annotationColor: settings.annotationColor,
      notificationsEmail: settings.notificationsEmail,
      notificationsBrowser: settings.notificationsBrowser,
    });
  });

  // Update user settings
  fastify.patch<{
    Body: {
      theme?: string;
      language?: string;
      defaultZoom?: number;
      showNavigator?: boolean;
      showScale?: boolean;
      autoRotate?: boolean;
      annotationColor?: string;
      notificationsEmail?: boolean;
      notificationsBrowser?: boolean;
    };
  }>('/api/users/me/settings', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const user = (request as any).user;
    const data = request.body;

    const settings = await prisma.userSettings.upsert({
      where: { userId: user.id },
      update: data,
      create: { userId: user.id, ...data },
    });

    return reply.send({
      theme: settings.theme,
      language: settings.language,
      defaultZoom: settings.defaultZoom,
      showNavigator: settings.showNavigator,
      showScale: settings.showScale,
      autoRotate: settings.autoRotate,
      annotationColor: settings.annotationColor,
      notificationsEmail: settings.notificationsEmail,
      notificationsBrowser: settings.notificationsBrowser,
    });
  });

  // Search users by email or name (for collaboration invites)
  fastify.get<{
    Querystring: { q: string };
  }>('/api/users/search', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const currentUser = (request as any).user;
    const { q } = request.query;

    if (!q || q.length < 2) {
      return reply.send([]);
    }

    const users = await prisma.user.findMany({
      where: {
        AND: [
          { id: { not: currentUser.id } }, // Exclude current user
          {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          },
        ],
      },
      take: 10,
      select: {
        id: true,
        email: true,
        name: true,
        avatarUrl: true,
        specialization: true,
      },
    });

    return reply.send(users);
  });
}
