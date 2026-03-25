require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const session = require("express-session");
const { google } = require("googleapis");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "replace_this_session_secret",
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: "lax",
      secure: false,
      maxAge: 1000 * 60 * 60 * 12, // 12 hours
    },
  })
);

app.use("/public", express.static(path.join(__dirname, "public")));
app.use(express.static(path.join(__dirname, "public")));

const PORT = process.env.PORT || 10000;

// =========================
// ENV
// =========================
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const BUSINESS_NAME = process.env.BUSINESS_NAME || "Owen HVAC Corp";
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || "";
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/Halifax";
const DEFAULT_APPOINTMENT_MINUTES = parseInt(
  process.env.DEFAULT_APPOINTMENT_MINUTES || "60",
  10
);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN;
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

const LIVE_ADMIN_USER = process.env.LIVE_ADMIN_USER || "admin";
const LIVE_ADMIN_PASS = process.env.LIVE_ADMIN_PASS || "ChangeThisPassword123!";

if (!OPENAI_API_KEY) {
  console.warn("Missing OPENAI_API_KEY");
}

// =========================
// OpenAI SDK
// =========================
const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

// =========================
// Google Calendar
// =========================
const oauth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET
);

oauth2Client.setCredentials({
  refresh_token: GOOGLE_REFRESH_TOKEN,
});

const calendar = google.calendar({
  version: "v3",
  auth: oauth2Client,
});

// =========================
// In-memory call store
// =========================
const liveCalls = new Map();
const streamToCallSid = new Map();

/*
liveCalls[callSid] = {
  callSid,
  streamSid,
  from,
  to,
  status,
  createdAt,
  updatedAt,
  transcript: [],
  lastAssistantText: "",
  extractionInFlight: false,
  lastExtractionAt: 0,
  mediaPacketCount: 0,

  extracted: {
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
  },

  conversationState: {
    mode: "collecting_info",
    availabilityChecked: false,
    availableSlots: [],
    currentSlotIndex: 0,
    selectedSlot: null,
    bookingInProgress: false,
    lastOfferedSlotStart: "",
    needsBackendResponse: false,
    lastCallerUtterance: "",
    lastBackendPrompt: "",
  }
}
*/

// =========================
// Helpers
// =========================
function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^\d+]/g, "").trim();
}

function getTodayDateInBusinessTimezone() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);

  const year = parts.find((p) => p.type === "year")?.value || "2026";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";

  return `${year}-${month}-${day}`;
}

function formatSlotForSpeech(isoString, timeZone = BUSINESS_TIMEZONE) {
  const date = new Date(isoString);

  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    weekday: "long",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(date);
}

function detectSlotAnswer(text = "") {
  const t = cleanText(text).toLowerCase();

  const yesWords = [
    "yes",
    "yeah",
    "yep",
    "ok",
    "okay",
    "sure",
    "that works",
    "works for me",
    "sounds good",
    "good",
    "fine",
    "correct",
    "that's right",
  ];

  const noWords = [
    "no",
    "nope",
    "not that time",
    "doesn't work",
    "does not work",
    "can't",
    "cannot",
    "not available",
    "another time",
    "something else",
    "different time",
  ];

  if (yesWords.some((word) => t.includes(word))) return "yes";
  if (noWords.some((word) => t.includes(word))) return "no";
  return "unknown";
}

function isLikelyBookingIntent(intent = "") {
  return [
    "service_or_repair",
    "quote_request",
    "maintenance",
    "new_installation",
  ].includes(intent);
}

function hasMinimumCustomerInfo(extracted = {}) {
  return Boolean(
    cleanText(extracted.callerName) &&
      cleanText(extracted.callbackNumber) &&
      cleanText(extracted.serviceAddress) &&
      cleanText(extracted.issueSummary)
  );
}

function createConversationState() {
  return {
    mode: "collecting_info",
    availabilityChecked: false,
    availableSlots: [],
    currentSlotIndex: 0,
    selectedSlot: null,
    bookingInProgress: false,
    lastOfferedSlotStart: "",
    needsBackendResponse: false,
    lastCallerUtterance: "",
    lastBackendPrompt: "",
  };
}

