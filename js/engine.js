// Arcadia — motor de audio (Web Audio API).
// Pistas -> efectos -> volumen -> paneo -> master -> limitador -> bocinas.

import { EFFECTS, makeImpulse } from './effects.js';
import { buildMastering, setMastering } from './master.js';
import { loadAudio } from './store.js';

const dbToGain = (db) => Math.pow(10, db / 20);
const PEAKS_PER_SEC = 1000; // detalle de la onda: 1000 puntos por segundo

export class Engine {
  constructor() {
    this.ctx = null;
    this.buffers = new Map();   // audioId -> AudioBuffer
    this.peaks = new Map();     // audioId -> { min, max }
    this.loading = new Map();   // audioId -> Promise
    this.chains = new Map();    // trackId -> cadena viva
    this.sources = [];
    this.playing = false;
    this.startCtxTime = 0;
    this.startPos = 0;
    this.metronome = false;
    this.bpm = 120;
    this.metroTimer = null;
    this.recorder = null;
  }

  // ---------- Contexto ----------
  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      // 'playback': el cel usa un búfer de audio más grande → no se traba ni truena con muchas pistas.
      // El retraso extra se compensa solo al grabar (ver recordLatency).
      this.ctx = new AC({ latencyHint: 'playback' });
      this.ms = this.buildMaster(this.ctx);
      this.workletPromise = loadWorklet(this.ctx).then((ok) => {
        // Las pistas que ya tenían Shimmer se vuelven a armar, ahora con el cambio de tono.
        if (ok) this.chains.forEach((c) => { c.sig = ''; });
        return ok;
      });
      this.master = this.ms.master;
      this.masterIn = this.ms.input;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  /**
   * Master: margen de volumen → volumen general → compresor/limitador → recorte suave.
   * El recorte suave evita los "tronidos" de saturación digital cuando muchas pistas suman demasiado.
   */
  buildMaster(ctx) {
    const input = ctx.createGain();
    input.gain.value = 0.8;                    // margen (headroom) para sumar muchas pistas
    const master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6; comp.knee.value = 4; comp.ratio.value = 10;
    comp.attack.value = 0.003; comp.release.value = 0.2;
    const clip = ctx.createWaveShaper();
    clip.curve = softClipCurve();
    clip.oversample = 'none';                  // sin rebote del filtro: el techo de 0.97 se respeta exacto
    const half = ctx.createGain(); half.gain.value = 0.5;   // la curva cubre ±2 → entra a la mitad
    input.connect(master);
    const mastering = buildMastering(ctx, master, comp);   // la pulida final va antes del limitador
    comp.connect(half).connect(clip).connect(ctx.destination);
    return { ctx, input, master, mastering, reverbs: new Map() };
  }

  /** Reverb compartida por tipo: una sola para todas las pistas (mucho más ligera que una por pista). */
  reverbBus(ms, type) {
    if (ms.reverbs.has(type)) return ms.reverbs.get(type);
    const ctx = ms.ctx;
    const inp = ctx.createGain();
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 180;
    const conv = ctx.createConvolver();
    conv.buffer = makeImpulse(ctx, type);
    inp.connect(hp).connect(conv).connect(ms.input);
    ms.reverbs.set(type, inp);
    return inp;
  }

  /** Retraso real de la salida de audio (para que la voz grabada quede en su lugar). */
  recordLatency() {
    if (!this.ctx) return 0;
    return (this.ctx.baseLatency || 0) + (this.ctx.outputLatency || 0);
  }

  setMasterVolume(v) { if (this.master) this.master.gain.value = v; }

  /** Espera a que el procesador del eco angelical esté listo (solo la primera vez). */
  async ready() { this.ensure(); try { await this.workletPromise; } catch (e) {} }

  /** Cambia la masterización en vivo (mientras suena se escucha el cambio). */
  setMastering(cfg) { if (this.ms) setMastering(this.ms.mastering, cfg, this.ctx); }

  // ---------- Carga de audio ----------
  async getBuffer(audioId) {
    if (this.buffers.has(audioId)) return this.buffers.get(audioId);
    if (this.loading.has(audioId)) return this.loading.get(audioId);
    const p = (async () => {
      let buf;
      if (audioId.startsWith('demo:')) {
        buf = await synthDemo(audioId.slice(5));
      } else {
        const rec = await loadAudio(audioId);
        if (!rec) throw new Error('Audio no encontrado: ' + audioId);
        const data = await rec.blob.arrayBuffer();
        buf = await this.decode(data);
      }
      this.buffers.set(audioId, buf);
      this.peaks.set(audioId, computePeaks(buf));
      return buf;
    })();
    this.loading.set(audioId, p);
    try { return await p; } finally { this.loading.delete(audioId); }
  }

