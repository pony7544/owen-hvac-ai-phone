// =============================================================
// server.js — Owen HVAC AI Phone System
// 重构版：所有逻辑通过 services/ 模块访问，server.js 只负责
// HTTP/WebSocket 路由和 OpenAI Realtime 会话管理
// =============================================================

require("dotenv").config();
const os   = require("os");
const fs   = require("fs");

const express    = require("express");
const http       = require("http");
const path       = require("path");
const bodyParser = require("body-parser");
const WebSocket  = require("ws");
const session    = require("express-session");

// ─── 统一提示词 ────────────────────────────────
const { HVAC_SYSTEM_PROMPT, HVAC_TOOLS } = require("./prompts");

// ─── Services ─────────────────────────────────
const {
  liveCalls,
  streamToCallSid,
  cleanText,
  normalizePhone,
  getOrCreateCallSession,
  restoreCallSession,
  mergeCallSessions,
  resolveStartCallSid,
  pushTranscript,
  buildCallSummary,
  persistToRedis,
} = require("./services/call-session.service");

const { createExtractionService } = require("./services/extraction.service");
const { createCalendarService }   = require("./services/calendar.service");
const { buildWav, decodeG711UlawFrame, TimelineRecorder } = require("./services/recording.service");

// =========================
// ENV 校验
// =========================
if (!process.env.SESSION_SECRET) {
  console.error("FATAL: SESSION_SECRET environment variable is not set.");
  process.exit(1);
}
if (!process.env.LIVE_ADMIN_PASS) {
  console.error("FATAL: LIVE_ADMIN_PASS environment variable is not set.");
  process.exit(1);
}
if (!process.env.OPENAI_API_KEY) {
  console.error("FATAL: OPENAI_API_KEY environment variable is not set.");
  process.exit(1);
}

const OPENAI_API_KEY             = process.env.OPENAI_API_KEY;
const BUSINESS_NAME              = process.env.BUSINESS_NAME              || "Owen HVAC Corp";
const BUSINESS_TIMEZONE          = process.env.BUSINESS_TIMEZONE          || "America/Halifax";
const DEFAULT_APPOINTMENT_MINUTES= parseInt(process.env.DEFAULT_APPOINTMENT_MINUTES || "60", 10);
const LIVE_ADMIN_USER            = process.env.LIVE_ADMIN_USER            || "admin";
const LIVE_ADMIN_PASS            = process.env.LIVE_ADMIN_PASS;
const PORT                       = process.env.PORT                       || 10000;

// AI 模型（可通过环境变量覆盖，无需重新部署）
const REALTIME_MODEL       = process.env.OPENAI_REALTIME_MODEL      || "gpt-4o-realtime-preview";
const REALTIME_VOICE       = process.env.OPENAI_REALTIME_VOICE      || "alloy";
const TRANSCRIPTION_MODEL  = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const EXTRACTION_MODEL     = process.env.OPENAI_EXTRACTION_MODEL    || "gpt-4o-mini";

// ─── Twilio REST Client（用于主动挂断电话）────
const twilioAccountSid = process.env.TWILIO_ACCOUNT_SID;
const twilioAuthToken  = process.env.TWILIO_AUTH_TOKEN;
let twilioClient = null;
if (twilioAccountSid && twilioAuthToken) {
  const twilio = require("twilio");
  twilioClient = twilio(twilioAccountSid, twilioAuthToken);
  console.log("[Twilio] REST client initialized for programmatic hangup");
} else {
  console.warn("[Twilio] TWILIO_ACCOUNT_SID or TWILIO_AUTH_TOKEN not set — end_call tool will not be able to hang up");
}

// =========================
// 初始化 Services
// =========================
const calendarService = createCalendarService({
  googleClientId:             process.env.GOOGLE_CLIENT_ID,
  googleClientSecret:         process.env.GOOGLE_CLIENT_SECRET,
  googleRefreshToken:         process.env.GOOGLE_REFRESH_TOKEN,
  googleCalendarId:           process.env.GOOGLE_CALENDAR_ID || "primary",
  businessTimezone:           BUSINESS_TIMEZONE,
  defaultAppointmentMinutes:  DEFAULT_APPOINTMENT_MINUTES,
  businessName:               BUSINESS_NAME,
  getOrCreateCallSession,
});

