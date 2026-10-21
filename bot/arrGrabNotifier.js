import { EmbedBuilder } from "discord.js";
import logger from "../utils/logger.js";
import { PersistentMap } from "../utils/persistentMap.js";
import {
  deleteSeriesGrabRoundup,
  getSeriesGrabRoundup,
  setSeriesGrabRoundup,
} from "./roundupState.js";

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function envBoolean(value, fallback = true) {
  if (value == null || String(value).trim() === "") return fallback;
  return !["0", "false", "no", "off"].includes(
    String(value).trim().toLowerCase()
  );
}

const INITIAL_DELAY_MINUTES = positiveNumber(
  process.env.ARR_GRAB_NOTIFICATION_DELAY_MINUTES,
  10
);
const INITIAL_DELAY_MS = INITIAL_DELAY_MINUTES * 60 * 1000;
const SERIES_GRAB_ROUNDUP_WINDOW_HOURS = positiveNumber(
  process.env.SERIES_GRAB_ROUNDUP_WINDOW_HOURS,
  4
);
const SERIES_GRAB_ROUNDUP_WINDOW_MS =
  SERIES_GRAB_ROUNDUP_WINDOW_HOURS * 60 * 60 * 1000;
const SERIES_GRAB_ROUNDUP_ENABLED = envBoolean(
  process.env.SERIES_GRAB_ROUNDUP_ENABLED,
  true
);

const RETRY_MS = 60 * 1000;
const MAX_RETRIES = 10;
const POLL_MS = 30 * 1000;
const MAX_ROUNDUP_ENTRIES = 25;

const pending = new PersistentMap(
  "arr-grab-notifications",
  2 * 24 * 60 * 60 * 1000,
  {
    validateValue: (value) =>
      value &&
      typeof value.app === "string" &&
      typeof value.dueAt === "number",
  }
);

let timer = null;
let running = false;
let activeClient = null;

function arrTarget(app) {
  return app === "radarr"
    ? {
        name: "Radarr",
        base: process.env.RADARR_URL,
        key: process.env.RADARR_API_KEY,
      }
    : {
        name: "Sonarr",
        base: process.env.SONARR_URL,
        key: process.env.SONARR_API_KEY,
      };
}

function validUsers(values) {
  return [
    ...new Set(
      (values || [])
        .map(String)
        .filter((id) => /^\d{17,20}$/.test(id))
    ),
  ];
}

function formatDuration(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const match = /^(?:(\d+)\.)?(\d{1,2}):(\d{2}):(\d{2})$/.exec(
    value.trim()
  );
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
  if (!base || !target.key) {
    throw new Error(`${target.name} API configuration is incomplete`);
  }
  const url = `${base}/api/v3/queue/details?includeUnknownMovieItems=true&includeMovie=true&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true`;
  const response = await fetch(url, {
    headers: { Accept: "application/json", "X-Api-Key": target.key },
  });
  if (!response.ok) {
    throw new Error(`${target.name} queue returned ${response.status}`);
  }
  const body = await response.json();
  return Array.isArray(body) ? body : body?.records || [];
}

async function apiJson(target, path) {
  const base = String(target.base || "").replace(/\/+$/, "");
  const response = await fetch(`${base}${path}`, {
    headers: { Accept: "application/json", "X-Api-Key": target.key },
  });
  if (!response.ok) {
    throw new Error(`${target.name} ${path} returned ${response.status}`);
  }
  return response.json();
}

function findQueueRow(rows, item) {
  return (
    rows.find((row) => {
      // Preserve Radarr's existing movie-first queue matching exactly.
      if (item.app === "radarr" && item.localId) {
        return Number(row.movieId) === Number(item.localId);
      }
      // Sonarr roundups need the queue row for this exact grabbed release.
      if (item.downloadId) {
        return (
          String(row.downloadId || "").toLowerCase() ===
          String(item.downloadId).toLowerCase()
        );
      }
      if (item.app === "sonarr" && item.localId) {
        return Number(row.seriesId) === Number(item.localId);
      }
      return false;
    }) || null
  );
}

function normalizedId(value) {
  return String(value || "").trim().toLowerCase();
}

function positiveIntegerSet(values) {
  return new Set(
    (values || [])
      .map((value) => Number.parseInt(String(value), 10))
      .filter((value) => Number.isSafeInteger(value) && value > 0)
  );
}

function historyDownloadId(entry) {
  return normalizedId(
    entry?.downloadId ||
      entry?.data?.downloadId ||
      entry?.data?.downloadClientId
  );
}

