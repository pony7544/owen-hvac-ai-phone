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
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Owen HVAC Corp";
const BUSINESS_PHONE = process.env.BUSINESS_PHONE || "";
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/Halifax";
const DEFAULT_APPOINTMENT_MINUTES = parseInt(
  process.env.DEFAULT_APPOINTMENT_MINUTES || "60",
  10
);

const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const GOOGLE_REFRESH_TOKEN = process.env.GOOGLE_REFRESH_TOKEN || "";
const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID || "primary";

const LIVE_ADMIN_USER = process.env.LIVE_ADMIN_USER || "admin";
const LIVE_ADMIN_PASS = process.env.LIVE_ADMIN_PASS || "ChangeThisPassword123!";

// 保留你原文件可用的 realtime 写法
const REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || "gpt-4o-realtime-preview";
const REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || "alloy";

// 这里保留你原来的 PUBLIC_WSS_URL 优先级思路
const PUBLIC_BASE_URL =
  process.env.PUBLIC_BASE_URL ||
  process.env.RENDER_EXTERNAL_URL ||
  process.env.BASE_URL ||
  "";

const PUBLIC_WSS_URL =
  process.env.PUBLIC_WSS_URL ||
  (PUBLIC_BASE_URL.startsWith("https://")
    ? PUBLIC_BASE_URL.replace(/^https:\/\//i, "wss://")
    : PUBLIC_BASE_URL.startsWith("http://")
    ? PUBLIC_BASE_URL.replace(/^http:\/\//i, "ws://")
    : "");

const TWILIO_VOICE_PATH = "/twilio/voice";
const TWILIO_VOICE_INCOMING_PATH = "/twilio/voice/incoming";
const TWILIO_STATUS_PATH = "/twilio/voice/status";
const MEDIA_STREAM_PATH = "/media-stream";

if (!OPENAI_API_KEY) {
  console.warn("Missing OPENAI_API_KEY");
}

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
// Helpers
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

function escapeXml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

function getTodayDateInBusinessTimezone() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: BUSINESS_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());

  const year = parts.find((p) => p.type === "year")?.value || "2000";
  const month = parts.find((p) => p.type === "month")?.value || "01";
  const day = parts.find((p) => p.type === "day")?.value || "01";
  return `${year}-${month}-${day}`;
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

function getLatestCalls(limit = 20) {
  return Array.from(liveCalls.values())
    .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
    .slice(0, limit)
    .map(getCallPublicData);
}

function buildSystemPrompt() {
  return `
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
- Speak naturally as a receptionist.
`.trim();
}

function sendOpenAIEvent(ws, event) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(event));
  }
}

// =========================
// Page Routes
// =========================
app.get("/", (req, res) => {
  res.send("Owen HVAC AI phone server is running.");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "owen-hvac-ai-phone",
    time: new Date().toISOString(),
    publicBaseUrl: PUBLIC_BASE_URL,
    publicWssUrl: PUBLIC_WSS_URL,
    voiceWebhook: buildHttpUrl(PUBLIC_BASE_URL, TWILIO_VOICE_PATH),
    statusWebhook: buildHttpUrl(PUBLIC_BASE_URL, TWILIO_STATUS_PATH),
    mediaStreamPath: MEDIA_STREAM_PATH,
  });
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
        <div class="row"><a href="/logout">Logout</a></div>
        <div class="row"><button onclick="loadCalls()">Refresh</button></div>
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
// Live APIs
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
    const data = await testCalendarConnection();
    res.json({ ok: true, calendar: data });
  } catch (err) {
    res.json({ ok: false, error: err.message });
  }
});