function ensureConversationState(call) {
  if (!call.conversationState) {
    call.conversationState = createConversationState();
  }
  return call.conversationState;
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
      extracted: {
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
      },
      conversationState: createConversationState(),
    });
  }

  const call = liveCalls.get(callSid);
  ensureConversationState(call);
  return call;
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

  target.extracted = {
    ...source.extracted,
    ...target.extracted,
    intent: target.extracted.intent || source.extracted.intent || "",
    callerName: target.extracted.callerName || source.extracted.callerName || "",
    callbackNumber:
      target.extracted.callbackNumber || source.extracted.callbackNumber || "",
    serviceAddress:
      target.extracted.serviceAddress || source.extracted.serviceAddress || "",
    issueSummary:
      target.extracted.issueSummary || source.extracted.issueSummary || "",
    preferredDate:
      target.extracted.preferredDate || source.extracted.preferredDate || "",
    preferredTime:
      target.extracted.preferredTime || source.extracted.preferredTime || "",
    preferredDateTime:
      target.extracted.preferredDateTime ||
      source.extracted.preferredDateTime ||
      "",
    bookingConfirmed:
      Boolean(target.extracted.bookingConfirmed) ||
      Boolean(source.extracted.bookingConfirmed),
    appointmentCreated:
      Boolean(target.extracted.appointmentCreated) ||
      Boolean(source.extracted.appointmentCreated),
    appointmentEventId:
      target.extracted.appointmentEventId ||
      source.extracted.appointmentEventId ||
      "",
  };

  const targetCs = ensureConversationState(target);
  const sourceCs = ensureConversationState(source);

  targetCs.mode =
    targetCs.mode && targetCs.mode !== "collecting_info"
      ? targetCs.mode
      : sourceCs.mode;
  targetCs.availabilityChecked =
    targetCs.availabilityChecked || sourceCs.availabilityChecked;
  targetCs.availableSlots =
    targetCs.availableSlots?.length > 0
      ? targetCs.availableSlots
      : sourceCs.availableSlots || [];
  targetCs.currentSlotIndex = Math.max(
    targetCs.currentSlotIndex || 0,
    sourceCs.currentSlotIndex || 0
  );
  targetCs.selectedSlot = targetCs.selectedSlot || sourceCs.selectedSlot || null;
  targetCs.bookingInProgress =
    targetCs.bookingInProgress || sourceCs.bookingInProgress;
  targetCs.lastOfferedSlotStart =
    targetCs.lastOfferedSlotStart || sourceCs.lastOfferedSlotStart || "";
  targetCs.needsBackendResponse =
    targetCs.needsBackendResponse || sourceCs.needsBackendResponse;
  targetCs.lastCallerUtterance =
    targetCs.lastCallerUtterance || sourceCs.lastCallerUtterance || "";
  targetCs.lastBackendPrompt =
    targetCs.lastBackendPrompt || sourceCs.lastBackendPrompt || "";

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
  const f = call.extracted || {};
  const cs = ensureConversationState(call);

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
    conversationMode: cs.mode || "",
    currentSlotIndex: cs.currentSlotIndex || 0,
    availableSlotCount: Array.isArray(cs.availableSlots)
      ? cs.availableSlots.length
      : 0,
    lastOfferedSlotStart: cs.lastOfferedSlotStart || "",
  };
}

function isValidIsoDate(s) {
  return /^\d{4}-\d{2}-\d{2}$/.test(s);
}

function isValidHHMM(s) {
  return /^\d{2}:\d{2}$/.test(s);
}

function parsePreferredDateTime(dateRaw, timeRaw, timezone = BUSINESS_TIMEZONE) {
  if (!dateRaw || !timeRaw) return null;
  if (!isValidIsoDate(dateRaw)) return null;
  if (!isValidHHMM(timeRaw)) return null;

  const start = new Date(`${dateRaw}T${timeRaw}:00`);
  if (Number.isNaN(start.getTime())) return null;

  const end = new Date(start.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);

  return {
    start,
    end,
    timezone,
  };
}

function requireLiveAuth(req, res, next) {
  if (req.session && req.session.liveAuthed) {
    return next();
  }
  return res.redirect("/login");
}

function requireApiAuth(req, res, next) {
  if (req.session && req.session.liveAuthed) {
    return next();
  }
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

// =========================
// Calendar helpers
// =========================
async function testCalendarConnection() {
  const res = await calendar.calendars.get({
    calendarId: GOOGLE_CALENDAR_ID,
  });
  return res.data;
}

async function listEventsForDay(dateStr) {
  const dayStart = new Date(`${dateStr}T00:00:00`);
  const dayEnd = new Date(`${dateStr}T23:59:59`);

  const res = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    timeMin: dayStart.toISOString(),
    timeMax: dayEnd.toISOString(),
    singleEvents: true,
    orderBy: "startTime",
  });

  return res.data.items || [];
}

