// =============================================================
// models/index.js — MongoDB 连接 + Mongoose Schema 定义
// 更新：添加营业时间、服务类型配置和通话统计功能
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
  extractionPrompt: { type: String, default: "" },
  greeting:     { type: String, default: "" },
  
  // 语音控制参数
  speechSpeed:        { type: String, default: "moderate", enum: ["slow", "moderate", "fast"] },
  vadThreshold:       { type: Number, default: 0.5 },
  silenceDurationMs:  { type: Number, default: 500 },
  
  // ===== 新增：营业时间配置 =====
  businessHours: {
    monday: {
      enabled: { type: Boolean, default: true },
      open: { type: String, default: "09:00" },
      close: { type: String, default: "17:00" }
    },
    tuesday: {
      enabled: { type: Boolean, default: true },
      open: { type: String, default: "09:00" },
      close: { type: String, default: "17:00" }
    },
    wednesday: {
      enabled: { type: Boolean, default: true },
      open: { type: String, default: "09:00" },
      close: { type: String, default: "17:00" }
    },
    thursday: {
      enabled: { type: Boolean, default: true },
      open: { type: String, default: "09:00" },
      close: { type: String, default: "17:00" }
    },
    friday: {
      enabled: { type: Boolean, default: true },
      open: { type: String, default: "09:00" },
      close: { type: String, default: "17:00" }
    },
    saturday: {
      enabled: { type: Boolean, default: false },
      open: { type: String, default: "10:00" },
      close: { type: String, default: "14:00" }
    },
    sunday: {
      enabled: { type: Boolean, default: false },
      open: { type: String, default: "10:00" },
      close: { type: String, default: "14:00" }
    }
  },
  
  // ===== 新增：服务类型配置 =====
  serviceTypes: [{
    id: { type: String, required: true },
    name: { type: String, required: true },
    nameEn: { type: String, required: true },
    duration: { type: Number, required: true },
    description: { type: String, default: "" },
    price: { type: Number, default: 0 },
    enabled: { type: Boolean, default: true }
  }],
  
  // ===== 新增：时间槽配置 =====
  slotInterval: { type: Number, default: 30 },
  
  // ===== 新增：API Key（用于 Webhook） =====
  apiKey: {
    type: String,
    default: () => require('crypto').randomBytes(32).toString('hex'),
    index: true
  },
  
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
  from:       { type: String, default: "", index: true },  // ✅ 添加索引
  to:         { type: String, default: "", index: true },  // ✅ 添加索引
  status:     { type: String, default: "new" },
  streamSid:  { type: String, default: "" },
  
  // ===== 新增：通话时长相关字段 =====
  startTime:  { type: Date, index: true },
  endTime:    { type: Date },
  duration:   { type: Number, default: 0 },  // 通话时长（秒）
  
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

// ✅ 添加复合索引以优化统计查询
callSchema.index({ tenantId: 1, createdAt: -1 });
callSchema.index({ tenantId: 1, from: 1, createdAt: -1 });
callSchema.index({ tenantId: 1, startTime: 1 });

// ─── Recording Schema ────────────────────────
const recordingSchema = new mongoose.Schema({
  callSid:         { type: String, required: true, unique: true, index: true },
  tenantId:        { type: String, default: "" },
  wavBuffer:       { type: Buffer },
  callerFrames:    { type: Buffer },
  assistantFrames: { type: Buffer },
  durationSec:     { type: Number, default: 0 },
  available:       { type: Boolean, default: false },
}, { timestamps: true });

// ===== 新增：月度统计汇总表（可选，用于优化查询） =====
const callStatsSchema = new mongoose.Schema({
  tenantId:        { type: String, required: true, index: true },
  year:            { type: Number, required: true },
  month:           { type: Number, required: true },
  
  totalCalls:      { type: Number, default: 0 },
  totalDuration:   { type: Number, default: 0 },
  avgDuration:     { type: Number, default: 0 },
  
  callsBySource: [{
    from: String,
    count: Number,
    totalDuration: Number
  }],
  
  dailyStats: [{
    date: Date,
    count: Number,
    duration: Number
  }],
  
  lastUpdated: { type: Date, default: Date.now }
}, { timestamps: true });

callStatsSchema.index({ tenantId: 1, year: 1, month: 1 }, { unique: true });

const Tenant    = mongoose.models.Tenant    || mongoose.model("Tenant", tenantSchema);
const Call      = mongoose.models.Call      || mongoose.model("Call", callSchema);
const Recording = mongoose.models.Recording || mongoose.model("Recording", recordingSchema);
const CallStats = mongoose.models.CallStats || mongoose.model("CallStats", callStatsSchema);

module.exports = { connectDB, Tenant, Call, Recording, CallStats };
