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
    // ===== 新增参数 =====
    businessHours = null,
    serviceTypes = [],
    slotInterval = 30,
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
   * 获取指定时区在指定日期时间的 UTC 偏移量
   */
  function getTimezoneOffset(dateStr, timeStr, tz) {
    try {
      const dateTime = new Date(`${dateStr}T${timeStr}:00`);
      const formatter = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        timeZoneName: 'longOffset'
      });
      const parts = formatter.formatToParts(dateTime);
      const timeZonePart = parts.find(part => part.type === 'timeZoneName');
      if (timeZonePart && timeZonePart.value) {
        const match = timeZonePart.value.match(/GMT([+-]\d{2}:\d{2})/);
        if (match) {
          return match[1];
        }
      }
    } catch (error) {
      console.error(`[Calendar] Error getting timezone offset:`, error.message);
    }
    console.warn(`[Calendar] Using default offset -04:00`);
    return "-04:00";
  }

  function parsePreferredDateTime(dateRaw, timeRaw, timezone = businessTimezone) {
    if (!dateRaw || !timeRaw) return null;
    if (!isValidIsoDate(dateRaw)) return null;
    if (!isValidHHMM(timeRaw)) return null;

    const offset = getTimezoneOffset(dateRaw, timeRaw, timezone);
    const startLocal = `${dateRaw}T${timeRaw}:00${offset}`;

    const [hh, mm] = timeRaw.split(":").map(Number);
    const totalMin = hh * 60 + mm + defaultAppointmentMinutes;
    const endHH = String(Math.floor(totalMin / 60) % 24).padStart(2, "0");
    const endMM = String(totalMin % 60).padStart(2, "0");
    const endLocal = `${dateRaw}T${endHH}:${endMM}:00${offset}`;

    return {
      startLocal,
      endLocal,
      timezone,
    };
  }

  async function testCalendarConnection() {
    try {
      const res = await calendar.calendars.get({
        calendarId: googleCalendarId,
      });
      console.log(`[Calendar] ✓ Connection successful: ${res.data.summary}`);
      return res.data;
    } catch (error) {
      console.error(`[Calendar] ✗ Connection failed:`, error.message);
      throw error;
    }
  }

  async function listEventsForDay(dateStr) {
    try {
      const offset = getTimezoneOffset(dateStr, "00:00", businessTimezone);
      const timeMin = `${dateStr}T00:00:00${offset}`;
      const timeMax = `${dateStr}T23:59:59${offset}`;
      
      console.log(`[Calendar] Listing events for ${dateStr}`);
      
      const res = await calendar.events.list({
        calendarId: googleCalendarId,
        timeMin,
        timeMax,
        timeZone: businessTimezone,
        singleEvents: true,
        orderBy: "startTime",
      });

      const events = res.data.items || [];
      console.log(`[Calendar] Found ${events.length} event(s)`);
      return events;
    } catch (error) {
      console.error(`[Calendar] Error listing events:`, error.message);
      throw error;
    }
  }

  /**
   * 生成指定日期的可用时间槽
   * @param {string} dateStr - YYYY-MM-DD
   * @param {Array} events - 已有事件
   * @param {number} slotDuration - 时间槽时长（分钟）
   * @param {Object} customBusinessHours - 可选的营业时间配置
   */
  function generateSlotsForDay(dateStr, events, slotDuration, customBusinessHours = null) {
    const slots = [];
    
    // 获取该日是星期几
    const date = new Date(dateStr + 'T00:00:00');
    const dayNames = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
    const dayName = dayNames[date.getDay()];
    
    // 获取营业时间配置
    const hoursConfig = customBusinessHours || businessHours;
    let openTime = "09:00";
    let closeTime = "17:00";
    let isOpen = true;
    
    if (hoursConfig && hoursConfig[dayName]) {
      const dayHours = hoursConfig[dayName];
      isOpen = dayHours.enabled !== false;
      openTime = dayHours.open || openTime;
      closeTime = dayHours.close || closeTime;
    }
    
    if (!isOpen) {
      console.log(`[Calendar] ${dateStr} (${dayName}) is closed`);
      return [];
    }
    
    const [openHH, openMM] = openTime.split(':').map(Number);
    const [closeHH, closeMM] = closeTime.split(':').map(Number);
    const openMinutes = openHH * 60 + openMM;
    const closeMinutes = closeHH * 60 + closeMM;
    
    console.log(`[Calendar] ${dateStr} (${dayName}) hours: ${openTime} - ${closeTime}`);
    
    // 转换已有事件为分钟范围（使用营业时区）
    const busyRanges = events
      .filter(evt => evt.start?.dateTime && evt.end?.dateTime)
      .map(evt => {
        // 用营业时区格式化，确保小时/分钟是本地时间
        const sStr = new Date(evt.start.dateTime).toLocaleString("en-US", { timeZone: businessTimezone, hour12: false, hour: "2-digit", minute: "2-digit" });
        const eStr = new Date(evt.end.dateTime).toLocaleString("en-US", { timeZone: businessTimezone, hour12: false, hour: "2-digit", minute: "2-digit" });
        const [sHH, sMM] = sStr.split(":").map(Number);
        const [eHH, eMM] = eStr.split(":").map(Number);
        return { 
          startMin: sHH * 60 + sMM, 
          endMin: eHH * 60 + eMM 
        };
      });
    
    // 生成时间槽
    const interval = slotInterval || 30;
    for (let startMin = openMinutes; startMin + slotDuration <= closeMinutes; startMin += interval) {
      const endMin = startMin + slotDuration;
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
    
    console.log(`[Calendar] Generated ${slots.length} slot(s) for ${dateStr}`);
    return slots;
  }

  /**
   * 获取最近的可用时间槽
   * @param {number} maxSlots - 最多返回多少个
   * @param {number} lookAheadDays - 向前查找多少天
   * @param {string|null} serviceTypeId - 服务类型 ID
   */
  async function getNextAvailableSlots(maxSlots = 3, lookAheadDays = 14, serviceTypeId = null) {
    const availableSlots = [];
    const today = new Date();
    const todayStr = today.toLocaleDateString('en-CA', { timeZone: businessTimezone });
    
    // 确定时间槽时长
    let slotDuration = defaultAppointmentMinutes;
    let serviceName = "Service";
    
    if (serviceTypeId && Array.isArray(serviceTypes) && serviceTypes.length > 0) {
      const serviceType = serviceTypes.find(st => st.id === serviceTypeId && st.enabled);
      if (serviceType) {
        slotDuration = serviceType.duration;
        serviceName = serviceType.nameEn || serviceType.name;
      }
    }
    
    console.log(`[Calendar] Looking for ${maxSlots} slot(s) of ${slotDuration}min (${serviceName})`);
    
    for (let dayOffset = 0; dayOffset < lookAheadDays && availableSlots.length < maxSlots; dayOffset++) {
      const checkDate = new Date(today);
      checkDate.setDate(today.getDate() + dayOffset);
      const dateStr = checkDate.toLocaleDateString('en-CA', { timeZone: businessTimezone });
      
      try {
        const events = await listEventsForDay(dateStr);
        const slots = generateSlotsForDay(dateStr, events, slotDuration);
        
        // 如果是今天，过滤掉已过去的时间（使用营业时区的当前时间）
        let filteredSlots = slots;
        if (dateStr === todayStr) {
          // 获取营业时区的当前小时和分钟
          const nowInTz = new Date().toLocaleString("en-US", { timeZone: businessTimezone, hour12: false, hour: "2-digit", minute: "2-digit" });
          const [nowHH, nowMM] = nowInTz.split(":").map(Number);
          const currentMinutes = nowHH * 60 + nowMM;
          const buffer = 60;
          
          filteredSlots = slots.filter(slot => {
            const slotTime = slot.start.split('T')[1];
            const [hh, mm] = slotTime.split(':').map(Number);
            const slotMinutes = hh * 60 + mm;
            return slotMinutes > currentMinutes + buffer;
          });
        }
        
        // 添加到结果
        for (const slot of filteredSlots) {
          if (availableSlots.length >= maxSlots) break;
          availableSlots.push({
            date: dateStr,
            startTime: slot.start.split('T')[1].substring(0, 5),
            endTime: slot.end.split('T')[1].substring(0, 5),
            dateTimeStart: slot.start,
            dateTimeEnd: slot.end,
            duration: slotDuration,
            serviceType: serviceName
          });
        }
      } catch (err) {
        console.error(`[Calendar] Error checking ${dateStr}:`, err.message);
      }
    }
    
    console.log(`[Calendar] Found ${availableSlots.length} available slot(s)`);
    return availableSlots;
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
        dateTime: parsed.startLocal,
        timeZone: parsed.timezone,
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
    getNextAvailableSlots,  // ✅ 新增导出
    createAppointmentEvent,
    maybeAutoCreateAppointment,
    parsePreferredDateTime,
    isValidIsoDate,
    isValidHHMM,
    getTimezoneOffset,
  };
}

module.exports = {
  createCalendarService,
};
