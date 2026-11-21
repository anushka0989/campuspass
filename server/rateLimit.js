// Tiny in-memory limiter for FAILED logins only (per IP + email).
// Successful logins never count, so test suites and normal use are unaffected.

const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 10;
const failures = new Map(); // key -> { count, first }

const keyOf = (req, email) => `${req.ip}|${email}`;

function isLocked(req, email) {
  const k = keyOf(req, email);
  const entry = failures.get(k);
  if (!entry) return false;
  if (Date.now() - entry.first > WINDOW_MS) {
    failures.delete(k);
    return false;
  }
  return entry.count >= MAX_FAILURES;
}

function recordFailure(req, email) {
  const k = keyOf(req, email);
  const entry = failures.get(k);
  if (!entry || Date.now() - entry.first > WINDOW_MS) failures.set(k, { count: 1, first: Date.now() });
  else entry.count += 1;
}

function clearFailures(req, email) {
  failures.delete(keyOf(req, email));
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of failures) if (now - v.first > WINDOW_MS) failures.delete(k);
}, 5 * 60 * 1000).unref();

module.exports = { isLocked, recordFailure, clearFailures };
