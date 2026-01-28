import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { Readable } from 'stream';
import prisma from '../../db/index.js';
import config from '../../config/index.js';

/**
 * Cache of S3 clients by endpoint+region key
 */
const s3ClientCache = new Map<string, S3Client>();

/**
 * Gets or creates an S3 client for the given endpoint and region
 */
function getS3Client(endpoint: string, region: string): S3Client {
  const cacheKey = `${endpoint}|${region}`;

  let client = s3ClientCache.get(cacheKey);
  if (!client) {
    client = new S3Client({
      endpoint,
      region,
      credentials: {
        accessKeyId: config.S3_ACCESS_KEY,
        secretAccessKey: config.S3_SECRET_KEY,
      },
      forcePathStyle: config.S3_FORCE_PATH_STYLE,
    });
    s3ClientCache.set(cacheKey, client);
  }

  return client;
}

/**
 * Rewrite manifest URLs to be same-origin
 * Changes tile URLs from absolute Wasabi URLs to relative /preview paths
 */
function rewriteManifest(manifest: Record<string, unknown>, slideId: string): Record<string, unknown> {
  const rewritten = { ...manifest };

  // If manifest has tileUrlTemplate, rewrite it
  if (typeof rewritten.tileUrlTemplate === 'string') {
    // Replace any external tile URL with our same-origin proxy
    rewritten.tileUrlTemplate = `/preview/${slideId}/tiles/{z}/{x}_{y}.jpg`;
  }

  // If manifest has thumbUrl, rewrite it
  if (typeof rewritten.thumbUrl === 'string') {
    rewritten.thumbUrl = `/preview/${slideId}/thumb.jpg`;
  }

  return rewritten;
}

export async function previewRoutes(fastify: FastifyInstance): Promise<void> {
  /**
   * GET /preview/:slideId/manifest.json
   * Fetches manifest from Wasabi and returns it with rewritten URLs
   */
  fastify.get('/preview/:slideId/manifest.json', async (
    request: FastifyRequest<{ Params: { slideId: string } }>,
    reply: FastifyReply
  ) => {
    const { slideId } = request.params;

    try {
      // Get preview asset info from database
      const previewAsset = await prisma.previewAsset.findUnique({
        where: { slideId },
      });

      if (!previewAsset) {
        return reply.status(404).send({ error: 'Preview not found for this slide' });
      }

      // Fetch manifest from Wasabi
      const client = getS3Client(previewAsset.wasabiEndpoint, previewAsset.wasabiRegion);
      const command = new GetObjectCommand({
        Bucket: previewAsset.wasabiBucket,
        Key: previewAsset.manifestKey,
      });

      try {
        const response = await client.send(command);

        if (!response.Body) {
          return reply.status(404).send({ error: 'Manifest not found in storage' });
        }

        // Read the body as text
        const bodyString = await response.Body.transformToString();
        const manifest = JSON.parse(bodyString);

        // Rewrite URLs to be same-origin
        const rewrittenManifest = rewriteManifest(manifest, slideId);

        // Return with no-cache headers (manifest may change during processing)
        reply.header('Content-Type', 'application/json');
        reply.header('Cache-Control', 'no-cache, no-store, must-revalidate');

        return reply.send(rewrittenManifest);
      } catch (s3Error: unknown) {
        const error = s3Error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
          return reply.status(404).send({ error: 'Manifest not found' });
        }
        throw s3Error;
      }
    } catch (err) {
      request.log.error({ error: err, slideId }, 'Failed to fetch manifest');
      return reply.status(500).send({ error: 'Failed to fetch manifest' });
    }
  });

  /**
   * GET /preview/:slideId/thumb.jpg
   * Streams thumbnail from Wasabi
   */
  fastify.get('/preview/:slideId/thumb.jpg', async (
    request: FastifyRequest<{ Params: { slideId: string } }>,
    reply: FastifyReply
  ) => {
    const { slideId } = request.params;

    try {
      const previewAsset = await prisma.previewAsset.findUnique({
        where: { slideId },
      });

      if (!previewAsset) {
        return reply.status(404).send({ error: 'Preview not found for this slide' });
      }

      const client = getS3Client(previewAsset.wasabiEndpoint, previewAsset.wasabiRegion);
      const command = new GetObjectCommand({
        Bucket: previewAsset.wasabiBucket,
        Key: previewAsset.thumbKey,
      });

      try {
        const response = await client.send(command);

        if (!response.Body) {
          return reply.status(404).send({ error: 'Thumbnail not found in storage' });
        }

        // Set headers
        reply.header('Content-Type', response.ContentType || 'image/jpeg');
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');

        if (response.ContentLength) {
          reply.header('Content-Length', response.ContentLength);
        }

        // Stream the response
        const stream = response.Body as Readable;
        return reply.send(stream);
      } catch (s3Error: unknown) {
        const error = s3Error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
          return reply.status(404).send({ error: 'Thumbnail not found' });
        }
        throw s3Error;
      }
    } catch (err) {
      request.log.error({ error: err, slideId }, 'Failed to fetch thumbnail');
      return reply.status(500).send({ error: 'Failed to fetch thumbnail' });
    }
  });

  /**
   * GET /preview/:slideId/tiles/:level/:file
   * Streams a tile from Wasabi
   * :file is in format "x_y.jpg"
   */
  fastify.get('/preview/:slideId/tiles/:level/:file', async (
    request: FastifyRequest<{ Params: { slideId: string; level: string; file: string } }>,
    reply: FastifyReply
  ) => {
    const { slideId, level, file } = request.params;

    // Validate level (must be numeric)
    if (!/^\d+$/.test(level)) {
      return reply.status(400).send({ error: 'Invalid level format' });
    }

    // Validate file format (x_y.jpg)
    if (!/^\d+_\d+\.(jpg|jpeg|png)$/i.test(file)) {
      return reply.status(400).send({ error: 'Invalid tile file format' });
    }

    try {
      const previewAsset = await prisma.previewAsset.findUnique({
        where: { slideId },
      });

      if (!previewAsset) {
        return reply.status(404).send({ error: 'Preview not found for this slide' });
      }

      // Construct the tile key
      // Tiles are stored as: previews/<slideId>/preview_tiles/<level>/<x>_<y>.jpg
      const tileKey = `${previewAsset.lowTilesPrefix}/${level}/${file}`;

      const client = getS3Client(previewAsset.wasabiEndpoint, previewAsset.wasabiRegion);
      const command = new GetObjectCommand({
        Bucket: previewAsset.wasabiBucket,
        Key: tileKey,
      });

      try {
        const response = await client.send(command);

        if (!response.Body) {
          return reply.status(404).send({ error: 'Tile not found in storage' });
        }

        // Set headers
        reply.header('Content-Type', response.ContentType || 'image/jpeg');
        reply.header('Cache-Control', 'public, max-age=31536000, immutable');

        if (response.ContentLength) {
          reply.header('Content-Length', response.ContentLength);
        }

        // Stream the response
        const stream = response.Body as Readable;
        return reply.send(stream);
      } catch (s3Error: unknown) {
        const error = s3Error as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) {
          return reply.status(404).send({ error: 'Tile not found' });
        }
        throw s3Error;
      }
    } catch (err) {
      request.log.error({ error: err, slideId, level, file }, 'Failed to fetch tile');
      return reply.status(500).send({ error: 'Failed to fetch tile' });
    }
  });
}

export default previewRoutes;
