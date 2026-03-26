require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const session = require("express-session");

// ===== services =====
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
const { createRecordingService } = require("./services/recording.service");

// ===== app =====
const app = express();
const server = http.createServer(app);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET || "replace_this_session_secret",
    resave: false,
    saveUninitialized: false,
  })
);

app.use(express.static(path.join(__dirname, "public")));

// ===== ENV =====
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 10000;

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Owen HVAC Corp";
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/Halifax";

// ===== services init =====
const calendarService = createCalendarService({
  businessTimezone: BUSINESS_TIMEZONE,
  getOrCreateCallSession,
});

const extractionService = createExtractionService({
  openaiApiKey: OPENAI_API_KEY,
  businessTimezone: BUSINESS_TIMEZONE,
  getOrCreateCallSession,
  normalizePhone,
});

const recordingService = createRecordingService({
  recordingsDir: path.join(__dirname, "recordings"),
  retentionDays: 90,
  getOrCreateCallSession,
  liveCalls,
});

const {
  ensureRecordingSession,
  appendCallerAudio,
  appendAssistantAudio,
  finalizeRecording,
  getRecordingMeta,
  streamRecordingMedia,
  cleanupExpiredRecordings,
} = recordingService;

// ===== API =====
app.get("/api/live-calls", (req, res) => {
  res.json({
    ok: true,
    calls: Array.from(liveCalls.values()),
  });
});

app.get("/api/live-call/:callSid", (req, res) => {
  const call = liveCalls.get(req.params.callSid);
  if (!call) return res.status(404).json({ ok: false });

  res.json({ ok: true, call });
});

app.get("/api/live-call/:callSid/recording", (req, res) => {
  const result = getRecordingMeta(req.params.callSid);
  if (!result.ok) return res.status(404).json(result);
  res.json(result);
});

app.get("/api/live-call/:callSid/recording/media", async (req, res) => {
  try {
    await streamRecordingMedia(req.params.callSid, res);
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===== Twilio webhook =====
app.post("/twilio/voice", (req, res) => {
  const callSid = req.body.CallSid || `call_${Date.now()}`;

  getOrCreateCallSession(callSid);

  const streamUrl = `wss://${req.headers.host}/media-stream?callSid=${callSid}`;

  res.type("text/xml").send(`
<Response>
  <Say>Hello, you have reached ${BUSINESS_NAME}</Say>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>
`);
});

// ===== WS =====
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }
});

wss.on("connection", (twilioWs, request) => {
  const url = new URL(request.url, "http://localhost");
  let callSid = url.searchParams.get("callSid");

  let streamSid = "";

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`,
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("OpenAI connected");
  });

  openaiWs.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());

    if (data.type === "response.audio.delta" && data.delta) {
      await appendAssistantAudio(callSid, data.delta);

      if (streamSid) {
        twilioWs.send(
          JSON.stringify({
            event: "media",
            streamSid,
            media: { payload: data.delta },
          })
        );
      }
    }
  });

  twilioWs.on("message", async (msg) => {
    const data = JSON.parse(msg.toString());

    switch (data.event) {
      case "start":
        streamSid = data.start.streamSid;
        callSid = resolveStartCallSid(data.start, callSid);

        ensureRecordingSession(callSid);
        break;

      case "media":
        if (data.media?.payload) {
          await appendCallerAudio(callSid, data.media.payload);

          openaiWs.send(
            JSON.stringify({
              type: "input_audio_buffer.append",
              audio: data.media.payload,
            })
          );
        }
        break;

      case "stop":
        await finalizeRecording(callSid);
        openaiWs.close();
        break;
    }
  });

  twilioWs.on("close", async () => {
    await finalizeRecording(callSid);
  });
});

// ===== cleanup =====
setInterval(() => {
  cleanupExpiredRecordings().catch(console.error);
}, 24 * 60 * 60 * 1000);

// ===== start =====
server.listen(PORT, () => {
  console.log("Server running on port", PORT);
});
