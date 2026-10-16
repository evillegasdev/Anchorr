import logger from "../utils/logger.js";
import { deleteInvitation, listInvitations, listWizarrUsers } from "../api/wizarr.js";
import { deleteJellyfinUser, resolveJellyfinUser } from "../api/jellyfinUsers.js";
import { removeDiscordIdFromSeerrUser } from "../api/seerrUsers.js";
import { deleteUserMapping } from "../utils/userMappingStore.js";
import {
  getLatestInviteRecordForDiscordUser,
  isActiveInviteStatus,
  listCompletedManagedRecords,
  updateInviteRecord,
} from "./inviteState.js";

const DEPARTURE_RECONCILE_INTERVAL_MS = 5 * 60 * 1000;
const DEPARTURE_RECONCILE_INITIAL_DELAY_MS = 30 * 1000;
const departureCleanupInFlight = new Set();
let departureReconcileTimer = null;
let departureReconcileInitialTimer = null;
let departureReconcileRunning = false;
let lifecycleClient = null;

function parseWizarrUserId(value) {
  if (typeof value !== "string") return null;
  const match = /^<User ([1-9][0-9]*)>$/.exec(value.trim());
  return match ? Number.parseInt(match[1], 10) : null;
}

async function sendAudit(client, event) {
  const channelId = process.env.DISCORD_INVITE_AUDIT_CHANNEL_ID;
  if (!channelId) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (!channel?.isTextBased()) return;
    const lines = [
      "**ForFlower membership lifecycle event**",
      `Result: ${event.result}`,
      `Discord user: <@${event.discordUserId}>`,
      `Detail: ${event.detail}`,
    ];
    if (event.invitationId) lines.push(`Wizarr invitation ID: ${event.invitationId}`);
    if (event.username) lines.push(`Jellyfin username: ${event.username}`);
    await channel.send({ content: lines.join("\n"), allowedMentions: { users: [], roles: [] } });
  } catch (error) {
    logger.error(`[MEMBERSHIP] Audit failure: ${error.message}`);
  }
}

async function handleMemberAdd(client, member) {
  if (member.user?.bot || member.guild.id !== process.env.DISCORD_GUILD_ID) return;

  const pendingRole = process.env.DISCORD_PENDING_ONBOARDING_ROLE_ID;
  const mediaRole = process.env.DISCORD_MEDIA_MEMBER_ROLE_ID;

  if (!pendingRole) {
    throw new Error("Pending Onboarding role is not configured");
  }

  if (mediaRole && member.roles.cache.has(mediaRole)) {
    logger.info(
      `[MEMBERSHIP] Pending-role assignment skipped; member already has Media Member role discordUserId=${member.id} guildId=${member.guild.id}`
    );
    return;
  }

  let result;
  let detail;

  if (member.roles.cache.has(pendingRole)) {
    result = "pending-role-already-present";
    detail = "New server member already had Pending Onboarding";

    logger.info(
      `[MEMBERSHIP] Pending Onboarding role already present discordUserId=${member.id} guildId=${member.guild.id} roleId=${pendingRole}`
    );
  } else {
    await member.roles.add(
      pendingRole,
      "ForFlower automatic onboarding assignment"
    );

    result = "pending-role-assigned";
    detail = "Pending Onboarding assigned to new server member";

    logger.info(
      `[MEMBERSHIP] Added Pending Onboarding role discordUserId=${member.id} guildId=${member.guild.id} roleId=${pendingRole}`
    );
  }

  await sendAudit(client, {
    result,
    discordUserId: member.id,
    discordDisplayName:
      member.displayName ||
      member.user.globalName ||
      member.user.username,
    detail,
  });
}

async function deleteMappedJellyfinAccount(client, record, discordUserId, discordDisplayName) {
  let jellyfinUserId = record?.jellyfinUserId || null;
  let username = record?.jellyfinUsername || null;
  let wizarrUserId = record?.wizarrUserId || null;

  if (!jellyfinUserId && record?.invitationId) {
    const [invitations, wizarrUsers] = await Promise.all([listInvitations(), listWizarrUsers()]);
    const invitation = invitations.find((candidate) => candidate.id === record.invitationId);
    if (invitation?.status === "used") {
      wizarrUserId = parseWizarrUserId(invitation.used_by);
      const wizarrUser = wizarrUsers.find((candidate) => candidate.id === wizarrUserId);
      if (wizarrUser?.server === "ForFlower" && wizarrUser?.server_type === "jellyfin") {
        username = wizarrUser.username;
        const jellyfinUser = await resolveJellyfinUser(username);
        jellyfinUserId = jellyfinUser?.Id || null;
      }
    }
  }

  if (jellyfinUserId) {
    if (record.seerrUserId) {
      try {
        await removeDiscordIdFromSeerrUser(record.seerrUserId, discordUserId);
      } catch (error) {
        logger.warn(`[MEMBERSHIP] Seerr Discord ID cleanup failed: ${error.message}`);
      }
    }
    try { deleteUserMapping(discordUserId); }
    catch (error) { logger.warn(`[MEMBERSHIP] Local Seerr mapping cleanup failed: ${error.message}`); }

    const deletion = await deleteJellyfinUser(jellyfinUserId);
    updateInviteRecord(record.id, {
      status: "departed_deleted",
      wizarrUserId,
      jellyfinUserId,
      jellyfinUsername: username || deletion.username || null,
      departedAt: new Date().toISOString(),
      lastError: null,
      seerrAssociationStatus: record.seerrUserId
        ? "removed"
        : record.seerrAssociationStatus,
      seerrRemovedAt: record.seerrUserId
        ? new Date().toISOString()
        : null,
    });
    await sendAudit(client, {
      result: "jellyfin-user-deleted",
      discordUserId,
      discordDisplayName,
      invitationId: record.invitationId,
      username: username || deletion.username || null,
      detail: deletion.alreadyAbsent
        ? "Discord member left; Jellyfin account was already absent"
        : "Discord member left; Jellyfin account deleted and absence verified",
    });
    return;
  }

  if (record?.invitationId && isActiveInviteStatus(record.status)) {
    try { await deleteInvitation(record.invitationId); }
    catch (error) { logger.warn(`[MEMBERSHIP] Pending invitation revoke failed: ${error.message}`); }
    updateInviteRecord(record.id, {
      status: "departed_cancelled",
      departedAt: new Date().toISOString(),
      lastError: null,
    });
    await sendAudit(client, {
      result: "pending-invite-cancelled",
      discordUserId,
      discordDisplayName,
      invitationId: record.invitationId,
      detail: "Discord member left before a Jellyfin identity was resolved",
    });
    return;
  }

  await sendAudit(client, {
    result: "no-mapped-account",
    discordUserId,
    discordDisplayName,
    detail: "Discord member left without a bot-managed Jellyfin identity",
  });
}

