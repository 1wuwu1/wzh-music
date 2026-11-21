/**
 * K 歌工作台。
 *
 * 与日常播放器使用独立的 audio / Web Audio 节点，原因是
 * createMediaElementSource 对同一 <audio> 只能绑定一次。
 * 录制的对象是「伴奏 + 可选原唱 + 麦克风」混音后的 MediaStream。
 */
import * as api from './api.js';
import { player } from './player.js';
import { parseLRC, findLineIndex } from './lyrics.js';
import { escapeHtml, fixImgUrl, formatTime, PLACEHOLDER_IMG } from './utils.js';
import {
  PerformanceAnalyzer,
  clamp,
  detectPitch,
  loadHistory,
  noteName,
  saveHistory,
} from './karaoke-score.js';

const $ = (id) => document.getElementById(id);

const el = {
  page: $('karaoke-page'),
  close: $('karaoke-close'),
  importBtn: $('karaoke-import'),
  historyBtn: $('karaoke-history-btn'),
  file: $('karaoke-file'),
  status: $('karaoke-status'),
  headerStatus: $('karaoke-header-status'),
  cover: $('karaoke-cover'),
  songName: $('karaoke-song-name'),
  songArtist: $('karaoke-song-artist'),
  source: $('karaoke-source'),
  time: $('karaoke-time'),
  liveNote: $('karaoke-live-note'),
  liveLevel: $('karaoke-live-level'),
  liveScore: $('karaoke-live-score'),
  meterBars: [...document.querySelectorAll('.karaoke-meter i')],
  linePrev: $('karaoke-line-prev'),
  lineCurrent: $('karaoke-line-current'),
  lineNext: $('karaoke-line-next'),
  start: $('karaoke-start'),
  stop: $('karaoke-stop'),
  replay: $('karaoke-replay'),
  loopBtn: $('karaoke-loop-btn'),
  loopClear: $('karaoke-loop-clear'),
  review: $('karaoke-review'),
  reviewAudio: $('karaoke-review-audio'),
  download: $('karaoke-download'),
  report: $('karaoke-report'),
  reportClose: $('karaoke-report-close'),
  reportSong: $('karaoke-report-song'),
  reportScore: $('karaoke-report-score'),
  reportGrade: $('karaoke-report-grade'),
  reportSummary: $('karaoke-report-summary'),
  reportMini: $('karaoke-report-mini'),
  reportMetrics: $('karaoke-report-metrics'),
  reportCoach: $('karaoke-report-coach'),
  reportLines: $('karaoke-report-lines'),
  originalVolume: $('karaoke-original-volume'),
  originalValue: $('karaoke-original-value'),
  backingVolume: $('karaoke-backing-volume'),
  backingValue: $('karaoke-backing-value'),
  voiceVolume: $('karaoke-voice-volume'),
  voiceValue: $('karaoke-voice-value'),
  backing: $('karaoke-backing'),
  original: $('karaoke-original'),
};

const state = {
  initialized: false,
  song: null,
  session: 0,
  lines: [],
  lineIndex: -2,
  backingUrls: [],
  originalUrls: [],
  localBackingUrl: '',
  backingMode: '',
  sourceKind: '',
  preparing: false,
  recording: false,
  finishing: false,
  resultUrl: '',
  chunks: [],
  stream: null,
  recorder: null,
  ctx: null,
  graphBuilt: false,
  micSource: null,
  recordDest: null,
  backingSource: null,
  originalSource: null,
  backingGain: null,
  originalGain: null,
  voiceGain: null,
  clock: null,
  picker: null,
  pickerSongs: [],
  voiceAnalyser: null,
  timeData: null,
  frequencyData: null,
  featureTimer: null,
  analyzer: null,
  result: null,
  coachToken: 0,
  practiceLoop: { active: false, start: 0, end: 0, label: '', repeats: 0 },
};

let toastFn = (msg) => console.warn(msg);

function toast(msg, warn = false) {
  toastFn(msg, warn);
}

function setStatus(msg, warn = false) {
  el.status.textContent = msg;
  el.status.classList.toggle('warn', !!warn);
}

function setHeaderStatus(msg) {
  el.headerStatus.textContent = msg;
}

function setPageOpen(open) {
  el.page.classList.toggle('open', open);
  el.page.setAttribute('aria-hidden', open ? 'false' : 'true');
  document.body.classList.toggle('karaoke-open', open);
}

function setPlaying(playing) {
  el.page.classList.toggle('playing', !!playing);
}

function setRecording(recording) {
  state.recording = !!recording;
  el.page.classList.toggle('recording', !!recording);
  el.start.hidden = !!recording;
  el.stop.hidden = !recording;
  el.replay.hidden = true;
}

function updateVolumeLabels() {
  const rows = [
    [el.originalVolume, el.originalValue],
    [el.backingVolume, el.backingValue],
    [el.voiceVolume, el.voiceValue],
  ];
  for (const [input, label] of rows) label.textContent = `${input.value}%`;
}

