import logger from "../utils/logger.js";
import { listInvitations, listWizarrUsers } from "../api/wizarr.js";
import { resolveJellyfinUser, enforceForFlowerUserPolicy } from "../api/jellyfinUsers.js";
import {
  listReconcileableRecords,
  listPendingSeerrAssociationRecords,
  updateInviteRecord,
} from "./inviteState.js";
import {
  findSeerrUserByJellyfinId,
  importJellyfinUserIntoSeerr,
  associateDiscordIdWithSeerrUser,
} from "../api/seerrUsers.js";
import { saveUserMapping } from "../utils/userMappingStore.js";

const POLL_MS = 15000;
let timer = null;
let running = false;
let client = null;

async function audit(event) {
  const channelId = process.env.DISCORD_INVITE_AUDIT_CHANNEL_ID;
  if (!channelId || !client) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    const lines = [
      "**ForFlower reconciliation event**",
      `Result: ${event.result}`,
      `Discord user: <@${event.discordUserId}>`,
      `Wizarr invitation ID: ${event.invitationId}`,
      `Detail: ${event.detail}`,
    ];
    if (event.username) lines.push(`Jellyfin username: ${event.username}`);
    await channel.send({ content: lines.join("\n"), allowedMentions: { users: [], roles: [] } });
  } catch (error) { logger.error(`[RECONCILE] Audit failure: ${error.message}`); }
}

