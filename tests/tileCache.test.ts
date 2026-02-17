import { describe, it, expect, beforeEach } from 'vitest';
import { TileCache } from '../src/modules/edge/tileCache.js';

describe('TileCache', () => {
  let cache: TileCache;

  beforeEach(() => {
    cache = new TileCache({ maxSizeMB: 1, ttlMs: 5000 });
  });

  it('should return undefined for cache miss', () => {
    expect(cache.get('slide1', 5, 0, 0)).toBeUndefined();
  });

  it('should store and retrieve a tile', () => {
    const buffer = Buffer.from('fake-tile-data');
    cache.set('slide1', 5, 0, 0, buffer, 'image/jpeg');

    const result = cache.get('slide1', 5, 0, 0);
    expect(result).toBeDefined();
    expect(result!.buffer).toEqual(buffer);
    expect(result!.contentType).toBe('image/jpeg');
  });

  it('should evict when size limit is exceeded', () => {
    const bigBuffer = Buffer.alloc(500 * 1024, 0x42);

    cache.set('s1', 0, 0, 0, bigBuffer, 'image/jpeg');
    cache.set('s1', 0, 1, 0, bigBuffer, 'image/jpeg');
    cache.set('s1', 0, 2, 0, bigBuffer, 'image/jpeg');

    expect(cache.get('s1', 0, 2, 0)).toBeDefined();
    expect(cache.size()).toBeLessThanOrEqual(2);
  });

  it('should report stats', () => {
    const buffer = Buffer.from('data');
    cache.set('s1', 0, 0, 0, buffer, 'image/jpeg');
    cache.get('s1', 0, 0, 0); // hit
    cache.get('s1', 0, 1, 0); // miss

    const stats = cache.stats();
    expect(stats.hits).toBe(1);
    expect(stats.misses).toBe(1);
    expect(stats.entries).toBe(1);
  });
});