function applyMixGains() {
  if (!state.graphBuilt) return;
  const original = Number(el.originalVolume.value) / 100;
  const backing = Number(el.backingVolume.value) / 100;
  const voice = Number(el.voiceVolume.value) / 100;
  state.originalGain.gain.value = original;
  state.backingGain.gain.value = backing;
  state.voiceGain.gain.value = voice;
}

function clearClock() {
  if (state.clock) {
    clearInterval(state.clock);
    state.clock = null;
  }
}

function resetMeter() {
  el.meterBars.forEach((bar) => {
    bar.style.height = '';
    bar.style.opacity = '';
  });
  el.liveNote.textContent = '--';
  el.liveLevel.textContent = '等待';
  el.liveScore.textContent = '--';
  el.page.style.setProperty('--voice-glow', '70px');
  el.page.style.setProperty('--voice-hue', '168');
}

function stopVoiceAnalysis() {
  if (state.featureTimer) {
    clearInterval(state.featureTimer);
    state.featureTimer = null;
  }
  el.page.classList.remove('live-analysis');
  resetMeter();
}

function seekPlayback(time) {
  const duration = durationOf(el.backing);
  const target = clamp(Number(time) || 0, 0, duration || Number.MAX_SAFE_INTEGER);
  try { el.backing.currentTime = target; } catch { /* metadata not ready */ }
  if (el.original.src) {
    try { el.original.currentTime = target; } catch { /* metadata not ready */ }
  }
  return target;
}

function updatePracticeButton() {
  const loop = state.practiceLoop;
  el.loopBtn.classList.toggle('active', loop.active);
  el.loopBtn.textContent = loop.active
    ? `循环中${loop.repeats ? ` · ${loop.repeats}` : ''}`
    : '循环本句';
  el.loopClear.hidden = !loop.active;
  el.loopClear.disabled = !loop.active;
}

function rollPracticeLoop(time) {
  const loop = state.practiceLoop;
  if (!loop.active || el.backing.paused || time < loop.end - 0.04) return time;
  loop.repeats++;
  updatePracticeButton();
  return seekPlayback(loop.start);
}

function setCurrentLineLoop() {
  if (!state.lines.length) {
    toast('这首歌暂无同步歌词，暂时不能按句循环', true);
    return;
  }
  const now = el.backing.currentTime || 0;
  let index = findLineIndex(state.lines, now);
  if (index < 0) index = 0;
  if (index >= state.lines.length) index = state.lines.length - 1;
  const line = state.lines[index];
  const next = state.lines[index + 1]?.time;
  const duration = durationOf(el.backing) || state.song?.duration || 0;
  const start = Math.max(0, line.time - 0.7);
  let end = Number.isFinite(next) ? next - 0.12 : (duration || line.time + 8);
  end = Math.min(duration || end, end);
  if (!Number.isFinite(end) || end - start < 1.8) end = start + Math.max(3, duration ? Math.min(8, duration - start) : 6);
  state.practiceLoop = {
    active: true,
    start,
    end,
    label: line.text || `第 ${index + 1} 句`,
    repeats: 0,
  };
  updatePracticeButton();
  if (!state.recording) seekPlayback(start);
  setHeaderStatus(`循环练习：${state.practiceLoop.label}`);
  setStatus(`已设置「${state.practiceLoop.label}」循环段。点击“开始演唱”后会反复练习这一句。`);
}

function clearPracticeLoop() {
  state.practiceLoop = { active: false, start: 0, end: 0, label: '', repeats: 0 };
  updatePracticeButton();
  setHeaderStatus(state.sourceKind || '准备开唱');
  setStatus('已恢复整首演唱。');
}

function runVoiceFrame() {
  if (!state.recording || !state.voiceAnalyser || !state.analyzer) return;
  state.voiceAnalyser.getFloatTimeDomainData(state.timeData);
  state.voiceAnalyser.getByteFrequencyData(state.frequencyData);
  const pitch = detectPitch(state.timeData, state.ctx.sampleRate);
  const db = pitch.rms > 0 ? 20 * Math.log10(pitch.rms) : -100;
  const time = el.backing.currentTime || 0;
  const lineIndex = findLineIndex(state.lines, time);
  state.analyzer.addFrame({ time, rms: pitch.rms, db, hz: pitch.hz, clarity: pitch.clarity, lineIndex });

  const active = db > -50 || pitch.clarity > 0.24;
  el.liveNote.textContent = active && pitch.clarity > 0.18 ? noteName(pitch.hz) : '--';
  el.liveLevel.textContent = !active ? '等待' : db < -38 ? '偏轻' : db > -13 ? '偏响' : '稳定';
  const liveScore = active
    ? Math.round(clamp(pitch.clarity * 72 + clamp((db + 48) * 3.2, 0, 28), 0, 100))
    : 0;
  el.liveScore.textContent = active ? String(liveScore) : '--';

  const bands = el.meterBars.length;
  for (let i = 0; i < bands; i++) {
    const ratio = (i + 1) / bands;
    const index = clamp(Math.floor(Math.pow(ratio, 1.7) * (state.frequencyData.length - 1)), 0, state.frequencyData.length - 1);
    const level = state.frequencyData[index] / 255;
    el.meterBars[i].style.height = `${6 + level * 27}px`;
    el.meterBars[i].style.opacity = String(0.24 + level * 0.76);
  }
  const energy = clamp((db + 50) / 35, 0, 1);
  const hue = pitch.hz > 0 ? clamp(Math.round(186 - midiOffset(pitch.hz) * 2.2), 120, 210) : 168;
  el.page.style.setProperty('--voice-glow', `${45 + energy * 130}px`);
  el.page.style.setProperty('--voice-hue', String(hue));
}

