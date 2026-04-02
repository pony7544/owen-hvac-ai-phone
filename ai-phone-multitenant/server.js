// =============================================================
// server.js — Multi-tenant AI Phone System
// 一套代码，通过 tenants.json 配置区分不同客户。
// 每个租户独立 webhook: /twilio/voice/:tenantId
// 每个租户独立 status:  /twilio/status/:tenantId
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
const { initR2, isR2Enabled, uploadRecording, downloadRecording } = require("./services/r2.service");

// =========================
// ENV 校验
// =========================
if (!process.env.SESSION_SECRET) { console.error("FATAL: SESSION_SECRET not set."); process.exit(1); }
if (!process.env.OPENAI_API_KEY) { console.error("FATAL: OPENAI_API_KEY not set."); process.exit(1); }

const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const PORT                = process.env.PORT || 10000;
const REALTIME_MODEL      = process.env.OPENAI_REALTIME_MODEL       || "gpt-4o-realtime-preview";
const TRANSCRIPTION_MODEL = process.env.OPENAI_TRANSCRIPTION_MODEL  || "gpt-4o-mini-transcribe";
const EXTRACTION_MODEL    = process.env.OPENAI_EXTRACTION_MODEL     || "gpt-4o-mini";
const ADMIN_USER          = process.env.ADMIN_USER || "superadmin";
const ADMIN_PASS          = process.env.ADMIN_PASS || "";

// Twilio REST Client（平台级，所有租户共用）
let twilioClient = null;
if (process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN) {
  twilioClient = require("twilio")(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
  console.log("[Twilio] REST client initialized");
}

// Extraction service
const extractionService = createExtractionService({
  openaiApiKey: OPENAI_API_KEY,
  extractionModel: EXTRACTION_MODEL,
  businessTimezone: "America/Halifax",
  getOrCreateCallSession, normalizePhone,
  persistToRedis: persistToDB,
});

// callSid → tenantId 映射
const callTenantMap = new Map();
// 待匹配的 callSid 队列
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
app.get("/analytics", requireAuth, (_req, res) => res.sendFile(path.join(__dirname, "public", "analytics.html")));
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
// Helper
// =========================
function getSessionTenant(req) {
  const tid = req.session?.tenantId;
  return tid ? tenantService.getTenant(tid) : null;
}

// =========================
// Twilio Status Callback — 核心处理函数
// 所有租户的 status 回调都走这里，用 CallSid 区分，不会混淆
// =========================
function handleStatusCallback(body, tenantId) {
  const callSid = body.CallSid || "";
  if (!callSid) return;

  const s = getOrCreateCallSession(callSid);

  // tenantId 优先从 URL 参数取（最准确），其次从 map 查，最后从 session 读
  const resolvedTenantId = tenantId || callTenantMap.get(callSid) || s.tenantId || "";
  if (resolvedTenantId && !s.tenantId) s.tenantId = resolvedTenantId;

  const prevStatus = s.status;
  s.status    = body.CallStatus || s.status;
  s.from      = body.From || s.from;
  s.to        = body.To  || s.to;
  s.updatedAt = new Date().toISOString();

  // 通话接通时记录 startTime
  if (s.status === "in-progress" && !s.startTime) {
    s.startTime = new Date();
  }

  // 通话结束时记录 duration 和 endTime
  // Twilio 在 CallStatus = completed/busy/failed/no-answer 时回传 CallDuration
  const duration = parseInt(body.CallDuration || "0", 10);
  if (duration > 0) {
    s.duration = duration;
    s.endTime  = new Date();
    console.log(`[Status] callSid=${callSid} tenant=${resolvedTenantId} status=${s.status} duration=${duration}s`);
  } else {
    console.log(`[Status] callSid=${callSid} tenant=${resolvedTenantId} status=${s.status} (${prevStatus} → ${s.status})`);
  }

  // 持久化到 MongoDB（包含 duration/startTime/endTime）
  persistToDB(callSid, s);
}

// ── 每个租户自己的 status URL（推荐在 Twilio 控制台配置这个）
// 格式: POST /twilio/status/:tenantId
// Twilio 控制台 → Phone Numbers → 对应号码 → Status Callback URL:
//   https://你的域名/twilio/status/owen-hvac
//   https://你的域名/twilio/status/another-tenant
app.post("/twilio/status/:tenantId", (req, res) => {
  const { tenantId } = req.params;
  console.log(`[Status] Received for tenant=${tenantId}`);
  handleStatusCallback(req.body, tenantId);
  res.sendStatus(200);
});

// ── 兜底通用 status（向后兼容，老配置仍能用）
app.post("/twilio/voice/status", (req, res) => {
  console.log(`[Status] Received on generic endpoint`);
  handleStatusCallback(req.body, null);
  res.sendStatus(200);
});

// =========================
// Live Dashboard APIs
// =========================

// 租户基本信息 API（前端用来获取 timezone 等配置）
app.get("/api/tenant/info", requireApiAuth, (req, res) => {
  const tenant = getSessionTenant(req);
  if (!tenant) return res.json({ ok: true, timezone: "America/Halifax", businessName: "" });
  res.json({
    ok: true,
    timezone: tenant.timezone || "America/Halifax",
    businessName: tenant.businessName || "",
    businessHours: tenant.businessHours || null,
    slotInterval: tenant.slotInterval || 30,
    defaultAppointmentMinutes: tenant.defaultAppointmentMinutes || 60,
  });
});

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
    duration: call.duration || 0,
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
  res.json({
    ok: true, available: true,
    durationSec: rec.durationSec, createdAt: rec.createdAt,
    archivedToR2: rec.archivedToR2 || false,
    storage: rec.archivedToR2 ? "r2" : "mongodb",
  });
});

