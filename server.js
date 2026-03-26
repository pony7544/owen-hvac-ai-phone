require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const session = require("express-session");

const {
  liveCalls,
  streamToCallSid,
  cleanText,
  normalizePhone,
  getOrCreateCallSession,
  mergeCallSessions,
  resolveStartCallSid,
  pushTranscript,
  buildCallSummary,
} = require("./services/call-session.service");

const { createCalendarService } = require("./services/calendar.service");
const { createExtractionService } = require("./services/extraction.service");

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
      maxAge: 1000 * 60 * 60 * 12,
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

// Realtime model / voice config
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";

// Public URL for Twilio media stream + status callback
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  "";

const MEDIA_STREAM_PATH = "/media-stream";
const TWILIO_VOICE_PATH = "/twilio/voice";
const TWILIO_STATUS_PATH = "/twilio/status";

// =========================
// Services
// =========================
const calendarService = createCalendarService({
  googleClientId: GOOGLE_CLIENT_ID,
  googleClientSecret: GOOGLE_CLIENT_SECRET,
  googleRefreshToken: GOOGLE_REFRESH_TOKEN,
  googleCalendarId: GOOGLE_CALENDAR_ID,
  businessTimezone: BUSINESS_TIMEZONE,
  defaultAppointmentMinutes: DEFAULT_APPOINTMENT_MINUTES,
  businessName: BUSINESS_NAME,
  getOrCreateCallSession,
});

const extractionService = createExtractionService({
  openaiApiKey: OPENAI_API_KEY,
  businessTimezone: BUSINESS_TIMEZONE,
  getOrCreateCallSession,
  normalizePhone,
});

const {
  testCalendarConnection,
  listEventsForDay,
  generateSlotsForDay,
  createAppointmentEvent,
  maybeAutoCreateAppointment,
} = calendarService;

const {
  refreshStructuredCallInfo,
  refreshStructuredCallInfoDebounced,
} = extractionService;

