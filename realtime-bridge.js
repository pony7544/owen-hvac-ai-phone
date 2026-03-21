const WebSocket = require("ws");
const { HVAC_SYSTEM_PROMPT } = require("./prompts");

function attachRealtimeBridge(server) {
  const wss = new WebSocket.Server({ server, path: "/twilio/stream" });

  wss.on("connection", (twilioWs) => {
    console.log("=== Twilio stream connected ===");

    let streamSid = null;

    const openaiWs = new WebSocket(
      "wss://api.openai.com/v1/realtime?model=gpt-realtime",
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "OpenAI-Beta": "realtime=v1",
        },
      }
    );

    openaiWs.on("open", () => {
      console.log("=== OpenAI realtime connected ===");

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
          },
        },
      };

      openaiWs.send(JSON.stringify(sessionUpdate));
    });

    openaiWs.on("message", (data) => {
      try {
        const msg = JSON.parse(data.toString());

        // 调试先看主要事件
        if (
          msg.type === "session.created" ||
          msg.type === "session.updated" ||
          msg.type === "response.done" ||
          msg.type === "error"
        ) {
          console.log("OpenAI event:", msg.type, JSON.stringify(msg));
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
          streamSid = msg.start.streamSid;
          console.log("Twilio stream started:", streamSid);

          // AI 主动先说一句欢迎语
          const initialResponse = {
            type: "response.create",
            response: {
              modalities: ["audio", "text"],
              instructions:
                "Greet the caller and say: Thank you for calling Owen HVAC Corp. How can I help you today?",
            },
          };

          if (openaiWs.readyState === WebSocket.OPEN) {
            openaiWs.send(JSON.stringify(initialResponse));
          }
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
      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.close();
      }
    });

    twilioWs.on("error", (err) => {
      console.error("Twilio websocket error:", err);
    });
  });
}

module.exports = {
  attachRealtimeBridge,
};
