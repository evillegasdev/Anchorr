import { EmbedBuilder } from "discord.js";
import logger from "./utils/logger.js";
import { PersistentMap } from "./utils/persistentMap.js";
import { getUserMappings } from "./utils/userMappingStore.js";
import { getLatestInviteRecordForJellyfinUser } from "./bot/inviteState.js";

const SUPPORTED_TYPES = new Set([
  "MEDIA_PENDING",
  "MEDIA_AUTO_APPROVED",
  "MEDIA_APPROVED",
  "MEDIA_DECLINED",
  "MEDIA_FAILED",
  "MEDIA_AVAILABLE",
]);

const eventDedup = new PersistentMap(
  "seerr-request-events",
  30 * 24 * 60 * 60 * 1000,
  {
    validateValue: (value) =>
      value && typeof value.type === "string" && typeof value.sentAt === "string",
  }
);

function text(value, max = 1000) {
  if (typeof value !== "string") return null;
  const normalized = value.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return normalized ? normalized.slice(0, max) : null;
}

function number(value) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function discordIds(value) {
  const values = Array.isArray(value) ? value : [];
  return [...new Set(values.map(String).filter((id) => /^\d{17,20}$/.test(id)))];
}

function resolveDiscordId(payload) {
  const direct = discordIds(payload.requestedByDiscordIds)[0];
  if (direct) return direct;

  const seerrUserId = number(payload.requestedBySeerrUserId);
  if (seerrUserId) {
    const mapping = getUserMappings().find(
      (item) => Number(item.seerrUserId) === seerrUserId
    );
    if (mapping && /^\d{17,20}$/.test(String(mapping.discordUserId))) {
      return String(mapping.discordUserId);
    }
  }

  const jellyfinUserId = text(payload.requestedByJellyfinUserId, 64);
  if (jellyfinUserId) {
    const record = getLatestInviteRecordForJellyfinUser(jellyfinUserId);
    if (record && /^\d{17,20}$/.test(String(record.discordUserId))) {
      return String(record.discordUserId);
    }
  }

  return null;
}

function eventMetadata(type) {
  const values = {
    MEDIA_PENDING: ["Request pending approval", 0xF1C40F],
    MEDIA_AUTO_APPROVED: ["Request automatically approved", 0x3498DB],
    MEDIA_APPROVED: ["Request approved", 0x2ECC71],
    MEDIA_DECLINED: ["Request declined", 0xE67E22],
    MEDIA_FAILED: ["Request processing failed", 0xE74C3C],
    MEDIA_AVAILABLE: ["Media available", 0x57F287],
  };
  return values[type] || ["Request status updated", 0x5865F2];
}

function dedupKey(payload) {
  return [
    payload.notificationType,
    payload.requestId || "none",
    payload.mediaType || "none",
    payload.tmdbId || "none",
    payload.mediaStatus || "none",
    payload.subject || "none",
  ].join(":");
}

export async function handleSeerrWebhook(payload, client) {
  const notificationType = text(payload?.notificationType, 64);
  if (!notificationType || !SUPPORTED_TYPES.has(notificationType)) {
    logger.info(`[SEERR WEBHOOK] Ignored unsupported event: ${notificationType || "missing"}`);
    return { ignored: true };
  }

  const normalized = {
    notificationType,
    event: text(payload.event, 200),
    subject: text(payload.subject, 256) || "Unknown media",
    message: text(payload.message, 1500),
    image: text(payload.image, 1000),
    requestId: number(payload.requestId),
    requestedBySeerrUserId: number(payload.requestedBySeerrUserId),
    requestedByJellyfinUserId: text(payload.requestedByJellyfinUserId, 64),
    requestedByDiscordIds: discordIds(payload.requestedByDiscordIds),
    mediaType: text(payload.mediaType, 16),
    tmdbId: number(payload.tmdbId),
    mediaStatus: text(payload.mediaStatus, 64),
  };

  const key = dedupKey(normalized);
  if (eventDedup.has(key)) {
    logger.info(`[SEERR WEBHOOK] Duplicate suppressed: ${key}`);
    return { duplicate: true };
  }

  const channelId = process.env.DISCORD_REQUEST_STATUS_CHANNEL_ID;
  if (!channelId) throw new Error("DISCORD_REQUEST_STATUS_CHANNEL_ID is not configured");
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("Request-status channel is not text-capable");

  const requesterId = resolveDiscordId(normalized);
  const [title, color] = eventMetadata(notificationType);
  const detail = normalized.message || normalized.event;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setDescription(normalized.subject)
    .setColor(color)
    .setTimestamp();

  if (detail) embed.addFields({ name: "Detail", value: detail, inline: false });
  if (normalized.mediaType) embed.addFields({ name: "Media type", value: normalized.mediaType, inline: true });
  if (normalized.requestId) embed.addFields({ name: "Request ID", value: String(normalized.requestId), inline: true });
  if (normalized.mediaStatus) embed.addFields({ name: "Media status", value: normalized.mediaStatus, inline: true });
  if (normalized.image && /^https?:\/\//i.test(normalized.image)) embed.setThumbnail(normalized.image);

  const content = requesterId
    ? `<@${requesterId}>`
    : "Request status update";

  await channel.send({
    content,
    embeds: [embed],
    allowedMentions: { users: requesterId ? [requesterId] : [], roles: [] },
  });

  eventDedup.set(key, { type: notificationType, sentAt: new Date().toISOString() });
  logger.info(`[SEERR WEBHOOK] Delivered ${notificationType} request=${normalized.requestId || "unknown"} requester=${requesterId || "unresolved"}`);
  return { delivered: true, requesterId };
}
