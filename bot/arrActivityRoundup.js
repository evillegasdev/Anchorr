import { EmbedBuilder } from "discord.js";
import logger from "../utils/logger.js";
import { PersistentMap } from "../utils/persistentMap.js";

function positiveNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const WINDOW_HOURS = positiveNumber(
  process.env.ARR_SUPERVISOR_ROUNDUP_WINDOW_HOURS,
  24
);
const WINDOW_MS = WINDOW_HOURS * 60 * 60 * 1000;
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 25;

const roundups = new PersistentMap("arr-activity-roundups", STATE_TTL_MS, {
  validateValue: (value) =>
    value &&
    typeof value === "object" &&
    typeof value.messageId === "string" &&
    typeof value.channelId === "string" &&
    typeof value.createdAt === "string" &&
    typeof value.lastUpdatedAt === "string" &&
    Array.isArray(value.entries),
});

function clean(value, max = 1000) {
  if (value == null) return null;
  const result = String(value)
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .trim();
  return result ? result.slice(0, max) : null;
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

function identityKey(event) {
  const identity = event.tmdbId || event.tvdbId || event.localId;
  if (!identity) {
    throw new Error("Arr activity event has no stable media identity");
  }
  return `${event.app}:${event.mediaType}:${identity}`;
}

function makeEntry(event, nowIso) {
  return {
    kind: clean(event.kind, 100) || "Download activity",
    color: Number(event.color) || 0x3498db,
    detail: clean(event.detail, 1000),
    state: clean(event.state, 100),
    status: clean(event.status, 100),
    mediaType: clean(event.mediaType, 50),
    downloadClient: clean(event.downloadClient, 100),
    noProgress: clean(event.noProgress, 100),
    remainingBytes: clean(event.remainingBytes, 100),
    occurredAt: event.occurredAt || nowIso,
  };
}

function subject(state) {
  const title = state.title || "Tracked media";
  return `${title}${state.year ? ` (${state.year})` : ""}`;
}

function entryValue(entry) {
  const lines = [];
  if (entry.detail) lines.push(`**Detail**\n${entry.detail}`);
  if (entry.state) lines.push(`**State**\n${entry.state}`);
  if (entry.status) lines.push(`**Status**\n${entry.status}`);
  if (entry.mediaType) lines.push(`**Media type**\n${entry.mediaType}`);
  if (entry.downloadClient) {
    lines.push(`**Download client**\n${entry.downloadClient}`);
  }
  if (entry.noProgress) lines.push(`**No progress**\n${entry.noProgress}`);
  if (entry.remainingBytes) {
    lines.push(`**Remaining bytes**\n${entry.remainingBytes}`);
  }
  const occurredAt = Date.parse(entry.occurredAt || "");
  if (Number.isFinite(occurredAt)) {
    const seconds = Math.floor(occurredAt / 1000);
    lines.push(`**Occurred**\n<t:${seconds}:F> (<t:${seconds}:R>)`);
  }
  return (lines.join("\n") || "No additional details").slice(0, 1024);
}

function embedFor(state) {
  const appName = state.app === "radarr" ? "Radarr" : "Sonarr";
  const latest = state.entries[state.entries.length - 1];
  const embed = new EmbedBuilder()
    .setTitle(`${appName}: download activity`)
    .setDescription(subject(state))
    .setColor(latest?.color || 0x3498db)
    .setFooter({
      text: `Aggregation window: ${WINDOW_HOURS}h • Activity entries: ${state.entries.length}`,
    });

  state.entries.forEach((entry, index) => {
    embed.addFields({
      name: `Event #${index + 1}: ${entry.kind}`,
      value: entryValue(entry),
      inline: false,
    });
  });
  return embed;
}

export async function recordArrActivity(client, event) {
  const channelId = process.env.DISCORD_REQUEST_STATUS_CHANNEL_ID;
  if (!channelId) {
    throw new Error("DISCORD_REQUEST_STATUS_CHANNEL_ID is not configured");
  }

  const key = identityKey(event);
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const existing = roundups.get(key);
  const createdAtMs = Date.parse(existing?.createdAt || "");
  const withinWindow =
    existing &&
    Number.isFinite(createdAtMs) &&
    now - createdAtMs < WINDOW_MS;
  const requesterIds = validUsers([
    ...(existing?.requesterIds || []),
    ...(event.requesterIds || []),
  ]);

  let state = withinWindow
    ? {
        ...existing,
        title: clean(event.title, 256) || existing.title,
        year: Number(event.year) || existing.year || null,
        requesterIds,
        lastUpdatedAt: nowIso,
        entries: [
          ...existing.entries,
          makeEntry(event, nowIso),
        ].slice(-MAX_ENTRIES),
      }
    : {
        app: event.app,
        mediaType: event.mediaType,
        tmdbId: event.tmdbId || null,
        tvdbId: event.tvdbId || null,
        localId: event.localId || null,
        title: clean(event.title, 256) || "Tracked media",
        year: Number(event.year) || null,
        messageId: "pending",
        channelId,
        requesterIds,
        createdAt: nowIso,
        lastUpdatedAt: nowIso,
        entries: [makeEntry(event, nowIso)],
      };

  const content = requesterIds.length
    ? requesterIds.map((id) => `<@${id}>`).join(" ")
    : `${event.app === "radarr" ? "Radarr" : "Sonarr"} status update`;

  if (withinWindow) {
    try {
      const channel = await client.channels.fetch(state.channelId);
      if (!channel?.isTextBased()) {
        throw new Error("Stored roundup channel is not text-capable");
      }
      const message = await channel.messages.fetch(state.messageId);
      await message.edit({
        content,
        embeds: [embedFor(state)],
        allowedMentions: { users: requesterIds, roles: [] },
      });
      roundups.set(key, state, STATE_TTL_MS);
      logger.info(
        `[ARR ACTIVITY ROUNDUP] Updated ${key} message=${state.messageId} entries=${state.entries.length} window=${WINDOW_HOURS}h`
      );
      return { action: "updated", key, messageId: state.messageId };
    } catch (error) {
      logger.warn(
        `[ARR ACTIVITY ROUNDUP] Unable to edit ${key} message=${state.messageId}; creating replacement: ${error.message}`
      );
      roundups.delete(key);
      state = {
        ...state,
        messageId: "pending",
        channelId,
        createdAt: nowIso,
        lastUpdatedAt: nowIso,
      };
    }
  }

  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) {
    throw new Error("Request-status channel is not text-capable");
  }
  const message = await channel.send({
    content,
    embeds: [embedFor(state)],
    allowedMentions: { users: requesterIds, roles: [] },
  });
  state.messageId = message.id;
  state.channelId = channel.id;
  roundups.set(key, state, STATE_TTL_MS);
  logger.info(
    `[ARR ACTIVITY ROUNDUP] Created ${key} message=${message.id} entries=${state.entries.length} window=${WINDOW_HOURS}h`
  );
  return { action: "created", key, messageId: message.id };
}

export function getArrActivityRoundupWindowHours() {
  return WINDOW_HOURS;
}
