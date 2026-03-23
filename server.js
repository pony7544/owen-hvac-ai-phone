require("dotenv").config();

const express = require("express");
const http = require("http");
const path = require("path");
const bodyParser = require("body-parser");
const WebSocket = require("ws");
const { google } = require("googleapis");

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
// production可换Redis
// =========================
const liveCalls = new Map();
/*
liveCalls[callSid] = {
  callSid,
  streamSid,
  transcript: [],
  lastAssistantText: "",
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

function pushTranscript(callSid, role, text) {
  const session = getOrCreateCallSession(callSid);
  session.transcript.push({
    role,
    text,
    ts: new Date().toISOString(),
  });
}

function normalizePhone(phone) {
  if (!phone) return "";
  return phone.replace(/[^\d+]/g, "").trim();
}

function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function monthNameToNumber(name) {
  const months = {
    january: 1,
    february: 2,
    march: 3,
    april: 4,
    may: 5,
    june: 6,
    july: 7,
    august: 8,
    september: 9,
    october: 10,
    november: 11,
    december: 12,
  };
  return months[(name || "").toLowerCase()] || null;
}

function parseAssistantConfirmation(text) {
  const raw = cleanText(text);
  const result = {};

  // name
  const nameMatch =
    raw.match(/name as ([^,\.]+)/i) ||
    raw.match(/your name is ([^,\.]+)/i) ||
    raw.match(/i have your name as ([^,\.]+)/i);
  if (nameMatch) result.name = cleanText(nameMatch[1]);

  // phone
  const phoneMatch =
    raw.match(/phone number as ([+\d\-\s\(\)]+)/i) ||
    raw.match(/callback number as ([+\d\-\s\(\)]+)/i) ||
    raw.match(/number as ([+\d\-\s\(\)]+)/i);
  if (phoneMatch) result.phone = cleanText(phoneMatch[1]);

  // address
  const addressMatch =
    raw.match(/address as ([^\.]+?)(?:, and the issue is| and the issue is|\.|$)/i) ||
    raw.match(/service address as ([^\.]+?)(?:, and the issue is| and the issue is|\.|$)/i);
  if (addressMatch) result.address = cleanText(addressMatch[1]);

  // issue
  const issueMatch =
    raw.match(/issue is (.+?)(?:\.| is that all correct| perfect)/i) ||
    raw.match(/problem is (.+?)(?:\.| is that all correct| perfect)/i);
  if (issueMatch) result.issue = cleanText(issueMatch[1]);

  // confirmation
  if (
    /is that all correct/i.test(raw) ||
    /just to confirm/i.test(raw) ||
    /we've recorded your appointment request/i.test(raw)
  ) {
    result.confirmationPromptSeen = true;
  }

  // appointment date + time
  // e.g. "appointment on March 25 at 8 o'clock"
  const dateTimeMatch =
    raw.match(/appointment on ([a-zA-Z]+ \d{1,2}) at ([^\.]+?)(?:\.| just to confirm)/i) ||
    raw.match(/prefer an appointment on ([a-zA-Z]+ \d{1,2}) at ([^\.]+?)(?:\.| just to confirm)/i) ||
    raw.match(/like the appointment on ([a-zA-Z]+ \d{1,2}) at ([^\.]+?)(?:\.| just to confirm)/i);

  if (dateTimeMatch) {
    result.preferredDateRaw = cleanText(dateTimeMatch[1]);
    result.preferredTimeRaw = cleanText(dateTimeMatch[2]);
  }

  return result;
}

function mergeExtracted(target, incoming) {
  for (const key of Object.keys(incoming)) {
    if (
      incoming[key] !== undefined &&
      incoming[key] !== null &&
      incoming[key] !== ""
    ) {
      target[key] = incoming[key];
    }
  }
}

function parsePreferredDateTime(dateRaw, timeRaw, timezone = BUSINESS_TIMEZONE) {
  if (!dateRaw || !timeRaw) return null;

  // 支持 "March 25"
  const dateMatch = dateRaw.match(/^([A-Za-z]+)\s+(\d{1,2})$/);
  if (!dateMatch) return null;

  const month = monthNameToNumber(dateMatch[1]);
  const day = parseInt(dateMatch[2], 10);
  if (!month || !day) return null;

  // 默认按今年；若已过去太多，可改成明年
  const now = new Date();
  let year = now.getFullYear();

  // time parse
  // 例：8 o'clock / 8:30 / 5 pm / 5:30 pm
  let hour = null;
  let minute = 0;
  const t = timeRaw.toLowerCase().replace(/\s+/g, " ").trim();

  let m =
    t.match(/^(\d{1,2})\s*o'?clock$/) ||
    t.match(/^(\d{1,2})$/) ||
    t.match(/^(\d{1,2}):(\d{2})$/) ||
    t.match(/^(\d{1,2})\s*(am|pm)$/) ||
    t.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);

  if (!m) return null;

  if (m.length === 2) {
    hour = parseInt(m[1], 10);
  } else if (m.length === 3 && /^\d+$/.test(m[1]) && /^\d+$/.test(m[2])) {
    hour = parseInt(m[1], 10);
    minute = parseInt(m[2], 10);
  } else if (m.length === 3) {
    hour = parseInt(m[1], 10);
    const ampm = m[2];
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  } else if (m.length === 4) {
    hour = parseInt(m[1], 10);
    minute = parseInt(m[2], 10);
    const ampm = m[3];
    if (ampm === "pm" && hour < 12) hour += 12;
    if (ampm === "am" && hour === 12) hour = 0;
  }

  // 对纯数字时间做简单业务推断：
  // 1-8 默认下午更常见，可按实际业务调整
  if (/^\d{1,2}$/.test(t) || /^\d{1,2}\s*o'?clock$/.test(t)) {
    if (hour >= 1 && hour <= 8) hour += 12;
  }

  const start = new Date(year, month - 1, day, hour, minute, 0, 0);

  // 如果日期已经过去很多，可自动挪到明年
  if (start.getTime() < now.getTime() - 24 * 60 * 60 * 1000) {
    start.setFullYear(year + 1);
  }

  const end = new Date(start.getTime() + DEFAULT_APPOINTMENT_MINUTES * 60000);

  return {
    start,
    end,
    timezone,
  };
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
    throw new Error("Unable to parse preferred date/time from confirmation text.");
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
// WebSocket servers
// 1) /media-stream for Twilio
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

  // OpenAI Realtime WS
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
Your job is to speak naturally and help callers with service, repair, maintenance, quotes, and booking.

Goals:
1. Identify the caller's intent.
2. Collect:
   - full name
   - callback number
   - full service address
   - short issue summary
   - preferred appointment date
   - preferred appointment time
3. Once you have all details, read them back in one confirmation sentence using this style exactly:

"Got it. You’d prefer an appointment on [DATE] at [TIME]. Just to confirm, I have your name as [NAME], your phone number as [PHONE], the address as [ADDRESS], and the issue is [ISSUE]. Is that all correct?"

4. If the caller confirms, say:
"Perfect. We’ve recorded your appointment request. A team member will follow up soon to confirm. Thanks for calling ${BUSINESS_NAME}."

Rules:
- Keep answers short and phone-friendly.
- Ask one thing at a time if information is missing.
- Do not invent customer details.
- Use English unless caller speaks another language.
- If the caller gives a preferred date/time, restate it clearly.
- Once caller confirms all details are correct, that means booking is confirmed.
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

    // 首句
    openaiWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions: `Greet the caller and ask how you can help today.`,
        },
      })
    );
  });

  openaiWs.on("message", async (message) => {
    try {
      const data = JSON.parse(message.toString());

      // 返回音频给Twilio
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

      // assistant 文本片段
      if (data.type === "response.output_text.delta" && data.delta) {
        session.lastAssistantText += data.delta;
      }

      // assistant 一轮结束
      if (data.type === "response.done") {
        const assistantText = cleanText(session.lastAssistantText);

        if (assistantText) {
          pushTranscript(callSid, "assistant", assistantText);
          console.log("Assistant:", assistantText);

          const parsed = parseAssistantConfirmation(assistantText);
          mergeExtracted(session.extracted, parsed);

          // 如果assistant明确是在确认详情
          if (parsed.confirmationPromptSeen) {
            // 可认为intent大概率是service_or_repair
            if (!session.extracted.intent) {
              session.extracted.intent = "service_or_repair";
            }
          }

          // 如果assistant已经说“已记录预约请求”，也算用户确认完毕之后的结束语
          if (/we[’']?ve recorded your appointment request/i.test(assistantText)) {
            session.extracted.bookingConfirmed = true;
          }

          session.lastAssistantText = "";

          // 自动创建预约
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

// =========================
// Manual update endpoint
// 供你前端测试右侧表单写入
// =========================
app.post("/api/live-call/:callSid/update", async (req, res) => {
  try {
    const callSid = req.params.callSid;
    const session = getOrCreateCallSession(callSid);

    mergeExtracted(session.extracted, req.body);

    if (req.body.bookingConfirmed === true) {
      session.extracted.bookingConfirmed = true;
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
// optional: mark customer confirmation
// 当你从caller转写里识别到 “correct / yes / that's right” 可调这个
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
