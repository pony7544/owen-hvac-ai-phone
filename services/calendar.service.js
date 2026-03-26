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

  function parsePreferredDateTime(dateRaw, timeRaw, timezone = businessTimezone) {
    if (!dateRaw || !timeRaw) return null;
    if (!isValidIsoDate(dateRaw)) return null;
    if (!isValidHHMM(timeRaw)) return null;

    const start = new Date(`${dateRaw}T${timeRaw}:00`);
    if (Number.isNaN(start.getTime())) return null;

    const end = new Date(start.getTime() + defaultAppointmentMinutes * 60000);

    return {
      start,
      end,
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
    const dayStart = new Date(`${dateStr}T00:00:00`);
    const dayEnd = new Date(`${dateStr}T23:59:59`);

    const res = await calendar.events.list({
      calendarId: googleCalendarId,
      timeMin: dayStart.toISOString(),
      timeMax: dayEnd.toISOString(),
      singleEvents: true,
      orderBy: "startTime",
    });

    return res.data.items || [];
  }

  function generateSlotsForDay(dateStr, events, slotMinutes = 120) {
    const slots = [];
    const workStart = new Date(`${dateStr}T08:00:00`);
    const workEnd = new Date(`${dateStr}T18:00:00`);

    let cursor = new Date(workStart);

    while (cursor < workEnd) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor.getTime() + slotMinutes * 60000);

      const overlaps = events.some((evt) => {
        if (!evt.start?.dateTime || !evt.end?.dateTime) return false;
        const evtStart = new Date(evt.start.dateTime);
        const evtEnd = new Date(evt.end.dateTime);
        return slotStart < evtEnd && slotEnd > evtStart;
      });

      if (!overlaps && slotEnd <= workEnd) {
        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
        });
      }

      cursor = new Date(cursor.getTime() + slotMinutes * 60000);
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
        dateTime: parsed.start.toISOString(),
        timeZone: parsed.timezone,
      },
      end: {
        dateTime: parsed.end.toISOString(),
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
