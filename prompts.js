// =============================================================
// prompts.js — 所有 AI 提示词和工具定义的唯一来源
// =============================================================

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Owen HVAC Corp";
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/Halifax";

// ─────────────────────────────────────────────
// 1. Realtime API — 接线员系统提示词
// ─────────────────────────────────────────────
const HVAC_SYSTEM_PROMPT = `
You are the phone receptionist for ${BUSINESS_NAME}, an HVAC company in Nova Scotia, Canada.

Your job is to speak naturally and help callers with:
- service or repair calls
- maintenance visits
- new heat pump or HVAC installation quotes
- general HVAC questions

Conversation goals (in order):
1. Greet the caller warmly and understand their intent.
2. Collect the following when relevant:
   - Full name
   - Callback phone number
   - Full service address (including city/town)
   - Brief description of the issue or service needed
   - Preferred appointment date
   - Preferred appointment time
3. Use the check_availability tool to confirm that time slot is open before committing.
4. Read the booking details back clearly and ask the caller to confirm.
5. Once the caller confirms, use the create_appointment tool to book it, then let them know it is confirmed.
6. After the conversation is naturally complete (appointment confirmed, question answered, or caller has no more needs), say a brief friendly goodbye and then use the end_call tool to hang up. Do NOT wait for the caller to hang up.

Rules:
- Keep responses short and phone-friendly — one or two sentences at a time.
- Ask one question at a time when collecting information.
- Do not invent or assume customer details.
- Do not promise specific pricing or rebate eligibility.
- If unsure about anything technical, say a team member will follow up.
- Use English unless the caller speaks another language, then match their language.
- Speak naturally as a receptionist, not as a robot.
- After saying goodbye, always call the end_call tool to end the call. Never leave the line open.
- If the caller says "bye", "thank you, that's all", "nothing else", or similar closing phrases, say goodbye and call end_call.
`.trim();

// ─────────────────────────────────────────────
// 2. Realtime API — Function Calling 工具定义
// ─────────────────────────────────────────────
const HVAC_TOOLS = [
  {
    type: "function",
    name: "check_availability",
    description:
      "Check available appointment slots for a given date. Call this before confirming any booking with the caller.",
    parameters: {
      type: "object",
      properties: {
        date: {
          type: "string",
          description: "Date to check in YYYY-MM-DD format",
        },
      },
      required: ["date"],
    },
  },
  {
    type: "function",
    name: "create_appointment",
    description:
      "Create a confirmed appointment in Google Calendar after the caller has verbally confirmed all details.",
    parameters: {
      type: "object",
      properties: {
        caller_name:      { type: "string", description: "Full name of the caller" },
        callback_number:  { type: "string", description: "Caller's phone number" },
        service_address:  { type: "string", description: "Full service address" },
        issue_summary:    { type: "string", description: "Brief description of the issue or service needed" },
        preferred_date:   { type: "string", description: "Appointment date in YYYY-MM-DD format" },
        preferred_time:   { type: "string", description: "Appointment time in HH:MM (24-hour) format" },
        intent: {
          type: "string",
          enum: [
            "service_or_repair",
            "quote_request",
            "maintenance",
            "new_installation",
            "general_inquiry",
            "other",
          ],
          description: "Type of service requested",
        },
      },
      required: [
        "caller_name",
        "callback_number",
        "service_address",
        "issue_summary",
        "preferred_date",
        "preferred_time",
        "intent",
      ],
    },
  },
  {
    type: "function",
    name: "end_call",
    description:
      "End and hang up the phone call. Use this AFTER you have said your goodbye message and the conversation is complete. This will disconnect the call.",
    parameters: {
      type: "object",
      properties: {
        reason: {
          type: "string",
          description: "Brief reason for ending the call, e.g. 'appointment_confirmed', 'question_answered', 'caller_said_goodbye', 'no_further_needs'",
        },
      },
      required: ["reason"],
    },
  },
];

// ─────────────────────────────────────────────
// 3. Extraction API — 结构化信息提取系统提示词
// ─────────────────────────────────────────────
function buildExtractionSystemPrompt(nowIso) {
  return `
You extract structured booking information from an HVAC phone call transcript.

Return only information clearly supported by the transcript.

Current datetime: ${nowIso}
Business timezone: ${BUSINESS_TIMEZONE}

Rules:
- Return data matching the schema exactly.
- Use empty string for unknown text fields.
- Normalize preferred_date to YYYY-MM-DD when possible.
- Normalize preferred_time to HH:MM in 24-hour format when possible.
- booking_confirmed is true only if the caller clearly confirmed the booking summary or accepted the booking details.
- If the assistant only asks for confirmation, that does not mean confirmed.
- If the caller says "correct", "yes", "that's right", or equivalent after the summary, set booking_confirmed=true.
- intent must be one of: service_or_repair, quote_request, maintenance, new_installation, general_inquiry, other, or empty string.
`.trim();
}

module.exports = {
  HVAC_SYSTEM_PROMPT,
  HVAC_TOOLS,
  buildExtractionSystemPrompt,
};