function midiOffset(hz) {
  return clamp(Math.round(12 * Math.log2(hz / 220)), -24, 24);
}

function startVoiceAnalysis() {
  stopVoiceAnalysis();
  if (!state.voiceAnalyser || !state.analyzer) return;
  state.timeData = new Float32Array(state.voiceAnalyser.fftSize);
  state.frequencyData = new Uint8Array(state.voiceAnalyser.frequencyBinCount);
  el.page.classList.add('live-analysis');
  runVoiceFrame();
  state.featureTimer = setInterval(runVoiceFrame, 85);
}

function startClock() {
  clearClock();
  updateKaraokeClock();
  state.clock = setInterval(updateKaraokeClock, 100);
}

function durationOf(audio) {
  return Number.isFinite(audio.duration) ? audio.duration : null;
}

function updateKaraokeClock() {
  const pos = rollPracticeLoop(el.backing.currentTime || 0);
  const duration = durationOf(el.backing) || state.song?.duration || null;
  el.time.textContent = `${formatTime(pos)} / ${duration != null ? formatTime(duration) : '--:--'}`;
  updateLyric(pos);
}

function lineHtml(line) {
  if (!line) return '';
  return escapeHtml(line.text || '') +
    (line.trans ? `<span class="lyric-trans">${escapeHtml(line.trans)}</span>` : '');
}

function updateLyric(time) {
  if (!state.lines.length) return;
  const idx = findLineIndex(state.lines, time);
  if (idx === state.lineIndex) return;
  state.lineIndex = idx;
  const current = idx >= 0 ? state.lines[idx] : null;
  const next = idx + 1 < state.lines.length ? state.lines[idx + 1] : null;
  const prev = idx > 0 ? state.lines[idx - 1] : null;
  el.linePrev.textContent = prev?.text || '';
  el.lineNext.textContent = next?.text || (current ? '' : state.lines[0]?.text || '');
  el.lineCurrent.innerHTML = current
    ? lineHtml(current)
    : escapeHtml(state.song ? '准备一下，马上开始' : '准备好后，点击“开始演唱”');
  el.lineCurrent.classList.toggle('idle', !current);
}

async function loadLyrics(song, token) {
  if (!song?.hash) {
    state.lines = [];
    updateLyric(0);
    return false;
  }
  try {
    const meta = await api.searchLyric(song);
    if (!meta) throw new Error('no lyric');
    const text = await api.getLyric(meta.id, meta.accesskey);
    if (token !== state.session) return false;
    const title = String(song.name || '').trim();
    const artists = String(song.artists || '').trim();
    const skipTitle = (line) => {
      const body = String(line || '').trim();
      return /^(?:作词|作曲|词曲|编曲|制作|吉他|贝斯|鼓|和声|录音|混音|母带|监制|策划|统筹|发行|出品)\s*[:：]/i.test(body) ||
        body === title ||
        (body.startsWith(title) && /^\s*-\s/.test(body.slice(title.length))) ||
        (body.startsWith(title) && !!artists && body.endsWith(artists) && body.includes(' - ')) ||
        (!!artists && (body === `${artists} - ${title}` || body === `${title} - ${artists}`));
    };
    state.lines = parseLRC(text, skipTitle);
    state.lineIndex = -2;
    updateLyric(0);
    return state.lines.length > 0;
  } catch {
    if (token !== state.session) return false;
    state.lines = [];
    state.lineIndex = -2;
    updateLyric(0);
    return false;
  }
}

function setAudioUrls(audio, urls) {
  audio.pause();
  audio.dataset.urlIndex = '0';
  audio.removeAttribute('src');
  if (!urls.length) {
    audio.load();
    return;
  }
  audio.src = urls[0];
  audio.load();
}

async function resolveSongUrls(song) {
  let urls = [];
  if (api.hasLogin()) {
    urls = await api.getSongUrlVip(song.hash320 || song.hash, '320').catch(() => []);
    if (!urls.length) urls = await api.getSongUrlVip(song.hash, '128').catch(() => []);
  }
  if (!urls.length) {
    const result = await api.resolvePlayUrl(song.hash).catch(() => ({ urls: [] }));
    urls = result.urls || [];
  }
  return urls;
}

