import { EmbedBuilder } from "discord.js";
import logger from "./utils/logger.js";
import { PersistentMap } from "./utils/persistentMap.js";
import { getRequestCorrelation } from "./utils/requestCorrelationStore.js";
import { queueDelayedGrab } from "./bot/arrGrabNotifier.js";

const SUPPORTED = new Set([
  "Grab", "Download", "ImportComplete", "HealthIssue",
  "HealthRestored", "ManualInteractionRequired",
]);
const dedup = new PersistentMap("arr-events", 30 * 24 * 60 * 60 * 1000, {
  validateValue: (value) => value && typeof value.type === "string",
});
const tvdbCache = new Map();

function clean(value, max=1000) {
  if (typeof value !== "string") return null;
  const result=value.replace(/[\u0000-\u001f\u007f]/g," ").trim();
  return result ? result.slice(0,max) : null;
}
function positive(value) {
  const n=Number.parseInt(String(value),10);
  return Number.isSafeInteger(n) && n>0 ? n : null;
}
function detectApp(payload) {
  const value=String(payload.instanceName || payload.applicationUrl || "").toLowerCase();
  if (value.includes("sonarr") || payload.series || payload.episodes) return "sonarr";
  if (value.includes("radarr") || payload.movie || payload.remoteMovie) return "radarr";
  return null;
}
async function tvdbToTmdb(tvdbId) {
  if (!tvdbId || !process.env.TMDB_API_KEY) return null;
  if (tvdbCache.has(tvdbId)) return tvdbCache.get(tvdbId);
  const url=new URL(`https://api.themoviedb.org/3/find/${tvdbId}`);
  url.searchParams.set("api_key",process.env.TMDB_API_KEY);
  url.searchParams.set("external_source","tvdb_id");
  const response=await fetch(url);
  if (!response.ok) throw new Error(`TMDB TVDb lookup returned ${response.status}`);
  const body=await response.json();
  const tmdbId=positive(body.tv_results?.[0]?.id);
  tvdbCache.set(tvdbId,tmdbId);
  return tmdbId;
}
async function mediaIdentity(payload, app) {
  if (app === "radarr") {
    return {
      type:"movie",
      tmdbId:positive(payload.movie?.tmdbId || payload.remoteMovie?.tmdbId),
      title:clean(payload.movie?.title || payload.remoteMovie?.title,256),
      year:positive(payload.movie?.year || payload.remoteMovie?.year),
      localId:positive(payload.movie?.id),
    };
  }
  const tvdbId=positive(payload.series?.tvdbId);
  return {
    type:"tv",
    tmdbId:await tvdbToTmdb(tvdbId),
    tvdbId,
    title:clean(payload.series?.title,256),
    year:positive(payload.series?.year),
    localId:positive(payload.series?.id),
  };
}
function eventInfo(type, app) {
  const name=app === "radarr" ? "Radarr" : "Sonarr";
  return ({
    Grab:[`${name}: download grabbed`,0x3498DB],
    Download:[`${name}: import completed`,0x2ECC71],
    ImportComplete:[`${name}: import completed`,0x2ECC71],
    HealthIssue:[`${name}: health issue`,0xE74C3C],
    HealthRestored:[`${name}: health restored`,0x57F287],
    ManualInteractionRequired:[`${name}: manual interaction required`,0xE67E22],
  })[type];
}
function detail(payload,type) {
  if (type === "Grab") return clean(payload.release?.releaseTitle || payload.release?.indexer,1000);
  if (type === "HealthIssue" || type === "HealthRestored") return clean(payload.message || payload.healthCheck?.message,1000);
  if (type === "ManualInteractionRequired") {
    return clean(payload.message || payload.downloadInfo?.title || payload.release?.releaseTitle,1000);
  }
  return clean(payload.movieFile?.relativePath || payload.episodeFile?.relativePath || payload.release?.releaseTitle,1000);
}
function dedupKey(app,type,payload,media) {
  return [app,type,media.tmdbId||media.tvdbId||"none",payload.downloadId||payload.release?.releaseTitle||payload.message||"none"].join(":");
}