  decode(arrayBuffer) {
    const ctx = this.ensure();
    return new Promise((res, rej) => ctx.decodeAudioData(arrayBuffer, res, rej));
  }

  async addBuffer(audioId, arrayBuffer) {
    const buf = await this.decode(arrayBuffer);
    this.buffers.set(audioId, buf);
    this.peaks.set(audioId, computePeaks(buf));
    return buf;
  }

  async loadProject(project) {
    const ids = new Set();
    project.tracks.forEach((t) => t.regions.forEach((r) => ids.add(r.audioId)));
    await Promise.all([...ids].map((id) => this.getBuffer(id).catch(() => null)));
  }

  // ---------- Cadena de cada pista ----------
  buildChain(ms, track) {
    const ctx = ms.ctx;
    const input = ctx.createGain();
    const vol = ctx.createGain();
    const pan = ctx.createStereoPanner();
    vol.connect(pan).connect(ms.input);
    const chain = { ms, input, vol, pan, fx: [], sig: '' };
    this.wireEffects(ctx, chain, track);
    return chain;
  }

  /** La reverb de una pista: la señal sigue seca por la cadena y una parte se "envía" a la reverb compartida. */
  reverbSend(chain) {
    const ctx = chain.ms.ctx;
    const dry = ctx.createGain(), send = ctx.createGain();
    chain.pan.connect(send);
    let type = null;
    return {
      input: dry, output: dry, send,
      set: (p) => {
        const mix = p.mix / 100;
        dry.gain.value = 1 - mix * 0.5;
        send.gain.value = mix * 1.4;
        if (p.type !== type) {
          try { send.disconnect(); } catch (e) {}
          send.connect(this.reverbBus(chain.ms, p.type));
          type = p.type;
        }
      },
    };
  }

  wireEffects(ctx, chain, track) {
    chain.input.disconnect();
    chain.fx.forEach((f) => {
      try { f.node.output.disconnect(); } catch (e) {}
      if (f.node.send) { try { chain.pan.disconnect(f.node.send); f.node.send.disconnect(); } catch (e) {} }
    });
    chain.fx = [];
    let last = chain.input;
    (track.effects || []).forEach((e) => {
      if (!e.enabled || !EFFECTS[e.type]) return;
      const node = e.type === 'reverb' ? this.reverbSend(chain) : EFFECTS[e.type].build(ctx);
      node.set(e.params);
      last.connect(node.input);
      last = node.output;
      chain.fx.push({ id: e.id, node });
    });
    last.connect(chain.vol);
    chain.sig = effectSignature(track);
  }

  /** Aplica volumen, paneo, mute/solo y efectos sin cortar la reproducción. */
  syncMix(project) {
    if (!this.ctx) return;
    const anySolo = project.tracks.some((t) => t.solo);
    const now = this.ctx.currentTime;
    project.tracks.forEach((t) => {
      let chain = this.chains.get(t.id);
      if (!chain) { chain = this.buildChain(this.ms, t); this.chains.set(t.id, chain); }
      const audible = !t.muted && (!anySolo || t.solo);
      chain.vol.gain.setTargetAtTime(audible ? t.volume : 0, now, 0.015);
      chain.pan.pan.setTargetAtTime(t.pan, now, 0.015);
      if (chain.sig !== effectSignature(t)) {
        this.wireEffects(this.ctx, chain, t);
      } else {
        const enabled = (t.effects || []).filter((e) => e.enabled && EFFECTS[e.type]);
        enabled.forEach((e, i) => chain.fx[i] && chain.fx[i].node.set(e.params));
      }
    });
    // Pistas borradas
    for (const [id, chain] of this.chains) {
      if (!project.tracks.some((t) => t.id === id)) { chain.vol.disconnect(); chain.pan.disconnect(); this.chains.delete(id); }
    }
  }

  // ---------- Reproducción ----------
  get position() {
    if (!this.playing || !this.ctx) return this.startPos;
    return this.startPos + (this.ctx.currentTime - this.startCtxTime);
  }

