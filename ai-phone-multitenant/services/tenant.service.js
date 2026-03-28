// =============================================================
// services/tenant.service.js — MongoDB 版多租户管理
// DB 为持久化层，内存 Map 为运行时缓存（含 calendarService 实例）
// =============================================================

const { createCalendarService } = require("./calendar.service");

// 懒加载 Model，避免循环依赖导致 OverwriteModelError
function getTenantModel() {
  return require("../models").Tenant;
}

const STANDARD_TOOLS = [
  {
    type: "function", name: "check_availability",
    description: "Check available appointment slots for a given date.",
    parameters: {
      type: "object",
      properties: { date: { type: "string", description: "YYYY-MM-DD" } },
      required: ["date"],
    },
  },
  {
    type: "function", name: "create_appointment",
    description: "Create a confirmed appointment after the caller verbally confirmed.",
    parameters: {
      type: "object",
      properties: {
        caller_name: { type: "string" }, callback_number: { type: "string" },
        service_address: { type: "string" }, issue_summary: { type: "string" },
        preferred_date: { type: "string", description: "YYYY-MM-DD" },
        preferred_time: { type: "string", description: "HH:MM 24h" },
        intent: { type: "string", enum: ["service_or_repair","quote_request","maintenance","new_installation","general_inquiry","other"] },
      },
      required: ["caller_name","callback_number","service_address","issue_summary","preferred_date","preferred_time","intent"],
    },
  },
  {
    type: "function", name: "end_call",
    description: "Hang up the call after saying goodbye.",
    parameters: {
      type: "object",
      properties: { reason: { type: "string" } },
      required: ["reason"],
    },
  },
];

// ─── 内存缓存 ────────────────────────────────
let tenantsCache = new Map();  // tenantId → runtime tenant object
let byPhone = new Map();
let byUser  = new Map();

// ─── 构建运行时租户对象（含 calendarService）───
function buildRuntimeTenant(doc, getOrCreateCallSession) {
  const cfg = doc.toObject ? doc.toObject() : doc;
  let calendarService = null;
  if (cfg.google?.clientId && cfg.google?.clientSecret && cfg.google?.refreshToken) {
    calendarService = createCalendarService({
      googleClientId:            cfg.google.clientId,
      googleClientSecret:        cfg.google.clientSecret,
      googleRefreshToken:        cfg.google.refreshToken,
      googleCalendarId:          cfg.google.calendarId || "primary",
      businessTimezone:          cfg.timezone || "America/Halifax",
      defaultAppointmentMinutes: cfg.defaultAppointmentMinutes || 60,
      businessName:              cfg.businessName || cfg.id,
      getOrCreateCallSession,
    });
  }
  return {
    id: cfg.id, businessName: cfg.businessName || cfg.id,
    timezone: cfg.timezone || "America/Halifax",
    phoneNumber: cfg.phoneNumber || "", voice: cfg.voice || "alloy",
    defaultAppointmentMinutes: cfg.defaultAppointmentMinutes || 60,
    adminUser: cfg.adminUser || "", adminPass: cfg.adminPass || "",
    prompt: cfg.prompt || "",
    extractionPrompt: cfg.extractionPrompt || "",
    greeting: cfg.greeting || `Hello, thank you for calling ${cfg.businessName || cfg.id}. Please hold.`,
    speechSpeed: cfg.speechSpeed || "moderate",
    vadThreshold: cfg.vadThreshold ?? 0.5,
    silenceDurationMs: cfg.silenceDurationMs ?? 500,
    tools: STANDARD_TOOLS,
    google: cfg.google || {},
    calendarService,
  };
}

function rebuildIndexes() {
  byPhone.clear();
  byUser.clear();
  for (const [, t] of tenantsCache) {
    if (t.phoneNumber) {
      byPhone.set(t.phoneNumber, t.id);
      byPhone.set(t.phoneNumber.replace(/\D/g, ""), t.id);
    }
    if (t.adminUser) byUser.set(t.adminUser, t.id);
  }
}

// ─── 对外接口 ────────────────────────────────

async function loadAll({ getOrCreateCallSession } = {}) {
  const docs = await getTenantModel().find();
  tenantsCache.clear();
  for (const doc of docs) {
    tenantsCache.set(doc.id, buildRuntimeTenant(doc, getOrCreateCallSession));
    console.log(`[Tenant] Loaded: ${doc.id} (${doc.businessName || doc.id})`);
  }
  rebuildIndexes();
  console.log(`[Tenant] Total: ${tenantsCache.size} tenants`);
}

function getTenant(tenantId) { return tenantsCache.get(tenantId) || null; }
function getAllTenants() { return Array.from(tenantsCache.values()); }

function getByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const tid = byPhone.get(phoneNumber) || byPhone.get(phoneNumber.replace(/\D/g, ""));
  return tid ? tenantsCache.get(tid) : null;
}

function getByUser(username) {
  const tid = byUser.get(username);
  return tid ? tenantsCache.get(tid) : null;
}

async function createTenant(cfg, { getOrCreateCallSession } = {}) {
  if (!cfg.id) throw new Error("Tenant id is required");
  if (tenantsCache.has(cfg.id)) throw new Error(`Tenant ${cfg.id} already exists`);
  const doc = await getTenantModel().create(cfg);
  tenantsCache.set(doc.id, buildRuntimeTenant(doc, getOrCreateCallSession));
  rebuildIndexes();
  return tenantsCache.get(doc.id);
}

async function updateTenant(tenantId, updates, { getOrCreateCallSession } = {}) {
  const doc = await getTenantModel().findOneAndUpdate(
    { id: tenantId },
    { $set: { ...updates, id: tenantId } },
    { new: true }
  );
  if (!doc) throw new Error(`Tenant ${tenantId} not found`);
  tenantsCache.set(tenantId, buildRuntimeTenant(doc, getOrCreateCallSession));
  rebuildIndexes();
  return tenantsCache.get(tenantId);
}

async function deleteTenant(tenantId) {
  const res = await getTenantModel().deleteOne({ id: tenantId });
  if (res.deletedCount === 0) throw new Error(`Tenant ${tenantId} not found`);
  tenantsCache.delete(tenantId);
  rebuildIndexes();
}

async function getTenantRaw(tenantId) {
  const doc = await getTenantModel().findOne({ id: tenantId }).lean();
  return doc || null;
}

module.exports = {
  STANDARD_TOOLS, loadAll, getTenant, getAllTenants,
  getByPhone, getByUser, createTenant, updateTenant, deleteTenant, getTenantRaw,
};