async function cleanupManagedDeparture(client, record, discordUserId, discordDisplayName) {
  if (departureCleanupInFlight.has(discordUserId)) {
    logger.info(`[MEMBERSHIP] Cleanup already in progress for ${discordUserId}; duplicate trigger suppressed`);
    return;
  }
  departureCleanupInFlight.add(discordUserId);
  try {
    await deleteMappedJellyfinAccount(
      client,
      record,
      discordUserId,
      discordDisplayName
    );
  } finally {
    departureCleanupInFlight.delete(discordUserId);
  }
}

export async function reconcileCompletedMemberDepartures(client) {
  if (departureReconcileRunning) return;
  departureReconcileRunning = true;
  try {
    const records = listCompletedManagedRecords();
    for (const record of records) {
      try {
        const guild = client.guilds.cache.get(record.guildId) ||
          await client.guilds.fetch(record.guildId);
        try {
          await guild.members.fetch(record.discordUserId);
          continue;
        } catch (error) {
          if (Number(error?.code) !== 10007) {
            logger.warn(
              `[MEMBERSHIP RECOVERY] Discord membership check failed for ${record.discordUserId}: ${error.message}`
            );
            continue;
          }
        }

        logger.warn(
          `[MEMBERSHIP RECOVERY] Discord definitively reports member ${record.discordUserId} absent; cleaning managed account ${record.jellyfinUsername || record.jellyfinUserId}`
        );
        await cleanupManagedDeparture(
          client,
          record,
          record.discordUserId,
          record.discordDisplayName || record.discordUserId
        );
      } catch (error) {
        logger.error(
          `[MEMBERSHIP RECOVERY] Cleanup failed for ${record.discordUserId}: ${error.message}`
        );
      }
    }
  } finally {
    departureReconcileRunning = false;
  }
}

function scheduleCompletedMemberReconciliation(client) {
  lifecycleClient = client;
  if (departureReconcileTimer) clearInterval(departureReconcileTimer);
  if (departureReconcileInitialTimer) clearTimeout(departureReconcileInitialTimer);

  departureReconcileInitialTimer = setTimeout(() => {
    void reconcileCompletedMemberDepartures(lifecycleClient).catch((error) =>
      logger.error(`[MEMBERSHIP RECOVERY] Initial pass failed: ${error.message}`)
    );
  }, DEPARTURE_RECONCILE_INITIAL_DELAY_MS);
  departureReconcileInitialTimer.unref?.();

  departureReconcileTimer = setInterval(() => {
    void reconcileCompletedMemberDepartures(lifecycleClient).catch((error) =>
      logger.error(`[MEMBERSHIP RECOVERY] Periodic pass failed: ${error.message}`)
    );
  }, DEPARTURE_RECONCILE_INTERVAL_MS);
  departureReconcileTimer.unref?.();

  logger.info(
    `[MEMBERSHIP RECOVERY] Started with ${DEPARTURE_RECONCILE_INTERVAL_MS / 60000}m polling and ${DEPARTURE_RECONCILE_INITIAL_DELAY_MS / 1000}s initial delay`
  );
}

async function handleMemberRemove(client, member) {
  if (member.user?.bot || member.guild.id !== process.env.DISCORD_GUILD_ID) return;
  const record = getLatestInviteRecordForDiscordUser(member.id);
  if (!record) {
    await sendAudit(client, {
      result: "no-mapped-account",
      discordUserId: member.id,
      discordDisplayName: member.displayName || member.user.globalName || member.user.username,
      detail: "Discord member left without a reconciliation record",
    });
    return;
  }
  await cleanupManagedDeparture(
    client,
    record,
    member.id,
    record.discordDisplayName || member.displayName || member.user.globalName || member.user.username
  );
}

export function registerMemberLifecycle(client) {
  client.on("guildMemberAdd", (member) => {
    void handleMemberAdd(client, member).catch((error) =>
      logger.error(`[MEMBERSHIP] guildMemberAdd failed for ${member.id}: ${error.message}`)
    );
  });
  client.on("guildMemberRemove", (member) => {
    void handleMemberRemove(client, member).catch((error) =>
      logger.error(`[MEMBERSHIP] guildMemberRemove failed for ${member.id}: ${error.message}`)
    );
  });
  scheduleCompletedMemberReconciliation(client);
  logger.info("[MEMBERSHIP] Discord member lifecycle handlers registered");
}
