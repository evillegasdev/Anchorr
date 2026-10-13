import axios from "axios";

const DEFAULT_TIMEOUT_MS = 10000;
const VALID_EXPIRATION_DAYS = new Set([1, 7, 30]);

function requiredEnvironment(name) {
  const value = process.env[name];

  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value.trim();
}

function parsePositiveInteger(name, value) {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

function parseIntegerList(name, value) {
  const values = String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => Number.parseInt(item, 10));

  if (
    values.length === 0 ||
    values.some(
      (item) =>
        !Number.isSafeInteger(item) ||
        item <= 0
    )
  ) {
    throw new Error(
      `${name} must be a comma-separated list of positive integers`
    );
  }

  return [...new Set(values)];
}

function getConfiguration() {
  const apiUrl = requiredEnvironment("WIZARR_API_URL")
    .replace(/\/+$/, "");

  const publicUrl = new URL(
    requiredEnvironment("WIZARR_PUBLIC_URL")
  );

  if (publicUrl.protocol !== "https:") {
    throw new Error(
      "WIZARR_PUBLIC_URL must use HTTPS"
    );
  }

  const serverId = parsePositiveInteger(
    "WIZARR_SERVER_ID",
    requiredEnvironment("WIZARR_SERVER_ID")
  );

  const libraryIds = parseIntegerList(
    "WIZARR_LIBRARY_IDS",
    requiredEnvironment("WIZARR_LIBRARY_IDS")
  );

  const expiresInDays = parsePositiveInteger(
    "WIZARR_INVITE_EXPIRES_DAYS",
    requiredEnvironment("WIZARR_INVITE_EXPIRES_DAYS")
  );

  if (!VALID_EXPIRATION_DAYS.has(expiresInDays)) {
    throw new Error(
      "WIZARR_INVITE_EXPIRES_DAYS must be 1, 7, or 30"
    );
  }

  const expectedUses = parsePositiveInteger(
    "WIZARR_INVITE_USES",
    requiredEnvironment("WIZARR_INVITE_USES")
  );

  if (expectedUses !== 1) {
    throw new Error(
      "ForFlower policy requires WIZARR_INVITE_USES=1"
    );
  }

  return {
    apiUrl,
    apiKey: requiredEnvironment("WIZARR_API_KEY"),
    publicUrl,
    serverId,
    libraryIds,
    expiresInDays,
  };
}

function createClient(configuration) {
  return axios.create({
    baseURL: configuration.apiUrl,
    timeout: DEFAULT_TIMEOUT_MS,
    maxRedirects: 0,
    headers: {
      "X-API-Key": configuration.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
  });
}

function buildPublicInvitationUrl(rawUrl, publicUrl) {
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    throw new Error(
      "Wizarr response did not include an invitation URL"
    );
  }

  let returnedUrl;

  try {
    returnedUrl = new URL(rawUrl, publicUrl);
  } catch {
    throw new Error(
      "Wizarr returned an invalid invitation URL"
    );
  }

  if (
    returnedUrl.protocol !== "https:" ||
    returnedUrl.hostname !== publicUrl.hostname ||
    returnedUrl.port !== publicUrl.port
  ) {
    throw new Error(
      "Wizarr returned an invitation URL outside the configured public origin"
    );
  }

  return returnedUrl.toString();
}

function toSafeApiError(error) {
  if (error.response) {
    const status = error.response.status;
    const message =
      error.response.data?.error ||
      error.response.data?.message ||
      "Wizarr rejected the request";

    const safeError = new Error(
      `Wizarr API request failed with HTTP ${status}: ${message}`
    );

    safeError.status = status;
    return safeError;
  }

  if (
    error.code === "ECONNREFUSED" ||
    error.code === "ENOTFOUND" ||
    error.code === "ETIMEDOUT" ||
    error.code === "ECONNABORTED"
  ) {
    return new Error(
      "The internal Wizarr API is unavailable"
    );
  }

  return new Error(
    error.message || "Unexpected Wizarr API error"
  );
}

export async function createForFlowerInvitation() {
  const configuration = getConfiguration();
  const client = createClient(configuration);

  const payload = {
    server_ids: [configuration.serverId],
    expires_in_days: configuration.expiresInDays,
    // In Wizarr v2026.10.1, `unlimited` controls whether the invitation
    // can provision multiple users. Keep membership unlimited through the
    // separate `duration` field while enforcing one-time invite redemption.
    duration: "unlimited",
    unlimited: false,
    library_ids: configuration.libraryIds,
    allow_downloads: true,
    allow_live_tv: false,
    allow_mobile_uploads: false,
  };

  try {
    const response = await client.post(
      "/invitations",
      payload
    );

    if (response.status !== 201) {
      throw new Error(
        `Unexpected Wizarr response status: ${response.status}`
      );
    }

    const invitation = response.data?.invitation;

    if (
      !invitation ||
      !Number.isSafeInteger(invitation.id) ||
      typeof invitation.code !== "string"
    ) {
      throw new Error(
        "Wizarr returned an incomplete invitation object"
      );
    }

    const url = buildPublicInvitationUrl(
      invitation.url,
      configuration.publicUrl
    );

    return {
      id: invitation.id,
      url,
      status: invitation.status || "pending",
      expires: invitation.expires || null,
      serverNames: Array.isArray(invitation.server_names)
        ? invitation.server_names
        : [],
      libraryIds: Array.isArray(
        invitation.specific_libraries
      )
        ? invitation.specific_libraries
        : configuration.libraryIds,
    };
  } catch (error) {
    throw toSafeApiError(error);
  }
}

export async function deleteInvitation(
  invitationId
) {
  const configuration = getConfiguration();
  const client = createClient(configuration);

  const id = parsePositiveInteger(
    "invitationId",
    invitationId
  );

  try {
    await client.delete(`/invitations/${id}`);
    return true;
  } catch (error) {
    throw toSafeApiError(error);
  }
}
