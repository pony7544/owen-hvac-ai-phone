// =============================================================
// services/extraction.service.js
// 用 gpt-4o-mini + JSON Schema 从对话记录中提取结构化预约信息
// =============================================================

const OpenAI = require("openai");
const { buildExtractionSystemPrompt } = require("../prompts");

function createExtractionService(config = {}) {
  const {
    openaiApiKey,
    businessTimezone = "America/Halifax",
    getOrCreateCallSession,
    normalizePhone,
    persistToRedis,
  } = config;

  const openai = new OpenAI({ apiKey: openaiApiKey });

  // ─── 标准化模型输出 ────────────────────────
  function normalizeExtractedFromModel(data = {}) {
    const preferredDate =
      typeof data.preferred_date === "string" ? data.preferred_date.trim() : "";
    const preferredTime =
      typeof data.preferred_time === "string" ? data.preferred_time.trim() : "";

    return {
      intent:          typeof data.intent   === "string" ? data.intent.trim()   : "",
      callerName:      typeof data.name     === "string" ? data.name.trim()     : "",
      callbackNumber:  typeof data.phone    === "string" && typeof normalizePhone === "function"
                         ? normalizePhone(data.phone)
                         : typeof data.phone === "string" ? data.phone.trim() : "",
      serviceAddress:  typeof data.address  === "string" ? data.address.trim()  : "",
      issueSummary:    typeof data.issue    === "string" ? data.issue.trim()    : "",
      preferredDate,
      preferredTime,
      preferredDateTime: preferredDate && preferredTime ? `${preferredDate} ${preferredTime}` : "",
      bookingConfirmed: Boolean(data.booking_confirmed),
    };
  }

  // ─── OpenAI 结构化抽取 ─────────────────────
  async function extractCallInfoWithOpenAI({ transcript, nowIso }) {
    const transcriptText = transcript
      .map((x) => `${x.role}: ${x.text}`)
      .join("\n");

    const response = await openai.responses.create({
      model: "gpt-4o-mini",
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: buildExtractionSystemPrompt(nowIso) }],
        },
        {
          role: "user",
          content: [{ type: "input_text", text: transcriptText }],
        },
      ],
      text: {
        format: {
          type: "json_schema",
          name: "call_info_extraction",
          strict: true,
          schema: {
            type: "object",
            additionalProperties: false,
            properties: {
              intent:           { type: "string" },
              name:             { type: "string" },
              phone:            { type: "string" },
              address:          { type: "string" },
              issue:            { type: "string" },
              preferred_date:   { type: "string" },
              preferred_time:   { type: "string" },
              booking_confirmed:{ type: "boolean" },
            },
            required: [
              "intent", "name", "phone", "address", "issue",
              "preferred_date", "preferred_time", "booking_confirmed",
            ],
          },
        },
      },
    });

    const raw = response.output_text || "{}";
    return JSON.parse(raw);
  }

  // ─── 写回 session ──────────────────────────
  async function refreshStructuredCallInfo(callSid) {
    if (typeof getOrCreateCallSession !== "function") {
      throw new Error("getOrCreateCallSession is required");
    }
    const session = getOrCreateCallSession(callSid);
    if (!session.transcript || session.transcript.length === 0) {
      return session.extracted;
    }

    const modelData = await extractCallInfoWithOpenAI({
      transcript: session.transcript,
      nowIso: new Date().toISOString(),
    });

    const normalized = normalizeExtractedFromModel(modelData);

    Object.assign(session.extracted, {
      intent:           normalized.intent,
      callerName:       normalized.callerName,
      callbackNumber:   normalized.callbackNumber,
      serviceAddress:   normalized.serviceAddress,
      issueSummary:     normalized.issueSummary,
      preferredDate:    normalized.preferredDate,
      preferredTime:    normalized.preferredTime,
      preferredDateTime:normalized.preferredDateTime,
      bookingConfirmed: normalized.bookingConfirmed,
    });
    session.updatedAt = new Date().toISOString();

    if (typeof persistToRedis === "function") {
      persistToRedis(callSid, session);
    }

    return session.extracted;
  }

  // ─── 防抖包装（同一通话最快 1200ms 触发一次）──
  async function refreshStructuredCallInfoDebounced(callSid, minIntervalMs = 1200) {
    if (typeof getOrCreateCallSession !== "function") {
      throw new Error("getOrCreateCallSession is required");
    }
    const session = getOrCreateCallSession(callSid);
    const now = Date.now();

    if (session.extractionInFlight) return session.extracted;
    if (now - session.lastExtractionAt < minIntervalMs) return session.extracted;

    session.extractionInFlight = true;
    session.lastExtractionAt = now;
    try {
      return await refreshStructuredCallInfo(callSid);
    } finally {
      session.extractionInFlight = false;
    }
  }

  return {
    normalizeExtractedFromModel,
    extractCallInfoWithOpenAI,
    refreshStructuredCallInfo,
    refreshStructuredCallInfoDebounced,
  };
}

module.exports = { createExtractionService };
