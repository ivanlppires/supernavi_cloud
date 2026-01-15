import { describe, it, expect } from 'vitest';
import {
  isValidKey,
  validateTileKeyAgainstPrefix,
  extractSlideIdFromKey,
} from '../src/modules/wasabi/wasabiSigner.js';

describe('wasabiSigner', () => {
  describe('isValidKey', () => {
    it('should accept valid keys', () => {
      expect(isValidKey('previews/slide-123/thumb.jpg')).toBe(true);
      expect(isValidKey('previews/slide-123/tiles/0/0_0.jpg')).toBe(true);
      expect(isValidKey('folder/subfolder/file.txt')).toBe(true);
    });

    it('should reject empty keys', () => {
      expect(isValidKey('')).toBe(false);
      expect(isValidKey('   ')).toBe(false);
    });

    it('should reject keys with path traversal', () => {
      expect(isValidKey('../etc/passwd')).toBe(false);
      expect(isValidKey('previews/../other/file.jpg')).toBe(false);
      expect(isValidKey('previews/slide-123/../../secret')).toBe(false);
    });

    it('should reject keys starting with /', () => {
      expect(isValidKey('/previews/slide-123/thumb.jpg')).toBe(false);
    });

    it('should reject keys with control characters', () => {
      expect(isValidKey('previews/slide\x00123/thumb.jpg')).toBe(false);
      expect(isValidKey('previews/slide\nid/thumb.jpg')).toBe(false);
    });
  });

  describe('validateTileKeyAgainstPrefix', () => {
    const prefix = 'previews/slide-123/tiles';

    it('should accept keys within the prefix', () => {
      expect(validateTileKeyAgainstPrefix('previews/slide-123/tiles/0/0_0.jpg', prefix)).toBe(true);
      expect(validateTileKeyAgainstPrefix('previews/slide-123/tiles/1/2_3.jpg', prefix)).toBe(true);
    });

    it('should accept keys matching prefix exactly (with trailing content)', () => {
      expect(validateTileKeyAgainstPrefix('previews/slide-123/tiles/', prefix)).toBe(true);
    });

    it('should reject keys outside the prefix', () => {
      expect(validateTileKeyAgainstPrefix('previews/other-slide/tiles/0/0_0.jpg', prefix)).toBe(false);
      expect(validateTileKeyAgainstPrefix('previews/slide-124/tiles/0/0_0.jpg', prefix)).toBe(false);
    });

    it('should reject invalid keys even if they match prefix', () => {
      expect(validateTileKeyAgainstPrefix('../previews/slide-123/tiles/0/0_0.jpg', prefix)).toBe(false);
    });

    it('should handle prefix with trailing slash', () => {
      const prefixWithSlash = 'previews/slide-123/tiles/';
      expect(validateTileKeyAgainstPrefix('previews/slide-123/tiles/0/0_0.jpg', prefixWithSlash)).toBe(true);
    });
  });

  describe('extractSlideIdFromKey', () => {
    it('should extract slide_id from valid preview keys', () => {
      expect(extractSlideIdFromKey('previews/slide-123/thumb.jpg')).toBe('slide-123');
      expect(extractSlideIdFromKey('previews/abc-def-ghi/tiles/0/0_0.jpg')).toBe('abc-def-ghi');
      expect(extractSlideIdFromKey('previews/12345/manifest.json')).toBe('12345');
    });

    it('should return null for invalid key formats', () => {
      expect(extractSlideIdFromKey('other/slide-123/thumb.jpg')).toBeNull();
      expect(extractSlideIdFromKey('thumb.jpg')).toBeNull();
      expect(extractSlideIdFromKey('')).toBeNull();
    });

    it('should handle UUID slide IDs', () => {
      const uuid = 'f47ac10b-58cc-4372-a567-0e02b2c3d479';
      expect(extractSlideIdFromKey(`previews/${uuid}/thumb.jpg`)).toBe(uuid);
    });
  });
});
