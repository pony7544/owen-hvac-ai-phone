const { google } = require("googleapis");

const {
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN,
  GOOGLE_CALENDAR_ID = "primary",
  BUSINESS_TIMEZONE = "America/Halifax",
  DEFAULT_APPOINTMENT_MINUTES = 120,
} = process.env;

const oAuth2Client = new google.auth.OAuth2(
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET
);

oAuth2Client.setCredentials({
  refresh_token: GOOGLE_REFRESH_TOKEN,
});

const calendar = google.calendar({
  version: "v3",
  auth: oAuth2Client,
});

async function listEvents(timeMin, timeMax) {
  const res = await calendar.events.list({
    calendarId: GOOGLE_CALENDAR_ID,
    timeMin,
    timeMax,
    singleEvents: true,
    orderBy: "startTime",
  });

  return res.data.items || [];
}

async function getAvailableSlots(date, options = {}) {
  const {
    startHour = 9,
    endHour = 17,
    slotMinutes = 60,
  } = options;

  const dayStart = new Date(`${date}T00:00:00`);
  const dayEnd = new Date(`${date}T23:59:59`);

  const events = await listEvents(dayStart.toISOString(), dayEnd.toISOString());

  const busyRanges = events.map((event) => ({
    start: new Date(event.start.dateTime || event.start.date),
    end: new Date(event.end.dateTime || event.end.date),
  }));

  const slots = [];
  const start = new Date(`${date}T00:00:00`);

  for (let hour = startHour; hour < endHour; hour++) {
    const slotStart = new Date(start);
    slotStart.setHours(hour, 0, 0, 0);

    const slotEnd = new Date(slotStart.getTime() + slotMinutes * 60 * 1000);

    const conflict = busyRanges.some(
      (busy) => slotStart < busy.end && slotEnd > busy.start
    );

    if (!conflict) {
      slots.push({
        start: slotStart.toISOString(),
        end: slotEnd.toISOString(),
      });
    }
  }

  return slots;
}

async function createAppointment({
  customerName,
  phone,
  address,
  serviceType,
  startDateTime,
  durationMinutes = Number(DEFAULT_APPOINTMENT_MINUTES),
  notes = "",
}) {
  const start = new Date(startDateTime);
  const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

  const event = {
    summary: `${serviceType} - ${customerName}`,
    description: [
      `Customer: ${customerName || ""}`,
      `Phone: ${phone || ""}`,
      `Address: ${address || ""}`,
      `Service Type: ${serviceType || ""}`,
      `Notes: ${notes || ""}`,
    ].join("\n"),
    start: {
      dateTime: start.toISOString(),
      timeZone: BUSINESS_TIMEZONE,
    },
    end: {
      dateTime: end.toISOString(),
      timeZone: BUSINESS_TIMEZONE,
    },
  };

  const res = await calendar.events.insert({
    calendarId: GOOGLE_CALENDAR_ID,
    requestBody: event,
  });

  return res.data;
}

async function updateAppointment(eventId, updates) {
  const existing = await calendar.events.get({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId,
  });

  const event = existing.data;

  if (updates.customerName || updates.serviceType) {
    const serviceType = updates.serviceType || event.summary?.split(" - ")[0] || "Appointment";
    const customerName = updates.customerName || event.summary?.split(" - ")[1] || "Customer";
    event.summary = `${serviceType} - ${customerName}`;
  }

  if (
    updates.customerName ||
    updates.phone ||
    updates.address ||
    updates.serviceType ||
    updates.notes
  ) {
    event.description = [
      `Customer: ${updates.customerName || ""}`,
      `Phone: ${updates.phone || ""}`,
      `Address: ${updates.address || ""}`,
      `Service Type: ${updates.serviceType || ""}`,
      `Notes: ${updates.notes || ""}`,
    ].join("\n");
  }

  if (updates.startDateTime) {
    const start = new Date(updates.startDateTime);
    const durationMinutes =
      Number(updates.durationMinutes || DEFAULT_APPOINTMENT_MINUTES);
    const end = new Date(start.getTime() + durationMinutes * 60 * 1000);

    event.start = {
      dateTime: start.toISOString(),
      timeZone: BUSINESS_TIMEZONE,
    };
    event.end = {
      dateTime: end.toISOString(),
      timeZone: BUSINESS_TIMEZONE,
    };
  }

  const res = await calendar.events.update({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId,
    requestBody: event,
  });

  return res.data;
}

async function cancelAppointment(eventId) {
  await calendar.events.delete({
    calendarId: GOOGLE_CALENDAR_ID,
    eventId,
  });

  return { success: true };
}

module.exports = {
  listEvents,
  getAvailableSlots,
  createAppointment,
  updateAppointment,
  cancelAppointment,
};
