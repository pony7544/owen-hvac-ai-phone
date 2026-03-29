const { google } = require("googleapis");

function createCalendarService(config = {}) {
  const {
    googleClientId,
    googleClientSecret,
    googleRefreshToken,
    googleCalendarId = "primary",
    businessTimezone = "America/Halifax",
    defaultAppointmentMinutes = 60,
    businessName = "Owen HVAC Corp",
    getOrCreateCallSession,
  } = config;

  const oauth2Client = new google.auth.OAuth2(
    googleClientId,
    googleClientSecret
  );

  oauth2Client.setCredentials({
    refresh_token: googleRefreshToken,
  });

  const calendar = google.calendar({
    version: "v3",
    auth: oauth2Client,
  });

  function isValidIsoDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(s);
  }

  function isValidHHMM(s) {
    return /^\d{2}:\d{2}$/.test(s);
  }

  /**
   * 获取指定时区在指定日期时间的 UTC 偏移量（如 "-04:00"）
   * 这个函数会根据日期自动处理夏令时
   */
  function getTimezoneOffset(dateStr, timeStr, tz) {
    try {
      // 构造日期时间对象
      const dateTime = new Date(`${dateStr}T${timeStr}:00`);
      
      // 使用 Intl.DateTimeFormat 的 formatToParts 获取时区偏移
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'longOffset' // 返回 "GMT+08:00" 或 "GMT-04:00" 格式
      });
      
      const parts = formatter.formatToParts(dateTime);
      const timeZonePart = parts.find(part => part.type === 'timeZoneName');
      
      if (timeZonePart && timeZonePart.value) {
        // 解析 "GMT-04:00" 格式，提取 "-04:00"
        const match = timeZonePart.value.match(/GMT([+-]\d{2}:\d{2})/);
        if (match) {
          return match[1]; // 返回 "-04:00" 或 "+08:00"
        }
      }
    } catch (error) {
      console.error(`[Calendar] Error getting timezone offset for ${tz} on ${dateStr} ${timeStr}:`, error.message);
    }
    
    // 如果出错，返回默认偏移（Halifax 标准时间）
    console.warn(`[Calendar] Using default offset -04:00 for timezone ${tz}`);
    return "-04:00";
  }

  /**
   * 解析首选日期时间，生成带时区偏移的 RFC3339 格式字符串
   * @param {string} dateRaw - YYYY-MM-DD 格式
   * @param {string} timeRaw - HH:MM 24小时格式
   * @param {string} timezone - IANA 时区名称，如 "America/Halifax"
   * @returns {object|null} - { startLocal, endLocal, timezone }
   */
  function parsePreferredDateTime(dateRaw, timeRaw, timezone = businessTimezone) {
    if (!dateRaw || !timeRaw) return null;
    if (!isValidIsoDate(dateRaw)) return null;
    if (!isValidHHMM(timeRaw)) return null;

    // 获取该时区在指定日期时间的 UTC 偏移量
    const offset = getTimezoneOffset(dateRaw, timeRaw, timezone);

    // RFC3339 格式：本地时间 + 时区偏移
    // 例如: "2026-03-29T14:00:00-04:00"
    const startLocal = `${dateRaw}T${timeRaw}:00${offset}`;

    // 计算结束时间
    const [hh, mm] = timeRaw.split(":").map(Number);
    const totalMin = hh * 60 + mm + defaultAppointmentMinutes;
    const endHH = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const endMM = String(totalMin % 60).padStart(2, "0");
    const endLocal = `${dateRaw}T${endHH}:${endMM}:00${offset}`;

    return {
      startLocal,   // "2026-03-29T14:00:00-04:00"
      endLocal,     // "2026-03-29T15:00:00-04:00"
      timezone,
    };
  }

  async function testCalendarConnection() {
    try {
      const res = await calendar.calendars.get({
        calendarId: googleCalendarId,
      });
      console.log(`[Calendar] ✓ Connection test successful for calendar: ${res.data.summary}`);
      return res.data;
    } catch (error) {
      console.error(`[Calendar] ✗ Connection test failed:`, error.message);
      throw error;
    }
  }

  /**
   * 获取指定日期的所有事件
   * 修复：添加时区偏移到 timeMin 和 timeMax，确保查询正确的时间范围
   */
  async function listEventsForDay(dateStr) {
    try {
      // 添加时区偏移，确保 Google Calendar API 正确解释时间范围
      const offset = getTimezoneOffset(dateStr, "00:00", businessTimezone);
      
      const timeMin = `${dateStr}T00:00:00${offset}`;
      const timeMax = `${dateStr}T23:59:59${offset}`;
      
      console.log(`[Calendar] Listing events for ${dateStr} (${businessTimezone})`);
      console.log(`[Calendar] Query range: ${timeMin} to ${timeMax}`);
      
      const res = await calendar.events.list({
        calendarId: googleCalendarId,
        timeMin,
        timeMax,
        timeZone: businessTimezone,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = res.data.items || [];
      console.log(`[Calendar] Found ${events.length} event(s) on ${dateStr}`);
      return events;
    } catch (error) {
      console.error(`[Calendar] Error listing events for ${dateStr}:`, error.message);
      throw error;
    }
  }

  function generateSlotsForDay(dateStr, events, slotMinutes = 120) {
    const slots = [];

    // 将事件转换为分钟范围（相对于当天 00:00 的分钟数）
    const busyRanges = events
      .filter(evt => evt.start?.dateTime && evt.end?.dateTime)
      .map(evt => {
        const s = new Date(evt.start.dateTime);
        const e = new Date(evt.end.dateTime);
        return { startMin: s.getHours() * 60 + s.getMinutes(), endMin: e.getHours() * 60 + e.getMinutes() };
      });

    // 营业时间：8:00 - 18:00
    for (let startMin = 8 * 60; startMin + slotMinutes <= 18 * 60; startMin += slotMinutes) {
      const endMin = startMin + slotMinutes;

      const overlaps = busyRanges.some(b => startMin < b.endMin && endMin > b.startMin);

      if (!overlaps) {
        const sh = String(Math.floor(startMin / 60)).padStart(2, "0");
        const sm = String(startMin % 60).padStart(2, "0");
        const eh = String(Math.floor(endMin / 60)).padStart(2, "0");
        const em = String(endMin % 60).padStart(2, "0");
        slots.push({
          start: `${dateStr}T${sh}:${sm}:00`,
          end:   `${dateStr}T${eh}:${em}:00`,
        });
      }
    }

    console.log(`[Calendar] Generated ${slots.length} available slot(s) for ${dateStr}`);
    return slots;
  }

  async function createAppointmentEvent(callSid) {
    if (typeof getOrCreateCallSession !== "function") {
      throw new Error("getOrCreateCallSession is required");
    }

    const session = getOrCreateCallSession(callSid);
    const f = session.extracted || {};

    const parsed = parsePreferredDateTime(f.preferredDate, f.preferredTime, businessTimezone);
    if (!parsed) {
      throw new Error("Unable to parse normalized preferred date/time.");
    }

    // 详细日志
    console.log(`[Calendar] ============= Creating Appointment =============`);
    console.log(`[Calendar] Business: ${businessName}`);
    console.log(`[Calendar] Timezone: ${businessTimezone}`);
    console.log(`[Calendar] Customer: ${f.callerName || 'N/A'}`);
    console.log(`[Calendar] Phone: ${f.callbackNumber || 'N/A'}`);
    console.log(`[Calendar] Address: ${f.serviceAddress || 'N/A'}`);
    console.log(`[Calendar] Issue: ${f.issueSummary || 'N/A'}`);
    console.log(`[Calendar] Requested Date: ${f.preferredDate}`);
    console.log(`[Calendar] Requested Time: ${f.preferredTime}`);
    console.log(`[Calendar] Parsed Start (RFC3339): ${parsed.startLocal}`);
    console.log(`[Calendar] Parsed End (RFC3339): ${parsed.endLocal}`);
    console.log(`[Calendar] ================================================`);

    const event = {
      summary: `Service Call - ${f.callerName || "Customer"}`,
      location: f.serviceAddress || "",
      description: [
        `Customer Name: ${f.callerName || ""}`,
        `Phone: ${f.callbackNumber || ""}`,
        `Address: ${f.serviceAddress || ""}`,
        `Issue: ${f.issueSummary || ""}`,
        `Call SID: ${callSid}`,
        `Booked by AI phone assistant for ${businessName}.`,
      ].join("\n"),
      start: {
        dateTime: parsed.startLocal,  // 带时区偏移的完整 RFC3339 格式
        timeZone: parsed.timezone,     // 同时保留时区信息
      },
      end: {
        dateTime: parsed.endLocal,
        timeZone: parsed.timezone,
      },
    };

    try {
      const res = await calendar.events.insert({
        calendarId: googleCalendarId,
        requestBody: event,
      });

      session.extracted.appointmentCreated = true;
      session.extracted.appointmentEventId = res.data.id || "";
      session.updatedAt = new Date().toISOString();

      console.log(`[Calendar] ✓ Appointment created successfully`);
      console.log(`[Calendar] Event ID: ${res.data.id}`);
      console.log(`[Calendar] Calendar Link: ${res.data.htmlLink || 'N/A'}`);

      return res.data;
    } catch (error) {
      console.error(`[Calendar] ✗ Failed to create appointment:`, error.message);
      throw error;
    }
  }

  async function maybeAutoCreateAppointment(callSid) {
    if (typeof getOrCreateCallSession !== "function") {
      throw new Error("getOrCreateCallSession is required");
    }

    const session = getOrCreateCallSession(callSid);
    const f = session.extracted || {};

    if (f.appointmentCreated) return null;
    if (!f.bookingConfirmed) return null;

    if (
      !f.callerName ||
      !f.callbackNumber ||
      !f.serviceAddress ||
      !f.issueSummary ||
      !f.preferredDate ||
      !f.preferredTime
    ) {
      return null;
    }

    return await createAppointmentEvent(callSid);
  }

  return {
    testCalendarConnection,
    listEventsForDay,
    generateSlotsForDay,
    createAppointmentEvent,
    maybeAutoCreateAppointment,
    parsePreferredDateTime,
    isValidIsoDate,
    isValidHHMM,
    getTimezoneOffset, // 导出以便测试
  };
}

module.exports = {
  createCalendarService,
};
