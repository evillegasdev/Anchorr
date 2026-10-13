import { PersistentMap } from "./persistentMap.js";

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const correlations = new PersistentMap("request-correlations", RETENTION_MS, {
  validateValue: (value) =>
    value &&
    Number.isSafeInteger(value.tmdbId) &&
    value.tmdbId > 0 &&
    ["movie", "tv"].includes(value.mediaType) &&
    Array.isArray(value.discordUserIds) &&
    value.discordUserIds.every((id) => /^\d{17,20}$/.test(String(id))) &&
    typeof value.updatedAt === "string",
});

function key(tmdbId, mediaType) {
  const id = Number.parseInt(String(tmdbId), 10);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  if (!["movie", "tv"].includes(mediaType)) return null;
  return `${id}-${mediaType}`;
}

export function saveRequestCorrelation({
  tmdbId,
  mediaType,
  requestId = null,
  discordUserIds,
  status,
}) {
  const correlationKey = key(tmdbId, mediaType);
  if (!correlationKey) return null;
  const ids = [...new Set((discordUserIds || []).map(String).filter((id) => /^\d{17,20}$/.test(id)))];
  if (ids.length === 0) return null;
  const existing = correlations.get(correlationKey) || {};
  const value = {
    ...existing,
    tmdbId: Number.parseInt(String(tmdbId), 10),
    mediaType,
    requestId: Number.isSafeInteger(requestId) ? requestId : existing.requestId || null,
    discordUserIds: [...new Set([...(existing.discordUserIds || []), ...ids])],
    status: status || existing.status || "active",
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  correlations.set(correlationKey, value);
  return { ...value };
}

export function getRequestCorrelation(tmdbId, mediaType) {
  const correlationKey = key(tmdbId, mediaType);
  if (!correlationKey) return null;
  const value = correlations.get(correlationKey);
  return value ? { ...value, discordUserIds: [...value.discordUserIds] } : null;
}
