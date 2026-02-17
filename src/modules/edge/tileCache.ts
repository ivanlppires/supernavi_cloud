import { LRUCache } from 'lru-cache';

interface CachedTile {
  buffer: Buffer;
  contentType: string;
}

interface TileCacheOptions {
  maxSizeMB: number;
  ttlMs: number;
}

export class TileCache {
  private cache: LRUCache<string, CachedTile>;
  private _hits = 0;
  private _misses = 0;

  constructor(options: TileCacheOptions) {
    this.cache = new LRUCache<string, CachedTile>({
      maxSize: options.maxSizeMB * 1024 * 1024,
      sizeCalculation: (value) => value.buffer.length,
      ttl: options.ttlMs,
    });
  }

  private key(slideId: string, z: number, x: number, y: number): string {
    return `${slideId}:${z}:${x}:${y}`;
  }

  get(slideId: string, z: number, x: number, y: number): CachedTile | undefined {
    const result = this.cache.get(this.key(slideId, z, x, y));
    if (result) {
      this._hits++;
    } else {
      this._misses++;
    }
    return result;
  }

  set(slideId: string, z: number, x: number, y: number, buffer: Buffer, contentType: string): void {
    this.cache.set(this.key(slideId, z, x, y), { buffer, contentType });
  }

  size(): number {
    return this.cache.size;
  }

  stats() {
    return {
      entries: this.cache.size,
      sizeBytes: this.cache.calculatedSize,
      hits: this._hits,
      misses: this._misses,
    };
  }
}
