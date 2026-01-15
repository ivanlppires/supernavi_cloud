/**
 * Validates that a key is safe (no path traversal, etc.)
 */
export function isValidKey(key: string): boolean {
  // Must not be empty
  if (!key || key.trim() === '') {
    return false;
  }

  // Must not contain path traversal
  if (key.includes('..')) {
    return false;
  }

  // Must not start with /
  if (key.startsWith('/')) {
    return false;
  }

  // Must not contain null bytes or other control characters
  if (/[\x00-\x1f]/.test(key)) {
    return false;
  }

  return true;
}

/**
 * Validates that a tile key belongs to the expected prefix
 */
export function validateTileKeyAgainstPrefix(
  key: string,
  allowedPrefix: string
): boolean {
  if (!isValidKey(key)) {
    return false;
  }

  // Normalize prefix (ensure it ends without /)
  const normalizedPrefix = allowedPrefix.endsWith('/')
    ? allowedPrefix.slice(0, -1)
    : allowedPrefix;

  // Key must start with the allowed prefix
  return key.startsWith(normalizedPrefix + '/') || key.startsWith(normalizedPrefix);
}

/**
 * Extracts slide_id from a tile key like "previews/<slide_id>/tiles/..."
 */
export function extractSlideIdFromKey(key: string): string | null {
  // Expected format: previews/<slide_id>/...
  const match = key.match(/^previews\/([^/]+)\//);
  return match ? match[1] : null;
}
