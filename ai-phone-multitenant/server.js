// =============================================================
// server.js 更新补丁
// 添加：1. 通话时长记录  2. 统计 API  3. get_next_available_slots 工具处理
// =============================================================

// ========================================
// 第 1 部分：在文件顶部添加导入
// ========================================
// 在现有的 require 语句后添加：
const { CallStats } = require("./models");
const { buildSystemPrompt, buildTools } = require("./prompts");

// ========================================
// 第 2 部分：添加新的路由（在 app.get("/calendar"...) 之后）
// ========================================

// Analytics 页面
app.get("/analytics", requireAuth, (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "analytics.html"));
});

// ========================================
// 第 3 部分：添加统计 API（在现有 API 路由之后）
// ========================================

// 月度统计查询
app.get("/api/analytics/monthly", requireApiAuth, async (req, res) => {
  try {
    const tenantId = req.session.tenantId;
    const { year, month } = req.query;
    
    if (!year || !month) {
      return res.status(400).json({ ok: false, error: "Year and month required" });
    }
    
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    
    const { Call } = require("./models");
    const calls = await Call.find({
      tenantId,
      createdAt: { $gte: startDate, $lte: endDate }
    }).sort({ createdAt: -1 }).limit(100);
    
    // 计算统计数据
    const stats = {
      totalCalls: calls.length,
      totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0),
      avgDuration: 0,
      appointmentsBooked: calls.filter(c => c.extracted?.appointmentCreated).length,
      callsBySource: {},
      dailyStats: {}
    };
    
    if (stats.totalCalls > 0) {
      stats.avgDuration = Math.round(stats.totalDuration / stats.totalCalls);
    }
    
    // 按来源分组
    calls.forEach(call => {
      const from = call.from || 'Unknown';
      if (!stats.callsBySource[from]) {
        stats.callsBySource[from] = { from, count: 0, totalDuration: 0 };
      }
      stats.callsBySource[from].count++;
      stats.callsBySource[from].totalDuration += (call.duration || 0);
    });
    
    stats.callsBySource = Object.values(stats.callsBySource)
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);
    
    // 按日期分组
    calls.forEach(call => {
      const date = new Date(call.createdAt).toISOString().split('T')[0];
      if (!stats.dailyStats[date]) {
        stats.dailyStats[date] = { date, count: 0, duration: 0 };
      }
      stats.dailyStats[date].count++;
      stats.dailyStats[date].duration += (call.duration || 0);
    });
    
    stats.dailyStats = Object.values(stats.dailyStats)
      .sort((a, b) => new Date(a.date) - new Date(b.date));
    
    res.json({ ok: true, stats, calls: calls.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// 导出 CSV
app.get("/api/analytics/export", requireApiAuth, async (req, res) => {
  try {
    const tenantId = req.session.tenantId;
    const { year, month, format } = req.query;
    
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    
    const { Call } = require("./models");
    const calls = await Call.find({
      tenantId,
      createdAt: { $gte: startDate, $lte: endDate }
    }).sort({ createdAt: -1 });
    
    if (format === 'csv') {
      const csv = [
        ['Date', 'Time', 'From', 'Duration (seconds)', 'Customer Name', 'Status', 'Appointment'].join(','),
        ...calls.map(c => [
          new Date(c.createdAt).toLocaleDateString(),
          new Date(c.createdAt).toLocaleTimeString(),
          c.from,
          c.duration || 0,
          (c.extracted?.callerName || '').replace(/,/g, ' '),
          c.status,
          c.extracted?.appointmentCreated ? 'Yes' : 'No'
        ].join(','))
      ].join('\n');
      
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="calls-${year}-${month}.csv"`);
      res.send(csv);
    } else {
      res.json({ ok: true, calls });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Webhook API（公开，需要 API Key）
app.get("/api/webhook/analytics", async (req, res) => {
  try {
    const { apiKey, tenantId, year, month } = req.query;
    
    const tenant = tenantService.getTenant(tenantId);
    if (!tenant || tenant.apiKey !== apiKey) {
      return res.status(401).json({ ok: false, error: "Invalid API key" });
    }
    
    const startDate = new Date(year, month - 1, 1);
    const endDate = new Date(year, month, 0, 23, 59, 59);
    
    const { Call } = require("./models");
    const calls = await Call.find({
      tenantId,
      createdAt: { $gte: startDate, $lte: endDate }
    });
    
    const stats = {
      totalCalls: calls.length,
      totalDuration: calls.reduce((sum, c) => sum + (c.duration || 0), 0),
      avgDuration: calls.length > 0 ? Math.round(calls.reduce((sum, c) => sum + (c.duration || 0), 0) / calls.length) : 0,
      appointmentsBooked: calls.filter(c => c.extracted?.appointmentCreated).length
    };
    
    res.json({ ok: true, stats });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ========================================
// 第 4 部分：更新 tenant.service.js 加载逻辑
// 需要在 loadAll() 函数中传递新配置
// ========================================

// 在 tenant.service.js 的 loadAll() 函数中，修改 calendarService 创建：
/*
if (tenant.google?.refreshToken) {
  const calendarService = createCalendarService({
    googleClientId: tenant.google.clientId,
    googleClientSecret: tenant.google.clientSecret,
    googleRefreshToken: tenant.google.refreshToken,
    googleCalendarId: tenant.google.calendarId || "primary",
    businessTimezone: tenant.timezone || "America/Halifax",
    defaultAppointmentMinutes: tenant.defaultAppointmentMinutes || 60,
    businessName: tenant.businessName || tenant.id,
    getOrCreateCallSession,
    // ===== 新增参数 =====
    businessHours: tenant.businessHours || null,
    serviceTypes: tenant.serviceTypes || [],
    slotInterval: tenant.slotInterval || 30,
  });
  tenant.calendarService = calendarService;
}
*/

// ========================================
// 第 5 部分：更新 WebSocket 部分（在 wss.on("connection") 内部）
// ========================================

/*
在 WebSocket 连接处理函数内部添加：

wss.on("connection", (twilioWs, req) => {
  // ... 现有代码 ...
  
  let callStartTime = null;  // ✅ 新增：记录通话开始时间
  
  // 修改 configureAndGreet 函数
  function configureAndGreet() {
    if (sessionConfigured) return;
    sessionConfigured = true;

    const tenantId = callTenantMap.get(activeCallSid);
    const tenant = tenantId ? tenantService.getTenant(tenantId) : null;

    // ===== 使用动态生成的 prompt 和 tools =====
    let prompt = tenant?.prompt || FALLBACK_PROMPT;
    
    // 如果 tenant 有服务类型配置，使用动态生成的 prompt
    if (tenant?.serviceTypes && tenant.serviceTypes.length > 0) {
      prompt = buildSystemPrompt(tenant.businessName, tenant.serviceTypes);
    }
    
    const voice = tenant?.voice || "alloy";
    
    // 使用动态生成的 tools
    let tools = tenant?.tools || tenantService.STANDARD_TOOLS;
    if (tenant?.serviceTypes && tenant.serviceTypes.length > 0) {
      tools = buildTools(tenant.serviceTypes);
    }
    
    const vadThreshold = tenant?.vadThreshold ?? 0.5;
    const silenceDurationMs = tenant?.silenceDurationMs ?? 500;
    tenantExtractionPrompt = tenant?.extractionPrompt || "";

    // 语速设置
    const speedMap = {
      slow: "\n\nIMPORTANT: Speak very slowly and clearly. Pause between sentences.",
      moderate: "\n\nSpeak at a calm, moderate pace. Pause briefly after each sentence.",
      fast: "\n\nSpeak at a natural conversational pace.",
    };
    const speedInstruction = speedMap[tenant?.speechSpeed] || speedMap.moderate;
    prompt += speedInstruction;

    // ✅ 记录通话开始时间
    callStartTime = new Date();
    callSession.startTime = callStartTime;
    
    console.log(`[Call] Started at ${callStartTime.toISOString()}`);
    console.log(`[WS] Configured: ${activeCallSid} tenant=${tenantId || 'none'}`);

    if (openaiWs.readyState === WebSocket.OPEN) {
      openaiWs.send(JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["audio", "text"],
          instructions: prompt,
          tools, 
          tool_choice: "auto",
          voice,
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: TRANSCRIPTION_MODEL },
          turn_detection: { 
            type: "server_vad", 
            threshold: vadThreshold, 
            silence_duration_ms: silenceDurationMs, 
            prefix_padding_ms: 300 
          },
        },
      }));
      openaiWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: tenant?.greeting || "Greet the caller and ask how you can help today." 
        },
      }));
    }
  }
  
  // ✅ 新增：通话结束时计算时长
  function finalizeCall() {
    if (!callStartTime) return;
    
    const callEndTime = new Date();
    const durationSeconds = Math.round((callEndTime - callStartTime) / 1000);
    
    callSession.endTime = callEndTime;
    callSession.duration = durationSeconds;
    
    console.log(`[Call] Ended. Duration: ${durationSeconds}s`);
    
    // 保存到数据库
    persistToDB(activeCallSid, callSession);
  }
  
  // ===== 修改 tool 处理部分，添加 get_next_available_slots =====
  // 在 response.done 的 Function Calling 部分添加：
  
  if (data.type === "response.done") {
    const tenantId = callTenantMap.get(activeCallSid);
    const tenant = tenantId ? tenantService.getTenant(tenantId) : null;
    const calSvc = tenant?.calendarService;
    const tz = tenant?.timezone || "America/Halifax";
    const apptMin = tenant?.defaultAppointmentMinutes || 60;

    for (const item of (data.response?.output || [])) {
      if (item.type !== "function_call") continue;
      const fnName = item.name;
      let fnArgs = {}; 
      try { fnArgs = JSON.parse(item.arguments || "{}"); } catch (_) {}
      console.log(`[Tool] ${fnName}`, fnArgs);
      let toolResult = "";

      // ===== 新增：get_next_available_slots 处理 =====
      if (fnName === "get_next_available_slots" && calSvc) {
        try {
          const count = fnArgs.count || 3;
          const serviceTypeId = fnArgs.service_type || null;
          const slots = await calSvc.getNextAvailableSlots(count, 14, serviceTypeId);
          
          if (!slots.length) {
            toolResult = `No available slots in the next 14 days. Tell caller we're fully booked and ask for their contact info to follow up.`;
          } else {
            const formattedSlots = slots.map((slot, idx) => {
              const date = new Date(slot.dateTimeStart);
              const dayName = date.toLocaleDateString('en-CA', { timeZone: tz, weekday: 'long' });
              const monthDay = date.toLocaleDateString('en-CA', { timeZone: tz, month: 'long', day: 'numeric' });
              const time = date.toLocaleTimeString('en-CA', {
                timeZone: tz,
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
              });
              return `${idx + 1}. ${dayName}, ${monthDay} at ${time}`;
            }).join('; ');
            
            toolResult = `Next available slots: ${formattedSlots}. Present these to caller and ask them to choose.`;
          }
        } catch (err) {
          toolResult = `Error getting available slots: ${err?.message}`;
        }
      }

      if (fnName === "check_availability" && calSvc) {
        try {
          const events = await calSvc.listEventsForDay(fnArgs.date);
          const slots = calSvc.generateSlotsForDay(fnArgs.date, events, apptMin);
          if (!slots.length) { 
            toolResult = `No available slots on ${fnArgs.date}. Ask for another date.`; 
          } else {
            const labels = slots.map(s => new Date(s.start).toLocaleTimeString("en-CA", { timeZone: tz, hour: "numeric", minute: "2-digit" }));
            toolResult = `Available on ${fnArgs.date}: ${labels.join(", ")}. Confirm with caller.`;
          }
        } catch (err) { 
          toolResult = `Calendar check failed: ${err?.message}`; 
        }
      }

      if (fnName === "create_appointment" && calSvc) {
        try {
          const s = getOrCreateCallSession(activeCallSid);
          Object.assign(s.extracted, {
            callerName: fnArgs.caller_name || s.extracted.callerName,
            callbackNumber: fnArgs.callback_number || s.extracted.callbackNumber,
            serviceAddress: fnArgs.service_address || s.extracted.serviceAddress,
            issueSummary: fnArgs.issue_summary || s.extracted.issueSummary,
            preferredDate: fnArgs.preferred_date || s.extracted.preferredDate,
            preferredTime: fnArgs.preferred_time || s.extracted.preferredTime,
            intent: fnArgs.intent || s.extracted.intent,
            bookingConfirmed: true,
          });
          const event = await calSvc.createAppointmentEvent(activeCallSid);
          persistToDB(activeCallSid, s);
          toolResult = `Appointment created. Event ID: ${event.id}. Confirm to caller.`;
        } catch (err) { 
          toolResult = `Failed: ${err?.message}. Tell caller a team member will follow up.`; 
        }
      }

      // ===== 修改 end_call 处理，添加延迟 =====
      if (fnName === "end_call") {
        const reason = fnArgs.reason || "complete";
        console.log(`[EndCall] ${activeCallSid}, reason: ${reason}`);
        toolResult = "Call ending. Say a brief goodbye now.";
        if (goodbyeTimer) { clearTimeout(goodbyeTimer); goodbyeTimer = null; }
        
        // ✅ 延迟挂断，给 AI 时间说完话
        console.log(`[EndCall] Delaying hangup by 6 seconds...`);
        setTimeout(() => {
          forceHangup(reason);
        }, 6000);
      }

      if (openaiWs.readyState === WebSocket.OPEN) {
        openaiWs.send(JSON.stringify({ 
          type: "conversation.item.create", 
          item: { type: "function_call_output", call_id: item.call_id, output: toolResult } 
        }));
        if (fnName !== "end_call") {
          openaiWs.send(JSON.stringify({ type: "response.create" }));
        }
      }
    }
  }
  
  // ===== 在 stop 和 close 事件中调用 finalizeCall =====
  twilioWs.on("message", async (msg) => {
    // ... 现有代码 ...
    
    if (data.event === "stop") {
      // ... 现有代码 ...
      finalizeCall();  // ✅ 添加
    }
  });
  
  twilioWs.on("close", () => {
    // ... 现有代码 ...
    finalizeCall();  // ✅ 添加
  });
});
*/

// ========================================
// 使用说明
// ========================================
/*
1. 将上述代码按标注的位置插入到 server.js 中
2. 确保 models/index.js 已更新
3. 确保 calendar.service.js 已更新
4. 确保 prompts.js 已更新
5. 将 analytics.html 放入 public/ 目录
6. 重启服务器测试
*/
