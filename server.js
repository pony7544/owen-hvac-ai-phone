const express = require("express");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Owen HVAC semi-automatic phone front desk is running.");
});

/**
 * 入口：Twilio 来电先打到这里
 */
app.post("/twilio/voice/incoming", (req, res) => {
  console.log("=== Incoming Call ===");
  console.log("From:", req.body.From);
  console.log("To:", req.body.To);
  console.log("CallSid:", req.body.CallSid);

  const host = req.get("host");
  const gatherActionUrl = `https://${host}/twilio/voice/menu`;

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
  </Say>
  <Gather numDigits="1" action="${gatherActionUrl}" method="POST" timeout="8">
    <Say language="en-US" voice="alice">
      Please make your selection now.
    </Say>
  </Gather>
  <Say language="en-US" voice="alice">
    We did not receive your selection. Please call again, or our team will follow up shortly.
  </Say>
  <Hangup/>
</Response>`.trim();

  res.type("text/xml");
  res.send(twiml);
});

/**
 * 按键菜单处理
 */
app.post("/twilio/voice/menu", (req, res) => {
  const digits = req.body.Digits || "";
  const from = req.body.From || "";
  const callSid = req.body.CallSid || "";

  console.log("=== Menu Selection ===");
  console.log("From:", from);
  console.log("CallSid:", callSid);
  console.log("Digits:", digits);

  let twiml = "";

  if (digits === "1") {
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
    twiml = `
<Response>
  <Say language="en-US" voice="alice">
    Thank you. You selected service or repair.
  </Say>
  <Pause length="1"/>
  <Say language="en-US" voice="alice">
    Our service team will contact you shortly. Please have your equipment brand, model number, and service address ready.
  </Say>
  <Hangup/>
</Response>`.trim();
  } else if (digits === "3") {
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
  } else {
    twiml = `
<Response>
  <Say language="en-US" voice="alice">
    Sorry, that was not a valid selection.
  </Say>
  <Pause length="1"/>
  <Say language="en-US" voice="alice">
    Please call again and press 1 for installation, 2 for service, or 3 for rebate questions.
  </Say>
  <Hangup/>
</Response>`.trim();
  }

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

  res.sendStatus(200);
});

const port = process.env.PORT || 10000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
