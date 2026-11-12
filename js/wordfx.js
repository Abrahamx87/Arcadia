// Arcadia — "Pídelo con palabras": convierte lo que escribes en español en una cadena de efectos.
// Ejemplos: "voz trap con mucho eco", "balada con reverb de iglesia", "voz angelical", "voz de radio".
// Entiende estilos (trap, balada, rock…), cosas que quieres (eco, brillo, graves…) y cuánto (poco, mucho).

import { defaultParams } from './effects.js';

const norm = (t) => t.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const has = (t, words) => words.some((w) => t.includes(w));

// Orden profesional de la cadena: limpiar → tono → dinámica → brillo → espacio
const ORDER = ['cleanup', 'eq', 'compressor', 'exciter', 'treble', 'delay', 'reverb', 'shimmer'];

export function effectsFromWords(text) {
  const t = norm(text || '');
  const fx = {};
  const notes = [];
  const add = (type, params, why) => { fx[type] = { ...defaultParams(type), ...(fx[type] || {}), ...params }; if (why) notes.push(why); };

  // ¿Cuánto?
  let amt = 1;
  if (has(t, ['mucho', 'muchisimo', 'bastante', 'muy ', 'full', 'exagerad', 'fuerte', 'demasiad', 'harto'])) amt = 1.4;
  if (has(t, ['poco', 'poquito', 'suave', 'ligero', 'ligera', 'sutil', 'leve', 'tantito'])) amt = 0.6;
  const k = (v) => Math.round(v * amt * 10) / 10;

  // ---------- Estilos ----------
  if (has(t, ['trap', 'rap', 'hip hop', 'hiphop', 'drill', 'reggaeton', 'regueton', 'urbano', 'dembow', 'corrido tumbado'])) {
    add('cleanup', { freq: 110 });
    add('compressor', { threshold: -24, ratio: 6, attack: 5, release: 120, makeup: 7 });
    add('exciter', { tune: 5000, harmonics: 15, threshold: 0, mix: -12 });
    add('delay', { time: 310, feedback: 22, mix: 12 });
    add('reverb', { mix: 18, type: 'plate' }, 'estilo urbano');
  }
  if (has(t, ['balada', 'romantic', 'pop', 'bolero', 'lenta'])) {
    add('cleanup', { freq: 90 });
    add('compressor', { threshold: -20, ratio: 3, attack: 12, release: 220, makeup: 4 });
    add('treble', { gain: 3, freq: 7000 });
    add('reverb', { mix: 35, type: 'hall' }, 'estilo balada');
  }
  if (has(t, ['rock', 'metal', 'punk'])) {
    add('compressor', { threshold: -22, ratio: 5, attack: 8, release: 150, makeup: 6 });
    add('eq', { low: 1, mid: 3, midFreq: 1800, high: 1 });
    add('reverb', { mix: 18, type: 'room' }, 'estilo rock');
  }
  if (has(t, ['acustic', 'natural', 'intim', 'susurr', 'cerca'])) {
    add('cleanup', { freq: 80 });
    add('compressor', { threshold: -18, ratio: 2.5, attack: 15, release: 250, makeup: 3 });
    add('reverb', { mix: 15, type: 'room' }, 'sonido natural');
  }
  if (has(t, ['lofi', 'lo-fi', 'lo fi', 'vieja', 'antigua', 'vintage', 'retro'])) {
    add('eq', { low: 2, mid: 1, midFreq: 900, high: -8 });
    add('reverb', { mix: 22, type: 'spring' }, 'sonido vintage');
  }
  if (has(t, ['radio', 'telefono', 'celular', 'megafono', 'altavoz'])) {
    add('cleanup', { freq: 400 });
    add('eq', { low: -12, mid: 6, midFreq: 1500, high: -10 }, 'voz de radio');
  }

  // ---------- Lo que pides ----------
  if (has(t, ['eco', 'echo', 'delay', 'repit', 'repeticion', 'rebote'])) add('delay', { time: 330, feedback: k(32), mix: k(22) }, 'eco');
  if (has(t, ['iglesia', 'catedral', 'templo'])) add('reverb', { mix: k(42), type: 'cathedral' }, 'reverb de iglesia');
  else if (has(t, ['estadio', 'concierto', 'sala grande', 'grande', 'amplia', 'espacio', 'lejos', 'lejana'])) add('reverb', { mix: k(38), type: 'hall' }, 'reverb grande');
  else if (has(t, ['cuarto', 'chica', 'pequen', 'seca'])) add('reverb', { mix: k(18), type: 'room' }, 'reverb de cuarto');
  else if (has(t, ['reverb', 'reverberacion', 'ambiente', 'profund'])) add('reverb', { mix: k(32), type: 'institute' }, 'reverb');
  if (has(t, ['angel', 'celestial', 'cielo', 'etere', 'divin', 'shimmer', 'magic', 'sueno', 'sonad'])) add('shimmer', { mix: k(38), amount: Math.min(100, k(62)) }, 'eco angelical');
  if (has(t, ['brill', 'clara', 'claro', 'limpi', 'cristal', 'aire', 'nitid', 'presencia'])) {
    add('exciter', { tune: 7000, harmonics: k(8), threshold: 0, mix: -10 });
    add('treble', { gain: k(3), freq: 7000 }, 'brillo');
  }
  if (has(t, ['grave', 'gruesa', 'grueso', 'cuerpo', 'calida', 'calido', 'profunda voz', 'gorda'])) add('eq', { low: k(4), mid: 0, midFreq: 1000, high: 0 }, 'más cuerpo');
  if (has(t, ['oscura', 'opaca', 'menos brillo', 'sin brillo'])) add('eq', { low: 1, mid: 0, midFreq: 1000, high: -k(5) }, 'más oscura');
  if (has(t, ['al frente', 'adelante', 'presente', 'pegue', 'pegada', 'que se escuche', 'que resalte', 'resalt', 'potente', 'fuerte', 'pareja', 'nivelad'])) {
    add('compressor', { threshold: -24, ratio: k(5) > 8 ? 8 : k(5), attack: 6, release: 150, makeup: k(6) }, 'voz al frente');
  }
  if (has(t, ['ruido', 'limpia', 'limpiar', 'zumbido', 'sucia'])) add('cleanup', { freq: 120 }, 'limpieza');

  // Siempre: si es una voz y no hay limpieza, un limpiador suave ayuda
  const isVoice = has(t, ['voz', 'vocal', 'cant', 'coro', 'rap']);
  if (isVoice && !fx.cleanup && Object.keys(fx).length) add('cleanup', { freq: 90 });

  // Nada reconocido → un punto de partida razonable
  if (!Object.keys(fx).length) {
    add('compressor', { threshold: -20, ratio: 3, attack: 10, release: 200, makeup: 4 });
    add('reverb', { mix: 25, type: 'institute' });
    notes.push('una mezcla básica (no reconocí palabras específicas)');
  }

  const effects = ORDER.filter((type) => fx[type]).map((type) => ({ type, params: fx[type] }));
  return { effects, notes: [...new Set(notes)] };
}

export const WORD_EXAMPLES = ['Voz trap con eco', 'Balada con reverb de iglesia', 'Voz angelical', 'Voz brillante y al frente', 'Voz de radio', 'Lofi con poco eco'];
