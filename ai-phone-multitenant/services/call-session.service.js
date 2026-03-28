// =============================================================
// services/call-session.service.js
// 通话会话管理：内存 Map 主存储 + Redis 可选持久化
// 若未配置 REDIS_URL，纯内存运行（行为与原版相同）
// =============================================================

const redis = (() => {
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    const { createClient } = require("redis");
    const client = createClient({ url });
    client.connect().catch((err) =>
      console.error("[Redis] connect error:", err.message)
    );
    client.on("error", (err) =>
      console.error("[Redis] client error:", err.message)
    );
    console.log("[Redis] connected to", url);
    return client;
  } catch (err) {
    console.warn("[Redis] redis package not found, running without persistence:", err.message);
    return null;
  }
})();

const REDIS_KEY_PREFIX = "hvac:call:";
const REDIS_TTL_SECONDS = 60 * 60 * 48; // 48 hours

// ─── 内存主存储 ───────────────────────────────
const liveCalls = new Map();
const streamToCallSid = new Map();

// ─── 工具函数 ─────────────────────────────────
function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^\d+]/g, "").trim();
}

function createEmptyExtracted() {
  return {
    intent: "",
    callerName: "",
    callbackNumber: "",
    serviceAddress: "",
    issueSummary: "",
    preferredDate: "",
    preferredTime: "",
    preferredDateTime: "",
    bookingConfirmed: false,
    appointmentCreated: false,
    appointmentEventId: "",
  };
}

// ─── Redis 持久化（非阻塞，失败不影响主流程）────
async function persistToRedis(callSid, sessionData) {
  if (!redis) return;
  try {
    const key = REDIS_KEY_PREFIX + callSid;
    // transcript 可能很大，只持久化元数据和 extracted
    const payload = {
      callSid: sessionData.callSid,
      from: sessionData.from,
      to: sessionData.to,
      status: sessionData.status,
      createdAt: sessionData.createdAt,
      updatedAt: sessionData.updatedAt,
      transcript: sessionData.transcript,
      extracted: sessionData.extracted,
    };
    await redis.set(key, JSON.stringify(payload), { EX: REDIS_TTL_SECONDS });
  } catch (err) {
    console.error("[Redis] persist error:", err.message);
  }
}