  /** Posición suave para dibujar: usa el reloj de la pantalla en vez de los "saltitos" del reloj de audio. */
  visualPosition() {
    if (!this.playing || !this.ctx) return this.startPos;
    const now = performance.now();
    const ts = this.ctx.getOutputTimestamp ? this.ctx.getOutputTimestamp() : null;
    let ctxTime;
    if (ts && ts.performanceTime > 0 && ts.contextTime > 0) {
      ctxTime = ts.contextTime + (now - ts.performanceTime) / 1000;
    } else {
      ctxTime = this.ctx.currentTime;
    }
    const audio = this.startPos + (ctxTime - this.startCtxTime);
    if (audio <= this.startPos) return this.startPos;
    // Reloj liso: avanza con el reloj de la pantalla (parejito, sin saltos) y se va
    // corrigiendo poquito a poco contra el reloj del audio, que en Android avanza "a brincos".
    const c = this._clk;
    if (!c) { this._clk = { base: audio, t: now }; this._lastVis = audio; return audio; }
    let p = c.base + (now - c.t) / 1000;
    const err = audio - p;
    if (Math.abs(err) > 0.25) { c.base = audio; c.t = now; p = audio; }
    else { c.base += err * 0.03; p += err * 0.03; }
    if (p < this._lastVis) p = this._lastVis; // nunca hacia atrás
    this._lastVis = p;
    return p;
  }

  play(project, from) {
    this._lastVis = undefined;
    this._clk = null;
    const ctx = this.ensure();
    this.stopSources();
    this.syncMix(project);
    this.bpm = project.bpm;
    const t0 = ctx.currentTime + 0.06;
    this.startCtxTime = t0;
    this.startPos = from;
    this.playing = true;
    project.tracks.forEach((t) => {
      const chain = this.chains.get(t.id);
      t.regions.forEach((r) => {
        const buf = this.buffers.get(r.audioId);
        if (!buf) return;
        const end = r.start + r.length;
        if (end <= from) return;
        const skip = Math.max(0, from - r.start);
        const when = t0 + Math.max(0, r.start - from);
        const offset = r.offset + skip;
        const dur = r.length - skip;
        if (dur <= 0 || offset >= buf.duration) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain();
        g.gain.value = r.gain ?? 1;
        src.connect(g).connect(chain.input);
        src.start(when, offset, Math.min(dur, buf.duration - offset));
        this.sources.push(src);
      });
    });
    if (this.metronome) this.startMetronome(from, t0);
  }

  stopSources() {
    this.sources.forEach((s) => { try { s.stop(); } catch (e) {} });
    this.sources = [];
    clearInterval(this.metroTimer);
  }

  stop() {
    const pos = this.position;
    this.stopSources();
    this.playing = false;
    this.startPos = pos;
    return pos;
  }

  // ---------- Metrónomo ----------
  startMetronome(from, t0) {
    const beat = 60 / this.bpm;
    let n = Math.ceil(from / beat - 1e-6);
    const schedule = () => {
      const horizon = this.ctx.currentTime + 0.2;
      while (true) {
        const when = t0 + (n * beat - from);
        if (when > horizon) break;
        if (when >= this.ctx.currentTime - 0.01) this.click(when, n % 4 === 0);
        n++;
      }
    };
    schedule();
    this.metroTimer = setInterval(schedule, 40);
  }

