import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import prisma from '../../db/index.js';
import { authenticate } from '../auth/routes.js';
import {
  createAnnotationSchema,
  updateAnnotationSchema,
  type AnnotationResponse,
  type AnnotationsListResponse,
  type Coordinates,
} from './schemas.js';

export async function annotationRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /api/v1/slides/:slide_id/annotations
   * Returns all annotations for a slide
   */
  fastify.get('/api/v1/slides/:slide_id/annotations', async (
    request: FastifyRequest<{ Params: { slide_id: string } }>,
    reply: FastifyReply
  ) => {
    const { slide_id } = request.params;

    try {
      const annotations = await prisma.annotationRead.findMany({
        where: { slideId: slide_id },
        orderBy: { createdAt: 'asc' },
      });

      const response: AnnotationsListResponse = {
        annotations: annotations.map((a) => ({
          id: a.id,
          slideId: a.slideId,
          name: a.name,
          color: a.color,
          type: a.type,
          coordinates: a.coordinates as Coordinates,
          status: a.status,
          priority: a.priority,
          createdBy: a.createdBy,
          createdAt: a.createdAt.toISOString(),
          updatedAt: a.updatedAt.toISOString(),
        })),
        total: annotations.length,
      };

      return reply.send(response);
    } catch (err) {
      request.log.error({ error: err, slide_id }, 'Failed to fetch annotations');
      return reply.status(500).send({ error: 'Failed to fetch annotations' });
    }
  });

  /**
   * POST /api/v1/slides/:slide_id/annotations
   * Creates a new annotation for a slide
   */
  fastify.post('/api/v1/slides/:slide_id/annotations', async (
    request: FastifyRequest<{ Params: { slide_id: string } }>,
    reply: FastifyReply
  ) => {
    const { slide_id } = request.params;

    const parseResult = createAnnotationSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parseResult.error.format(),
      });
    }

    const data = parseResult.data;

    try {
      const annotation = await prisma.annotationRead.create({
        data: {
          slideId: slide_id,
          name: data.name,
          color: data.color,
          type: data.type,
          coordinates: data.coordinates,
          status: data.status,
          priority: data.priority,
          createdBy: data.createdBy ?? null,
        },
      });

      const response: AnnotationResponse = {
        id: annotation.id,
        slideId: annotation.slideId,
        name: annotation.name,
        color: annotation.color,
        type: annotation.type,
        coordinates: annotation.coordinates as Coordinates,
        status: annotation.status,
        priority: annotation.priority,
        createdBy: annotation.createdBy,
        createdAt: annotation.createdAt.toISOString(),
        updatedAt: annotation.updatedAt.toISOString(),
      };

      request.log.info({ annotation_id: annotation.id, slide_id }, 'Annotation created');
      return reply.status(201).send(response);
    } catch (err) {
      request.log.error({ error: err, slide_id }, 'Failed to create annotation');
      return reply.status(500).send({ error: 'Failed to create annotation' });
    }
  });

  /**
   * GET /api/v1/annotations/:id
   * Returns a single annotation by ID
   */
  fastify.get('/api/v1/annotations/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const id = parseInt(request.params.id, 10);

    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid annotation ID' });
    }

    try {
      const annotation = await prisma.annotationRead.findUnique({
        where: { id },
      });

      if (!annotation) {
        return reply.status(404).send({ error: 'Annotation not found' });
      }

      const response: AnnotationResponse = {
        id: annotation.id,
        slideId: annotation.slideId,
        name: annotation.name,
        color: annotation.color,
        type: annotation.type,
        coordinates: annotation.coordinates as Coordinates,
        status: annotation.status,
        priority: annotation.priority,
        createdBy: annotation.createdBy,
        createdAt: annotation.createdAt.toISOString(),
        updatedAt: annotation.updatedAt.toISOString(),
      };

      return reply.send(response);
    } catch (err) {
      request.log.error({ error: err, id }, 'Failed to fetch annotation');
      return reply.status(500).send({ error: 'Failed to fetch annotation' });
    }
  });

  /**
   * PUT /api/v1/annotations/:id
   * Updates an annotation
   */
  fastify.put('/api/v1/annotations/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const id = parseInt(request.params.id, 10);

    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid annotation ID' });
    }

    const parseResult = updateAnnotationSchema.safeParse(request.body);
    if (!parseResult.success) {
      return reply.status(400).send({
        error: 'Invalid request body',
        details: parseResult.error.format(),
      });
    }

    const data = parseResult.data;

    try {
      // Check if annotation exists
      const existing = await prisma.annotationRead.findUnique({
        where: { id },
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Annotation not found' });
      }

      const annotation = await prisma.annotationRead.update({
        where: { id },
        data: {
          ...(data.name !== undefined && { name: data.name }),
          ...(data.color !== undefined && { color: data.color }),
          ...(data.coordinates !== undefined && { coordinates: data.coordinates }),
          ...(data.status !== undefined && { status: data.status }),
          ...(data.priority !== undefined && { priority: data.priority }),
        },
      });

      const response: AnnotationResponse = {
        id: annotation.id,
        slideId: annotation.slideId,
        name: annotation.name,
        color: annotation.color,
        type: annotation.type,
        coordinates: annotation.coordinates as Coordinates,
        status: annotation.status,
        priority: annotation.priority,
        createdBy: annotation.createdBy,
        createdAt: annotation.createdAt.toISOString(),
        updatedAt: annotation.updatedAt.toISOString(),
      };

      request.log.info({ annotation_id: id }, 'Annotation updated');
      return reply.send(response);
    } catch (err) {
      request.log.error({ error: err, id }, 'Failed to update annotation');
      return reply.status(500).send({ error: 'Failed to update annotation' });
    }
  });

  /**
   * DELETE /api/v1/annotations/:id
   * Deletes an annotation
   */
  fastify.delete('/api/v1/annotations/:id', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const id = parseInt(request.params.id, 10);

    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid annotation ID' });
    }

    try {
      // Check if annotation exists
      const existing = await prisma.annotationRead.findUnique({
        where: { id },
      });

      if (!existing) {
        return reply.status(404).send({ error: 'Annotation not found' });
      }

      await prisma.annotationRead.delete({
        where: { id },
      });

      request.log.info({ annotation_id: id }, 'Annotation deleted');
      return reply.status(204).send();
    } catch (err) {
      request.log.error({ error: err, id }, 'Failed to delete annotation');
      return reply.status(500).send({ error: 'Failed to delete annotation' });
    }
  });

  /**
   * GET /api/v1/annotations/:id/messages
   * Returns all messages for an annotation
   */
  fastify.get('/api/v1/annotations/:id/messages', async (
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply
  ) => {
    const id = parseInt(request.params.id, 10);

    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid annotation ID' });
    }

    try {
      // Check if annotation exists
      const annotation = await prisma.annotationRead.findUnique({
        where: { id },
      });

      if (!annotation) {
        return reply.status(404).send({ error: 'Annotation not found' });
      }

      const messages = await prisma.messageRead.findMany({
        where: { annotationId: id },
        orderBy: { createdAt: 'asc' },
      });

      return reply.send(messages.map((m) => ({
        id: m.id,
        annotationId: m.annotationId,
        authorId: m.authorId,
        content: m.content,
        type: m.type,
        aiConfidence: m.aiConfidence,
        aiFindings: m.aiFindings,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
      })));
    } catch (err) {
      request.log.error({ error: err, id }, 'Failed to fetch messages');
      return reply.status(500).send({ error: 'Failed to fetch messages' });
    }
  });

  /**
   * POST /api/v1/annotations/:id/messages
   * Creates a new message in an annotation thread
   */
  fastify.post<{ Params: { id: string } }>('/api/v1/annotations/:id/messages', {
    preHandler: authenticate,
  }, async (request, reply) => {
    const id = parseInt(request.params.id, 10);

    if (isNaN(id)) {
      return reply.status(400).send({ error: 'Invalid annotation ID' });
    }

    const body = request.body as { content?: string; type?: string };

    if (!body.content || typeof body.content !== 'string' || body.content.trim() === '') {
      return reply.status(400).send({ error: 'Content is required' });
    }

    try {
      // Check if annotation exists
      const annotation = await prisma.annotationRead.findUnique({
        where: { id },
      });

      if (!annotation) {
        return reply.status(404).send({ error: 'Annotation not found' });
      }

      // Get authenticated user ID (from JWT)
      const userId = (request as any).user?.id;
      if (!userId) {
        return reply.status(401).send({ error: 'Unauthorized' });
      }

      const message = await prisma.messageRead.create({
        data: {
          annotationId: id,
          authorId: userId,
          content: body.content.trim(),
          type: body.type || 'text',
        },
      });

      request.log.info({ message_id: message.id, annotation_id: id }, 'Message created');

      return reply.status(201).send({
        id: message.id,
        annotationId: message.annotationId,
        authorId: message.authorId,
        content: message.content,
        type: message.type,
        aiConfidence: message.aiConfidence,
        aiFindings: message.aiFindings,
        createdAt: message.createdAt.toISOString(),
        updatedAt: message.updatedAt.toISOString(),
      });
    } catch (err) {
      request.log.error({ error: err, id }, 'Failed to create message');
      return reply.status(500).send({ error: 'Failed to create message' });
    }
  });
}

export default annotationRoutes;