const extractionService = createExtractionService({
  openaiApiKey:         OPENAI_API_KEY,
  extractionModel:      EXTRACTION_MODEL,
  businessTimezone:     BUSINESS_TIMEZONE,
  getOrCreateCallSession,
  normalizePhone,
  persistToRedis,
});

// =========================
// Express App
// =========================
const app    = express();
const server = http.createServer(app);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.use(
  session({
    secret: process.env.SESSION_SECRET,
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

// =========================
// Auth middleware
// =========================
function requireLiveAuth(req, res, next) {
  if (req.session?.liveAuthed) return next();
  return res.redirect("/login");
}

function requireApiAuth(req, res, next) {
  if (req.session?.liveAuthed) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}

// =========================
// Page routes
// =========================
app.get("/", (_req, res) => res.send("Owen HVAC AI phone server is running."));

app.get("/login", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "login.html"))
);

app.post("/login", (req, res) => {
  const username = cleanText(req.body.username);
  const password = req.body.password || "";

  if (username === LIVE_ADMIN_USER && password === LIVE_ADMIN_PASS) {
    req.session.liveAuthed = true;
    req.session.liveUser   = username;
    return res.redirect("/live");
  }
  return res.status(401).send(`
    <html><body style="font-family:Arial;padding:24px">
      <h3>Login failed</h3>
      <p>Invalid username or password.</p>
      <p><a href="/login">Back to login</a></p>
    </body></html>
  `);
});

app.post("/logout", (req, res) => {
  req.session.destroy(() => res.redirect("/login"));
});

app.get("/live", requireLiveAuth, (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "live.html"))
);

// =========================
// Live dashboard APIs
// =========================
app.get("/api/live/calls", requireApiAuth, (_req, res) => {
  const calls = Array.from(liveCalls.values())
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(buildCallSummary);
  res.json({ ok: true, calls });
});

app.get("/api/live-call/:callSid", requireApiAuth, (req, res) => {
  const call = liveCalls.get(req.params.callSid);
  if (!call) return res.status(404).json({ ok: false, error: "Call not found" });
  const rec = call.recording;
  return res.json({
    ok: true,
    call: {
      callSid:    call.callSid,
      from:       call.from,
      to:         call.to,
      status:     call.status,
      streamSid:  call.streamSid,
      createdAt:  call.createdAt,
      updatedAt:  call.updatedAt,
      transcript: call.transcript,
      extracted:  call.extracted,
      recording:  rec ? {
        available:   !!rec.available,
        durationSec: rec.durationSec,
        createdAt:   rec.createdAt,
      } : null,
    },
  });
});

app.get("/api/calendar/status", requireApiAuth, async (_req, res) => {
  try {
    const cal  = await calendarService.testCalendarConnection();
    const today = new Date().toLocaleDateString("en-CA", { timeZone: BUSINESS_TIMEZONE });
    const events = await calendarService.listEventsForDay(today);
    const slots  = calendarService.generateSlotsForDay(today, events, 120);
    res.json({
      ok: true, connected: true,
      calendarId: cal.id,
      summary:    cal.summary || "",
      timeZone:   cal.timeZone || BUSINESS_TIMEZONE,
      todayDate:  today,
      todayEventCount:     events.length,
      todayAvailableSlots: slots.length,
      slots,
    });
  } catch (err) {
    res.status(500).json({ ok: false, connected: false, error: err?.message });
  }
});

