// =============================================================
// services/r2.service.js — Cloudflare R2 对象存储服务
// 使用 S3 兼容 API，录音文件 2 天后从 MongoDB 迁移到 R2
// =============================================================

let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand;
try {
  const s3 = require("@aws-sdk/client-s3");
  S3Client = s3.S3Client;
  PutObjectCommand = s3.PutObjectCommand;
  GetObjectCommand = s3.GetObjectCommand;
  DeleteObjectCommand = s3.DeleteObjectCommand;
} catch (err) {
  console.warn("[R2] @aws-sdk/client-s3 not installed — R2 storage disabled. Run: npm install @aws-sdk/client-s3");
}

let s3Client = null;
let bucketName = "";
let r2Enabled = false;

/**
 * 初始化 R2 客户端
 * 需要环境变量：R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_BUCKET_NAME
 */
function initR2() {
  if (!S3Client) {
    console.log("[R2] SDK not available — skipping R2 init");
    return false;
  }

  const accountId = process.env.R2_ACCOUNT_ID;
  const accessKeyId = process.env.R2_ACCESS_KEY_ID;
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
  bucketName = process.env.R2_BUCKET_NAME || "phone-recordings";

  if (!accountId || !accessKeyId || !secretAccessKey) {
    console.log("[R2] Not configured — recordings will stay in MongoDB only");
    return false;
  }

  s3Client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: { accessKeyId, secretAccessKey },
  });

  r2Enabled = true;
  console.log(`[R2] Initialized — bucket: ${bucketName}`);
  return true;
}

/**
 * 上传 WAV 录音到 R2
 * @param {string} callSid
 * @param {Buffer} wavBuffer
 * @param {object} metadata - 额外元数据 (tenantId, durationSec 等)
 * @returns {string} R2 对象 key
 */
async function uploadRecording(callSid, wavBuffer, metadata = {}) {
  if (!r2Enabled || !s3Client) throw new Error("R2 not configured");

  const key = `recordings/${metadata.tenantId || "unknown"}/${callSid}.wav`;

  await s3Client.send(new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    Body: wavBuffer,
    ContentType: "audio/wav",
    Metadata: {
      callsid: callSid,
      tenantid: metadata.tenantId || "",
      durationsec: String(metadata.durationSec || 0),
      createdat: metadata.createdAt || new Date().toISOString(),
    },
  }));

  console.log(`[R2] Uploaded ${key} (${(wavBuffer.length / 1024 / 1024).toFixed(2)} MB)`);
  return key;
}

/**
 * 从 R2 下载 WAV 录音
 * @param {string} r2Key
 * @returns {Buffer} WAV 文件内容
 */
async function downloadRecording(r2Key) {
  if (!r2Enabled || !s3Client) throw new Error("R2 not configured");

  const response = await s3Client.send(new GetObjectCommand({
    Bucket: bucketName,
    Key: r2Key,
  }));

  // 流转 Buffer
  const chunks = [];
  for await (const chunk of response.Body) {
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  console.log(`[R2] Downloaded ${r2Key} (${(buffer.length / 1024 / 1024).toFixed(2)} MB)`);
  return buffer;
}

/**
 * 从 R2 删除录音
 * @param {string} r2Key
 */
async function deleteRecording(r2Key) {
  if (!r2Enabled || !s3Client) return;

  await s3Client.send(new DeleteObjectCommand({
    Bucket: bucketName,
    Key: r2Key,
  }));
  console.log(`[R2] Deleted ${r2Key}`);
}

function isR2Enabled() {
  return r2Enabled;
}

module.exports = { initR2, isR2Enabled, uploadRecording, downloadRecording, deleteRecording };
