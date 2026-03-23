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

  async getEvent(eventId) {
    const res = await this.calendar.events.get({
      calendarId: this.calendarId,
      eventId,
    });

    return res.data;
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

  async createAppointment({
    customerName,
    phone = "",
    address = "",
    serviceType = "HVAC Appointment",
    startDateTime,
    durationMinutes = DEFAULT_APPOINTMENT_MINUTES,
    notes = "",
  }) {
    const start = new Date(startDateTime);
    const end = new Date(start.getTime() + Number(durationMinutes) * 60 * 1000);

    const description = [
      `Customer: ${customerName || ""}`,
      `Phone: ${phone}`,
      `Address: ${address}`,
      `Service Type: ${serviceType}`,
      `Notes: ${notes}`,
      "",
      "Created by Owen HVAC AI system.",
    ].join("\n");

    const res = await this.calendar.events.insert({
      calendarId: this.calendarId,
      requestBody: {
        summary: `${serviceType} - ${customerName}`,
        description,
        location: address,
        start: {
          dateTime: start.toISOString(),
          timeZone: BUSINESS_TIMEZONE,
        },
        end: {
          dateTime: end.toISOString(),
          timeZone: BUSINESS_TIMEZONE,
        },
      },
    });

    return {
      eventId: res.data.id,
      htmlLink: res.data.htmlLink,
      summary: res.data.summary,
      description: res.data.description,
      location: res.data.location,
      start: res.data.start,
      end: res.data.end,
      status: res.data.status,
    };
  }

  async updateAppointment(eventId, updates = {}) {
    const existing = await this.getEvent(eventId);

    const existingStart = existing.start?.dateTime || existing.start?.date;
    const existingEnd = existing.end?.dateTime || existing.end?.date;

    let startDateTime = existingStart;
    let endDateTime = existingEnd;

    if (updates.startDateTime) {
      const start = new Date(updates.startDateTime);
      const durationMinutes = Number(
        updates.durationMinutes || DEFAULT_APPOINTMENT_MINUTES
      );
      const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

      startDateTime = start.toISOString();
      endDateTime = end.toISOString();
    }

    const newCustomerName =
      updates.customerName ||
      this.extractField(existing.description, "Customer") ||
      "";
    const newPhone =
      updates.phone || this.extractField(existing.description, "Phone") || "";
    const newAddress =
      updates.address || existing.location || this.extractField(existing.description, "Address") || "";
    const newServiceType =
      updates.serviceType ||
      this.extractField(existing.description, "Service Type") ||
      existing.summary ||
      "HVAC Appointment";
    const newNotes =
      updates.notes || this.extractField(existing.description, "Notes") || "";

    const description = [
      `Customer: ${newCustomerName}`,
      `Phone: ${newPhone}`,
      `Address: ${newAddress}`,
      `Service Type: ${newServiceType}`,
      `Notes: ${newNotes}`,
      "",
      "Updated by Owen HVAC AI system.",
    ].join("\n");

    const res = await this.calendar.events.update({
      calendarId: this.calendarId,
      eventId,
      requestBody: {
        ...existing,
        summary: `${newServiceType} - ${newCustomerName}`,
        description,
        location: newAddress,
        start: {
          dateTime: startDateTime,
          timeZone: BUSINESS_TIMEZONE,
        },
        end: {
          dateTime: endDateTime,
          timeZone: BUSINESS_TIMEZONE,
        },
      },
    });

    return {
      eventId: res.data.id,
      htmlLink: res.data.htmlLink,
      summary: res.data.summary,
      description: res.data.description,
      location: res.data.location,
      start: res.data.start,
      end: res.data.end,
      status: res.data.status,
    };
  }

  async cancelAppointment(eventId) {
    await this.calendar.events.delete({
      calendarId: this.calendarId,
      eventId,
    });

    return {
      success: true,
      eventId,
    };
  }

  extractField(description = "", label) {
    const regex = new RegExp(`^${label}:\\s*(.*)$`, "mi");
    const match = description.match(regex);
    return match ? match[1].trim() : "";
  }
}

module.exports = {
  HVACCalendarService,
};