async function loadTracks(song, token) {
  state.preparing = true;
  setStatus('正在匹配酷狗伴奏和原唱…');
  setHeaderStatus('匹配音轨中');
  el.source.textContent = '匹配中';
  el.start.disabled = true;

  const accompanimentPromise = api.getAccompaniment(song).catch((error) => ({
    ok: false,
    error: error?.message || '伴奏匹配失败',
  }));
  const originalPromise = resolveSongUrls(song).catch(() => []);
  const [accompaniment, originalUrls] = await Promise.all([accompanimentPromise, originalPromise]);
  if (token !== state.session) return;

  state.originalUrls = originalUrls;
  state.localBackingUrl = '';
  state.backingUrls = [];
  state.backingMode = '';
  state.sourceKind = '';

  if (accompaniment.ok) {
    const resolved = await api.resolvePlayUrl(accompaniment.hash).catch(() => ({ urls: [] }));
    if (token !== state.session) return;
    state.backingUrls = resolved.urls || [];
    state.backingMode = 'accompaniment';
    state.sourceKind = '酷狗伴奏';
  }

  if (!state.backingUrls.length) {
    // 没有伴奏仍可使用原唱练习；用户也可以随时导入本地伴奏覆盖。
    state.backingUrls = originalUrls.slice();
    state.backingMode = state.backingUrls.length ? 'original' : '';
    state.sourceKind = state.backingUrls.length ? '原唱练习' : '待导入';
  }

  setAudioUrls(el.backing, state.backingUrls);
  setAudioUrls(el.original, accompaniment.ok ? originalUrls : []);
  el.originalVolume.disabled = !(accompaniment.ok && originalUrls.length);

  state.preparing = false;
  el.start.disabled = state.backingUrls.length === 0;
  el.source.textContent = state.sourceKind;
  setHeaderStatus(state.sourceKind);

  if (state.backingMode === 'accompaniment') {
    setStatus(
      originalUrls.length
        ? '伴奏已就绪。戴耳机可避免声音被麦克风再次收录，点击“开始演唱”录音。'
        : '伴奏已就绪。暂未取得原唱轨，将只播放伴奏并录制人声。'
    );
  } else if (state.backingMode === 'original') {
    setStatus('没有匹配到伴奏，当前将用原唱练习。你可以点右上角“导入伴奏”替换音轨。', true);
  } else {
    setStatus('暂未取得可用音轨。点击右上角“导入伴奏”选择本地伴奏文件。', true);
  }
}

async function prepare(song) {
  const token = ++state.session;
  state.song = song;
  state.lines = [];
  state.lineIndex = -2;
  state.finishing = false;
  state.analyzer = null;
  state.result = null;
  state.practiceLoop = { active: false, start: 0, end: 0, label: '', repeats: 0 };
  updatePracticeButton();
  clearClock();
  stopVoiceAnalysis();
  stopStream();
  setPlaying(false);
  setRecording(false);
  el.stop.disabled = false;
  el.backing.pause();
  el.original.pause();
  el.backing.currentTime = 0;
  el.original.currentTime = 0;
  el.review.hidden = true;
  el.report.hidden = true;
  el.reviewAudio.pause();
  if (state.resultUrl) {
    URL.revokeObjectURL(state.resultUrl);
    state.resultUrl = '';
  }
  el.reviewAudio.removeAttribute('src');
  el.reviewAudio.load();
  el.download.removeAttribute('href');
  el.download.removeAttribute('download');
  el.replay.hidden = true;
  el.start.hidden = false;
  el.start.textContent = '开始演唱';
  updateLyric(0);
  updateKaraokeClock();

  el.songName.textContent = song?.name || '选择一首歌开始';
  el.songArtist.textContent = song?.artists || '支持酷狗伴奏匹配，也可以导入本地伴奏';
  el.cover.src = song ? fixImgUrl(song.img, 480) || PLACEHOLDER_IMG : PLACEHOLDER_IMG;

  if (!song?.hash) {
    setStatus('请先选择一首在线歌曲，或直接导入本地伴奏。', true);
    el.start.disabled = true;
    return;
  }

  const lyricsPromise = loadLyrics(song, token);
  await loadTracks(song, token);
  await lyricsPromise;
}

export async function openKaraoke(song) {
  if (!song) {
    toast('请先选择一首歌', true);
    return;
  }
  if (state.recording) {
    toast('请先结束当前录音', true);
    return;
  }
  if (player.state === 'playing') player.audio.pause();
  setPageOpen(true);
  await prepare(song);
}

export function openKaraokeForCurrent() {
  const song = player.getCurrent();
  if (!song) {
    toast('播放器里还没有歌曲，请先去 K 歌页选择', true);
    return;
  }
  openKaraoke(song);
}

function pickerCard(song, i) {
  const img = fixImgUrl(song.img, 160) || PLACEHOLDER_IMG;
  return `
    <button class="karaoke-song-card" data-karaoke-i="${i}" type="button">
      <img src="${escapeHtml(img)}" alt="">
      <span>
        <strong>${escapeHtml(song.name)}</strong>
        <span>${escapeHtml(song.artists)}${song.duration != null ? ` · ${formatTime(song.duration)}` : ''}</span>
      </span>
      <b>开唱</b>
    </button>`;
}