function parseWizarrUserId(usedBy) {
  if (typeof usedBy !== "string") return null;
  const match = /^<User ([1-9][0-9]*)>$/.exec(usedBy.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

async function completeDiscord(record, username) {
  const guild = await client.guilds.fetch(record.guildId);
  const member = await guild.members.fetch(record.discordUserId);
  const mediaRole = process.env.DISCORD_MEDIA_MEMBER_ROLE_ID;
  const pendingRole = process.env.DISCORD_PENDING_ONBOARDING_ROLE_ID;
  if (!mediaRole || !pendingRole) throw new Error("Discord onboarding roles are not configured");
  await member.roles.add(mediaRole, "ForFlower onboarding reconciliation completed");
  await member.roles.remove(pendingRole, "ForFlower onboarding reconciliation completed");
  try {
    await member.send(`✅ ForFlower onboarding is complete for Jellyfin user **${username}**.`);
  } catch (error) {
    logger.warn(`[RECONCILE] Completion DM failed for ${record.discordUserId}: ${error.message}`);
  }
}

async function processRecord(record, invitations, wizarrUsers) {
  const invitation = invitations.find((item) => item.id === record.invitationId);
  if (!invitation) return;
  if (invitation.status === "expired") {
    updateInviteRecord(record.id, { status: "expired", lastError: "Wizarr invitation expired" });
    await audit({ ...record, result: "expired", detail: "Invitation expired before redemption" });
    return;
  }
  if (invitation.status !== "used") return;

  const wizarrUserId = parseWizarrUserId(invitation.used_by);
  if (!wizarrUserId) {
    updateInviteRecord(record.id, { status: "waiting_identity", attempts: record.attempts + 1, lastError: "Used invitation has no parseable Wizarr user reference" });
    return;
  }
  const wizarrUser = wizarrUsers.find((user) => user.id === wizarrUserId);
  if (!wizarrUser) {
    updateInviteRecord(record.id, { status: "waiting_identity", attempts: record.attempts + 1, wizarrUserId, lastError: "Referenced Wizarr user is not available" });
    return;
  }
  if (wizarrUser.server !== "ForFlower" || wizarrUser.server_type !== "jellyfin") {
    throw new Error("Referenced Wizarr user does not belong to the ForFlower Jellyfin server");
  }

  updateInviteRecord(record.id, { status: "processing", attempts: record.attempts + 1, wizarrUserId, jellyfinUsername: wizarrUser.username, lastError: null });
  const jellyfinUser = await resolveJellyfinUser(wizarrUser.username);
  if (!jellyfinUser) throw new Error("Exact Jellyfin user was not found");
  if (jellyfinUser.Policy?.IsAdministrator) throw new Error("Refusing to onboard a Jellyfin administrator");

  const verification = await enforceForFlowerUserPolicy(jellyfinUser);
  await completeDiscord(record, verification.username);
  const completedRecord = updateInviteRecord(record.id, {
    status: "completed",
    jellyfinUserId: verification.userId,
    jellyfinUsername: verification.username,
    completedAt: new Date().toISOString(),
    lastError: null,
  });
  await audit({ ...completedRecord, result: "completed", detail: "Jellyfin policy verified and Discord roles updated", username: verification.username });
  try {
    await associateSeerr(completedRecord);
  } catch (error) {
    logger.warn(`[RECONCILE] Initial Seerr association deferred: ${error.message}`);
    updateInviteRecord(record.id, {
      seerrAssociationStatus: "pending",
      seerrLastError: error.message,
    });
  }
}

async function associateSeerr(record) {
  let seerrUser = await findSeerrUserByJellyfinId(record.jellyfinUserId);
  if (!seerrUser) {
    updateInviteRecord(record.id, {
      seerrAssociationStatus: "importing",
      seerrLastError: null,
    });

    await importJellyfinUserIntoSeerr(record.jellyfinUserId);
    seerrUser = await findSeerrUserByJellyfinId(record.jellyfinUserId);

    if (!seerrUser) {
      throw new Error("Seerr import completed but the Jellyfin-linked user was not found");
    }
  }

  await associateDiscordIdWithSeerrUser(seerrUser.id, record.discordUserId);
  saveUserMapping({
    discordUserId: record.discordUserId,
    seerrUserId: seerrUser.id,
    discordUsername: null,
    discordDisplayName: record.discordDisplayName || null,
    seerrDisplayName: seerrUser.displayName || seerrUser.username || `User ${seerrUser.id}`,
  });
  updateInviteRecord(record.id, {
    seerrUserId: seerrUser.id,
    seerrAssociationStatus: "completed",
    seerrLastError: null,
    seerrAssociatedAt: new Date().toISOString(),
  });
  await audit({
    ...record,
    result: "seerr-associated",
    detail: "Discord identity associated with Seerr; native Seerr Discord delivery remains disabled",
    username: record.jellyfinUsername,
  });
  return true;
}

async function retryPendingSeerrAssociations() {
  const records = listPendingSeerrAssociationRecords();
  for (const record of records) {
    try {
      await associateSeerr(record);
    } catch (error) {
      logger.warn(`[RECONCILE] Seerr association pending for ${record.id}: ${error.message}`);
      updateInviteRecord(record.id, {
        seerrAssociationStatus: "pending",
        seerrLastError: error.message,
      });
    }
  }
}

async function tick() {
  if (running) return;
  running = true;
  try {
    const records = listReconcileableRecords();
    if (records.length > 0) {
      const [invitations, users] = await Promise.all([listInvitations(), listWizarrUsers()]);
      for (const record of records) {
      try { await processRecord(record, invitations, users); }
      catch (error) {
        logger.error(`[RECONCILE] Record ${record.id} failed: ${error.message}`);
        updateInviteRecord(record.id, { status: "waiting_identity", attempts: record.attempts + 1, lastError: error.message });
        await audit({ ...record, result: "failed", detail: error.message });
      }
      }
    }
    await retryPendingSeerrAssociations();
  } catch (error) { logger.error(`[RECONCILE] Poll failed: ${error.message}`); }
  finally { running = false; }
}

export function startInviteReconciler(discordClient) {
  if (timer) return;
  client = discordClient;
  timer = setInterval(tick, POLL_MS);
  timer.unref?.();
  void tick();
  logger.info(`[RECONCILE] Invite reconciler started with ${POLL_MS / 1000}s polling`);
}

export function stopInviteReconciler() {
  if (timer) clearInterval(timer);
  timer = null; client = null;
}
