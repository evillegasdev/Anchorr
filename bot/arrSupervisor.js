import { EmbedBuilder } from "discord.js";
import logger from "../utils/logger.js";
import { PersistentMap } from "../utils/persistentMap.js";
import { listRequestCorrelations } from "../utils/requestCorrelationStore.js";

const POLL_MS = 60 * 1000;
const STALL_MS = 45 * 60 * 1000;
const WARNING_CONFIRM_MS = 5 * 60 * 1000;
const NO_RELEASE_CONFIRM_MS = 10 * 60 * 1000;
const STATE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const supervisorState = new PersistentMap("arr-supervisor", STATE_TTL_MS, {
  validateValue: (v) => v && typeof v.updatedAt === "string",
});
let timer=null;
let running=false;
let activeClient=null;

function arrConfig(mediaType) {
  return mediaType === "movie"
    ? { name:"Radarr", base:process.env.RADARR_URL, key:process.env.RADARR_API_KEY }
    : { name:"Sonarr", base:process.env.SONARR_URL, key:process.env.SONARR_API_KEY };
}
async function api(target,path) {
  const response=await fetch(`${String(target.base||"").replace(/\/+$/,"")}${path}`,{
    headers:{Accept:"application/json","X-Api-Key":target.key},
  });
  if (!response.ok) throw new Error(`${target.name} ${path} returned ${response.status}`);
  return response.json();
}
async function resolveMedia(target,c) {
  if (c.mediaType === "movie") {
    const rows=await api(target,`/api/v3/movie?tmdbId=${c.tmdbId}`);
    return Array.isArray(rows)?rows[0]||null:null;
  }
  const rows=await api(target,"/api/v3/series");
  return Array.isArray(rows)?rows.find((x)=>Number(x.tmdbId)===Number(c.tmdbId))||null:null;
}
function fingerprintQueue(row) {
  return JSON.stringify({
    state:row?.trackedDownloadState||row?.status||null,
    status:row?.trackedDownloadStatus||null,
    error:Boolean(row?.errorMessage),
    messages:row?.statusMessages||[],
  });
}
function isProblem(row) {
  const state=String(row?.trackedDownloadState||"").toLowerCase();
  const status=String(row?.trackedDownloadStatus||"").toLowerCase();
  return Boolean(row?.errorMessage) || ["warning","error"].includes(status) ||
    ["importblocked","importpending","failed","warning"].includes(state) ||
    (Array.isArray(row?.statusMessages)&&row.statusMessages.length>0);
}
function hasImport(history) {
  return history.some((x)=>["downloadFolderImported","episodeFileImported"].includes(x.eventType));
}
function hasGrab(history) { return history.some((x)=>x.eventType==="grabbed"); }
function searchCommand(commands,mediaType,localId) {
  return commands.find((cmd)=>{
    const body=cmd.body||{};
    const ids=mediaType==="movie"?body.movieIds:body.seriesIds;
    const one=mediaType==="movie"?body.movieId:body.seriesId;
    const name=String(cmd.name||cmd.commandName||"").toLowerCase();
    return name.includes("search") &&
      (Number(one)===Number(localId)||(Array.isArray(ids)&&ids.map(Number).includes(Number(localId))));
  })||null;
}
async function send(client,c,title,description,color,fields=[]) {
  const channel=await client.channels.fetch(process.env.DISCORD_REQUEST_STATUS_CHANNEL_ID);
  if (!channel?.isTextBased()) throw new Error("Request-status channel is not text-capable");
  const users=c.discordUserIds.filter((id)=>/^\d{17,20}$/.test(String(id)));
  const embed=new EmbedBuilder().setTitle(title).setDescription(description).setColor(color).setTimestamp();
  if (fields.length) embed.addFields(fields);
  await channel.send({content:users.map((id)=>`<@${id}>`).join(" ")||"Arr status update",embeds:[embed],allowedMentions:{users,roles:[]}});
}
async function evaluate(client,c) {
  if (["available","MEDIA_AVAILABLE","MEDIA_DECLINED"].includes(c.status)) return;
  const target=arrConfig(c.mediaType);
  if (!target.base||!target.key) return;
  const media=await resolveMedia(target,c);
  if (!media) return;
  const localId=media.id;
  const [queue,historyResponse,commands]=await Promise.all([
    api(target,"/api/v3/queue/details?includeUnknownMovieItems=true&includeMovie=true&includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true"),
    c.mediaType==="movie"
      ? api(target,`/api/v3/history/movie?movieId=${localId}`)
      : api(target,"/api/v3/history?page=1&pageSize=100&sortKey=date&sortDirection=descending"),
    api(target,"/api/v3/command"),
  ]);
  const rows=Array.isArray(queue)?queue:[];
  const q=rows.find((x)=>c.mediaType==="movie"?Number(x.movieId)===Number(localId):Number(x.seriesId)===Number(localId));
  const allHistory=Array.isArray(historyResponse)?historyResponse:(historyResponse?.records||[]);
  const history=allHistory.filter((x)=>c.mediaType==="movie"?Number(x.movieId)===Number(localId):Number(x.seriesId)===Number(localId));
  const stateKey=`${c.tmdbId}-${c.mediaType}`;
  const previous=supervisorState.get(stateKey)||{};
  const now=Date.now();
  let next={...previous,tmdbId:c.tmdbId,mediaType:c.mediaType,updatedAt:new Date().toISOString()};

  if (q) {
    const downloadId=String(q.downloadId||q.id||"");
    const sizeleft=Number(q.sizeleft);
    const changed=downloadId!==previous.downloadId || !Number.isFinite(previous.sizeleft) ||
      !Number.isFinite(sizeleft) || sizeleft < previous.sizeleft;
    if (changed) next={...next,downloadId,sizeleft,lastProgressAt:now};
    else next={...next,downloadId,sizeleft,lastProgressAt:previous.lastProgressAt||now};

    const problem=isProblem(q);
    const fp=fingerprintQueue(q);
    if (problem) {
      next.problemFirstSeenAt=fp===previous.problemFingerprint?(previous.problemFirstSeenAt||now):now;
      next.problemFingerprint=fp;
      if (now-next.problemFirstSeenAt>=WARNING_CONFIRM_MS && previous.notifiedProblemFingerprint!==fp) {
        await send(client,c,`${target.name}: download needs attention`,media.title||"Tracked media",0xE67E22,[
          {name:"State",value:String(q.trackedDownloadState||q.status||"unknown"),inline:true},
          {name:"Status",value:String(q.trackedDownloadStatus||"unknown"),inline:true},
        ]);
        next.notifiedProblemFingerprint=fp;
      }
    } else {
      if (previous.notifiedProblemFingerprint) {
        await send(client,c,`${target.name}: download recovered`,media.title||"Tracked media",0x57F287);
      }
      delete next.problemFirstSeenAt; delete next.problemFingerprint; delete next.notifiedProblemFingerprint;
    }

    const stalled=String(q.trackedDownloadState||q.status||"").toLowerCase()==="downloading" && now-(next.lastProgressAt||now)>=STALL_MS;
    if (stalled && !previous.stallNotifiedAt) {
      await send(client,c,`${target.name}: download appears stalled`,media.title||"Tracked media",0xE74C3C,[
        {name:"No progress",value:"At least 45 minutes",inline:true},
        {name:"Remaining bytes",value:Number.isFinite(sizeleft)?String(sizeleft):"Unknown",inline:true},
      ]);
      next.stallNotifiedAt=new Date().toISOString();
    } else if (!stalled && previous.stallNotifiedAt) {
      await send(client,c,`${target.name}: download progress resumed`,media.title||"Tracked media",0x57F287);
      delete next.stallNotifiedAt;
    }
    delete next.noReleaseCandidateAt; delete next.noReleaseNotifiedAt;
  } else {
    const imported=(c.mediaType==="movie"?Boolean(media.hasFile):Number(media.statistics?.episodeFileCount||0)>0)||hasImport(history);
    if (imported) {
      delete next.noReleaseCandidateAt; delete next.noReleaseNotifiedAt;
    } else {
      const command=searchCommand(Array.isArray(commands)?commands:[],c.mediaType,localId);
      const completed=command && ["completed","failed"].includes(String(command.status||"").toLowerCase());
      const noGrab=!hasGrab(history);
      if (completed && noGrab) {
        next.noReleaseCandidateAt=previous.noReleaseCandidateAt||now;
        if (now-next.noReleaseCandidateAt>=NO_RELEASE_CONFIRM_MS && !previous.noReleaseNotifiedAt) {
          await send(client,c,`${target.name}: no eligible release found`,media.title||"Tracked media",0xE67E22,[
            {name:"Evidence",value:"Search completed with no grab and no active queue item",inline:false},
          ]);
          next.noReleaseNotifiedAt=new Date().toISOString();
        }
      } else {
        delete next.noReleaseCandidateAt;
      }
    }
  }
  supervisorState.set(stateKey,next);
}
async function tick() {
  if (running||!activeClient) return;
  running=true;
  try {
    for (const correlation of listRequestCorrelations()) {
      try { await evaluate(activeClient,correlation); }
      catch (error) { logger.warn(`[ARR SUPERVISOR] ${correlation.tmdbId}-${correlation.mediaType}: ${error.message}`); }
    }
  } finally { running=false; }
}
export function startArrSupervisor(client) {
  activeClient=client;
  if (timer) clearInterval(timer);
  timer=setInterval(()=>tick().catch((e)=>logger.error(`[ARR SUPERVISOR] Poll failed: ${e.message}`)),POLL_MS);
  timer.unref?.();
  setTimeout(()=>tick().catch((e)=>logger.error(`[ARR SUPERVISOR] Initial poll failed: ${e.message}`)),15000).unref?.();
  logger.info(`[ARR SUPERVISOR] Started with ${POLL_MS/1000}s polling, ${STALL_MS/60000}m stall threshold`);
}
