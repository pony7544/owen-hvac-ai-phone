const fs = require("fs");
const fsp = require("fs/promises");
const path = require("path");
const { spawn } = require("child_process");

function createRecordingService({
  recordingsDir,
  retentionDays = 90,
  getOrCreateCallSession,
  liveCalls,
  sampleRate = 8000,
  ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg",
  mp3Bitrate = process.env.RECORDING_MP3_BITRATE || "32k",
}) {
  fs.mkdirSync(recordingsDir, { recursive: true });

  function addDaysIso(dateLike, days) {
    const d = new Date(dateLike || Date.now());
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString();
  }

  function mulawByteToPcm16(muLawByte) {
    muLawByte = ~muLawByte & 0xff;

    const sign = muLawByte & 0x80;
    const exponent = (muLawByte >> 4) & 0x07;
    const mantissa = muLawByte & 0x0f;

    let sample = ((mantissa << 3) + 0x84) << exponent;
    sample -= 0x84;

    return sign ? -sample : sample;
  }

  function decodeMulawBufferToPcm16Buffer(muLawBuffer) {
    const out = Buffer.alloc(muLawBuffer.length * 2);
    for (let i = 0; i < muLawBuffer.length; i++) {
      const pcm = mulawByteToPcm16(muLawBuffer[i]);
      out.writeInt16LE(pcm, i * 2);
    }
    return out;
  }

  function mixPcm16MonoBuffers(bufA, bufB) {
    const samplesA = Math.floor(bufA.length / 2);
    const samplesB = Math.floor(bufB.length / 2);
    const maxSamples = Math.max(samplesA, samplesB);

    const out = Buffer.alloc(maxSamples * 2);

    for (let i = 0; i < maxSamples; i++) {
      const a = i < samplesA ? bufA.readInt16LE(i * 2) : 0;
      const b = i < samplesB ? bufB.readInt16LE(i * 2) : 0;

      let mixed = a + b;

      if (mixed > 32767) mixed = 32767;
      if (mixed < -32768) mixed = -32768;

      out.writeInt16LE(mixed, i * 2);
    }

    return out;
  }

  function buildWavHeader(
    dataLength,
    wavSampleRate = 8000,
    channels = 1,
    bitsPerSample = 16
  ) {
    const byteRate = (wavSampleRate * channels * bitsPerSample) / 8;
    const blockAlign = (channels * bitsPerSample) / 8;
    const buffer = Buffer.alloc(44);

    buffer.write("RIFF", 0);
    buffer.writeUInt32LE(36 + dataLength, 4);
    buffer.write("WAVE", 8);
    buffer.write("fmt ", 12);
    buffer.writeUInt32LE(16, 16);
    buffer.writeUInt16LE(1, 20);
    buffer.writeUInt16LE(channels, 22);
    buffer.writeUInt32LE(wavSampleRate, 24);
    buffer.writeUInt32LE(byteRate, 28);
    buffer.writeUInt16LE(blockAlign, 32);
    buffer.writeUInt16LE(bitsPerSample, 34);
    buffer.write("data", 36);
    buffer.writeUInt32LE(dataLength, 40);

    return buffer;
  }

  async function writeWavFile(filePath, pcm16Buffer) {
    const header = buildWavHeader(pcm16Buffer.length, sampleRate, 1, 16);
    await fsp.writeFile(filePath, Buffer.concat([header, pcm16Buffer]));
  }

  function pcmStats(pcmBuf) {
    const samples = Math.floor(pcmBuf.length / 2);
    if (!samples) {
      return { samples: 0, peak: 0, rms: 0, nonZero: 0, nonZeroPct: 0 };
    }

    let peak = 0;
    let sumSq = 0;
    let nonZero = 0;

    for (let i = 0; i < samples; i++) {
      const v = pcmBuf.readInt16LE(i * 2);
      const a = Math.abs(v);
      if (a > peak) peak = a;
      if (a > 500) nonZero++;
      sumSq += v * v;
    }

    return {
      samples,
      peak,
      rms: Math.round(Math.sqrt(sumSq / samples)),
      nonZero,
      nonZeroPct: Math.round((nonZero / samples) * 10000) / 100,
    };
  }

  function runFfmpeg(args) {
    return new Promise((resolve, reject) => {
      const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

      let stderr = "";
      let stdout = "";

      child.stdout.on("data", (chunk) => {
        stdout += chunk.toString();
      });

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
      });

      child.on("error", (err) => {
        reject(err);
      });

      child.on("close", (code) => {
        if (code === 0) {
          resolve({ stdout, stderr });
        } else {
          reject(
            new Error(
              `ffmpeg exited with code ${code}. ${stderr || stdout || ""}`.trim()
            )
          );
        }
      });
    });
  }

  async function convertWavToMp3(wavPath, mp3Path) {
    await runFfmpeg([
      "-y",
      "-i",
      wavPath,
      "-codec:a",
      "libmp3lame",
      "-b:a",
      mp3Bitrate,
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      mp3Path,
    ]);
  }

  function ensureRecordingSession(callSid) {
    const sessionObj = getOrCreateCallSession(callSid);

    if (!sessionObj.recording) {
      const safeBaseName = String(callSid).replace(/[^a-zA-Z0-9._-]/g, "_");

      sessionObj.recording = {
        status: "recording",
        available: false,
        createdAt: new Date().toISOString(),
        completedAt: "",
        expiresAt: addDaysIso(new Date(), retentionDays),
        deletedAt: "",
        durationSec: 0,
        fileName: `${safeBaseName}.mixed.mp3`,

        callerChunks: [],
        assistantChunks: [],

        callerMulawPath: path.join(recordingsDir, `${safeBaseName}.caller.ulaw`),
        assistantMulawPath: path.join(recordingsDir, `${safeBaseName}.assistant.ulaw`),

        callerWavPath: path.join(recordingsDir, `${safeBaseName}.caller.wav`),
        assistantWavPath: path.join(recordingsDir, `${safeBaseName}.assistant.wav`),
        mixedWavPath: path.join(recordingsDir, `${safeBaseName}.mixed.wav`),
        mixedMp3Path: path.join(recordingsDir, `${safeBaseName}.mixed.mp3`),
      };
    }

    return sessionObj.recording;
  }

  async function appendCallerAudio(callSid, base64Payload) {
    if (!callSid || !base64Payload) return;
    const rec = ensureRecordingSession(callSid);
    rec.callerChunks.push(Buffer.from(base64Payload, "base64"));
  }

  async function appendAssistantAudio(callSid, base64Payload) {
    if (!callSid || !base64Payload) return;
    const rec = ensureRecordingSession(callSid);
    rec.assistantChunks.push(Buffer.from(base64Payload, "base64"));
  }

  async function safeUnlink(filePath) {
    if (!filePath) return;
    try {
      await fsp.unlink(filePath);
    } catch (err) {
      if (err.code !== "ENOENT") throw err;
    }
  }

  async function finalizeRecording(callSid) {
    if (!callSid) return null;

    const sessionObj = getOrCreateCallSession(callSid);
    const rec = sessionObj.recording;

    if (!rec) return null;
    if (rec.available && rec.mixedMp3Path) return rec;
    if (rec.finalizing) return rec;

    rec.finalizing = true;
    rec.status = "finalizing";

    try {
      const callerMulaw = Buffer.concat(rec.callerChunks || []);
      const assistantMulaw = Buffer.concat(rec.assistantChunks || []);

      console.log("REC SIZE DEBUG raw", {
        callSid,
        callerMulawBytes: callerMulaw.length,
        assistantMulawBytes: assistantMulaw.length,
        callerSecApprox: Math.round((callerMulaw.length / sampleRate) * 100) / 100,
        assistantSecApprox:
          Math.round((assistantMulaw.length / sampleRate) * 100) / 100,
      });

      await fsp.writeFile(rec.callerMulawPath, callerMulaw);
      await fsp.writeFile(rec.assistantMulawPath, assistantMulaw);

      const callerPcm = decodeMulawBufferToPcm16Buffer(callerMulaw);
      const assistantPcm = decodeMulawBufferToPcm16Buffer(assistantMulaw);
      const mixedPcm = mixPcm16MonoBuffers(callerPcm, assistantPcm);

      console.log("PCM ENERGY DEBUG", {
        callSid,
        caller: pcmStats(callerPcm),
        assistant: pcmStats(assistantPcm),
      });

      console.log("REC SIZE DEBUG pcm", {
        callSid,
        callerPcmBytes: callerPcm.length,
        assistantPcmBytes: assistantPcm.length,
        mixedPcmBytes: mixedPcm.length,
        mixedSecApprox:
          Math.round(((mixedPcm.length / 2 / sampleRate) * 100)) / 100,
      });

      await writeWavFile(rec.callerWavPath, callerPcm);
      await writeWavFile(rec.assistantWavPath, assistantPcm);
      await writeWavFile(rec.mixedWavPath, mixedPcm);

      await convertWavToMp3(rec.mixedWavPath, rec.mixedMp3Path);

      const mixedWavStat = await fsp.stat(rec.mixedWavPath);
      const mixedMp3Stat = await fsp.stat(rec.mixedMp3Path);

      console.log("REC FILE DEBUG", {
        callSid,
        mixedWavBytes: mixedWavStat.size,
        mixedMp3Bytes: mixedMp3Stat.size,
      });

      rec.durationSec =
        Math.round(((mixedPcm.length / 2 / sampleRate) * 100)) / 100;
      rec.available = true;
      rec.status = "completed";
      rec.completedAt = new Date().toISOString();

      rec.callerChunks = [];
      rec.assistantChunks = [];

      // 先保留诊断文件，确认问题后再改回删除
      // await safeUnlink(rec.callerMulawPath);
      // await safeUnlink(rec.assistantMulawPath);
      // await safeUnlink(rec.callerWavPath);
      // await safeUnlink(rec.assistantWavPath);
      // await safeUnlink(rec.mixedWavPath);

      sessionObj.updatedAt = new Date().toISOString();
      return rec;
    } catch (err) {
      rec.status = "failed";
      rec.error = err.message || "Failed to finalize recording";
      sessionObj.updatedAt = new Date().toISOString();
      throw err;
    } finally {
      rec.finalizing = false;
    }
  }

  function getRecordingMeta(callSid) {
    const sessionObj = liveCalls.get(callSid);
    const rec = sessionObj?.recording;

    return {
      callSid,
      recording: rec
        ? {
            available: !!rec.available && !rec.deletedAt,
            status: rec.status || "unknown",
            durationSec: rec.durationSec || 0,
            createdAt: rec.createdAt || "",
            completedAt: rec.completedAt || "",
            expiresAt: rec.expiresAt || "",
            deletedAt: rec.deletedAt || "",
            fileName: rec.fileName || "",
            streamUrl:
              rec.available && !rec.deletedAt
                ? `/api/live-call/${encodeURIComponent(callSid)}/recording/media`
                : "",
          }
        : {
            available: false,
            status: "not-started",
            durationSec: 0,
            createdAt: "",
            completedAt: "",
            expiresAt: "",
            deletedAt: "",
            fileName: "",
            streamUrl: "",
          },
    };
  }

 async function streamRecordingMedia(callSid, req, res) {
  const sessionObj = liveCalls.get(callSid);

  if (!sessionObj) {
    return res.status(404).json({ ok: false, error: "Call not found" });
  }

  const rec = sessionObj.recording;
  if (!rec?.mixedMp3Path || rec.deletedAt) {
    return res.status(404).json({ ok: false, error: "Recording not available" });
  }

  await fsp.access(rec.mixedMp3Path, fs.constants.R_OK);
  const stat = await fsp.stat(rec.mixedMp3Path);
  const fileSize = stat.size;
  const range = req.headers.range;

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Cache-Control", "private, max-age=60");

  if (range) {
    const parts = range.replace(/bytes=/, "").split("-");
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

    if (Number.isNaN(start) || Number.isNaN(end) || start > end || end >= fileSize) {
      res.status(416).setHeader("Content-Range", `bytes */${fileSize}`);
      return res.end();
    }

    const chunkSize = end - start + 1;
    res.status(206);
    res.setHeader("Content-Range", `bytes ${start}-${end}/${fileSize}`);
    res.setHeader("Content-Length", chunkSize);

    return fs.createReadStream(rec.mixedMp3Path, { start, end }).pipe(res);
  }

  res.setHeader("Content-Length", fileSize);
  return fs.createReadStream(rec.mixedMp3Path).pipe(res);
}

  async function deleteRecordingFiles(rec) {
    const paths = [
      rec?.callerMulawPath,
      rec?.assistantMulawPath,
      rec?.callerWavPath,
      rec?.assistantWavPath,
      rec?.mixedWavPath,
      rec?.mixedMp3Path,
    ].filter(Boolean);

    for (const p of paths) {
      try {
        await fsp.unlink(p);
      } catch (err) {
        if (err.code !== "ENOENT") {
          console.error("delete recording file error:", p, err?.message || err);
        }
      }
    }
  }

  async function deleteRecordingIfExpired(sessionObj) {
    const rec = sessionObj?.recording;
    if (!rec || rec.deletedAt) return false;

    const expiresAt = rec.expiresAt ? new Date(rec.expiresAt).getTime() : 0;
    if (!expiresAt || Date.now() < expiresAt) return false;

    await deleteRecordingFiles(rec);

    rec.deletedAt = new Date().toISOString();
    rec.available = false;
    rec.status = "deleted";
    sessionObj.updatedAt = new Date().toISOString();
    return true;
  }

  async function cleanupExpiredRecordings() {
    const calls = Array.from(liveCalls.values());
    for (const sessionObj of calls) {
      try {
        await deleteRecordingIfExpired(sessionObj);
      } catch (err) {
        console.error(
          `cleanup recording failed for ${sessionObj.callSid}:`,
          err?.message || err
        );
      }
    }
  }

  return {
    ensureRecordingSession,
    appendCallerAudio,
    appendAssistantAudio,
    finalizeRecording,
    getRecordingMeta,
    streamRecordingMedia,
    cleanupExpiredRecordings,
  };
}

module.exports = { createRecordingService };
