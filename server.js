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
      maxAge: 1000 * 60 * 60 * 12, // 12小时
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
// =========================
const liveCalls = new Map();
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
  extracted: {
    intent: "",
    callerName: "",
    callbackNumber: "",
    serviceAddress: "",
    issueSummary: "",
    preferredDate: "",      // YYYY-MM-DD
    preferredTime: "",      // HH:MM
    preferredDateTime: "",
    bookingConfirmed: false,
    appointmentCreated: false,
    appointmentEventId: "",
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
    });
  }
  return liveCalls.get(callSid);
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

async function createAppointmentEvent(callSid) {
  const session = getOrCreateCallSession(callSid);
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

  if (f.appointmentCreated) return null;
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
    return await refreshStructuredCallInfo(callSid);
  } finally {
    session.extractionInFlight = false;
  }
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
// Page routes
// =========================
app.get("/", (req, res) => {
  res.send("Owen HVAC AI phone server is running.");
});

app.get("/login", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "login.html"));
});

app.post("/login", (req, res) => {
  const username = cleanText(req.body.username);
  const password = req.body.password || "";

  if (username === LIVE_ADMIN_USER && password === LIVE_ADMIN_PASS) {
    req.session.liveAuthed = true;
    req.session.liveUser = username;
    return res.redirect("/live");
  }

  return res.status(401).send(`
    <html>
      <body style="font-family: Arial; padding: 24px;">
        <h3>Login failed</h3>
        <p>Invalid username or password.</p>
        <p><a href="/login">Back to login</a></p>
      </body>
    </html>
  `);
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/live", requireLiveAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "live.html"));
});

// =========================
// Live dashboard APIs
// =========================
app.get("/api/live/calls", requireApiAuth, (req, res) => {
  const calls = Array.from(liveCalls.values())
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map((c) => buildCallSummary(c));

  res.json({
    ok: true,
    calls,
  });
});

app.get("/api/live-call/:callSid", requireApiAuth, (req, res) => {
  const callSid = req.params.callSid;
  const call = liveCalls.get(callSid);

  if (!call) {
    return res.status(404).json({ ok: false, error: "Call not found" });
  }

  return res.json({
    ok: true,
    call: {
      callSid: call.callSid,
      from: call.from,
      to: call.to,
      status: call.status,
      streamSid: call.streamSid,
      createdAt: call.createdAt,
      updatedAt: call.updatedAt,
      transcript: call.transcript,
      extracted: call.extracted,
    },
  });
});

app.get("/api/calendar/status", requireApiAuth, async (req, res) => {
  try {
    const cal = await testCalendarConnection();

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    const date = `${yyyy}-${mm}-${dd}`;

    const events = await listEventsForDay(date);
    const slots = generateSlotsForDay(date, events, 120);

    res.json({
      ok: true,
      connected: true,
      calendarId: cal.id || GOOGLE_CALENDAR_ID,
      summary: cal.summary || "",
      timeZone: cal.timeZone || BUSINESS_TIMEZONE,
      todayDate: date,
      todayEventCount: events.length,
      todayAvailableSlots: slots.length,
      slots,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      connected: false,
      error: err?.message || "Calendar status failed",
    });
  }
});

app.post("/api/live-call/:callSid/reextract", requireApiAuth, async (req, res) => {
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
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || "Re-extract failed",
    });
  }
});

app.post("/api/live-call/:callSid/create-appointment", requireApiAuth, async (req, res) => {
  try {
    const event = await createAppointmentEvent(req.params.callSid);
    res.json({
      ok: true,
      eventId: event.id,
      htmlLink: event.htmlLink,
      event,
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err?.message || "Create appointment failed",
    });
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
    res.status(500).json({
      ok: false,
      error: err?.message || "Failed to get availability",
    });
  }
});

// =========================
// Twilio webhook routes
// =========================
function twilioVoiceHandler(req, res) {
  const callSid = req.body.CallSid || `call_${Date.now()}`;
  const from = req.body.From || "";
  const to = req.body.To || "";

  const session = getOrCreateCallSession(callSid);
  session.from = from;
  session.to = to;
  session.status = "initiated";
  session.updatedAt = new Date().toISOString();

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
}

app.post("/twilio/voice", twilioVoiceHandler);
app.post("/twilio/voice/incoming", twilioVoiceHandler);

app.post("/twilio/voice/status", (req, res) => {
  const callSid = req.body.CallSid || "";
  if (callSid) {
    const session = getOrCreateCallSession(callSid);
    session.status = req.body.CallStatus || session.status;
    session.from = req.body.From || session.from;
    session.to = req.body.To || session.to;
    session.updatedAt = new Date().toISOString();
  }

  console.log("Twilio Status Callback:", req.body);
  res.sendStatus(200);
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

      if (data.type === "response.output_text.delta" && data.delta) {
        session.lastAssistantText += data.delta;
      }

      if (data.type === "response.done") {
        const assistantText = cleanText(session.lastAssistantText);

        if (assistantText) {
          pushTranscript(callSid, "assistant", assistantText);
          session.lastAssistantText = "";

          try {
            await refreshStructuredCallInfoDebounced(callSid);
          } catch (err) {
            console.error("Structured extraction after assistant failed:", err?.message || err);
          }

          try {
            await maybeAutoCreateAppointment(callSid);
          } catch (err) {
            console.error("Auto-create appointment failed:", err?.message || err);
          }
        }
      }

      if (
        data.type === "conversation.item.input_audio_transcription.completed" &&
        data.transcript
      ) {
        const callerText = cleanText(data.transcript);
        if (callerText) {
          pushTranscript(callSid, "caller", callerText);

          try {
            await refreshStructuredCallInfoDebounced(callSid);
          } catch (err) {
            console.error("Structured extraction after caller failed:", err?.message || err);
          }

          try {
            await maybeAutoCreateAppointment(callSid);
          } catch (err) {
            console.error("Auto-create appointment after caller failed:", err?.message || err);
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
          session.status = "in_progress";
          session.updatedAt = new Date().toISOString();
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
          session.status = "stream_closed";
          session.updatedAt = new Date().toISOString();
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
    session.status = "stream_closed";
    session.updatedAt = new Date().toISOString();
    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.close();
    }
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WS error:", err?.message || err);
  });
});

// =========================
// Start
// =========================
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
