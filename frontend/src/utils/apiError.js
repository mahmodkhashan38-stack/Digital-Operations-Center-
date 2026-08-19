// DOC-69 - "Error & UX Hardening". A small, shared, LAST-LINE-OF-DEFENSE
// helper for turning any thrown value into a safe, human-readable string.
//
// This project's error handling was already largely centralized BEFORE
// this ticket: services/api.js's own `request()` helper already parses
// every backend JSON error response once (`data.message`) and throws a
// real `Error` whose `.message` is already that safe, backend-authored
// string - every existing component that does `catch (error) { setX(error
// .message) }` is therefore already displaying a safe message today, not
// a raw technical one, because the backend itself never sends stack
// traces/driver internals in that field (see backend/src/middleware/
// errorHandler.js). This ticket does NOT duplicate that logic in thirty
// places - it does not exist to replace `error.message`.
//
// What this helper is for instead: the few edges where a caught value is
// NOT guaranteed to already be one of `request()`'s own clean Errors -
// a raw network failure (`fetch()` itself throwing, e.g. offline/DNS/
// connection-refused), a non-Error throw, or any future call site that
// talks to the backend without going through `request()`. Centralizing
// THAT extraction in one place (rather than a ad hoc `error?.message ||
// 'fallback'` at each such call site) is what task spec section 4 asks
// for.
function getApiErrorMessage(error, fallback = 'Something went wrong. Please try again.') {
  if (!error) {
    return fallback;
  }

  // A raw browser network failure - `fetch()` rejects with a `TypeError`
  // whose own message ("Failed to fetch" in Chrome, "NetworkError when
  // attempting to fetch resource" in Firefox, "Load failed" in Safari) is
  // exactly the kind of raw technical string task spec section 13
  // explicitly forbids showing. Every one of these browser-specific
  // strings is itself a `TypeError` with no real HTTP `status` at all
  // (services/api.js's `request()` only ever sets `.status` AFTER a
  // response is actually received) - that absence is what reliably tells
  // this apart from a normal, already-safe backend error.
  if (error instanceof TypeError && error.status === undefined) {
    return 'Unable to connect to the server. Please check your connection and try again.';
  }

  if (typeof error === 'string' && error.trim().length > 0) {
    return error;
  }

  if (error instanceof Error && typeof error.message === 'string' && error.message.trim().length > 0) {
    // Defensive only (task spec section 3's own named examples) - none of
    // this project's OWN thrown errors ever look like this today (see
    // this file's own top comment), but a future/third-party dependency
    // throwing something less disciplined should still never reach the
    // screen verbatim.
    const RAW_TECHNICAL_PATTERNS = [
      /^MongoServerError/i, /^CastError/i, /^AxiosError/i, /ECONNREFUSED/, /^E11000/,
      /\[object Object\]/, /Cannot read propert/i,
    ];
    if (RAW_TECHNICAL_PATTERNS.some((pattern) => pattern.test(error.message))) {
      return fallback;
    }
    return error.message;
  }

  return fallback;
}

export default getApiErrorMessage;
