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