function historyEpisodeId(entry) {
  const value = Number.parseInt(
    String(entry?.episodeId || entry?.episode?.id || entry?.data?.episodeId),
    10
  );
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function isSonarrImport(entry, item, createdAtMs) {
  return (
    Number(entry?.seriesId) === Number(item.localId) &&
    ["downloadFolderImported", "episodeFileImported"].includes(
      entry?.eventType
    ) &&
    Number.isFinite(Date.parse(entry?.date || "")) &&
    Date.parse(entry?.date || "") >= createdAtMs
  );
}

function sonarrImportMatchesGrab(rows, item) {
  const createdAtMs = Date.parse(item.createdAt || "");
  if (!Number.isFinite(createdAtMs)) return false;

  const imports = rows.filter((entry) =>
    isSonarrImport(entry, item, createdAtMs)
  );
  if (!imports.length) return false;

  // 1. Strongest identity: the exact Sonarr download ID from the Grab webhook.
  const wantedDownloadId = normalizedId(item.downloadId);
  if (
    wantedDownloadId &&
    imports.some((entry) => historyDownloadId(entry) === wantedDownloadId)
  ) {
    return true;
  }

  // 2. If the Grab supplied episode IDs, suppress only after every grabbed
  // episode has an import event. One imported episode/season cannot suppress
  // different pending downloads for the same series.
  const wantedEpisodeIds = positiveIntegerSet(item.episodeIds);
  if (wantedEpisodeIds.size > 0) {
    const importedEpisodeIds = new Set(
      imports.map(historyEpisodeId).filter(Boolean)
    );
    return [...wantedEpisodeIds].every((id) =>
      importedEpisodeIds.has(id)
    );
  }

  // No exact download or episode identity means the import cannot safely be
  // attributed to this Grab. Never fall back to seriesId alone.
  return false;
}

async function alreadyCompleted(target, item) {
  if (!item.localId) return false;
  if (item.app === "radarr") {
    const movie = await apiJson(
      target,
      `/api/v3/movie/${encodeURIComponent(item.localId)}`
    );
    if (movie?.hasFile === true) return true;
    const history = await apiJson(
      target,
      `/api/v3/history/movie?movieId=${encodeURIComponent(item.localId)}`
    );
    const rows = Array.isArray(history) ? history : history?.records || [];
    return rows.some(
      (entry) =>
        entry?.eventType === "downloadFolderImported" &&
        Date.parse(entry?.date || "") >= Date.parse(item.createdAt || "")
    );
  }

  const history = await apiJson(
    target,
    "/api/v3/history?page=1&pageSize=100&sortKey=date&sortDirection=descending"
  );
  const rows = Array.isArray(history) ? history : history?.records || [];
  return sonarrImportMatchesGrab(rows, item);
}

function estimateFields(row) {
  const fields = [];
  const timestamp = Date.parse(row?.estimatedCompletionTime || "");
  if (Number.isFinite(timestamp)) {
    const seconds = Math.floor(timestamp / 1000);
    fields.push({
      name: "Estimated completion",
      value: `<t:${seconds}:F> (<t:${seconds}:R>)`,
      inline: false,
    });
  }
  const remaining = formatDuration(row?.timeleft);
  if (remaining) {
    fields.push({
      name: "Estimated time remaining",
      value: remaining,
      inline: true,
    });
  }
  return fields;
}

function subjectFor(item) {
  return item.title
    ? `${item.title}${item.year ? ` (${item.year})` : ""}`
    : "Arr download";
}

function roundupKey(item) {
  if (item.tmdbId) return `sonarr:${item.tmdbId}`;
  if (item.tvdbId) return `sonarr:${item.tvdbId}`;
  return null;
}

function roundupEntryKey(item) {
  return `${item.releaseTitle || ""}${item.downloadId || ""}`;
}

function makeRoundupEntry(item, row) {
  const estimatedCompletionTime = Number.isFinite(
    Date.parse(row?.estimatedCompletionTime || "")
  )
    ? row.estimatedCompletionTime
    : null;

  return {
    key: roundupEntryKey(item),
    releaseTitle: String(item.releaseTitle || "Unknown release").slice(0, 1000),
    downloadId: item.downloadId || null,
    estimatedCompletionTime,
    timeleft: formatDuration(row?.timeleft) || null,
    downloadClient: String(
      item.downloadClient || row?.downloadClient || "Not available"
    ).slice(0, 100),
    requesterIds: validUsers(item.requesterIds),
    updatedAt: new Date().toISOString(),
  };
}

function mergeRoundupEntry(entries, entry) {
  const next = Array.isArray(entries) ? [...entries] : [];
  const index = next.findIndex((value) => value?.key === entry.key);
  if (index >= 0) next[index] = { ...next[index], ...entry };
  else next.push(entry);
  return next.slice(-MAX_ROUNDUP_ENTRIES);
}

function requesterIdsForRoundup(state) {
  return validUsers(
    (state.entries || []).flatMap((entry) => entry.requesterIds || [])
  );
}

function roundupEmbed(item, state) {
  const lastUpdatedSeconds = Math.floor(
    Date.parse(state.lastUpdatedAt) / 1000
  );
  const description = [
    subjectFor(item),
    "",
    `Last updated <t:${lastUpdatedSeconds}:R>`,
  ].join("\n");

  const embed = new EmbedBuilder()
    .setTitle("Sonarr: downloads grabbed")
    .setDescription(description)
    .setColor(0x3498db)
    .setFooter({
      text: `Aggregation window: ${SERIES_GRAB_ROUNDUP_WINDOW_HOURS}h • Grab entries: ${state.entries.length}`,
    });

  state.entries.forEach((entry, index) => {
    const completionMs = Date.parse(entry.estimatedCompletionTime || "");
    const completion = Number.isFinite(completionMs)
      ? `<t:${Math.floor(completionMs / 1000)}:F> (<t:${Math.floor(
          completionMs / 1000
        )}:R>)`
      : "Not available yet";
    const remaining = entry.timeleft || "Not available yet";
    const value = [
      entry.releaseTitle,
      "",
      "**Estimated completion**",
      completion,
      "**Estimated time remaining**",
      remaining,
      "**Download client**",
      entry.downloadClient || "Not available",
    ]
      .join("\n")
      .slice(0, 1024);

    embed.addFields({
      name: `Release #${index + 1}`,
      value,
      inline: false,
    });
  });

  return embed;
}

async function sendOrEditSeriesRoundup(client, item, row) {
  const key = roundupKey(item);
  if (!key) {
    logger.warn(
      `[ARR GRAB ROUNDUP] Sonarr Grab has no TMDb or TVDb ID; falling back to individual notification key=${item.dedupKey}`
    );
    return false;
  }

  const configuredChannelId = process.env.DISCORD_REQUEST_STATUS_CHANNEL_ID;
  if (!configuredChannelId) {
    throw new Error("DISCORD_REQUEST_STATUS_CHANNEL_ID is not configured");
  }

  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const entry = makeRoundupEntry(item, row);
  const existing = getSeriesGrabRoundup(key);
  const createdAtMs = Date.parse(existing?.createdAt || "");
  const withinWindow =
    existing &&
    Number.isFinite(createdAtMs) &&
    now - createdAtMs < SERIES_GRAB_ROUNDUP_WINDOW_MS;

  let state = withinWindow
    ? {
        ...existing,
        entries: mergeRoundupEntry(existing.entries, entry),
        lastUpdatedAt: nowIso,
      }
    : {
        messageId: "pending",
        channelId: configuredChannelId,
        createdAt: nowIso,
        lastUpdatedAt: nowIso,
        entries: [entry],
      };

  const requesterIds = requesterIdsForRoundup(state);
  const content = requesterIds.length
    ? requesterIds.map((id) => `<@${id}>`).join(" ")
    : "Sonarr status update";

  if (withinWindow) {
    try {
      const channel = await client.channels.fetch(state.channelId);
      if (!channel?.isTextBased()) {
        throw new Error("Stored roundup channel is not text-capable");
      }
      const message = await channel.messages.fetch(state.messageId);
      await message.edit({
        content,
        embeds: [roundupEmbed(item, state)],
        allowedMentions: { users: requesterIds, roles: [] },
      });
      setSeriesGrabRoundup(key, state);
      logger.info(
        `[ARR GRAB ROUNDUP] Updated ${key} message=${state.messageId} entries=${state.entries.length} window=${SERIES_GRAB_ROUNDUP_WINDOW_HOURS}h`
      );
      return true;
    } catch (error) {
      logger.warn(
        `[ARR GRAB ROUNDUP] Unable to edit stored ${key} message=${state.messageId}; creating replacement: ${error.message}`
      );
      deleteSeriesGrabRoundup(key);
      state = {
        messageId: "pending",
        channelId: configuredChannelId,
        createdAt: nowIso,
        lastUpdatedAt: nowIso,
        entries: state.entries,
      };
    }
  }

  const channel = await client.channels.fetch(configuredChannelId);
  if (!channel?.isTextBased()) {
    throw new Error("Request-status channel is not text-capable");
  }
  const message = await channel.send({
    content,
    embeds: [roundupEmbed(item, state)],
    allowedMentions: { users: requesterIds, roles: [] },
  });
  state.messageId = message.id;
  state.channelId = channel.id;
  setSeriesGrabRoundup(key, state);
  logger.info(
    `[ARR GRAB ROUNDUP] Created ${key} message=${state.messageId} entries=${state.entries.length} window=${SERIES_GRAB_ROUNDUP_WINDOW_HOURS}h`
  );
  return true;
}

async function deliverIndividual(client, key, item, row) {
  const channelId = process.env.DISCORD_REQUEST_STATUS_CHANNEL_ID;
  if (!channelId) {
    throw new Error("DISCORD_REQUEST_STATUS_CHANNEL_ID is not configured");
  }
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) {
    throw new Error("Request-status channel is not text-capable");
  }

  const requesterIds = validUsers(item.requesterIds);
  const appName = item.app === "radarr" ? "Radarr" : "Sonarr";
  const embed = new EmbedBuilder()
    .setTitle(`${appName}: download grabbed`)
    .setDescription(subjectFor(item))
    .setColor(0x3498db)
    .setTimestamp();

  if (item.releaseTitle) {
    embed.addFields({
      name: "Release",
      value: item.releaseTitle.slice(0, 1000),
      inline: false,
    });
  }

  const fields = estimateFields(row);
  if (fields.length) embed.addFields(fields);
  else {
    embed.addFields({
      name: "Estimated completion",
      value: "Not available yet",
      inline: false,
    });
  }

  if (item.downloadClient || row?.downloadClient) {
    embed.addFields({
      name: "Download client",
      value: String(item.downloadClient || row.downloadClient).slice(0, 100),
      inline: true,
    });
  }

  await channel.send({
    content: requesterIds.length
      ? requesterIds.map((id) => `<@${id}>`).join(" ")
      : `${appName} status update`,
    embeds: [embed],
    allowedMentions: { users: requesterIds, roles: [] },
  });

  pending.delete(key);
  logger.info(
    `[ARR GRAB] Delivered delayed ${item.app} Grab media=${
      item.tmdbId || item.tvdbId || "unknown"
    } requesters=${requesterIds.length} etr=${
      fields.length ? "available" : "unavailable"
    }`
  );
}

