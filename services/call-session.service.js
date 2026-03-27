const liveCalls = new Map();
const streamToCallSid = new Map();

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

function mergeRecordings(target, source) {
  if (!source?.recording) return;

  if (!target.recording) {
    target.recording = source.recording;
    return;
  }

  target.recording.callerChunks = [
    ...(target.recording.callerChunks || []),
    ...(source.recording.callerChunks || []),
  ];

  target.recording.assistantChunks = [
    ...(target.recording.assistantChunks || []),
    ...(source.recording.assistantChunks || []),
  ];

  target.recording.createdAt =
    target.recording.createdAt || source.recording.createdAt || "";

  target.recording.completedAt =
    target.recording.completedAt || source.recording.completedAt || "";

  target.recording.expiresAt =
    target.recording.expiresAt || source.recording.expiresAt || "";

  target.recording.deletedAt =
    target.recording.deletedAt || source.recording.deletedAt || "";

  target.recording.durationSec = Math.max(
    Number(target.recording.durationSec || 0),
    Number(source.recording.durationSec || 0)
  );

  target.recording.available =
    Boolean(target.recording.available) || Boolean(source.recording.available);

  target.recording.status =
    target.recording.status ||
    source.recording.status ||
    "recording";

  target.recording.fileName =
    target.recording.fileName || source.recording.fileName || "";

  target.recording.mimeType =
    target.recording.mimeType || source.recording.mimeType || "";

  target.recording.sampleRate =
    target.recording.sampleRate || source.recording.sampleRate || 8000;

  target.recording.channels =
    target.recording.channels || source.recording.channels || 1;
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

  target.lastAssistantText =
    target.lastAssistantText || source.lastAssistantText || "";

  target.extractionInFlight =
    target.extractionInFlight || source.extractionInFlight || false;

  target.lastExtractionAt = Math.max(
    target.lastExtractionAt || 0,
    source.lastExtractionAt || 0
  );

  target.mediaPacketCount =
    (target.mediaPacketCount || 0) + (source.mediaPacketCount || 0);

  const targetExtracted = target.extracted || createEmptyExtracted();
  const sourceExtracted = source.extracted || createEmptyExtracted();

  target.extracted = {
    ...sourceExtracted,
    ...targetExtracted,
    intent: targetExtracted.intent || sourceExtracted.intent || "",
    callerName: targetExtracted.callerName || sourceExtracted.callerName || "",
    callbackNumber:
      targetExtracted.callbackNumber || sourceExtracted.callbackNumber || "",
    serviceAddress:
      targetExtracted.serviceAddress || sourceExtracted.serviceAddress || "",
    issueSummary:
      targetExtracted.issueSummary || sourceExtracted.issueSummary || "",
    preferredDate:
      targetExtracted.preferredDate || sourceExtracted.preferredDate || "",
    preferredTime:
      targetExtracted.preferredTime || sourceExtracted.preferredTime || "",
    preferredDateTime:
      targetExtracted.preferredDateTime ||
      sourceExtracted.preferredDateTime ||
      "",
    bookingConfirmed:
      Boolean(targetExtracted.bookingConfirmed) ||
      Boolean(sourceExtracted.bookingConfirmed),
    appointmentCreated:
      Boolean(targetExtracted.appointmentCreated) ||
      Boolean(sourceExtracted.appointmentCreated),
    appointmentEventId:
      targetExtracted.appointmentEventId ||
      sourceExtracted.appointmentEventId ||
      "",
  };

  // 关键修复：把旧 session 上已经录到的 recording 一起迁移
  mergeRecordings(target, source);

  if (source.streamSid) {
    streamToCallSid.set(source.streamSid, targetSid);
  }

  liveCalls.delete(sourceSid);
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

  session.transcript.push({
    role,
    text: cleaned,
    ts: new Date().toISOString(),
  });

  session.updatedAt = new Date().toISOString();
}

function buildCallSummary(call) {
  const f = call.extracted || createEmptyExtracted();
  return {
    callSid: call.callSid,
    from: call.from || "",
    to: call.to || "",
    status: call.status || "",
    createdAt: call.createdAt || "",
    updatedAt: call.updatedAt || "",
    intent: f.intent || "",
    callerName: f.callerName || "",
    callbackNumber: f.callbackNumber || "",
    serviceAddress: f.serviceAddress || "",
    issueSummary: f.issueSummary || "",
    preferredDate: f.preferredDate || "",
    preferredTime: f.preferredTime || "",
    bookingConfirmed: !!f.bookingConfirmed,
    appointmentCreated: !!f.appointmentCreated,
    appointmentEventId: f.appointmentEventId || "",
  };
}

module.exports = {
  liveCalls,
  streamToCallSid,
  cleanText,
  normalizePhone,
  createEmptyExtracted,
  getOrCreateCallSession,
  mergeCallSessions,
  resolveStartCallSid,
  pushTranscript,
  buildCallSummary,
};
