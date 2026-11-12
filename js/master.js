// Arcadia — masterización: la "pulida final" de toda la canción.
// Cadena: graves → medios → agudos → aire → compresor de pegamento → volumen final.
// Cada preset dice cuánto mover cada cosa al 100 % de intensidad; la perilla de intensidad lo escala.

export const MASTER_PRESETS = {
  universal: { label: 'Universal', desc: 'Equilibrado, sirve para casi todo', low: 1.5, mid: 0, high: 1.5, air: 2, thr: -18, ratio: 2.5, attack: 0.02, gain: 4 },
  urbano:    { label: 'Urbano (trap / reggaetón)', desc: 'Graves que pegan y voz al frente', low: 4, mid: -1.5, high: 2, air: 2, thr: -24, ratio: 4, attack: 0.008, gain: 7 },
  brillante: { label: 'Brillante', desc: 'Más claro y con aire, ideal para voces', low: 0, mid: -1, high: 3, air: 4, thr: -18, ratio: 2.5, attack: 0.02, gain: 4 },
  calido:    { label: 'Cálido', desc: 'Más cuerpo y suave en los agudos', low: 3, mid: -0.5, high: -1, air: 0, thr: -20, ratio: 2, attack: 0.03, gain: 3.5 },
  suave:     { label: 'Suave / Acústico', desc: 'Natural, casi sin tocar', low: 1, mid: 0, high: 1, air: 1, thr: -14, ratio: 1.8, attack: 0.03, gain: 2 },
};

export function defaultMastering() {
  return { enabled: false, preset: 'universal', intensity: 70, low: 0, mid: 0, high: 0 };
}

/** Crea los nodos del master entre `from` y `to`. Devuelve un objeto para actualizarlos. */
export function buildMastering(ctx, from, to) {
  const low = ctx.createBiquadFilter(); low.type = 'lowshelf'; low.frequency.value = 110;
  const mid = ctx.createBiquadFilter(); mid.type = 'peaking'; mid.frequency.value = 1000; mid.Q.value = 0.8;
  const high = ctx.createBiquadFilter(); high.type = 'highshelf'; high.frequency.value = 6000;
  const air = ctx.createBiquadFilter(); air.type = 'highshelf'; air.frequency.value = 12000;
  const comp = ctx.createDynamicsCompressor(); comp.knee.value = 8; comp.release.value = 0.25;
  const gain = ctx.createGain();
  from.connect(low).connect(mid).connect(high).connect(air).connect(comp).connect(gain).connect(to);
  const m = { low, mid, high, air, comp, gain };
  setMastering(m, defaultMastering(), ctx);
  return m;
}

/** Aplica una configuración (preset + intensidad + ecualizador final). Sin cortar el audio. */
export function setMastering(m, cfg, ctx) {
  const on = cfg && cfg.enabled;
  const p = MASTER_PRESETS[(cfg && cfg.preset) || 'universal'] || MASTER_PRESETS.universal;
  const k = on ? (cfg.intensity ?? 70) / 100 : 0;
  const t = ctx.currentTime || 0;
  const offline = typeof OfflineAudioContext !== 'undefined' && ctx instanceof OfflineAudioContext;
  const set = (param, v) => (offline ? (param.value = v) : param.setTargetAtTime(v, t, 0.03));
  set(m.low.gain, p.low * k + (on ? cfg.low || 0 : 0));
  set(m.mid.gain, p.mid * k + (on ? cfg.mid || 0 : 0));
  set(m.high.gain, p.high * k + (on ? cfg.high || 0 : 0));
  set(m.air.gain, p.air * k);
  set(m.comp.threshold, p.thr * k);
  set(m.comp.ratio, 1 + (p.ratio - 1) * k);
  m.comp.attack.value = p.attack;
  set(m.gain.gain, Math.pow(10, (p.gain * k) / 20));
}
