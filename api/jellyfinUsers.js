import axios from "axios";

const TIMEOUT_MS = 10000;

function configuration() {
  const baseURL = String(process.env.JELLYFIN_BASE_URL || "").replace(/\/+$/, "");
  const apiKey = String(process.env.JELLYFIN_API_KEY || "").trim();
  if (!baseURL || !apiKey) throw new Error("Jellyfin API configuration is incomplete");
  return { baseURL, apiKey };
}

function client() {
  const { baseURL, apiKey } = configuration();
  return axios.create({
    baseURL,
    timeout: TIMEOUT_MS,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Emby-Token": apiKey,
      Authorization: `MediaBrowser Token="${apiKey}"`,
    },
  });
}

export async function listJellyfinUsers() {
  const response = await client().get("/Users");
  if (!Array.isArray(response.data)) throw new Error("Jellyfin returned an invalid user list");
  return response.data;
}

export async function resolveJellyfinUser(username) {
  const users = await listJellyfinUsers();
  const exact = users.filter((user) => user?.Name === username);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) throw new Error("Multiple exact Jellyfin username matches");
  const folded = users.filter((user) =>
    typeof user?.Name === "string" && user.Name.toLocaleLowerCase() === username.toLocaleLowerCase()
  );
  if (folded.length === 1) return folded[0];
  if (folded.length > 1) throw new Error("Multiple case-insensitive Jellyfin username matches");
  return null;
}

export async function listJellyfinFolderIds() {
  const response = await client().get("/Library/VirtualFolders");
  if (!Array.isArray(response.data)) throw new Error("Jellyfin returned an invalid virtual-folder list");
  const ids = response.data.map((folder) => folder?.ItemId).filter((id) => typeof id === "string" && id.length > 0);
  if (ids.length === 0) throw new Error("No Jellyfin virtual-folder IDs were returned");
  return [...new Set(ids)];
}

export async function enforceForFlowerUserPolicy(user) {
  if (!user?.Id || !user?.Policy) throw new Error("Jellyfin user object is incomplete");
  if (user.Policy.IsAdministrator) throw new Error("Refusing to modify a Jellyfin administrator");

  const folderIds = await listJellyfinFolderIds();
  const originalHidden = user.Policy.IsHidden;
  const policy = {
    ...user.Policy,
    EnableAllFolders: true,
    EnabledFolders: [],
    EnableContentDownloading: true,
    EnableContentDeletion: true,
    EnableContentDeletionFromFolders: folderIds,
    EnableSubtitleManagement: true,
  };

  await client().post(`/Users/${encodeURIComponent(user.Id)}/Policy`, policy);
  const refreshed = await client().get(`/Users/${encodeURIComponent(user.Id)}`);
  const effective = refreshed.data?.Policy;
  if (!effective) throw new Error("Jellyfin policy read-back was missing");

  const actualDeletionFolders = Array.isArray(effective.EnableContentDeletionFromFolders)
    ? effective.EnableContentDeletionFromFolders
    : [];
  const missingFolders = folderIds.filter((id) => !actualDeletionFolders.includes(id));
  if (!effective.EnableAllFolders || !effective.EnableContentDownloading ||
      !effective.EnableContentDeletion || !effective.EnableSubtitleManagement ||
      missingFolders.length > 0) {
    throw new Error("Jellyfin policy read-back did not match required permissions");
  }
  if (effective.IsHidden !== originalHidden) {
    throw new Error("Jellyfin IsHidden changed unexpectedly");
  }

  return { userId: user.Id, username: refreshed.data?.Name || user.Name, folderIds };
}

export async function deleteJellyfinUser(userId) {
  if (typeof userId !== "string" || userId.length === 0) {
    throw new Error("Jellyfin user ID is required");
  }

  const users = await listJellyfinUsers();
  const user = users.find((candidate) => candidate?.Id === userId);
  if (!user) return { deleted: false, alreadyAbsent: true };
  if (user.Policy?.IsAdministrator) {
    throw new Error("Refusing to delete a Jellyfin administrator");
  }

  await client().delete(`/Users/${encodeURIComponent(userId)}`);
  const remaining = await listJellyfinUsers();
  if (remaining.some((candidate) => candidate?.Id === userId)) {
    throw new Error("Jellyfin user still exists after deletion request");
  }

  return { deleted: true, alreadyAbsent: false, username: user.Name };
}