async function loadFromRedis(callSid) {
  if (!redis) return null;
  try {
    const key = REDIS_KEY_PREFIX + callSid;
    const raw = await redis.get(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error("[Redis] load error:", err.message);
    return null;
  }
}

// ─── 核心 API ─────────────────────────────────
function getOrCreateCallSession(callSid) {
  if (!liveCalls.has(callSid)) {
    liveCalls.set(callSid, {
      callSid,
      streamSid: "",
      from: "",
      to: "",
      status: "new",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      transcript: [],
      lastAssistantText: "",
      extractionInFlight: false,
      lastExtractionAt: 0,
      mediaPacketCount: 0,
      extracted: createEmptyExtracted(),
    });
  }
  return liveCalls.get(callSid);
}

// 从 Redis 恢复历史通话（服务器重启后调用）
async function restoreCallSession(callSid) {
  if (liveCalls.has(callSid)) return liveCalls.get(callSid);
  const saved = await loadFromRedis(callSid);
  if (!saved) return getOrCreateCallSession(callSid);

  const session = getOrCreateCallSession(callSid);
  session.from = saved.from || "";
  session.to = saved.to || "";
  session.status = saved.status || "new";
  session.createdAt = saved.createdAt || session.createdAt;
  session.updatedAt = saved.updatedAt || session.updatedAt;
  session.transcript = Array.isArray(saved.transcript) ? saved.transcript : [];
  session.extracted = { ...createEmptyExtracted(), ...(saved.extracted || {}) };
  console.log(`[Redis] restored session for ${callSid}`);
  return session;
}

function mergeCallSessions(targetSid, sourceSid) {
  if (!targetSid && !sourceSid) return null;
  if (!targetSid || !sourceSid || targetSid === sourceSid) {
    return getOrCreateCallSession(targetSid || sourceSid);
  }

  const target = getOrCreateCallSession(targetSid);
  const source = liveCalls.get(sourceSid);
  if (!source) return target;

  target.streamSid = target.streamSid || source.streamSid || "";
  target.from = target.from || source.from || "";
  target.to = target.to || source.to || "";
  target.status = source.status || target.status;
  target.updatedAt = new Date().toISOString();

  if (Array.isArray(source.transcript) && source.transcript.length) {
    target.transcript = [...target.transcript, ...source.transcript].sort(
      (a, b) => new Date(a.ts) - new Date(b.ts)
    );
  }

  target.lastAssistantText = target.lastAssistantText || source.lastAssistantText || "";
  target.extractionInFlight = target.extractionInFlight || source.extractionInFlight || false;
  target.lastExtractionAt = Math.max(target.lastExtractionAt || 0, source.lastExtractionAt || 0);
  target.mediaPacketCount = (target.mediaPacketCount || 0) + (source.mediaPacketCount || 0);

  const te = target.extracted || createEmptyExtracted();
  const se = source.extracted || createEmptyExtracted();
  target.extracted = {
    ...se,
    ...te,
    intent:              te.intent              || se.intent              || "",
    callerName:          te.callerName          || se.callerName          || "",
    callbackNumber:      te.callbackNumber      || se.callbackNumber      || "",
    serviceAddress:      te.serviceAddress      || se.serviceAddress      || "",
    issueSummary:        te.issueSummary        || se.issueSummary        || "",
    preferredDate:       te.preferredDate       || se.preferredDate       || "",
    preferredTime:       te.preferredTime       || se.preferredTime       || "",
    preferredDateTime:   te.preferredDateTime   || se.preferredDateTime   || "",
    bookingConfirmed:    Boolean(te.bookingConfirmed)   || Boolean(se.bookingConfirmed),
    appointmentCreated:  Boolean(te.appointmentCreated) || Boolean(se.appointmentCreated),
    appointmentEventId:  te.appointmentEventId  || se.appointmentEventId  || "",
  };

  if (source.streamSid) streamToCallSid.set(source.streamSid, targetSid);
  liveCalls.delete(sourceSid);

  persistToRedis(targetSid, target);
  return target;
}

function resolveStartCallSid(startData, fallbackCallSid = "") {
  return (
    startData?.callSid ||
    startData?.customParameters?.callSid ||
    fallbackCallSid ||
    ""
  );
}

function pushTranscript(callSid, role, text) {
  const session = getOrCreateCallSession(callSid);
  const cleaned = cleanText(text);
  if (!cleaned) return;
  session.transcript.push({ role, text: cleaned, ts: new Date().toISOString() });
  session.updatedAt = new Date().toISOString();
  persistToRedis(callSid, session);
}

function buildCallSummary(call) {
  const f = call.extracted || createEmptyExtracted();
  return {
    callSid:            call.callSid,
    from:               call.from               || "",
    to:                 call.to                 || "",
    status:             call.status             || "",
    createdAt:          call.createdAt          || "",
    updatedAt:          call.updatedAt          || "",
    intent:             f.intent                || "",
    callerName:         f.callerName            || "",
    callbackNumber:     f.callbackNumber        || "",
    serviceAddress:     f.serviceAddress        || "",
    issueSummary:       f.issueSummary          || "",
    preferredDate:      f.preferredDate         || "",
    preferredTime:      f.preferredTime         || "",
    bookingConfirmed:   !!f.bookingConfirmed,
    appointmentCreated: !!f.appointmentCreated,
    appointmentEventId: f.appointmentEventId    || "",
  };
}

module.exports = {
  liveCalls,
  streamToCallSid,
  cleanText,
  normalizePhone,
  createEmptyExtracted,
  getOrCreateCallSession,
  restoreCallSession,
  mergeCallSessions,
  resolveStartCallSid,
  pushTranscript,
  buildCallSummary,
  persistToRedis,
};
