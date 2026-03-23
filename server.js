const { HVACCalendarService } = require("./service");
const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");
const twilio = require("twilio");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let calendarService = null;

const DATA_DIR = path.join(__dirname, "data");
const CALLS_FILE = path.join(DATA_DIR, "calls.json");

const LIVE_AGENT_NUMBER = process.env.LIVE_AGENT_NUMBER || "";
const APP_MODE = (process.env.APP_MODE || "menu").toLowerCase();

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "";
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || "";
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || "";
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

const DEFAULT_APPOINTMENT_MINUTES = Number(
  process.env.DEFAULT_APPOINTMENT_MINUTES || 60
);

const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/Halifax";

const twilioClient =
  TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN
    ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN)
    : null;

// 实时通话会话
const liveSessions = new Map();

// SSE 客户端集合
const sseClients = new Set();

const HVAC_SYSTEM_PROMPT = `
You are the phone assistant for Owen HVAC Corp in Nova Scotia, Canada.

Your role is to act like a professional phone intake coordinator for an HVAC company.

Your goals:
1. Greet the caller briefly.
2. Determine whether the call is about:
   - new heat pump installation
   - service or repair
   - rebate or grant questions
3. Collect these fields in a natural phone conversation:
   - caller name
   - callback number
   - service address
   - short issue summary or job request
   - preferred appointment date
   - preferred appointment time
4. Confirm important details clearly.
5. Keep responses short and spoken, not written.

Rules:
- Ask one question at a time.
- Be concise and professional.
- Do not promise exact pricing.
- Do not make final rebate eligibility decisions.
- If unsure, say a team member will follow up.
- If the caller gives an address, phone number, date, or time, repeat it back clearly for confirmation.
- After collecting enough information, summarize the call and confirm:
  caller name, callback number, address, issue, preferred appointment date and preferred appointment time.
- After confirmation, politely tell the caller the appointment request has been recorded.

Important classification hints:
- "install", "new heat pump", "quote", "estimate", "replace system" => new_installation
- "service", "repair", "not working", "error code", "broken", "no heat", "no cooling" => service_or_repair
- "rebate", "grant", "program", "efficiency", "incentive" => rebate_questions

Very important:
- Do not invent a date or time.
- If the caller has not clearly provided a preferred date and time, ask for it.
- Before finishing, ask for confirmation like:
  "Just to confirm, I have your name as ..., your phone number as ..., the address as ..., and you’d like an appointment on ... at .... Is that correct?"
`;

function getCalendarService() {
  if (!calendarService) {
    calendarService = new HVACCalendarService();
  }
  return calendarService;
}

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(CALLS_FILE)) {
    fs.writeFileSync(CALLS_FILE, JSON.stringify([], null, 2), "utf8");
  }
}

function readCalls() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(CALLS_FILE, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    console.error("Failed to read calls file:", err);
    return [];
  }
}

function saveAllCalls(calls) {
  ensureStorage();
  fs.writeFileSync(CALLS_FILE, JSON.stringify(calls, null, 2), "utf8");
}

function saveCallRecord(record) {
  const calls = readCalls();
  calls.push(record);
  saveAllCalls(calls);
}

