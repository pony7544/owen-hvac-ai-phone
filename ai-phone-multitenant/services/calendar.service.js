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
   */
  function getTimezoneOffset(dateStr, timeStr, tz) {
    // 用 Intl.DateTimeFormat 获取时区偏移
    try {
      const dt = new Date(`${dateStr}T${timeStr}:00Z`); // 临时 UTC 时间，仅用于获取偏移
      const formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: tz,
        timeZoneName: "shortOffset",
      });
      const parts = formatter.formatToParts(dt);
      const tzPart = parts.find(p => p.type === "timeZoneName");
      if (tzPart) {
        // 格式如 "GMT-4" 或 "GMT+5:30"
        const match = tzPart.value.match(/GMT([+-]?)(\d+)(?::(\d+))?/);
        if (match) {
          const sign = match[1] || "+";
          const hours = match[2].padStart(2, "0");
          const mins = (match[3] || "0").padStart(2, "0");
          return `${sign}${hours}:${mins}`;
        }
      }
    } catch (_) {}
    return "-04:00"; // fallback Montreal EDT
  }

  function parsePreferredDateTime(dateRaw, timeRaw, timezone = businessTimezone) {
    if (!dateRaw || !timeRaw) return null;
    if (!isValidIsoDate(dateRaw)) return null;
    if (!isValidHHMM(timeRaw)) return null;

    const offset = getTimezoneOffset(dateRaw, timeRaw, timezone);

    // RFC3339 格式：本地时间 + 时区偏移
    const startLocal = `${dateRaw}T${timeRaw}:00${offset}`;

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
    const res = await calendar.calendars.get({
      calendarId: googleCalendarId,
    });
    return res.data;
  }

  async function listEventsForDay(dateStr) {
    // 使用 timeZone 参数让 Google Calendar API 按业务时区计算日期范围
    const res = await calendar.events.list({
      calendarId: googleCalendarId,
      timeMin: `${dateStr}T00:00:00`,
      timeMax: `${dateStr}T23:59:59`,
      timeZone: businessTimezone,
      singleEvents: true,
      orderBy: "startTime",
    });

    return res.data.items || [];
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

    return slots;
  }

  async function createAppointmentEvent(callSid) {
    if (typeof getOrCreateCallSession !== "function") {
      throw new Error("getOrCreateCallSession is required");
    }

    const session = getOrCreateCallSession(callSid);
    const f = session.extracted || {};

    const parsed = parsePreferredDateTime(f.preferredDate, f.preferredTime);
    if (!parsed) {
      throw new Error("Unable to parse normalized preferred date/time.");
    }

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

    const res = await calendar.events.insert({
      calendarId: googleCalendarId,
      requestBody: event,
    });

    session.extracted.appointmentCreated = true;
    session.extracted.appointmentEventId = res.data.id || "";
    session.updatedAt = new Date().toISOString();

    return res.data;
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
  };
}

module.exports = {
  createCalendarService,
};
