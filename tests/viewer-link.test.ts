import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createHash, randomBytes } from 'crypto';
import Fastify, { FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import jwt, { SignOptions } from 'jsonwebtoken';
import { prisma } from '../src/db/index.js';
import { uiBridgeRoutes } from '../src/modules/ui-bridge/routes.js';
import { authRoutes } from '../src/modules/auth/routes.js';

let app: FastifyInstance;
let adminId: string;
let adminToken: string;

const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-in-production';
const API_KEY = process.env.UI_BRIDGE_API_KEY || 'snavi-dev-bridge-key-2026';

function signTestToken(userId: string): string {
  return jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: '1h' } as SignOptions);
}

async function createTestAdmin(): Promise<{ id: string; token: string }> {
  const user = await prisma.user.create({
    data: {
      email: `vl-admin-${Date.now()}@test.local`,
      name: 'Test Admin VL',
      role: 'admin',
    },
  });
  return { id: user.id, token: signTestToken(user.id) };
}

async function createTestSlide(slideId: string, caseBase: string | null, caseId: string | null = null) {
  return prisma.slideRead.create({
    data: {
      slideId,
      svsFilename: `${caseBase || 'unknown'}.svs`,
      externalCaseId: caseBase ? `pathoweb:${caseBase}` : null,
      externalCaseBase: caseBase,
      confirmedCaseLink: !!caseBase,
      hasPreview: false,
      caseId,
      width: 1000,
      height: 1000,
      mpp: 0.25,
    },
  });
}

/** Create a paired device and return the raw token */
async function createPairedDevice(userId: string): Promise<string> {
  const rawToken = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(rawToken).digest('hex');
  await prisma.extensionDevice.create({
    data: {
      name: `test-device-vl-${Date.now()}`,
      tokenHash,
      clinicId: userId,
      lastSeenAt: new Date(),
    },
  });
  return rawToken;
}

beforeAll(async () => {
  app = Fastify();
  await app.register(rateLimit, { max: 200, timeWindow: '1 minute' });
  await app.register(authRoutes);
  await app.register(uiBridgeRoutes);
  await app.ready();

  const admin = await createTestAdmin();
  adminId = admin.id;
  adminToken = admin.token;
});

afterAll(async () => {
  // Cleanup test data in correct order (FK constraints)
  await prisma.viewerAuditLog.deleteMany({});
  await prisma.slideRead.deleteMany({ where: { slideId: { startsWith: 'test-vl-' } } });
  await prisma.caseRead.deleteMany({ where: { caseId: { startsWith: 'pathoweb-' } } });
  await prisma.extensionDevice.deleteMany({ where: { name: { startsWith: 'test-device-vl-' } } });
  await prisma.user.deleteMany({ where: { email: { contains: 'vl-admin' } } });
  await app.close();
});

beforeEach(async () => {
  // Clean slides and cases between tests
  await prisma.viewerAuditLog.deleteMany({});
  await prisma.slideRead.deleteMany({ where: { slideId: { startsWith: 'test-vl-' } } });
  await prisma.caseRead.deleteMany({ where: { caseId: { startsWith: 'pathoweb-' } } });
});

// Use API key auth for most tests (stable, no cross-test interference)
const apiKeyHeaders = { 'x-supernavi-key': API_KEY };

