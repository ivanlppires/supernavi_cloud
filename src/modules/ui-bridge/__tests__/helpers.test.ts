import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  normalizeCaseBase,
  toExternalCaseId,
  signThumbUrl,
  verifyThumbSignature,
  findOrCreateCase,
  linkSiblingSlides,
} from '../helpers.js';

// ============================================================================
// Pure helpers
// ============================================================================

describe('normalizeCaseBase', () => {
  it('strips pathoweb: prefix', () => {
    expect(normalizeCaseBase('pathoweb:AP26000299')).toBe('AP26000299');
  });

  it('uppercases input', () => {
    expect(normalizeCaseBase('ap26000299')).toBe('AP26000299');
  });

  it('handles pathoweb: prefix with lowercase', () => {
    expect(normalizeCaseBase('pathoweb:ap26000299')).toBe('AP26000299');
  });
});

describe('toExternalCaseId', () => {
  it('prepends pathoweb: prefix', () => {
    expect(toExternalCaseId('AP26000299')).toBe('pathoweb:AP26000299');
  });
});

const TEST_SECRET = 'test-thumb-secret-for-unit-tests';

describe('signThumbUrl / verifyThumbSignature', () => {
  it('produces a valid round-trip signature', () => {
    const slideId = 'abc123def456';
    const url = signThumbUrl(slideId, TEST_SECRET, 300);

    // Extract exp and sig from URL
    const urlObj = new URL(url, 'http://localhost');
    const exp = urlObj.searchParams.get('exp')!;
    const sig = urlObj.searchParams.get('sig')!;

    expect(verifyThumbSignature(slideId, exp, sig, TEST_SECRET)).toBe(true);
  });

  it('rejects tampered signature', () => {
    const slideId = 'abc123def456';
    const url = signThumbUrl(slideId, TEST_SECRET, 300);

    const urlObj = new URL(url, 'http://localhost');
    const exp = urlObj.searchParams.get('exp')!;

    // Tamper with signature
    expect(verifyThumbSignature(slideId, exp, 'deadbeef'.repeat(8), TEST_SECRET)).toBe(false);
  });
});

// ============================================================================
// DB helpers (mocked Prisma)
// ============================================================================

function createMockPrisma() {
  return {
    caseRead: {
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    slideRead: {
      updateMany: vi.fn(),
    },
  } as any;
}

describe('findOrCreateCase', () => {
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
  });

  it('creates with deterministic ID when case does not exist', async () => {
    mockPrisma.caseRead.findFirst.mockResolvedValue(null);
    mockPrisma.caseRead.create.mockResolvedValue({
      caseId: 'pathoweb-ap26000299',
      patientRef: 'AP26000299',
      title: 'João Silva',
    });

    const result = await findOrCreateCase(mockPrisma, {
      caseBase: 'AP26000299',
      patientData: { patientName: 'João Silva', age: '65', doctor: 'Dr. Santos' },
      ownerId: 'user-1',
    });

    expect(mockPrisma.caseRead.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          caseId: 'pathoweb-ap26000299',
          title: 'João Silva',
          patientRef: 'AP26000299',
          patientAge: 65,
          doctor: 'Dr. Santos',
          ownerId: 'user-1',
          status: 'active',
        }),
      }),
    );
    expect(result.caseId).toBe('pathoweb-ap26000299');
  });

  it('reuses existing case by patientRef (no create)', async () => {
    const existingCase = {
      caseId: 'pathoweb-ap26000299',
      patientRef: 'AP26000299',
      title: 'Old Name',
      ownerId: 'user-1',
    };
    mockPrisma.caseRead.findFirst.mockResolvedValue(existingCase);
    mockPrisma.caseRead.update.mockResolvedValue(existingCase);

    const result = await findOrCreateCase(mockPrisma, {
      caseBase: 'AP26000299',
      patientData: { patientName: 'New Name' },
      ownerId: 'user-1',
    });

    expect(mockPrisma.caseRead.create).not.toHaveBeenCalled();
    expect(mockPrisma.caseRead.update).toHaveBeenCalled();
    expect(result.caseId).toBe('pathoweb-ap26000299');
  });
});

describe('linkSiblingSlides', () => {
  it('updates slides with null caseId matching externalCaseBase', async () => {
    const mockPrisma = createMockPrisma();
    mockPrisma.slideRead.updateMany.mockResolvedValue({ count: 3 });

    const result = await linkSiblingSlides(mockPrisma, {
      caseBase: 'AP26000299',
      caseId: 'pathoweb-ap26000299',
    });

    expect(mockPrisma.slideRead.updateMany).toHaveBeenCalledWith({
      where: { externalCaseBase: 'AP26000299', caseId: null },
      data: { caseId: 'pathoweb-ap26000299' },
    });
    expect(result.count).toBe(3);
  });
});
