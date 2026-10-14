import crypto from "crypto";
import fs from "fs";
import path from "path";
import { CONFIG_PATH } from "../utils/configFile.js";

export const INVITE_STATE_PATH = path.join(path.dirname(CONFIG_PATH), "invite-reconciliation.json");
let records = [];

function validate(record) {
  return record && typeof record.id === "string" && Number.isSafeInteger(record.invitationId) &&
    typeof record.discordUserId === "string" && typeof record.guildId === "string";
}

function load() {
  if (!fs.existsSync(INVITE_STATE_PATH)) return;
  try {
    const parsed = JSON.parse(fs.readFileSync(INVITE_STATE_PATH, "utf8"));
    if (!Array.isArray(parsed)) throw new Error("state is not an array");
    records = parsed.filter(validate);
  } catch (error) {
    const destination = `${INVITE_STATE_PATH}.corrupt-${Date.now()}`;
    try { fs.renameSync(INVITE_STATE_PATH, destination); } catch (_) {}
    records = [];
    throw new Error(`Invite reconciliation state could not be loaded: ${error.message}`);
  }
}

function save() {
  const directory = path.dirname(INVITE_STATE_PATH);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = `${INVITE_STATE_PATH}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(records, null, 2), { encoding: "utf8", mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, INVITE_STATE_PATH);
}

load();

export function hasActiveInviteForDiscordUser(discordUserId) {
  return records.some((record) => record.discordUserId === discordUserId &&
    ["pending", "processing", "waiting_identity"].includes(record.status));
}

export function createInviteRecord({ invitationId, discordUserId, discordDisplayName, guildId, sourceChannelId }) {
  if (hasActiveInviteForDiscordUser(discordUserId)) throw new Error("Discord user already has an active invitation");
  const record = {
    id: crypto.randomUUID(), invitationId, discordUserId,
    discordDisplayName: discordDisplayName || null,
    guildId, sourceChannelId,
    status: "pending", createdAt: new Date().toISOString(), attempts: 0,
    lastError: null, wizarrUserId: null, jellyfinUserId: null, jellyfinUsername: null,
    seerrUserId: null, seerrAssociationStatus: "pending", seerrLastError: null,
    completedAt: null,
  };
  records.push(record); save(); return { ...record };
}

export function removeInviteRecord(id) {
  records = records.filter((record) => record.id !== id); save();
}

export function updateInviteRecord(id, changes) {
  const index = records.findIndex((record) => record.id === id);
  if (index < 0) throw new Error("Invite reconciliation record not found");
  records[index] = { ...records[index], ...changes, updatedAt: new Date().toISOString() };
  save(); return { ...records[index] };
}

export function listReconcileableRecords() {
  return records.filter((record) => ["pending", "processing", "waiting_identity"].includes(record.status)).map((record) => ({ ...record }));
}

export function getLatestInviteRecordForDiscordUser(discordUserId) {
  const matches = records
    .filter((record) => record.discordUserId === discordUserId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return matches[0] ? { ...matches[0] } : null;
}

export function isActiveInviteStatus(status) {
  return ["pending", "processing", "waiting_identity"].includes(status);
}

export function listPendingSeerrAssociationRecords() {
  return records
    .filter((record) =>
      record.status === "completed" &&
      record.jellyfinUserId &&
      record.seerrAssociationStatus !== "completed"
    )
    .map((record) => ({ ...record }));
}

export function getLatestInviteRecordForJellyfinUser(jellyfinUserId) {
  const matches = records
    .filter((record) => record.jellyfinUserId === jellyfinUserId)
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return matches[0] ? { ...matches[0] } : null;
}

export function listCompletedManagedRecords() {
  const latestByDiscordUser = new Map();
  for (const record of records) {
    const existing = latestByDiscordUser.get(record.discordUserId);
    if (!existing || String(record.createdAt).localeCompare(String(existing.createdAt)) > 0) {
      latestByDiscordUser.set(record.discordUserId, record);
    }
  }
  return [...latestByDiscordUser.values()]
    .filter((record) =>
      record.status === "completed" &&
      record.discordUserId &&
      record.guildId &&
      record.jellyfinUserId
    )
    .map((record) => ({ ...record }));
}
