// =============================================================
// services/recording.service.js
// g711 μ-law → PCM16 解码 + 时间轴对齐双声道 WAV 合成
//
// Twilio Media Streams 和 OpenAI Realtime 都使用 g711_ulaw，
// 每帧是 base64 编码的 μ-law 字节，采样率 8000Hz，每包 ~160 样本（20ms）
//
// ★ 关键设计：使用 TimelineRecorder 统一时间轴记录双声道音频。
//   Twilio 的 caller 音频流是连续的（每 20ms 一包），作为时钟基准。
//   Assistant 音频只在 AI 说话时才有帧，空闲时用静音填充。
//   这样合成出的 WAV 文件中两个声道在时间上完全对齐，
//   播放时能听到正确的一问一答节奏。
// =============================================================

// ─── μ-law 解码查找表（ITU-T G.711）──────────
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

// ─── 160 样本的静音帧（20ms @ 8kHz）──────────
const SILENCE_FRAME = new Int16Array(160);

/**
 * 把帧数组合并为一段连续 PCM 样本
 * 帧可以是 base64 字符串或 null（静音）
 */
function framesToPCM(frames) {
  if (!frames || frames.length === 0) return new Int16Array(0);
  const parts = frames.map(f =>
    f === null ? SILENCE_FRAME : decodeG711UlawFrame(f)
  );
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
  buf.writeUInt32LE(16,        offset);     offset += 4;
  buf.writeUInt16LE(1,         offset);     offset += 2;
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
 * callerFrames 和 assistantFrames 是时间轴对齐的数组，
 * 每个 slot 要么是 base64 帧，要么是 null（静音）。
 *
 * @param {(string|null)[]} callerFrames     时间轴对齐的来电者帧
 * @param {(string|null)[]} assistantFrames  时间轴对齐的 AI 帧
 * @param {boolean}  monoOnly               true = 只输出指定侧作为单声道
 * @returns {Buffer}  完整 WAV 文件 Buffer
 */
function buildWav(callerFrames, assistantFrames, monoOnly = false) {
  const SAMPLE_RATE = 8000;

  const callerPCM    = framesToPCM(callerFrames);
  const assistantPCM = framesToPCM(assistantFrames);

  if (monoOnly) {
    const pcm = callerPCM.length ? callerPCM : assistantPCM;
    const numSamples = pcm.length;
    const headerSize = 44;
    const dataSize   = numSamples * 2;
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
  const numSamples = Math.max(callerPCM.length, assistantPCM.length);
  const headerSize = 44;
  const dataSize   = numSamples * 2 * 2;
  const buf        = Buffer.allocUnsafe(headerSize + dataSize);

  writeWavHeader(buf, 0, 2, SAMPLE_RATE, numSamples);

  let pos = headerSize;
  for (let i = 0; i < numSamples; i++) {
    const l = i < callerPCM.length    ? callerPCM[i]    : 0;
    const r = i < assistantPCM.length ? assistantPCM[i] : 0;
    buf.writeInt16LE(l, pos);     pos += 2;
    buf.writeInt16LE(r, pos);     pos += 2;
  }
  return buf;
}

// =============================================================
// TimelineRecorder — 统一时间轴录音器
//
// 核心思路：
//   Twilio 每 ~20ms 发一个 media 包，这是连续不间断的时钟源。
//   每次 pushCaller() 调用都推进时间轴一个 slot（20ms）。
//   Assistant 帧在 AI 说话时才有，先存入队列，
//   由 caller 的时钟 tick 按顺序取出并对齐到同一 slot。
//   AI 不说话时，assistant 那一侧自动填 null（静音）。
//
// 用法：
//   const recorder = new TimelineRecorder();
//   // Twilio media event:
//   recorder.pushCaller(base64Payload);
//   // OpenAI response.audio.delta:
//   recorder.pushAssistant(base64Payload);
//   // 通话结束：
//   const { callerFrames, assistantFrames } = recorder.finalize();
// =============================================================
class TimelineRecorder {
  constructor() {
    this._callerSlots    = [];   // (string | null)[]
    this._assistantSlots = [];   // (string | null)[]
    this._assistantQueue = [];   // string[] — 待对齐的 AI 帧
  }

  /**
   * 推入一个 caller 帧（Twilio media event 驱动，每 ~20ms 一次）
   * 这是时钟基准——每次调用推进时间轴一个 slot
   */
  pushCaller(base64Payload) {
    this._callerSlots.push(base64Payload);

    // 从 assistant 队列取一个帧对齐到同一 slot
    if (this._assistantQueue.length > 0) {
      this._assistantSlots.push(this._assistantQueue.shift());
    } else {
      this._assistantSlots.push(null);  // AI 此刻没在说话
    }
  }

  /**
   * 推入一个 assistant 帧（OpenAI response.audio.delta 驱动）
   * 先进队列，等 caller tick 时对齐到时间轴
   */
  pushAssistant(base64Payload) {
    this._assistantQueue.push(base64Payload);
  }

  /**
   * 通话结束，取出对齐好的双声道帧数组。
   * 如果 assistant 队列还有剩余帧（通话在 AI 说话时结束），
   * 追加到时间轴末尾，caller 侧补 null（静音）。
   */
  finalize() {
    while (this._assistantQueue.length > 0) {
      this._callerSlots.push(null);
      this._assistantSlots.push(this._assistantQueue.shift());
    }

    return {
      callerFrames:    this._callerSlots,
      assistantFrames: this._assistantSlots,
    };
  }
}

module.exports = { decodeG711UlawFrame, buildWav, TimelineRecorder };