function bindPickerCards(container) {
  container.querySelectorAll('[data-karaoke-i]').forEach((card) => {
    card.addEventListener('click', () => {
      const song = state.pickerSongs[Number(card.dataset.karaokeI)];
      if (song) openKaraoke(song);
    });
  });
  container.querySelectorAll('img').forEach((img) => {
    img.addEventListener('error', () => {
      if (img.src !== PLACEHOLDER_IMG) img.src = PLACEHOLDER_IMG;
    }, { once: true });
  });
}

function renderPickerResults(container, songs, message = '') {
  state.pickerSongs = songs || [];
  const grid = container.querySelector('#karaoke-picker-results');
  if (!grid) return;
  grid.innerHTML = state.pickerSongs.length
    ? state.pickerSongs.map(pickerCard).join('')
    : `<div class="karaoke-empty">${escapeHtml(message || '没有找到可演唱的歌曲')}</div>`;
  bindPickerCards(grid);
}

export async function renderKaraokePicker(container) {
  if (!container) return;
  state.picker = container;
  container.innerHTML = `
    <div class="karaoke-picker">
      <section class="karaoke-picker-hero">
        <h2>🎤 RE:KG 唱吧</h2>
        <p>搜索歌曲，自动匹配酷狗伴奏和同步歌词。录制时会混合伴奏、原唱与人声，作品只保存在当前设备。</p>
      </section>
      <div class="karaoke-picker-search">
        <input id="karaoke-picker-query" type="search" placeholder="搜索歌名或歌手…" autocomplete="off" spellcheck="false">
        <button id="karaoke-picker-search" type="button">搜索开唱</button>
      </div>
      <div class="view-title">成长档案<span class="sub">评分摘要自动保存在本机</span></div>
      <div class="karaoke-history-list" id="karaoke-picker-history"></div>
      <div class="view-title">推荐开唱<span class="sub">点击歌曲进入 K 歌工作台</span></div>
      <div class="karaoke-song-grid" id="karaoke-picker-results">
        <div class="karaoke-empty">正在加载推荐歌曲…</div>
      </div>
    </div>`;

  const input = container.querySelector('#karaoke-picker-query');
  const submit = async () => {
    const keyword = input.value.trim();
    if (!keyword) {
      renderPickerResults(container, state.pickerSongs);
      return;
    }
    const grid = container.querySelector('#karaoke-picker-results');
    grid.innerHTML = '<div class="karaoke-empty">正在搜索…</div>';
    try {
      renderPickerResults(container, await api.searchSongs(keyword), '没有找到相关歌曲');
    } catch {
      grid.innerHTML = '<div class="karaoke-empty">搜索失败，请确认本地服务已启动</div>';
    }
  };
  container.querySelector('#karaoke-picker-search').addEventListener('click', submit);
  renderHistoryList(container);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') submit();
  });

  try {
    renderPickerResults(container, await api.getRecommendSongs());
  } catch {
    container.querySelector('#karaoke-picker-results').innerHTML =
      '<div class="karaoke-empty">推荐加载失败，仍可在上方搜索歌曲</div>';
  }
}

function ensureAudioGraph() {
  if (state.graphBuilt) {
    if (state.ctx.state === 'suspended') state.ctx.resume().catch(() => {});
    return;
  }
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) throw new Error('当前环境不支持 Web Audio');
  const ctx = new Ctx();
  const recordDest = ctx.createMediaStreamDestination();
  const backingGain = ctx.createGain();
  const originalGain = ctx.createGain();
  const voiceGain = ctx.createGain();
  const voiceAnalyser = ctx.createAnalyser();
  voiceAnalyser.fftSize = 2048;
  voiceAnalyser.smoothingTimeConstant = 0.68;
  const backingSource = ctx.createMediaElementSource(el.backing);
  const originalSource = ctx.createMediaElementSource(el.original);

  backingSource.connect(backingGain);
  originalSource.connect(originalGain);
  backingGain.connect(ctx.destination);
  originalGain.connect(ctx.destination);
  backingGain.connect(recordDest);
  originalGain.connect(recordDest);
  voiceGain.connect(recordDest);

  state.ctx = ctx;
  state.recordDest = recordDest;
  state.backingSource = backingSource;
  state.originalSource = originalSource;
  state.backingGain = backingGain;
  state.originalGain = originalGain;
  state.voiceGain = voiceGain;
  state.voiceAnalyser = voiceAnalyser;
  state.graphBuilt = true;
  applyMixGains();
}

function chooseMimeType() {
  const options = [
    'audio/webm;codecs=opus',
    'audio/webm',
    'audio/ogg;codecs=opus',
    'audio/mp4',
  ];
  return options.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || '';
}

function stopStream() {
  if (state.micSource) {
    try { state.micSource.disconnect(); } catch { /* already disconnected */ }
    state.micSource = null;
  }
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
}

