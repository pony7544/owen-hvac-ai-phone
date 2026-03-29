// =============================================================
// server.js — Multi-tenant AI Phone System
// 一套代码，通过 tenants.json 配置区分不同客户。
// 每个租户独立 webhook: /twilio/voice/:tenantId
// =============================================================

require("dotenv").config();
const { CallStats } = require("./models");
const { buildSystemPrompt, buildTools } = require("./prompts");
const os   = require("os");
const fs   = require("fs");
const express    = require("express");
const http       = require("http");
const path       = require("path");
const bodyParser = require("body-parser");
const WebSocket  = require("ws");
const session    = require("express-session");

const { FALLBACK_PROMPT, buildExtractionSystemPrompt } = require("./prompts");
const { connectDB } = require("./models");
const tenantService = require("./services/tenant.service");
const {
  liveCalls, streamToCallSid, cleanText, normalizePhone,
  getOrCreateCallSession, restoreCallSession, loadRecentCalls, mergeCallSessions,
  resolveStartCallSid, pushTranscript, buildCallSummary,
  persistToDB, persistRecordingToDB, loadRecordingFromDB,
} = require("./services/call-session.service");
const { createExtractionService } = require("./services/extraction.service");
const { buildWav, TimelineRecorder } = require("./services/recording.service");

// =========================
// ENV 校验
// =========================
if (!process.env.SESSION_SECRET) { console.error("FATAL: SESSION_SECRET not set."); process.exit(1); }
if (!process.env.OPENAI_API_KEY) { console.error("FATAL: OPENAI_API_KEY not set."); process.exit(1); }

const OPENAI_API_KEY    = process.env.OPENAI_API_KEY;
const PORT              = process.env.PORT || 10000;
const REALTIME_MODEL    = process.env.OPENAI_REALTIME_MODEL      || "gpt-4o-realtime-preview";
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL || "gpt-4o-mini-transcribe";
const EXTRACTION_MODEL  = process.env.OPENAI_EXTRACTION_MODEL    || "gpt-4o-mini";
const ADMIN_USER        = process.env.ADMIN_USER || "superadmin";
const ADMIN_PASS        = process.env.ADMIN_PASS || "";

// Twilio REST Client（平台级，所有租户共用）
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log("[Twilio] REST client initialized");
}

// Extraction service（平台级共用 OpenAI key）
const extractionService = createExtractionService({
  openaiApiKey: OPENAI_API_KEY,
  extractionModel: EXTRACTION_MODEL,
  businessTimezone: "America/Halifax",
  getOrCreateCallSession, normalizePhone,
  persistToRedis: persistToDB,  // extraction.service.js 内部用 persistToRedis 这个 key
});

// callSid → tenantId 映射
const callTenantMap = new Map();
// 待匹配的 callSid 队列（webhook 创建，WS 连接时消费）
const pendingCallSids = [];

// =========================
// Express App
// =========================
const app    = express();
const server = http.createServer(app);

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: "lax", secure: false, maxAge: 1000*60*60*12 },
}));
app.use(express.static(path.join(__dirname, "public")));

// =========================
// Auth
// =========================
function requireAuth(req, res, next) {
  if (req.session?.authed) return next();
  return res.redirect("/login");
}
function requireApiAuth(req, res, next) {
  if (req.session?.authed) return next();
  return res.status(401).json({ ok: false, error: "Unauthorized" });
}
function requireAdmin(req, res, next) {
  if (req.session?.authed && req.session?.isAdmin) return next();
  return res.status(403).json({ ok: false, error: "Admin only" });
}

