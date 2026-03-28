// =============================================================
// services/call-session.service.js
// 通话会话管理：内存 Map 用于活跃通话，MongoDB 持久化
// 通话进行中全部操作走内存（低延迟），通话结束/关键节点写 DB
// =============================================================

// 懒加载 Model，避免循环依赖
function getCallModel() { return require("../models").Call; }
function getRecordingModel() { return require("../models").Recording; }
const zlib = require("zlib");

// ─── 内存主存储（活跃通话）───────────────────
const liveCalls = new Map();
const streamToCallSid = new Map();

// ─── 工具函数 ─────────────────────────────────
function cleanText(s) { return (s || "").replace(/\s+/g, " ").trim(); }
function normalizePhone(phone) { return phone ? phone.replace(/[^\d+]/g, "").trim() : ""; }

function createEmptyExtracted() {
  return {
    intent: "", callerName: "", callbackNumber: "", serviceAddress: "",
    issueSummary: "", preferredDate: "", preferredTime: "", preferredDateTime: "",
    bookingConfirmed: false, appointmentCreated: false, appointmentEventId: "",
  };
}

// ─── MongoDB 持久化（非阻塞）─────────────────
async function persistToDB(callSid, sessionData) {
  try {
    await getCallModel().findOneAndUpdate(
      { callSid },
      {
        callSid:         sessionData.callSid,
        tenantId:        sessionData.tenantId || "",
        from:            sessionData.from,
        to:              sessionData.to,
        status:          sessionData.status,
        streamSid:       sessionData.streamSid || "",
        transcript:      sessionData.transcript,
        extracted:       sessionData.extracted,
        mediaPacketCount: sessionData.mediaPacketCount || 0,
      },
      { upsert: true, new: true }
    );
  } catch (err) {
    console.error("[DB] persist call error:", err.message);
  }
}

async function persistRecordingToDB(callSid, tenantId, wavBuffer, callerFrames, assistantFrames, durationSec) {
  try {
    // 压缩 frames 数据以减少存储
    const callerBuf = zlib.gzipSync(JSON.stringify(callerFrames));
    const assistantBuf = zlib.gzipSync(JSON.stringify(assistantFrames));

    await getRecordingModel().findOneAndUpdate(
      { callSid },
      {
        callSid, tenantId: tenantId || "",
        wavBuffer, callerFrames: callerBuf, assistantFrames: assistantBuf,
        durationSec, available: true,
      },
      { upsert: true, new: true }
    );
    console.log(`[DB] Recording saved for ${callSid}`);
  } catch (err) {
    console.error("[DB] persist recording error:", err.message);
  }
}

async function loadCallFromDB(callSid) {
  try {
    const doc = await getCallModel().findOne({ callSid }).lean();
    return doc || null;
  } catch (err) {
    console.error("[DB] load call error:", err.message);
    return null;
  }
}

async function loadRecordingFromDB(callSid) {
  try {
    const doc = await getRecordingModel().findOne({ callSid }).lean();
    if (!doc) return null;
    // 解压 frames
    let callerFrames = [], assistantFrames = [];
    if (doc.callerFrames) {
      try { callerFrames = JSON.parse(zlib.gunzipSync(doc.callerFrames).toString()); } catch (_) {}
    }
    if (doc.assistantFrames) {
      try { assistantFrames = JSON.parse(zlib.gunzipSync(doc.assistantFrames).toString()); } catch (_) {}
    }
    return {
      wavBuffer: doc.wavBuffer,
      _callerFrames: callerFrames,
      _assistantFrames: assistantFrames,
      durationSec: doc.durationSec,
      createdAt: doc.createdAt?.toISOString(),
      available: doc.available,
    };
  } catch (err) {
    console.error("[DB] load recording error:", err.message);
    return null;
  }
}

// ─── 核心 API ─────────────────────────────────
function getOrCreateCallSession(callSid) {
  if (!liveCalls.has(callSid)) {
    liveCalls.set(callSid, {
      callSid, streamSid: "", tenantId: "",
      from: "", to: "", status: "new",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      transcript: [], lastAssistantText: "",
      extractionInFlight: false, lastExtractionAt: 0,
      mediaPacketCount: 0,
      extracted: createEmptyExtracted(),
    });
  }
  return liveCalls.get(callSid);
}

// 从 DB 恢复通话（服务器重启后 or 查看历史记录）
async function restoreCallSession(callSid) {
  if (liveCalls.has(callSid)) return liveCalls.get(callSid);
  const saved = await loadCallFromDB(callSid);
  if (!saved) return getOrCreateCallSession(callSid);

  const session = getOrCreateCallSession(callSid);
  session.tenantId = saved.tenantId || "";
  session.from = saved.from || "";
  session.to = saved.to || "";
  session.status = saved.status || "new";
  session.createdAt = saved.createdAt?.toISOString?.() || saved.createdAt || session.createdAt;
  session.updatedAt = saved.updatedAt?.toISOString?.() || saved.updatedAt || session.updatedAt;
  session.transcript = Array.isArray(saved.transcript) ? saved.transcript : [];
  session.extracted = { ...createEmptyExtracted(), ...(saved.extracted || {}) };
  console.log(`[DB] Restored session for ${callSid}`);

  // 也尝试恢复录音
  const rec = await loadRecordingFromDB(callSid);
  if (rec) session.recording = rec;

  return session;
}

