const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

const RECORDINGS_DIR = path.join(__dirname, "..", "recordings");
const RECORDING_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const recordingSessions = new Map();

/**
 * 文件路径工具
 */
function getRecordingPaths(callSid) {
  return {
    dir: RECORDINGS_DIR,
    callerUlawPath: path.join(RECORDINGS_DIR, `${callSid}.caller.ulaw`),
    assistantUlawPath: path.join(RECORDINGS_DIR, `${callSid}.assistant.ulaw`),
    callerWavPath: path.join(RECORDINGS_DIR, `${callSid}.caller.wav`),
    assistantWavPath: path.join(RECORDINGS_DIR, `${callSid}.assistant.wav`),
    mixedWavPath: path.join(RECORDINGS_DIR, `${callSid}.mixed.wav`),
    mixedMp3Path: path.join(RECORDINGS_DIR, `${callSid}.mixed.mp3`),
    metaPath: path.join(RECORDINGS_DIR, `${callSid}.meta.json`),
  };
}

async function ensureRecordingsDir() {
  await fsp.mkdir(RECORDINGS_DIR, { recursive: true });
}

/**
 * 当前通话录音会话
 */
function ensureRecordingSession(callSid) {
  if (!callSid) return null;

  const existing = recordingSessions.get(callSid);
  if (existing) return existing;

  const paths = getRecordingPaths(callSid);
  const session = {
    callSid,
    ...paths,
    status: "recording", // recording | finalizing | completed | failed | deleted
    startedAt: new Date().toISOString(),
    finalizedAt: null,
    deletedAt: null,
    durationSec: 0,
    error: null,
  };

  recordingSessions.set(callSid, session);
  return session;
}

function getRecordingSession(callSid) {
  return recordingSessions.get(callSid) || null;
}

/**
 * 持久化 metadata
 */
async function writeMeta(callSid, patch = {}) {
  await ensureRecordingsDir();
  const paths = getRecordingPaths(callSid);

  let prev = {};
  try {
    const raw = await fsp.readFile(paths.metaPath, "utf8");
    prev = JSON.parse(raw);
  } catch (_) {}

  const next = {
    callSid,
    ...prev,
    ...patch,
    updatedAt: new Date().toISOString(),
  };

  await fsp.writeFile(paths.metaPath, JSON.stringify(next, null, 2), "utf8");
  return next;
}

async function readMeta(callSid) {
  const paths = getRecordingPaths(callSid);
  try {
    const raw = await fsp.readFile(paths.metaPath, "utf8");
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

/**
 * 判断文件是否存在
 */
async function fileExists(filePath) {
  try {
    await fsp.access(filePath, fs.constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * 追加 caller μ-law 音频
 * Twilio inbound media 常见是 mulaw/8000 base64
 */
async function appendCallerAudio(callSid, base64Audio) {
  if (!callSid || !base64Audio) return;

  await ensureRecordingsDir();
  const session = ensureRecordingSession(callSid);
  const chunk = Buffer.from(base64Audio, "base64");

  await fsp.appendFile(session.callerUlawPath, chunk);

  await writeMeta(callSid, {
    callSid,
    status: "recording",
    startedAt: session.startedAt,
    callerBytes: (await safeStatSize(session.callerUlawPath)) || 0,
  });
}

/**
 * 追加 assistant μ-law 音频
 * 如果你发送给 Twilio 的也是 mulaw/8000 base64，这里可直接复用
 */
async function appendAssistantAudio(callSid, base64Audio) {
  if (!callSid || !base64Audio) return;

  await ensureRecordingsDir();
  const session = ensureRecordingSession(callSid);
  const chunk = Buffer.from(base64Audio, "base64");

  await fsp.appendFile(session.assistantUlawPath, chunk);

  await writeMeta(callSid, {
    callSid,
    status: "recording",
    startedAt: session.startedAt,
    assistantBytes: (await safeStatSize(session.assistantUlawPath)) || 0,
  });
}

async function safeStatSize(filePath) {
  try {
    const st = await fsp.stat(filePath);
    return st.size;
  } catch {
    return 0;
  }
}

/**
 * ffmpeg 执行器
 */
function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (d) => {
      stdout += d.toString();
    });

    proc.stderr.on("data", (d) => {
      stderr += d.toString();
    });

    proc.on("error", (err) => {
      reject(err);
    });

    proc.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(
          new Error(`ffmpeg exited with code ${code}\n${stderr || stdout}`)
        );
      }
    });
  });
}

/**
 * μ-law 转 wav
 */