function generateSlotsForDay(dateStr, events, slotMinutes = 120) {
  const slots = [];
  const workStart = new Date(`${dateStr}T08:00:00`);
  const workEnd = new Date(`${dateStr}T18:00:00`);

  let cursor = new Date(workStart);

  while (cursor < workEnd) {
    const slotStart = new Date(cursor);
    const slotEnd = new Date(cursor.getTime() + slotMinutes * 60000);

    const overlaps = events.some((evt) => {
      if (!evt.start?.dateTime || !evt.end?.dateTime) return false;
      const evtStart = new Date(evt.start.dateTime);
      const evtEnd = new Date(evt.end.dateTime);
      return slotStart < evtEnd && slotEnd > evtStart;
    });

    if (!overlaps && slotEnd <= workEnd) {
      slots.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
      });
    }

    cursor = new Date(cursor.getTime() + slotMinutes * 60000);
  }

  return slots;
}

function getCurrentOfferedSlot(callSid) {
  const session = getOrCreateCallSession(callSid);
  const cs = ensureConversationState(session);

  if (!Array.isArray(cs.availableSlots) || cs.availableSlots.length === 0) {
    return null;
  }

  return cs.availableSlots[cs.currentSlotIndex] || null;
}

function advanceToNextSlot(callSid) {
  const session = getOrCreateCallSession(callSid);
  const cs = ensureConversationState(session);

  cs.currentSlotIndex += 1;

  if (
    !Array.isArray(cs.availableSlots) ||
    cs.currentSlotIndex >= cs.availableSlots.length
  ) {
    return null;
  }

  return cs.availableSlots[cs.currentSlotIndex];
}

async function findNextAvailableSlots(callSid, daysToCheck = 5, maxSlots = 5) {
  const session = getOrCreateCallSession(callSid);
  const cs = ensureConversationState(session);

  const collected = [];

  for (let offset = 0; offset < daysToCheck; offset += 1) {
    const base = new Date();
    base.setDate(base.getDate() + offset);

    const yyyy = base.getFullYear();
    const mm = String(base.getMonth() + 1).padStart(2, "0");
    const dd = String(base.getDate()).padStart(2, "0");
    const dateStr = `${yyyy}-${mm}-${dd}`;

    const events = await listEventsForDay(dateStr);
    const slots = generateSlotsForDay(dateStr, events, DEFAULT_APPOINTMENT_MINUTES);

    for (const slot of slots) {
      collected.push(slot);
      if (collected.length >= maxSlots) {
        break;
      }
    }

    if (collected.length >= maxSlots) {
      break;
    }
  }

  cs.availableSlots = collected;
  cs.currentSlotIndex = 0;
  cs.availabilityChecked = true;
  return collected;
}

function buildSlotOfferPrompt(callSid) {
  const session = getOrCreateCallSession(callSid);
  const cs = ensureConversationState(session);
  const slot = getCurrentOfferedSlot(callSid);

  if (!slot) {
    cs.mode = "no_slots_available";
    return "Thank you. I have your information, but I do not see a nearby appointment time available right now. We will follow up with you as soon as possible.";
  }

  cs.mode = "offering_slot";
  cs.lastOfferedSlotStart = slot.start;
  const spokenTime = formatSlotForSpeech(slot.start);

  return `Our earliest available appointment is ${spokenTime}. Would that work for you?`;
}

function buildNextSlotPrompt(callSid) {
  const session = getOrCreateCallSession(callSid);
  const cs = ensureConversationState(session);
  const nextSlot = advanceToNextSlot(callSid);

  if (!nextSlot) {
    cs.mode = "no_slots_available";
    return "No problem. I do not have another nearby opening available right now. We will follow up with you to arrange a time.";
  }

  cs.mode = "offering_slot";
  cs.lastOfferedSlotStart = nextSlot.start;
  const spokenTime = formatSlotForSpeech(nextSlot.start);

  return `No problem. I also have ${spokenTime}. Would that work better for you?`;
}

