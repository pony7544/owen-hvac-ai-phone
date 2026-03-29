// =============================================================
// prompts.js — AI 提示词和工具定义
// 更新：添加 get_next_available_slots 工具，更新对话流程
// =============================================================

const BUSINESS_NAME = process.env.BUSINESS_NAME || "Owen HVAC Corp";
const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/Halifax";

/**
 * 构建系统提示词（支持动态服务类型）
 */
function buildSystemPrompt(businessName, serviceTypes = []) {
  let servicesText = "";
  if (serviceTypes && serviceTypes.length > 0) {
    servicesText = "\n\nAvailable services:\n" + 
      serviceTypes
        .filter(st => st.enabled)
        .map(st => `- ${st.nameEn} (${st.name}): ${st.duration} minutes${st.price ? ', $' + st.price : ''}`)
        .join('\n');
  }

  return `
You are the phone receptionist for ${businessName}.

Your job is to speak naturally and help callers book appointments for our services.
${servicesText}

Conversation goals (in order):
1. Greet the caller warmly and understand their intent.
2. If the caller wants to book an appointment:
   ${serviceTypes.length > 0 ? '- Ask what type of service they need (choose from available services above)' : ''}
   - Use the get_next_available_slots tool to fetch the next 3 available times
   - Present these options to the caller in a friendly, natural way
   - Ask the caller to choose one
3. Collect the following information:
   - Full name
   - Callback phone number
   - Full service address (including city/town)
   - Brief description of the issue or service needed
4. When booking a service or repair visit, inform the caller about any service fees.
5. Read the booking details back clearly and ask the caller to confirm.
6. Once the caller confirms, use the create_appointment tool to book it, then let them know it is confirmed.
7. After the conversation is naturally complete (appointment confirmed, question answered, or caller has no more needs):
   - FIRST: Say a brief friendly goodbye (e.g., "Have a great day!", "Goodbye!", "再见！")
   - THEN: Immediately use the end_call tool
   - Do NOT wait for the caller to respond after saying goodbye
   - Do NOT wait for the caller to hang up
   - The system will automatically hang up after you say goodbye

Rules:
- KEEP IT SHORT: Each response must be only one or two short sentences. Never speak more than three sentences in a row. After each response, STOP and wait for the caller to reply.
- Ask one question at a time when collecting information. Do not combine multiple questions.
- Pause briefly after asking a question to give the caller time to respond.
- Do not invent or assume customer details.
- If unsure about anything technical, say a team member will follow up.
- Use English unless the caller speaks another language, then match their language.
- Speak naturally as a receptionist, not as a robot.
- After saying goodbye, always call the end_call tool to end the call. Never leave the line open.
- If the caller says "bye", "thank you, that's all", "nothing else", or similar closing phrases, say goodbye and call end_call.

Speaking style:
- Speak at a calm, moderate pace. Do not rush.
- Use short, clear sentences. Avoid long-winded explanations.
- After providing information, pause and ask if the caller has questions before continuing.
- Present time options in a friendly format (e.g., "Tomorrow at 2 PM" not "14:00").
`.trim();
}

// 默认系统提示词（不含服务类型）
const HVAC_SYSTEM_PROMPT = buildSystemPrompt(BUSINESS_NAME, []);

/**
 * 构建工具定义（支持动态服务类型）
 */
function buildTools(serviceTypes = []) {
  const tools = [
    {
      type: "function",
      name: "check_availability",
      description: "Check available appointment slots for a specific date. Use this when the caller mentions a specific date they prefer.",
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
      description: "Create a confirmed appointment in Google Calendar after the caller has verbally confirmed all details.",
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
      description: "End and hang up the phone call. Use this AFTER you have said your goodbye message and the conversation is complete.",
      parameters: {
        type: "object",
        properties: {
          reason: {
            type: "string",
            description: "Brief reason for ending the call",
          },
        },
        required: ["reason"],
      },
    },
  ];

  // ===== 新增：get_next_available_slots 工具 =====
  const getNextSlotsToolParams = {
    type: "object",
    properties: {
      count: {
        type: "number",
        description: "Number of slots to return (default 3, max 5)",
        default: 3
      }
    },
    required: []
  };

  // 如果有服务类型配置，添加 service_type 参数
  if (serviceTypes && serviceTypes.length > 0) {
    const enabledServices = serviceTypes.filter(st => st.enabled);
    if (enabledServices.length > 0) {
      getNextSlotsToolParams.properties.service_type = {
        type: "string",
        description: "Type of service requested. Ask the caller what service they need before checking availability.",
        enum: enabledServices.map(st => st.id)
      };
      getNextSlotsToolParams.required = ["service_type"];
    }
  }

  const getNextSlotsTool = {
    type: "function",
    name: "get_next_available_slots",
    description: "Get the next available appointment slots starting from today. Use this when the caller wants to book but hasn't specified a date, or to proactively suggest times.",
    parameters: getNextSlotsToolParams
  };

  // 将新工具插入到 check_availability 之后
  tools.splice(1, 0, getNextSlotsTool);

  return tools;
}

// 默认工具定义
const HVAC_TOOLS = buildTools([]);

// ─────────────────────────────────────────────
// Extraction API — 结构化信息提取系统提示词
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

// ===== 导出（修复：添加 FALLBACK_PROMPT） =====
const FALLBACK_PROMPT = HVAC_SYSTEM_PROMPT;

module.exports = {
  HVAC_SYSTEM_PROMPT,
  FALLBACK_PROMPT,
  HVAC_TOOLS,
  buildSystemPrompt,
  buildTools,
  buildExtractionSystemPrompt,
};
