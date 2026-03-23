require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const { google } = require("googleapis");
const OpenAI = require("openai");

const app = express();
const server = http.createServer(app);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
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
// In-memory session store
// production建议换Redis
// =========================
const liveCalls = new Map();
/*
liveCalls[callSid] = {
  callSid,
  streamSid,
  transcript: [],
  lastAssistantText: "",
  lastCallerText: "",
  extractionInFlight: false,
  lastExtractionAt: 0,
  extracted: {
    intent: "",
    name: "",
    phone: "",
    address: "",
    issue: "",
    preferredDateRaw: "",   // YYYY-MM-DD
    preferredTimeRaw: "",   // HH:MM
    bookingConfirmed: false,
    appointmentCreated: false,
    appointmentEventId: "",
  }
}
*/

// =========================
// Helpers
// =========================
function getOrCreateCallSession(callSid) {
  if (!liveCalls.has(callSid)) {
    liveCalls.set(callSid, {
      callSid,
      streamSid: "",
      transcript: [],
      lastAssistantText: "",
      lastCallerText: "",
      extractionInFlight: false,
      lastExtractionAt: 0,
      extracted: {
        intent: "",
        name: "",
        phone: "",
        address: "",
        issue: "",
        preferredDateRaw: "",
        preferredTimeRaw: "",
        bookingConfirmed: false,
        appointmentCreated: false,
        appointmentEventId: "",
      },
    });
  }
  return liveCalls.get(callSid);
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^\d+]/g, "").trim();
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
}

function buildCallSummary(extracted) {
  return [
    `Intent: ${extracted.intent || ""}`,
    `Name: ${extracted.name || ""}`,
    `Callback: ${extracted.phone || ""}`,
    `Address: ${extracted.address || ""}`,
    `Issue: ${extracted.issue || ""}`,
    `Preferred Date: ${extracted.preferredDateRaw || ""}`,
    `Preferred Time: ${extracted.preferredTimeRaw || ""}`,
    `Confirmed: ${extracted.bookingConfirmed ? "yes" : "no"}`,
    `Appointment Created: ${extracted.appointmentCreated ? "yes" : "no"}`,
    `Event ID: ${extracted.appointmentEventId || ""}`,
  ].join(" | ");
}

function mergeManualUpdate(target, incoming) {
  const allowed = [
    "intent",
    "name",
    "phone",
    "address",
    "issue",
    "preferredDateRaw",
    "preferredTimeRaw",
    "bookingConfirmed",
  ];

  for (const key of allowed) {
    if (incoming[key] !== undefined && incoming[key] !== null) {
      target[key] = incoming[key];
    }
  }
}

