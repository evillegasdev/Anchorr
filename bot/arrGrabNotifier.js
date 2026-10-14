import { EmbedBuilder } from "discord.js";
import logger from "../utils/logger.js";
import { PersistentMap } from "../utils/persistentMap.js";

const INITIAL_DELAY_MS = 5 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const MAX_RETRIES = 10;
const POLL_MS = 30 * 1000;
const pending = new PersistentMap("arr-grab-notifications", 2 * 24 * 60 * 60 * 1000, {
  validateValue: (value) => value && typeof value.app === "string" && typeof value.dueAt === "number",
});
let timer = null;
let running = false;
let activeClient = null;

function arrTarget(app) {
  return app === "radarr"
    ? { name: "Radarr", base: process.env.RADARR_URL, key: process.env.RADARR_API_KEY }
    : { name: "Sonarr", base: process.env.SONARR_URL, key: process.env.SONARR_API_KEY };
}
function validUsers(values) {
  return [...new Set((values || []).map(String).filter((id) => /^\d{17,20}$/.test(id)))];
}
function formatDuration(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) return value.trim();
  const parts = [];
  const days = Number(match[1] || 0);
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes || parts.length === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}
async function getQueueRows(target) {
  const base = String(target.base || "").replace(/\/+$/, "");
  if (!base || !target.key) throw new Error(`${target.name} API configuration is incomplete`);
  const url = `${base}/api/v3/queue/details?includeUnknownMovieItems=true&includeMovie=true&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true`;
  const response = await fetch(url, { headers: { Accept: "application/json", "X-Api-Key": target.key } });
  if (!response.ok) throw new Error(`${target.name} queue returned ${response.status}`);
  const body = await response.json();
  return Array.isArray(body) ? body : body?.records || [];
}
async function apiJson(target, path) {
  const base = String(target.base || "").replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json", "X-Api-Key": target.key },
  });
  if (!response.ok) throw new Error(`${target.name} ${path} returned ${response.status}`);
  return response.json();
}
function findQueueRow(rows, item) {
  return rows.find((row) => {
    if (item.app === "radarr" && item.localId) return Number(row.movieId) === Number(item.localId);
    if (item.app === "sonarr" && item.localId) return Number(row.seriesId) === Number(item.localId);
    if (item.downloadId) return String(row.downloadId || "").toLowerCase() === String(item.downloadId).toLowerCase();
    return false;
  }) || null;
}
async function alreadyCompleted(target, item) {
  if (!item.localId) return false;
  if (item.app === "radarr") {
    const movie = await apiJson(target, `/api/v3/movie/${encodeURIComponent(item.localId)}`);
    if (movie?.hasFile === true) return true;
    const history = await apiJson(target, `/api/v3/history/movie?movieId=${encodeURIComponent(item.localId)}`);
    const rows = Array.isArray(history) ? history : history?.records || [];
    return rows.some((entry) =>
      entry?.eventType === "downloadFolderImported" &&
      Date.parse(entry?.date || "") >= Date.parse(item.createdAt || "")
    );
  }
  const history = await apiJson(target, "/api/v3/history?page=1&pageSize=100&sortKey=date&sortDirection=descending");
  const rows = Array.isArray(history) ? history : history?.records || [];
  return rows.some((entry) =>
    Number(entry?.seriesId) === Number(item.localId) &&
    ["downloadFolderImported", "episodeFileImported"].includes(entry?.eventType) &&
    Date.parse(entry?.date || "") >= Date.parse(item.createdAt || "")
  );
}
function estimateFields(row) {
  const fields = [];
  const timestamp = Date.parse(row?.estimatedCompletionTime || "");
  if (Number.isFinite(timestamp)) {
    const seconds = Math.floor(timestamp / 1000);
    fields.push({ name: "Estimated completion", value: `<t:${seconds}:F> (<t:${seconds}:R>)`, inline: false });
  }
  const remaining = formatDuration(row?.timeleft);
  if (remaining) fields.push({ name: "Estimated time remaining", value: remaining, inline: true });
  return fields;
}
async function deliver(client, key, item, row) {
  const channelId = process.env.DISCORD_REQUEST_STATUS_CHANNEL_ID;
  if (!channelId) throw new Error("DISCORD_REQUEST_STATUS_CHANNEL_ID is not configured");
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("Request-status channel is not text-capable");
  const requesterIds = validUsers(item.requesterIds);
  const appName = item.app === "radarr" ? "Radarr" : "Sonarr";
  const subject = item.title ? `${item.title}${item.year ? ` (${item.year})` : ""}` : "Arr download";
  const embed = new EmbedBuilder()
    .setTitle(`${appName}: download grabbed`)
    .setDescription(subject)
    .setColor(0x3498DB)
    .setTimestamp();
  if (item.releaseTitle) embed.addFields({ name: "Release", value: item.releaseTitle.slice(0, 1000), inline: false });
  const fields = estimateFields(row);
  if (fields.length) embed.addFields(fields);
  else embed.addFields({ name: "Estimated completion", value: "Not available yet", inline: false });
  if (item.downloadClient || row?.downloadClient) {
    embed.addFields({ name: "Download client", value: String(item.downloadClient || row.downloadClient).slice(0, 100), inline: true });
  }
  await channel.send({
    content: requesterIds.length ? requesterIds.map((id) => `<@${id}>`).join(" ") : `${appName} status update`,
    embeds: [embed],
    allowedMentions: { users: requesterIds, roles: [] },
  });
  pending.delete(key);
  logger.info(`[ARR GRAB] Delivered delayed ${item.app} Grab media=${item.tmdbId || item.tvdbId || "unknown"} requesters=${requesterIds.length} etr=${fields.length ? "available" : "unavailable"}`);
}
async function processItem(client, key, item) {
  if (Date.now() < item.dueAt) return;
  const target = arrTarget(item.app);
  const row = findQueueRow(await getQueueRows(target), item);
  if (await alreadyCompleted(target, item)) {
    pending.delete(key);
    logger.info(`[ARR GRAB] Suppressed delayed ${item.app} Grab for ${key}; media already imported`);
    return;
  }
  const hasEstimate = Boolean(row?.estimatedCompletionTime || row?.timeleft);
  const attempts = Number(item.attempts || 0);
  if (!row && attempts >= 1) {
    pending.delete(key);
    logger.info(`[ARR GRAB] Suppressed delayed ${item.app} Grab for ${key}; queue item no longer exists`);
    return;
  }
  if (!hasEstimate && attempts < MAX_RETRIES) {
    pending.set(key, { ...item, attempts: attempts + 1, dueAt: Date.now() + RETRY_MS, updatedAt: new Date().toISOString() });
    logger.info(`[ARR GRAB] ETR unavailable for ${key}; retry ${attempts + 1}/${MAX_RETRIES}`);
    return;
  }
  await deliver(client, key, item, row);
}
async function tick() {
  if (running || !activeClient) return;
  running = true;
  try {
    for (const key of pending.keys()) {
      const item = pending.get(key);
      if (!item) continue;
      try { await processItem(activeClient, key, item); }
      catch (error) { logger.warn(`[ARR GRAB] ${key}: ${error.message}`); }
    }
  } finally {
    running = false;
  }
}
export function queueDelayedGrab(item) {
  if (pending.has(item.dedupKey)) return false;
  pending.set(item.dedupKey, {
    ...item,
    requesterIds: validUsers(item.requesterIds),
    attempts: 0,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    dueAt: Date.now() + INITIAL_DELAY_MS,
  });
  logger.info(`[ARR GRAB] Queued delayed ${item.app} Grab key=${item.dedupKey} dueIn=5m`);
  return true;
}
export function startArrGrabNotifier(client) {
  activeClient = client;
  if (timer) clearInterval(timer);
  timer = setInterval(() => void tick().catch((error) => logger.error(`[ARR GRAB] Poll failed: ${error.message}`)), POLL_MS);
  timer.unref?.();
  setTimeout(() => void tick().catch((error) => logger.error(`[ARR GRAB] Initial poll failed: ${error.message}`)), 5000).unref?.();
  logger.info(`[ARR GRAB] Delayed notifier started with 5m delay and ${MAX_RETRIES} ETR retries`);
}