app.get("/api/live-call/:callSid/recording/stream", requireApiAuth, async (req, res) => {
  const call = liveCalls.get(req.params.callSid);
  if (!call) return res.status(404).json({ ok: false, error: "Call not found" });

  let rec = call.recording;
  if ((!rec || rec._fromDB) && !rec?.wavBuffer) {
    const dbRec = await loadRecordingFromDB(req.params.callSid);
    if (dbRec) { call.recording = dbRec; rec = dbRec; }
  }
  if (!rec?.available) return res.status(404).json({ ok: false, error: "Not ready" });

  let wavToSend = rec.wavBuffer || null;

  // 如果 MongoDB 中 wavBuffer 已清除（已归档到 R2），从 R2 下载
  if (!wavToSend && rec.r2Key && isR2Enabled()) {
    try {
      console.log(`[Recording] Fetching from R2: ${rec.r2Key}`);
      wavToSend = await downloadRecording(rec.r2Key);
    } catch (err) {
      console.error(`[Recording] R2 download failed: ${err?.message}`);
      return res.status(404).json({ ok: false, error: "Recording archived but R2 download failed" });
    }
  }

  if (!wavToSend) return res.status(404).json({ ok: false, error: "Recording not available" });

  // 分声道播放（只有 MongoDB 中有 frames 才支持，R2 归档后只支持混合播放）
  const channel = req.query.channel || "both";
  if (channel !== "both" && rec._callerFrames && rec._assistantFrames) {
    wavToSend = buildWav(
      channel === "left"  ? rec._callerFrames    || [] : [],
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

// =========================
// Analytics APIs
// =========================
app.get("/api/analytics/monthly", requireApiAuth, async (req, res) => {
  try {
    const tenantId = req.session.tenantId;
    const { year, month } = req.query;
    if (!year || !month) return res.status(400).json({ ok: false, error: "Year and month required" });

    const startDate = new Date(year, month - 1, 1);
    const endDate   = new Date(year, month, 0, 23, 59, 59);

    const { Call } = require("./models");
    const calls = await Call.find({
      tenantId,
      createdAt: { $gte: startDate, $lte: endDate },
    }).sort({ createdAt: -1 }).limit(100);

    const stats = {
      totalCalls: calls.length,
      totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0),
      avgDuration: 0,
      appointmentsBooked: calls.filter(c => c.extracted?.appointmentCreated).length,
      callsBySource: {},
      dailyStats: {},
    };

    if (stats.totalCalls > 0) {
      stats.avgDuration = Math.round(stats.totalDuration / stats.totalCalls);
    }

    calls.forEach(call => {
      const from = call.from || "Unknown";
      if (!stats.callsBySource[from]) stats.callsBySource[from] = { from, count: 0, totalDuration: 0 };
      stats.callsBySource[from].count++;
      stats.callsBySource[from].totalDuration += (call.duration || 0);
    });
    stats.callsBySource = Object.values(stats.callsBySource).sort((a, b) => b.count - a.count).slice(0, 10);

    calls.forEach(call => {
      const date = new Date(call.createdAt).toISOString().split("T")[0];
      if (!stats.dailyStats[date]) stats.dailyStats[date] = { date, count: 0, duration: 0 };
      stats.dailyStats[date].count++;
      stats.dailyStats[date].duration += (call.duration || 0);
    });
    stats.dailyStats = Object.values(stats.dailyStats).sort((a, b) => new Date(a.date) - new Date(b.date));

    res.json({ ok: true, stats, calls: calls.slice(0, 50) });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/api/analytics/export", requireApiAuth, async (req, res) => {
  try {
    const tenantId = req.session.tenantId;
    const { year, month, format } = req.query;

    const startDate = new Date(year, month - 1, 1);
    const endDate   = new Date(year, month, 0, 23, 59, 59);

    const { Call } = require("./models");
    const calls = await Call.find({
      tenantId,
      createdAt: { $gte: startDate, $lte: endDate },
    }).sort({ createdAt: -1 });

    if (format === "csv") {
      const csv = [
        ["Date", "Time", "From", "Duration (seconds)", "Customer Name", "Status", "Appointment"].join(","),
        ...calls.map(c => [
          new Date(c.createdAt).toLocaleDateString(),
          new Date(c.createdAt).toLocaleTimeString(),
          c.from,
          c.duration || 0,
          (c.extracted?.callerName || "").replace(/,/g, " "),
          c.status,
          c.extracted?.appointmentCreated ? "Yes" : "No",
        ].join(",")),
      ].join("\n");

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="calls-${year}-${month}.csv"`);
      res.send(csv);
    } else {
      res.json({ ok: true, calls });
    }
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
});

app.get("/api/webhook/analytics", async (req, res) => {
  try {
    const { apiKey, tenantId, year, month } = req.query;
    const tenant = tenantService.getTenant(tenantId);
    if (!tenant || tenant.apiKey !== apiKey) return res.status(401).json({ ok: false, error: "Invalid API key" });

    const startDate = new Date(year, month - 1, 1);
    const endDate   = new Date(year, month, 0, 23, 59, 59);

    const { Call } = require("./models");
    const calls = await Call.find({ tenantId, createdAt: { $gte: startDate, $lte: endDate } });
    const stats = {
      totalCalls: calls.length,
      totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0),
      avgDuration: calls.length > 0 ? Math.round(calls.reduce((sum, c) => sum + (c.duration || 0), 0) / calls.length) : 0,
      appointmentsBooked: calls.filter(c => c.extracted?.appointmentCreated).length,
    };
    res.json({ ok: true, stats });
  } catch (err) { res.status(500).json({ ok: false, error: err.message }); }
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
  const from    = req.body.From || "";
  const to      = req.body.To   || "";

  callTenantMap.set(callSid, tenantId);
  pendingCallSids.push({ callSid, ts: Date.now() });

  const callSession = getOrCreateCallSession(callSid);
  callSession.tenantId  = tenantId;
  callSession.from      = from;
  callSession.to        = to;
  callSession.status    = "initiated";
  callSession.startTime = new Date(); // ✅ 通话开始时间
  callSession.updatedAt = new Date().toISOString();

  const publicUrl = process.env.PUBLIC_WSS_URL || process.env.RENDER_EXTERNAL_URL;
  if (!publicUrl) return res.status(500).send("Missing PUBLIC_WSS_URL");

  const streamUrl = publicUrl.replace("https://", "wss://").replace("http://", "ws://");
  const greeting  = tenant?.greeting || "Hello, please hold while I connect you.";

  // ✅ statusCallback 写在 TwiML 里，自动绑定到本租户的 status URL
  // Twilio 会在通话状态变更时（包括 completed）POST 到这个地址，带上 CallDuration
  const statusCallbackUrl = `${publicUrl}/twilio/status/${tenantId}`;

  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">${greeting}</Say>
  <Connect>
    <Stream url="${streamUrl}/media-stream?callSid=${encodeURIComponent(callSid)}" />
  </Connect>
</Response>`;

  // 用 Twilio REST API 更新这通电话的 statusCallback（TwiML 里无法在 <Connect> 上直接加）
  if (twilioClient && callSid.startsWith("CA")) {
    twilioClient.calls(callSid).update({
      statusCallback: statusCallbackUrl,
      statusCallbackMethod: "POST",
      statusCallbackEvent: ["initiated", "ringing", "answered", "completed"],
    }).catch(err => console.warn(`[Twilio] statusCallback update failed: ${err?.message}`));
  }

  res.type("text/xml").send(twiml);
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
    const wavBuffer  = buildWav(callerFrames, assistantFrames);
    const s          = getOrCreateCallSession(callSid);
    const durationSec = Math.round((callerFrames.length * 160) / 8000);
    s.recording = {
      wavBuffer, _callerFrames: callerFrames, _assistantFrames: assistantFrames,
      durationSec, createdAt: new Date().toISOString(), available: true,
    };
    s.updatedAt = new Date().toISOString();
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

  let activeCallSid   = urlCallSid;
  let callSession     = getOrCreateCallSession(activeCallSid);
  let streamSid       = "";
  let assistantTranscriptBuffer = "";
  let sessionConfigured = false;
  let recordingStarted  = false;
  let tenantExtractionPrompt = "";
  let endCallTriggered = false;
  let goodbyeTimer     = null;

  const recorder = new TimelineRecorder();

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

  const openaiWs = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`,
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  function configureAndGreet() {
    if (sessionConfigured) return;
    sessionConfigured = true;

    const tenantId = callTenantMap.get(activeCallSid);
    const tenant   = tenantId ? tenantService.getTenant(tenantId) : null;

    // 如果租户有自定义 prompt 就用它，否则用 buildSystemPrompt 动态生成（含当前日期）
    let prompt   = tenant?.prompt || buildSystemPrompt(tenant || {});
    const voice  = tenant?.voice  || "alloy";
    // 使用 buildTools 动态生成工具列表（含 get_next_available_slots）
    const tools  = buildTools(tenant || {});
    const vadThreshold      = tenant?.vadThreshold      ?? 0.5;
    const silenceDurationMs = tenant?.silenceDurationMs ?? 500;
    tenantExtractionPrompt  = tenant?.extractionPrompt  || "";

    const speedMap = {
      slow:     "\n\nIMPORTANT: Speak very slowly and clearly. Pause between sentences. Give the caller plenty of time to process.",
      moderate: "\n\nSpeak at a calm, moderate pace. Pause briefly after each sentence.",
      fast:     "\n\nSpeak at a natural conversational pace.",
    };
    prompt += speedMap[tenant?.speechSpeed] || speedMap.moderate;

    console.log(`[WS] Configured: ${activeCallSid} tenant=${tenantId || "none"} voice=${voice} vad=${vadThreshold} silence=${silenceDurationMs}ms speed=${tenant?.speechSpeed || "moderate"}`);

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

  openaiWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      if (data.type === "error") {
        console.error(`[OpenAI] Error event:`, JSON.stringify(data.error || data));
      }

      if (data.type === "conversation.item.input_audio_transcription.completed" && data.transcript) {
        const t = cleanText(data.transcript);
        if (t) {
          console.log("[Caller]", t);
          pushTranscript(activeCallSid, "caller", t);
          try { await extractionService.refreshStructuredCallInfoDebounced(activeCallSid, { customExtractionPrompt: tenantExtractionPrompt }); } catch (_) {}
        }
      }

      if (data.type === "response.audio_transcript.delta" && data.delta) {
        assistantTranscriptBuffer += data.delta;
      }

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
        if (t) {
          console.log("[Assistant]", t);
          pushTranscript(activeCallSid, "assistant", t);
          try { await extractionService.refreshStructuredCallInfoDebounced(activeCallSid, { customExtractionPrompt: tenantExtractionPrompt }); } catch (_) {}
        }

        if (t && !endCallTriggered) {
          const lower = t.toLowerCase();
          const goodbyePatterns = ["goodbye", "bye", "再见", "see you", "have a great day", "take care", "au revoir", "bonne journée"];
          if (goodbyePatterns.some(p => lower.includes(p))) {
            if (goodbyeTimer) clearTimeout(goodbyeTimer);
            goodbyeTimer = setTimeout(() => {
              if (!endCallTriggered) {
                console.log(`[AutoHangup] AI said goodbye but didn't call end_call, forcing hangup`);
                forceHangup("ai_said_goodbye_no_end_call");
              }
            }, 8000);
          }
        }
      }

      // Function Calling
      if (data.type === "response.done") {
        const tenantId = callTenantMap.get(activeCallSid);
        const tenant   = tenantId ? tenantService.getTenant(tenantId) : null;
        const calSvc   = tenant?.calendarService;
        const tz       = tenant?.timezone || "America/Halifax";
        const apptMin  = tenant?.defaultAppointmentMinutes || 60;

        for (const item of (data.response?.output || [])) {
          if (item.type !== "function_call") continue;
          const fnName = item.name;
          let fnArgs = {}; try { fnArgs = JSON.parse(item.arguments || "{}"); } catch (_) {}
          console.log(`[Tool] ${fnName}`, fnArgs);
          let toolResult = "";

          if (fnName === "get_next_available_slots" && calSvc) {
            try {
              // 获取足够多的 slot 以覆盖多个不同日期
              const slots = await calSvc.getNextAvailableSlots(20, 14);
              if (!slots.length) {
                toolResult = "No available slots found in the next 14 days. Ask the caller for a preferred date and we will try to accommodate.";
              } else {
                // 按日期去重，只取前3个不同的日期
                const seenDates = new Set();
                const uniqueDates = [];
                for (const s of slots) {
                  if (!seenDates.has(s.date)) {
                    seenDates.add(s.date);
                    uniqueDates.push(s.date);
                    if (uniqueDates.length >= 3) break;
                  }
                }

                const dateDescriptions = uniqueDates.map(dateStr => {
                  const offset = calSvc.getTimezoneOffset(dateStr, "09:00", tz);
                  const dateObj = new Date(`${dateStr}T09:00:00${offset}`);
                  const dayName = dateObj.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
                  const monthDay = dateObj.toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric" });
                  return `${dayName} ${monthDay} (${dateStr})`;
                });

                toolResult = `Available dates:\n${dateDescriptions.join("\n")}\n\nIMPORTANT: Only tell the caller which DATES are available. Do NOT mention specific times yet. Example: "We have availability on Wednesday April 2nd, Thursday April 3rd, and Friday April 4th. Which day works best for you?" After the caller picks a date, call the check_availability tool with that date to get the specific time slots.`;
              }
            } catch (err) {
              console.error(`[Tool] get_next_available_slots error:`, err?.message);
              toolResult = `Could not check calendar: ${err?.message}. Ask the caller for a preferred date instead.`;
            }
          }

          if (fnName === "check_availability" && calSvc) {
            try {
              const events = await calSvc.listEventsForDay(fnArgs.date);
              const allSlots = calSvc.generateSlotsForDay(fnArgs.date, events, apptMin);

              // 最多取3个时间段推荐给客户
              const topSlots = allSlots.slice(0, 3);

              if (!topSlots.length) { toolResult = `No available time slots on ${fnArgs.date}. Ask the caller if another date works.`; }
              else {
                const offset = calSvc.getTimezoneOffset(fnArgs.date, "09:00", tz);
                const dateObj = new Date(`${fnArgs.date}T09:00:00${offset}`);
                const dayName = dateObj.toLocaleDateString("en-US", { timeZone: tz, weekday: "long" });
                const monthDay = dateObj.toLocaleDateString("en-US", { timeZone: tz, month: "long", day: "numeric" });

                const labels = topSlots.map(s => {
                  const timePart = s.start.split('T')[1].substring(0, 5);
                  const [hh, mm] = timePart.split(":").map(Number);
                  const ampm = hh >= 12 ? "PM" : "AM";
                  const h12 = hh % 12 || 12;
                  return mm === 0 ? `${h12} ${ampm}` : `${h12}:${String(mm).padStart(2,"0")} ${ampm}`;
                });

                const totalAvailable = allSlots.length;
                toolResult = `On ${dayName} ${monthDay} (${fnArgs.date}), here are ${topSlots.length} suggested time slots: ${labels.join(", ")}. (${totalAvailable} total slots available that day.)\n\nPresent these ${topSlots.length} times to the caller and ask which one works best. If the caller wants a different time, there are ${totalAvailable} slots total — ask what time they prefer and check if it's available.`;
              }
            } catch (err) { toolResult = `Calendar check failed: ${err?.message}`; }
          }

          if (fnName === "create_appointment" && calSvc) {
            try {
              const s = getOrCreateCallSession(activeCallSid);
              Object.assign(s.extracted, {
                callerName:      fnArgs.caller_name      || s.extracted.callerName,
                callbackNumber:  fnArgs.callback_number  || s.extracted.callbackNumber,
                serviceAddress:  fnArgs.service_address  || s.extracted.serviceAddress,
                issueSummary:    fnArgs.issue_summary     || s.extracted.issueSummary,
                preferredDate:   fnArgs.preferred_date   || s.extracted.preferredDate,
                preferredTime:   fnArgs.preferred_time   || s.extracted.preferredTime,
                intent:          fnArgs.intent           || s.extracted.intent,
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
            toolResult = "Call ending. Say a brief goodbye now.";
            if (goodbyeTimer) { clearTimeout(goodbyeTimer); goodbyeTimer = null; }
            console.log(`[EndCall] Delaying hangup by 6 seconds to let AI finish speaking...`);
            setTimeout(() => forceHangup(reason), 6000);
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
  openaiWs.on("close", (code, reason) => console.log(`[OpenAI] disconnected code=${code} reason=${reason?.toString() || ""}`));

  let mediaCount = 0;
  twilioWs.on("message", async (msg) => {
    try {
      const raw  = msg.toString();
      const data = JSON.parse(raw);

      if (data.event === "media") {
        mediaCount++;
        if (mediaCount <= 3 || mediaCount % 100 === 0) console.log(`[Twilio] media packet #${mediaCount}`);
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
            callSession   = getOrCreateCallSession(activeCallSid);
          }
          if (streamSid) streamToCallSid.set(streamSid, activeCallSid);
          callSession.streamSid = streamSid;
          callSession.status    = "in_progress";
          callSession.updatedAt = new Date().toISOString();
          console.log(`[WS] stream started call=${activeCallSid}`);
          if (openaiWs.readyState === WebSocket.OPEN) configureAndGreet();
          break;
        }
        case "media":
          callSession.mediaPacketCount += 1;
          if (!streamSid && data.streamSid) {
            streamSid = data.streamSid;
            streamToCallSid.set(streamSid, activeCallSid);
            callSession.streamSid = streamSid;
            callSession.status    = "in_progress";
            callSession.updatedAt = new Date().toISOString();
          }
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
          const stopCallSid = data.stop?.callSid || "";
          if (stopCallSid && stopCallSid !== activeCallSid) {
            console.log(`[WS] Stop-rebinding ${activeCallSid} -> ${stopCallSid}`);
            mergeCallSessions(stopCallSid, activeCallSid);
            if (callTenantMap.has(activeCallSid)) {
              callTenantMap.set(stopCallSid, callTenantMap.get(activeCallSid));
              callTenantMap.delete(activeCallSid);
            }
            activeCallSid = stopCallSid;
            callSession   = getOrCreateCallSession(activeCallSid);
          }
          if (!streamSid && data.streamSid) streamSid = data.streamSid;
          console.log(`[WS] stream stopped: ${activeCallSid}`);
          callSession.status    = "stream_closed";
          callSession.updatedAt = new Date().toISOString();
          if (streamSid) streamToCallSid.delete(streamSid);
          if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
          finalizeRecording(activeCallSid, recorder);
          break;
        }
      }
    } catch (err) { console.error("[Twilio] error:", err?.message); }
  });

  twilioWs.on("close", () => {
    callSession.status    = "stream_closed";
    callSession.updatedAt = new Date().toISOString();
    if (streamSid) streamToCallSid.delete(streamSid);
    if (openaiWs.readyState === WebSocket.OPEN) openaiWs.close();
    finalizeRecording(activeCallSid, recorder);
  });
  twilioWs.on("error", (err) => console.error("[Twilio] WS error:", err?.message));
});

// =========================
// Start
// =========================
(async () => {
  await connectDB();
  await tenantService.loadAll({ getOrCreateCallSession });
  await loadRecentCalls(200);

  // 初始化 R2 对象存储（可选，配置了环境变量才启用）
  initR2();

  // 定时任务：每小时扫描一次，把 2 天前的录音归档到 R2
  if (isR2Enabled()) {
    const ARCHIVE_INTERVAL_MS = 60 * 60 * 1000; // 1 小时
    const ARCHIVE_AGE_MS      = 2 * 24 * 60 * 60 * 1000; // 2 天

    async function archiveOldRecordings() {
      try {
        const { Recording } = require("./models");
        const cutoff = new Date(Date.now() - ARCHIVE_AGE_MS);

        // 找到 2 天前的、有 wavBuffer 但还没归档到 R2 的录音
        const oldRecs = await Recording.find({
          available: true,
          archivedToR2: { $ne: true },
          wavBuffer: { $ne: null },
          createdAt: { $lt: cutoff },
        }).limit(20); // 每次最多处理 20 条，避免一次性占用太多内存

        if (!oldRecs.length) return;
        console.log(`[R2 Archive] Found ${oldRecs.length} recording(s) older than 2 days to archive`);

        for (const rec of oldRecs) {
          try {
            // 1. 上传 WAV 到 R2
            const r2Key = await uploadRecording(rec.callSid, rec.wavBuffer, {
              tenantId: rec.tenantId,
              durationSec: rec.durationSec,
              createdAt: rec.createdAt?.toISOString(),
            });

            // 2. 更新 MongoDB：记录 R2 key，清除 wavBuffer 和 frames 释放空间
            await Recording.updateOne(
              { callSid: rec.callSid },
              {
                $set: { r2Key, archivedToR2: true },
                $unset: { wavBuffer: 1, callerFrames: 1, assistantFrames: 1 },
              }
            );

            // 3. 同步更新内存缓存
            const liveCall = liveCalls.get(rec.callSid);
            if (liveCall?.recording) {
              liveCall.recording.r2Key = r2Key;
              liveCall.recording.archivedToR2 = true;
              delete liveCall.recording.wavBuffer;
              delete liveCall.recording._callerFrames;
              delete liveCall.recording._assistantFrames;
            }

            console.log(`[R2 Archive] ${rec.callSid} archived → ${r2Key}`);
          } catch (err) {
            console.error(`[R2 Archive] Failed to archive ${rec.callSid}:`, err?.message);
          }
        }
      } catch (err) {
        console.error("[R2 Archive] Scan error:", err?.message);
      }
    }

    // 启动后先跑一次，之后每小时跑
    setTimeout(archiveOldRecordings, 30000); // 启动 30 秒后首次运行
    setInterval(archiveOldRecordings, ARCHIVE_INTERVAL_MS);
    console.log("[R2 Archive] Cron enabled — archiving recordings older than 2 days every hour");
  }

  server.listen(PORT, () => console.log(`[Server] listening on port ${PORT}`));
})().catch(err => {
  console.error("FATAL startup error:", err);
  process.exit(1);
});