function normalizeExtractedFromModel(data = {}) {
  const intent =
    typeof data.intent === "string" ? data.intent.trim() : "";
  const name =
    typeof data.name === "string" ? data.name.trim() : "";
  const phone =
    typeof data.phone === "string" ? normalizePhone(data.phone) : "";
  const address =
    typeof data.address === "string" ? data.address.trim() : "";
  const issue =
    typeof data.issue === "string" ? data.issue.trim() : "";
  const preferredDateRaw =
    typeof data.preferred_date === "string" ? data.preferred_date.trim() : "";
  const preferredTimeRaw =
    typeof data.preferred_time === "string" ? data.preferred_time.trim() : "";

  return {
    intent,
    name,
    phone,
    address,
    issue,
    preferredDateRaw,
    preferredTimeRaw,
    bookingConfirmed: Boolean(data.booking_confirmed),
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

async function createAppointmentEvent({
  name,
  phone,
  address,
  issue,
  preferredDateRaw,
  preferredTimeRaw,
}) {
  const parsed = parsePreferredDateTime(preferredDateRaw, preferredTimeRaw);
  if (!parsed) {
    throw new Error("Unable to parse normalized preferred date/time.");
  }

  const event = {
    summary: `Service Call - ${name || "Customer"}`,
    location: address || "",
    description: [
      `Customer Name: ${name || ""}`,
      `Phone: ${phone || ""}`,
      `Address: ${address || ""}`,
      `Issue: ${issue || ""}`,
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

  return res.data;
}

async function maybeAutoCreateAppointment(callSid) {
  const session = getOrCreateCallSession(callSid);
  const ex = session.extracted;

  if (ex.appointmentCreated) return null;
  if (!ex.bookingConfirmed) return null;

  if (
    !ex.name ||
    !ex.phone ||
    !ex.address ||
    !ex.issue ||
    !ex.preferredDateRaw ||
    !ex.preferredTimeRaw
  ) {
    return null;
  }

  const created = await createAppointmentEvent({
    name: ex.name,
    phone: ex.phone,
    address: ex.address,
    issue: ex.issue,
    preferredDateRaw: ex.preferredDateRaw,
    preferredTimeRaw: ex.preferredTimeRaw,
  });

  ex.appointmentCreated = true;
  ex.appointmentEventId = created.id || "";

  return created;
}

// =========================
// Structured extraction
// =========================
async function extractCallInfoWithOpenAI({ transcript, nowIso, timezone }) {
  const transcriptText = transcript
    .map((x) => `${x.role}: ${x.text}`)
    .join("\n");

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
  service_or_repair, quote_request, maintenance, general_inquiry, other, or empty string.
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
  session.extracted.name = normalized.name;
  session.extracted.phone = normalized.phone;
  session.extracted.address = normalized.address;
  session.extracted.issue = normalized.issue;
  session.extracted.preferredDateRaw = normalized.preferredDateRaw;
  session.extracted.preferredTimeRaw = normalized.preferredTimeRaw;
  session.extracted.bookingConfirmed = normalized.bookingConfirmed;

  return session.extracted;
}

async function refreshStructuredCallInfoDebounced(callSid, minIntervalMs = 1000) {
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
    const extracted = await refreshStructuredCallInfo(callSid);
    return extracted;
  } finally {
    session.extractionInFlight = false;
  }
}

// =========================
// Realtime dashboard API
// =========================
app.get("/api/live-call/:callSid", (req, res) => {
  const callSid = req.params.callSid;
  const session = liveCalls.get(callSid);

  if (!session) {
    return res.status(404).json({ ok: false, error: "Call not found" });
  }

  return res.json({
    ok: true,
    callSid: session.callSid,
    streamSid: session.streamSid,
    transcript: session.transcript,
    extracted: session.extracted,
    callSummary: buildCallSummary(session.extracted),
  });
});

// =========================
// Health
// =========================
app.get("/", (req, res) => {
  res.send("Owen HVAC AI phone server is running.");
});

// =========================
// Calendar APIs
// =========================
app.get("/test/calendar", async (req, res) => {
  try {
    const data = await testCalendarConnection();
    res.json({ ok: true, calendar: data });
  } catch (err) {
    console.error("Calendar test error:", err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Calendar connection failed",
    });
  }
});

app.get("/appointments/availability", async (req, res) => {
  try {
    const date = req.query.date;
    if (!date) {
      return res.status(400).json({ ok: false, error: "Missing date" });
    }

    const events = await listEventsForDay(date);
    const slots = generateSlotsForDay(date, events, 120);

    res.json({
      ok: true,
      date,
      timezone: BUSINESS_TIMEZONE,
      slots,
    });
  } catch (err) {
    console.error("Availability error:", err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to get availability",
    });
  }
});

app.post("/appointments", async (req, res) => {
  try {
    const {
      name,
      phone,
      address,
      issue,
      preferredDateRaw,
      preferredTimeRaw,
    } = req.body;

    const event = await createAppointmentEvent({
      name,
      phone,
      address,
      issue,
      preferredDateRaw,
      preferredTimeRaw,
    });

    res.json({
      ok: true,
      eventId: event.id,
      htmlLink: event.htmlLink,
      event,
    });
  } catch (err) {
    console.error("Create appointment error:", err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to create appointment",
    });
  }
});

