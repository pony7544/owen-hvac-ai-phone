const OpenAI = require("openai");

function createExtractionService(config = {}) {
  const {
    openaiApiKey,
    businessTimezone = "America/Halifax",
    getOrCreateCallSession,
    normalizePhone,
  } = config;

  const openai = new OpenAI({
    apiKey: openaiApiKey,
  });

  function normalizeExtractedFromModel(data = {}) {
    const preferredDate =
      typeof data.preferred_date === "string" ? data.preferred_date.trim() : "";
    const preferredTime =
      typeof data.preferred_time === "string" ? data.preferred_time.trim() : "";

    return {
      intent: typeof data.intent === "string" ? data.intent.trim() : "",
      callerName: typeof data.name === "string" ? data.name.trim() : "",
      callbackNumber:
        typeof data.phone === "string" && typeof normalizePhone === "function"
          ? normalizePhone(data.phone)
          : typeof data.phone === "string"
          ? data.phone.trim()
          : "",
      serviceAddress:
        typeof data.address === "string" ? data.address.trim() : "",
      issueSummary: typeof data.issue === "string" ? data.issue.trim() : "",
      preferredDate,
      preferredTime,
      preferredDateTime:
        preferredDate && preferredTime ? `${preferredDate} ${preferredTime}` : "",
      bookingConfirmed: Boolean(data.booking_confirmed),
    };
  }

  async function extractCallInfoWithOpenAI({ transcript, nowIso, timezone }) {
    const transcriptText = transcript
      .map((x) => `${x.role}: ${x.text}`)
      .join("\n");

    const response = await openai.responses.create({
      model: "gpt-4O-mini",
      input: [
        {
          role: "system",
          content: [
            {
              type: "input_text",
              text: `
You extract structured booking information from an HVAC phone call transcript.

Return only information clearly supported by the transcript.

Current datetime: ${nowIso}
Business timezone: ${timezone}

Rules:
- Return data matching the schema exactly.
- Use empty string for unknown text fields.
- Normalize preferred_date to YYYY-MM-DD when possible.
- Normalize preferred_time to HH:MM in 24-hour format when possible.
- booking_confirmed is true only if the caller clearly confirmed the booking summary or accepted the booking details.
- If the assistant only asks for confirmation, that does not mean confirmed.
- If the caller says "correct", "yes", "that's right", "正确", or equivalent after the summary, set booking_confirmed=true.
- intent must be one of:
  service_or_repair, quote_request, maintenance, new_installation, general_inquiry, other, or empty string.
              `.trim(),
            },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "input_text",
              text: transcriptText,
            },
          ],
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
              intent: { type: "string" },
              name: { type: "string" },
              phone: { type: "string" },
              address: { type: "string" },
              issue: { type: "string" },
              preferred_date: { type: "string" },
              preferred_time: { type: "string" },
              booking_confirmed: { type: "boolean" },
            },
            required: [
              "intent",
              "name",
              "phone",
              "address",
              "issue",
              "preferred_date",
              "preferred_time",
              "booking_confirmed",
            ],
          },
        },
      },
    });

    const raw = response.output_text || "{}";
    return JSON.parse(raw);
  }

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
      timezone: businessTimezone,
    });

    const normalized = normalizeExtractedFromModel(modelData);

    session.extracted.intent = normalized.intent;
    session.extracted.callerName = normalized.callerName;
    session.extracted.callbackNumber = normalized.callbackNumber;
    session.extracted.serviceAddress = normalized.serviceAddress;
    session.extracted.issueSummary = normalized.issueSummary;
    session.extracted.preferredDate = normalized.preferredDate;
    session.extracted.preferredTime = normalized.preferredTime;
    session.extracted.preferredDateTime = normalized.preferredDateTime;
    session.extracted.bookingConfirmed = normalized.bookingConfirmed;
    session.updatedAt = new Date().toISOString();

    return session.extracted;
  }

  async function refreshStructuredCallInfoDebounced(callSid, minIntervalMs = 1200) {
    if (typeof getOrCreateCallSession !== "function") {
      throw new Error("getOrCreateCallSession is required");
    }

    const session = getOrCreateCallSession(callSid);
    const now = Date.now();

    if (session.extractionInFlight) {
      return session.extracted;
    }

    if (now - session.lastExtractionAt < minIntervalMs) {
      return session.extracted;
    }

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

module.exports = {
  createExtractionService,
};
