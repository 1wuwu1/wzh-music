/**
 * K 歌实时特征分析与演唱评分。
 *
 * 当前酷狗伴奏接口不保证提供逐音高参考旋律，因此这里的“音准”是
 * 麦克风基频的清晰度与稳定度，而不是与标准旋律逐音比较后的绝对准确度。
 * 后续拿到 MIDI/音高曲线时，只需在 analyzeLine 中加入参考音高误差即可。
 */

const HISTORY_KEY = 'vmp.karaoke.history.v1';
const MAX_HISTORY = 40;

export const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

function median(values) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function percentile(values, p) {
  if (!values.length) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = clamp(Math.round((sorted.length - 1) * p), 0, sorted.length - 1);
  return sorted[index];
}

function toDb(rms) {
  return rms > 0 ? 20 * Math.log10(rms) : -100;
}

function midiFromHz(hz) {
  return hz > 0 ? 69 + 12 * Math.log2(hz / 440) : 0;
}

export function noteName(hz) {
  if (!Number.isFinite(hz) || hz <= 0) return '--';
  const names = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const midi = Math.round(midiFromHz(hz));
  return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/**
 * 自相关基频检测。输入必须为 [-1, 1] 左右的单声道时域采样。
 * 返回基础频率、清晰度和 RMS；无法判断时频率为 0。
 */
export function detectPitch(samples, sampleRate) {
  let mean = 0;
  for (let i = 0; i < samples.length; i++) mean += samples[i];
  mean /= samples.length || 1;

  let energy = 0;
  for (let i = 0; i < samples.length; i++) {
    const x = samples[i] - mean;
    energy += x * x;
  }
  const rms = Math.sqrt(energy / Math.max(1, samples.length));
  if (rms < 0.003) return { hz: 0, clarity: 0, rms };

  const minLag = Math.max(2, Math.floor(sampleRate / 1200));
  const maxLag = Math.min(Math.floor(sampleRate / 70), Math.floor(samples.length / 2));
  let bestLag = 0;
  let bestCorrelation = 0;
  let normalizedEnergy = 0;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let correlation = 0;
    for (let i = 0; i < samples.length - lag; i++) {
      correlation += (samples[i] - mean) * (samples[i + lag] - mean);
    }
    if (correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestLag = lag;
    }
  }
  normalizedEnergy = energy || 1;
  const clarity = clamp(bestCorrelation / normalizedEnergy, 0, 1);
  return {
    hz: bestLag ? sampleRate / bestLag : 0,
    clarity,
    rms,
  };
}