async function deliver(client, key, item, row) {
  if (item.app === "sonarr" && SERIES_GRAB_ROUNDUP_ENABLED) {
    const delivered = await sendOrEditSeriesRoundup(client, item, row);
    if (delivered) {
      pending.delete(key);
      return;
    }
  }
  await deliverIndividual(client, key, item, row);
}

async function processItem(client, key, item) {
  if (Date.now() < item.dueAt) return;

  const target = arrTarget(item.app);
  const row = findQueueRow(await getQueueRows(target), item);

  if (await alreadyCompleted(target, item)) {
    pending.delete(key);
    logger.info(
      `[ARR GRAB] Suppressed delayed ${item.app} Grab for ${key}; media already imported`
    );
    return;
  }

  const hasEstimate = Boolean(
    row?.estimatedCompletionTime || row?.timeleft
  );
  const attempts = Number(item.attempts || 0);

  if (!row && attempts >= 1) {
    pending.delete(key);
    logger.info(
      `[ARR GRAB] Suppressed delayed ${item.app} Grab for ${key}; queue item no longer exists`
    );
    return;
  }

  if (!hasEstimate && attempts < MAX_RETRIES) {
    pending.set(key, {
      ...item,
      attempts: attempts + 1,
      dueAt: Date.now() + RETRY_MS,
      updatedAt: new Date().toISOString(),
    });
    logger.info(
      `[ARR GRAB] ETR unavailable for ${key}; retry ${attempts + 1}/${MAX_RETRIES}`
    );
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
      try {
        await processItem(activeClient, key, item);
      } catch (error) {
        logger.warn(`[ARR GRAB] ${key}: ${error.message}`);
      }
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
  logger.info(
    `[ARR GRAB] Queued delayed ${item.app} Grab key=${item.dedupKey} dueIn=${INITIAL_DELAY_MINUTES}m roundup=${
      item.app === "sonarr" ? SERIES_GRAB_ROUNDUP_ENABLED : "ignored-for-radarr"
    }`
  );
  return true;
}

export function startArrGrabNotifier(client) {
  activeClient = client;
  if (timer) clearInterval(timer);
  timer = setInterval(
    () =>
      void tick().catch((error) =>
        logger.error(`[ARR GRAB] Poll failed: ${error.message}`)
      ),
    POLL_MS
  );
  timer.unref?.();
  setTimeout(
    () =>
      void tick().catch((error) =>
        logger.error(`[ARR GRAB] Initial poll failed: ${error.message}`)
      ),
    5000
  ).unref?.();
  logger.info(
    `[ARR GRAB] Delayed notifier started delay=${INITIAL_DELAY_MINUTES}m retries=${MAX_RETRIES} sonarrRoundup=${SERIES_GRAB_ROUNDUP_ENABLED} roundupWindow=${SERIES_GRAB_ROUNDUP_WINDOW_HOURS}h`
  );
}