function resetAudioPositions(time = 0) {
  for (const audio of [el.backing, el.original]) {
    audio.pause();
    try { audio.currentTime = Math.max(0, time); } catch { /* metadata may not be ready */ }
  }
}

function extensionForMime(type) {
  if (type.includes('ogg')) return 'ogg';
  if (type.includes('mp4')) return 'm4a';
  return 'webm';
}

function safeFileName(text) {
  return String(text || 'K歌作品').replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();
}

async function startRecording() {
  if (state.recording || state.preparing || !state.song) return;
  if (!state.backingUrls.length && !state.localBackingUrl) {
    setStatus('还没有可用伴奏，请点击右上角“导入伴奏”。', true);
    return;
  }
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    setStatus('当前浏览器不支持麦克风录音，请使用桌面版 REKG。', true);
    return;
  }

  el.start.disabled = true;
  el.start.textContent = '准备录音…';
  setStatus('正在请求麦克风权限…');
  try {
    ensureAudioGraph();
    state.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
      video: false,
    });
    if (state.ctx.state === 'suspended') await state.ctx.resume();

    stopStreamSourceOnly();
    state.micSource = state.ctx.createMediaStreamSource(state.stream);
    state.micSource.connect(state.voiceGain);
    state.micSource.connect(state.voiceAnalyser);
    applyMixGains();

    el.report.hidden = true;
    state.result = null;
    state.analyzer = new PerformanceAnalyzer(state.lines);
    state.chunks = [];
    const mimeType = chooseMimeType();
    state.recorder = new MediaRecorder(
      state.recordDest.stream,
      mimeType ? { mimeType, audioBitsPerSecond: 128000 } : undefined
    );
    state.recorder.addEventListener('dataavailable', (event) => {
      if (event.data?.size) state.chunks.push(event.data);
    });
    state.recorder.addEventListener('stop', finalizeRecording, { once: true });

    const startAt = state.practiceLoop.active ? state.practiceLoop.start : 0;
    resetAudioPositions(startAt);
    state.lineIndex = -2;
    updateLyric(startAt);
    setRecording(true);
    state.finishing = false;
    state.recorder.start(1000);

    try {
      await el.backing.play();
    } catch {
      throw new Error('伴奏无法播放，请重新匹配或导入本地伴奏');
    }
    if (state.originalUrls.length) el.original.play().catch(() => {});
    setPlaying(true);
    startClock();
    startVoiceAnalysis();
    setHeaderStatus('正在录音');
    setStatus('录音中。戴耳机效果更好，点击“结束并生成作品”完成。');
    toast('开始录音');
  } catch (error) {
    stopVoiceAnalysis();
    stopStream();
    resetAudioPositions(state.practiceLoop.active ? state.practiceLoop.start : 0);
    setPlaying(false);
    setRecording(false);
    el.start.disabled = false;
    el.start.textContent = '开始演唱';
    const permissionDenied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
    setStatus(
      permissionDenied
        ? '麦克风权限被拒绝。请在 Windows 设置 → 隐私和安全性 → 麦克风中允许 REKG。'
        : error?.message || '录音启动失败，请检查音频设备',
      true
    );
  }
}

function stopStreamSourceOnly() {
  if (!state.micSource) return;
  try { state.micSource.disconnect(); } catch { /* no-op */ }
  state.micSource = null;
}

function reportMetric(label, value) {
  return `
    <div class="karaoke-metric" style="--metric:${clamp(value, 0, 100)}%">
      <header><span>${label}</span><b>${Math.round(value)}</b></header>
      <i></i>
    </div>`;
}

function renderReport(result, { preview = false } = {}) {
  if (!result || !el.report) return;
  el.report.hidden = false;
  el.reportSong.textContent = `${result.song?.name || '本次作品'} · ${result.song?.artists || ''}`.replace(/\s·\s$/, '');
  el.reportScore.textContent = String(result.score);
  el.reportGrade.textContent = result.grade;
  el.reportSummary.textContent = result.feedback?.[0] || '分析完成';
  const minutes = Math.max(0, Math.round((result.duration || 0) / 60));
  const onset = Number(result.voice?.onsetError);
  el.reportMini.innerHTML = [
    `人声覆盖 ${result.voice?.coverage || 0}%`,
    `主要音区 ${escapeHtml(result.voice?.medianNote || '--')}`,
    Number.isFinite(onset) ? `平均进入 ${onset > 0 ? '晚' : '早'} ${Math.abs(onset).toFixed(2)} 秒` : '无进入偏差数据',
    `时长 ${minutes ? `${minutes} 分钟` : `${result.duration || 0} 秒`}`,
    result.loopCount ? `循环回到 ${result.loopCount} 次` : '',
  ].filter(Boolean).map((item) => `<span>${item}</span>`).join('');
  el.reportMetrics.innerHTML = [
    reportMetric('音准稳定', result.metrics?.pitch || 0),
    reportMetric('节奏进入', result.metrics?.rhythm || 0),
    reportMetric('长音稳定', result.metrics?.stability || 0),
    reportMetric('表现层次', result.metrics?.expression || 0),
  ].join('');
  el.reportCoach.textContent = result.coach || result.feedback?.join('\n') || '暂无建议';
  const weak = result.weakLines || [];
  el.reportLines.innerHTML = weak.length
    ? weak.map((line) => `
        <div class="karaoke-weak-line">
          <span>${escapeHtml(line.text)}</span>
          <b>${Math.round(line.score)} 分</b>
        </div>`).join('')
    : '<div class="karaoke-weak-line"><span>没有发现明显薄弱句，可以继续尝试整首完成。</span><b>+</b></div>';
  window.__APP_KARAOKE_REPORT = preview ? 'history' : 'result';
}

