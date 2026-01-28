import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { OAuth2Client } from 'google-auth-library';
import jwt, { SignOptions } from 'jsonwebtoken';
import { prisma } from '../../db/index.js';
import config from '../../config/index.js';

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

// Auth middleware
async function authenticate(
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
  }, async (_request, reply) => {
    const cases = await prisma.caseRead.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        slides: true,
      },
    });

    // Transform to frontend expected format
    const result = cases.map(c => ({
      id: c.caseId,
      caseNumber: c.caseId,
      patientName: c.title,
      status: c.status === 'active' ? 'pendente' : c.status,
      location: 'inbox',
      createdAt: c.createdAt.toISOString(),
      updatedAt: c.updatedAt.toISOString(),
      slides: c.slides.map(s => ({
        id: s.slideId,
        name: s.svsFilename,
        processingStatus: s.hasPreview ? 'ready' : 'processing',
      })),
    }));

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
    const { caseNumber, patientName } = request.body;
    const now = new Date();
    const caseId = `case-${Date.now()}`;

    const newCase = await prisma.caseRead.create({
      data: {
        caseId,
        title: patientName,
        patientRef: caseNumber,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });

    request.log.info({ caseId: newCase.caseId, patientName }, 'Case created');

    return reply.status(201).send({
      id: newCase.caseId,
      caseNumber: newCase.patientRef,
      patientName: newCase.title,
      status: 'pendente',
      location: 'inbox',
      createdAt: newCase.createdAt.toISOString(),
      updatedAt: newCase.updatedAt.toISOString(),
    });
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
    });

    const result = slides.map(s => ({
      id: s.slideId,
      caseId: s.caseId,
      name: s.svsFilename.replace(/\.[^/.]+$/, ''),
      originalFilename: s.svsFilename,
      width: s.width,
      height: s.height,
      processingStatus: s.hasPreview ? 'ready' : 'processing',
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
}
