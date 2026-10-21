import { PersistentMap } from "../utils/persistentMap.js";
import logger from "../utils/logger.js";

const NEVER_TTL_MS = 100 * 365 * 24 * 60 * 60 * 1000;
const SERIES_GRAB_ROUNDUP_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const map = new PersistentMap("roundup-state", NEVER_TTL_MS, {
  validateValue: (v) =>
    (typeof v === "number" && Number.isFinite(v)) || Array.isArray(v),
});

// PersistentMap prefixes the name with "dedup-", so this writes:
// dedup-series-grab-roundups.json next to config.json.
const seriesGrabRoundups = new PersistentMap(
  "series-grab-roundups",
  SERIES_GRAB_ROUNDUP_TTL_MS,
  {
    validateValue: (value) =>
      value &&
      typeof value === "object" &&
      typeof value.messageId === "string" &&
      typeof value.channelId === "string" &&
      typeof value.createdAt === "string" &&
      typeof value.lastUpdatedAt === "string" &&
      Array.isArray(value.entries),
  }
);

const INSTALLED_AT_KEY = "installedAt";
const LAST_POSTED_AT_KEY = "lastPostedAt";
const FAILURES_KEY = "failures";
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export function getInstalledAt(now = Date.now()) {
  const existing = map.get(INSTALLED_AT_KEY);
  if (typeof existing === "number" && Number.isFinite(existing)) {
    return existing;
  }
  logger.info(
    `roundup-state: stamping installedAt=${new Date(now).toISOString()} (no prior value found)`
  );
  map.set(INSTALLED_AT_KEY, now);
  return now;
}

export function getLastPostedAt() {
  const v = map.get(LAST_POSTED_AT_KEY);
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

export function setLastPostedAt(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return;
  map.set(LAST_POSTED_AT_KEY, ms);
}

export function getFailureCount(now = Date.now()) {
  const list = map.get(FAILURES_KEY);
  if (!Array.isArray(list)) return 0;
  const cutoff = now - WEEK_MS;
  return list.filter((t) => typeof t === "number" && t >= cutoff).length;
}

export function recordFailure(ms = Date.now()) {
  const list = Array.isArray(map.get(FAILURES_KEY))
    ? map.get(FAILURES_KEY)
    : [];
  const cutoff = ms - WEEK_MS;
  const pruned = list.filter((t) => typeof t === "number" && t >= cutoff);
  pruned.push(ms);
  map.set(FAILURES_KEY, pruned);
}

export function getSeriesGrabRoundup(key) {
  return seriesGrabRoundups.get(key) || null;
}

export function setSeriesGrabRoundup(key, value) {
  seriesGrabRoundups.set(key, value, SERIES_GRAB_ROUNDUP_TTL_MS);
}

export function deleteSeriesGrabRoundup(key) {
  seriesGrabRoundups.delete(key);
}

(function migrateLegacyLastPostedAt() {
  // Wrapped: a corrupted PersistentMap or unreadable disk should not crash the
  // bot at import time. Worst case the migration is skipped and the user gets
  // one duplicate roundup, which is recoverable; a boot crash is not.
  try {
    const existing = map.get(LAST_POSTED_AT_KEY);
    if (typeof existing === "number" && Number.isFinite(existing)) return;
    const legacy = process.env.WEEKLY_ROUNDUP_LAST_POSTED_AT;
    if (!legacy) return;
    const parsed = Date.parse(legacy);
    if (!Number.isFinite(parsed)) {
      logger.warn(
        `roundup-state: legacy WEEKLY_ROUNDUP_LAST_POSTED_AT="${legacy}" is not a parseable date; skipping migration (next run may produce a duplicate roundup)`
      );
      return;
    }
    map.set(LAST_POSTED_AT_KEY, parsed);
    logger.info(
      `roundup-state: migrated legacy lastPostedAt=${new Date(parsed).toISOString()} from config`
    );
  } catch (err) {
    logger.error(
      `roundup-state: legacy migration failed: ${err?.message || err}`
    );
  }
})();