  click(when, accent) {
    const ctx = this.ctx;
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1500 : 1000;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.5 : 0.3, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g).connect(this.ctx.destination);
    o.start(when); o.stop(when + 0.06);
  }

  // ---------- Grabación ----------
  async startRecording() {
    this.ensure();
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const types = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t)) || '';
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const chunks = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    this.recorder = { rec, stream, chunks, mimeType };
    rec.start();
  }

  stopRecording() {
    return new Promise((resolve) => {
      const r = this.recorder;
      if (!r) return resolve(null);
      r.rec.onstop = () => {
        r.stream.getTracks().forEach((t) => t.stop());
        this.recorder = null;
        resolve(new Blob(r.chunks, { type: r.mimeType || 'audio/webm' }));
      };
      r.rec.stop();
    });
  }

  // ---------- Nivelar volumen (sonoridad LUFS, estándar ITU BS.1770 / EBU R128) ----------
  /** Energía de bloques de 400 ms de una región, filtrada como la escucha el oído (K-weighting). */
  async loudnessBlocks(r) {
    const buf = await this.getBuffer(r.audioId);
    const sr = 24000;
    const len = Math.max(1, Math.ceil(Math.min(r.length, buf.duration - r.offset) * sr));
    const ctx = new OfflineAudioContext(buf.numberOfChannels, len, sr);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const shelf = ctx.createBiquadFilter(); shelf.type = 'highshelf'; shelf.frequency.value = 1681; shelf.gain.value = 4;
    const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 38; hp.Q.value = 0.5;
    src.connect(shelf).connect(hp).connect(ctx.destination);
    src.start(0, r.offset, r.length);
    const out = await ctx.startRendering();
    // Sumas acumuladas de x² para medir cada bloque al instante
    const n = out.length, cum = new Float64Array(n + 1);
    for (let c = 0; c < out.numberOfChannels; c++) {
      const d = out.getChannelData(c);
      let acc = 0;
      for (let i = 0; i < n; i++) { acc += d[i] * d[i]; cum[i + 1] += acc; }
    }
    const g2 = Math.pow(r.gain ?? 1, 2);
    const block = Math.round(0.4 * sr), hop = Math.round(0.1 * sr), blocks = [];
    if (n < block) blocks.push((cum[n] / n) * g2);
    for (let s0 = 0; s0 + block <= n; s0 += hop) blocks.push(((cum[s0 + block] - cum[s0]) / block) * g2);
    return blocks;
  }

  /** Sonoridad integrada en LUFS de una pista (todas sus regiones juntas). -Infinity si está en silencio. */
  async trackLoudness(track) {
    let blocks = [];
    for (const r of track.regions) blocks = blocks.concat(await this.loudnessBlocks(r));
    const L = (ms) => -0.691 + 10 * Math.log10(ms);
    const abs = blocks.filter((ms) => ms > 0 && L(ms) > -70);          // compuerta absoluta: quita silencios
    if (!abs.length) return -Infinity;
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    const rel = L(mean(abs)) - 10;                                       // compuerta relativa: quita partes muy bajitas
    const gated = abs.filter((ms) => L(ms) > rel);
    return L(mean(gated.length ? gated : abs));
  }

  // ---------- Exportar ----------
  async exportWav(project) {
    await this.loadProject(project);
    const end = projectEnd(project);
    if (end <= 0) throw new Error('El proyecto no tiene audio');
    const rate = 44100;
    const length = Math.ceil((end + 1.5) * rate);
    const ctx = new OfflineAudioContext(2, length, rate);
    await loadWorklet(ctx);
    const ms = this.buildMaster(ctx);
    ms.master.gain.value = project.masterVolume ?? 1;
    setMastering(ms.mastering, project.mastering, ctx);
    const anySolo = project.tracks.some((t) => t.solo);
    project.tracks.forEach((t) => {
      const chain = this.buildChain(ms, t);
      chain.vol.gain.value = !t.muted && (!anySolo || t.solo) ? t.volume : 0;
      chain.pan.pan.value = t.pan;
      t.regions.forEach((r) => {
        const buf = this.buffers.get(r.audioId);
        if (!buf) return;
        const src = ctx.createBufferSource();
        src.buffer = buf;
        const g = ctx.createGain(); g.gain.value = r.gain ?? 1;
        src.connect(g).connect(chain.input);
        src.start(r.start, r.offset, Math.min(r.length, buf.duration - r.offset));
      });
    });
    const rendered = await ctx.startRendering();
    return encodeWav(rendered);
  }
}

export function projectEnd(project) {
  let end = 0;
  project.tracks.forEach((t) => t.regions.forEach((r) => { end = Math.max(end, r.start + r.length); }));
  return end;
}

function effectSignature(track) {
  return (track.effects || []).filter((e) => e.enabled).map((e) => e.id + e.type).join('|');
}

const WORKLET_URL = new URL('./pitch-worklet.js', import.meta.url);
async function loadWorklet(ctx) {
  if (!ctx.audioWorklet) return false;
  try { await ctx.audioWorklet.addModule(WORKLET_URL); ctx._pitchReady = true; return true; }
  catch (e) { console.warn('Shimmer sin cambio de tono:', e); return false; }
}

function softClipCurve() {
  // La entrada se interpreta en el rango ±2: hasta 0.9 pasa limpia y arriba se redondea con suavidad hacia 1.
  const n = 4096, c = new Float32Array(n), knee = 0.9;
  for (let i = 0; i < n; i++) {
    const x = ((i / (n - 1)) * 2 - 1) * 2, a = Math.abs(x);
    const y = a <= knee ? a : knee + (1 - knee) * Math.tanh((a - knee) / (1 - knee));
    c[i] = Math.sign(x) * y * 0.97;          // techo en 0.97: nunca toca el máximo digital
  }
  return c;
}