// =========================
// Pages
// =========================
app.get("/", (_req, res) => res.send("AI Phone System is running."));
app.get("/login", (_req, res) => res.sendFile(path.join(__dirname, "public", "login.html")));
app.get("/live", requireAuth, (_req, res) => res.sendFile(path.join(__dirname, "public", "live.html")));
app.get("/calendar", requireAuth, (_req, res) => res.sendFile(path.join(__dirname, "public", "calendar.html")));
app.get("/analytics", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "analytics.html"));
});
app.get("/admin", requireAuth, (req, res) => {
  if (!req.session.isAdmin) return res.redirect("/live");
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

app.post("/login", (req, res) => {
  const username = cleanText(req.body.username);
  const password = req.body.password || "";

  // 超级管理员
  if (ADMIN_PASS && username === ADMIN_USER && password === ADMIN_PASS) {
    req.session.authed = true;
    req.session.isAdmin = true;
    req.session.tenantId = null;
    return res.redirect("/admin");
  }

  // 租户用户
  const tenant = tenantService.getByUser(username);
  if (tenant && tenant.adminPass && password === tenant.adminPass) {
    req.session.authed = true;
    req.session.isAdmin = false;
    req.session.tenantId = tenant.id;
    return res.redirect("/live");
  }

  res.status(401).send(`<html><body style="font-family:Arial;padding:24px"><h3>Login failed</h3><p>Invalid credentials.</p><p><a href="/login">Back</a></p></body></html>`);
});

app.get("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));
app.post("/logout", (req, res) => req.session.destroy(() => res.redirect("/login")));

// =========================
// Helper: 获取当前用户的 tenant
// =========================
function getSessionTenant(req) {
  const tid = req.session?.tenantId;
  return tid ? tenantService.getTenant(tid) : null;
}

// =========================
// Live Dashboard APIs
// =========================
app.get("/api/live/calls", requireApiAuth, (req, res) => {
  const tid = req.session.tenantId;
  const calls = Array.from(liveCalls.values())
    .filter(c => !tid || callTenantMap.get(c.callSid) === tid || c.tenantId === tid)
    .sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))
    .map(buildCallSummary);
  res.json({ ok: true, calls });
});

app.get("/api/live-call/:callSid", requireApiAuth, (req, res) => {
  const call = liveCalls.get(req.params.callSid);
  if (!call) return res.status(404).json({ ok: false, error: "Call not found" });
  const rec = call.recording;
  res.json({ ok: true, call: {
    callSid: call.callSid, from: call.from, to: call.to,
    status: call.status, streamSid: call.streamSid,
    createdAt: call.createdAt, updatedAt: call.updatedAt,
    transcript: call.transcript, extracted: call.extracted,
    recording: rec ? { available: !!rec.available, durationSec: rec.durationSec, createdAt: rec.createdAt } : null,
  }});
});

app.get("/api/calendar/status", requireApiAuth, async (req, res) => {
  const tenant = getSessionTenant(req);
  const cal = tenant?.calendarService;
  if (!cal) return res.status(400).json({ ok: false, error: "No calendar configured" });
  try {
    const data = await cal.testCalendarConnection();
    const tz = tenant.timezone;
    const today = new Date().toLocaleDateString("en-CA", { timeZone: tz });
    const events = await cal.listEventsForDay(today);
    const slots = cal.generateSlotsForDay(today, events, 120);
    res.json({ ok: true, connected: true, calendarId: data.id, summary: data.summary || "",
      timeZone: data.timeZone || tz, todayDate: today,
      todayEventCount: events.length, todayAvailableSlots: slots.length, slots });
  } catch (err) { res.status(500).json({ ok: false, error: err?.message }); }
});

app.post("/api/live-call/:callSid/reextract", requireApiAuth, async (req, res) => {
  try {
    const { callSid } = req.params;
    const tenant = getSessionTenant(req);
    const extracted = await extractionService.refreshStructuredCallInfo(callSid, { customExtractionPrompt: tenant?.extractionPrompt || "" });
    let created = null;
    if (tenant?.calendarService) {
      try { created = await tenant.calendarService.maybeAutoCreateAppointment(callSid); } catch (_) {}
    }
    res.json({ ok: true, extracted, createdEventId: created?.id || null });
  } catch (err) { res.status(500).json({ ok: false, error: err?.message }); }
});

app.post("/api/live-call/:callSid/create-appointment", requireApiAuth, async (req, res) => {
  const tenant = getSessionTenant(req);
  if (!tenant?.calendarService) return res.status(400).json({ ok: false, error: "No calendar" });
  try {
    const event = await tenant.calendarService.createAppointmentEvent(req.params.callSid);
    res.json({ ok: true, eventId: event.id, event });
  } catch (err) { res.status(500).json({ ok: false, error: err?.message }); }
});

// =========================
// Calendar Management APIs
// =========================
app.get("/api/calendar/events", requireApiAuth, async (req, res) => {
  const tenant = getSessionTenant(req);
  if (!tenant?.calendarService) return res.status(400).json({ ok: false, error: "No calendar" });
  try {
    const events = await tenant.calendarService.listEventsForDay(req.query.date);
    res.json({ ok: true, events });
  } catch (err) { res.status(500).json({ ok: false, error: err?.message }); }
});

app.get("/api/calendar/slots", requireApiAuth, async (req, res) => {
  const tenant = getSessionTenant(req);
  if (!tenant?.calendarService) return res.status(400).json({ ok: false, error: "No calendar" });
  try {
    const events = await tenant.calendarService.listEventsForDay(req.query.date);
    const slots = tenant.calendarService.generateSlotsForDay(req.query.date, events, 60);
    res.json({ ok: true, slots });
  } catch (err) { res.status(500).json({ ok: false, error: err?.message }); }
});

app.post("/api/calendar/block", requireApiAuth, async (req, res) => {
  const tenant = getSessionTenant(req);
  if (!tenant?.calendarService) return res.status(400).json({ ok: false, error: "No calendar" });
  const { date, startTime, endTime, reason } = req.body;
  try {
    // 通过 Google Calendar API 直接创建 blocked event
    const { google } = require("googleapis");
    const oauth2 = new google.auth.OAuth2(tenant.google.clientId, tenant.google.clientSecret);
    oauth2.setCredentials({ refresh_token: tenant.google.refreshToken });
    const calendar = google.calendar({ version: "v3", auth: oauth2 });
    const event = await calendar.events.insert({
      calendarId: tenant.google.calendarId || "primary",
      requestBody: {
        summary: reason ? `Blocked: ${reason}` : "Blocked - Unavailable",
        start: { dateTime: `${date}T${startTime}:00`, timeZone: tenant.timezone },
        end:   { dateTime: `${date}T${endTime}:00`,   timeZone: tenant.timezone },
      },
    });
    res.json({ ok: true, eventId: event.data.id });
  } catch (err) { res.status(500).json({ ok: false, error: err?.message }); }
});

app.delete("/api/calendar/events/:eventId", requireApiAuth, async (req, res) => {
  const tenant = getSessionTenant(req);
  if (!tenant?.calendarService) return res.status(400).json({ ok: false, error: "No calendar" });
  try {
    const { google } = require("googleapis");
    const oauth2 = new google.auth.OAuth2(tenant.google.clientId, tenant.google.clientSecret);
    oauth2.setCredentials({ refresh_token: tenant.google.refreshToken });
    const calendar = google.calendar({ version: "v3", auth: oauth2 });
    await calendar.events.delete({
      calendarId: tenant.google.calendarId || "primary",
      eventId: req.params.eventId,
    });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ ok: false, error: err?.message }); }
});

