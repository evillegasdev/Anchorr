import logger from "./logger.js";

const JOB_ID = "jellyfin-recently-added-scan";
const DEFAULT_DELAY_MS = 10_000;
const DEFAULT_RETRY_MS = 45_000;
const DEFAULT_MAX_ATTEMPTS = 2;

let firstTimer = null;
let retryTimer = null;
let cycleRunning = false;
let batch = new Map();

function integerSetting(name, fallback, minimum, maximum) {
  const value = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(value) && value >= minimum && value <= maximum
    ? value
    : fallback;
}

function settings() {
  return {
    delayMs: integerSetting("SEERR_RECENT_SCAN_DELAY_MS", DEFAULT_DELAY_MS, 1_000, 300_000),
    retryMs: integerSetting("SEERR_RECENT_SCAN_RETRY_MS", DEFAULT_RETRY_MS, 5_000, 600_000),
    maxAttempts: integerSetting("SEERR_RECENT_SCAN_MAX_ATTEMPTS", DEFAULT_MAX_ATTEMPTS, 1, 5),
  };
}

function seerrConfig() {
  const baseUrl = String(process.env.SEERR_URL || "").trim().replace(/\/+$/, "");
  const apiKey = String(process.env.SEERR_API_KEY || "").trim();
  if (!baseUrl || !apiKey) {
    throw new Error("SEERR_URL or SEERR_API_KEY is not configured");
  }
  return { baseUrl, apiKey };
}

async function request(path, options = {}) {
  const { baseUrl, apiKey } = seerrConfig();
  const response = await fetch(`${baseUrl}${path}`, {
    ...options,
    headers: {
      "X-Api-Key": apiKey,
      Accept: "application/json",
      ...(options.headers || {}),
    },
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Seerr ${options.method || "GET"} ${path} returned ${response.status}: ${body.slice(0, 300)}`);
  }
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

async function runAttempt(attempt, batchSize) {
  const jobs = await request("/api/v1/settings/jobs");
  const job = Array.isArray(jobs) ? jobs.find((item) => item?.id === JOB_ID) : null;
  if (!job) throw new Error(`Seerr job not found: ${JOB_ID}`);

  if (job.running) {
    logger.info(`[SEERR FAST SCAN] Attempt ${attempt} joined already-running ${JOB_ID}; batched imports=${batchSize}`);
    return { joined: true };
  }

  await request(`/api/v1/settings/jobs/${encodeURIComponent(JOB_ID)}/run`, { method: "POST" });
  logger.info(`[SEERR FAST SCAN] Attempt ${attempt} started ${JOB_ID}; batched imports=${batchSize}`);
  return { started: true };
}

async function executeCycle() {
  if (cycleRunning) return;
  cycleRunning = true;
  firstTimer = null;

  const currentBatch = batch;
  batch = new Map();
  const { retryMs, maxAttempts } = settings();
  const batchSize = currentBatch.size;

  try {
    await runAttempt(1, batchSize);
  } catch (error) {
    logger.error(`[SEERR FAST SCAN] Attempt 1 failed: ${error.message}`);
  }

  if (maxAttempts > 1) {
    retryTimer = setTimeout(async () => {
      retryTimer = null;
      try {
        await runAttempt(2, batchSize);
      } catch (error) {
        logger.error(`[SEERR FAST SCAN] Attempt 2 failed: ${error.message}`);
      } finally {
        cycleRunning = false;
        if (batch.size > 0) scheduleCycle();
      }
    }, retryMs);
    retryTimer.unref?.();
  } else {
    cycleRunning = false;
    if (batch.size > 0) scheduleCycle();
  }
}

function scheduleCycle() {
  if (cycleRunning || firstTimer) return;
  const { delayMs } = settings();
  firstTimer = setTimeout(() => {
    executeCycle().catch((error) => {
      cycleRunning = false;
      logger.error(`[SEERR FAST SCAN] Cycle failed: ${error.message}`);
      if (batch.size > 0) scheduleCycle();
    });
  }, delayMs);
  firstTimer.unref?.();
  logger.info(`[SEERR FAST SCAN] Scheduled ${JOB_ID} in ${delayMs}ms; pending imports=${batch.size}`);
}

export function queueSeerrRecentlyAddedScan({ app, eventType, mediaId, title } = {}) {
  const key = [app || "arr", mediaId || title || "unknown"].join(":");
  batch.set(key, {
    app: app || null,
    eventType: eventType || null,
    mediaId: mediaId || null,
    title: title || null,
    queuedAt: new Date().toISOString(),
  });
  scheduleCycle();
  return { queued: true, key };
}
