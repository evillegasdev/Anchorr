import axios from "axios";
import { getSeerrApiUrl } from "../utils/seerrUrl.js";

const TIMEOUT_MS = 10000;

function client() {
  const baseURL = getSeerrApiUrl(process.env.SEERR_URL || "").replace(/\/+$/, "");
  const apiKey = String(process.env.SEERR_API_KEY || "").trim();
  if (!baseURL || !apiKey) throw new Error("Seerr API configuration is incomplete");
  return axios.create({
    baseURL,
    timeout: TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    },
  });
}

export async function listSeerrUsers() {
  const response = await client().get("/user", {
    params: { take: 1000, skip: 0, sort: "created" },
  });
  const users = Array.isArray(response.data)
    ? response.data
    : response.data?.results;
  if (!Array.isArray(users)) throw new Error("Seerr returned an invalid user list");
  return users;
}

export async function findSeerrUserByJellyfinId(jellyfinUserId) {
  const users = await listSeerrUsers();
  const matches = users.filter((user) =>
    String(user?.jellyfinUserId || "") === String(jellyfinUserId)
  );
  if (matches.length > 1) throw new Error("Multiple Seerr users match the Jellyfin user ID");
  return matches[0] || null;
}


export async function importJellyfinUserIntoSeerr(jellyfinUserId) {
  if (typeof jellyfinUserId !== "string" || !/^[a-f0-9]{32}$/i.test(jellyfinUserId)) {
    throw new Error("A valid Jellyfin user ID is required for Seerr import");
  }

  const response = await client().post("/user/import-from-jellyfin", {
    jellyfinUserIds: [jellyfinUserId],
  });

  if (response.status !== 201 && response.status !== 200) {
    throw new Error(`Unexpected Seerr import response status: ${response.status}`);
  }

  const imported = Array.isArray(response.data) ? response.data : [];
  const mismatched = imported.filter((user) =>
    user?.jellyfinUserId && String(user.jellyfinUserId) !== jellyfinUserId
  );
  if (mismatched.length > 0) {
    throw new Error("Seerr import returned a different Jellyfin user");
  }

  return imported;
}

export async function getSeerrNotificationSettings(seerrUserId) {
  const response = await client().get(`/user/${encodeURIComponent(seerrUserId)}/settings/notifications`);
  if (!response.data || typeof response.data !== "object") {
    throw new Error("Seerr returned invalid notification settings");
  }
  return response.data;
}

export async function associateDiscordIdWithSeerrUser(seerrUserId, discordUserId) {
  const settings = await getSeerrNotificationSettings(seerrUserId);
  const current = Array.isArray(settings.discordIds)
    ? settings.discordIds.map(String)
    : settings.discordId ? [String(settings.discordId)] : [];
  const discordIds = [...new Set([...current, String(discordUserId)])];

  // Keep Seerr native Discord delivery disabled. ForFlower Media Bot owns event routing.
  const payload = {
    ...settings,
    discordEnabled: false,
    discordIds,
  };

  await client().post(`/user/${encodeURIComponent(seerrUserId)}/settings/notifications`, payload);
  const verified = await getSeerrNotificationSettings(seerrUserId);
  const verifiedIds = Array.isArray(verified.discordIds)
    ? verified.discordIds.map(String)
    : [];
  if (!verifiedIds.includes(String(discordUserId))) {
    throw new Error("Seerr Discord ID association did not verify");
  }
  if (verified.discordEnabled !== false) {
    throw new Error("Seerr native Discord notifications were unexpectedly enabled");
  }
  return verified;
}

export async function removeDiscordIdFromSeerrUser(seerrUserId, discordUserId) {
  const settings = await getSeerrNotificationSettings(seerrUserId);
  const current = Array.isArray(settings.discordIds)
    ? settings.discordIds.map(String)
    : [];
  const discordIds = current.filter((id) => id !== String(discordUserId));
  const payload = { ...settings, discordEnabled: false, discordIds };
  await client().post(`/user/${encodeURIComponent(seerrUserId)}/settings/notifications`, payload);
  const verified = await getSeerrNotificationSettings(seerrUserId);
  const verifiedIds = Array.isArray(verified.discordIds)
    ? verified.discordIds.map(String)
    : [];
  if (verifiedIds.includes(String(discordUserId))) {
    throw new Error("Seerr Discord ID removal did not verify");
  }
  return verified;
}