// =========================
// Recording APIs
// =========================
app.get("/api/live-call/:callSid/recording/info", requireApiAuth, async (req, res) => {
  const call = liveCalls.get(req.params.callSid);
  if (!call) return res.status(404).json({ ok: false, error: "Call not found" });
  let rec = call.recording;
  if ((!rec || rec._fromDB) && !rec?.wavBuffer) {
    const dbRec = await loadRecordingFromDB(req.params.callSid);
    if (dbRec) { call.recording = dbRec; rec = dbRec; }
  }
  if (!rec?.available) return res.json({ ok: true, available: false });
  res.json({ ok: true, available: true, durationSec: rec.durationSec, createdAt: rec.createdAt });
});

app.get("/api/live-call/:callSid/recording/stream", requireApiAuth, async (req, res) => {
  const call = liveCalls.get(req.params.callSid);
  if (!call) return res.status(404).json({ ok: false, error: "Call not found" });

  // 如果内存中没有录音数据，从 DB 加载
  let rec = call.recording;
  if ((!rec || rec._fromDB) && !rec?.wavBuffer) {
    const dbRec = await loadRecordingFromDB(req.params.callSid);
    if (dbRec) {
      call.recording = dbRec;
      rec = dbRec;
    }
  }
  if (!rec?.available || !rec.wavBuffer) return res.status(404).json({ ok: false, error: "Not ready" });

  const channel = req.query.channel || "both";
  let wavToSend = rec.wavBuffer;
  if (channel === "left" || channel === "right") {
    wavToSend = buildWav(
      channel === "left"  ? rec._callerFrames || [] : [],
      channel === "right" ? rec._assistantFrames || [] : [],
      true
    );
  }
  const tmpPath = path.join(os.tmpdir(), `rec-${req.params.callSid}-${channel}.wav`);
  fs.writeFile(tmpPath, wavToSend, (err) => {
    if (err) return res.status(500).json({ ok: false, error: "Write failed" });
    res.sendFile(tmpPath, {
      headers: { "Content-Type": "audio/wav", "Content-Disposition": `inline; filename="call-${req.params.callSid}.wav"` },
    }, () => fs.unlink(tmpPath, () => {}));
  });
});
// 月度统计查询
app.get("/api/analytics/monthly", requireApiAuth, async (req, res) => {
  try {
    const tenantId = req.session.tenantId;
    const { year, month } = req.query;
    
    if (!year || !month) {
      return res.status(400).json({ ok: false, error: "Year and month required" });
    }
    
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    
    const { Call } = require("./models");
    const calls = await Call.find({
      tenantId,
      createdAt: { $gte: startDate, $lte: endDate }
    }).sort({ createdAt: -1 }).limit(100);
    
    // 计算统计数据
    const stats = {
      totalCalls: calls.length,
      totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0),
      avgDuration: 0,
      appointmentsBooked: calls.filter(c => c.extracted?.appointmentCreated).length,
      callsBySource: {},
      dailyStats: {}
    };
    
    if (stats.totalCalls > 0) {
      stats.avgDuration = Math.round(stats.totalDuration / stats.totalCalls);
    }
    
    // 按来源分组
    calls.forEach(call => {
      const from = call.from || 'Unknown';
      if (!stats.callsBySource[from]) {
        stats.callsBySource[from] = { from, count: 0, totalDuration: 0 };
      }
      stats.callsBySource[from].count++;
      stats.callsBySource[from].totalDuration += (call.duration || 0);
    });
    
    stats.callsBySource = Object.values(stats.callsBySource)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    // 按日期分组
    calls.forEach(call => {
      const date = new Date(call.createdAt).toISOString().split('T')[0];
      if (!stats.dailyStats[date]) {
        stats.dailyStats[date] = { date, count: 0, duration: 0 };
      }
      stats.dailyStats[date].count++;
      stats.dailyStats[date].duration += (call.duration || 0);
    });
    
    stats.dailyStats = Object.values(stats.dailyStats)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    
    res.json({ ok: true, stats, calls: calls.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
 
// 导出 CSV
app.get("/api/analytics/export", requireApiAuth, async (req, res) => {
  try {
    const tenantId = req.session.tenantId;
    const { year, month, format } = req.query;
    
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    
    const { Call } = require("./models");
    const calls = await Call.find({
      tenantId,
      createdAt: { $gte: startDate, $lte: endDate }
    }).sort({ createdAt: -1 });
    
    if (format === 'csv') {
      const csv = [
        ['Date', 'Time', 'From', 'Duration (seconds)', 'Customer Name', 'Status', 'Appointment'].join(','),
        ...calls.map(c => [
          new Date(c.createdAt).toLocaleDateString(),
          new Date(c.createdAt).toLocaleTimeString(),
          c.from,
          c.duration || 0,
          (c.extracted?.callerName || '').replace(/,/g, ' '),
          c.status,
          c.extracted?.appointmentCreated ? 'Yes' : 'No'
        ].join(','))
      ].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="calls-${year}-${month}.csv"`);
      res.send(csv);
    } else {
      res.json({ ok: true, calls });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
 
// Webhook API（公开，需要 API Key）
app.get("/api/webhook/analytics", async (req, res) => {
  try {
    const { apiKey, tenantId, year, month } = req.query;
    
    const tenant = tenantService.getTenant(tenantId);
    if (!tenant || tenant.apiKey !== apiKey) {
      return res.status(401).json({ ok: false, error: "Invalid API key" });
    }
    
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    
    const { Call } = require("./models");
    const calls = await Call.find({
      tenantId,
      createdAt: { $gte: startDate, $lte: endDate }
    });
    
    const stats = {
      totalCalls: calls.length,
      totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0),
      avgDuration: calls.length > 0 ? Math.round(calls.reduce((sum, c) => sum + (c.duration || 0), 0) / calls.length) : 0,
      appointmentsBooked: calls.filter(c => c.extracted?.appointmentCreated).length
    };
    
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});
// =========================
// Admin APIs — 租户 CRUD
// =========================
app.get("/api/admin/tenants", requireAdmin, async (_req, res) => {
  const list = tenantService.getAllTenants().map(t => ({
    id: t.id, businessName: t.businessName, phoneNumber: t.phoneNumber,
    voice: t.voice, hasCalendar: !!(t.google?.clientId && t.google?.refreshToken),
  }));
  res.json({ ok: true, tenants: list });
});

app.get("/api/admin/tenants/:id", requireAdmin, async (req, res) => {
  const raw = await tenantService.getTenantRaw(req.params.id);
  if (!raw) return res.status(404).json({ ok: false, error: "Not found" });
  res.json({ ok: true, tenant: raw });
});

app.post("/api/admin/tenants", requireAdmin, async (req, res) => {
  try {
    await tenantService.createTenant(req.body, { getOrCreateCallSession });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err?.message }); }
});

app.put("/api/admin/tenants/:id", requireAdmin, async (req, res) => {
  try {
    await tenantService.updateTenant(req.params.id, req.body, { getOrCreateCallSession });
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err?.message }); }
});

app.delete("/api/admin/tenants/:id", requireAdmin, async (req, res) => {
  try {
    await tenantService.deleteTenant(req.params.id);
    res.json({ ok: true });
  } catch (err) { res.status(400).json({ ok: false, error: err?.message }); }
});

// =========================
// Twilio Voice Webhook — /twilio/voice/:tenantId
// =========================
app.post("/twilio/voice/:tenantId", (req, res) => {
  const { tenantId } = req.params;
  const tenant = tenantService.getTenant(tenantId);

  const callSid = req.body.CallSid || `call_${Date.now()}`;
  const from = req.body.From || "";
  const to   = req.body.To || "";

  // 绑定 callSid → tenantId
  callTenantMap.set(callSid, tenantId);
  // 放入待匹配队列，WS 连接时消费
  pendingCallSids.push({ callSid, ts: Date.now() });

  const callSession = getOrCreateCallSession(callSid);
  callSession.tenantId = tenantId;
  callSession.from = from;
  callSession.to = to;
  callSession.status = "initiated";
  callSession.updatedAt = new Date().toISOString();

  const wsUrl = process.env.PUBLIC_WSS_URL || process.env.RENDER_EXTERNAL_URL;
  if (!wsUrl) return res.status(500).send("Missing PUBLIC_WSS_URL");

  const streamUrl = wsUrl.replace("https://", "wss://").replace("http://", "ws://");
  const greeting = tenant?.greeting || "Hello, please hold while I connect you.";

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${greeting}</Say>
  <Connect>
    <Stream url="${streamUrl}/media-stream?callSid=${encodeURIComponent(callSid)}" />
  </Connect>
</Response>`;
  res.type("text/xml").send(twiml);
});

app.post("/twilio/voice/status", (req, res) => {
  const callSid = req.body.CallSid || "";
  if (callSid) {
    const s = getOrCreateCallSession(callSid);
    s.status = req.body.CallStatus || s.status;
    s.from = req.body.From || s.from;
    s.to = req.body.To || s.to;
    s.updatedAt = new Date().toISOString();
  }
  res.sendStatus(200);
});

// =========================
// 录音
// =========================
const finalizedCalls = new Set();

function finalizeRecording(callSid, recorder) {
  if (finalizedCalls.has(callSid)) return;
  const { callerFrames, assistantFrames } = recorder.finalize();
  if (!callerFrames.length && !assistantFrames.length) return;
  finalizedCalls.add(callSid);
  try {
    const wavBuffer = buildWav(callerFrames, assistantFrames);
    const s = getOrCreateCallSession(callSid);
    const durationSec = Math.round((callerFrames.length * 160) / 8000);
    s.recording = {
      wavBuffer, _callerFrames: callerFrames, _assistantFrames: assistantFrames,
      durationSec, createdAt: new Date().toISOString(), available: true,
    };
    s.updatedAt = new Date().toISOString();
    // 持久化到 MongoDB
    const tenantId = callTenantMap.get(callSid) || s.tenantId || "";
    persistToDB(callSid, s);
    persistRecordingToDB(callSid, tenantId, wavBuffer, callerFrames, assistantFrames, durationSec);
    console.log(`[Recording] WAV ready for ${callSid}, ~${durationSec}s`);
  } catch (err) { console.error("[Recording] build WAV failed:", err?.message); }
}

// =========================
// WebSocket — Twilio Media Streams
// =========================
const wss = new WebSocket.Server({ noServer: true });

server.on("upgrade", (request, socket, head) => {
  if (request.url.startsWith("/media-stream")) {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit("connection", ws, request));
  } else { socket.destroy(); }
});

wss.on("connection", async (twilioWs, request) => {
  const urlObj = new URL(request.url, `http://${request.headers.host}`);
  let urlCallSid = urlObj.searchParams.get("callSid") || "";

  console.log(`[WS] Raw URL callSid: "${urlCallSid}", pending queue size: ${pendingCallSids.length}`);

  // 如果 URL 参数没有真正的 Twilio CallSid（CA开头），从 pending 队列取
  if (!urlCallSid || !urlCallSid.startsWith("CA")) {
    const now = Date.now();
    while (pendingCallSids.length && now - pendingCallSids[0].ts > 30000) pendingCallSids.shift();
    const pending = pendingCallSids.shift();
    if (pending) {
      urlCallSid = pending.callSid;
      console.log(`[WS] Matched pending callSid: ${urlCallSid}`);
    } else {
      urlCallSid = urlCallSid || `call_${Date.now()}`;
      console.log(`[WS] No pending match, using fallback: ${urlCallSid}`);
    }
  }

  await restoreCallSession(urlCallSid);

  let activeCallSid = urlCallSid;
  let callSession = getOrCreateCallSession(activeCallSid);
  let streamSid = "";
  let assistantTranscriptBuffer = "";
  let sessionConfigured = false;
  let recordingStarted = false;
  let tenantExtractionPrompt = "";
  let endCallTriggered = false;        // end_call 是否已触发
  let goodbyeTimer = null;             // 告别后的自动挂断计时器

  const recorder = new TimelineRecorder();

  // 强制挂断函数
  function forceHangup(reason) {
    if (endCallTriggered) return;
    endCallTriggered = true;
    console.log(`[ForceHangup] ${activeCallSid}, reason: ${reason}`);
    setTimeout(async () => {
      try {
        if (twilioClient && activeCallSid.startsWith("CA")) {
          await twilioClient.calls(activeCallSid).update({ status: "completed" });
          console.log(`[ForceHangup] Successfully hung up ${activeCallSid}`);
        } else {
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
        }
      } catch (e) { console.error("[ForceHangup] failed:", e?.message); }
    }, 2000);
  }

  console.log(`[WS] Connected: ${activeCallSid}`);

  // ─── 连接 OpenAI Realtime ──────────────────
  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  /**
   * 在 start 事件 rebind 后调用，用真实 callSid 找到租户并配置 session
   */
  function configureAndGreet() {
    if (sessionConfigured) return;
    sessionConfigured = true;

    const tenantId = callTenantMap.get(activeCallSid);
    const tenant = tenantId ? tenantService.getTenant(tenantId) : null;

    let prompt = tenant?.prompt || FALLBACK_PROMPT;
    const voice  = tenant?.voice || "alloy";
    const tools  = tenant?.tools || tenantService.STANDARD_TOOLS;
    const vadThreshold = tenant?.vadThreshold ?? 0.5;
    const silenceDurationMs = tenant?.silenceDurationMs ?? 500;
    tenantExtractionPrompt = tenant?.extractionPrompt || "";

    // 根据语速设置注入 prompt 指令
    const speedMap = {
      slow: "\n\nIMPORTANT: Speak very slowly and clearly. Pause between sentences. Give the caller plenty of time to process.",
      moderate: "\n\nSpeak at a calm, moderate pace. Pause briefly after each sentence.",
      fast: "\n\nSpeak at a natural conversational pace.",
    };
    const speedInstruction = speedMap[tenant?.speechSpeed] || speedMap.moderate;
    prompt += speedInstruction;

    console.log(`[WS] Configured: ${activeCallSid} tenant=${tenantId || 'none'} voice=${voice} vad=${vadThreshold} silence=${silenceDurationMs}ms speed=${tenant?.speechSpeed || 'moderate'}`);

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: prompt,
          tools, tool_choice: "auto",
          voice,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: TRANSCRIPTION_MODEL },
          turn_detection: { type: "server_vad", threshold: vadThreshold, silence_duration_ms: silenceDurationMs, prefix_padding_ms: 300 },
        },
      }));
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio", "text"], instructions: "Greet the caller and ask how you can help today." },
      }));
    }
  }

  openaiWs.on("open", () => {
    console.log("[OpenAI] Realtime connected");
    if (streamSid) configureAndGreet();
  });

  // ─── OpenAI → Twilio ─────────────────────
  openaiWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 记录 OpenAI 发来的错误
      if (data.type === "error") {
        console.error(`[OpenAI] Error event:`, JSON.stringify(data.error || data));
      }

      if (data.type === "conversation.item.input_audio_transcription.completed" && data.transcript) {
        const t = cleanText(data.transcript);
        if (t) { console.log("[Caller]", t); pushTranscript(activeCallSid, "caller", t);
          try { await extractionService.refreshStructuredCallInfoDebounced(activeCallSid, { customExtractionPrompt: tenantExtractionPrompt }); } catch (_) {} }
      }

      if (data.type === "response.audio_transcript.delta" && data.delta) assistantTranscriptBuffer += data.delta;

      if (data.type === "response.audio.delta" && data.delta) {
        if (!recordingStarted) {
          recordingStarted = true;
          console.log(`[Recording] Started — AI first audio frame for ${activeCallSid}`);
        }
        recorder.pushAssistant(data.delta);
        if (streamSid && twilioWs.readyState === WebSocket.OPEN)
          twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: data.delta } }));
      }

      if (data.type === "response.done") {
        const t = cleanText(assistantTranscriptBuffer);
        assistantTranscriptBuffer = "";
        if (t) { console.log("[Assistant]", t); pushTranscript(activeCallSid, "assistant", t);
          try { await extractionService.refreshStructuredCallInfoDebounced(activeCallSid, { customExtractionPrompt: tenantExtractionPrompt }); } catch (_) {} }

        // 检测 AI 是否在说再见 — 如果是，启动自动挂断计时器
        if (t && !endCallTriggered) {
          const lower = t.toLowerCase();
          const goodbyePatterns = ["goodbye", "bye", "再见", "see you", "have a great day", "take care", "au revoir", "bonne journée"];
          const isGoodbye = goodbyePatterns.some(p => lower.includes(p));
          if (isGoodbye) {
            if (goodbyeTimer) clearTimeout(goodbyeTimer);
            goodbyeTimer = setTimeout(() => {
              if (!endCallTriggered) {
                console.log(`[AutoHangup] AI said goodbye but didn't call end_call, forcing hangup`);
                forceHangup("ai_said_goodbye_no_end_call");
              }
            }, 8000);  // 8 秒后如果 end_call 还没触发就强制挂断
          }
        }
      }

      // Function Calling
      if (data.type === "response.done") {
        const tenantId = callTenantMap.get(activeCallSid);
        const tenant = tenantId ? tenantService.getTenant(tenantId) : null;
        const calSvc = tenant?.calendarService;
        const tz = tenant?.timezone || "America/Halifax";
        const apptMin = tenant?.defaultAppointmentMinutes || 60;

        for (const item of (data.response?.output || [])) {
          if (item.type !== "function_call") continue;
          const fnName = item.name;
          let fnArgs = {}; try { fnArgs = JSON.parse(item.arguments || "{}"); } catch (_) {}
          console.log(`[Tool] ${fnName}`, fnArgs);
          let toolResult = "";

          if (fnName === "check_availability" && calSvc) {
            try {
              const events = await calSvc.listEventsForDay(fnArgs.date);
              const slots = calSvc.generateSlotsForDay(fnArgs.date, events, apptMin);
              if (!slots.length) { toolResult = `No available slots on ${fnArgs.date}. Ask for another date.`; }
              else {
                const labels = slots.map(s => new Date(s.start).toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" }));
                toolResult = `Available on ${fnArgs.date}: ${labels.join(", ")}. Confirm with caller.`;
              }
            } catch (err) { toolResult = `Calendar check failed: ${err?.message}`; }
          }

          if (fnName === "create_appointment" && calSvc) {
            try {
              const s = getOrCreateCallSession(activeCallSid);
              Object.assign(s.extracted, {
                callerName: fnArgs.caller_name || s.extracted.callerName,
                callbackNumber: fnArgs.callback_number || s.extracted.callbackNumber,
                serviceAddress: fnArgs.service_address || s.extracted.serviceAddress,
                issueSummary: fnArgs.issue_summary || s.extracted.issueSummary,
                preferredDate: fnArgs.preferred_date || s.extracted.preferredDate,
                preferredTime: fnArgs.preferred_time || s.extracted.preferredTime,
                intent: fnArgs.intent || s.extracted.intent,
                bookingConfirmed: true,
              });
              const event = await calSvc.createAppointmentEvent(activeCallSid);
              persistToDB(activeCallSid, s);
              toolResult = `Appointment created. Event ID: ${event.id}. Confirm to caller.`;
            } catch (err) { toolResult = `Failed: ${err?.message}. Tell caller a team member will follow up.`; }
          }

         if (fnName === "end_call") {
            const reason = fnArgs.reason || "complete";
            console.log(`[EndCall] ${activeCallSid}, reason: ${reason}`);
  
          // 告诉 AI 要挂断了，让它说再见
            toolResult = "Call ending. Say a brief goodbye now.";
  
          // 清除可能存在的自动挂断计时器
          if (goodbyeTimer) { 
            clearTimeout(goodbyeTimer); 
            goodbyeTimer = null; 
          }
  
  // ✅ 修复：延迟挂断，给 AI 充足时间说完最后的话
  console.log(`[EndCall] Delaying hangup by 6 seconds to let AI finish speaking...`);
  setTimeout(() => {
    forceHangup(reason);
  }, 6000);  // 6 秒 + forceHangup 内部的 2 秒 = 总共 8 秒
}

          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify({ type: "conversation.item.create", item: { type: "function_call_output", call_id: item.call_id, output: toolResult } }));
            if (fnName !== "end_call") openaiWs.send(JSON.stringify({ type: "response.create" }));
          }
        }
      }
    } catch (err) { console.error("[OpenAI] error:", err?.message); }
  });

  openaiWs.on("error", (err) => console.error("[OpenAI] WS error:", err?.message));
  openaiWs.on("close", (code, reason) => console.log(`[OpenAI] disconnected code=${code} reason=${reason?.toString() || ''}`));

  // ─── Twilio → OpenAI ─────────────────────
  let mediaCount = 0;
  twilioWs.on("message", async (msg) => {
    try {
      const raw = msg.toString();
      const data = JSON.parse(raw);

      // 调试：记录所有事件类型
      if (data.event === "media") {
        mediaCount++;
        if (mediaCount <= 3 || mediaCount % 100 === 0) {
          console.log(`[Twilio] media packet #${mediaCount}`);
        }
      } else {
        console.log(`[Twilio] event=${data.event}`, raw.substring(0, 400));
      }

      switch (data.event) {
        case "start": {
          streamSid = data.start?.streamSid || "";
          const startCallSid = resolveStartCallSid(data.start, urlCallSid);
          if (startCallSid && startCallSid !== activeCallSid) {
            console.log(`[WS] Rebinding ${activeCallSid} -> ${startCallSid}`);
            mergeCallSessions(startCallSid, activeCallSid);
            if (callTenantMap.has(activeCallSid)) {
              callTenantMap.set(startCallSid, callTenantMap.get(activeCallSid));
              callTenantMap.delete(activeCallSid);
            }
            activeCallSid = startCallSid;
            callSession = getOrCreateCallSession(activeCallSid);
          }
          if (streamSid) streamToCallSid.set(streamSid, activeCallSid);
          callSession.streamSid = streamSid;
          callSession.status = "in_progress";
          callSession.updatedAt = new Date().toISOString();
          console.log(`[WS] stream started call=${activeCallSid}`);
          if (openaiWs.readyState === WebSocket.OPEN) configureAndGreet();
          break;
        }
        case "media":
          callSession.mediaPacketCount += 1;

          // 提取 streamSid（有些 Twilio 版本不发 start 事件）
          if (!streamSid && data.streamSid) {
            streamSid = data.streamSid;
            streamToCallSid.set(streamSid, activeCallSid);
            callSession.streamSid = streamSid;
            callSession.status = "in_progress";
            callSession.updatedAt = new Date().toISOString();
          }

          // 第一个 media 包到达时触发 configureAndGreet（兜底 start 事件缺失）
          if (!sessionConfigured && openaiWs.readyState === WebSocket.OPEN) {
            console.log(`[WS] First media received, configuring session for ${activeCallSid}`);
            configureAndGreet();
          }

          if (data.media?.payload) {
            if (recordingStarted) recorder.pushCaller(data.media.payload);
          }
          if (openaiWs.readyState === WebSocket.OPEN)
            openaiWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: data.media.payload }));
          break;
        case "stop": {
          // 从 stop 事件提取真正的 callSid 做最后的 rebind
          const stopCallSid = data.stop?.callSid || "";
          if (stopCallSid && stopCallSid !== activeCallSid) {
            console.log(`[WS] Stop-rebinding ${activeCallSid} -> ${stopCallSid}`);
            mergeCallSessions(stopCallSid, activeCallSid);
            if (callTenantMap.has(activeCallSid)) {
              callTenantMap.set(stopCallSid, callTenantMap.get(activeCallSid));
              callTenantMap.delete(activeCallSid);
            }
            activeCallSid = stopCallSid;
            callSession = getOrCreateCallSession(activeCallSid);
          }
          if (!streamSid && data.streamSid) streamSid = data.streamSid;

          console.log(`[WS] stream stopped: ${activeCallSid}`);
          callSession.status = "stream_closed"; callSession.updatedAt = new Date().toISOString();
          if (streamSid) streamToCallSid.delete(streamSid);
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          finalizeRecording(activeCallSid, recorder);
          break;
        }
      }
    } catch (err) { console.error("[Twilio] error:", err?.message); }
  });

  twilioWs.on("close", () => {
    callSession.status = "stream_closed"; callSession.updatedAt = new Date().toISOString();
    if (streamSid) streamToCallSid.delete(streamSid);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    finalizeRecording(activeCallSid, recorder);
  });
  twilioWs.on("error", (err) => console.error("[Twilio] WS error:", err?.message));
});

// =========================
// Start (async — connect DB first)
// =========================
(async () => {
  await connectDB();
  await tenantService.loadAll({ getOrCreateCallSession });
  await loadRecentCalls(200);

  server.listen(PORT, () => console.log(`[Server] listening on port ${PORT}`));
})().catch(err => {
  console.error("FATAL startup error:", err);
  process.exit(1);
});
