// Arcadia — efectos de audio hechos con la Web Audio API.
// Cada efecto: { label, sub, params: [{key,label,min,max,step,unit,def}], build(ctx) -> {input, output, set(params)} }

const dbToGain = (db) => Math.pow(10, db / 20);

// ---------- Reverb (estilo Univerb) ----------
export const REVERB_TYPES = {
  room:      { label: 'Cuarto pequeño',   seconds: 0.7, decay: 3.0, bright: 0.55, pre: 0.005 },
  institute: { label: 'Sala mediana',     seconds: 1.6, decay: 2.6, bright: 0.45, pre: 0.012 },
  hall:      { label: 'Sala grande',      seconds: 2.4, decay: 2.2, bright: 0.40, pre: 0.020 },
  cathedral: { label: 'Catedral',         seconds: 3.6, decay: 1.8, bright: 0.35, pre: 0.030 },
  plate:     { label: 'Plate (placa)',    seconds: 1.9, decay: 2.4, bright: 0.85, pre: 0.000 },
  spring:    { label: 'Resorte vintage',  seconds: 1.5, decay: 2.8, bright: 0.65, pre: 0.000, spring: true },
  shimmer:   { label: 'Shimmer', seconds: 4.2, decay: 1.7, bright: 0.8, pre: 0.02, hidden: true },
};

const impulseCache = new Map();
export function makeImpulse(ctx, typeKey) {
  const cacheKey = typeKey + '@' + ctx.sampleRate;
  if (impulseCache.has(cacheKey) && ctx instanceof AudioContext) return impulseCache.get(cacheKey);
  const t = REVERB_TYPES[typeKey] || REVERB_TYPES.institute;
  const rate = ctx.sampleRate;
  const len = Math.floor(rate * t.seconds);
  const pre = Math.floor(rate * t.pre);
  const buf = ctx.createBuffer(2, len + pre, rate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let lp = 0;
    // Semilla fija por canal: el mismo tipo siempre suena igual.
    let seed = 12345 + ch * 777 + typeKey.length * 31;
    const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296 * 2 - 1; };
    for (let i = 0; i < len; i++) {
      const p = i / len;
      let n = rnd();
      // Filtro paso bajo que se cierra con el tiempo: la cola se oscurece, como en una sala real.
      const k = t.bright * (1 - p * 0.7);
      lp = lp + k * (n - lp);
      let v = lp * Math.pow(1 - p, t.decay);
      if (t.spring) v *= 1 + 0.45 * Math.sin(i / rate * 2 * Math.PI * 9 * (1 + p));
      d[i + pre] = v;
    }
  }
  if (ctx instanceof AudioContext) impulseCache.set(cacheKey, buf);
  return buf;
}

function reverb(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(), wet = ctx.createGain();
  const conv = ctx.createConvolver();
  const tone = ctx.createBiquadFilter(); tone.type = 'highpass'; tone.frequency.value = 180;
  input.connect(dry).connect(output);
  input.connect(tone).connect(conv).connect(wet).connect(output);
  let currentType = null;
  return {
    input, output,
    set(p) {
      const mix = p.mix / 100;
      dry.gain.value = 1 - mix * 0.5;
      wet.gain.value = mix * 1.4;
      if (p.type !== currentType) { conv.buffer = makeImpulse(ctx, p.type); currentType = p.type; }
    },
  };
}

// ---------- Exciter (estilo Aphex Aural Exciter) ----------
function makeCurve(drive) {
  const n = 2048, curve = new Float32Array(n);
  const k = 1 + drive * 30;
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    // Saturación asimétrica suave: crea armónicos pares e impares (el "brillo").
    curve[i] = Math.tanh(k * x + 0.15 * k * x * x) / Math.tanh(k);
  }
  return curve;
}

function exciter(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const hp1 = ctx.createBiquadFilter(); hp1.type = 'highpass'; hp1.Q.value = 0.7;
  const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.Q.value = 0.7;
  const pre = ctx.createGain();
  const shaper = ctx.createWaveShaper(); shaper.oversample = '2x';
  const post = ctx.createBiquadFilter(); post.type = 'highpass'; post.Q.value = 0.5;
  const mixGain = ctx.createGain();
  input.connect(output); // señal original intacta
  input.connect(hp1).connect(hp2).connect(pre).connect(shaper).connect(post).connect(mixGain).connect(output);
  return {
    input, output,
    set(p) {
      hp1.frequency.value = hp2.frequency.value = p.tune;
      post.frequency.value = p.tune;
      pre.gain.value = dbToGain(-p.threshold);
      shaper.curve = makeCurve(p.harmonics / 100);
      mixGain.gain.value = dbToGain(p.mix) * 1.6;
    },
  };
}