function updateCallRecord(callSid, updates) {
  const calls = readCalls();
  const index = calls.findIndex((item) => item.callSid === callSid);

  if (index >= 0) {
    calls[index] = {
      ...calls[index],
      ...updates,
      updatedAt: new Date().toISOString(),
    };
  } else {
    calls.push({
      callSid,
      ...updates,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
  }

  saveAllCalls(calls);
}

function getLiveState() {
  return Array.from(liveSessions.values()).sort((a, b) => {
    return new Date(b.startedAt || 0) - new Date(a.startedAt || 0);
  });
}

function broadcastLiveState() {
  const payload = JSON.stringify({
    type: "snapshot",
    sessions: getLiveState(),
  });

  for (const res of sseClients) {
    try {
      res.write(`data: ${payload}\n\n`);
    } catch (err) {
      console.error("SSE write error:", err);
    }
  }
}

function ensureLiveSession(callSid, initial = {}) {
  if (!callSid) return null;

  if (!liveSessions.has(callSid)) {
    liveSessions.set(callSid, {
      callSid,
      from: initial.from || "",
      to: initial.to || "",
      status: initial.status || "started",
      streamSid: initial.streamSid || "",
      direction: initial.direction || "incoming",
      startedAt: initial.startedAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      activeSpeaker: "",
      summary: "",
      selection: initial.selection || "",
      transcript: [],
      fields: {
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

  return liveSessions.get(callSid);
}

function updateLiveSession(callSid, updates = {}) {
  const session = ensureLiveSession(callSid);
  if (!session) return null;

  Object.assign(session, updates, {
    updatedAt: new Date().toISOString(),
  });

  broadcastLiveState();
  return session;
}

function detectConfirmation(session, text) {
  if (!session || !text) return;

  const lower = text.toLowerCase();

  const yesWords = [
    "yes",
    "correct",
    "that's right",
    "that is right",
    "sounds good",
    "okay",
    "ok",
    "confirmed",
    "yes that's correct",
    "yes that is correct",
  ];

  if (yesWords.some((w) => lower.includes(w))) {
    session.fields.bookingConfirmed = true;
  }
}

function extractDateTimeFields(session, text) {
  if (!session || !text) return;

  const raw = text.trim();

  const datePatterns = [
    /\b(20\d{2}-\d{2}-\d{2})\b/i,
    /\b(\d{1,2}\/\d{1,2}\/20\d{2})\b/i,
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:,\s*20\d{2})?\b/i,
    /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)\s+\d{1,2}(?:,\s*20\d{2})?\b/i,
    /\b(today)\b/i,
    /\b(tomorrow)\b/i,
  ];

  const timePatterns = [
    /\b(\d{1,2}:\d{2}\s?(am|pm))\b/i,
    /\b(\d{1,2}\s?(am|pm))\b/i,
    /\b(\d{1,2}:\d{2})\b/i,
  ];

  for (const p of datePatterns) {
    const m = raw.match(p);
    if (m && !session.fields.preferredDate) {
      session.fields.preferredDate = m[0].trim();
      break;
    }
  }

  for (const p of timePatterns) {
    const m = raw.match(p);
    if (m && !session.fields.preferredTime) {
      session.fields.preferredTime = m[0].trim();
      break;
    }
  }
}

function extractFieldsFromText(session, role, text) {
  if (!session || !text) return;

  const lower = text.toLowerCase();

  if (!session.fields.intent) {
    if (
      lower.includes("install") ||
      lower.includes("new heat pump") ||
      lower.includes("quote") ||
      lower.includes("estimate") ||
      lower.includes("replace")
    ) {
      session.fields.intent = "new_installation";
    } else if (
      lower.includes("service") ||
      lower.includes("repair") ||
      lower.includes("error code") ||
      lower.includes("not working") ||
      lower.includes("broken") ||
      lower.includes("no heat") ||
      lower.includes("no cooling")
    ) {
      session.fields.intent = "service_or_repair";
    } else if (
      lower.includes("rebate") ||
      lower.includes("grant") ||
      lower.includes("program") ||
      lower.includes("incentive") ||
      lower.includes("efficiency")
    ) {
      session.fields.intent = "rebate_questions";
    }
  }

  detectConfirmation(session, text);

  if (role !== "caller") return;

  const namePatterns = [
    /my name is ([a-z ,.'-]+)/i,
    /this is ([a-z ,.'-]+)/i,
    /i am ([a-z ,.'-]+)/i,
    /i'm ([a-z ,.'-]+)/i,
  ];

  for (const p of namePatterns) {
    const m = text.match(p);
    if (m && !session.fields.callerName) {
      session.fields.callerName = m[1].trim();
      break;
    }
  }

  const phoneMatch = text.match(
    /(\+?1?[\s\-().]*\d{3}[\s\-().]*\d{3}[\s\-().]*\d{4})/
  );
  if (phoneMatch && !session.fields.callbackNumber) {
    session.fields.callbackNumber = phoneMatch[1].trim();
  }

  const addressMatch = text.match(
    /\b\d{1,6}\s+[A-Za-z0-9.'-]+\s+(Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Lane|Ln|Court|Ct|Boulevard|Blvd|Highway|Hwy|Way|Place|Pl|Terrace|Ter)\b.*?/i
  );
  if (addressMatch && !session.fields.serviceAddress) {
    session.fields.serviceAddress = addressMatch[0].trim();
  }

  extractDateTimeFields(session, text);

  if (text.trim().length > 12) {
    const lowerText = text.toLowerCase();

    const ignorePhrases = [
      "yes",
      "correct",
      "that's right",
      "that is right",
      "sounds good",
      "okay",
      "ok",
      "confirmed",
    ];

    const isMostlyConfirmation = ignorePhrases.some((p) =>
      lowerText.includes(p)
    );

    if (!isMostlyConfirmation) {
      session.fields.issueSummary = text.trim();
    }
  }
}

function normalizePreferredDate(rawDate) {
  if (!rawDate) return "";

  const value = String(rawDate).trim().toLowerCase();
  const now = new Date();

  if (value === "today") {
    return now.toISOString().slice(0, 10);
  }

  if (value === "tomorrow") {
    const d = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return d.toISOString().slice(0, 10);
  }

  const direct = new Date(rawDate);
  if (!Number.isNaN(direct.getTime())) {
    return direct.toISOString().slice(0, 10);
  }

  return "";
}

function normalizePreferredTime(rawTime) {
  if (!rawTime) return "";
  return String(rawTime).trim().toUpperCase();
}

function buildPreferredDateTime(fields) {
  if (!fields) return "";

  if (fields.preferredDateTime) return fields.preferredDateTime;

  const normalizedDate = normalizePreferredDate(fields.preferredDate);
  const normalizedTime = normalizePreferredTime(fields.preferredTime);

  if (!normalizedDate || !normalizedTime) return "";

  const combined = `${normalizedDate} ${normalizedTime}`;
  const parsed = new Date(combined);

  if (Number.isNaN(parsed.getTime())) {
    return "";
  }

  return parsed.toISOString();
}

function mapIntentToServiceType(intent) {
  if (intent === "new_installation") return "Heat Pump Estimate";
  if (intent === "service_or_repair") return "Service Call";
  if (intent === "rebate_questions") return "Rebate Consultation";
  return "HVAC Appointment";
}

async function createAppointmentViaApi(
  payload,
  reqHost = `127.0.0.1:${process.env.PORT || 10000}`
) {
  const baseUrl = `http://${reqHost}`;

  const res = await fetch(`${baseUrl}/appointments`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || "Failed to create appointment");
  }

  return data;
}

async function maybeAutoCreateAppointment(
  callSid,
  reqHost = `127.0.0.1:${process.env.PORT || 10000}`
) {
  const session = liveSessions.get(callSid);
  if (!session) return;

  const f = session.fields || {};

  if (f.appointmentCreated) return;

  const startDateTime = buildPreferredDateTime(f);

  const hasRequired =
    f.callerName &&
    f.callbackNumber &&
    f.serviceAddress &&
    f.issueSummary &&
    startDateTime &&
    f.bookingConfirmed;

  if (!hasRequired) return;

  try {
    const serviceType = mapIntentToServiceType(f.intent);

    const result = await createAppointmentViaApi(
      {
        customerName: f.callerName,
        phone: f.callbackNumber,
        address: f.serviceAddress,
        serviceType,
        startDateTime,
        durationMinutes: DEFAULT_APPOINTMENT_MINUTES,
        notes: f.issueSummary,
      },
      reqHost
    );

    f.preferredDateTime = startDateTime;
    f.appointmentCreated = true;
    f.appointmentEventId = result?.event?.eventId || "";

    session.summary =
      buildCallSummary(session) +
      (f.appointmentEventId
        ? ` | Appointment Created: ${f.appointmentEventId}`
        : "");
    session.updatedAt = new Date().toISOString();

    updateCallRecord(callSid, {
      extractedFields: f,
      appointmentCreated: true,
      appointmentEventId: f.appointmentEventId,
      summary: session.summary,
    });

    broadcastLiveState();
    console.log("Appointment auto-created:", f.appointmentEventId);
  } catch (err) {
    console.error("Auto appointment creation failed:", err.message);
  }
}

function appendTranscript(callSid, role, text) {
  if (!callSid || !text) return;

  const session = ensureLiveSession(callSid);
  if (!session) return;

  if (!Array.isArray(session.transcript)) {
    session.transcript = [];
  }

  const clean = String(text).replace(/\s+/g, " ").trim();
  if (!clean) return;

  const last = session.transcript[session.transcript.length - 1];

  if (last && last.role === role) {
    const needsSpace =
      last.text &&
      !last.text.endsWith(" ") &&
      ![".", ",", "!", "?", ":", ";"].includes(clean[0]);

    last.text = `${last.text}${needsSpace ? " " : ""}${clean}`.trim();
    last.at = new Date().toISOString();
  } else {
    session.transcript.push({
      role,
      text: clean,
      at: new Date().toISOString(),
    });
  }

  session.updatedAt = new Date().toISOString();

  if (role === "caller") {
    extractFieldsFromText(session, role, clean);

    const hostForInternalApi = `127.0.0.1:${process.env.PORT || 10000}`;
    maybeAutoCreateAppointment(callSid, hostForInternalApi).catch((err) => {
      console.error("maybeAutoCreateAppointment error:", err.message);
    });
  }

  broadcastLiveState();
}

function buildCallSummary(session) {
  if (!session) return "";

  const fields = session.fields || {};
  const parts = [];

  if (fields.intent) parts.push(`Intent: ${fields.intent}`);
  if (fields.callerName) parts.push(`Name: ${fields.callerName}`);
  if (fields.callbackNumber) parts.push(`Callback: ${fields.callbackNumber}`);
  if (fields.serviceAddress) parts.push(`Address: ${fields.serviceAddress}`);
  if (fields.issueSummary) parts.push(`Issue: ${fields.issueSummary}`);
  if (fields.preferredDate)
    parts.push(`Preferred Date: ${fields.preferredDate}`);
  if (fields.preferredTime)
    parts.push(`Preferred Time: ${fields.preferredTime}`);
  if (fields.bookingConfirmed) parts.push(`Confirmed: yes`);
  if (fields.appointmentCreated) parts.push(`Appointment Created: yes`);
  if (fields.appointmentEventId)
    parts.push(`Event ID: ${fields.appointmentEventId}`);

  if (!parts.length) {
    const transcriptText = Array.isArray(session.transcript)
      ? session.transcript.map((t) => `[${t.role}] ${t.text}`).join(" ")
      : "";
    return transcriptText.slice(0, 500);
  }

  return parts.join(" | ");
}

function finalizeSession(callSid) {
  const session = liveSessions.get(callSid);
  if (!session) return;

  session.activeSpeaker = "";
  session.summary = buildCallSummary(session);

  updateCallRecord(callSid, {
    transcript: session.transcript,
    extractedFields: session.fields,
    summary: session.summary || "",
    liveStatus: session.status,
  });

  broadcastLiveState();

  setTimeout(() => {
    liveSessions.delete(callSid);
    broadcastLiveState();
  }, 5 * 60 * 1000);
}

function buildMenuTwiml(host) {
  const gatherActionUrl = `https://${host}/twilio/voice/menu`;

  return `
<Response>
  <Say language="en-US" voice="alice">
    Thank you for calling Owen H V A C Corp.
  </Say>
  <Pause length="1"/>
  <Say language="en-US" voice="alice">
    For a new heat pump installation, press 1.
    For service or repair, press 2.
    For rebate or grant questions, press 3.
    To speak with our team directly, press 0.
  </Say>
  <Gather numDigits="1" action="${gatherActionUrl}" method="POST" timeout="8">
    <Say language="en-US" voice="alice">
      Please make your selection now.
    </Say>
  </Gather>
  <Say language="en-US" voice="alice">
    We did not receive your selection.
    Please call again, or our team will follow up shortly.
  </Say>
  <Hangup/>
</Response>`.trim();
}

function buildAiStreamTwiml(host) {
  const streamUrl = `wss://${host}/twilio/stream`;

  return `
<Response>
  <Connect>
    <Stream url="${streamUrl}" />
  </Connect>
</Response>`.trim();
}

function parseDateRangeFromQuery(dateStr) {
  const date = String(dateStr || "").trim();
  if (!date) {
    throw new Error("date is required, format: YYYY-MM-DD");
  }

  const start = new Date(`${date}T00:00:00-03:00`);
  const end = new Date(`${date}T23:59:59-03:00`);

  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
    throw new Error("Invalid date format. Use YYYY-MM-DD");
  }

  return { start, end, date };
}

function attachRealtimeBridge(server) {
  const wss = new WebSocketServer({
    server,
    path: "/twilio/stream",
  });

  wss.on("connection", (twilioWs) => {
    console.log("=== Twilio stream connected ===");

    let streamSid = null;
    let callSid = null;
    let openAiReady = false;
    let twilioStarted = false;
    let initialGreetingSent = false;

    if (!OPENAI_API_KEY) {
      console.error("OPENAI_API_KEY is missing");
      try {
        twilioWs.close();
      } catch {}
      return;
    }

    const openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    function maybeStartInitialGreeting() {
      if (!openAiReady || !twilioStarted || initialGreetingSent) return;
      initialGreetingSent = true;

      const initialResponse = {
        type: "response.create",
        response: {
          output_modalities: ["audio", "text"],
          instructions:
            "Greet the caller briefly and say: Thank you for calling Owen HVAC Corp. Are you calling about a new installation, service or repair, or rebate questions?",
        },
      };

      openaiWs.send(JSON.stringify(initialResponse));
    }

    openaiWs.on("open", () => {
      console.log("=== OpenAI realtime connected ===");
      openAiReady = true;

      const sessionUpdate = {
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: HVAC_SYSTEM_PROMPT,
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          turn_detection: {
            type: "server_vad",
            threshold: 0.5,
            prefix_padding_ms: 300,
            silence_duration_ms: 500,
            create_response: true,
          },
          input_audio_transcription: {
            model: "gpt-4o-mini-transcribe",
          },
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      maybeStartInitialGreeting();
    });

    openaiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        if (msg.type) {
          console.log("OpenAI raw event type:", msg.type);
        }

        if (
          msg.type === "session.created" ||
          msg.type === "session.updated" ||
          msg.type === "response.done" ||
          msg.type === "error"
        ) {
          console.log("OpenAI event:", msg.type);
          if (msg.type === "error") {
            console.error("OpenAI error payload:", JSON.stringify(msg));
          }
        }

        if (msg.type === "response.audio_transcript.delta" && msg.delta) {
          console.log("AI transcript delta:", msg.delta);

          updateLiveSession(callSid, {
            activeSpeaker: "assistant",
          });

          appendTranscript(callSid, "assistant", msg.delta);
        }

        if (
          msg.type ===
            "conversation.item.input_audio_transcription.completed" &&
          msg.transcript
        ) {
          console.log("Caller transcript:", msg.transcript);

          updateLiveSession(callSid, {
            activeSpeaker: "caller",
          });

          appendTranscript(callSid, "caller", msg.transcript);
        }

        if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
          console.log("OpenAI audio delta received, length:", msg.delta.length);

          updateLiveSession(callSid, {
            activeSpeaker: "assistant",
          });

          const mediaMsg = {
            event: "media",
            streamSid,
            media: {
              payload: msg.delta,
            },
          };

          twilioWs.send(JSON.stringify(mediaMsg));

          twilioWs.send(
            JSON.stringify({
              event: "mark",
              streamSid,
              mark: { name: "ai-audio-chunk" },
            })
          );

          console.log("Sent audio back to Twilio stream:", streamSid);
        }
      } catch (err) {
        console.error("Failed to parse OpenAI message:", err);
      }
    });

    openaiWs.on("close", () => {
      console.log("=== OpenAI realtime disconnected ===");
    });

    openaiWs.on("error", (err) => {
      console.error("OpenAI websocket error:", err);
    });

    twilioWs.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());

        if (msg.event === "start") {
          streamSid = msg.start?.streamSid || null;
          callSid =
            msg.start?.callSid || msg.start?.customParameters?.CallSid || null;

          twilioStarted = true;

          console.log("Twilio stream started:", streamSid);
          console.log("Twilio callSid:", callSid);

          if (callSid) {
            ensureLiveSession(callSid, {
              streamSid,
              status: "in_progress",
              selection: "ai_mode",
            });
            updateLiveSession(callSid, {
              streamSid,
              status: "in_progress",
              selection: "ai_mode",
            });
            updateCallRecord(callSid, {
              stage: "ai_stream_started",
              streamSid,
              selection: "ai_mode",
            });
          }

          maybeStartInitialGreeting();
        }

        if (msg.event === "media" && msg.media?.payload) {
          const audioAppend = {
            type: "input_audio_buffer.append",
            audio: msg.media.payload,
          };

          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify(audioAppend));
          }
        }

        if (msg.event === "mark") {
          console.log("Twilio mark event:", JSON.stringify(msg.mark || {}));
        }

        if (msg.event === "stop") {
          console.log("Twilio stream stopped");

          if (callSid) {
            updateLiveSession(callSid, {
              status: "stream_stopped",
              activeSpeaker: "",
            });
            updateCallRecord(callSid, {
              stage: "ai_stream_stopped",
            });
          }

          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.close();
          }
        }
      } catch (err) {
        console.error("Failed to parse Twilio message:", err);
      }
    });

    twilioWs.on("close", () => {
      console.log("=== Twilio websocket disconnected ===");

      if (callSid) {
        updateLiveSession(callSid, {
          status: "stream_closed",
          activeSpeaker: "",
        });
      }

      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    twilioWs.on("error", (err) => {
      console.error("Twilio websocket error:", err);
    });
  });
}

