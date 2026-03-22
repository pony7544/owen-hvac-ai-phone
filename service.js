const { google } = require("googleapis");

const BUSINESS_TIMEZONE = process.env.BUSINESS_TIMEZONE || "America/Halifax";
const DEFAULT_APPOINTMENT_MINUTES = Number(
  process.env.DEFAULT_APPOINTMENT_MINUTES || 60
);

function createGoogleCalendarClient() {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;

  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error(
      "Missing Google credentials. Required: GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN"
    );
  }

  const auth = new google.auth.OAuth2(clientId, clientSecret);
  auth.setCredentials({
    refresh_token: refreshToken,
  });

  return google.calendar({
    version: "v3",
    auth,
  });
}

class HVACCalendarService {
  constructor() {
    this.calendar = createGoogleCalendarClient();
    this.calendarId = process.env.GOOGLE_CALENDAR_ID;
    if (!this.calendarId) {
      throw new Error("Missing GOOGLE_CALENDAR_ID");
    }
  }

  async getCalendarInfo() {
    const res = await this.calendar.calendars.get({
      calendarId: this.calendarId,
    });

    return {
      id: res.data.id,
      summary: res.data.summary,
      timeZone: res.data.timeZone,
    };
  }

  async getBusyBlocks({ start, end }) {
    const timeMin =
      start instanceof Date ? start.toISOString() : new Date(start).toISOString();
    const timeMax =
      end instanceof Date ? end.toISOString() : new Date(end).toISOString();

    const res = await this.calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: BUSINESS_TIMEZONE,
        items: [{ id: this.calendarId }],
      },
    });

    return res.data.calendars?.[this.calendarId]?.busy || [];
  }

  async getAvailableSlots({
    start,
    end,
    slotMinutes = DEFAULT_APPOINTMENT_MINUTES,
    maxSlots = 5,
  }) {
    const timeMin =
      start instanceof Date ? start.toISOString() : new Date(start).toISOString();
    const timeMax =
      end instanceof Date ? end.toISOString() : new Date(end).toISOString();

    const busy = await this.getBusyBlocks({ start: timeMin, end: timeMax });

    const slots = [];
    let cursor = new Date(timeMin);
    const endDate = new Date(timeMax);

    while (cursor < endDate && slots.length < maxSlots) {
      const slotStart = new Date(cursor);
      const slotEnd = new Date(cursor.getTime() + slotMinutes * 60 * 1000);

      const overlaps = busy.some((b) => {
        const busyStart = new Date(b.start);
        const busyEnd = new Date(b.end);
        return slotStart < busyEnd && slotEnd > busyStart;
      });

      const hour = Number(
        slotStart.toLocaleString("en-CA", {
          timeZone: BUSINESS_TIMEZONE,
          hour: "numeric",
          hour12: false,
        })
      );

      const isBusinessHour = hour >= 8 && hour < 17;

      if (!overlaps && isBusinessHour && slotEnd <= endDate) {
        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          label: slotStart.toLocaleString("en-CA", {
            timeZone: BUSINESS_TIMEZONE,
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          }),
        });
      }

      cursor = new Date(cursor.getTime() + 30 * 60 * 1000);
    }

    return slots;
  }

  async createBooking({
    customerName = "Test Customer",
    phone = "",
    address = "",
    intent = "service_or_repair",
    issueSummary = "Test booking from Owen HVAC AI system",
    start,
    end,
  }) {
    const title =
      intent === "new_installation"
        ? `HVAC Installation Consultation - ${customerName}`
        : `HVAC Service Call - ${customerName}`;

    const description = [
      `Intent: ${intent}`,
      `Customer: ${customerName}`,
      `Phone: ${phone}`,
      `Address: ${address}`,
      `Issue: ${issueSummary}`,
      "",
      "Created by Owen HVAC AI system.",
    ].join("\n");

    const res = await this.calendar.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: title,
        description,
        location: address,
        start: {
          dateTime:
            start instanceof Date ? start.toISOString() : new Date(start).toISOString(),
          timeZone: BUSINESS_TIMEZONE,
        },
        end: {
          dateTime:
            end instanceof Date ? end.toISOString() : new Date(end).toISOString(),
          timeZone: BUSINESS_TIMEZONE,
        },
      },
    });

    return {
      eventId: res.data.id,
      htmlLink: res.data.htmlLink,
      summary: res.data.summary,
      start: res.data.start,
      end: res.data.end,
    };
  }
}

module.exports = {
  HVACCalendarService,
};