// ---------- Agudos (Treble boost) ----------
function treble(ctx) {
  const f = ctx.createBiquadFilter(); f.type = 'highshelf';
  return { input: f, output: f, set(p) { f.frequency.value = p.freq; f.gain.value = p.gain; } };
}

// ---------- Ecualizador de 3 bandas ----------
function eq3(ctx) {
  const lo = ctx.createBiquadFilter(); lo.type = 'lowshelf'; lo.frequency.value = 150;
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.Q.value = 0.9;
  const hi = ctx.createBiquadFilter(); hi.type = 'highshelf'; hi.frequency.value = 8000;
  lo.connect(mid).connect(hi);
  return {
    input: lo, output: hi,
    set(p) { lo.gain.value = p.low; mid.gain.value = p.mid; mid.frequency.value = p.midFreq; hi.gain.value = p.high; },
  };
}

// ---------- Compresor ----------
function compressor(ctx) {
  const c = ctx.createDynamicsCompressor();
  const makeup = ctx.createGain();
  c.connect(makeup);
  return {
    input: c, output: makeup,
    set(p) {
      c.threshold.value = p.threshold; c.ratio.value = p.ratio; c.knee.value = 6;
      c.attack.value = p.attack / 1000; c.release.value = p.release / 1000;
      makeup.gain.value = dbToGain(p.makeup);
    },
  };
}

// ---------- Delay (eco) ----------
function delay(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const d = ctx.createDelay(2.0), fb = ctx.createGain(), wet = ctx.createGain();
  const tone = ctx.createBiquadFilter(); tone.type = 'lowpass'; tone.frequency.value = 5000;
  input.connect(output);
  input.connect(d); d.connect(tone).connect(fb).connect(d); d.connect(wet).connect(output);
  return { input, output, set(p) { d.delayTime.value = p.time / 1000; fb.gain.value = p.feedback / 100; wet.gain.value = p.mix / 100; } };
}