// 启动时从 DB 加载最近的通话到内存
async function loadRecentCalls(limit = 100) {
  try {
    const docs = await getCallModel().find().sort({ updatedAt: -1 }).limit(limit).lean();
    for (const doc of docs) {
      if (liveCalls.has(doc.callSid)) continue;
      const session = getOrCreateCallSession(doc.callSid);
      session.tenantId = doc.tenantId || "";
      session.from = doc.from || "";
      session.to = doc.to || "";
      session.status = doc.status || "completed";
      session.createdAt = doc.createdAt?.toISOString?.() || doc.createdAt || "";
      session.updatedAt = doc.updatedAt?.toISOString?.() || doc.updatedAt || "";
      session.transcript = Array.isArray(doc.transcript) ? doc.transcript : [];
      session.extracted = { ...createEmptyExtracted(), ...(doc.extracted || {}) };

      // 录音标记（不加载 wavBuffer 到内存，需要时再从 DB 读）
      const hasRec = await getRecordingModel().exists({ callSid: doc.callSid, available: true });
      if (hasRec) {
        session.recording = { available: true, durationSec: 0, _fromDB: true, createdAt: "" };
      }
    }
    console.log(`[DB] Loaded ${docs.length} recent calls into memory`);
  } catch (err) {
    console.error("[DB] loadRecentCalls error:", err.message);
  }
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
  target.tenantId = target.tenantId || source.tenantId || "";
  target.from = target.from || source.from || "";
  target.to = target.to || source.to || "";
  target.status = source.status || target.status;
  target.updatedAt = new Date().toISOString();

  if (Array.isArray(source.transcript) && source.transcript.length) {
    target.transcript = [...target.transcript, ...source.transcript]
      .sort((a, b) => new Date(a.ts) - new Date(b.ts));
  }

  target.lastAssistantText = target.lastAssistantText || source.lastAssistantText || "";
  target.extractionInFlight = target.extractionInFlight || source.extractionInFlight;
  target.lastExtractionAt = Math.max(target.lastExtractionAt || 0, source.lastExtractionAt || 0);
  target.mediaPacketCount = (target.mediaPacketCount || 0) + (source.mediaPacketCount || 0);

  const te = target.extracted || createEmptyExtracted();
  const se = source.extracted || createEmptyExtracted();
  target.extracted = {
    intent: te.intent || se.intent || "",
    callerName: te.callerName || se.callerName || "",
    callbackNumber: te.callbackNumber || se.callbackNumber || "",
    serviceAddress: te.serviceAddress || se.serviceAddress || "",
    issueSummary: te.issueSummary || se.issueSummary || "",
    preferredDate: te.preferredDate || se.preferredDate || "",
    preferredTime: te.preferredTime || se.preferredTime || "",
    preferredDateTime: te.preferredDateTime || se.preferredDateTime || "",
    bookingConfirmed: Boolean(te.bookingConfirmed) || Boolean(se.bookingConfirmed),
    appointmentCreated: Boolean(te.appointmentCreated) || Boolean(se.appointmentCreated),
    appointmentEventId: te.appointmentEventId || se.appointmentEventId || "",
  };

  if (source.streamSid) streamToCallSid.set(source.streamSid, targetSid);
  liveCalls.delete(sourceSid);
  persistToDB(targetSid, target);
  return target;
}

function resolveStartCallSid(startData, fallbackCallSid = "") {
  return startData?.callSid || startData?.customParameters?.callSid || fallbackCallSid || "";
}

function pushTranscript(callSid, role, text) {
  const session = getOrCreateCallSession(callSid);
  const cleaned = cleanText(text);
  if (!cleaned) return;
  session.transcript.push({ role, text: cleaned, ts: new Date().toISOString() });
  session.updatedAt = new Date().toISOString();
  persistToDB(callSid, session);
}

function buildCallSummary(call) {
  const f = call.extracted || createEmptyExtracted();
  return {
    callSid: call.callSid, from: call.from || "", to: call.to || "",
    status: call.status || "", createdAt: call.createdAt || "",
    updatedAt: call.updatedAt || "", intent: f.intent || "",
    callerName: f.callerName || "", callbackNumber: f.callbackNumber || "",
    serviceAddress: f.serviceAddress || "", issueSummary: f.issueSummary || "",
    preferredDate: f.preferredDate || "", preferredTime: f.preferredTime || "",
    bookingConfirmed: !!f.bookingConfirmed,
    appointmentCreated: !!f.appointmentCreated,
    appointmentEventId: f.appointmentEventId || "",
    extracted: f,
  };
}

module.exports = {
  liveCalls, streamToCallSid, cleanText, normalizePhone, createEmptyExtracted,
  getOrCreateCallSession, restoreCallSession, loadRecentCalls,
  mergeCallSessions, resolveStartCallSid, pushTranscript, buildCallSummary,
  persistToDB, persistRecordingToDB, loadRecordingFromDB,
};