app.get("/appointments/availability", async (req, res) => {
  try {
    const date = cleanText(req.query.date || getTodayDateInBusinessTimezone());
    const slotMinutes = parseInt(req.query.slotMinutes || "120", 10);

    const events = await listEventsForDay(date);
    const slots = generateSlotsForDay(date, events, slotMinutes);

    res.json({
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
    res.json({ ok: false, error: err.message });
  }
});

// =========================
// Twilio Voice Webhook
// =========================
function twilioVoiceHandler(req, res) {
  const callSid = cleanText(req.body.CallSid || `call_${Date.now()}`);
  const from = cleanText(req.body.From || "");
  const to = cleanText(req.body.To || "");

  const sessionObj = getOrCreateCallSession(callSid);
  sessionObj.from = from || sessionObj.from;
  sessionObj.to = to || sessionObj.to;
  sessionObj.status = "initiated";
  sessionObj.updatedAt = new Date().toISOString();

  const streamBase =
    PUBLIC_WSS_URL ||
    (req.headers.host ? `wss://${req.headers.host}` : "");

  const streamUrl = `${streamBase}${MEDIA_STREAM_PATH}?callSid=${encodeURIComponent(
    callSid
  )}`;

  const twiml = `
<Response>
  <Say voice="alice">Hello, you have reached ${escapeXml(
    BUSINESS_NAME
  )}. Please hold while I connect you.</Say>
  <Connect>
    <Stream url="${escapeXml(streamUrl)}" />
  </Connect>
</Response>
`.trim();

  res.type("text/xml").send(twiml);
}

app.post(TWILIO_VOICE_PATH, twilioVoiceHandler);
app.post(TWILIO_VOICE_INCOMING_PATH, twilioVoiceHandler);

app.post(TWILIO_STATUS_PATH, (req, res) => {
  const callSid = req.body.CallSid || "";
  if (callSid) {
    const sessionObj = getOrCreateCallSession(callSid);
    sessionObj.status = req.body.CallStatus || sessionObj.status;
    sessionObj.from = req.body.From || sessionObj.from;
    sessionObj.to = req.body.To || sessionObj.to;
    sessionObj.updatedAt = new Date().toISOString();
  }
  console.log("Twilio Status Callback:", req.body);
  res.sendStatus(200);
});

// =========================
// WebSocket server for Twilio Media Streams
// =========================
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  const { url } = request || {};
  if (url && url.startsWith(MEDIA_STREAM_PATH)) {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (twilioWs, request) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  const urlCallSid =
    urlObj.searchParams.get("callSid") || `call_${Date.now()}`;

  let activeCallSid = urlCallSid;
  let sessionObj = getOrCreateCallSession(activeCallSid);

  console.log(`Twilio media stream connected: initial=${activeCallSid}`);

  let streamSid = "";
  let assistantTranscriptBuffer = "";

  const openaiWs = new WebSocket(
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

    const sessionUpdate = {
      type: "session.update",
      session: {
        modalities: ["audio", "text"],
        instructions: buildSystemPrompt(),
        voice: REALTIME_VOICE,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: {
          model: "gpt-4o-mini-transcribe",
        },
        turn_detection: {
          type: "server_vad",
          silence_duration_ms: 700,
          prefix_padding_ms: 300,
        },
      },
    };

    sendOpenAIEvent(openaiWs, sessionUpdate);

    sendOpenAIEvent(openaiWs, {
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: "Greet the caller and ask how you can help today.",
      },
    });
  });

  openaiWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());
      console.log("OpenAI event type:", data.type);

      if (
        data.type === "conversation.item.input_audio_transcription.completed" &&
        data.transcript
      ) {
        const callerText = cleanText(data.transcript);
        if (callerText) {
          console.log("Caller:", callerText);
          pushTranscript(activeCallSid, "caller", callerText);

          try {
            await refreshStructuredCallInfoDebounced(activeCallSid);
          } catch (err) {
            console.error(
              "Structured extraction after caller failed:",
              err?.message || err
            );
          }

          try {
            await maybeAutoCreateAppointment(activeCallSid);
          } catch (err) {
            console.error(
              "Auto-create appointment after caller failed:",
              err?.message || err
            );
          }
        }
      }

      if (data.type === "response.audio_transcript.delta" && data.delta) {
        assistantTranscriptBuffer += data.delta;
      }

      if (data.type === "response.audio.delta" && data.delta) {
        console.log("🔊 audio delta", {
          len: data.delta.length,
          streamSid,
        });

        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(
            JSON.stringify({
              event: "media",
              streamSid,
              media: {
                payload: data.delta,
              },
            })
          );
          console.log("✅ sent audio to Twilio");
        } else {
          console.log("❌ Twilio not ready or streamSid missing");
        }
      }

      if (data.type === "response.audio.done") {
        console.log("🔊 audio done");
      }

      if (data.type === "response.done") {
        const assistantText = cleanText(assistantTranscriptBuffer);
        console.log("🤖 response done", assistantText);

        if (assistantText) {
          pushTranscript(activeCallSid, "assistant", assistantText);
          assistantTranscriptBuffer = "";

          try {
            await refreshStructuredCallInfoDebounced(activeCallSid);
          } catch (err) {
            console.error(
              "Structured extraction after assistant failed:",
              err?.message || err
            );
          }

          try {
            await maybeAutoCreateAppointment(activeCallSid);
          } catch (err) {
            console.error(
              "Auto-create appointment failed:",
              err?.message || err
            );
          }
        } else {
          assistantTranscriptBuffer = "";
        }
      }

      if (data.type === "error") {
        console.error(
          "OpenAI realtime error event:",
          JSON.stringify(data, null, 2)
        );
      }
    } catch (err) {
      console.error("OpenAI message parse error:", err?.message || err);
    }
  });

  openaiWs.on("error", (err) => {
    console.error("OpenAI WS error:", err?.message || err);
  });

  openaiWs.on("close", (code, reason) => {
    console.log("OpenAI WS closed:", code, reason ? reason.toString() : "");
    try {
      if (twilioWs.readyState === WebSocket.OPEN) {
        twilioWs.close();
      }
    } catch {}
  });

  twilioWs.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start": {
          console.log(
            "Twilio stream start:",
            JSON.stringify(data.start, null, 2)
          );

          streamSid = data.start?.streamSid || "";

          const startCallSid = resolveStartCallSid(data.start, urlCallSid);
          if (startCallSid && startCallSid !== activeCallSid) {
            console.log(
              `Merging call session from ${activeCallSid} -> ${startCallSid}`
            );
            sessionObj = mergeCallSessions(startCallSid, activeCallSid);
            activeCallSid = startCallSid;
          } else {
            sessionObj = getOrCreateCallSession(activeCallSid);
          }

          sessionObj.streamSid = streamSid || sessionObj.streamSid;
          sessionObj.status = "in-progress";
          sessionObj.from =
            cleanText(data.start?.customParameters?.from || "") ||
            sessionObj.from;
          sessionObj.to =
            cleanText(data.start?.customParameters?.to || "") || sessionObj.to;
          sessionObj.updatedAt = new Date().toISOString();

          if (streamSid) {
            streamToCallSid.set(streamSid, activeCallSid);
          }

          break;
        }

        case "media": {
          if (activeCallSid) {
            const call = getOrCreateCallSession(activeCallSid);
            call.mediaPacketCount = (call.mediaPacketCount || 0) + 1;
            call.updatedAt = new Date().toISOString();
          }

          if (
            data.media?.payload &&
            openaiWs.readyState === WebSocket.OPEN
          ) {
            openaiWs.send(
              JSON.stringify({
                type: "input_audio_buffer.append",
                audio: data.media.payload,
              })
            );
          }

          break;
        }

        case "mark":
          break;

        case "stop": {
          console.log("Twilio stream stop");
          if (activeCallSid && liveCalls.has(activeCallSid)) {
            const call = liveCalls.get(activeCallSid);
            call.status = "completed";
            call.updatedAt = new Date().toISOString();
          }

          try {
            if (openaiWs.readyState === WebSocket.OPEN) {
              openaiWs.close();
            }
          } catch {}

          break;
        }

        default:
          break;
      }
    } catch (err) {
      console.error("Twilio WS message error:", err?.message || err);
    }
  });

  twilioWs.on("close", () => {
    console.log("Twilio WS closed");
    if (activeCallSid && liveCalls.has(activeCallSid)) {
      const call = liveCalls.get(activeCallSid);
      if (call.status === "in-progress") {
        call.status = "completed";
      }
      call.updatedAt = new Date().toISOString();
    }

    try {
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    } catch {}
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
  if (PUBLIC_BASE_URL) {
    console.log("Voice webhook:", buildHttpUrl(PUBLIC_BASE_URL, TWILIO_VOICE_PATH));
    console.log("Status webhook:", buildHttpUrl(PUBLIC_BASE_URL, TWILIO_STATUS_PATH));
  }
  if (PUBLIC_WSS_URL) {
    console.log("Media stream base:", PUBLIC_WSS_URL + MEDIA_STREAM_PATH);
  }
});