async function createAppointmentEventFromSelectedSlot(callSid) {
  const session = getOrCreateCallSession(callSid);
  const cs = ensureConversationState(session);
  const f = session.extracted;
  const slot = getCurrentOfferedSlot(callSid);

  if (!slot) {
    throw new Error("No offered slot available to book.");
  }

  cs.bookingInProgress = true;
  cs.selectedSlot = slot;

  const event = {
    summary: `Service Call - ${f.callerName || "Customer"}`,
    location: f.serviceAddress || "",
    description: [
      `Customer Name: ${f.callerName || ""}`,
      `Phone: ${f.callbackNumber || ""}`,
      `Address: ${f.serviceAddress || ""}`,
      `Issue: ${f.issueSummary || ""}`,
      `Call SID: ${callSid}`,
      `Booked by AI phone assistant for ${BUSINESS_NAME}.`,
    ].join("\n"),
    start: {
      dateTime: slot.start,
      timeZone: BUSINESS_TIMEZONE,
    },
    end: {
      dateTime: slot.end,
      timeZone: BUSINESS_TIMEZONE,
    },
  };

  const res = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: event,
  });

  session.extracted.appointmentCreated = true;
  session.extracted.appointmentEventId = res.data.id || "";
  session.extracted.bookingConfirmed = true;
  session.extracted.preferredDate = slot.start.slice(0, 10);

  const localTime = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(slot.start));

  session.extracted.preferredTime = localTime;
  session.extracted.preferredDateTime = `${session.extracted.preferredDate} ${localTime}`;

  cs.bookingInProgress = false;
  cs.mode = "completed";
  session.updatedAt = new Date().toISOString();

  return res.data;
}

async function createAppointmentEvent(callSid) {
  const session = getOrCreateCallSession(callSid);
  const cs = ensureConversationState(session);

  if (cs.selectedSlot || getCurrentOfferedSlot(callSid)) {
    return await createAppointmentEventFromSelectedSlot(callSid);
  }

  const f = session.extracted;
  const parsed = parsePreferredDateTime(f.preferredDate, f.preferredTime);
  if (!parsed) {
    throw new Error("Unable to parse normalized preferred date/time.");
  }

  const event = {
    summary: `Service Call - ${f.callerName || "Customer"}`,
    location: f.serviceAddress || "",
    description: [
      `Customer Name: ${f.callerName || ""}`,
      `Phone: ${f.callbackNumber || ""}`,
      `Address: ${f.serviceAddress || ""}`,
      `Issue: ${f.issueSummary || ""}`,
      `Call SID: ${callSid}`,
      `Booked by AI phone assistant for ${BUSINESS_NAME}.`,
    ].join("\n"),
    start: {
      dateTime: parsed.start.toISOString(),
      timeZone: parsed.timezone,
    },
    end: {
      dateTime: parsed.end.toISOString(),
      timeZone: parsed.timezone,
    },
  };

  const res = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: event,
  });

  session.extracted.appointmentCreated = true;
  session.extracted.appointmentEventId = res.data.id || "";
  session.updatedAt = new Date().toISOString();

  return res.data;
}

async function maybeAutoCreateAppointment(callSid) {
  const session = getOrCreateCallSession(callSid);
  const f = session.extracted;
  const cs = ensureConversationState(session);

  if (f.appointmentCreated) return null;

  if (cs.mode === "completed") return null;

  if (cs.selectedSlot && f.bookingConfirmed && !f.appointmentCreated) {
    return await createAppointmentEventFromSelectedSlot(callSid);
  }

  if (!f.bookingConfirmed) return null;

  if (
    !f.callerName ||
    !f.callbackNumber ||
    !f.serviceAddress ||
    !f.issueSummary ||
    !f.preferredDate ||
    !f.preferredTime
  ) {
    return null;
  }

  return await createAppointmentEvent(callSid);
}

// =========================
// Structured extraction
// =========================
function normalizeExtractedFromModel(data = {}) {
  const preferredDate =
    typeof data.preferred_date === "string" ? data.preferred_date.trim() : "";
  const preferredTime =
    typeof data.preferred_time === "string" ? data.preferred_time.trim() : "";

  return {
    intent: typeof data.intent === "string" ? data.intent.trim() : "",
    callerName: typeof data.name === "string" ? data.name.trim() : "",
    callbackNumber:
      typeof data.phone === "string" ? normalizePhone(data.phone) : "",
    serviceAddress:
      typeof data.address === "string" ? data.address.trim() : "",
    issueSummary:
      typeof data.issue === "string" ? data.issue.trim() : "",
    preferredDate,
    preferredTime,
    preferredDateTime:
      preferredDate && preferredTime ? `${preferredDate} ${preferredTime}` : "",
    bookingConfirmed: Boolean(data.booking_confirmed),
  };
}

