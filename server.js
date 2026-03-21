const express = require("express");
const fs = require("fs");
const path = require("path");
const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const DATA_DIR = path.join(__dirname, "data");
const CALLS_FILE = path.join(DATA_DIR, "calls.json");

const LIVE_AGENT_NUMBER = process.env.LIVE_AGENT_NUMBER || "";

const HVAC_SYSTEM_PROMPT = `
You are the phone assistant for Owen HVAC Corp in Nova Scotia, Canada.

Your job is to greet callers, ask what they need, and keep responses brief and clear in natural spoken English.

You can help with:
- new heat pump installation
- service or repair
- rebate or grant questions

Rules:
- keep answers short
- ask one question at a time
- do not promise pricing
- do not give firm rebate eligibility decisions
- if unsure, say a team member will follow up
- collect callback number and service address when relevant
`;

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

ensureStorage();

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
    let transcriptBuffer = [];

    if (!process.env.OPENAI_API_KEY) {
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
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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
          modalities: ["audio", "text"],
          instructions:
            "Greet the caller and say: Thank you for calling Owen HVAC Corp. How can I help you today?",
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
            create_response: true
          }
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
      maybeStartInitialGreeting();
    });

    openaiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

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

        // AI 文字 transcript（调试和保存）
        if (msg.type === "response.audio_transcript.delta" && msg.delta) {
          transcriptBuffer.push({
            role: "assistant",
            text: msg.delta,
            at: new Date().toISOString(),
          });
        }

        if (msg.type === "conversation.item.input_audio_transcription.completed" && msg.transcript) {
          transcriptBuffer.push({
            role: "caller",
            text: msg.transcript,
            at: new Date().toISOString(),
          });
        }

        // 把 AI 音频回送给 Twilio
        if (msg.type === "response.audio.delta" && msg.delta && streamSid) {
          const mediaMsg = {
            event: "media",
            streamSid,
            media: {
              payload: msg.delta,
            },
          };
          twilioWs.send(JSON.stringify(mediaMsg));
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
          callSid = msg.start?.callSid || msg.start?.customParameters?.CallSid || null;
          twilioStarted = true;

          console.log("Twilio stream started:", streamSid);
          console.log("Twilio callSid:", callSid);

          if (callSid) {
            updateCallRecord(callSid, {
              stage: "ai_stream_started",
              streamSid,
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

        if (msg.event === "stop") {
          console.log("Twilio stream stopped");

          if (callSid && transcriptBuffer.length) {
            updateCallRecord(callSid, {
              transcript: transcriptBuffer,
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

      if (callSid && transcriptBuffer.length) {
        updateCallRecord(callSid, {
          transcript: transcriptBuffer,
          stage: "ai_stream_closed",
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
  const html = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Owen HVAC Call Dashboard</title>
  <style>
    body {
      font-family: Arial, sans-serif;
      margin: 0;
      background: #f5f7fb;
      color: #1f2937;
    }
    .wrap {
      max-width: 1200px;
      margin: 0 auto;
      padding: 24px;
    }
    h1 {
      margin: 0 0 8px;
      font-size: 28px;
    }
    .sub {
      color: #6b7280;
      margin-bottom: 20px;
    }
    .toolbar {
      display: flex;
      gap: 12px;
      flex-wrap: wrap;
      margin-bottom: 16px;
    }
    input, select, button {
      padding: 10px 12px;
      border: 1px solid #d1d5db;
      border-radius: 8px;
      font-size: 14px;
    }
    button {
      cursor: pointer;
      background: #111827;
      color: white;
      border: none;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      gap: 12px;
      margin-bottom: 20px;
    }
    .card {
      background: white;
      border-radius: 14px;
      padding: 16px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    .card .label {
      color: #6b7280;
      font-size: 13px;
      margin-bottom: 8px;
    }
    .card .value {
      font-size: 24px;
      font-weight: bold;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      background: white;
      border-radius: 14px;
      overflow: hidden;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
    }
    th, td {
      padding: 12px 14px;
      border-bottom: 1px solid #e5e7eb;
      text-align: left;
      font-size: 14px;
      vertical-align: top;
    }
    th {
      background: #111827;
      color: white;
      font-weight: 600;
    }
    tr:hover {
      background: #f9fafb;
    }
    .badge {
      display: inline-block;
      padding: 4px 8px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 600;
    }
    .status-completed { background: #dcfce7; color: #166534; }
    .status-started { background: #dbeafe; color: #1d4ed8; }
    .status-failed { background: #fee2e2; color: #991b1b; }
    .status-unknown { background: #e5e7eb; color: #374151; }
    .sel-install { background: #ede9fe; color: #5b21b6; }
    .sel-service { background: #fef3c7; color: #92400e; }
    .sel-rebate { background: #cffafe; color: #155e75; }
    .sel-transfer { background: #fee2e2; color: #9f1239; }
    .sel-invalid { background: #e5e7eb; color: #374151; }
    .sel-ai { background: #dbeafe; color: #1d4ed8; }
    .muted {
      color: #6b7280;
    }
    .empty {
      background: white;
      padding: 24px;
      border-radius: 14px;
      box-shadow: 0 1px 3px rgba(0,0,0,0.08);
      color: #6b7280;
    }
    pre {
      white-space: pre-wrap;
      word-break: break-word;
      margin: 0;
      font-size: 12px;
      color: #374151;
    }
    @media (max-width: 900px) {
      .stats {
        grid-template-columns: repeat(2, minmax(0, 1fr));
      }
      table, thead, tbody, th, td, tr {
        display: block;
      }
      thead {
        display: none;
      }
      tr {
        margin-bottom: 12px;
        background: white;
        border-radius: 14px;
        box-shadow: 0 1px 3px rgba(0,0,0,0.08);
        overflow: hidden;
      }
      td {
        border-bottom: 1px solid #e5e7eb;
      }
      td::before {
        content: attr(data-label);
        display: block;
        font-size: 12px;
        color: #6b7280;
        margin-bottom: 4px;
      }
    }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>Owen HVAC Call Dashboard</h1>
    <div class="sub">Live call records from your phone front desk.</div>

    <div class="toolbar">
      <input id="searchInput" type="text" placeholder="Search phone / CallSid / selection" />
      <select id="statusFilter">
        <option value="">All statuses</option>
        <option value="started">started</option>
        <option value="completed">completed</option>
        <option value="failed">failed</option>
      </select>
      <select id="selectionFilter">
        <option value="">All selections</option>
        <option value="new_installation">new_installation</option>
        <option value="service_or_repair">service_or_repair</option>
        <option value="rebate_questions">rebate_questions</option>
        <option value="transfer_to_agent">transfer_to_agent</option>
        <option value="invalid">invalid</option>
        <option value="ai_mode">ai_mode</option>
      </select>
      <button id="refreshBtn">Refresh</button>
    </div>

    <div class="stats">
      <div class="card">
        <div class="label">Total Calls</div>
        <div class="value" id="statTotal">0</div>
      </div>
      <div class="card">
        <div class="label">Completed</div>
        <div class="value" id="statCompleted">0</div>
      </div>
      <div class="card">
        <div class="label">Service / Repair</div>
        <div class="value" id="statService">0</div>
      </div>
      <div class="card">
        <div class="label">AI Mode Calls</div>
        <div class="value" id="statAi">0</div>
      </div>
    </div>

    <div id="tableWrap"></div>
  </div>

  <script>
    let allCalls = [];

    function statusBadge(status) {
      const safe = (status || "unknown").toLowerCase();
      const cls = ["completed", "started", "failed"].includes(safe) ? safe : "unknown";
      return '<span class="badge status-' + cls + '">' + safe + '</span>';
    }

    function selectionBadge(selection) {
      const map = {
        new_installation: ["New Installation", "sel-install"],
        service_or_repair: ["Service / Repair", "sel-service"],
        rebate_questions: ["Rebate Questions", "sel-rebate"],
        transfer_to_agent: ["Transfer to Agent", "sel-transfer"],
        invalid: ["Invalid", "sel-invalid"],
        ai_mode: ["AI Mode", "sel-ai"],
        "": ["-", "sel-invalid"]
      };
      const val = map[selection || ""] || [selection, "sel-invalid"];
      return '<span class="badge ' + val[1] + '">' + val[0] + '</span>';
    }

    function fmtDate(value) {
      if (!value) return "-";
      const d = new Date(value);
      if (Number.isNaN(d.getTime())) return value;
      return d.toLocaleString();
    }

    function renderStats(calls) {
      document.getElementById("statTotal").textContent = calls.length;
      document.getElementById("statCompleted").textContent =
        calls.filter(c => (c.callStatus || "").toLowerCase() === "completed").length;
      document.getElementById("statService").textContent =
        calls.filter(c => c.selection === "service_or_repair").length;
      document.getElementById("statAi").textContent =
        calls.filter(c => c.selection === "ai_mode").length;
    }

    function renderTable(calls) {
      const wrap = document.getElementById("tableWrap");

      if (!calls.length) {
        wrap.innerHTML = '<div class="empty">No call records found.</div>';
        return;
      }

      const rows = calls.map(call => {
        const transcriptText = Array.isArray(call.transcript)
          ? call.transcript.map(t => '[' + (t.role || 'unknown') + '] ' + (t.text || '')).join("\\n")
          : "";

        return \`
          <tr>
            <td data-label="Time">\${fmtDate(call.createdAt)}</td>
            <td data-label="From">\${call.from || "-"}</td>
            <td data-label="To">\${call.to || "-"}</td>
            <td data-label="Selection">\${selectionBadge(call.selection || "")}</td>
            <td data-label="Status">\${statusBadge(call.callStatus || "unknown")}</td>
            <td data-label="Digits">\${call.digits || "-"}</td>
            <td data-label="Transcript"><pre>\${transcriptText || "-"}</pre></td>
            <td data-label="CallSid"><span class="muted">\${call.callSid || "-"}</span></td>
          </tr>
        \`;
      }).join("");

      wrap.innerHTML = \`
        <table>
          <thead>
            <tr>
              <th>Time</th>
              <th>From</th>
              <th>To</th>
              <th>Selection</th>
              <th>Status</th>
              <th>Digits</th>
              <th>Transcript</th>
              <th>CallSid</th>
            </tr>
          </thead>
          <tbody>\${rows}</tbody>
        </table>
      \`;
    }

    function applyFilters() {
      const q = document.getElementById("searchInput").value.trim().toLowerCase();
      const status = document.getElementById("statusFilter").value;
      const selection = document.getElementById("selectionFilter").value;

      const filtered = allCalls.filter(call => {
        const transcriptText = Array.isArray(call.transcript)
          ? call.transcript.map(t => t.text || "").join(" ")
          : "";

        const haystack = [
          call.from || "",
          call.to || "",
          call.callSid || "",
          call.selection || "",
          call.callStatus || "",
          call.digits || "",
          transcriptText
        ].join(" ").toLowerCase();

        const qMatch = !q || haystack.includes(q);
        const statusMatch = !status || (call.callStatus || "").toLowerCase() === status;
        const selectionMatch = !selection || (call.selection || "") === selection;

        return qMatch && statusMatch && selectionMatch;
      });

      renderStats(filtered);
      renderTable(filtered);
    }

    async function loadCalls() {
      const res = await fetch("/calls", { cache: "no-store" });
      const data = await res.json();
      allCalls = Array.isArray(data)
        ? data.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
        : [];
      applyFilters();
    }

    document.getElementById("refreshBtn").addEventListener("click", loadCalls);
    document.getElementById("searchInput").addEventListener("input", applyFilters);
    document.getElementById("statusFilter").addEventListener("change", applyFilters);
    document.getElementById("selectionFilter").addEventListener("change", applyFilters);

    loadCalls();
    setInterval(loadCalls, 10000);
  </script>
</body>
</html>
  `.trim();

  res.type("text/html");
  res.send(html);
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
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
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

  updateCallRecord(callSid, {
    callStatus: req.body.CallStatus || "unknown",
    from: req.body.From || "",
    to: req.body.To || "",
  });

  res.sendStatus(200);
});

const port = process.env.PORT || 10000;
const server = http.createServer(app);

attachRealtimeBridge(server);

server.listen(port, "0.0.0.0", () => {
  console.log(\`Server listening on port \${port}\`);
});
