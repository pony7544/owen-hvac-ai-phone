// =============================================================
// services/tenant.service.js — 多租户 CRUD 抽象层
//
// 当前实现：JSON 文件读写
// 未来切换：替换本文件的内部实现为 MongoDB/PostgreSQL，
//           对外接口（loadAll/get/create/update/delete 等）不变。
// =============================================================

const fs   = require("fs");
const path = require("path");
const { createCalendarService } = require("./calendar.service");

const TENANTS_PATH = path.join(__dirname, "..", "tenants.json");

// 所有租户共用的 AI 工具定义
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
        caller_name:     { type: "string" },
        callback_number: { type: "string" },
        service_address: { type: "string" },
        issue_summary:   { type: "string" },
        preferred_date:  { type: "string", description: "YYYY-MM-DD" },
        preferred_time:  { type: "string", description: "HH:MM 24h" },
        intent:          { type: "string", enum: ["service_or_repair","quote_request","maintenance","new_installation","general_inquiry","other"] },
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
let tenants = new Map();   // tenantId → tenant object
let byPhone = new Map();   // phone digits → tenantId
let byUser  = new Map();   // adminUser → tenantId

// ─── JSON 文件读写 ───────────────────────────
function readJsonFile() {
  if (!fs.existsSync(TENANTS_PATH)) return [];
  return JSON.parse(fs.readFileSync(TENANTS_PATH, "utf-8"));
}

function writeJsonFile(list) {
  fs.writeFileSync(TENANTS_PATH, JSON.stringify(list, null, 2), "utf-8");
}

// ─── 构建租户对象（含 calendarService 实例）───
function buildTenantObject(cfg, getOrCreateCallSession) {
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
    id:             cfg.id,
    businessName:   cfg.businessName || cfg.id,
    timezone:       cfg.timezone || "America/Halifax",
    phoneNumber:    cfg.phoneNumber || "",
    voice:          cfg.voice || "alloy",
    defaultAppointmentMinutes: cfg.defaultAppointmentMinutes || 60,
    adminUser:      cfg.adminUser || "",
    adminPass:      cfg.adminPass || "",
    prompt:         cfg.prompt || "",
    greeting:       cfg.greeting || `Hello, thank you for calling ${cfg.businessName || cfg.id}. Please hold.`,
    tools:          STANDARD_TOOLS,
    google:         cfg.google || {},
    calendarService,
  };
}

// ─── 重建索引 ────────────────────────────────
function rebuildIndexes() {
  byPhone.clear();
  byUser.clear();
  for (const [, t] of tenants) {
    if (t.phoneNumber) {
      byPhone.set(t.phoneNumber, t.id);
      byPhone.set(t.phoneNumber.replace(/\D/g, ""), t.id);
    }
    if (t.adminUser) {
      byUser.set(t.adminUser, t.id);
    }
  }
}

// =============================================================
// 对外接口（未来换数据库只需替换这些函数的内部实现）
// =============================================================

/**
 * 初始化：从 JSON 加载所有租户
 */
function loadAll({ getOrCreateCallSession } = {}) {
  const list = readJsonFile();
  tenants.clear();
  for (const cfg of list) {
    if (!cfg.id) continue;
    tenants.set(cfg.id, buildTenantObject(cfg, getOrCreateCallSession));
    console.log(`[Tenant] Loaded: ${cfg.id} (${cfg.businessName || cfg.id})`);
  }
  rebuildIndexes();
  console.log(`[Tenant] Total: ${tenants.size} tenants`);
}

/**
 * 获取单个租户
 */
function getTenant(tenantId) {
  return tenants.get(tenantId) || null;
}

/**
 * 获取所有租户（返回数组）
 */
function getAllTenants() {
  return Array.from(tenants.values());
}

/**
 * 按电话号码查找租户
 */
function getByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const tid = byPhone.get(phoneNumber) || byPhone.get(phoneNumber.replace(/\D/g, ""));
  return tid ? tenants.get(tid) : null;
}

/**
 * 按登录用户名查找租户
 */
function getByUser(username) {
  const tid = byUser.get(username);
  return tid ? tenants.get(tid) : null;
}

/**
 * 创建新租户
 */
function createTenant(cfg, { getOrCreateCallSession } = {}) {
  if (!cfg.id) throw new Error("Tenant id is required");
  if (tenants.has(cfg.id)) throw new Error(`Tenant ${cfg.id} already exists`);

  // 写入 JSON
  const list = readJsonFile();
  list.push(cfg);
  writeJsonFile(list);

  // 更新内存
  tenants.set(cfg.id, buildTenantObject(cfg, getOrCreateCallSession));
  rebuildIndexes();
  return tenants.get(cfg.id);
}

/**
 * 更新租户
 */
function updateTenant(tenantId, updates, { getOrCreateCallSession } = {}) {
  if (!tenants.has(tenantId)) throw new Error(`Tenant ${tenantId} not found`);

  // 更新 JSON
  const list = readJsonFile();
  const idx  = list.findIndex(t => t.id === tenantId);
  if (idx === -1) throw new Error(`Tenant ${tenantId} not in file`);

  const merged = { ...list[idx], ...updates, id: tenantId }; // id 不可改
  list[idx] = merged;
  writeJsonFile(list);

  // 更新内存
  tenants.set(tenantId, buildTenantObject(merged, getOrCreateCallSession));
  rebuildIndexes();
  return tenants.get(tenantId);
}

/**
 * 删除租户
 */
function deleteTenant(tenantId) {
  if (!tenants.has(tenantId)) throw new Error(`Tenant ${tenantId} not found`);

  // 从 JSON 删除
  const list = readJsonFile().filter(t => t.id !== tenantId);
  writeJsonFile(list);

  // 从内存删除
  tenants.delete(tenantId);
  rebuildIndexes();
}

/**
 * 获取租户的原始 JSON 配置（用于编辑表单）
 */
function getTenantRaw(tenantId) {
  const list = readJsonFile();
  return list.find(t => t.id === tenantId) || null;
}

module.exports = {
  STANDARD_TOOLS,
  loadAll,
  getTenant,
  getAllTenants,
  getByPhone,
  getByUser,
  createTenant,
  updateTenant,
  deleteTenant,
  getTenantRaw,
};
