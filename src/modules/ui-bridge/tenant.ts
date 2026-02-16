/**
 * Tenant isolation helpers for multi-edge environments.
 *
 * getUserEdgeIds(userId) returns the list of edge IDs a user can access.
 * When null is returned (no user_edges rows), no filtering is applied
 * — this preserves backward compatibility during rollout.
 */

import { prisma } from '../../db/index.js';

/**
 * Returns the list of edge IDs a user is allowed to access.
 * Returns null if user has no entries in user_edges (backward compat: no filtering).
 */
export async function getUserEdgeIds(userId: string): Promise<string[] | null> {
  const rows = await prisma.userEdge.findMany({
    where: { userId },
    select: { edgeId: true },
  });

  if (rows.length === 0) return null;
  return rows.map(r => r.edgeId);
}

/**
 * Returns the primary edge ID for a user, or the first edge if no primary is set.
 */
export async function getUserPrimaryEdgeId(userId: string): Promise<string | null> {
  const primary = await prisma.userEdge.findFirst({
    where: { userId, isPrimary: true },
    select: { edgeId: true },
  });
  if (primary) return primary.edgeId;

  const first = await prisma.userEdge.findFirst({
    where: { userId },
    select: { edgeId: true },
  });
  return first?.edgeId ?? null;
}

/**
 * Builds a Prisma where fragment that filters by edgeId.
 * Returns {} if edgeIds is null (no filtering = backward compat).
 */
export function edgeFilter(edgeIds: string[] | null): { edgeId?: { in: string[] } } {
  if (!edgeIds) return {};
  return { edgeId: { in: edgeIds } };
}

/**
 * Extracts the userId from the request's authenticated extension device.
 * Returns null for legacy API key auth (no device).
 */
export function getAuthUserId(request: any): string | null {
  return request.extensionDevice?.clinicId ?? null;
}
