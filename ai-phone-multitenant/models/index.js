// =============================================================
// models/index.js — MongoDB 连接 + Mongoose Schema 定义
// =============================================================

const mongoose = require("mongoose");

// ─── 连接 ────────────────────────────────────
async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("FATAL: MONGODB_URI not set.");
    process.exit(1);
  }
  await mongoose.connect(uri);
  console.log("[MongoDB] Connected to", uri.replace(/\/\/.*@/, "//***@"));
}

// ─── Tenant Schema ───────────────────────────
const tenantSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true, index: true },
  businessName: { type: String, default: "" },
  timezone:     { type: String, default: "America/Halifax" },
  phoneNumber:  { type: String, default: "" },
  voice:        { type: String, default: "alloy" },
  defaultAppointmentMinutes: { type: Number, default: 60 },
  adminUser:    { type: String, default: "" },
  adminPass:    { type: String, default: "" },
  prompt:       { type: String, default: "" },
  greeting:     { type: String, default: "" },
  google: {
    clientId:     { type: String, default: "" },
    clientSecret: { type: String, default: "" },
    refreshToken: { type: String, default: "" },
    calendarId:   { type: String, default: "primary" },
  },
}, { timestamps: true });

// ─── Call Schema ─────────────────────────────
const callSchema = new mongoose.Schema({
  callSid:    { type: String, required: true, unique: true, index: true },
  tenantId:   { type: String, default: "", index: true },
  from:       { type: String, default: "" },
  to:         { type: String, default: "" },
  status:     { type: String, default: "new" },
  streamSid:  { type: String, default: "" },
  transcript: [{
    role: { type: String },
    text: { type: String },
    ts:   { type: String },
  }],
  extracted: {
    intent:              { type: String, default: "" },
    callerName:          { type: String, default: "" },
    callbackNumber:      { type: String, default: "" },
    serviceAddress:      { type: String, default: "" },
    issueSummary:        { type: String, default: "" },
    preferredDate:       { type: String, default: "" },
    preferredTime:       { type: String, default: "" },
    preferredDateTime:   { type: String, default: "" },
    bookingConfirmed:    { type: Boolean, default: false },
    appointmentCreated:  { type: Boolean, default: false },
    appointmentEventId:  { type: String, default: "" },
  },
  mediaPacketCount: { type: Number, default: 0 },
}, { timestamps: true });

// ─── Recording Schema ────────────────────────
const recordingSchema = new mongoose.Schema({
  callSid:         { type: String, required: true, unique: true, index: true },
  tenantId:        { type: String, default: "" },
  wavBuffer:       { type: Buffer },
  callerFrames:    { type: Buffer },    // JSON.stringify 后的 compressed frames
  assistantFrames: { type: Buffer },    // JSON.stringify 后的 compressed frames
  durationSec:     { type: Number, default: 0 },
  available:       { type: Boolean, default: false },
}, { timestamps: true });

const Tenant    = mongoose.models.Tenant    || mongoose.model("Tenant", tenantSchema);
const Call      = mongoose.models.Call      || mongoose.model("Call", callSchema);
const Recording = mongoose.models.Recording || mongoose.model("Recording", recordingSchema);

module.exports = { connectDB, Tenant, Call, Recording };
