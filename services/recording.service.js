// =============================================================
// services/recording.service.js
// g711 μ-law → PCM16 解码 + 双声道 WAV 合成
//
// Twilio Media Streams 和 OpenAI Realtime 都使用 g711_ulaw，
// 每帧是 base64 编码的 μ-law 字节，采样率 8000Hz，每包 ~160 样本（20ms）
// =============================================================

// ─── μ-law 解码查找表（ITU-T G.711）──────────
// μ-law byte → 14-bit linear PCM，然后左移 2 位得到 16-bit PCM
const ULAW_TO_LINEAR = (() => {
  const table = new Int16Array(256);
  for (let i = 0; i < 256; i++) {
    let u = ~i & 0xFF;
    const sign  = u & 0x80;
    const exp   = (u >> 4) & 0x07;
    const mant  = u & 0x0F;
    let sample  = ((mant << 3) + 0x84) << exp;
    sample     -= 0x84;
    table[i]    = sign ? -sample : sample;
  }
  return table;
})();

/**
 * 把单个 base64 g711_ulaw 帧解码为 Int16Array PCM 样本
 */
function decodeG711UlawFrame(base64Payload) {
  const bytes  = Buffer.from(base64Payload, "base64");
  const pcm    = new Int16Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    pcm[i] = ULAW_TO_LINEAR[bytes[i]];
  }
  return pcm;
}

/**
 * 把帧数组合并为一段连续 PCM 样本
 */
function framesToPCM(frames) {
  if (!frames || frames.length === 0) return new Int16Array(0);
  const parts = frames.map(decodeG711UlawFrame);
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out   = new Int16Array(total);
  let offset  = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/**
 * 写入 WAV 文件头
 * @param {Buffer} buf       目标 Buffer（需足够大）
 * @param {number} offset    写入起始偏移
 * @param {number} channels  声道数（1 或 2）
 * @param {number} sampleRate 采样率（Hz）
 * @param {number} numSamples 总样本数（每声道）
 */
function writeWavHeader(buf, offset, channels, sampleRate, numSamples) {
  const bitsPerSample = 16;
  const byteRate      = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign    = channels * (bitsPerSample / 8);
  const dataSize      = numSamples * channels * (bitsPerSample / 8);
  const chunkSize     = 36 + dataSize;

  buf.write("RIFF",           offset);      offset += 4;
  buf.writeUInt32LE(chunkSize, offset);     offset += 4;
  buf.write("WAVE",           offset);      offset += 4;
  buf.write("fmt ",           offset);      offset += 4;
  buf.writeUInt32LE(16,        offset);     offset += 4;  // PCM chunk size
  buf.writeUInt16LE(1,         offset);     offset += 2;  // PCM format
  buf.writeUInt16LE(channels,  offset);     offset += 2;
  buf.writeUInt32LE(sampleRate,offset);     offset += 4;
  buf.writeUInt32LE(byteRate,  offset);     offset += 4;
  buf.writeUInt16LE(blockAlign,offset);     offset += 2;
  buf.writeUInt16LE(bitsPerSample, offset); offset += 2;
  buf.write("data",            offset);     offset += 4;
  buf.writeUInt32LE(dataSize,  offset);
}

/**
 * 合成双声道 WAV（或单声道）
 *
 * @param {string[]} callerFrames     来电者 g711_ulaw base64 帧数组（左声道）
 * @param {string[]} assistantFrames  AI 助手 g711_ulaw base64 帧数组（右声道）
 * @param {boolean}  monoOnly         true = 只输出有帧的那一侧作为单声道
 * @returns {Buffer}  完整 WAV 文件 Buffer
 */
function buildWav(callerFrames, assistantFrames, monoOnly = false) {
  const SAMPLE_RATE = 8000;

  const callerPCM    = framesToPCM(callerFrames);
  const assistantPCM = framesToPCM(assistantFrames);

  if (monoOnly) {
    // 单声道：取非空的那一侧
    const pcm = callerPCM.length ? callerPCM : assistantPCM;
    const numSamples = pcm.length;
    const headerSize = 44;
    const dataSize   = numSamples * 2;         // 2 bytes / sample (16-bit)
    const buf        = Buffer.allocUnsafe(headerSize + dataSize);

    writeWavHeader(buf, 0, 1, SAMPLE_RATE, numSamples);

    let pos = headerSize;
    for (let i = 0; i < numSamples; i++) {
      buf.writeInt16LE(pcm[i], pos);
      pos += 2;
    }
    return buf;
  }

  // ─── 双声道交织（L=caller, R=assistant）────
  // 两侧长度可能不等，以最长者为准，短的补 0
  const numSamples = Math.max(callerPCM.length, assistantPCM.length);
  const headerSize = 44;
  const dataSize   = numSamples * 2 * 2;       // 2 ch × 2 bytes/sample
  const buf        = Buffer.allocUnsafe(headerSize + dataSize);

  writeWavHeader(buf, 0, 2, SAMPLE_RATE, numSamples);

  let pos = headerSize;
  for (let i = 0; i < numSamples; i++) {
    const l = i < callerPCM.length    ? callerPCM[i]    : 0;
    const r = i < assistantPCM.length ? assistantPCM[i] : 0;
    buf.writeInt16LE(l, pos);     pos += 2;   // L = caller
    buf.writeInt16LE(r, pos);     pos += 2;   // R = assistant
  }
  return buf;
}

module.exports = { decodeG711UlawFrame, buildWav };