app.post("/api/live-call/:callSid/reextract", requireApiAuth, async (req, res) => {
  try {
    const { callSid } = req.params;
    const extracted = await extractionService.refreshStructuredCallInfo(callSid);
    let created = null;
    try { created = await calendarService.maybeAutoCreateAppointment(callSid); }
    catch (err) { console.error("Reextract auto-create failed:", err?.message); }
    res.json({ ok: true, extracted, createdEventId: created?.id || null });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.post("/api/live-call/:callSid/create-appointment", requireApiAuth, async (req, res) => {
  try {
    const event = await calendarService.createAppointmentEvent(req.params.callSid);
    res.json({ ok: true, eventId: event.id, htmlLink: event.htmlLink, event });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

// =========================
// Calendar public / test APIs
// =========================
app.get("/test/calendar", async (_req, res) => {
  try {
    const data = await calendarService.testCalendarConnection();
    res.json({ ok: true, calendar: data });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

app.get("/appointments/availability", async (req, res) => {
  try {
    const { date } = req.query;
    if (!date) return res.status(400).json({ ok: false, error: "Missing date" });
    const events = await calendarService.listEventsForDay(date);
    const slots  = calendarService.generateSlotsForDay(date, events, 120);
    res.json({ ok: true, date, timezone: BUSINESS_TIMEZONE, slots });
  } catch (err) {
    res.status(500).json({ ok: false, error: err?.message });
  }
});

// =========================
// Twilio voice webhook
// =========================
function twilioVoiceHandler(req, res) {
  const callSid = req.body.CallSid || `call_${Date.now()}`;
  const from    = req.body.From || "";
  const to      = req.body.To   || "";

  const callSession = getOrCreateCallSession(callSid);
  callSession.from   = from;
  callSession.to     = to;
  callSession.status = "initiated";
  callSession.updatedAt = new Date().toISOString();

  const wsUrl = process.env.PUBLIC_WSS_URL || process.env.RENDER_EXTERNAL_URL;
  if (!wsUrl) {
    return res.status(500).send("Missing PUBLIC_WSS_URL or RENDER_EXTERNAL_URL.");
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

app.post("/twilio/voice",          twilioVoiceHandler);
app.post("/twilio/voice/incoming", twilioVoiceHandler);

app.post("/twilio/voice/status", (req, res) => {
  const callSid = req.body.CallSid || "";
  if (callSid) {
    const callSession = getOrCreateCallSession(callSid);
    callSession.status    = req.body.CallStatus || callSession.status;
    callSession.from      = req.body.From || callSession.from;
    callSession.to        = req.body.To   || callSession.to;
    callSession.updatedAt = new Date().toISOString();
  }
  res.sendStatus(200);
});

// =========================
// 录音：合成双声道 WAV
// =========================
// 防止 stop + close 双重触发
const finalizedCalls = new Set();

function finalizeRecording(callSid, recorder) {
  if (finalizedCalls.has(callSid)) return;

  // 从录音器取出时间轴对齐的帧
  const { callerFrames, assistantFrames } = recorder.finalize();
  if (!callerFrames.length && !assistantFrames.length) return;
  finalizedCalls.add(callSid);

  try {
    const wavBuffer = buildWav(callerFrames, assistantFrames);
    const session   = getOrCreateCallSession(callSid);
    session.recording = {
      wavBuffer,                          // Buffer in memory
      _callerFrames:    callerFrames,     // 时间轴对齐，含 null（静音）
      _assistantFrames: assistantFrames,  // 时间轴对齐，含 null（静音）
      durationSec: Math.round(
        (callerFrames.length * 160) / 8000  // 160 samples/frame at 8kHz
      ),
      createdAt:  new Date().toISOString(),
      available:  true,
    };
    session.updatedAt = new Date().toISOString();
    persistToRedis(callSid, session);
    console.log(`[Recording] WAV ready for ${callSid}, ~${session.recording.durationSec}s`);
  } catch (err) {
    console.error("[Recording] build WAV failed:", err?.message);
  }
}

// =========================
// 录音 API
// =========================

// GET /api/live-call/:callSid/recording/info — 录音元数据
app.get("/api/live-call/:callSid/recording/info", requireApiAuth, (req, res) => {
  const call = liveCalls.get(req.params.callSid);
  if (!call) return res.status(404).json({ ok: false, error: "Call not found" });

  const rec = call.recording;
  if (!rec?.available) {
    return res.json({ ok: true, available: false });
  }
  res.json({
    ok:          true,
    available:   true,
    durationSec: rec.durationSec,
    createdAt:   rec.createdAt,
  });
});

// GET /api/live-call/:callSid/recording/stream?channel=both|left|right
// channel: both=双声道, left=caller only, right=assistant only
// 修改后

app.get("/api/live-call/:callSid/recording/stream", requireApiAuth, (req, res) => {
  const call = liveCalls.get(req.params.callSid);
  if (!call) return res.status(404).json({ ok: false, error: "Call not found" });

  const rec = call.recording;
  if (!rec?.available || !rec.wavBuffer) {
    return res.status(404).json({ ok: false, error: "Recording not ready" });
  }

  const channel = req.query.channel || "both";
  let wavToSend = rec.wavBuffer;

  if (channel === "left" || channel === "right") {
    wavToSend = buildWav(
      channel === "left"  ? call.recording._callerFrames  || [] : [],
      channel === "right" ? call.recording._assistantFrames || [] : [],
      true
    );
  }

  // 写临时文件，让 sendFile 处理 Range 请求（支持 seek 和 Safari）
  const tmpPath = path.join(os.tmpdir(), `hvac-rec-${req.params.callSid}-${channel}.wav`);
  fs.writeFile(tmpPath, wavToSend, (writeErr) => {
    if (writeErr) {
      return res.status(500).json({ ok: false, error: "Failed to prepare recording" });
    }
    res.sendFile(tmpPath, {
      headers: {
        "Content-Type":        "audio/wav",
        "Content-Disposition": `inline; filename="call-${req.params.callSid}.wav"`,
      },
    }, (sendErr) => {
      // 响应发完后删除临时文件（静默失败无所谓）
      fs.unlink(tmpPath, () => {});
    });
  });
});
// =========================
// WebSocket — Twilio Media Streams
// =========================
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/media-stream")) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else {
    socket.destroy();
  }
});

wss.on("connection", async (twilioWs, request) => {
  const urlObj     = new URL(request.url, `http://${request.headers.host}`);
  const urlCallSid = urlObj.searchParams.get("callSid") || `call_${Date.now()}`;

  // 尝试从 Redis 恢复（服务器重启场景）
  await restoreCallSession(urlCallSid);

  let activeCallSid = urlCallSid;
  let callSession   = getOrCreateCallSession(activeCallSid);
  let streamSid     = "";
  let assistantTranscriptBuffer = "";

  // ─── 时间轴对齐录音器 ──────────────────────
  // 用 Twilio 的 caller 媒体流作为时钟基准（每 20ms 一包），
  // assistant 帧按实际到达时间对齐到同一时间轴
  const recorder = new TimelineRecorder();

  console.log(`[WS] Twilio connected: ${activeCallSid}`);

  // ─── 连接 OpenAI Realtime ──────────────────
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
    {
      headers: {
        Authorization:  `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta":  "realtime=v1",
      },
    }
  );

  openaiWs.on("open", () => {
    console.log("[OpenAI] Realtime connected");

    // session.update — 注入系统提示词 + Function Calling 工具
    openaiWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities:   ["audio", "text"],
        instructions: HVAC_SYSTEM_PROMPT,
        tools:        HVAC_TOOLS,
        tool_choice:  "auto",
        voice:        REALTIME_VOICE,
        input_audio_format:  "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: TRANSCRIPTION_MODEL },
        turn_detection: {
          type:                 "server_vad",
          threshold:            0.5,           // 语音检测灵敏度（0-1），越低越容易检测到 caller 说话
          silence_duration_ms:  500,           // 500ms 静音即认为 caller 说完（原 700ms）
          prefix_padding_ms:    300,           // 保留 caller 开始说话前 300ms 的音频
        },
      },
    }));

    // AI 主动打招呼
    openaiWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities:   ["audio", "text"],
        instructions: "Greet the caller and ask how you can help today.",
      },
    }));
  });

  // ─── OpenAI → Twilio 消息处理 ─────────────
  openaiWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 来电者语音转写完成
      if (
        data.type === "conversation.item.input_audio_transcription.completed" &&
        data.transcript
      ) {
        const callerText = cleanText(data.transcript);
        if (callerText) {
          console.log("[Caller]", callerText);
          pushTranscript(activeCallSid, "caller", callerText);
          try {
            await extractionService.refreshStructuredCallInfoDebounced(activeCallSid);
          } catch (err) {
            console.error("[Extraction] after caller:", err?.message);
          }
        }
      }

      // AI 文字增量（累积 buffer）
      if (data.type === "response.audio_transcript.delta" && data.delta) {
        assistantTranscriptBuffer += data.delta;
      }

      // AI 音频增量 → 转发给 Twilio + 录入 assistant 缓冲
      if (data.type === "response.audio.delta" && data.delta) {
        recorder.pushAssistant(data.delta);
        if (streamSid && twilioWs.readyState === WebSocket.OPEN) {
          twilioWs.send(JSON.stringify({
            event:     "media",
            streamSid,
            media:     { payload: data.delta },
          }));
        }
      }

      // AI 一轮回复结束
      if (data.type === "response.done") {
        const assistantText = cleanText(assistantTranscriptBuffer);
        assistantTranscriptBuffer = "";
        if (assistantText) {
          console.log("[Assistant]", assistantText);
          pushTranscript(activeCallSid, "assistant", assistantText);
          try {
            await extractionService.refreshStructuredCallInfoDebounced(activeCallSid);
          } catch (err) {
            console.error("[Extraction] after assistant:", err?.message);
          }
        }
      }

      // ── Function Calling 处理 ──────────────
      // AI 决定调用工具时，OpenAI 会发 response.done，
      // 其中 output[] 包含 type=function_call 的条目
      if (data.type === "response.done") {
        const outputs = data.response?.output || [];
        for (const item of outputs) {
          if (item.type !== "function_call") continue;

          const fnName = item.name;
          let fnArgs  = {};
          try { fnArgs = JSON.parse(item.arguments || "{}"); } catch (_) {}

          console.log(`[Tool] ${fnName}`, fnArgs);
          let toolResult = "";

          // ── check_availability ─────────────
          if (fnName === "check_availability") {
            try {
              const { date } = fnArgs;
              const events = await calendarService.listEventsForDay(date);
              const slots  = calendarService.generateSlotsForDay(date, events, DEFAULT_APPOINTMENT_MINUTES);
              if (slots.length === 0) {
                toolResult = `No available slots on ${date}. Please ask the caller for an alternate date.`;
              } else {
                const labels = slots.map((s) => {
                  const d = new Date(s.start);
                  return d.toLocaleTimeString("en-CA", {
                    timeZone: BUSINESS_TIMEZONE,
                    hour: "numeric",
                    minute: "2-digit",
                  });
                });
                toolResult = `Available slots on ${date}: ${labels.join(", ")}. Confirm one with the caller.`;
              }
            } catch (err) {
              toolResult = `Calendar check failed: ${err?.message}. Ask caller to try another date.`;
            }
          }

          // ── create_appointment ─────────────
          if (fnName === "create_appointment") {
            try {
              // 把 AI 收集到的字段写入 session，再让 calendarService 创建
              const s = getOrCreateCallSession(activeCallSid);
              s.extracted.callerName      = fnArgs.caller_name     || s.extracted.callerName;
              s.extracted.callbackNumber  = fnArgs.callback_number || s.extracted.callbackNumber;
              s.extracted.serviceAddress  = fnArgs.service_address || s.extracted.serviceAddress;
              s.extracted.issueSummary    = fnArgs.issue_summary   || s.extracted.issueSummary;
              s.extracted.preferredDate   = fnArgs.preferred_date  || s.extracted.preferredDate;
              s.extracted.preferredTime   = fnArgs.preferred_time  || s.extracted.preferredTime;
              s.extracted.intent          = fnArgs.intent          || s.extracted.intent;
              s.extracted.bookingConfirmed = true;

              const event = await calendarService.createAppointmentEvent(activeCallSid);
              persistToRedis(activeCallSid, s);
              toolResult = `Appointment created successfully. Event ID: ${event.id}. Tell the caller it is confirmed.`;
            } catch (err) {
              toolResult = `Failed to create appointment: ${err?.message}. Tell the caller a team member will follow up to confirm.`;
            }
          }

          // ── end_call ────────────────────────
          if (fnName === "end_call") {
            const reason = fnArgs.reason || "conversation_complete";
            console.log(`[EndCall] AI requested hangup for ${activeCallSid}, reason: ${reason}`);
            toolResult = "Call will be ended now. Goodbye.";

            // 延迟几秒后挂断，让 AI 的告别语音播完
            setTimeout(async () => {
              try {
                if (twilioClient) {
                  await twilioClient.calls(activeCallSid)
                    .update({ status: "completed" });
                  console.log(`[EndCall] Successfully hung up ${activeCallSid}`);
                } else {
                  // 没有 Twilio REST client，通过关闭 WebSocket 来结束
                  console.log(`[EndCall] No Twilio client, closing WebSocket for ${activeCallSid}`);
                  if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
                  if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
                }
              } catch (hangupErr) {
                console.error(`[EndCall] Failed to hang up ${activeCallSid}:`, hangupErr?.message);
              }
            }, 3000);  // 3 秒后挂断，给告别语留出播放时间
          }

          // 把工具结果送回 OpenAI Realtime，让 AI 继续对话
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type: "conversation.item.create",
              item: {
                type:    "function_call_output",
                call_id: item.call_id,
                output:  toolResult,
              },
            }));
            // 触发 AI 基于工具结果继续说话（end_call 时 AI 不需要再说话，但保持一致）
            if (fnName !== "end_call") {
              openaiWs.send(JSON.stringify({ type: "response.create" }));
            }
          }
        }
      }

    } catch (err) {
      console.error("[OpenAI] message parse error:", err?.message);
    }
  });

  openaiWs.on("error", (err) => console.error("[OpenAI] WS error:", err?.message));
  openaiWs.on("close", ()    => console.log("[OpenAI] disconnected"));

  // ─── Twilio → OpenAI 消息处理 ─────────────
  twilioWs.on("message", async (msg) => {
    try {
      const data = JSON.parse(msg.toString());

      switch (data.event) {
        case "start": {
          streamSid = data.start?.streamSid || "";
          const startCallSid = resolveStartCallSid(data.start, urlCallSid);

          if (startCallSid && startCallSid !== activeCallSid) {
            console.log(`[WS] Rebinding ${activeCallSid} -> ${startCallSid}`);
            mergeCallSessions(startCallSid, activeCallSid);
            activeCallSid = startCallSid;
            callSession   = getOrCreateCallSession(activeCallSid);
          }

          if (streamSid) streamToCallSid.set(streamSid, activeCallSid);
          callSession.streamSid  = streamSid;
          callSession.status     = "in_progress";
          callSession.updatedAt  = new Date().toISOString();
          console.log(`[WS] stream started sid=${streamSid} call=${activeCallSid}`);
          break;
        }

        case "media":
          callSession.mediaPacketCount += 1;
          // 录入 caller 声道缓冲（时间轴基准）
          if (data.media?.payload) recorder.pushCaller(data.media.payload);
          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({
              type:  "input_audio_buffer.append",
              audio: data.media.payload,
            }));
          }
          break;

        case "stop":
          console.log(`[WS] stream stopped: ${activeCallSid}`);
          callSession.status    = "stream_closed";
          callSession.updatedAt = new Date().toISOString();
          if (streamSid) streamToCallSid.delete(streamSid);
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          // 合成双声道 WAV（时间轴对齐）
          finalizeRecording(activeCallSid, recorder);
          break;
      }
    } catch (err) {
      console.error("[Twilio] message error:", err?.message);
    }
  });

  twilioWs.on("close", () => {
    console.log(`[WS] Twilio closed: ${activeCallSid}`);
    callSession.status    = "stream_closed";
    callSession.updatedAt = new Date().toISOString();
    if (streamSid) streamToCallSid.delete(streamSid);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    // 合成双声道 WAV（stop 事件没触发时的兜底）
    finalizeRecording(activeCallSid, recorder);
  });

  twilioWs.on("error", (err) => console.error("[Twilio] WS error:", err?.message));
});

// =========================
// Start server
// =========================
server.listen(PORT, () => {
  console.log(`[Server] listening on port ${PORT}`);
});
