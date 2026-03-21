const express = require("express");

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Owen HVAC AI phone backend is running.");
});

app.post("/twilio/voice/incoming", (req, res) => {
  const twiml = `
<Response>
  <Say voice="alice">
    Thank you for calling Owen HVAC Corp. Please hold while we connect your call.
  </Say>
  <Pause length="5"/>
</Response>`.trim();

  res.type("text/xml");
  res.send(twiml);
});

const port = process.env.PORT || 10000;

app.listen(port, "0.0.0.0", () => {
  console.log(`Server listening on port ${port}`);
});
