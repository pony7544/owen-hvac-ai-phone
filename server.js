const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const DATA_DIR = path.join(__dirname, "data");
const CALLS_FILE = path.join(DATA_DIR, "calls.json");

// 修改成你要转接的号码（加拿大号码写 +1 开头）
const LIVE_AGENT_NUMBER = "+19029892358";

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

function saveCallRecord(record) {
  const calls = readCalls();
  calls.push(record);
  fs.writeFileSync(CALLS_FILE, JSON.stringify(calls, null, 2), "utf8");
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

  fs.writeFileSync(CALLS_FILE, JSON.stringify(calls, null, 2), "utf8");
}

ensureStorage();

app.get("/", (req, res) => {
  res.send("Owen HVAC semi-automatic phone front desk is running.");
});

app.get("/calls", (req, res) => {
  const calls = readCalls();
  res.json(calls);
});

/**
 * 来电入口
 */
app.post("/twilio/voice/incoming", (req, res) => {
  console.log("=== Incoming Call ===");
  console.log("From:", req.body.From);
  console.log("To:", req.body.To);
  console.log("CallSid:", req.body.CallSid);

  const from = req.body.From || "";
  const to = req.body.To || "";
  const callSid = req.body.CallSid || "";
  const host = req.get("host");
  const gatherActionUrl = `https://${host}/twilio/voice/menu`;

  saveCallRecord({
    callSid,
    from,
    to,
    stage: "incoming",
    selection: "",
    callStatus: "started",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  const twiml = `
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

  res.type("text/xml");
  res.send(twiml);
});

/**
 * 菜单处理
 */
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

/**
 * 通话状态回调
 */
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

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