async function convertUlawToWav(inputPath, outputPath) {
  if (!(await fileExists(inputPath))) {
    throw new Error(`Input ulaw file not found: ${inputPath}`);
  }

  await runFfmpeg([
    "-y",
    "-f",
    "mulaw",
    "-ar",
    "8000",
    "-ac",
    "1",
    "-i",
    inputPath,
    outputPath,
  ]);
}

/**
 * 混音
 */
async function mixWavsToWav(callerWavPath, assistantWavPath, mixedWavPath) {
  const hasCaller = await fileExists(callerWavPath);
  const hasAssistant = await fileExists(assistantWavPath);

  if (!hasCaller && !hasAssistant) {
    throw new Error("No caller or assistant wav exists to mix");
  }

  if (hasCaller && !hasAssistant) {
    await fsp.copyFile(callerWavPath, mixedWavPath);
    return;
  }

  if (!hasCaller && hasAssistant) {
    await fsp.copyFile(assistantWavPath, mixedWavPath);
    return;
  }

  await runFfmpeg([
    "-y",
    "-i",
    callerWavPath,
    "-i",
    assistantWavPath,
    "-filter_complex",
    "amix=inputs=2:duration=longest:dropout_transition=0",
    "-ar",
    "8000",
    "-ac",
    "1",
    mixedWavPath,
  ]);
}

/**
 * wav 转 mp3
 */
async function convertWavToMp3(inputPath, outputPath) {
  if (!(await fileExists(inputPath))) {
    throw new Error(`Mixed wav not found: ${inputPath}`);
  }

  await runFfmpeg([
    "-y",
    "-i",
    inputPath,
    "-codec:a",
    "libmp3lame",
    "-b:a",
    "64k",
    outputPath,
  ]);
}

/**
 * 估算时长（基于 mulaw 8000Hz 单声道，1 byte/sample）
 */
async function estimateDurationSecFromUlaw(filePath) {
  try {
    const st = await fsp.stat(filePath);
    return Math.ceil(st.size / 8000);
  } catch {
    return 0;
  }
}

/**
 * 结束录音并生成 wav/mp3
 */
async function finalizeRecording(callSid) {
  if (!callSid) return null;

  await ensureRecordingsDir();

  const session = ensureRecordingSession(callSid);
  session.status = "finalizing";

  await writeMeta(callSid, {
    status: "finalizing",
    finalizedAt: null,
    deletedAt: null,
    error: null,
  });

  try {
    const hasCallerUlaw = await fileExists(session.callerUlawPath);
    const hasAssistantUlaw = await fileExists(session.assistantUlawPath);

    if (!hasCallerUlaw && !hasAssistantUlaw) {
      throw new Error("No raw recording chunks found");
    }

    if (hasCallerUlaw) {
      await convertUlawToWav(session.callerUlawPath, session.callerWavPath);
    }

    if (hasAssistantUlaw) {
      await convertUlawToWav(
        session.assistantUlawPath,
        session.assistantWavPath
      );
    }

    await mixWavsToWav(
      session.callerWavPath,
      session.assistantWavPath,
      session.mixedWavPath
    );

    await convertWavToMp3(session.mixedWavPath, session.mixedMp3Path);

    const callerDur = await estimateDurationSecFromUlaw(session.callerUlawPath);
    const assistantDur = await estimateDurationSecFromUlaw(
      session.assistantUlawPath
    );
    const durationSec = Math.max(callerDur, assistantDur);

    session.status = "completed";
    session.finalizedAt = new Date().toISOString();
    session.durationSec = durationSec;
    session.error = null;

    await writeMeta(callSid, {
      status: "completed",
      finalizedAt: session.finalizedAt,
      durationSec,
      mixedMp3Path: session.mixedMp3Path,
      mixedWavPath: session.mixedWavPath,
      callerWavPath: session.callerWavPath,
      assistantWavPath: session.assistantWavPath,
      error: null,
    });

    return session;
  } catch (err) {
    session.status = "failed";
    session.error = err.message || String(err);

    await writeMeta(callSid, {
      status: "failed",
      error: session.error,
    });

    throw err;
  }
}

/**
 * 读取录音信息
 * 这里不依赖 liveCalls / 内存 session
 * 只要磁盘有文件，就能返回
 */
