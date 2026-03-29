// =============================================================
// migrate-tenants.js - 数据迁移脚本
// 为现有 tenants 添加营业时间、服务类型和 API Key 配置
// =============================================================

require("dotenv").config();
const { connectDB, Tenant } = require("./models");

// 默认营业时间配置（周一到周五 9:00-17:00）
const defaultBusinessHours = {
  monday: { enabled: true, open: "09:00", close: "17:00" },
  tuesday: { enabled: true, open: "09:00", close: "17:00" },
  wednesday: { enabled: true, open: "09:00", close: "17:00" },
  thursday: { enabled: true, open: "09:00", close: "17:00" },
  friday: { enabled: true, open: "09:00", close: "17:00" },
  saturday: { enabled: false, open: "10:00", close: "14:00" },
  sunday: { enabled: false, open: "10:00", close: "14:00" }
};

// 默认服务类型（标准服务，60分钟）
const defaultServiceTypes = [{
  id: "standard",
  name: "标准服务",
  nameEn: "Standard Service",
  duration: 60,
  description: "Standard appointment",
  price: 0,
  enabled: true
}];

async function migrate() {
  try {
    await connectDB();
    console.log("\n[Migrate] Starting tenant migration...\n");

    // 查找所有没有 businessHours 配置的 tenants
    const tenantsToUpdate = await Tenant.find({
      $or: [
        { businessHours: { $exists: false } },
        { serviceTypes: { $exists: false } },
        { slotInterval: { $exists: false } },
        { apiKey: { $exists: false } }
      ]
    });

    console.log(`[Migrate] Found ${tenantsToUpdate.length} tenant(s) to update\n`);

    if (tenantsToUpdate.length === 0) {
      console.log("[Migrate] No tenants need migration. All up to date!");
      process.exit(0);
    }

    let updatedCount = 0;

    for (const tenant of tenantsToUpdate) {
      console.log(`[Migrate] Updating tenant: ${tenant.id} (${tenant.businessName || 'N/A'})`);
      
      const updates = {};
      
      // 添加营业时间（如果不存在）
      if (!tenant.businessHours) {
        updates.businessHours = defaultBusinessHours;
        console.log(`  ✓ Added businessHours`);
      }
      
      // 添加服务类型（如果不存在）
      if (!tenant.serviceTypes || tenant.serviceTypes.length === 0) {
        updates.serviceTypes = defaultServiceTypes;
        console.log(`  ✓ Added serviceTypes`);
      }
      
      // 添加时间槽间隔（如果不存在）
      if (!tenant.slotInterval) {
        updates.slotInterval = 30;
        console.log(`  ✓ Added slotInterval: 30`);
      }
      
      // 添加 API Key（如果不存在）
      if (!tenant.apiKey) {
        const crypto = require('crypto');
        updates.apiKey = crypto.randomBytes(32).toString('hex');
        console.log(`  ✓ Added apiKey: ${updates.apiKey.substring(0, 8)}...`);
      }
      
      // 应用更新
      if (Object.keys(updates).length > 0) {
        await Tenant.updateOne(
          { id: tenant.id },
          { $set: updates }
        );
        updatedCount++;
        console.log(`  ✅ Updated successfully\n`);
      } else {
        console.log(`  ⏭️  No updates needed\n`);
      }
    }

    console.log("=".repeat(60));
    console.log(`[Migrate] Migration completed!`);
    console.log(`  Total tenants checked: ${tenantsToUpdate.length}`);
    console.log(`  Tenants updated: ${updatedCount}`);
    console.log("=".repeat(60));
    console.log("\n✅ You can now restart your server to use the new features.\n");

    process.exit(0);
  } catch (err) {
    console.error("\n❌ Migration failed:", err);
    console.error(err.stack);
    process.exit(1);
  }
}

// 运行迁移
migrate();