ensureStorage();

app.get("/", (req, res) => {
  res.send("Owen HVAC phone system is running.");
});

app.get("/calls", (req, res) => {
  const calls = readCalls().sort((a, b) => {
    return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
  });
  res.json(calls);
});

app.get("/dashboard", (req, res) => {
  res.redirect("/live");
});

app.get("/live/events", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  if (typeof res.flushHeaders === "function") {
    res.flushHeaders();
  }

  const sendInitial = JSON.stringify({
    type: "snapshot",
    sessions: getLiveState(),
  });
  res.write(`data: ${sendInitial}\n\n`);

  sseClients.add(res);

  req.on("close", () => {
    sseClients.delete(res);
  });
});

app.get("/live", (req, res) => {
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Owen HVAC Live Monitor</title>
  <style>
    body {
      margin: 0;
      font-family: Arial, sans-serif;
      background: #f4f6fb;
      color: #111827;
    }
    .wrap {
      max-width: 1400px;
      margin: 0 auto;
      padding: 20px;
    }
    h1 {
      margin: 0 0 8px;
    }
    .sub {
      color: #6b7280;
      margin-bottom: 16px;
    }
    .topbar {
      display: grid;
      grid-template-columns: 1fr 380px;
      gap: 16px;
      margin-bottom: 16px;
    }
    .card {
      background: white;
      border-radius: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      padding: 16px;
    }
    .dial-box input, .dial-box select, .dial-box button {
      width: 100%;
      box-sizing: border-box;
      margin-bottom: 10px;
      padding: 10px 12px;
      border-radius: 10px;
      border: 1px solid #d1d5db;
      font-size: 14px;
    }
    .dial-box button {
      background: #111827;
      color: white;
      border: none;
      cursor: pointer;
    }
    .layout {
      display: grid;
      grid-template-columns: 360px 1fr;
      gap: 16px;
    }
    .session-list {
      max-height: 75vh;
      overflow: auto;
    }
    .session-item {
      border: 1px solid #e5e7eb;
      border-radius: 12px;
      padding: 12px;
      margin-bottom: 10px;
      cursor: pointer;
    }
    .session-item.active {
      border-color: #2563eb;
      background: #eff6ff;
    }
    .session-title {
      font-weight: bold;
      margin-bottom: 4px;
    }
    .muted {
      color: #6b7280;
      font-size: 13px;
    }
    .main-grid {
      display: grid;
      grid-template-columns: 1fr 320px;
      gap: 16px;
    }
    .transcript-box {
      max-height: 75vh;
      overflow: auto;
    }
    .bubble {
      padding: 10px 12px;
      border-radius: 12px;
      margin-bottom: 10px;
      font-size: 14px;
      line-height: 1.5;
    }
    .bubble.active {
      outline: 3px solid #2563eb;
      box-shadow: 0 0 0 4px rgba(37, 99, 235, 0.15);
    }
    .caller {
      background: #fef3c7;
    }
    .assistant {
      background: #dbeafe;
    }
    .system {
      background: #e5e7eb;
    }
    .field {
      margin-bottom: 12px;
    }
    .field-label {
      font-size: 12px;
      color: #6b7280;
      margin-bottom: 4px;
    }
    .field-value {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 10px;
      padding: 10px;
      min-height: 18px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .status {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      background: #dcfce7;
      color: #166534;
      font-size: 12px;
      font-weight: 600;
    }
    .small {
      font-size: 12px;
    }
    @media (max-width: 1100px) {
      .topbar, .layout, .main-grid {
        grid-template-columns: 1fr;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Owen HVAC Live Monitor</h1>
    <div class="sub">Real-time phone call transcript + AI intake fields + outbound call launcher.</div>

    <div class="topbar">
      <div class="card">
        <div><strong>System mode:</strong> ${APP_MODE}</div>
        <div class="small muted" style="margin-top:8px;">
          Open this page during a call to see transcript updates in real time.
        </div>
      </div>

      <div class="card dial-box">
        <h3 style="margin-top:0;">Place outbound AI call</h3>
        <input id="dialTo" type="text" placeholder="+1902XXXXXXX" />
        <select id="dialMode">
          <option value="ai">AI mode</option>
          <option value="menu">Menu mode</option>
        </select>
        <button id="dialBtn">Call now</button>
        <div id="dialResult" class="muted small"></div>
      </div>
    </div>

    <div class="layout">
      <div class="card session-list" id="sessionList"></div>

      <div class="main-grid">
        <div class="card transcript-box">
          <h3 style="margin-top:0;">Live Transcript</h3>
          <div id="transcriptBox" class="muted">No active call selected.</div>
        </div>

        <div class="card">
          <h3 style="margin-top:0;">Extracted Fields</h3>
          <div class="field">
            <div class="field-label">Call SID</div>
            <div class="field-value" id="fieldCallSid"></div>
          </div>
          <div class="field">
            <div class="field-label">From</div>
            <div class="field-value" id="fieldFrom"></div>
          </div>
          <div class="field">
            <div class="field-label">To</div>
            <div class="field-value" id="fieldTo"></div>
          </div>
          <div class="field">
            <div class="field-label">Status</div>
            <div class="field-value" id="fieldStatus"></div>
          </div>
          <div class="field">
            <div class="field-label">Intent</div>
            <div class="field-value" id="fieldIntent"></div>
          </div>
          <div class="field">
            <div class="field-label">Caller Name</div>
            <div class="field-value" id="fieldName"></div>
          </div>
          <div class="field">
            <div class="field-label">Callback Number</div>
            <div class="field-value" id="fieldCallback"></div>
          </div>
          <div class="field">
            <div class="field-label">Service Address</div>
            <div class="field-value" id="fieldAddress"></div>
          </div>
          <div class="field">
            <div class="field-label">Issue Summary</div>
            <div class="field-value" id="fieldIssue"></div>
          </div>
          <div class="field">
            <div class="field-label">Preferred Date</div>
            <div class="field-value" id="fieldPreferredDate"></div>
          </div>
          <div class="field">
            <div class="field-label">Preferred Time</div>
            <div class="field-value" id="fieldPreferredTime"></div>
          </div>
          <div class="field">
            <div class="field-label">Booking Confirmed</div>
            <div class="field-value" id="fieldBookingConfirmed"></div>
          </div>
          <div class="field">
            <div class="field-label">Appointment Created</div>
            <div class="field-value" id="fieldAppointmentCreated"></div>
          </div>
          <div class="field">
            <div class="field-label">Appointment Event ID</div>
            <div class="field-value" id="fieldAppointmentEventId"></div>
          </div>
          <div class="field">
            <div class="field-label">Call Summary</div>
            <div class="field-value" id="fieldSummary"></div>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let sessions = [];
    let selectedCallSid = null;

    function escapeHtml(value = "") {
      return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
    }

    function renderSessionList() {
      const el = document.getElementById("sessionList");

      if (!sessions.length) {
        el.innerHTML = '<div class="muted">No live or recent sessions.</div>';
        return;
      }

      el.innerHTML = sessions.map(s => {
        const activeClass = s.callSid === selectedCallSid ? "active" : "";
        return \`
          <div class="session-item \${activeClass}" onclick="selectSession('\${s.callSid}')">
            <div class="session-title">\${escapeHtml(s.from || "Unknown caller")}</div>
            <div class="muted">CallSid: \${escapeHtml(s.callSid || "-")}</div>
            <div class="muted">Status: <span class="status">\${escapeHtml(s.status || "unknown")}</span></div>
            <div class="muted">Intent: \${escapeHtml((s.fields && s.fields.intent) || "-")}</div>
            <div class="muted">Summary: \${escapeHtml((s.summary || "").slice(0, 80) || "-")}</div>
          </div>
        \`;
      }).join("");
    }

    function renderSelectedSession() {
      const session = sessions.find(s => s.callSid === selectedCallSid);

      const transcriptBox = document.getElementById("transcriptBox");

      if (!session) {
        transcriptBox.innerHTML = '<div class="muted">No active call selected.</div>';
        document.getElementById("fieldCallSid").textContent = "";
        document.getElementById("fieldFrom").textContent = "";
        document.getElementById("fieldTo").textContent = "";
        document.getElementById("fieldStatus").textContent = "";
        document.getElementById("fieldIntent").textContent = "";
        document.getElementById("fieldName").textContent = "";
        document.getElementById("fieldCallback").textContent = "";
        document.getElementById("fieldAddress").textContent = "";
        document.getElementById("fieldIssue").textContent = "";
        document.getElementById("fieldPreferredDate").textContent = "";
        document.getElementById("fieldPreferredTime").textContent = "";
        document.getElementById("fieldBookingConfirmed").textContent = "";
        document.getElementById("fieldAppointmentCreated").textContent = "";
        document.getElementById("fieldAppointmentEventId").textContent = "";
        document.getElementById("fieldSummary").textContent = "";
        return;
      }

      const transcript = Array.isArray(session.transcript) ? session.transcript : [];
      const activeSpeaker = session.activeSpeaker || "";

      transcriptBox.innerHTML = transcript.length
        ? transcript.map((t, idx) => {
            const cls = t.role === "caller" ? "caller" : t.role === "assistant" ? "assistant" : "system";
            const isLast = idx === transcript.length - 1;
            const activeClass = isLast && t.role === activeSpeaker ? "active" : "";

            return \`
              <div class="bubble \${cls} \${activeClass}">
                <strong>\${escapeHtml(t.role)}:</strong><br/>
                \${escapeHtml(t.text || "")}
              </div>
            \`;
          }).join("")
        : '<div class="muted">No transcript yet.</div>';

      document.getElementById("fieldCallSid").textContent = session.callSid || "";
      document.getElementById("fieldFrom").textContent = session.from || "";
      document.getElementById("fieldTo").textContent = session.to || "";
      document.getElementById("fieldStatus").textContent = session.status || "";
      document.getElementById("fieldIntent").textContent = (session.fields && session.fields.intent) || "";
      document.getElementById("fieldName").textContent = (session.fields && session.fields.callerName) || "";
      document.getElementById("fieldCallback").textContent = (session.fields && session.fields.callbackNumber) || "";
      document.getElementById("fieldAddress").textContent = (session.fields && session.fields.serviceAddress) || "";
      document.getElementById("fieldIssue").textContent = (session.fields && session.fields.issueSummary) || "";
      document.getElementById("fieldPreferredDate").textContent = (session.fields && session.fields.preferredDate) || "";
      document.getElementById("fieldPreferredTime").textContent = (session.fields && session.fields.preferredTime) || "";
      document.getElementById("fieldBookingConfirmed").textContent = (session.fields && String(session.fields.bookingConfirmed)) || "";
      document.getElementById("fieldAppointmentCreated").textContent = (session.fields && String(session.fields.appointmentCreated)) || "";
      document.getElementById("fieldAppointmentEventId").textContent = (session.fields && session.fields.appointmentEventId) || "";
      document.getElementById("fieldSummary").textContent = session.summary || "";
    }

    function selectSession(callSid) {
      selectedCallSid = callSid;
      renderSessionList();
      renderSelectedSession();
    }

    window.selectSession = selectSession;

    function applySnapshot(data) {
      sessions = Array.isArray(data.sessions) ? data.sessions : [];
      if (!selectedCallSid && sessions.length) {
        selectedCallSid = sessions[0].callSid;
      }
      if (selectedCallSid && !sessions.find(s => s.callSid === selectedCallSid)) {
        selectedCallSid = sessions.length ? sessions[0].callSid : null;
      }
      renderSessionList();
      renderSelectedSession();
    }

    const es = new EventSource("/live/events");
    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.type === "snapshot") {
          applySnapshot(data);
        }
      } catch (err) {
        console.error(err);
      }
    };

    document.getElementById("dialBtn").addEventListener("click", async () => {
      const to = document.getElementById("dialTo").value.trim();
      const mode = document.getElementById("dialMode").value;
      const result = document.getElementById("dialResult");

      result.textContent = "Calling...";

      try {
        const res = await fetch("/admin/call", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ to, mode })
        });

        const data = await res.json();

        if (!res.ok) {
          result.textContent = data.error || "Failed to place call.";
          return;
        }

        result.textContent = "Call started. CallSid: " + (data.callSid || "");
      } catch (err) {
        result.textContent = "Request failed.";
      }
    });
  </script>
</body>
</html>
  `.trim();

  res.type("text/html");
  res.send(html);
});

// =========================
// Calendar test routes
// =========================

app.get("/test/calendar", async (req, res) => {
  try {
    const svc = getCalendarService();
    const info = await svc.getCalendarInfo();
    res.json({
      ok: true,
      calendar: info,
    });
  } catch (err) {
    console.error("Calendar info test failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.get("/test/calendar/slots", async (req, res) => {
  try {
    const svc = getCalendarService();

    if (req.query.date) {
      const { start, end, date } = parseDateRangeFromQuery(req.query.date);
      const slotMinutes = Number(
        req.query.slotMinutes || DEFAULT_APPOINTMENT_MINUTES
      );
      const maxSlots = Number(req.query.maxSlots || 5);

      const slots = await svc.getAvailableSlots({
        start,
        end,
        slotMinutes,
        maxSlots,
      });

      return res.json({
        ok: true,
        date,
        slotMinutes,
        count: slots.length,
        slots,
      });
    }

    const now = new Date();
    const end = new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000);

    const slots = await svc.getAvailableSlots({
      start: now,
      end,
      maxSlots: 5,
      slotMinutes: DEFAULT_APPOINTMENT_MINUTES,
    });

    res.json({
      ok: true,
      count: slots.length,
      slots,
    });
  } catch (err) {
    console.error("Calendar slots test failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

// =========================
// Formal appointment APIs
// =========================

app.get("/appointments/availability", async (req, res) => {
  try {
    const svc = getCalendarService();
    const { start, end, date } = parseDateRangeFromQuery(req.query.date);

    const slotMinutes = Number(
      req.query.slotMinutes || DEFAULT_APPOINTMENT_MINUTES
    );
    const maxSlots = Number(req.query.maxSlots || 10);

    const slots = await svc.getAvailableSlots({
      start,
      end,
      slotMinutes,
      maxSlots,
    });

    res.json({
      ok: true,
      date,
      slotMinutes,
      count: slots.length,
      slots,
    });
  } catch (err) {
    console.error("Availability lookup failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.post("/appointments", async (req, res) => {
  try {
    const svc = getCalendarService();

    const {
      customerName,
      phone,
      address,
      serviceType,
      startDateTime,
      durationMinutes,
      notes,
    } = req.body || {};

    if (!customerName || !serviceType || !startDateTime) {
      return res.status(400).json({
        ok: false,
        error: "customerName, serviceType, startDateTime are required",
      });
    }

    const result = await svc.createAppointment({
      customerName,
      phone: phone || "",
      address: address || "",
      serviceType,
      startDateTime,
      durationMinutes: Number(
        durationMinutes || DEFAULT_APPOINTMENT_MINUTES
      ),
      notes: notes || "",
    });

    res.json({
      ok: true,
      event: result,
    });
  } catch (err) {
    console.error("Create appointment failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.patch("/appointments/:eventId", async (req, res) => {
  try {
    const svc = getCalendarService();
    const { eventId } = req.params;

    if (!eventId) {
      return res.status(400).json({
        ok: false,
        error: "eventId is required",
      });
    }

    const result = await svc.updateAppointment(eventId, req.body || {});

    res.json({
      ok: true,
      event: result,
    });
  } catch (err) {
    console.error("Update appointment failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.delete("/appointments/:eventId", async (req, res) => {
  try {
    const svc = getCalendarService();
    const { eventId } = req.params;

    if (!eventId) {
      return res.status(400).json({
        ok: false,
        error: "eventId is required",
      });
    }

    const result = await svc.cancelAppointment(eventId);

    res.json({
      ok: true,
      result,
    });
  } catch (err) {
    console.error("Delete appointment failed:", err);
    res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
});

app.post("/admin/call", async (req, res) => {
  try {
    if (!twilioClient) {
      return res.status(500).json({
        error:
          "Twilio client is not configured. Add TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER.",
      });
    }

    const to = String(req.body.to || "").trim();
    const mode = String(req.body.mode || "ai").trim().toLowerCase();

    if (!to) {
      return res.status(400).json({ error: "Phone number is required." });
    }

    const host = req.get("host");
    const voiceUrl =
      mode === "menu"
        ? `https://${host}/twilio/voice/outbound?mode=menu`
        : `https://${host}/twilio/voice/outbound?mode=ai`;

    const call = await twilioClient.calls.create({
      to,
      from: TWILIO_PHONE_NUMBER,
      url: voiceUrl,
      method: "POST",
      statusCallback: `https://${host}/twilio/voice/status`,
      statusCallbackMethod: "POST",
    });

    return res.json({
      ok: true,
      callSid: call.sid,
    });
  } catch (err) {
    console.error("Outbound call failed:", err);
    return res.status(500).json({
      error: err.message || "Outbound call failed.",
    });
  }
});

app.post("/twilio/voice/incoming", (req, res) => {
  console.log("=== Incoming Call ===");
  console.log("From:", req.body.From);
  console.log("To:", req.body.To);
  console.log("CallSid:", req.body.CallSid);

  const from = req.body.From || "";
  const to = req.body.To || "";
  const callSid = req.body.CallSid || "";
  const host = req.get("host");
  const appMode = (process.env.APP_MODE || "menu").toLowerCase();

  saveCallRecord({
    callSid,
    from,
    to,
    stage: "incoming",
    selection: appMode === "ai" ? "ai_mode" : "",
    digits: "",
    callStatus: "started",
    direction: "incoming",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  ensureLiveSession(callSid, {
    from,
    to,
    direction: "incoming",
    status: "started",
    startedAt: new Date().toISOString(),
    selection: appMode === "ai" ? "ai_mode" : "",
  });

  updateLiveSession(callSid, {
    from,
    to,
    direction: "incoming",
    status: "started",
    selection: appMode === "ai" ? "ai_mode" : "",
  });

  if (appMode === "ai") {
    const twiml = buildAiStreamTwiml(host);
    res.type("text/xml");
    res.send(twiml);
    return;
  }

  const twiml = buildMenuTwiml(host);
  res.type("text/xml");
  res.send(twiml);
});

app.post("/twilio/voice/outbound", (req, res) => {
  console.log("=== Outbound Call TwiML Request ===");
  console.log("From:", req.body.From);
  console.log("To:", req.body.To);
  console.log("CallSid:", req.body.CallSid);

  const from = req.body.From || "";
  const to = req.body.To || "";
  const callSid = req.body.CallSid || "";
  const host = req.get("host");
  const mode = String(req.query.mode || "ai").toLowerCase();

  saveCallRecord({
    callSid,
    from,
    to,
    stage: "outbound_started",
    selection: mode === "ai" ? "ai_mode" : "",
    digits: "",
    callStatus: "started",
    direction: "outbound",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  ensureLiveSession(callSid, {
    from,
    to,
    direction: "outbound",
    status: "started",
    startedAt: new Date().toISOString(),
    selection: mode === "ai" ? "ai_mode" : "",
  });

  updateLiveSession(callSid, {
    from,
    to,
    direction: "outbound",
    status: "started",
    selection: mode === "ai" ? "ai_mode" : "",
  });

  if (mode === "ai") {
    const twiml = buildAiStreamTwiml(host);
    res.type("text/xml");
    res.send(twiml);
    return;
  }

  const twiml = buildMenuTwiml(host);
  res.type("text/xml");
  res.send(twiml);
});

app.post("/twilio/voice/menu", (req, res) => {
  const digits = req.body.Digits || "";
  const from = req.body.From || "";
  const callSid = req.body.CallSid || "";

  console.log("=== Menu Selection ===");
  console.log("From:", from);
  console.log("CallSid:", callSid);
  console.log("Digits:", digits);

  let selectionLabel = "invalid";
  let twiml = "";

  if (digits === "1") {
    selectionLabel = "new_installation";
    twiml = `
<Response>
  <Say language="en-US" voice="alice">
    Thank you. You selected new heat pump installation.
  </Say>
  <Pause length="1"/>
  <Say language="en-US" voice="alice">
    Our comfort advisor will contact you shortly to discuss your property address, current heating system, and installation options.
  </Say>
  <Hangup/>
</Response>`.trim();
  } else if (digits === "2") {
    selectionLabel = "service_or_repair";
    twiml = `
<Response>
  <Say language="en-US" voice="alice">
    Thank you. You selected service or repair.
  </Say>
  <Pause length="1"/>
  <Say language="en-US" voice="alice">
    Our service team will contact you shortly.
    Please have your equipment brand, model number, and service address ready.
  </Say>
  <Hangup/>
</Response>`.trim();
  } else if (digits === "3") {
    selectionLabel = "rebate_questions";
    twiml = `
<Response>
  <Say language="en-US" voice="alice">
    Thank you. You selected rebate or grant questions.
  </Say>
  <Pause length="1"/>
  <Say language="en-US" voice="alice">
    A member of our team will follow up with you regarding available programs and application requirements.
  </Say>
  <Hangup/>
</Response>`.trim();
  } else if (digits === "0") {
    selectionLabel = "transfer_to_agent";
    twiml = `
<Response>
  <Say language="en-US" voice="alice">
    Please hold while we transfer your call to our team.
  </Say>
  <Dial>${LIVE_AGENT_NUMBER}</Dial>
</Response>`.trim();
  } else {
    selectionLabel = "invalid";
    twiml = `
<Response>
  <Say language="en-US" voice="alice">
    Sorry, that was not a valid selection.
  </Say>
  <Pause length="1"/>
  <Say language="en-US" voice="alice">
    Please call again and press 1 for installation,
    2 for service,
    3 for rebate questions,
    or 0 to speak with our team.
  </Say>
  <Hangup/>
</Response>`.trim();
  }

  updateCallRecord(callSid, {
    stage: "menu_completed",
    selection: selectionLabel,
    digits,
  });

  ensureLiveSession(callSid);
  updateLiveSession(callSid, {
    status: "menu_completed",
    activeSpeaker: "",
    selection: selectionLabel,
  });

  const session = liveSessions.get(callSid);
  if (session) {
    session.fields.intent = selectionLabel;
    session.updatedAt = new Date().toISOString();
  }
  broadcastLiveState();

  res.type("text/xml");
  res.send(twiml);
});

app.post("/twilio/voice/status", (req, res) => {
  console.log("=== Call Status Callback ===");
  console.log("CallSid:", req.body.CallSid);
  console.log("CallStatus:", req.body.CallStatus);
  console.log("From:", req.body.From);
  console.log("To:", req.body.To);
  console.log("Timestamp:", new Date().toISOString());

  const callSid = req.body.CallSid || "";
  const callStatus = req.body.CallStatus || "unknown";
  const from = req.body.From || "";
  const to = req.body.To || "";

  updateCallRecord(callSid, {
    callStatus,
    from,
    to,
  });

  ensureLiveSession(callSid, { from, to });
  updateLiveSession(callSid, {
    from,
    to,
    status: callStatus,
  });

  if (
    ["completed", "failed", "busy", "no-answer", "canceled"].includes(
      callStatus
    )
  ) {
    finalizeSession(callSid);
  }

  res.sendStatus(200);
});

const port = process.env.PORT || 10000;
const server = http.createServer(app);

attachRealtimeBridge(server);

server.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
