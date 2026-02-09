#!/usr/bin/env npx tsx
/**
 * Smoke Test: Preview Signed URLs
 *
 * Tests that the /api/v1/slides/:slide_id/preview endpoint returns
 * valid signed URLs that work with Wasabi S3.
 *
 * Usage:
 *   npx tsx scripts/smoke-preview.ts <slide_id>
 *   npx tsx scripts/smoke-preview.ts <slide_id> --base-url http://localhost:3001
 *
 * Example:
 *   npx tsx scripts/smoke-preview.ts f41fa55d4f2478bbff5e9192b1031fcc19f9513b24708961121012492e0bfe3b
 */

const args = process.argv.slice(2);

if (args.length < 1 || args[0] === '--help') {
  console.log(`
Usage: npx tsx scripts/smoke-preview.ts <slide_id> [options]

Options:
  --base-url <url>  API base URL (default: http://localhost:3000)
  --help            Show this help

Example:
  npx tsx scripts/smoke-preview.ts abc123def456
  npx tsx scripts/smoke-preview.ts abc123def456 --base-url http://localhost:3001
`);
  process.exit(args[0] === '--help' ? 0 : 1);
}

const slideId = args[0];
let baseUrl = 'http://localhost:3000';

// Parse --base-url option
const baseUrlIndex = args.indexOf('--base-url');
if (baseUrlIndex !== -1 && args[baseUrlIndex + 1]) {
  baseUrl = args[baseUrlIndex + 1];
}

interface PreviewResponse {
  slide_id: string;
  case_id: string;
  thumb_url: string;
  manifest_url: string;
  tiles: {
    strategy: string;
    max_preview_level: number;
    tile_size: number;
    format: string;
    endpoint: string;
  };
}

async function main() {
  console.log('='.repeat(60));
  console.log('Preview Signed URL Smoke Test');
  console.log('='.repeat(60));
  console.log('');
  console.log(`Slide ID: ${slideId}`);
  console.log(`Base URL: ${baseUrl}`);
  console.log('');

  // Step 1: Fetch preview
  console.log('[1/3] Fetching preview info...');
  const previewUrl = `${baseUrl}/api/v1/slides/${slideId}/preview`;
  console.log(`  GET ${previewUrl}`);

  let preview: PreviewResponse;
  try {
    const response = await fetch(previewUrl);
    if (!response.ok) {
      const errorText = await response.text();
      console.error(`  ERROR: HTTP ${response.status}`);
      console.error(`  ${errorText}`);
      process.exit(1);
    }
    preview = await response.json() as PreviewResponse;
    console.log('  OK');
    console.log('');
  } catch (err) {
    console.error(`  ERROR: ${(err as Error).message}`);
    process.exit(1);
  }

  // Display preview info
  console.log('Preview Response:');
  console.log(`  slide_id: ${preview.slide_id}`);
  console.log(`  case_id: ${preview.case_id}`);
  console.log(`  max_preview_level: ${preview.tiles.max_preview_level}`);
  console.log(`  tile_size: ${preview.tiles.tile_size}`);
  console.log(`  format: ${preview.tiles.format}`);
  console.log('');

  // Check if URLs contain real signatures
  console.log('Signed URLs Analysis:');
  const hasRealSignature = (url: string) => {
    return url.includes('X-Amz-Algorithm') &&
           url.includes('X-Amz-Credential') &&
           url.includes('X-Amz-Signature') &&
           !url.includes('mock');
  };

  const thumbHasRealSig = hasRealSignature(preview.thumb_url);
  const manifestHasRealSig = hasRealSignature(preview.manifest_url);

  console.log(`  thumb_url has real signature: ${thumbHasRealSig ? 'YES' : 'NO (MOCK!)'}`);
  console.log(`  manifest_url has real signature: ${manifestHasRealSig ? 'YES' : 'NO (MOCK!)'}`);
  console.log('');

  if (!thumbHasRealSig || !manifestHasRealSig) {
    console.error('ERROR: URLs contain mock signatures!');
    console.log('');
    console.log('thumb_url:', preview.thumb_url.substring(0, 100) + '...');
    console.log('manifest_url:', preview.manifest_url.substring(0, 100) + '...');
    process.exit(1);
  }

  // Step 2: Test thumb URL with GET request
  // Note: Wasabi doesn't support HEAD with presigned URLs, so we use GET
  console.log('[2/3] Testing thumb_url with GET request...');
  console.log(`  GET ${preview.thumb_url.substring(0, 80)}...`);

  try {
    const thumbResponse = await fetch(preview.thumb_url);
    console.log(`  HTTP ${thumbResponse.status} ${thumbResponse.statusText}`);

    if (thumbResponse.ok) {
      const contentType = thumbResponse.headers.get('content-type');
      const blob = await thumbResponse.blob();
      console.log(`  Content-Type: ${contentType}`);
      console.log(`  Size: ${blob.size} bytes`);
      console.log('  PASS');
    } else {
      console.error('  FAIL - Expected 200 OK');
      process.exit(1);
    }
  } catch (err) {
    console.error(`  ERROR: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log('');

  // Step 3: Test manifest URL with GET request
  // Note: Wasabi doesn't support HEAD with presigned URLs, so we use GET
  console.log('[3/3] Testing manifest_url with GET request...');
  console.log(`  GET ${preview.manifest_url.substring(0, 80)}...`);

  try {
    const manifestResponse = await fetch(preview.manifest_url);
    console.log(`  HTTP ${manifestResponse.status} ${manifestResponse.statusText}`);

    if (manifestResponse.ok) {
      const contentType = manifestResponse.headers.get('content-type');
      const blob = await manifestResponse.blob();
      console.log(`  Content-Type: ${contentType}`);
      console.log(`  Size: ${blob.size} bytes`);
      console.log('  PASS');
    } else {
      console.error('  FAIL - Expected 200 OK');
      process.exit(1);
    }
  } catch (err) {
    console.error(`  ERROR: ${(err as Error).message}`);
    process.exit(1);
  }
  console.log('');

  // Summary
  console.log('='.repeat(60));
  console.log('ALL TESTS PASSED');
  console.log('='.repeat(60));
  console.log('');
  console.log('Signed URLs are working correctly with Wasabi S3.');
}

main().catch((err) => {
  console.error('Unexpected error:', err);
  process.exit(1);
});
