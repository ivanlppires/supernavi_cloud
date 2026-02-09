/**
 * Matching heuristic for PathoWeb case-slide association.
 *
 * Calculates a score (0..1) for how well a slide matches a given case base.
 */

/**
 * Normalize a string: uppercase, remove separators and whitespace.
 */
function normalize(str: string): string {
  return str.toUpperCase().replace(/[\s\-_.]/g, '');
}

/**
 * Apply common OCR/handwriting confusion substitutions.
 * O <-> 0, I <-> 1
 */
function applyConfusionMap(str: string): string {
  return str
    .replace(/O/g, '0')
    .replace(/I/g, '1');
}

export interface MatchableSlide {
  externalCaseBase: string | null;
  externalCaseId: string | null;
  svsFilename: string;
}

/**
 * Calculate matching score between a case base and a slide.
 *
 * Scoring:
 *   1.00: externalCaseBase matches exactly (deterministic link)
 *   0.92: slide filename digits match caseBase digits (without AP prefix)
 *   0.88: match with O/0 and I/1 confusion tolerance
 *   < 0.85: not a candidate
 */
export function calculateMatchScore(
  caseBase: string,
  slide: MatchableSlide
): number {
  const normalizedQuery = normalize(caseBase);

  // 1.0: exact match on externalCaseBase
  if (slide.externalCaseBase) {
    const normalizedBase = normalize(slide.externalCaseBase);
    if (normalizedBase === normalizedQuery) return 1.0;
  }

  // Check filename-based matching
  const normalizedFilename = normalize(
    slide.svsFilename.replace(/\.[^/.]+$/, '') // remove extension
  );

  // 0.95: filename starts with the full case base
  if (normalizedFilename.startsWith(normalizedQuery)) return 0.95;

  // 0.92: digit-only match (strip AP prefix)
  const queryDigits = normalizedQuery.replace(/^AP/, '');
  if (queryDigits.length >= 6) {
    const filenameDigitsOnly = normalizedFilename.replace(/[^0-9]/g, '');
    if (filenameDigitsOnly.startsWith(queryDigits)) return 0.92;
  }

  // 0.88: confusion-tolerant match (O/0, I/1)
  const confusedQuery = applyConfusionMap(normalizedQuery);
  const confusedFilename = applyConfusionMap(normalizedFilename);
  if (confusedFilename.startsWith(confusedQuery)) return 0.88;

  return 0;
}

/**
 * Filter and score slides against a case base.
 * Returns only candidates with score >= minScore, sorted by score desc.
 */
export function findCandidates(
  caseBase: string,
  slides: MatchableSlide[],
  minScore = 0.85
): Array<MatchableSlide & { score: number }> {
  return slides
    .map(slide => ({ ...slide, score: calculateMatchScore(caseBase, slide) }))
    .filter(s => s.score >= minScore)
    .sort((a, b) => b.score - a.score);
}