async function extractCallInfoWithOpenAI({ transcript, nowIso, timezone }) {
  const transcriptText = transcript.map((x) => `${x.role}: ${x.text}`).join("\n");

  const response = await openai.responses.create({
    model: "gpt-5-mini",
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
  const session = getOrCreateCallSession(callSid);

  if (!session.transcript || session.transcript.length === 0) {
    return session.extracted;
  }

  const modelData = await extractCallInfoWithOpenAI({
    transcript: session.transcript,
    nowIso: new Date().toISOString(),
    timezone: BUSINESS_TIMEZONE,
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

// =========================
// Backend conversation control
// =========================
async function handleBackendConversationStep(callSid) {
  const session = getOrCreateCallSession(callSid);
  const f = session.extracted;
  const cs = ensureConversationState(session);

  // 记录最近一句用户话（用于 yes/no 判断）
  const lastUser = session.transcript
    .filter((t) => t.role === "user")
    .slice(-1)[0];

  if (lastUser) {
    cs.lastCallerUtterance = lastUser.text;
  }

  // =========================
  // 1. 收集信息阶段
  // =========================
  if (cs.mode === "collecting_info") {
    if (isLikelyBookingIntent(f.intent) && hasMinimumCustomerInfo(f)) {
      const slots = await findNextAvailableSlots(callSid);

      if (!slots || slots.length === 0) {
        cs.mode = "no_slots_available";
        return "Thank you. I have your information, but I do not see any available appointment times right now. We will follow up shortly.";
      }

      return buildSlotOfferPrompt(callSid);
    }

    return null; // 继续让AI收集信息
  }

  // =========================
  // 2. 报时间阶段
  // =========================
  if (cs.mode === "offering_slot") {
    const answer = detectSlotAnswer(cs.lastCallerUtterance);

    if (answer === "yes") {
      try {
        await createAppointmentEventFromSelectedSlot(callSid);

        const slot = cs.selectedSlot;
        const spokenTime = formatSlotForSpeech(slot.start);

        return `Great, you’re booked for ${spokenTime}. Thank you for calling ${BUSINESS_NAME}.`;
      } catch (err) {
        console.error("Booking failed:", err);
        cs.mode = "failed";
        return "I’m sorry, I couldn’t complete the booking right now. We will follow up with you shortly.";
      }
    }

    if (answer === "no") {
      return buildNextSlotPrompt(callSid);
    }

    return "Would that appointment time work for you?";
  }

  return null;
}

// =========================
// Twilio Voice Webhook
// =========================
app.post("/voice", (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const to = req.body.To;

  const call = getOrCreateCallSession(callSid);
  call.from = from;
  call.to = to;
  call.status = "in-progress";

  const twiml = `
<Response>
  <Connect>
    <Stream url="wss://${req.headers.host}/media-stream" />
  </Connect>
</Response>
`;

  res.type("text/xml");
  res.send(twiml);
});

// =========================
// WebSocket (Twilio Media Stream)
// =========================
const wss = new WebSocket.Server({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  let callSid = "";

  ws.on("message", async (message) => {
    const data = JSON.parse(message.toString());

    if (data.event === "start") {
      callSid = resolveStartCallSid(data.start);

      const call = getOrCreateCallSession(callSid);
      call.streamSid = data.start.streamSid;

      streamToCallSid.set(data.start.streamSid, callSid);
    }

    if (data.event === "media") {
      // 不处理音频，这里只用 transcript
    }

    if (data.event === "stop") {
      if (callSid && liveCalls.has(callSid)) {
        liveCalls.get(callSid).status = "completed";
      }
    }
  });
});

// =========================
// OpenAI Realtime (文本桥接)
// =========================
app.post("/realtime-input", async (req, res) => {
  try {
    const { callSid, text } = req.body;

    if (!callSid || !text) {
      return res.json({ ok: false });
    }

    pushTranscript(callSid, "user", text);

    await refreshStructuredCallInfoDebounced(callSid);

    const backendReply = await handleBackendConversationStep(callSid);

    if (backendReply) {
      pushTranscript(callSid, "assistant", backendReply);
      return res.json({
        ok: true,
        reply: backendReply,
        source: "backend",
      });
    }

    // fallback：让AI继续说
    return res.json({
      ok: true,
      reply: null,
      source: "ai",
    });
  } catch (err) {
    console.error(err);
    res.json({ ok: false });
  }
});

// =========================
// Calendar APIs
// =========================
app.get("/test/calendar", async (req, res) => {
  try {
    const data = await testCalendarConnection();
    res.json({ ok: true, calendar: data });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get("/appointments/availability", async (req, res) => {
  try {
    const date = req.query.date || getTodayDateInBusinessTimezone();

    const events = await listEventsForDay(date);
    const slots = generateSlotsForDay(
      date,
      events,
      DEFAULT_APPOINTMENT_MINUTES
    );

    res.json({
      ok: true,
      date,
      slots,
    });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

// =========================
// Admin (可选)
// =========================
app.get("/api/calls", requireApiAuth, (req, res) => {
  const calls = Array.from(liveCalls.values()).map(buildCallSummary);
  res.json({ ok: true, calls });
});

// =========================
// Start Server
// =========================
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