// =========================
// Auth helpers
// =========================
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
// General helpers
// =========================
function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function buildWsUrlFromBase(baseUrl, pathName) {
  if (!baseUrl) return "";
  if (baseUrl.startsWith("https://")) {
    return baseUrl.replace(/^https:\/\//i, "wss://") + pathName;
  }
  if (baseUrl.startsWith("http://")) {
    return baseUrl.replace(/^http:\/\//i, "ws://") + pathName;
  }
  return "";
}

function buildHttpUrl(baseUrl, pathName) {
  if (!baseUrl) return pathName;
  return `${baseUrl}${pathName}`;
}

function formatDisplayTime(iso, timeZone = BUSINESS_TIMEZONE) {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "numeric",
      minute: "2-digit",
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function safeJsonParse(raw, fallback = null) {
  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function getCallPublicData(sessionObj) {
  return {
    callSid: sessionObj.callSid,
    streamSid: sessionObj.streamSid || "",
    from: sessionObj.from || "",
    to: sessionObj.to || "",
    status: sessionObj.status || "",
    createdAt: sessionObj.createdAt || "",
    updatedAt: sessionObj.updatedAt || "",
    mediaPacketCount: sessionObj.mediaPacketCount || 0,
    lastAssistantText: sessionObj.lastAssistantText || "",
    extracted: sessionObj.extracted || {},
    transcript: Array.isArray(sessionObj.transcript) ? sessionObj.transcript : [],
    summary: buildCallSummary(sessionObj),
  };
}

function findCallSidByStreamOrCall(streamSid, callSid) {
  if (callSid) return callSid;
  if (streamSid && streamToCallSid.has(streamSid)) {
    return streamToCallSid.get(streamSid);
  }
  return "";
}

function getLatestCalls(limit = 20) {
  return Array.from(liveCalls.values())
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, limit)
    .map(getCallPublicData);
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
    <h3>Login failed</h3>
    <p>Invalid username or password.</p>
    <p><a href="/login">Back to login</a></p>
  `);
});

app.get("/logout", (req, res) => {
  req.session.destroy(() => {
    res.redirect("/login");
  });
});

app.get("/live", requireLiveAuth, (req, res) => {
  const liveHtmlPath = path.join(__dirname, "public", "live.html");
  res.sendFile(liveHtmlPath, (err) => {
    if (!err) return;

    // fallback simple dashboard if live.html doesn't exist
    res.send(`
      <!doctype html>
      <html>
      <head>
        <meta charset="utf-8" />
        <title>Live Calls</title>
        <style>
          body { font-family: Arial, sans-serif; margin: 20px; }
          pre { background: #f4f4f4; padding: 12px; border-radius: 8px; white-space: pre-wrap; }
          .row { margin-bottom: 16px; }
          button { padding: 8px 12px; }
        </style>
      </head>
      <body>
        <h2>Owen HVAC Live Calls</h2>
        <div class="row">
          <a href="/logout">Logout</a>
        </div>
        <div class="row">
          <button onclick="loadCalls()">Refresh</button>
        </div>
        <pre id="out">Loading...</pre>
        <script>
          async function loadCalls() {
            const res = await fetch('/api/live-calls');
            const data = await res.json();
            document.getElementById('out').textContent =
              JSON.stringify(data, null, 2);
          }
          loadCalls();
          setInterval(loadCalls, 2000);
        </script>
      </body>
      </html>
    `);
  });
});

// =========================
// Admin / live APIs
// =========================
app.get("/api/live-calls", requireApiAuth, (req, res) => {
  return res.json({
    ok: true,
    calls: getLatestCalls(50),
  });
});

app.get("/api/live-call/:callSid", requireApiAuth, (req, res) => {
  const callSid = req.params.callSid;
  const sessionObj = liveCalls.get(callSid);

  if (!sessionObj) {
    return res.status(404).json({ ok: false, error: "Call not found" });
  }

  return res.json({
    ok: true,
    call: getCallPublicData(sessionObj),
  });
});

app.post(
  "/api/live-call/:callSid/refresh-extraction",
  requireApiAuth,
  async (req, res) => {
    try {
      const callSid = req.params.callSid;
      const extracted = await refreshStructuredCallInfo(callSid);
      return res.json({ ok: true, extracted });
    } catch (err) {
      console.error("refresh extraction error:", err);
      return res.status(500).json({
        ok: false,
        error: err.message || "Failed to refresh extraction",
      });
    }
  }
);

app.post(
  "/api/live-call/:callSid/create-appointment",
  requireApiAuth,
  async (req, res) => {
    try {
      const callSid = req.params.callSid;
      const event = await createAppointmentEvent(callSid);
      return res.json({ ok: true, event });
    } catch (err) {
      console.error("create appointment error:", err);
      return res.status(500).json({
        ok: false,
        error: err.message || "Failed to create appointment",
      });
    }
  }
);

// =========================
// Calendar APIs
// =========================
app.get("/test/calendar", async (req, res) => {
  try {
    const calendarInfo = await testCalendarConnection();
    return res.json({
      ok: true,
      calendar: calendarInfo,
    });
  } catch (err) {
    console.error("calendar test error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Calendar test failed",
    });
  }
});

app.get("/appointments/availability", async (req, res) => {
  try {
    const date = cleanText(req.query.date);
    if (!date) {
      return res
        .status(400)
        .json({ ok: false, error: "Missing required query param: date" });
    }

    const slotMinutes = parseInt(req.query.slotMinutes || "120", 10);
    const events = await listEventsForDay(date);
    const slots = generateSlotsForDay(date, events, slotMinutes);

    return res.json({
      ok: true,
      date,
      slotMinutes,
      slots: slots.map((s) => ({
        ...s,
        displayStart: formatDisplayTime(s.start),
        displayEnd: formatDisplayTime(s.end),
      })),
    });
  } catch (err) {
    console.error("availability error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message || "Failed to get availability",
    });
  }
});

// =========================
// Twilio voice webhook
// =========================
app.post(TWILIO_VOICE_PATH, (req, res) => {
  try {
    const callSid = cleanText(req.body.CallSid || req.body.callSid || "");
    const from = cleanText(req.body.From || "");
    const to = cleanText(req.body.To || "");

    const sessionObj = getOrCreateCallSession(callSid);
    sessionObj.from = from || sessionObj.from;
    sessionObj.to = to || sessionObj.to;
    sessionObj.status = "initiated";
    sessionObj.updatedAt = new Date().toISOString();

    const wsUrl = buildWsUrlFromBase(PUBLIC_BASE_URL, MEDIA_STREAM_PATH);
    if (!wsUrl) {
      console.error("PUBLIC_BASE_URL / RENDER_EXTERNAL_URL is not configured");
    }

    const twiml = `
<Response>
  <Say voice="alice">Hello. You have reached ${escapeXml(
    BUSINESS_NAME
  )}. Please hold while I connect you to our AI assistant.</Say>
  <Connect>
    <Stream url="${escapeXml(wsUrl)}">
      <Parameter name="callSid" value="${escapeXml(callSid)}" />
      <Parameter name="from" value="${escapeXml(from)}" />
      <Parameter name="to" value="${escapeXml(to)}" />
      <Parameter name="businessName" value="${escapeXml(BUSINESS_NAME)}" />
      <Parameter name="businessPhone" value="${escapeXml(BUSINESS_PHONE)}" />
      <Parameter name="businessTimezone" value="${escapeXml(
        BUSINESS_TIMEZONE
      )}" />
    </Stream>
  </Connect>
</Response>`.trim();

    res.type("text/xml").send(twiml);
  } catch (err) {
    console.error("twilio voice webhook error:", err);
    res.type("text/xml").send(`
<Response>
  <Say voice="alice">Sorry, there was a temporary issue. Please try again later.</Say>
  <Hangup />
</Response>`.trim());
  }
});

app.post(TWILIO_STATUS_PATH, (req, res) => {
  try {
    console.log("Twilio Status Callback:", req.body);

    const callSid = cleanText(req.body.CallSid || "");
    const callStatus = cleanText(req.body.CallStatus || "");

    if (callSid) {
      const sessionObj = getOrCreateCallSession(callSid);
      sessionObj.status = callStatus || sessionObj.status;
      sessionObj.updatedAt = new Date().toISOString();
    }

    return res.status(204).send();
  } catch (err) {
    console.error("twilio status error:", err);
    return res.status(204).send();
  }
});

// =========================
// Realtime bridge helpers
// =========================
function buildSystemPrompt(sessionObj) {
  const knownName = sessionObj.extracted?.callerName || "";
  const knownPhone = sessionObj.extracted?.callbackNumber || "";
  const knownAddress = sessionObj.extracted?.serviceAddress || "";
  const knownIssue = sessionObj.extracted?.issueSummary || "";

  return `
You are the phone receptionist for ${BUSINESS_NAME}, an HVAC company.

Your goals:
1. Greet the caller naturally.
2. Collect:
   - caller full name
   - callback phone number
   - service address
   - reason for call / HVAC issue
3. Be concise and conversational.
4. Repeat back details to confirm accuracy.
5. If one field is already known, do not ask for it again unless needed.
6. Never invent appointment times.
7. Do not claim an appointment is booked unless the system confirms it.

Known info:
- Name: ${knownName}
- Phone: ${knownPhone}
- Address: ${knownAddress}
- Issue: ${knownIssue}

Business timezone: ${BUSINESS_TIMEZONE}

When speaking:
- Be friendly and short.
- Ask one thing at a time when possible.
- If the caller asks for service or quote, gather required information first.
`.trim();
}

function sendOpenAIEvent(ws, event) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

function sendTwilioAudio(ws, streamSid, base64Audio) {
  if (ws.readyState !== WebSocket.OPEN || !streamSid || !base64Audio) return;
  ws.send(
    JSON.stringify({
      event: "media",
      streamSid,
      media: {
        payload: base64Audio,
      },
    })
  );
}

function sendTwilioMark(ws, streamSid, name = "responsePart") {
  if (ws.readyState !== WebSocket.OPEN || !streamSid) return;
  ws.send(
    JSON.stringify({
      event: "mark",
      streamSid,
      mark: { name },
    })
  );
}

async function maybeSyncExtractionAndBooking(callSid) {
  try {
    await refreshStructuredCallInfoDebounced(callSid);
    await maybeAutoCreateAppointment(callSid);
  } catch (err) {
    console.error("maybeSyncExtractionAndBooking error:", err);
  }
}

// =========================
// WebSocket server
// =========================
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url === MEDIA_STREAM_PATH) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
    return;
  }
  socket.destroy();
});

wss.on("connection", (twilioWs, req) => {
  console.log("Twilio media stream connected");

  let streamSid = "";
  let callSid = "";
  let openaiWs = null;
  let openaiReady = false;

  function ensureSession() {
    if (!callSid) return null;
    return getOrCreateCallSession(callSid);
  }

  function connectOpenAI() {
    openaiWs = new WebSocket(
      `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(
        REALTIME_MODEL
      )}`,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    openaiWs.on("open", () => {
      console.log("Connected to OpenAI Realtime");
      openaiReady = true;

      const sessionObj = ensureSession();

      sendOpenAIEvent(openaiWs, {
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: buildSystemPrompt(
            sessionObj || { extracted: {}, transcript: [] }
          ),
          voice: REALTIME_VOICE,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe",
          },
          turn_detection: {
            type: "server_vad",
          },
          temperature: 0.6,
        },
      });

      sendOpenAIEvent(openaiWs, {
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Greet the caller and start collecting their name, callback number, service address, and reason for calling.",
        },
      });
    });

    openaiWs.on("message", async (raw) => {
      const event = safeJsonParse(raw.toString(), {});
      if (!event || !event.type) return;

      // Debug if needed:
      // console.log("OpenAI event:", event.type);

      switch (event.type) {
        case "response.audio.delta": {
          if (event.delta) {
            sendTwilioAudio(twilioWs, streamSid, event.delta);
          }
          break;
        }

        case "response.audio.done": {
          sendTwilioMark(twilioWs, streamSid, "responseAudioDone");
          break;
        }

        case "response.output_text.delta": {
          const sessionObj = ensureSession();
          if (sessionObj && event.delta) {
            sessionObj.lastAssistantText =
              (sessionObj.lastAssistantText || "") + event.delta;
            sessionObj.updatedAt = new Date().toISOString();
          }
          break;
        }

        case "response.output_text.done": {
          const sessionObj = ensureSession();
          if (sessionObj && sessionObj.lastAssistantText) {
            pushTranscript(callSid, "assistant", sessionObj.lastAssistantText);
            sessionObj.lastAssistantText = "";
            await maybeSyncExtractionAndBooking(callSid);
          }
          break;
        }

        case "conversation.item.input_audio_transcription.completed": {
          const text = cleanText(event.transcript || "");
          if (text && callSid) {
            pushTranscript(callSid, "user", text);
            await maybeSyncExtractionAndBooking(callSid);
          }
          break;
        }

        case "input_audio_buffer.speech_started":
        case "input_audio_buffer.speech_stopped":
        case "response.created":
        case "response.done":
        case "session.created":
        case "session.updated":
        case "conversation.item.created":
        case "rate_limits.updated":
          break;

        case "error": {
          console.error("OpenAI realtime error event:", event);
          break;
        }

        default:
          break;
      }
    });

    openaiWs.on("close", () => {
      console.log("OpenAI WS closed");
      openaiReady = false;
      try {
        twilioWs.close();
      } catch {}
    });

    openaiWs.on("error", (err) => {
      console.error("OpenAI WS error:", err);
      openaiReady = false;
    });
  }

  connectOpenAI();

  twilioWs.on("message", async (message) => {
    const data = safeJsonParse(message.toString(), {});
    if (!data || !data.event) return;

    switch (data.event) {
      case "connected":
        break;

      case "start": {
        streamSid = data.start?.streamSid || "";
        const startCallSid = resolveStartCallSid(data.start, "");
        const customCallSid = cleanText(
          data.start?.customParameters?.callSid || ""
        );
        callSid = startCallSid || customCallSid || callSid || "";

        if (streamSid && callSid) {
          streamToCallSid.set(streamSid, callSid);
        }

        const sessionObj = getOrCreateCallSession(callSid || `stream_${streamSid}`);
        if (!callSid) {
          callSid = sessionObj.callSid;
        }

        sessionObj.streamSid = streamSid || sessionObj.streamSid;
        sessionObj.from =
          cleanText(data.start?.customParameters?.from || "") || sessionObj.from;
        sessionObj.to =
          cleanText(data.start?.customParameters?.to || "") || sessionObj.to;
        sessionObj.status = "in-progress";
        sessionObj.updatedAt = new Date().toISOString();

        break;
      }

      case "media": {
        if (callSid) {
          const sessionObj = getOrCreateCallSession(callSid);
          sessionObj.mediaPacketCount = (sessionObj.mediaPacketCount || 0) + 1;
          sessionObj.updatedAt = new Date().toISOString();
        }

        if (openaiWs && openaiReady && data.media?.payload) {
          sendOpenAIEvent(openaiWs, {
            type: "input_audio_buffer.append",
            audio: data.media.payload,
          });
        }
        break;
      }

      case "mark":
        break;

      case "stop": {
        const resolvedCallSid = findCallSidByStreamOrCall(streamSid, callSid);
        if (resolvedCallSid) {
          const sessionObj = getOrCreateCallSession(resolvedCallSid);
          sessionObj.status = "completed";
          sessionObj.updatedAt = new Date().toISOString();
        }

        try {
          if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
        } catch {}

        break;
      }

      default:
        break;
    }
  });

  twilioWs.on("close", () => {
    const resolvedCallSid = findCallSidByStreamOrCall(streamSid, callSid);
    if (resolvedCallSid) {
      const sessionObj = getOrCreateCallSession(resolvedCallSid);
      sessionObj.updatedAt = new Date().toISOString();
      if (sessionObj.status === "in-progress") {
        sessionObj.status = "completed";
      }
    }

    try {
      if (openaiWs && openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    } catch {}
  });

  twilioWs.on("error", (err) => {
    console.error("Twilio WS error:", err);
  });
});

// =========================
// Optional utility route
// =========================
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "owen-hvac-ai-phone",
    time: new Date().toISOString(),
    publicBaseUrl: PUBLIC_BASE_URL,
    wsUrl: buildWsUrlFromBase(PUBLIC_BASE_URL, MEDIA_STREAM_PATH),
    voiceWebhook: buildHttpUrl(PUBLIC_BASE_URL, TWILIO_VOICE_PATH),
    statusWebhook: buildHttpUrl(PUBLIC_BASE_URL, TWILIO_STATUS_PATH),
  });
});

// =========================
// Start
// =========================
server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
  if (PUBLIC_BASE_URL) {
    console.log("Voice webhook:", buildHttpUrl(PUBLIC_BASE_URL, TWILIO_VOICE_PATH));
    console.log("Status webhook:", buildHttpUrl(PUBLIC_BASE_URL, TWILIO_STATUS_PATH));
    console.log("Media stream:", buildWsUrlFromBase(PUBLIC_BASE_URL, MEDIA_STREAM_PATH));
  } else {
    console.log("PUBLIC_BASE_URL not set");
  }
});