// ---------- Shimmer: eco angelical ----------
// Reverb larga y brillante cuya cola se sube una octava (pitch shifter) y vuelve a entrar a la reverb.
function shimmer(ctx) {
  const input = ctx.createGain(), output = ctx.createGain();
  const dry = ctx.createGain(), wet = ctx.createGain(), sum = ctx.createGain();
  const pre = ctx.createBiquadFilter(); pre.type = 'highpass'; pre.frequency.value = 300;
  const conv = ctx.createConvolver(); conv.buffer = makeImpulse(ctx, 'shimmer');
  const fb = ctx.createGain(), fbDelay = ctx.createDelay(1); fbDelay.delayTime.value = 0.05;
  const fbTone = ctx.createBiquadFilter(); fbTone.type = 'lowpass'; fbTone.frequency.value = 7000;
  const sparkle = ctx.createGain();
  input.connect(dry).connect(output);
  input.connect(pre).connect(sum).connect(conv).connect(wet).connect(output);
  let shifter = null;
  if (ctx._pitchReady) {
    shifter = new AudioWorkletNode(ctx, 'pitch-shift', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
    conv.connect(shifter);                                     // la cola de la reverb…
    shifter.connect(fbTone).connect(fb).connect(fbDelay).connect(sum);   // …una octava arriba vuelve a entrar
    pre.connect(sparkle).connect(fbDelay);                     // un poquito de la voz una octava arriba
  }
  return {
    input, output,
    set(p) {
      const mix = p.mix / 100, amt = p.amount / 100;
      dry.gain.value = 1 - mix * 0.4;
      wet.gain.value = mix * 1.3;
      fb.gain.value = amt * 0.55;          // < 0.6: brillante pero estable
      sparkle.gain.value = amt * 0.25;
    },
  };
}

// ---------- Filtro limpiador (quita graves sucios) ----------
function cleanup(ctx) {
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.Q.value = 0.7;
  return { input: f, output: f, set(p) { f.frequency.value = p.freq; } };
}

export const EFFECTS = {
  reverb: {
    label: 'Univerb', sub: 'Reverb', build: reverb,
    params: [
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, unit: '%', def: 35 },
      { key: 'type', label: 'Type', options: Object.fromEntries(Object.entries(REVERB_TYPES).filter(([, v]) => !v.hidden).map(([k, v]) => [k, v.label])), def: 'institute' },
    ],
  },
  exciter: {
    label: 'Exciter', sub: 'Vintage Aural Exciter', build: exciter,
    params: [
      { key: 'tune', label: 'Tune', min: 700, max: 7000, step: 50, unit: 'Hz', def: 7000 },
      { key: 'harmonics', label: 'Harmonics', min: 0, max: 100, step: 0.5, unit: '%', def: 0 },
      { key: 'threshold', label: 'Threshold', min: -30, max: 0, step: 0.1, unit: '', def: 0 },
      { key: 'mix', label: 'Mix', min: -30, max: 0, step: 0.1, unit: '', def: -10.1 },
    ],
  },
  treble: {
    label: 'Agudos', sub: 'Treble Boost', build: treble,
    params: [
      { key: 'gain', label: 'Brillo', min: 0, max: 12, step: 0.5, unit: 'dB', def: 4 },
      { key: 'freq', label: 'Desde', min: 2000, max: 12000, step: 100, unit: 'Hz', def: 6000 },
    ],
  },
  eq: {
    label: 'Ecualizador', sub: 'EQ de 3 bandas', build: eq3,
    params: [
      { key: 'low', label: 'Graves', min: -12, max: 12, step: 0.5, unit: 'dB', def: 0 },
      { key: 'mid', label: 'Medios', min: -12, max: 12, step: 0.5, unit: 'dB', def: 0 },
      { key: 'midFreq', label: 'Frecuencia de medios', min: 300, max: 4000, step: 50, unit: 'Hz', def: 1000 },
      { key: 'high', label: 'Agudos', min: -12, max: 12, step: 0.5, unit: 'dB', def: 0 },
    ],
  },
  compressor: {
    label: 'Compresor', sub: 'Iguala el volumen', build: compressor,
    params: [
      { key: 'threshold', label: 'Threshold', min: -50, max: 0, step: 1, unit: 'dB', def: -18 },
      { key: 'ratio', label: 'Ratio', min: 1, max: 20, step: 0.5, unit: ':1', def: 4 },
      { key: 'attack', label: 'Attack', min: 1, max: 100, step: 1, unit: 'ms', def: 10 },
      { key: 'release', label: 'Release', min: 20, max: 1000, step: 10, unit: 'ms', def: 200 },
      { key: 'makeup', label: 'Ganancia', min: 0, max: 18, step: 0.5, unit: 'dB', def: 4 },
    ],
  },
  delay: {
    label: 'Delay', sub: 'Eco', build: delay,
    params: [
      { key: 'time', label: 'Tiempo', min: 20, max: 1500, step: 10, unit: 'ms', def: 320 },
      { key: 'feedback', label: 'Repeticiones', min: 0, max: 90, step: 1, unit: '%', def: 30 },
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, unit: '%', def: 25 },
    ],
  },
  shimmer: {
    label: 'Shimmer', sub: 'Eco angelical', build: shimmer,
    params: [
      { key: 'mix', label: 'Mix', min: 0, max: 100, step: 1, unit: '%', def: 35 },
      { key: 'amount', label: 'Brillo angelical', min: 0, max: 100, step: 1, unit: '%', def: 60 },
    ],
  },
  cleanup: {
    label: 'Limpiador', sub: 'Quita graves sucios', build: cleanup,
    params: [{ key: 'freq', label: 'Corte', min: 20, max: 400, step: 5, unit: 'Hz', def: 90 }],
  },
};

export function defaultParams(type) {
  return Object.fromEntries(EFFECTS[type].params.map((p) => [p.key, p.def]));
}

/** Presets: cadenas de efectos listas, como en BandLab. */
export const PRESETS = [
  { name: 'Brillo + RV', effects: [
    { type: 'exciter', params: { tune: 7000, harmonics: 0, threshold: 0, mix: -10.1 } },
    { type: 'reverb', params: { mix: 35, type: 'institute' } },
  ] },
  { name: 'Voz limpia', effects: [
    { type: 'cleanup', params: { freq: 100 } },
    { type: 'compressor', params: { threshold: -20, ratio: 4, attack: 8, release: 180, makeup: 5 } },
    { type: 'treble', params: { gain: 3, freq: 7000 } },
  ] },
  { name: 'Voz trap', effects: [
    { type: 'cleanup', params: { freq: 110 } },
    { type: 'compressor', params: { threshold: -24, ratio: 6, attack: 5, release: 120, makeup: 7 } },
    { type: 'exciter', params: { tune: 5000, harmonics: 15, threshold: 0, mix: -12 } },
    { type: 'delay', params: { time: 310, feedback: 25, mix: 15 } },
    { type: 'reverb', params: { mix: 20, type: 'plate' } },
  ] },
  { name: 'Sala grande', effects: [{ type: 'reverb', params: { mix: 45, type: 'hall' } }] },
  { name: 'Voz angelical', effects: [
    { type: 'cleanup', params: { freq: 100 } },
    { type: 'compressor', params: { threshold: -20, ratio: 3, attack: 10, release: 200, makeup: 4 } },
    { type: 'exciter', params: { tune: 6000, harmonics: 10, threshold: 0, mix: -12 } },
    { type: 'shimmer', params: { mix: 40, amount: 65 } },
  ] },
];