export async function handleArrWebhook(payload,client,pendingRequests) {
  const type=clean(payload?.eventType,64);
  if (type === "Test") return { ignored:true };
  if (!SUPPORTED.has(type)) {
    logger.info(`[ARR WEBHOOK] Ignored unsupported event: ${type || "missing"}`);
    return { ignored:true };
  }
  const app=detectApp(payload);
  if (!app) throw new Error("Unable to identify Radarr or Sonarr payload");
  const media=await mediaIdentity(payload,app);
  const key=dedupKey(app,type,payload,media);
  if (dedup.has(key)) {
    logger.info(`[ARR WEBHOOK] Duplicate suppressed: ${key}`);
    return { duplicate:true };
  }
  if (["Download", "ImportComplete"].includes(type)) {
    dedup.set(key,{type,sentAt:new Date().toISOString(),suppressed:true});
    logger.info(`[ARR WEBHOOK] Suppressed ${app} ${type} media=${media.tmdbId||media.tvdbId||"unknown"}; Seerr MEDIA_AVAILABLE remains authoritative`);
    return {suppressed:true};
  }
  const channelId=process.env.DISCORD_REQUEST_STATUS_CHANNEL_ID;
  if (!channelId) throw new Error("DISCORD_REQUEST_STATUS_CHANNEL_ID is not configured");
  const channel=await client.channels.fetch(channelId);
  if (!channel?.isTextBased()) throw new Error("Request-status channel is not text-capable");
  const requestKey=media.tmdbId ? `${media.tmdbId}-${media.type}` : null;
  const legacyRequesterIds=requestKey && pendingRequests?.has(requestKey)
    ? [...pendingRequests.get(requestKey)].map(String).filter((id)=>/^\d{17,20}$/.test(id))
    : [];
  const correlation=media.tmdbId
    ? getRequestCorrelation(media.tmdbId,media.type)
    : null;
  const requesterIds=[...new Set([
    ...legacyRequesterIds,
    ...(correlation?.discordUserIds || []),
  ])];
  if (type === "Grab") {
    queueDelayedGrab({
      dedupKey:key,
      app,
      tmdbId:media.tmdbId,
      tvdbId:media.tvdbId,
      localId:media.localId,
      mediaType:media.type,
      title:media.title,
      year:media.year,
      releaseTitle:clean(payload.release?.releaseTitle || payload.release?.indexer,1000),
      downloadClient:clean(payload.downloadClient,100),
      downloadId:clean(payload.downloadId,200),
      requesterIds,
    });
    dedup.set(key,{type,sentAt:new Date().toISOString(),delayed:true});
    logger.info(`[ARR WEBHOOK] Queued delayed ${app} Grab media=${media.tmdbId||media.tvdbId||"unknown"} requesters=${requesterIds.length}`);
    return {queued:true,requesterIds};
  }
  const [title,color]=eventInfo(type,app);
  const subject=media.title ? `${media.title}${media.year ? ` (${media.year})` : ""}` : (clean(payload.sourceTitle,256)||"Arr status update");
  const embed=new EmbedBuilder().setTitle(title).setDescription(subject).setColor(color).setTimestamp();
  const body=detail(payload,type);
  if (body) embed.addFields({name:"Detail",value:body,inline:false});
  if (media.type) embed.addFields({name:"Media type",value:media.type,inline:true});
  if (payload.downloadClient) embed.addFields({name:"Download client",value:clean(payload.downloadClient,100),inline:true});
  const content=requesterIds.length ? requesterIds.map((id)=>`<@${id}>`).join(" ") : `${app === "radarr" ? "Radarr" : "Sonarr"} status update`;
  await channel.send({content,embeds:[embed],allowedMentions:{users:requesterIds,roles:[]}});
  dedup.set(key,{type,sentAt:new Date().toISOString()});
  logger.info(`[ARR WEBHOOK] Delivered ${app} ${type} media=${media.tmdbId||media.tvdbId||"unknown"} requesters=${requesterIds.length}`);
  return {delivered:true,requesterIds};
}
