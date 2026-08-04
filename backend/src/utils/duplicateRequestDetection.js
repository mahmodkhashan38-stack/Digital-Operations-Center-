const Request = require('../models/Request');

// DOC-58 - "Duplicate Request Detection". The one shared helper every
// duplicate check goes through - deliberately NOT duplicated inline in
// the controller (task spec: "Create one shared helper. Do not duplicate
// matching logic."). No AI/NLP/embeddings/Elasticsearch - deterministic,
// synchronous string comparison only, exactly as scoped.
//
// ALGORITHM (documented, one deterministic choice - task spec: "Choose
// one documented algorithm"):
//
//   1. Normalize both titles identically: trim, lowercase, strip every
//      character that is not a Unicode letter/number/whitespace
//      (punctuation removed), then collapse any run of whitespace down to
//      a single space and trim again. "Printer  Not Working!!!" and
//      "printer not working" both normalize to "printer not working".
//   2. EXACT - the two normalized titles are identical. Strongest
//      possible signal; always a duplicate.
//   3. CONTAINS - one normalized title is a substring of the other, in
//      EITHER direction ("printer not working" vs "printer not working
//      in room 204" both match each other). Still a very strong signal -
//      one title is essentially the other with extra words appended
//      somewhere.
//   4. OVERLAP - neither of the above, but the two titles' word sets
//      overlap heavily: `matching words / smaller title's distinct word
//      count >= WORD_OVERLAP_THRESHOLD` (0.6, i.e. at least 60% of the
//      SHORTER title's own distinct words also appear in the other
//      title). Deliberately measured against the smaller set (not the
//      union/Jaccard index) - a short, generic-sounding title like
//      "wifi down" should still flag against a longer "wifi down on
//      second floor" without being unfairly diluted by the longer
//      title's extra words; the longer candidate is still an equally
//      strong duplicate signal for the shorter one.
//   5. Anything else - not flagged. This is intentionally conservative
//      (task spec goal: "Prevent accidental duplicate Requests. NOT block
//      legitimate Requests.") - two titles that only share one or two
//      common words ("computer issue" vs "printer issue" - only "issue"
//      in common) fall well below the 0.6 threshold and are correctly
//      left alone.
//
// Only TITLE is compared (task spec: "Compare: title / optionally
// description" - description is explicitly optional, and is left out
// entirely here to keep the one algorithm simple, deterministic, and easy
// to document/test, rather than inventing a second weighted score to
// combine it with).
const ACTIVE_DUPLICATE_STATUSES = ['open', 'in_progress', 'reopened'];
const WORD_OVERLAP_THRESHOLD = 0.6;

// Strips everything except Unicode letters/numbers/whitespace - this is
// what "remove punctuation" means here (task spec's own normalization
// list: trim, lowercase, collapse spaces, remove punctuation). Using the
// Unicode-aware `\p{L}`/`\p{N}` classes (not `[a-z0-9]`) so this behaves
// sensibly for names/titles containing accented or non-Latin characters,
// not just plain ASCII.
function normalizeText(value) {
  return (value || '')
    .toString()
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function wordsOf(normalized) {
  return normalized ? normalized.split(' ').filter(Boolean) : [];
}

// `smaller` is intentionally `Math.min(setA.size, setB.size)`, not the
// union - see this file's own top comment for why.
function wordOverlapRatio(wordsA, wordsB) {
  if (wordsA.length === 0 || wordsB.length === 0) {
    return 0;
  }
  const setA = new Set(wordsA);
  const setB = new Set(wordsB);
  let intersectionCount = 0;
  setA.forEach((word) => {
    if (setB.has(word)) {
      intersectionCount += 1;
    }
  });
  const smaller = Math.min(setA.size, setB.size);
  return smaller === 0 ? 0 : intersectionCount / smaller;
}

// Returns 'exact' | 'contains' | 'overlap' | null. `normalizedNewTitle`/
// `newWords` are precomputed once by the caller and reused across every
// candidate, rather than re-normalizing the NEW Request's own title once
// per candidate compared.
function classifyMatch(normalizedNewTitle, newWords, candidateTitle) {
  const normalizedCandidateTitle = normalizeText(candidateTitle);
  if (!normalizedCandidateTitle || !normalizedNewTitle) {
    return null;
  }
  if (normalizedCandidateTitle === normalizedNewTitle) {
    return 'exact';
  }
  if (normalizedCandidateTitle.includes(normalizedNewTitle) || normalizedNewTitle.includes(normalizedCandidateTitle)) {
    return 'contains';
  }
  const candidateWords = wordsOf(normalizedCandidateTitle);
  if (wordOverlapRatio(newWords, candidateWords) >= WORD_OVERLAP_THRESHOLD) {
    return 'overlap';
  }
  return null;
}

// findDuplicateRequests({ organizationId, categoryId, title }) ->
//   Promise<Array<{ request: RequestDocument, matchType: string }>>
//
// SCOPE (task spec, both enforced at the database query level, never
// filtered client-side afterward):
//   - `organizationId` - only ever searches inside the caller's own
//     Organization, never another one (DOC-38 convention, same as every
//     other Request query in this project).
//   - `categoryId` - only Requests in the exact same Category are ever
//     compared; a Request in a different Category is never considered a
//     duplicate no matter how similar its title is.
//   - `status: { $in: ACTIVE_DUPLICATE_STATUSES }` - only open/
//     in_progress/reopened Requests are candidates; resolved/closed/
//     cancelled ones are completely invisible to this check (task spec:
//     "Ignore: resolved, closed, cancelled").
//
// Called ONLY from createRequest (task spec: "Only during: POST
// /api/requests. Never during edit.") - this file has no notion of
// "exclude this Request's own id" the way an edit-time duplicate check
// would need, on purpose, since it is never used for that.
async function findDuplicateRequests({ organizationId, categoryId, title }) {
  const normalizedNewTitle = normalizeText(title);
  if (!normalizedNewTitle) {
    return [];
  }
  const newWords = wordsOf(normalizedNewTitle);

  const candidates = await Request.find({
    organizationId,
    categoryId,
    status: { $in: ACTIVE_DUPLICATE_STATUSES },
  });

  const matches = [];
  candidates.forEach((candidate) => {
    const matchType = classifyMatch(normalizedNewTitle, newWords, candidate.title);
    if (matchType) {
      matches.push({ request: candidate, matchType });
    }
  });
  return matches;
}

module.exports = {
  findDuplicateRequests,
  normalizeText,
  ACTIVE_DUPLICATE_STATUSES,
  WORD_OVERLAP_THRESHOLD,
};