// ---------- Forma de onda ----------
function computePeaks(buf) {
  const n = Math.max(1, Math.ceil(buf.duration * PEAKS_PER_SEC));
  const min = new Float32Array(n), max = new Float32Array(n);
  const chans = [];
  for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
  const step = buf.length / n;
  for (let i = 0; i < n; i++) {
    let lo = 0, hi = 0;
    const a = Math.floor(i * step), b = Math.min(buf.length, Math.floor((i + 1) * step));
    const stride = Math.max(1, Math.floor((b - a) / 64));
    for (const d of chans) {
      for (let j = a; j < b; j += stride) { const v = d[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    min[i] = lo; max[i] = hi;
  }
  return { min, max, rate: PEAKS_PER_SEC };
}

// ---------- WAV ----------
export function encodeWav(buf) {
  const ch = buf.numberOfChannels, rate = buf.sampleRate, len = buf.length;
  const bytes = 44 + len * ch * 2;
  const view = new DataView(new ArrayBuffer(bytes));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); view.setUint32(4, bytes - 8, true); str(8, 'WAVE');
  str(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, ch, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate * ch * 2, true); view.setUint16(32, ch * 2, true); view.setUint16(34, 16, true);
  str(36, 'data'); view.setUint32(40, len * ch * 2, true);
  const data = []; for (let c = 0; c < ch; c++) data.push(buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]));
      view.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true); o += 2;
    }
  }
  return new Blob([view], { type: 'audio/wav' });
}

// ---------- Canción demo sintetizada (para escuchar algo desde el primer momento) ----------
const DEMO_BPM = 96;
const DEMO_BARS = 8;
const midi = (n) => 440 * Math.pow(2, (n - 69) / 12);
const CHORDS = [[57, 60, 64], [53, 57, 60], [48, 52, 55], [55, 59, 62]]; // Am F C G

async function synthDemo(part) {
  const rate = 22050, beat = 60 / DEMO_BPM, bar = beat * 4, total = bar * DEMO_BARS;
  const ctx = new OfflineAudioContext(1, Math.ceil(total * rate), rate);
  const out = ctx.createGain(); out.connect(ctx.destination);
  const noise = ctx.createBuffer(1, rate, rate);
  const nd = noise.getChannelData(0); let s = 7;
  for (let i = 0; i < nd.length; i++) { s = (s * 1664525 + 1013904223) >>> 0; nd[i] = s / 4294967296 * 2 - 1; }

  const env = (g, t, a, peak, d) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
  };
  const noiseHit = (t, freq, peak, d) => {
    const src = ctx.createBufferSource(); src.buffer = noise;
    const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = freq;
    const g = ctx.createGain(); env(g, t, 0.001, peak, d);
    src.connect(f).connect(g).connect(out); src.start(t); src.stop(t + d + 0.05);
  };
  const tone = (t, freq, dur, type, peak, cutoff, attack = 0.005) => {
    const o = ctx.createOscillator(); o.type = type; o.frequency.value = freq;
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = cutoff;
    const g = ctx.createGain(); env(g, t, attack, peak, dur);
    o.connect(f).connect(g).connect(out); o.start(t); o.stop(t + attack + dur + 0.05);
  };

  for (let b = 0; b < DEMO_BARS; b++) {
    const t = b * bar, chord = CHORDS[b % 4];
    if (part === 'drums') {
      [0, 2, 2.5].forEach((k) => {
        const when = t + k * beat;
        const o = ctx.createOscillator(); o.frequency.setValueAtTime(150, when); o.frequency.exponentialRampToValueAtTime(42, when + 0.12);
        const g = ctx.createGain(); env(g, when, 0.002, 0.9, 0.35);
        o.connect(g).connect(out); o.start(when); o.stop(when + 0.4);
      });
      [1, 3].forEach((k) => { noiseHit(t + k * beat, 1500, 0.45, 0.18); tone(t + k * beat, 190, 0.08, 'triangle', 0.3, 3000, 0.001); });
      for (let k = 0; k < 8; k++) noiseHit(t + k * beat / 2, 8000, k % 2 ? 0.12 : 0.2, 0.05);
    } else if (part === 'bass') {
      [0, 1.5, 2, 3].forEach((k) => tone(t + k * beat, midi(chord[0] - 24), 0.35, 'sawtooth', 0.35, 500));
    } else if (part === 'pad') {
      chord.forEach((n) => tone(t, midi(n), bar - 0.3, 'triangle', 0.09, 1800, 0.25));
    } else if (part === 'lead') {
      const scale = [69, 72, 74, 76, 79, 81];
      const pattern = [[0, 0], [1, 2], [1.5, 1], [2, 3], [3, 2], [3.5, 1]];
      pattern.forEach(([k, i]) => {
        const note = scale[(i + b) % scale.length];
        tone(t + k * beat, midi(note), beat * 0.45, 'square', 0.08, 2400);
      });
    }
  }
  return ctx.startRendering();
}

export const DEMO = { bpm: DEMO_BPM, length: (60 / DEMO_BPM) * 4 * DEMO_BARS };