describe('POST /api/ui-bridge/viewer-link', () => {
  it('creates case from patientData', async () => {
    await createTestSlide('test-vl-slide1', 'AP26000299');

    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/viewer-link',
      headers: apiKeyHeaders,
      payload: {
        slideId: 'test-vl-slide1',
        patientData: {
          patientName: 'João Silva',
          age: '65',
          doctor: 'Dr. Santos',
        },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.url).toContain('test-vl-slide1');
    expect(body.token).toBeTruthy();

    // Verify case was created in DB
    const caseRecord = await prisma.caseRead.findFirst({
      where: { patientRef: 'AP26000299' },
    });
    expect(caseRecord).toBeTruthy();
    expect(caseRecord!.caseId).toBe('pathoweb-ap26000299');
    expect(caseRecord!.title).toBe('João Silva');
    expect(caseRecord!.patientAge).toBe(65);
    expect(caseRecord!.doctor).toBe('Dr. Santos');
  });

  it('reuses existing case on repeat call (idempotent)', async () => {
    await createTestSlide('test-vl-slide2', 'AP26000300');

    // First call
    await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/viewer-link',
      headers: apiKeyHeaders,
      payload: {
        slideId: 'test-vl-slide2',
        patientData: { patientName: 'Maria Santos', age: '50' },
      },
    });

    // Second call (should reuse)
    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/viewer-link',
      headers: apiKeyHeaders,
      payload: {
        slideId: 'test-vl-slide2',
        patientData: { patientName: 'Maria Santos Updated', age: '51' },
      },
    });

    expect(res.statusCode).toBe(200);

    // Only one case should exist
    const cases = await prisma.caseRead.findMany({
      where: { patientRef: 'AP26000300' },
    });
    expect(cases).toHaveLength(1);
    expect(cases[0].title).toBe('Maria Santos Updated');
    expect(cases[0].patientAge).toBe(51);
  });

  it('links sibling slides to the case', async () => {
    await createTestSlide('test-vl-slide3a', 'AP26000301');
    await createTestSlide('test-vl-slide3b', 'AP26000301');
    await createTestSlide('test-vl-slide3c', 'AP26000301');

    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/viewer-link',
      headers: apiKeyHeaders,
      payload: {
        slideId: 'test-vl-slide3a',
        patientData: { patientName: 'Pedro Oliveira' },
      },
    });

    expect(res.statusCode).toBe(200);

    // All 3 slides should now have caseId
    const slides = await prisma.slideRead.findMany({
      where: { externalCaseBase: 'AP26000301' },
    });
    expect(slides).toHaveLength(3);
    slides.forEach(s => {
      expect(s.caseId).toBe('pathoweb-ap26000301');
    });
  });

  it('JWT contains real caseId', async () => {
    await createTestSlide('test-vl-slide4', 'AP26000302');

    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/viewer-link',
      headers: apiKeyHeaders,
      payload: {
        slideId: 'test-vl-slide4',
        patientData: { patientName: 'Ana Costa' },
      },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const decoded = jwt.decode(body.token) as any;
    expect(decoded.caseId).toBe('pathoweb-ap26000302');
    expect(decoded.slideId).toBe('test-vl-slide4');
    expect(decoded.purpose).toBe('viewer');
  });

  it('updates patient data on existing case', async () => {
    // Create case manually first
    await prisma.caseRead.create({
      data: {
        caseId: 'pathoweb-ap26000303',
        title: 'Old Name',
        patientRef: 'AP26000303',
        patientAge: 40,
        doctor: null,
        ownerId: adminId,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });
    await createTestSlide('test-vl-slide5', 'AP26000303');

    await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/viewer-link',
      headers: apiKeyHeaders,
      payload: {
        slideId: 'test-vl-slide5',
        patientData: { patientName: 'New Name', age: '55', doctor: 'Dr. Lima' },
      },
    });

    const updated = await prisma.caseRead.findUnique({
      where: { caseId: 'pathoweb-ap26000303' },
    });
    expect(updated!.title).toBe('New Name');
    expect(updated!.patientAge).toBe(55);
    expect(updated!.doctor).toBe('Dr. Lima');
  });

  it('handles missing patientData (no case creation)', async () => {
    await createTestSlide('test-vl-slide6', 'AP26000304');

    const res = await app.inject({
      method: 'POST',
      url: '/api/ui-bridge/viewer-link',
      headers: apiKeyHeaders,
      payload: {
        slideId: 'test-vl-slide6',
      },
    });

    expect(res.statusCode).toBe(200);

    // No case should be created
    const caseRecord = await prisma.caseRead.findFirst({
      where: { patientRef: 'AP26000304' },
    });
    expect(caseRecord).toBeNull();
  });
});

describe('GET /api/cases/:id', () => {
  it('returns patientAge and doctor from DB', async () => {
    await prisma.caseRead.create({
      data: {
        caseId: 'pathoweb-ap26000305',
        title: 'Carlos Ferreira',
        patientRef: 'AP26000305',
        patientAge: 72,
        doctor: 'Dr. Souza',
        ownerId: adminId,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/cases/pathoweb-ap26000305',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.patientAge).toBe(72);
    expect(body.doctor).toBe('Dr. Souza');
    expect(body.patientName).toBe('Carlos Ferreira');
    expect(body.caseNumber).toBe('AP26000305');
  });
});

describe('GET /api/cases', () => {
  it('includes doctor in list response', async () => {
    await prisma.caseRead.create({
      data: {
        caseId: 'pathoweb-ap26000306',
        title: 'Lucia Alves',
        patientRef: 'AP26000306',
        doctor: 'Dr. Mendes',
        ownerId: adminId,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/api/cases',
      headers: { authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    const matchingCase = body.find((c: any) => c.id === 'pathoweb-ap26000306');
    expect(matchingCase).toBeTruthy();
    expect(matchingCase.doctor).toBe('Dr. Mendes');
    expect(matchingCase.patientName).toBe('Lucia Alves');
  });
});
