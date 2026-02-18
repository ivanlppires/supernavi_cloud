import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from '../../db/index.js';
import { authenticate } from '../auth/routes.js';
import config from '../../config/index.js';

// ============================================================================
// Admin middleware — requires role=admin
// ============================================================================

async function requireAdmin(
  request: FastifyRequest,
  reply: FastifyReply
): Promise<void> {
  await authenticate(request, reply);
  if (reply.sent) return;

  const user = (request as any).user;
  if (!user || user.role !== 'admin') {
    return reply.status(403).send({ error: 'Admin access required' });
  }
}

// ============================================================================
// Routes
// ============================================================================

export async function adminRoutes(fastify: FastifyInstance): Promise<void> {

  // --------------------------------------------------------------------------
  // GET /api/admin/user-edges
  // Lists all user-edge associations (active + pending)
  // --------------------------------------------------------------------------
  fastify.get('/api/admin/user-edges', {
    preHandler: requireAdmin,
  }, async (_request, reply) => {
    const edges = await prisma.userEdge.findMany({
      include: {
        user: { select: { id: true, name: true, email: true, avatarUrl: true } },
      },
      orderBy: { createdAt: 'desc' },
    });

    return reply.send({
      edges: edges.map(e => ({
        id: e.id,
        email: e.email,
        edgeId: e.edgeId,
        isPrimary: e.isPrimary,
        status: e.userId ? 'active' : 'pending',
        user: e.user ? {
          id: e.user.id,
          name: e.user.name,
          email: e.user.email,
          avatarUrl: e.user.avatarUrl,
        } : null,
        createdAt: e.createdAt.toISOString(),
      })),
    });
  });

  // --------------------------------------------------------------------------
  // POST /api/admin/user-edges
  // Body: { email: string, edgeId: string, isPrimary?: boolean }
  // Creates a user-edge association. If user exists, links immediately.
  // If not, creates pending record (resolved on first login).
  // --------------------------------------------------------------------------
  fastify.post<{
    Body: { email: string; edgeId: string; isPrimary?: boolean };
  }>('/api/admin/user-edges', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const { email, edgeId, isPrimary } = request.body;

    if (!email || !edgeId) {
      return reply.status(400).send({ error: 'email and edgeId are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if association already exists
    const existing = await prisma.userEdge.findUnique({
      where: { email_edgeId: { email: normalizedEmail, edgeId } },
    });
    if (existing) {
      return reply.status(409).send({ error: 'Association already exists', id: existing.id });
    }

    // Find user by email (may not exist yet)
    const user = await prisma.user.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, name: true },
    });

    const record = await prisma.userEdge.create({
      data: {
        email: normalizedEmail,
        edgeId,
        isPrimary: isPrimary ?? false,
        userId: user?.id ?? null,
      },
    });

    request.log.info(
      { id: record.id, email: normalizedEmail, edgeId, userId: user?.id },
      user ? 'User-edge linked (active)' : 'User-edge created (pending)',
    );

    return reply.status(201).send({
      id: record.id,
      email: normalizedEmail,
      edgeId,
      isPrimary: record.isPrimary,
      status: user ? 'active' : 'pending',
      user: user ? { id: user.id, name: user.name } : null,
    });
  });

  // --------------------------------------------------------------------------
  // DELETE /api/admin/user-edges/:id
  // --------------------------------------------------------------------------
  fastify.delete<{
    Params: { id: string };
  }>('/api/admin/user-edges/:id', {
    preHandler: requireAdmin,
  }, async (request, reply) => {
    const { id } = request.params;

    try {
      await prisma.userEdge.delete({ where: { id } });
      return reply.send({ ok: true });
    } catch (err: any) {
      if (err.code === 'P2025') {
        return reply.status(404).send({ error: 'Association not found' });
      }
      throw err;
    }
  });

  // --------------------------------------------------------------------------
  // GET /api/admin/edges
  // Lists known edge IDs (from slides_read + user_edges)
  // --------------------------------------------------------------------------
  fastify.get('/api/admin/edges', {
    preHandler: requireAdmin,
  }, async (_request, reply) => {
    const fromSlides = await prisma.$queryRaw<Array<{ edge_id: string; slide_count: number }>>`
      SELECT edge_id, COUNT(*)::int AS slide_count
      FROM slides_read
      WHERE edge_id IS NOT NULL
      GROUP BY edge_id
      ORDER BY slide_count DESC
    `;

    const fromUserEdges = await prisma.userEdge.groupBy({
      by: ['edgeId'],
      _count: { id: true },
    });

    // Merge into a single list
    const edgeMap = new Map<string, { slideCount: number; userCount: number }>();
    for (const s of fromSlides) {
      edgeMap.set(s.edge_id, { slideCount: s.slide_count, userCount: 0 });
    }
    for (const ue of fromUserEdges) {
      const existing = edgeMap.get(ue.edgeId) || { slideCount: 0, userCount: 0 };
      existing.userCount = ue._count.id;
      edgeMap.set(ue.edgeId, existing);
    }

    const edges = Array.from(edgeMap.entries()).map(([edgeId, stats]) => ({
      edgeId,
      ...stats,
    }));

    return reply.send({ edges });
  });

  // --------------------------------------------------------------------------
  // POST /api/admin/dev-reset
  // Wipes all slide-related data (slides, previews, annotations, events).
  // Auth: x-supernavi-key header (same key used by UI-Bridge / extension).
  // In dev mode (NODE_ENV != production), no auth required.
  // --------------------------------------------------------------------------
  fastify.post('/api/admin/dev-reset', async (request, reply) => {
    if (config.NODE_ENV === 'production') {
      const apiKey = request.headers['x-supernavi-key'] as string | undefined;
      if (!apiKey || !config.UI_BRIDGE_API_KEY || apiKey !== config.UI_BRIDGE_API_KEY) {
        return reply.status(401).send({ error: 'x-supernavi-key required' });
      }
    }

    const deleted = {
      messages_read: 0,
      annotations_read: 0,
      viewer_audit_log: 0,
      preview_assets: 0,
      slides_read: 0,
      events_slide: 0,
    };

    // Order matters: respect FK constraints
    const r1 = await prisma.messageRead.deleteMany({});
    deleted.messages_read = r1.count;

    const r2 = await prisma.annotationRead.deleteMany({});
    deleted.annotations_read = r2.count;

    const r3 = await prisma.viewerAuditLog.deleteMany({});
    deleted.viewer_audit_log = r3.count;

    const r4 = await prisma.previewAsset.deleteMany({});
    deleted.preview_assets = r4.count;

    const r5 = await prisma.slideRead.deleteMany({});
    deleted.slides_read = r5.count;

    const r6 = await prisma.event.deleteMany({
      where: { aggregateType: 'Slide' },
    });
    deleted.events_slide = r6.count;

    request.log.info({ deleted }, 'dev-reset: slide data wiped');

    return reply.send({ ok: true, deleted });
  });
}