// =========================
// Twilio voice webhook
// =========================
app.post("/twilio/voice", (req, res) => {
  const callSid = req.body.CallSid || `call_${Date.now()}`;
  getOrCreateCallSession(callSid);

  const wsUrl = process.env.PUBLIC_WSS_URL || process.env.RENDER_EXTERNAL_URL;
  if (!wsUrl) {
    return res
      .status(500)
      .send("Missing PUBLIC_WSS_URL or RENDER_EXTERNAL_URL in environment.");
  }

  const streamUrl = wsUrl.startsWith("https://")
    ? wsUrl.replace("https://", "wss://")
    : wsUrl.startsWith("http://")
    ? wsUrl.replace("http://", "ws://")
    : wsUrl;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">Hello, thank you for calling ${BUSINESS_NAME}. Please hold while I connect you.</Say>
  <Connect>
    <Stream url="${streamUrl}/media-stream?callSid=${encodeURIComponent(callSid)}" />
  </Connect>
</Response>`;

  res.type("text/xml").send(twiml);
});

// =========================
// WebSocket server
// =========================
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { url } = request;
  if (url.startsWith("/media-stream")) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (twilioWs, request) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  const callSid = urlObj.searchParams.get("callSid") || `call_${Date.now()}`;
  const session = getOrCreateCallSession(callSid);

  console.log(`Twilio media stream connected: ${callSid}`);

  let streamSid = "";

  const openaiWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("Connected to OpenAI Realtime");

    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `
You are the phone receptionist for ${BUSINESS_NAME}, an HVAC company.

Your job is to speak naturally and help callers with:
- service
- repair
- maintenance
- installation quote requests
- general HVAC questions

Conversation goals:
1. Understand the caller's intent.
2. Collect, if relevant:
   - full name
   - callback number
   - full service address
   - short issue summary
   - preferred appointment date
   - preferred appointment time
3. Read the details back clearly for confirmation.
4. If the caller confirms, let them know the request has been recorded and a team member will follow up.

Rules:
- Keep responses short and phone-friendly.
- Ask one thing at a time when information is missing.
- Do not invent customer details.
- Use English unless the caller speaks another language.
- Do not output JSON to the caller.
- Speak naturally as a receptionist.
        `.trim(),
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
        },
      },
    };

    openaiWs.send(JSON.stringify(sessionUpdate));

    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: "Greet the caller and ask how you can help today.",
        },
      })
    );
  });

  openaiWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 音频回传给Twilio
      if (data.type === "response.audio.delta" && data.delta) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: {
              payload: data.delta,
            },
          })
        );
      }

      // assistant文本增量
      if (data.type === "response.output_text.delta" && data.delta) {
        session.lastAssistantText += data.delta;
      }

      // assistant一轮说完
      if (data.type === "response.done") {
        const assistantText = cleanText(session.lastAssistantText);

        if (assistantText) {
          pushTranscript(callSid, "assistant", assistantText);
          console.log("Assistant:", assistantText);
          session.lastAssistantText = "";

          try {
            const extracted = await refreshStructuredCallInfoDebounced(callSid);
            console.log("Structured extracted after assistant:", extracted);
          } catch (err) {
            console.error(
              "Structured extraction after assistant failed:",
              err?.message || err
            );
          }

          try {
            const created = await maybeAutoCreateAppointment(callSid);
            if (created) {
              console.log("✅ Appointment created:", created.id);
            }
          } catch (err) {
            console.error("Auto-create appointment failed:", err?.message || err);
          }
        }
      }

      // 可选：如果Realtime返回用户转写事件，抓进去
      if (
        data.type === "conversation.item.input_audio_transcription.completed" &&
        data.transcript
      ) {
        const callerText = cleanText(data.transcript);
        if (callerText) {
          pushTranscript(callSid, "caller", callerText);
          console.log("Caller:", callerText);

          try {
            const extracted = await refreshStructuredCallInfoDebounced(callSid);
            console.log("Structured extracted after caller:", extracted);
          } catch (err) {
            console.error(
              "Structured extraction after caller failed:",
              err?.message || err
            );
          }

          try {
            const created = await maybeAutoCreateAppointment(callSid);
            if (created) {
              console.log("✅ Appointment created:", created.id);
            }
          } catch (err) {
            console.error(
              "Auto-create appointment after caller failed:",
              err?.message || err
            );
          }
        }
      }
    } catch (err) {
      console.error("OpenAI message parse error:", err?.message || err);
    }
  });

  openaiWs.on("close", () => {
    console.log("OpenAI WS closed");
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err?.message || err);
  });

  twilioWs.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start":
          streamSid = data.start.streamSid;
          session.streamSid = streamSid;
          console.log("Twilio stream started:", streamSid);
          break;

        case "media":
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              })
            );
          }
          break;

        case "stop":
          console.log("Twilio stream stopped:", callSid);
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
          break;

        default:
          break;
      }
    } catch (err) {
      console.error("Twilio message error:", err?.message || err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed:", callSid);
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WS error:", err?.message || err);
  });
});
app.post("/twilio/voice/status", (req, res) => {
  console.log("📞 Twilio Status Callback:", req.body);

  // 你可以在这里记录通话状态
  // 例如：
  // CallSid
  // CallStatus (queued, ringing, in-progress, completed)
  // From / To

  res.sendStatus(200); // 很关键，必须返回 200
});
// =========================
// Manual update endpoint
// =========================
app.post("/api/live-call/:callSid/update", async (req, res) => {
  try {
    const callSid = req.params.callSid;
    const session = getOrCreateCallSession(callSid);

    mergeManualUpdate(session.extracted, req.body);

    if (req.body.phone) {
      session.extracted.phone = normalizePhone(req.body.phone);
    }

    let created = null;
    try {
      created = await maybeAutoCreateAppointment(callSid);
    } catch (err) {
      console.error("Manual update auto-create failed:", err?.message || err);
    }

    res.json({
      ok: true,
      extracted: session.extracted,
      createdEventId: created?.id || null,
      callSummary: buildCallSummary(session.extracted),
    });
  } catch (err) {
    console.error("Live call update error:", err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to update live call",
    });
  }
});

// =========================
// Force re-extract endpoint
// =========================
app.post("/api/live-call/:callSid/reextract", async (req, res) => {
  try {
    const callSid = req.params.callSid;
    const extracted = await refreshStructuredCallInfo(callSid);

    let created = null;
    try {
      created = await maybeAutoCreateAppointment(callSid);
    } catch (err) {
      console.error("Reextract auto-create failed:", err?.message || err);
    }

    res.json({
      ok: true,
      extracted,
      createdEventId: created?.id || null,
      callSummary: buildCallSummary(extracted),
    });
  } catch (err) {
    console.error("Reextract error:", err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to re-extract call info",
    });
  }
});

// =========================
// Manual confirm endpoint
// =========================
app.post("/api/live-call/:callSid/confirm", async (req, res) => {
  try {
    const callSid = req.params.callSid;
    const session = getOrCreateCallSession(callSid);
    session.extracted.bookingConfirmed = true;

    let created = null;
    try {
      created = await maybeAutoCreateAppointment(callSid);
    } catch (err) {
      console.error("Confirm auto-create failed:", err?.message || err);
    }

    res.json({
      ok: true,
      bookingConfirmed: true,
      appointmentCreated: session.extracted.appointmentCreated,
      appointmentEventId: session.extracted.appointmentEventId,
      createdEventId: created?.id || null,
    });
  } catch (err) {
    console.error("Confirm endpoint error:", err?.message || err);
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to confirm booking",
    });
  }
});

// =========================
// Start
// =========================
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