function findLineIndex(lines, time) {
  let lo = 0;
  let hi = lines.length - 1;
  let answer = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (lines[mid].time <= time) {
      answer = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return answer;
}

function gradeFor(score) {
  if (score >= 92) return 'SSS';
  if (score >= 86) return 'SS';
  if (score >= 80) return 'S';
  if (score >= 72) return 'A';
  if (score >= 64) return 'B';
  if (score >= 50) return 'C';
  return 'D';
}

export class PerformanceAnalyzer {
  constructor(lines = []) {
    this.lines = lines
      .filter((line) => Number.isFinite(line?.time))
      .map((line) => ({ time: line.time, text: line.text || '' }));
    this.frames = [];
    this.loopCount = 0;
  }

  addFrame(frame) {
    if (!Number.isFinite(frame?.time)) return;
    const previous = this.frames[this.frames.length - 1];
    if (previous && frame.time + 0.5 < previous.time) this.loopCount++;
    this.frames.push({
      time: Math.max(0, frame.time),
      rms: clamp(Number(frame.rms) || 0, 0, 1),
      db: clamp(Number(frame.db) || -100, -100, 0),
      hz: clamp(Number(frame.hz) || 0, 0, 2000),
      clarity: clamp(Number(frame.clarity) || 0, 0, 1),
      lineIndex: Number.isInteger(frame.lineIndex) ? frame.lineIndex : -1,
    });
    if (this.frames.length > 18000) this.frames.splice(0, 3000);
  }

  analyze(song = {}, duration = 0) {
    const frames = this.frames.filter((frame) => frame.time <= Math.max(1, duration + 2));
    const activeFrames = frames.filter((frame) => frame.db > -53 || frame.clarity > 0.24);
    const pitchedFrames = activeFrames.filter((frame) => frame.hz >= 70 && frame.clarity >= 0.2);
    const frameSteps = frames.slice(1)
      .map((frame, index) => frame.time - frames[index].time)
      .filter((step) => step > 0 && step < 0.4);
    const frameStep = median(frameSteps) || 0.085;
    // 按采集到的帧数估算实际录制时长；循环回到句首时不会把整首歌时长算进去。
    const totalDuration = Math.max(0.1, frames.length * frameStep);
    const voiceCoverage = frames.length ? activeFrames.length / frames.length : 0;

    if (!activeFrames.length || !pitchedFrames.length) {
      return {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        at: Date.now(),
        song: compactSong(song),
        score: 0,
        grade: 'D',
        duration: Math.round(totalDuration),
        metrics: { pitch: 0, rhythm: 0, stability: 0, expression: 0, confidence: 0 },
        voice: { coverage: 0, medianDb: -100, dynamicRange: 0, medianNote: '--' },
        lines: [],
        weakLines: [],
        feedback: ['没有检测到有效人声。请检查麦克风权限和输入设备后重新演唱。'],
        coach: '这次没有采集到可分析的人声，先确认麦克风设备可用。',
        loopCount: this.loopCount,
      };
    }

    const midiValues = pitchedFrames.map((frame) => midiFromHz(frame.hz));
    const clarityValues = pitchedFrames.map((frame) => frame.clarity);
    const jitterCents = [];
    for (let i = 1; i < pitchedFrames.length; i++) {
      if (pitchedFrames[i].time - pitchedFrames[i - 1].time > 0.25) continue;
      const delta = Math.abs(midiValues[i] - midiValues[i - 1]);
      if (delta < 1.8) jitterCents.push(delta * 100);
    }
    const medianJitter = median(jitterCents);
    const medianClarity = median(clarityValues);
    const stability = Math.round(clamp(100 - medianJitter * 0.72 - (1 - medianClarity) * 22, 0, 100));
    const pitch = Math.round(clamp(35 + medianClarity * 55 - Math.min(20, medianJitter * 0.08), 0, 100));

    const activeDb = activeFrames.map((frame) => frame.db);
    const medianDb = median(activeDb);
    const dynamicRange = Math.max(0, percentile(activeDb, 0.9) - percentile(activeDb, 0.1));
    const energyFit = 100 - Math.min(55, Math.abs(medianDb + 24) * 3.5);

    const lines = this.lines.map((line, index) => {
      const nextStart = this.lines[index + 1]?.time ?? (duration || line.time + 8);
      const end = Math.max(line.time + 0.5, nextStart - 0.08);
      const lineFrames = frames.filter((frame) => frame.time >= line.time - 0.8 && frame.time < end);
      const lineActive = lineFrames.filter((frame) => frame.db > -50 || frame.clarity > 0.22);
      const linePitch = lineFrames.filter((frame) => frame.hz >= 70 && frame.clarity >= 0.2);
      const expectedFrames = Math.max(3, Math.round((end - Math.max(line.time, 0)) / 0.08));
      const coverage = clamp(lineActive.length / expectedFrames, 0, 1);
      const firstActive = lineActive[0];
      const onsetError = firstActive ? firstActive.time - line.time : null;
      const lineMidi = linePitch.map((frame) => midiFromHz(frame.hz));
      const lineJitter = lineMidi.slice(1).reduce((sum, midi, i) => (
        sum + (Math.abs(midi - lineMidi[i]) < 1.8 ? Math.abs(midi - lineMidi[i]) * 100 : 0)
      ), 0) / Math.max(1, lineMidi.length - 1);
      const lineScore = Math.round(clamp(
        coverage * 65 +
        (onsetError == null ? 0 : Math.max(0, 35 - Math.abs(onsetError) * 35)) -
        Math.min(15, lineJitter * 0.08),
        0,
        100
      ));
      return {
        index,
        text: line.text,
        time: line.time,
        coverage,
        onsetError,
        jitter: lineJitter,
        score: lineScore,
      };
    }).filter((line) => line.text);

    const scoredLines = lines.filter((line) => line.coverage >= 0.08);
    const validOnsets = scoredLines
      .map((line) => line.onsetError)
      .filter((value) => Number.isFinite(value) && Math.abs(value) < 2);
    const meanOnsetError = validOnsets.length
      ? validOnsets.reduce((sum, value) => sum + value, 0) / validOnsets.length
      : 0;
    const lineCoverage = lines.length
      ? scoredLines.length / lines.length
      : voiceCoverage;
    const rhythm = Math.round(clamp(
      lineCoverage * 62 +
      Math.max(0, 38 - Math.abs(meanOnsetError) * 70) +
      Math.min(10, voiceCoverage * 10),
      0,
      100
    ));
    const dynamicFit = clamp((dynamicRange - 2) / 18, 0, 1);
    const expression = Math.round(clamp(
      voiceCoverage * 40 +
      dynamicFit * (0.3 + voiceCoverage * 0.7) * 30 +
      medianClarity * 20 +
      energyFit * 0.1,
      0,
      100
    ));
    const score = Math.round(
      pitch * 0.28 +
      rhythm * 0.30 +
      stability * 0.22 +
      expression * 0.20
    );

    const weakLines = lines
      .filter((line) => line.coverage < 0.45 || line.score < 58)
      .sort((a, b) => a.score - b.score)
      .slice(0, 4);
    const feedback = [];
    if (lineCoverage < 0.55) feedback.push('多句人声覆盖不足，可能是起唱延迟或麦克风音量偏低。');
    if (meanOnsetError > 0.35) feedback.push(`整体起唱约晚 ${meanOnsetError.toFixed(2)} 秒，可以更早进入歌词。`);
    if (meanOnsetError < -0.35) feedback.push(`整体起唱约早 ${Math.abs(meanOnsetError).toFixed(2)} 秒，注意等待伴奏节拍。`);
    if (stability < 68) feedback.push('长音和尾音有波动，可以放慢换气速度并保持腹部支撑。');
    if (medianDb < -38) feedback.push('人声偏轻，建议靠近麦克风或适当提高人声音量。');
    if (medianDb > -13) feedback.push('人声偏响，容易削波，建议离麦克风远一些。');
    if (dynamicRange < 5) feedback.push('音量变化较少，可以在副歌和尾句增加强弱层次。');
    if (!feedback.length) feedback.push('人声覆盖、进入时机和稳定性都较均衡，可以继续挑战音色与情绪层次。');

    return {
      id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
      at: Date.now(),
      song: compactSong(song),
      score,
      grade: gradeFor(score),
      duration: Math.round(totalDuration),
      metrics: { pitch, rhythm, stability, expression, confidence: Math.round(medianClarity * 100) },
      voice: {
        coverage: Math.round(voiceCoverage * 100),
        medianDb: Math.round(medianDb),
        dynamicRange: Math.round(dynamicRange),
        medianNote: noteName(median(pitchedFrames.map((frame) => frame.hz))),
        onsetError: Number(meanOnsetError.toFixed(2)),
      },
      lines,
      weakLines,
      feedback,
      coach: '',
      loopCount: this.loopCount,
    };
  }
}

export function compactSong(song = {}) {
  return {
    hash: song.hash || '',
    name: song.name || '未知歌曲',
    artists: song.artists || '未知歌手',
    img: song.img || '',
  };
}

function validHistory(value) {
  return value && typeof value === 'object' &&
    Number.isFinite(value.score) &&
    value.song && typeof value.song.name === 'string';
}

export function loadHistory() {
  try {
    const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    return Array.isArray(list) ? list.filter(validHistory).slice(0, MAX_HISTORY) : [];
  } catch {
    return [];
  }
}

export function saveHistory(result) {
  if (!validHistory(result)) return loadHistory();
  const next = [result, ...loadHistory().filter((item) => item.id !== result.id)].slice(0, MAX_HISTORY);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // 存储配额不足时保留内存结果，不阻断录制。
  }
  return next;
}

export function clearHistory() {
  try {
    localStorage.removeItem(HISTORY_KEY);
  } catch {
    // localStorage unavailable
  }
}
