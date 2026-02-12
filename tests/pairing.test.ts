import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import jwt, { SignOptions } from 'jsonwebtoken';
import { prisma } from '../src/db/index.js';
import { pairingRoutes } from '../src/modules/pairing/routes.js';
import { uiBridgeRoutes } from '../src/modules/ui-bridge/routes.js';
import { authRoutes } from '../src/modules/auth/routes.js';

let app: FastifyInstance;
let adminToken: string;
let adminId: string;

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';

function signTestToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '1h' } as SignOptions);
}

async function createTestAdmin(): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      email: `admin-${Date.now()}@test.local`,
      name: 'Test Admin',
      role: 'admin',
    },
  });
  return { id: user.id, token: signTestToken(user.id) };
}

async function createTestUser(): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      email: `user-${Date.now()}@test.local`,
      name: 'Test User',
      role: 'pathologist',
    },
  });
  return { id: user.id, token: signTestToken(user.id) };
}

beforeAll(async () => {
  app = Fastify();
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(authRoutes);
  await app.register(uiBridgeRoutes);
  await app.register(pairingRoutes);
  await app.ready();

  const admin = await createTestAdmin();
  adminToken = admin.token;
  adminId = admin.id;
});

afterAll(async () => {
  // Cleanup test data
  await prisma.pairingCode.deleteMany({});
  await prisma.extensionDevice.deleteMany({});
  await prisma.user.deleteMany({ where: { email: { contains: '@test.local' } } });
  await app.close();
});

beforeEach(async () => {
  // Clean pairing data between tests
  await prisma.pairingCode.deleteMany({});
  await prisma.extensionDevice.deleteMany({});
});

describe('POST /api/ui-bridge/pairing/start', () => {
  it('requires admin JWT', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/start',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('allows non-admin users', async () => {
    const user = await createTestUser();
    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/start',
      payload: {},
      headers: { authorization: `Bearer ${user.token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().code).toHaveLength(6);
  });

  it('returns a 6-char code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/start',
      payload: {},
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.code).toHaveLength(6);
    expect(body.expiresAt).toBeTruthy();
    expect(body.expiresInSeconds).toBe(600);
    expect(body.qrPayload).toBeTruthy();

    // Code should only contain unambiguous chars
    const validChars = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/;
    expect(body.code).toMatch(validChars);
  });

  it('invalidates previous unused codes', async () => {
    // Generate first code
    const res1 = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/start',
      payload: {},
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const code1 = res1.json().code;

    // Generate second code
    await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/start',
      payload: {},
      headers: { authorization: `Bearer ${adminToken}` },
    });

    // First code should be expired
    const pairingCode = await prisma.pairingCode.findUnique({ where: { code: code1 } });
    expect(pairingCode).toBeTruthy();
    expect(pairingCode!.expiresAt.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

describe('POST /api/ui-bridge/pairing/claim', () => {
  it('returns deviceToken for valid code', async () => {
    // Generate code
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/start',
      payload: {},
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const { code } = startRes.json();

    // Claim it
    const claimRes = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/claim',
      payload: { code },
    });
    expect(claimRes.statusCode).toBe(200);
    const body = claimRes.json();
    expect(body.deviceToken).toHaveLength(64); // 32 bytes hex
    expect(body.deviceId).toBeTruthy();
    expect(body.deviceName).toBeTruthy();

    // Verify device was created in DB with hashed token
    const device = await prisma.extensionDevice.findUnique({
      where: { id: body.deviceId },
    });
    expect(device).toBeTruthy();
    expect(device!.tokenHash).toBe(
      createHash('sha256').update(body.deviceToken).digest('hex')
    );
    expect(device!.revokedAt).toBeNull();
  });

  it('returns 404 for invalid code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/claim',
      payload: { code: 'XXXXXX' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 410 for expired code', async () => {
    // Create an already-expired code directly in DB
    await prisma.pairingCode.create({
      data: {
        code: 'EXPRD1',
        clinicId: adminId,
        expiresAt: new Date(Date.now() - 60000), // 1 min ago
      },
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/claim',
      payload: { code: 'EXPRD1' },
    });
    expect(res.statusCode).toBe(410);
  });

  it('returns 410 for already-used code', async () => {
    // Generate and claim a code
    const startRes = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/start',
      payload: {},
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const { code } = startRes.json();

    await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/claim',
      payload: { code },
    });

    // Try to claim again
    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/claim',
      payload: { code },
    });
    expect(res.statusCode).toBe(410);
  });
});

describe('POST /api/ui-bridge/pairing/revoke', () => {
  it('revokes a device', async () => {
    // Create a device directly in DB
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const device = await prisma.extensionDevice.create({
      data: {
        clinicId: adminId,
        name: 'ToRevoke-Device',
        tokenHash,
      },
    });

    // Revoke it
    const revokeRes = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/pairing/revoke',
      payload: { deviceId: device.id },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(revokeRes.statusCode).toBe(200);
    expect(revokeRes.json().ok).toBe(true);

    // Verify in DB
    const updated = await prisma.extensionDevice.findUnique({ where: { id: device.id } });
    expect(updated!.revokedAt).toBeTruthy();
  });
});

describe('authenticateApiKey dual-mode', () => {
  it('accepts legacy x-supernavi-key header', async () => {
    // Create a test slide so status endpoint works
    const res = await app.inject({
      method: 'GET',
      url: '/api/ui-bridge/cases/AP99999999/status',
      headers: { 'x-supernavi-key': process.env.UI_BRIDGE_API_KEY || 'snavi-dev-bridge-key-2026' },
    });
    // Should succeed auth (200) even if no data found
    expect(res.statusCode).toBe(200);
  });

  it('accepts paired device x-device-token header', async () => {
    // Create a device with known token
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await prisma.extensionDevice.create({
      data: {
        clinicId: adminId,
        name: 'Test-Device',
        tokenHash,
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/ui-bridge/cases/AP99999999/status',
      headers: { 'x-device-token': rawToken },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects revoked device token', async () => {
    const rawToken = randomBytes(32).toString('hex');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    await prisma.extensionDevice.create({
      data: {
        clinicId: adminId,
        name: 'Revoked-Device',
        tokenHash,
        revokedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/ui-bridge/cases/AP99999999/status',
      headers: { 'x-device-token': rawToken },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects request with no auth headers', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/ui-bridge/cases/AP99999999/status',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /api/ui-bridge/pairing/devices', () => {
  it('lists devices for admin', async () => {
    // Create devices
    await prisma.extensionDevice.createMany({
      data: [
        { clinicId: adminId, name: 'Device-1', tokenHash: 'hash1' },
        { clinicId: adminId, name: 'Device-2', tokenHash: 'hash2', revokedAt: new Date() },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/ui-bridge/pairing/devices',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const devices = res.json();
    expect(devices).toHaveLength(2);
    expect(devices[0].name).toBeTruthy();
    expect(devices.find((d: any) => d.name === 'Device-2').isActive).toBe(false);
    expect(devices.find((d: any) => d.name === 'Device-1').isActive).toBe(true);
  });
});