async function requestCoach(result) {
  if (!result?.id) return;
  const token = ++state.coachToken;
  try {
    const response = await fetch('/api/coach', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        song: `${result.song?.artists || ''} - ${result.song?.name || ''}`.replace(/^ - /, ''),
        metrics: result.metrics,
        voice: result.voice,
        weakLines: result.weakLines?.map((line) => line.text) || [],
      }),
    });
    const data = await response.json();
    if (token !== state.coachToken || data?.ok !== true || !data.text) return;
    result.coach = String(data.text).trim().slice(0, 1600);
    if (state.result?.id === result.id) {
      el.reportCoach.textContent = result.coach;
      saveHistory(result);
    }
  } catch {
    // 未配置模型或网络不可用时保留本地规则建议。
  }
}

function renderHistoryList(container) {
  const box = container?.querySelector('#karaoke-picker-history');
  if (!box) return;
  const history = loadHistory();
  box.innerHTML = history.length
    ? history.slice(0, 6).map((item) => `
        <div class="karaoke-history-item">
          <div>
            <b>${escapeHtml(item.song?.name || '未知歌曲')} · ${escapeHtml(item.song?.artists || '')}</b>
            <span>${new Date(item.at).toLocaleString('zh-CN', { hour12: false })} · 节奏 ${item.metrics?.rhythm || 0} · 稳定 ${item.metrics?.stability || 0}</span>
          </div>
          <strong>${item.score}</strong>
        </div>`).join('')
    : '<div class="karaoke-empty">还没有成长记录。完成一次演唱后会自动保存评分摘要。</div>';
}

function showLatestReport() {
  if (state.result) return renderReport(state.result);
  const [latest] = loadHistory();
  if (!latest) {
    toast('还没有演唱记录，先完成一次 K 歌', true);
    return;
  }
  renderReport(latest, { preview: true });
}

function finishRecording() {
  if (!state.recording || !state.recorder || state.finishing) return;
  state.finishing = true;
  el.stop.disabled = true;
  setStatus('正在生成录音作品…');
  try {
    if (state.recorder.state !== 'inactive') state.recorder.stop();
  } catch {
    state.finishing = false;
    el.stop.disabled = false;
    setStatus('结束录音失败，请重试', true);
    return;
  }
  el.backing.pause();
  el.original.pause();
  clearClock();
  stopVoiceAnalysis();
  stopStream();
  setPlaying(false);
}

function finalizeRecording() {
  const mime = state.recorder?.mimeType || state.chunks[0]?.type || 'audio/webm';
  const blob = new Blob(state.chunks, { type: mime });
  state.recorder = null;
  state.finishing = false;
  el.stop.disabled = false;
  setRecording(false);
  setPlaying(false);
  setHeaderStatus('作品已生成');

  if (!blob.size) {
    el.start.hidden = false;
    el.start.disabled = false;
    el.start.textContent = '再唱一次';
    setStatus('没有录到有效音频，请检查麦克风后重试。', true);
    return;
  }

  if (state.resultUrl) URL.revokeObjectURL(state.resultUrl);
  state.resultUrl = URL.createObjectURL(blob);
  const ext = extensionForMime(mime);
  const name = `REKG-K歌-${safeFileName(state.song?.name)}-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.${ext}`;
  el.reviewAudio.src = state.resultUrl;
  el.download.href = state.resultUrl;
  el.download.download = name;
  el.review.hidden = false;
  el.replay.hidden = false;
  el.start.hidden = false;
  el.start.disabled = false;
  el.start.textContent = '再唱一次';
  const result = state.analyzer?.analyze(
    state.song,
    durationOf(el.backing) || state.song?.duration || 0
  );
  if (result) {
    state.result = result;
    window.__APP_KARAOKE_RESULT = result;
    saveHistory(result);
    if (state.picker) renderHistoryList(state.picker);
    renderReport(result);
    requestCoach(result);
    setHeaderStatus(`作品已生成 · ${result.score} 分`);
    setStatus(`作品与评分已生成：${result.score} 分 ${result.grade}。可直接试听、下载或查看练习建议。`);
  } else {
    setStatus('作品已生成，可直接试听或下载。当前版本不会自动上传到服务器。');
  }
  toast(result ? `演唱完成：${result.score} 分` : '录音作品已生成');
}