async function getRecordingInfo(callSid) {
  if (!callSid) return null;

  await ensureRecordingsDir();

  const paths = getRecordingPaths(callSid);
  const meta = await readMeta(callSid);

  const mp3Exists = await fileExists(paths.mixedMp3Path);
  const mixedWavExists = await fileExists(paths.mixedWavPath);
  const callerWavExists = await fileExists(paths.callerWavPath);
  const assistantWavExists = await fileExists(paths.assistantWavPath);

  if (!meta && !mp3Exists && !mixedWavExists && !callerWavExists && !assistantWavExists) {
    return null;
  }

  const status = meta?.status || (mp3Exists ? "completed" : "recording");
  const finalizedAt = meta?.finalizedAt || null;
  const startedAt = meta?.startedAt || null;
  const deletedAt = meta?.deletedAt || null;
  const durationSec = meta?.durationSec || 0;

  let expiresAt = null;
  if (finalizedAt) {
    expiresAt = new Date(
      new Date(finalizedAt).getTime() + RECORDING_TTL_MS
    ).toISOString();
  }

  return {
    callSid,
    status,
    available: mp3Exists && !deletedAt,
    startedAt,
    finalizedAt,
    deletedAt,
    durationSec,
    expiresAt,
    callerWavExists,
    assistantWavExists,
    mixedWavExists,
    mixedMp3Exists: mp3Exists,
    streamUrl: `/api/live-call/${encodeURIComponent(callSid)}/recording/media`,
    downloadUrl: `/api/live-call/${encodeURIComponent(callSid)}/recording/media?download=1`,
    error: meta?.error || null,
  };
}

/**
 * 播放 mp3，支持 Range
 */
async function streamRecordingMedia(callSid, req, res) {
  if (!callSid) {
    return res.status(400).json({ ok: false, error: "Missing callSid" });
  }

  const paths = getRecordingPaths(callSid);

  try {
    await fsp.access(paths.mixedMp3Path, fs.constants.R_OK);
  } catch {
    return res.status(404).json({ ok: false, error: "Recording not found" });
  }

  const stat = await fsp.stat(paths.mixedMp3Path);
  const fileSize = stat.size;
  const range = req.headers.range;
  const isDownload = req.query.download === "1";

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=60");
  if (isDownload) {
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${callSid}.mixed.mp3"`
    );
  }

  if (!range) {
    res.setHeader("Content-Length", fileSize);
    const stream = fs.createReadStream(paths.mixedMp3Path);
    stream.on("error", (err) => {
      if (!res.headersSent) {
        res.status(500).end(err.message || "Stream error");
      } else {
        res.destroy(err);
      }
    });
    return stream.pipe(res);
  }

  const match = /bytes=(\d*)-(\d*)/.exec(range);
  if (!match) {
    return res.status(416).end();
  }

  let start = match[1] ? parseInt(match[1], 10) : 0;
  let end = match[2] ? parseInt(match[2], 10) : fileSize - 1;

  if (Number.isNaN(start)) start = 0;
  if (Number.isNaN(end)) end = fileSize - 1;

  if (start >= fileSize || end >= fileSize || start > end) {
    res.setHeader("Content-Range", `bytes */${fileSize}`);
    return res.status(416).end();
  }

  const chunkSize = end - start + 1;
  res.status(206);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
  res.setHeader("Content-Length", chunkSize);

  const stream = fs.createReadStream(paths.mixedMp3Path, { start, end });
  stream.on("error", (err) => {
    if (!res.headersSent) {
      res.status(500).end(err.message || "Stream error");
    } else {
      res.destroy(err);
    }
  });

  return stream.pipe(res);
}

/**
 * 删除过期录音
 */
async function cleanupExpiredRecordings() {
  await ensureRecordingsDir();

  const files = await fsp.readdir(RECORDINGS_DIR);
  const now = Date.now();

  for (const file of files) {
    if (!file.endsWith(".meta.json")) continue;

    const metaPath = path.join(RECORDINGS_DIR, file);

    try {
      const raw = await fsp.readFile(metaPath, "utf8");
      const meta = JSON.parse(raw);

      if (!meta.finalizedAt) continue;

      const finalizedAtMs = new Date(meta.finalizedAt).getTime();
      if (!Number.isFinite(finalizedAtMs)) continue;

      if (now - finalizedAtMs < RECORDING_TTL_MS) continue;

      const callSid = meta.callSid;
      if (!callSid) continue;

      const paths = getRecordingPaths(callSid);

      const allFiles = [
        paths.callerUlawPath,
        paths.assistantUlawPath,
        paths.callerWavPath,
        paths.assistantWavPath,
        paths.mixedWavPath,
        paths.mixedMp3Path,
        paths.metaPath,
      ];

      for (const p of allFiles) {
        try {
          await fsp.unlink(p);
        } catch (_) {}
      }

      const session = recordingSessions.get(callSid);
      if (session) {
        session.status = "deleted";
        session.deletedAt = new Date().toISOString();
      }
    } catch (_) {}
  }
}

module.exports = {
  RECORDINGS_DIR,
  ensureRecordingsDir,
  ensureRecordingSession,
  getRecordingSession,
  appendCallerAudio,
  appendAssistantAudio,
  finalizeRecording,
  getRecordingInfo,
  streamRecordingMedia,
  cleanupExpiredRecordings,
};