function retrySinging() {
  if (state.recording) return;
  stopVoiceAnalysis();
  state.analyzer = null;
  state.result = null;
  el.review.hidden = true;
  el.report.hidden = true;
  el.reviewAudio.pause();
  el.replay.hidden = true;
  el.start.hidden = false;
  el.start.textContent = '开始演唱';
  const startAt = state.practiceLoop.active ? state.practiceLoop.start : 0;
  resetAudioPositions(startAt);
  state.lineIndex = -2;
  updateLyric(startAt);
  updateKaraokeClock();
  setHeaderStatus(state.sourceKind || '准备开唱');
  setStatus('已回到起点，点击“开始演唱”重新录制。');
}

function importBacking(file) {
  if (!file) return;
  if (state.recording) {
    toast('请先结束当前录音', true);
    return;
  }
  state.session++; // 取消仍在进行中的在线匹配，导入文件优先
  state.preparing = false;
  state.analyzer = null;
  state.result = null;
  state.practiceLoop = { active: false, start: 0, end: 0, label: '', repeats: 0 };
  updatePracticeButton();
  stopVoiceAnalysis();
  if (state.localBackingUrl) URL.revokeObjectURL(state.localBackingUrl);
  state.localBackingUrl = URL.createObjectURL(file);
  state.backingUrls = [state.localBackingUrl];
  state.originalUrls = [];
  state.backingMode = 'local';
  state.sourceKind = '本地伴奏';
  el.backing.src = state.localBackingUrl;
  el.backing.load();
  el.original.pause();
  el.original.removeAttribute('src');
  el.original.load();
  el.originalVolume.disabled = true;
  el.originalVolume.value = '0';
  updateVolumeLabels();
  applyMixGains();
  el.start.disabled = false;
  el.review.hidden = true;
  el.report.hidden = true;
  el.replay.hidden = true;
  if (!el.start.textContent.includes('再唱')) el.start.textContent = '开始演唱';
  el.source.textContent = '本地伴奏';
  setHeaderStatus('本地伴奏');
  setStatus(`已载入「${file.name}」。点击“开始演唱”录音。`);
  if (state.song?.hash) loadLyrics(state.song, state.session);
}

function closeKaraoke() {
  if (state.recording) {
    toast('录音进行中，请先结束并生成作品', true);
    return;
  }
  clearClock();
  stopVoiceAnalysis();
  el.backing.pause();
  el.original.pause();
  el.reviewAudio.pause();
  setPlaying(false);
  setPageOpen(false);
  if (state.ctx?.state === 'running') state.ctx.suspend().catch(() => {});
}

function onAudioError(audio, urls) {
  const index = Number(audio.dataset.urlIndex || 0);
  if (!state.recording || index + 1 >= urls.length) return;
  const wasPlaying = !audio.paused;
  const time = audio.currentTime;
  audio.dataset.urlIndex = String(index + 1);
  audio.src = urls[index + 1];
  try { audio.currentTime = time; } catch { /* metadata not ready */ }
  if (wasPlaying) audio.play().catch(() => {});
}

export function initKaraoke({ toast: showToast } = {}) {
  if (state.initialized) return;
  state.initialized = true;
  if (showToast) toastFn = showToast;

  el.start.addEventListener('click', () => {
    if (el.start.textContent.includes('再唱')) retrySinging();
    else startRecording();
  });
  el.stop.addEventListener('click', finishRecording);
  el.replay.addEventListener('click', retrySinging);
  el.loopBtn.addEventListener('click', setCurrentLineLoop);
  el.loopClear.addEventListener('click', clearPracticeLoop);
  el.close.addEventListener('click', closeKaraoke);
  el.historyBtn.addEventListener('click', showLatestReport);
  el.reportClose.addEventListener('click', () => {
    el.report.hidden = true;
    window.__APP_KARAOKE_REPORT = 'closed';
  });
  el.importBtn.addEventListener('click', () => el.file.click());
  el.file.addEventListener('change', () => {
    const file = el.file.files?.[0];
    el.file.value = '';
    importBacking(file);
  });
  for (const input of [el.originalVolume, el.backingVolume, el.voiceVolume]) {
    input.addEventListener('input', () => {
      updateVolumeLabels();
      applyMixGains();
    });
  }
  el.backing.addEventListener('playing', () => setPlaying(true));
  el.backing.addEventListener('pause', () => {
    if (!state.recording) setPlaying(false);
  });
  el.backing.addEventListener('timeupdate', updateKaraokeClock);
  el.backing.addEventListener('loadedmetadata', updateKaraokeClock);
  el.backing.addEventListener('ended', () => {
    if (state.recording) finishRecording();
  });
  el.backing.addEventListener('error', () => onAudioError(el.backing, state.backingUrls));
  el.original.addEventListener('error', () => onAudioError(el.original, state.originalUrls));
  el.page.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !state.recording) closeKaraoke();
  });
  window.addEventListener('beforeunload', stopStream);
  updateVolumeLabels();
  applyMixGains();
  updatePracticeButton();
}
