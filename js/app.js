// Arcadia — interfaz de la app (biblioteca + estudio).
import * as store from './store.js';
import { Engine, projectEnd, DEMO } from './engine.js';
import { EFFECTS, PRESETS, defaultParams } from './effects.js';

// =====================================================================
// Constantes y utilidades
// =====================================================================
const MIN_PPS = 6, MAX_PPS = 320; // zoom: píxeles por segundo
const COLORS = ['#FF4D6D', '#FFB020', '#4DD68A', '#3DB8FF', '#B26BFF', '#FF7A3D',
  '#2EE6D0', '#FF5CC8', '#C6F432', '#7C8CFF', '#FFD84D', '#FF8FA3'];
const TYPES = {
  VOCAL: { label: 'Voz', icon: 'ic-mic' },
  INSTRUMENTAL: { label: 'Instrumental', icon: 'ic-note' },
  CHOIR: { label: 'Coros', icon: 'ic-choir' },
  DRUMS: { label: 'Batería', icon: 'ic-drums' },
  BASS: { label: 'Bajo', icon: 'ic-bass' },
  OTHER: { label: 'Audio', icon: 'ic-wave' },
};
const VERSION = '0.11';
const SOON = { sync: 'La sincronización con Abraham IA Music llega pronto ☁️' };

const $ = (s, el = document) => el.querySelector(s);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clone = (o) => JSON.parse(JSON.stringify(o));
const icon = (id, cls = '') => `<svg class="i ${cls}"><use href="#${id}"/></svg>`;
const fmtTime = (sec) => { const s = Math.max(0, sec), m = Math.floor(s / 60); return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`; };
const fmtDate = (ms) => new Date(ms).toLocaleDateString('es-MX', { day: 'numeric', month: 'short', year: 'numeric' });
const volToDb = (v) => (v <= 0.0001 ? '-∞' : (20 * Math.log10(v)).toFixed(1));
const fmtPan = (p) => (Math.abs(p) < 0.02 ? 'C' : p < 0 ? `${Math.round(-p * 100)} I` : `${Math.round(p * 100)} D`);

function loadSettings() {
  try { return { snap: true, latencyMs: 0, metronome: false, myPresets: [], seeded: false, ...JSON.parse(localStorage.getItem('arcadia.settings') || '{}') }; }
  catch (e) { return { snap: true, latencyMs: 0, metronome: false, myPresets: [], seeded: false }; }
}
function saveSettings() { try { localStorage.setItem('arcadia.settings', JSON.stringify(S.settings)); } catch (e) {} }

// =====================================================================
// Estado
// =====================================================================
const engine = new Engine();
const S = {
  projects: [],
  filter: 'mine',
  project: null,
  sel: { trackId: null, regionId: null },
  pps: 40,
  mixerOpen: false,
  undo: [],
  redo: [],
  recording: null,
  settings: loadSettings(),
};
engine.metronome = S.settings.metronome;
const pps = () => S.pps;
const headerW = () => 60;
/** Espacio a cada lado para que el inicio y el final de la canción puedan quedar bajo la línea blanca del centro. */
const lead = () => Math.max(40, Math.round(($('#timeline').clientWidth - headerW()) / 2));

// ---------- Modelos ----------
function nextColor(project) {
  const used = project.tracks.map((t) => t.color);
  return COLORS.find((c) => !used.includes(c)) || COLORS[project.tracks.length % COLORS.length];
}
function makeTrack(project, type, name) {
  const count = project.tracks.filter((t) => t.type === type).length + 1;
  return {
    id: uid(), type, name: name || (count === 1 ? TYPES[type].label : `${TYPES[type].label} ${count}`),
    color: nextColor(project), volume: 0.85, pan: 0, muted: false, solo: false, effects: [], regions: [],
  };
}
function makeProject(title) {
  const now = Date.now();
  return { id: uid(), title, bpm: 120, tracks: [], createdAt: now, updatedAt: now, deletedAt: null, syncStatus: 'LOCAL', color: COLORS[Math.floor(Math.random() * COLORS.length)] };
}
function makeEffect(type, params) { return { id: uid(), type, enabled: true, params: { ...defaultParams(type), ...(params || {}) } }; }

function demoProject() {
  const p = makeProject('Demo Arcadia');
  p.bpm = DEMO.bpm; p.color = '#FF4D6D';
  const L = DEMO.length;
  const add = (type, name, audio) => {
    const t = makeTrack(p, type, name);
    t.regions = [0, L].map((start) => ({ id: uid(), name, audioId: 'demo:' + audio, start, offset: 0, length: L }));
    p.tracks.push(t);
    return t;
  };
  add('DRUMS', 'Batería', 'drums').volume = 0.8;
  add('BASS', 'Bajo', 'bass').volume = 0.7;
  add('INSTRUMENTAL', 'Acordes', 'pad').volume = 0.75;
  const lead = add('OTHER', 'Melodía', 'lead');
  lead.volume = 0.6;
  lead.effects = PRESETS[0].effects.map((e) => makeEffect(e.type, e.params));
  lead.presetName = PRESETS[0].name;
  return p;
}

// ---------- Guardado ----------
let saveTimer = null;
function touch(project = S.project) {
  project.updatedAt = Date.now();
  if (project.syncStatus === 'SYNCED') project.syncStatus = 'PENDING';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => store.saveProject(project), 250);
}
const snapshot = () => JSON.stringify({ title: S.project.title, bpm: S.project.bpm, tracks: S.project.tracks });

/** Cambia el proyecto con opción de deshacer. */
function commit(fn, { restart = true, render = true } = {}) {
  S.undo.push(snapshot());
  if (S.undo.length > 80) S.undo.shift();
  S.redo = [];
  fn(S.project);
  afterChange(restart, render);
}
function afterChange(restart = true, render = true) {
  touch();
  if (render) renderStudio();
  engine.syncMix(S.project);
  if (restart && engine.playing && !S.recording) engine.play(S.project, engine.position);
  updateUndoButtons();
}
function restore(json) {
  const data = JSON.parse(json);
  Object.assign(S.project, data);
  const t = S.project.tracks;
  if (!t.some((x) => x.id === S.sel.trackId)) S.sel = { trackId: null, regionId: null };
  if (S.sel.regionId && !t.some((x) => x.regions.some((r) => r.id === S.sel.regionId))) S.sel.regionId = null;
  afterChange(true, true);
  refreshSheet();
}
function undo() { if (!S.undo.length || S.recording) return; S.redo.push(snapshot()); restore(S.undo.pop()); }
function redo() { if (!S.redo.length || S.recording) return; S.undo.push(snapshot()); restore(S.redo.pop()); }
function updateUndoButtons() { $('#undo').disabled = !S.undo.length; $('#redo').disabled = !S.redo.length; }

// Para sliders: guarda un punto de deshacer al empezar a moverlo.
let pendingSnap = null;
function beginLive() { if (!pendingSnap) pendingSnap = snapshot(); }
function endLive() {
  if (pendingSnap && pendingSnap !== snapshot()) { S.undo.push(pendingSnap); S.redo = []; updateUndoButtons(); }
  pendingSnap = null;
}
function liveChange() { touch(); engine.syncMix(S.project); }

// =====================================================================
// Avisos, hojas y diálogos
// =====================================================================
let toastTimer;
function toast(msg) {
  document.querySelectorAll('.toast').forEach((t) => t.remove());
  const el = document.createElement('div');
  el.className = 'toast' + (S.project ? '' : ' low');
  el.textContent = msg;
  document.body.appendChild(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.remove(), 2800);
}
document.addEventListener('click', (e) => { const b = e.target.closest('[data-soon]'); if (b) toast(SOON[b.dataset.soon]); });

function busy(msg) {
  const el = document.createElement('div');
  el.className = 'busy';
  el.innerHTML = `<div style="text-align:center"><div class="spinner"></div>${esc(msg)}</div>`;
  document.body.appendChild(el);
  return () => el.remove();
}

let sheetRender = null;
let sheetCloseTimer = null;
function openSheet(render) {
  clearTimeout(sheetCloseTimer);
  const already = $('#overlay .scrim:not(.closing)');
  sheetRender = render;
  if (already) { refreshSheet(); return; }   // cambiar de hoja sin volver a animar
  $('#overlay').innerHTML = '<div class="scrim" data-close><div class="sheet"><div class="grip"></div><div class="sheet-inner"></div></div></div>';
  refreshSheet();
}
function refreshSheet() {
  const inner = $('#overlay .sheet-inner');
  if (!inner || !sheetRender) return;
  const scroll = $('#overlay .sheet-body')?.scrollTop || 0;
  inner.innerHTML = '';
  sheetRender(inner);
  const body = $('#overlay .sheet-body');
  if (body) body.scrollTop = scroll;
  paintRanges(inner);
}
function closeSheet() {
  sheetRender = null; endLive();
  const scrim = $('#overlay .scrim');
  if (!scrim) return;
  scrim.classList.add('closing');
  clearTimeout(sheetCloseTimer);
  sheetCloseTimer = setTimeout(() => { $('#overlay').innerHTML = ''; }, 260);
}
$('#overlay').addEventListener('click', (e) => { if (e.target.hasAttribute('data-close')) closeSheet(); });

function sheetHead(title, extra = '') {
  return `<div class="sheet-head"><h3>${title}</h3>${extra}<button class="icon-btn" data-x>${icon('ic-close')}</button></div>`;
}

function dialog({ title, text = '', value = null, placeholder = '', ok = 'Aceptar', danger = false, type = 'text' }) {
  return new Promise((resolve) => {
    const prev = $('#overlay').innerHTML;
    const host = document.createElement('div');
    host.innerHTML = `<div class="scrim center"><form class="dialog">
      <h3>${esc(title)}</h3>${text ? `<p>${esc(text)}</p>` : ''}
      ${value !== null ? `<input class="text-input" type="${type}" value="${esc(value)}" placeholder="${esc(placeholder)}" maxlength="60" autocomplete="off">` : ''}
      <div class="row-btns"><button type="button" class="btn" data-cancel>Cancelar</button><button type="submit" class="btn ${danger ? 'danger' : 'primary'}">${esc(ok)}</button></div>
    </form></div>`;
    document.body.appendChild(host);
    const input = $('input', host);
    if (input) setTimeout(() => { input.focus(); input.select(); }, 60);
    const done = (v) => { host.remove(); resolve(v); };
    $('[data-cancel]', host).onclick = () => done(null);
    $('form', host).onsubmit = (e) => { e.preventDefault(); done(input ? input.value.trim() : true); };
    void prev;
  });
}

function paintRanges(root = document) {
  root.querySelectorAll('input[type=range]').forEach((r) => {
    const p = ((r.value - r.min) / (r.max - r.min)) * 100;
    r.style.setProperty('--p', p + '%');
  });
}
document.addEventListener('input', (e) => { if (e.target.type === 'range') paintRanges(e.target.parentElement); });

// =====================================================================
// Biblioteca
// =====================================================================
const SYNC = {
  SYNCED: { icon: 'ic-cloud-done', color: 'var(--sync)', label: 'Sincronizado' },
  PENDING: { icon: 'ic-cloud-up', color: 'var(--accent)', label: 'Por subir' },
  LOCAL: { icon: 'ic-phone', color: 'var(--text-3)', label: 'Solo en este cel' },
};

function renderLibrary() {
  const trash = S.filter === 'trash';
  document.querySelectorAll('[data-filter]').forEach((b) => b.classList.toggle('on', b.dataset.filter === S.filter));
  $('#list-title').textContent = trash ? 'Eliminados' : 'Todo';
  $('#new-project').classList.toggle('hidden', trash);
  const list = S.projects.filter((p) => (trash ? p.deletedAt : !p.deletedAt)).sort((a, b) => b.updatedAt - a.updatedAt);
  if (!list.length) {
    $('#project-list').innerHTML = `<div class="empty">${trash ? 'No hay proyectos eliminados.' : 'Aún no tienes proyectos.<br>Toca <b>Nuevo</b> para empezar tu primera canción.'}</div>`;
    return;
  }
  $('#project-list').innerHTML = list.map((p) => {
    const sync = SYNC[p.syncStatus] || SYNC.LOCAL;
    return `<div style="display:flex;align-items:center">
      <button class="proj" data-open="${p.id}">
        <div class="cover" style="background:linear-gradient(135deg, ${p.color}, #111)">${icon('ic-note')}</div>
        <div class="proj-info">
          <div class="proj-title"><span>${esc(p.title)}</span>${icon('ic-lock', 'sm lock')}</div>
          <div class="sub">Abraham · ${fmtDate(p.updatedAt)} · ${p.tracks.length} pistas</div>
        </div>
        <svg class="i" style="color:${sync.color}" aria-label="${sync.label}"><use href="#${sync.icon}"/></svg>
      </button>
      <button class="icon-btn" data-pmenu="${p.id}" aria-label="Opciones">${icon('ic-more')}</button>
    </div>`;
  }).join('');
}

$('#library').addEventListener('click', async (e) => {
  const f = e.target.closest('[data-filter]');
  if (f) { S.filter = f.dataset.filter; renderLibrary(); return; }
  const open = e.target.closest('[data-open]');
  if (open) {
    const p = S.projects.find((x) => x.id === open.dataset.open);
    if (p.deletedAt) { projectMenu(p); return; }
    location.hash = '#p-' + p.id;
    return;
  }
  const m = e.target.closest('[data-pmenu]');
  if (m) projectMenu(S.projects.find((x) => x.id === m.dataset.pmenu));
});

$('#new-project').addEventListener('click', async () => {
  const title = await dialog({ title: 'Nuevo proyecto', value: '', placeholder: 'Nombre de la canción', ok: 'Crear' });
  if (title === null) return;
  const p = makeProject(title || 'Proyecto sin título');
  S.projects.push(p);
  await store.saveProject(p);
  location.hash = '#p-' + p.id;
});

function projectMenu(p) {
  openSheet((el) => {
    const trash = !!p.deletedAt;
    el.innerHTML = sheetHead(esc(p.title)) + `<div class="sheet-body">
      ${trash ? `
        <button class="sheet-item" data-a="restore">${icon('ic-restore')}Restaurar</button>
        <button class="sheet-item danger" data-a="forever">${icon('ic-delete')}Eliminar para siempre</button>` : `
        <button class="sheet-item" data-a="open">${icon('ic-note')}Abrir en el Studio</button>
        <button class="sheet-item" data-a="rename">${icon('ic-edit')}Renombrar</button>
        <button class="sheet-item" data-a="dup">${icon('ic-copy')}Duplicar</button>
        <button class="sheet-item danger" data-a="trash">${icon('ic-delete')}Eliminar</button>`}
    </div>`;
    el.onclick = async (e) => {
      if (e.target.closest('[data-x]')) return closeSheet();
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (!a) return;
      closeSheet();
      if (a === 'open') location.hash = '#p-' + p.id;
      if (a === 'rename') {
        const t = await dialog({ title: 'Renombrar proyecto', value: p.title, ok: 'Guardar' });
        if (t) { p.title = t; touch(p); renderLibrary(); }
      }
      if (a === 'dup') {
        const c = { ...clone(p), id: uid(), title: p.title + ' (copia)', createdAt: Date.now(), updatedAt: Date.now(), syncStatus: 'LOCAL' };
        S.projects.push(c); await store.saveProject(c); renderLibrary(); toast('Proyecto duplicado');
      }
      if (a === 'trash') { p.deletedAt = Date.now(); await store.saveProject(p); renderLibrary(); toast('Movido a Eliminados'); }
      if (a === 'restore') { p.deletedAt = null; await store.saveProject(p); renderLibrary(); toast('Proyecto restaurado'); }
      if (a === 'forever') {
        const ok = await dialog({ title: '¿Eliminar para siempre?', text: `"${p.title}" se borrará y no se puede recuperar.`, ok: 'Eliminar', danger: true });
        if (ok) { S.projects = S.projects.filter((x) => x !== p); await store.deleteProjectForever(p.id); renderLibrary(); }
      }
    };
  });
}

// =====================================================================
// Estudio: dibujo
// =====================================================================
const timelineLength = () => Math.max(60, projectEnd(S.project) + 30, S.recording ? engine.position + 30 : 0);

const ROW_H = 93; // alto de pista (90) + separación negra (3)
const hexRgb = (hex) => { const n = parseInt(hex.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
const shade = (hex, k = 0.42) => { const [r, g, b] = hexRgb(hex); return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`; };
const tint = (hex, a) => { const [r, g, b] = hexRgb(hex); return `rgba(${r},${g},${b},${a})`; };
const fxLabel = (t) => ((t.effects || []).length ? `<i>Fx</i> ${esc(t.presetName || 'Personalizado')}` : '+<i>Fx</i>');

function renderStudio() {
  const p = S.project; if (!p) return;
  const scale = pps();
  const total = timelineLength();
  const width = Math.ceil(total * scale);
  $('#studio-title').textContent = p.title;
  $('#studio-sub').textContent = `${p.tracks.length} pistas · ${p.bpm} BPM`;
  $('#tl-inner').style.width = headerW() + lead() * 2 + width + 'px';
  $('#studio').style.setProperty('--lead', lead() + 'px');
  drawRuler(p, width, scale);

  const anySolo = p.tracks.some((t) => t.solo);
  const rows = p.tracks.map((t) => {
    const dim = t.muted || (anySolo && !t.solo);
    const fxOn = (t.effects || []).some((e) => e.enabled);
    const selected = S.sel.trackId === t.id;
    const regions = t.regions.map((r) => {
      const loading = !engine.buffers.has(r.audioId);
      const sel = S.sel.regionId === r.id;
      return `<div class="region ${sel ? 'selected' : ''} ${loading ? 'loading' : ''}" data-region="${r.id}" data-track="${t.id}"
        style="left:${r.start * scale}px;width:${Math.max(3, r.length * scale)}px;background:${shade(t.color, 0.5)};opacity:${dim ? 0.35 : 1}">${sel ? '<i class="r-knob"></i>' : ''}</div>`;
    }).join('');
    // Como en BandLab: cada pista tiene su fondo del mismo color (oscuro) de lado a lado,
    // y antes del inicio de la canción se ve su nombre con el botón +Fx.
    return `<div class="track-row ${selected ? 'selected' : ''}" style="--row:${shade(t.color, selected ? 0.34 : 0.24)}">
      <div class="track-head" data-head="${t.id}" aria-label="${esc(t.name)}">
        <svg class="i" style="color:${t.color};opacity:${dim ? 0.4 : 1}"><use href="#${TYPES[t.type]?.icon || 'ic-wave'}"/></svg>
        ${selected ? `<button class="head-del" data-delhead="${t.id}" aria-label="Eliminar pista ${esc(t.name)}">${icon('ic-delete')}</button>`
          : t.muted || t.solo ? `<span class="ms-badge">${t.muted ? '<b style="color:var(--mute)">M</b>' : ''}${t.solo ? '<b style="color:var(--solo)">S</b>' : ''}</span>` : ''}
      </div>
      <div class="lane" data-lane="${t.id}" style="width:${width}px">
        <div class="lane-label" style="color:${t.color}">
          <span class="ll-name">${esc(t.name)}</span>
          <button class="ll-fx" data-llfx="${t.id}" style="background:${shade(t.color, 0.55)};color:${fxOn ? t.color : 'var(--text)'}">${fxOn ? `<i>Fx</i> ${esc(t.presetName || 'Personalizado')}` : '+<i>Fx</i>'}</button>
        </div>
        ${regions}
        ${S.recording && S.recording.trackId === t.id ? `<div class="rec-region" id="rec-region" style="left:${S.recording.start * scale}px;width:0"></div>` : ''}
      </div>
    </div>`;
  }).join('');
  $('#tracks').innerHTML = rows || '<div class="empty" style="position:sticky;left:0;width:100vw">Este proyecto está vacío.<br>Toca el micrófono para grabar tu voz o <b>Importar</b> para subir tus pistas de IA.</div>';

  // Formas de onda en alta resolución, por partes y solo las que se ven
  setupWaveTiles(p, scale);
  fracEls = [...document.querySelectorAll('#tracks .lane'), $('#ruler')];
  fracNow = 0;
  if (engine.playing && playBase !== null) { const f = playBase - engine.visualPosition() * scale; fracNow = NaN; setFrac(f); }
  layoutPlayhead();
  renderEditBar();
  updatePlayhead();
  updateUndoButtons();
  if (S.mixerOpen) renderMixer();
  $('#tb-metro').classList.toggle('on', !!S.settings.metronome);
}

function gridBg(p, scale) {
  const beatPx = (60 / p.bpm) * scale, barPx = beatPx * 4;
  return `repeating-linear-gradient(90deg, var(--grid-bar) 0 1px, transparent 1px ${barPx}px)` +
    (beatPx > 18 ? `, repeating-linear-gradient(90deg, var(--grid) 0 1px, transparent 1px ${beatPx}px)` : '');
}

// ---------- Formas de onda (nítidas a la resolución real de la pantalla) ----------
const TILE = 1024;           // ancho de cada pedazo en píxeles de pantalla
const DPR = () => Math.min(window.devicePixelRatio || 1, 4);
const regionPeak = new Map();
let tileObserver = null;

function peakOf(r) {
  const key = `${r.audioId}|${r.offset}|${r.length}`;
  if (regionPeak.has(key)) return regionPeak.get(key);
  const pk = engine.peaks.get(r.audioId);
  if (!pk) return 1;
  const a = Math.floor(r.offset * pk.rate), b = Math.min(pk.min.length, Math.ceil((r.offset + r.length) * pk.rate));
  let m = 0.0001;
  for (let i = a; i < b; i++) m = Math.max(m, pk.max[i], -pk.min[i]);
  regionPeak.set(key, m);
  return m;
}

function setupWaveTiles(p, scale) {
  if (tileObserver) tileObserver.disconnect();
  tileObserver = new IntersectionObserver((entries) => {
    entries.forEach((en) => {
      if (!en.isIntersecting) return;
      tileObserver.unobserve(en.target);
      drawTile(en.target);
    });
  }, { root: $('#timeline'), rootMargin: '0px 1200px 0px 1200px' });
  p.tracks.forEach((t) => t.regions.forEach((r) => {
    const el = document.querySelector(`[data-region="${r.id}"]`);
    if (!el || !engine.peaks.has(r.audioId)) return;
    const w = Math.max(3, r.length * scale);
    for (let x0 = 0; x0 < w; x0 += TILE) {
      const cv = document.createElement('canvas');
      cv.width = 1; cv.height = 1;
      cv.style.cssText = `left:${x0}px;width:${Math.min(TILE, w - x0)}px`;
      cv._wave = { r, color: t.color, x0, tw: Math.min(TILE, w - x0), w };
      el.appendChild(cv);
      tileObserver.observe(cv);
    }
  }));
}

/** Onda rellena y simétrica, como en BandLab: color brillante sobre el mismo color oscuro. */
function drawTile(cv) {
  const { r, color, x0, tw, w } = cv._wave;
  const pk = engine.peaks.get(r.audioId);
  if (!pk) return;
  const dpr = DPR(), h = cv.clientHeight || 90;
  const W = Math.max(1, Math.round(tw * dpr)), H = Math.round(h * dpr);
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  const mid = H / 2, half = mid - 3 * dpr, n = pk.min.length;
  const norm = 1 / Math.max(peakOf(r), 0.35);
  const secPerPx = r.length / (w * dpr);
  const amp = new Float32Array(W + 1);
  for (let x = 0; x <= W; x++) {
    const t0 = r.offset + (x0 * dpr + x) * secPerPx;
    const a = Math.floor(t0 * pk.rate);
    if (a >= n) break;
    const b = Math.min(n, Math.max(a + 1, Math.floor((t0 + secPerPx) * pk.rate)));
    let m = 0;
    for (let i = a; i < b; i++) { const v = pk.max[i] > -pk.min[i] ? pk.max[i] : -pk.min[i]; if (v > m) m = v; }
    amp[x] = Math.min(1, m * (r.gain ?? 1) * norm) * half;
  }
  // Suavizado ligero + grosor mínimo: los silencios se ven como una franja, como en BandLab.
  const minBand = Math.max(1.5 * dpr, half * 0.06);
  for (let x = 0; x <= W; x++) {
    const v = (amp[Math.max(0, x - 1)] + amp[x] * 2 + amp[Math.min(W, x + 1)]) / 4;
    amp[x] = Math.max(minBand, v);
  }
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(0, mid - amp[0]);
  for (let x = 1; x <= W; x++) ctx.lineTo(x, mid - amp[x]);
  for (let x = W; x >= 0; x--) ctx.lineTo(x, mid + amp[x]);
  ctx.closePath();
  ctx.fill();
}

function drawRuler(p, width, scale) {
  const ruler = $('#ruler');
  ruler.style.width = width + 'px';
  ruler.querySelectorAll('canvas').forEach((c) => c.remove());
  const dpr = DPR();
  const h = 30, RT = 2048;
  const beatPx = (60 / p.bpm) * scale;
  const barEvery = beatPx * 4 < 30 ? 4 : 1; // con poco zoom, numera cada 4 compases
  for (let x0 = 0; x0 < width; x0 += RT) {
    const w = Math.min(RT, width - x0);
    const cv = document.createElement('canvas');
    cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr);
    cv.style.cssText = `position:absolute;left:${x0}px;top:0;width:${w}px;height:${h}px`;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.font = '500 10.5px Inter, system-ui, sans-serif';
    const b0 = Math.floor(x0 / beatPx), b1 = Math.ceil((x0 + w) / beatPx);
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(b * beatPx - x0) + 0.5;
      const isBar = b % 4 === 0;
      if (!isBar && beatPx < 9) continue;
      ctx.strokeStyle = isBar ? '#8a8a94' : '#4a4a52';
      ctx.beginPath(); ctx.moveTo(x, isBar ? 4 : h - 9); ctx.lineTo(x, h); ctx.stroke();
      if (isBar && (b / 4) % barEvery === 0) { ctx.fillStyle = '#b4b4bd'; ctx.fillText(String(b / 4 + 1), x + 4, 14); }
    }
    ruler.insertBefore(cv, ruler.firstChild);
  }
}

function renderEditBar() {
  const r = findRegion(S.sel.regionId);
  $('#editbar').classList.toggle('hidden', !r);
  if (r) $('#region-label').textContent = r.region.name;
}

function findRegion(id) {
  if (!id || !S.project) return null;
  for (const t of S.project.tracks) { const r = t.regions.find((x) => x.id === id); if (r) return { track: t, region: r }; }
  return null;
}
const findTrack = (id) => S.project?.tracks.find((t) => t.id === id);

// ---------- Cursor de reproducción ----------
let raf = null;
// La línea blanca es una capa fija encima de la línea de tiempo: nunca se mueve ni tiembla.
// Lo que se desplaza es la canción por debajo (como en BandLab).
let lastTimeText = '';
function updatePlayhead(follow = false, pos = engine.position) {
  const m = Math.floor(pos / 60), sec = pos - m * 60;
  const txt = `${String(m).padStart(2, '0')}:${String(Math.floor(sec)).padStart(2, '0')}<small>.${Math.floor((sec % 1) * 10)}</small>`;
  if (txt !== lastTimeText) { $('#t-now').innerHTML = txt; lastTimeText = txt; }
  if (follow) {
    const x = pos * pps();
    if (engine.playing) {
      // Mientras suena, la canción se desliza con la tarjeta gráfica (transform), sin tocar el scroll:
      // es más fluido y funciona igual en todos los celulares. La línea blanca no se mueve nunca.
      if (playBase === null) playBase = $('#timeline').scrollLeft;
      setFrac(playBase - x);
    } else {
      setFrac(0);
      setScroll(x);
    }
  }
}
let playBase = null; // posición del scroll cuando empezó a sonar
let fracEls = [], fracNow = 0;
function setFrac(f) {
  if (Math.abs(f - fracNow) < 0.005) return;
  fracNow = f;
  const v = f ? `translate3d(${f.toFixed(2)}px,0,0)` : '';
  fracEls.forEach((el) => { el.style.transform = v; });
}
/** Pasa lo que avanzó la canción al scroll real (al pausar, hacer zoom, etc.). */
function settleScroll(pos = engine.position) {
  playBase = null;
  setFrac(0);
  setScroll(pos * pps());
}
function setScroll(x) {
  const tl = $('#timeline');
  if (Math.abs(tl.scrollLeft - x) >= 0.25) tl.scrollLeft = x;
}
function layoutPlayhead() {
  const ph = $('#playhead'), wrap = $('.tl-wrap');
  if (!S.project) return;
  ph.style.left = headerW() + lead() + 'px';
  ph.style.height = Math.max(0, Math.min(30 + Math.max(1, S.project.tracks.length) * ROW_H + 64, wrap.clientHeight) - 12) + 'px';
}
function tick() {
  if (!engine.playing) return;
  updatePlayhead(true, engine.visualPosition());
  if (S.recording) {
    const rr = $('#rec-region');
    if (rr) rr.style.width = Math.max(0, (engine.position - S.recording.start) * pps()) + 'px';
    if (engine.position * pps() > parseFloat($('#tl-inner').style.width) - headerW() - lead() * 2 - 200) renderStudio();
  } else if (engine.position > timelineLength()) {
    stopPlayback();
  }
  raf = requestAnimationFrame(tick);
}
function startPlayback() {
  engine.ensure();
  engine.setMasterVolume(S.project.masterVolume ?? 1);
  settleScroll(engine.position);
  playBase = $('#timeline').scrollLeft;
  engine.play(S.project, engine.position);
  $('#play-icon').setAttribute('href', '#ic-pause');
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}
function stopPlayback() {
  const pos = engine.stop();
  settleScroll(pos);
  $('#play-icon').setAttribute('href', '#ic-play');
  cancelAnimationFrame(raf);
  updatePlayhead();
}
function seek(sec) {
  const pos = clamp(sec, 0, timelineLength());
  const wasPlaying = engine.playing;
  if (wasPlaying) engine.stop();
  engine.startPos = pos;
  if (wasPlaying) engine.play(S.project, pos);
  updatePlayhead(true);
}

$('#play').addEventListener('click', async () => {
  if (S.recording) return toggleRecord();
  if (engine.playing) return stopPlayback();
  engine.ensure();
  await engine.loadProject(S.project);
  startPlayback();
});
$('#rewind').addEventListener('click', () => { if (S.recording) return; seek(0); });
document.addEventListener('keydown', (e) => {
  if (!S.project || e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});

// ---------- Zoom: pellizco con dos dedos (como en BandLab) ----------
/** Zoom alrededor de la línea blanca, que no se mueve. */
function zoomAround(newPps) {
  const pos = engine.position;
  S.pps = clamp(newPps, MIN_PPS, MAX_PPS);
  playBase = null;
  renderStudio();
  settleScroll(pos);
  if (engine.playing) playBase = $('#timeline').scrollLeft - (engine.visualPosition() - pos) * S.pps;
  updatePlayhead();
}

let pinch = null;
(() => {
  const tl = $('#timeline');
  let pending = null, frame = null, targets = [];
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  tl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && S.project) {
      const [a, b] = e.touches;
      const pos = engine.position;
      pinch = { d: dist(a, b), pps: pps(), pos, k: 1 };
      if (drag) { drag.el.style.left = drag.start0 * pps() + 'px'; drag = null; }
      // Mientras pellizcas solo se "estira" la imagen con la tarjeta gráfica (súper fluido);
      // al soltar se vuelve a dibujar todo nítido con el nuevo zoom.
      targets = [...document.querySelectorAll('#tracks .lane'), $('#ruler')];
      targets.forEach((el) => { el.style.transformOrigin = `${pos * pinch.pps}px 0`; el.style.willChange = 'transform'; });
    }
  }, { passive: true });
  tl.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [a, b] = e.touches;
    const want = clamp(pinch.pps * (dist(a, b) / pinch.d), MIN_PPS, MAX_PPS);
    pending = want / pinch.pps;
    if (!frame) frame = requestAnimationFrame(() => {
      frame = null;
      pinch.k = pending;
      targets.forEach((el) => { el.style.transform = `scaleX(${pending})`; });
    });
  }, { passive: false });
  const end = (e) => {
    if (!pinch || e.touches.length >= 2) return;
    const { pps: p0, k, pos } = pinch;
    pinch = null;
    cancelAnimationFrame(frame); frame = null;
    targets.forEach((el) => { el.style.transform = ''; el.style.willChange = ''; });
    targets = [];
    S.pps = clamp(p0 * k, MIN_PPS, MAX_PPS);
    playBase = null;
    renderStudio();
    settleScroll(pos);
  };
  tl.addEventListener('touchend', end);
  tl.addEventListener('touchcancel', end);
  // En compu: Ctrl + rueda del mouse
  tl.addEventListener('wheel', (e) => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    zoomAround(pps() * (e.deltaY < 0 ? 1.15 : 1 / 1.15));
  }, { passive: false });

  // Como en BandLab: al poner el dedo se pausa, deslizas la canción bajo la línea blanca
  // y al soltar sigue sonando desde donde la dejaste.
  let touching = false, resumeAfter = false, resumeTimer = null;
  const excluded = (e) => e.target.closest && e.target.closest('.track-head, .add-row, .corner, .region.selected');
  const scheduleResume = () => {
    clearTimeout(resumeTimer);
    resumeTimer = setTimeout(() => {
      if (touching || !resumeAfter || !S.project) return;
      resumeAfter = false;
      startPlayback();
    }, 260);
  };
  const press = (e) => {
    if (excluded(e)) return;
    touching = true;
    clearTimeout(resumeTimer);
    if (engine.playing && !S.recording) { stopPlayback(); resumeAfter = true; }
  };
  const release = () => { if (!touching) return; touching = false; if (resumeAfter) scheduleResume(); };
  tl.addEventListener('touchstart', press, { passive: true, capture: true });
  tl.addEventListener('mousedown', press, true);
  window.addEventListener('touchend', release);
  window.addEventListener('touchcancel', release);
  window.addEventListener('mouseup', release);
  tl.addEventListener('wheel', (e) => { if (e.ctrlKey) return; press(e); touching = false; scheduleResume(); }, { passive: true });
  tl.addEventListener('scroll', () => {
    if (!S.project || S.recording || engine.playing || pinch) return;
    engine.startPos = clamp(tl.scrollLeft / pps(), 0, timelineLength());
    updatePlayhead();
    if (resumeAfter && !touching) scheduleResume();
  }, { passive: true });
})();
window.addEventListener('resize', () => { if (S.project && !engine.playing) { renderStudio(); settleScroll(); } });
new ResizeObserver(() => { if (S.project) layoutPlayhead(); }).observe(document.querySelector('.tl-wrap'));



// =====================================================================
// Estudio: toques y arrastre
// =====================================================================
$('#tracks').addEventListener('click', (e) => {
  if (drag && drag.moved) return;
  const mute = e.target.closest('[data-mute]'), solo = e.target.closest('[data-solo]');
  if (mute || solo) {
    const t = findTrack((mute || solo).dataset.mute || (mute || solo).dataset.solo);
    commit(() => { if (mute) t.muted = !t.muted; else t.solo = !t.solo; }, { restart: false });
    return;
  }
  const delh = e.target.closest('[data-delhead]');
  if (delh) { deleteTrack(delh.dataset.delhead); return; }
  const llfx = e.target.closest('[data-llfx]');
  if (llfx) { S.sel = { trackId: llfx.dataset.llfx, regionId: null }; renderStudio(); effectsSheet(llfx.dataset.llfx); return; }
  const head = e.target.closest('[data-head]');
  if (head) {
    // Primer toque: selecciona la pista. Segundo toque: abre sus opciones.
    const id = head.dataset.head;
    if (S.sel.trackId === id) trackSheet(id);
    else { S.sel = { trackId: id, regionId: null }; renderStudio(); }
    return;
  }
  const reg = e.target.closest('[data-region]');
  if (reg) { S.sel = { trackId: reg.dataset.track, regionId: reg.dataset.region }; renderStudio(); return; }
  const lane = e.target.closest('[data-lane]');
  if (lane) {
    const changed = S.sel.regionId || S.sel.trackId !== lane.dataset.lane;
    S.sel = { trackId: lane.dataset.lane, regionId: null };
    if (changed) renderStudio();
  }
});
$('#ruler').addEventListener('click', (e) => seek((e.clientX - $('#ruler').getBoundingClientRect().left) / pps()));

// Arrastrar una región seleccionada (como en BandLab: primero tocas, luego mueves).
let drag = null;
$('#tracks').addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.region.selected');
  if (!el || S.recording) return;
  const found = findRegion(el.dataset.region);
  if (!found) return;
  drag = { el, region: found.region, x0: e.clientX, start0: found.region.start, moved: false, newStart: found.region.start };
  el.setPointerCapture(e.pointerId);
});
$('#tracks').addEventListener('pointermove', (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x0;
  if (!drag.moved && Math.abs(dx) < 5) return;
  drag.moved = true;
  drag.el.classList.add('dragging');
  let s = Math.max(0, drag.start0 + dx / pps());
  if (S.settings.snap) { const beat = 60 / S.project.bpm; s = Math.round(s / beat) * beat; }
  drag.newStart = s;
  drag.el.style.left = s * pps() + 'px';
});
const endDrag = () => {
  if (!drag) return;
  const d = drag;
  setTimeout(() => { drag = null; }, 0);
  d.el.classList.remove('dragging');
  if (d.moved && d.newStart !== d.start0) commit(() => { d.region.start = d.newStart; });
};
$('#tracks').addEventListener('pointerup', endDrag);
$('#tracks').addEventListener('pointercancel', endDrag);

// ---------- Barra de edición de región ----------
$('#r-close').addEventListener('click', () => { S.sel.regionId = null; renderStudio(); });
$('#r-del').addEventListener('click', () => {
  const f = findRegion(S.sel.regionId); if (!f) return;
  commit(() => { f.track.regions = f.track.regions.filter((r) => r !== f.region); });
  S.sel.regionId = null; renderStudio();
});
$('#r-dup').addEventListener('click', () => {
  const f = findRegion(S.sel.regionId); if (!f) return;
  const copy = { ...clone(f.region), id: uid(), start: f.region.start + f.region.length };
  commit(() => { f.track.regions.push(copy); });
  S.sel.regionId = copy.id; renderStudio();
});
$('#r-split').addEventListener('click', () => {
  const f = findRegion(S.sel.regionId); if (!f) return;
  const r = f.region, pos = engine.position;
  if (pos <= r.start + 0.02 || pos >= r.start + r.length - 0.02) { toast('Pon el cursor dentro de la región para dividirla'); return; }
  const cut = pos - r.start;
  const right = { ...clone(r), id: uid(), start: pos, offset: r.offset + cut, length: r.length - cut };
  commit(() => { r.length = cut; f.track.regions.push(right); });
  S.sel.regionId = right.id; renderStudio();
});
$('#r-rename').addEventListener('click', async () => {
  const f = findRegion(S.sel.regionId); if (!f) return;
  const n = await dialog({ title: 'Nombre de la región', value: f.region.name, ok: 'Guardar' });
  if (n) commit(() => { f.region.name = n; }, { restart: false });
});

// =====================================================================
// Hojas del estudio
// =====================================================================
function rangeField(label, id, min, max, step, value, shown) {
  return `<div class="field"><label>${label}<b data-show="${id}">${shown}</b></label>
    <input type="range" data-range="${id}" min="${min}" max="${max}" step="${step}" value="${value}"></div>`;
}
function bindRanges(el, handlers) {
  el.querySelectorAll('[data-range]').forEach((r) => {
    const h = handlers[r.dataset.range];
    if (!h) return;
    r.addEventListener('pointerdown', beginLive);
    r.addEventListener('focus', beginLive);
    r.addEventListener('input', () => {
      beginLive();
      const shown = h(parseFloat(r.value));
      const b = el.querySelector(`[data-show="${r.dataset.range}"]`);
      if (b && shown !== undefined) b.textContent = shown;
      liveChange();
    });
    r.addEventListener('change', () => { endLive(); renderStudio(); });
  });
}

// ---------- Eliminar pista completa ----------
async function deleteTrack(trackId) {
  const t = findTrack(trackId); if (!t) return;
  const ok = await dialog({ title: `¿Eliminar "${t.name}"?`, text: 'Se borra la pista completa con todo su audio. Puedes recuperarla con Deshacer.', ok: 'Eliminar', danger: true });
  if (!ok) return;
  commit((p) => { p.tracks = p.tracks.filter((x) => x.id !== trackId); });
  S.sel = { trackId: null, regionId: null };
  closeSheet();
  renderStudio();
  toast('Pista eliminada');
}

// ---------- Pista ----------
function trackSheet(trackId) {
  openSheet((el) => {
    const t = findTrack(trackId);
    if (!t) return closeSheet();
    el.innerHTML = sheetHead(`<span style="color:${t.color}">●</span> ${esc(t.name)}`) + `<div class="sheet-body">
      <div class="field"><label>Nombre</label><input class="text-input" id="t-name" value="${esc(t.name)}" maxlength="40"></div>
      <div class="field"><label>Color</label><div class="swatches">
        ${COLORS.map((c) => `<button class="swatch ${c === t.color ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('')}
      </div></div>
      ${rangeField('Volumen', 'vol', 0, 1.5, 0.01, t.volume, volToDb(t.volume) + ' dB')}
      ${rangeField('Paneo', 'pan', -1, 1, 0.02, t.pan, fmtPan(t.pan))}
      <button class="sheet-item" data-a="fx">${icon('ic-sparkle')}Efectos<span class="hint">${(t.effects || []).length || 'Ninguno'}</span></button>
      <button class="sheet-item" data-a="import">${icon('ic-upload')}Importar audio en esta pista</button>
      <button class="sheet-item" data-a="type">${icon(TYPES[t.type].icon)}Tipo de pista<span class="hint">${TYPES[t.type].label}</span></button>
      <button class="sheet-item" data-a="up">${icon('ic-up')}Subir pista</button>
      <button class="sheet-item" data-a="down">${icon('ic-down')}Bajar pista</button>
      <button class="sheet-item" data-a="dup">${icon('ic-copy')}Duplicar pista</button>
      <button class="sheet-item danger" data-a="del">${icon('ic-delete')}Eliminar pista</button>
    </div>`;
    const name = $('#t-name', el);
    const saveName = () => { const v = name.value.trim(); if (v && v !== t.name) { commit(() => { t.name = v; }, { restart: false }); refreshSheet(); } };
    name.addEventListener('change', saveName);
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') name.blur(); });
    bindRanges(el, {
      vol: (v) => { t.volume = v; return volToDb(v) + ' dB'; },
      pan: (v) => { t.pan = Math.abs(v) < 0.04 ? 0 : v; return fmtPan(t.pan); },
    });
    el.onclick = async (e) => {
      if (e.target.closest('[data-x]')) return closeSheet();
      const c = e.target.closest('[data-color]');
      if (c) { commit(() => { t.color = c.dataset.color; }, { restart: false }); refreshSheet(); return; }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'fx') effectsSheet(t.id);
      if (a === 'import') { closeSheet(); pickFiles(t.id); }
      if (a === 'type') typeSheet(t.id);
      if (a === 'up' || a === 'down') {
        const i = S.project.tracks.indexOf(t), j = a === 'up' ? i - 1 : i + 1;
        if (j < 0 || j >= S.project.tracks.length) return;
        commit((p) => { [p.tracks[i], p.tracks[j]] = [p.tracks[j], p.tracks[i]]; }, { restart: false });
      }
      if (a === 'dup') {
        const copy = { ...clone(t), id: uid(), name: t.name + ' copia', color: nextColor(S.project) };
        copy.regions.forEach((r) => { r.id = uid(); });
        copy.effects.forEach((x) => { x.id = uid(); });
        commit((p) => { p.tracks.splice(p.tracks.indexOf(t) + 1, 0, copy); });
        closeSheet(); toast('Pista duplicada');
      }
      if (a === 'del') deleteTrack(t.id);
    };
  });
}

function typeSheet(trackId) {
  openSheet((el) => {
    const t = findTrack(trackId);
    el.innerHTML = sheetHead('Tipo de pista') + `<div class="sheet-body">${Object.entries(TYPES).map(([k, v]) =>
      `<button class="sheet-item" data-type="${k}">${icon(v.icon)}${v.label}${k === t.type ? '<span class="hint">✓</span>' : ''}</button>`).join('')}</div>`;
    el.onclick = (e) => {
      if (e.target.closest('[data-x]')) return trackSheet(trackId);
      const b = e.target.closest('[data-type]'); if (!b) return;
      commit(() => { t.type = b.dataset.type; }, { restart: false });
      trackSheet(trackId);
    };
  });
}

// ---------- Agregar pista ----------
function addTrackSheet() {
  openSheet((el) => {
    el.innerHTML = sheetHead('Agregar pista') + `<div class="sheet-body">
      <button class="sheet-item" data-a="rec">${icon('ic-mic')}Grabar voz<span class="hint">Micrófono</span></button>
      <button class="sheet-item" data-a="import">${icon('ic-upload')}Importar audio<span class="hint">MP3, WAV…</span></button>
      <div class="sub" style="padding:12px 6px 4px">Pista vacía</div>
      ${Object.entries(TYPES).map(([k, v]) => `<button class="sheet-item" data-type="${k}">${icon(v.icon)}${v.label}</button>`).join('')}
    </div>`;
    el.onclick = (e) => {
      if (e.target.closest('[data-x]')) return closeSheet();
      const a = e.target.closest('[data-a]')?.dataset.a;
      const type = e.target.closest('[data-type]')?.dataset.type;
      if (a === 'import') { closeSheet(); pickFiles(null); return; }
      if (a === 'rec' || type) {
        const t = makeTrack(S.project, a === 'rec' ? 'VOCAL' : type);
        commit((p) => { p.tracks.push(t); });
        S.sel = { trackId: t.id, regionId: null };
        closeSheet(); renderStudio();
        const tl = $('#timeline'); tl.scrollTo({ top: tl.scrollHeight, behavior: 'smooth' });
        if (a === 'rec') toast('Pista lista: toca el botón rojo para grabar 🎙️');
      }
    };
  });
}
$('#add-track').addEventListener('click', addTrackSheet);
$('#tb-mic').addEventListener('click', () => {
  const t = makeTrack(S.project, 'VOCAL');
  commit((p) => { p.tracks.push(t); }, { restart: false });
  S.sel = { trackId: t.id, regionId: null };
  renderStudio();
  const tl = $('#timeline'); tl.scrollTo({ top: tl.scrollHeight, behavior: 'smooth' });
  toast('Pista de voz lista: toca el botón rojo para grabar 🎙️');
});
$('#tb-metro').addEventListener('click', () => {
  S.settings.metronome = engine.metronome = !S.settings.metronome;
  saveSettings();
  $('#tb-metro').classList.toggle('on', S.settings.metronome);
  toast(S.settings.metronome ? 'Metrónomo encendido' : 'Metrónomo apagado');
  if (engine.playing) startPlayback();
});
$('#tb-export').addEventListener('click', () => exportSong());
function paintSnap() { $('#snap-btn').classList.toggle('on', !!S.settings.snap); }
$('#snap-btn').addEventListener('click', () => {
  S.settings.snap = !S.settings.snap; saveSettings(); paintSnap();
  toast(S.settings.snap ? 'Imán encendido: los bloques se acomodan al ritmo' : 'Imán apagado: movimiento libre');
});
paintSnap();

// ---------- Mezclador (panel de tarjetas de color, como en BandLab) ----------
function knobSvg(pan) {
  const dots = [-135, -90, -45, 0, 45, 90, 135].map((d) => {
    const r = (d - 90) * Math.PI / 180;
    return `<circle cx="${(24 + 21 * Math.cos(r)).toFixed(1)}" cy="${(24 + 21 * Math.sin(r)).toFixed(1)}" r="1.6" fill="#fff"/>`;
  }).join('');
  const ang = pan * 135;
  return `<svg viewBox="0 0 48 48" class="knob-svg">${dots}<circle cx="24" cy="24" r="15.5" fill="#fff"/>
    <line x1="24" y1="24" x2="24" y2="12" stroke="rgba(0,0,0,.8)" stroke-width="3" stroke-linecap="round" transform="rotate(${ang} 24 24)"/></svg>`;
}
function renderMixer() {
  const p = S.project, panel = $('#mixer');
  if (!p || !panel) return;
  const scroll = panel.scrollTop;
  panel.innerHTML = p.tracks.map((t, i) => `
    <div class="mix-row ${t.muted ? 'muted' : ''}" style="--i:${i}">
      <div class="mix-card" style="background:${t.color}">
        <div class="mc-top">
          <span class="mc-num">${i + 1}</span>
          <span class="mc-name">${esc(t.name)}</span>
          <button class="mc-fx" data-mfx="${t.id}">${fxLabel(t)}</button>
          <div class="mc-ms"><button class="${t.muted ? 'on' : ''}" data-mm="${t.id}" style="${t.muted ? `color:${shade(t.color, 0.6)}` : ''}">M</button><button class="${t.solo ? 'on' : ''}" data-ms="${t.id}" style="${t.solo ? `color:${shade(t.color, 0.6)}` : ''}">S</button></div>
          <button class="mc-more" data-mmore="${t.id}" aria-label="Opciones de ${esc(t.name)}">${icon('ic-more')}</button>
        </div>
        <div class="mc-bottom">
          <input type="range" class="mc-vol" data-mvol="${t.id}" min="0" max="1.5" step="0.01" value="${t.volume}" aria-label="Volumen de ${esc(t.name)}" style="--fill:${shade(t.color, 0.62)}">
          <div class="knob" data-knob="${t.id}" role="slider" aria-label="Paneo de ${esc(t.name)}" aria-valuemin="-1" aria-valuemax="1" aria-valuenow="${t.pan}">
            ${knobSvg(t.pan)}<span class="kl">L</span><span class="kr">R</span>
          </div>
        </div>
      </div>
      <button class="mix-icon" data-mhead="${t.id}" style="color:${t.color}">${icon(TYPES[t.type]?.icon || 'ic-other')}</button>
    </div>`).join('') + `<div class="mix-row" style="--i:${p.tracks.length}"><button class="mix-master" data-a="master">Volumen general · ${volToDb(p.masterVolume ?? 1)} dB</button></div>`;
  panel.scrollTop = scroll;
  paintRanges(panel);
}
// Animación de abrir/cerrar el mezclador: las tarjetas salen desde la izquierda una tras otra.
let mixerAnim = null;
function toggleMixer(open = !S.mixerOpen, animate = true) {
  const panel = $('#mixer');
  if (open === S.mixerOpen && !mixerAnim) return;
  S.mixerOpen = open;
  $('#open-mixer').classList.toggle('on', open);
  clearTimeout(mixerAnim); mixerAnim = null;
  panel.classList.remove('opening', 'closing');
  if (open) {
    panel.classList.remove('hidden');
    renderMixer();
    panel.scrollTop = $('#timeline').scrollTop;   // las tarjetas quedan justo encima de cada pista
    if (!animate) return;
    void panel.offsetWidth;                // reinicia la animación
    panel.classList.add('opening');
    const n = S.project ? S.project.tracks.length : 0;
    mixerAnim = setTimeout(() => { panel.classList.remove('opening'); mixerAnim = null; }, 420 + n * 40);
  } else {
    if (!animate || panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }
    panel.classList.add('closing');
    mixerAnim = setTimeout(() => { panel.classList.add('hidden'); panel.classList.remove('closing'); mixerAnim = null; }, 280 + (S.project ? S.project.tracks.length : 0) * 18);
  }
}
$('#open-mixer').addEventListener('click', () => toggleMixer());

(() => {
  const panel = $('#mixer');
  panel.addEventListener('click', async (e) => {
    const get = (attr) => { const el = e.target.closest(`[${attr}]`); return el && findTrack(el.getAttribute(attr)); };
    let t;
    if ((t = get('data-mm'))) return commit(() => { t.muted = !t.muted; }, { restart: false });
    if ((t = get('data-ms'))) return commit(() => { t.solo = !t.solo; }, { restart: false });
    if ((t = get('data-mfx'))) return effectsSheet(t.id);
    if ((t = get('data-mmore'))) { S.sel = { trackId: t.id, regionId: null }; renderStudio(); return trackSheet(t.id); }
    if ((t = get('data-mhead'))) { S.sel = { trackId: t.id, regionId: null }; return renderStudio(); }
    if (e.target.closest('[data-a="master"]')) {
      const v = await dialog({ title: 'Volumen general (dB)', value: volToDb(S.project.masterVolume ?? 1), type: 'number', ok: 'Guardar' });
      if (v === null) return;
      const db = clamp(Number(v), -40, 3.5);
      if (Number.isFinite(db)) { S.project.masterVolume = Math.pow(10, db / 20); engine.setMasterVolume(S.project.masterVolume); touch(); renderMixer(); }
    }
  });
  // Volumen
  panel.addEventListener('pointerdown', (e) => { if (e.target.matches('.mc-vol')) beginLive(); });
  panel.addEventListener('input', (e) => {
    if (!e.target.matches('.mc-vol')) return;
    beginLive();
    findTrack(e.target.dataset.mvol).volume = parseFloat(e.target.value);
    paintRanges(e.target.parentElement);
    liveChange();
  });
  panel.addEventListener('change', (e) => { if (e.target.matches('.mc-vol')) endLive(); });
  // Perilla de paneo: arrastra a los lados (o arriba/abajo); doble toque = al centro
  let knob = null, lastTap = 0;
  panel.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('[data-knob]');
    if (!el) return;
    e.preventDefault();
    const t = findTrack(el.dataset.knob);
    const now = Date.now();
    if (now - lastTap < 300) { beginLive(); t.pan = 0; liveChange(); endLive(); el.querySelector('svg').outerHTML = knobSvg(0); lastTap = 0; return; }
    lastTap = now;
    beginLive();
    knob = { el, t, x: e.clientX, y: e.clientY, pan: t.pan };
    el.setPointerCapture(e.pointerId);
  });
  panel.addEventListener('pointermove', (e) => {
    if (!knob) return;
    const d = (e.clientX - knob.x - (e.clientY - knob.y)) / 120;
    let v = clamp(knob.pan + d, -1, 1);
    if (Math.abs(v) < 0.04) v = 0;
    knob.t.pan = v;
    knob.el.querySelector('svg').outerHTML = knobSvg(v);
    liveChange();
  });
  const endKnob = () => { if (knob) { knob = null; endLive(); } };
  panel.addEventListener('pointerup', endKnob);
  panel.addEventListener('pointercancel', endKnob);
})();

// ---------- Efectos ----------
function fmtParam(def, v) {
  if (def.options) return def.options[v];
  const decimals = def.step < 1 ? 1 : 0;
  return `${Number(v).toFixed(decimals)}${def.unit ? ' ' + def.unit : ''}`;
}
function effectsSheet(trackId) {
  openSheet((el) => {
    const t = findTrack(trackId);
    if (!t) return closeSheet();
    const mine = S.settings.myPresets || [];
    el.innerHTML = sheetHead(`<span style="color:${t.color}">●</span> Efectos · ${esc(t.name)}`) + `<div class="sheet-body">
      <div class="preset-row">
        ${PRESETS.map((p, i) => `<button class="preset" data-preset="${i}">${esc(p.name)}</button>`).join('')}
        ${mine.map((p, i) => `<button class="preset" data-mypreset="${i}" style="box-shadow:0 0 0 1px ${t.color} inset">★ ${esc(p.name)}</button>`).join('')}
      </div>
      ${(t.effects || []).map((fx) => {
        const def = EFFECTS[fx.type];
        return `<div class="fx-card ${fx.enabled ? '' : 'off'}">
          <div class="fx-head">
            <button class="switch ${fx.enabled ? 'on' : ''}" data-toggle="${fx.id}" aria-label="Encender o apagar"></button>
            <div class="names"><b>${def.label}</b><span class="tag">${def.sub}</span></div>
            <button class="icon-btn" data-delfx="${fx.id}" aria-label="Quitar efecto">${icon('ic-delete')}</button>
          </div>
          ${def.params.map((pd) => pd.options
            ? `<div class="field"><label>${pd.label}</label><select class="text-input" data-sel="${fx.id}:${pd.key}">
                ${Object.entries(pd.options).map(([k, v]) => `<option value="${k}" ${fx.params[pd.key] === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>`
            : `<div class="field"><label>${pd.label}<b class="value-box" data-show="${fx.id}:${pd.key}">${fmtParam(pd, fx.params[pd.key])}</b></label>
                <input type="range" data-range="${fx.id}:${pd.key}" min="${pd.min}" max="${pd.max}" step="${pd.step}" value="${fx.params[pd.key]}"></div>`).join('')}
        </div>`;
      }).join('') || '<div class="empty" style="padding:20px">Sin efectos. Elige un preset de arriba o agrega uno.</div>'}
      <div class="row-btns">
        <button class="btn primary" data-a="add">${icon('ic-add', 'sm')}Agregar efecto</button>
        <button class="btn" data-a="save">${icon('ic-save', 'sm')}Guardar preset</button>
      </div>
    </div>`;
    const handlers = {};
    (t.effects || []).forEach((fx) => EFFECTS[fx.type].params.forEach((pd) => {
      if (!pd.options) handlers[`${fx.id}:${pd.key}`] = (v) => { fx.params[pd.key] = v; t.presetName = null; return fmtParam(pd, v); };
    }));
    bindRanges(el, handlers);
    el.querySelectorAll('[data-sel]').forEach((s) => s.addEventListener('change', () => {
      const [id, key] = s.dataset.sel.split(':');
      const fx = t.effects.find((x) => x.id === id);
      commit(() => { fx.params[key] = s.value; t.presetName = null; }, { restart: false, render: false });
    }));
    el.onclick = async (e) => {
      if (e.target.closest('[data-x]')) return closeSheet();
      const pr = e.target.closest('[data-preset]'), my = e.target.closest('[data-mypreset]');
      if (pr || my) {
        const preset = pr ? PRESETS[pr.dataset.preset] : mine[my.dataset.mypreset];
        commit(() => { t.effects = preset.effects.map((x) => makeEffect(x.type, x.params)); t.presetName = preset.name; }, { restart: false });
        toast(`Preset "${preset.name}" aplicado`);
        return refreshSheet();
      }
      const tg = e.target.closest('[data-toggle]');
      if (tg) { const fx = t.effects.find((x) => x.id === tg.dataset.toggle); commit(() => { fx.enabled = !fx.enabled; t.presetName = null; }, { restart: false }); return refreshSheet(); }
      const del = e.target.closest('[data-delfx]');
      if (del) { commit(() => { t.effects = t.effects.filter((x) => x.id !== del.dataset.delfx); t.presetName = null; }, { restart: false }); return refreshSheet(); }
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'add') addEffectSheet(trackId);
      if (a === 'save') {
        if (!t.effects.length) return toast('Agrega efectos antes de guardar el preset');
        const name = await dialog({ title: 'Guardar preset', value: '', placeholder: 'Ej. Mi voz trap', ok: 'Guardar' });
        if (!name) return;
        S.settings.myPresets = [...mine, { name, effects: t.effects.map((x) => ({ type: x.type, params: { ...x.params } })) }];
        saveSettings(); refreshSheet(); toast('Preset guardado ★');
      }
    };
  });
}
function addEffectSheet(trackId) {
  openSheet((el) => {
    el.innerHTML = sheetHead('Agregar efecto') + `<div class="sheet-body">${Object.entries(EFFECTS).map(([k, v]) =>
      `<button class="sheet-item" data-fx="${k}">${icon('ic-sparkle')}<div><div>${v.label}</div><div class="sub">${v.sub}</div></div></button>`).join('')}</div>`;
    el.onclick = (e) => {
      if (e.target.closest('[data-x]')) return effectsSheet(trackId);
      const b = e.target.closest('[data-fx]'); if (!b) return;
      const t = findTrack(trackId);
      commit(() => { t.effects = [...(t.effects || []), makeEffect(b.dataset.fx)]; t.presetName = null; }, { restart: false });
      effectsSheet(trackId);
    };
  });
}
$('#open-fx').addEventListener('click', () => {
  const id = S.sel.trackId || S.project.tracks[0]?.id;
  if (!id) return toast('Primero agrega una pista');
  effectsSheet(id);
});

// ---------- Menú del proyecto ----------
function projectSheet() {
  openSheet((el) => {
    const p = S.project;
    el.innerHTML = sheetHead('Proyecto') + `<div class="sheet-body">
      <button class="sheet-item" data-a="rename">${icon('ic-edit')}Renombrar<span class="hint">${esc(p.title)}</span></button>
      <button class="sheet-item" data-a="bpm">${icon('ic-timer')}Tempo<span class="hint">${p.bpm} BPM</span></button>
      <button class="sheet-item" data-a="metro">${icon('ic-timer')}Metrónomo<span class="switch ${S.settings.metronome ? 'on' : ''}" style="margin-left:auto"></span></button>
      <button class="sheet-item" data-a="snap">${icon('ic-tune')}Ajustar a la cuadrícula<span class="switch ${S.settings.snap ? 'on' : ''}" style="margin-left:auto"></span></button>
      ${rangeField('Compensar retraso al grabar', 'lat', 0, 400, 5, S.settings.latencyMs, S.settings.latencyMs + ' ms')}
      <div class="sub" style="margin:-4px 0 10px">Si tu voz grabada queda atrasada respecto a la pista, súbelo poco a poco.</div>
      <button class="sheet-item" data-a="export">${icon('ic-download')}Exportar canción (WAV)</button>
      <button class="sheet-item" data-a="sync">${icon('ic-cloud-up')}Sincronizar con Abraham IA Music<span class="hint">Pronto</span></button>
      <div class="sub" style="text-align:center;padding:14px 0 4px">Arcadia v${VERSION}</div>
    </div>`;
    const lat = el.querySelector('[data-range="lat"]');
    lat.addEventListener('input', () => { S.settings.latencyMs = +lat.value; el.querySelector('[data-show="lat"]').textContent = lat.value + ' ms'; saveSettings(); });
    el.onclick = async (e) => {
      if (e.target.closest('[data-x]')) return closeSheet();
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'rename') { const t = await dialog({ title: 'Renombrar proyecto', value: p.title, ok: 'Guardar' }); if (t) commit(() => { p.title = t; }, { restart: false }); refreshSheet(); }
      if (a === 'bpm') {
        const v = await dialog({ title: 'Tempo (BPM)', value: String(p.bpm), type: 'number', ok: 'Guardar' });
        const n = Math.round(Number(v));
        if (v && n >= 40 && n <= 240) commit(() => { p.bpm = n; }, { restart: false });
        else if (v) toast('Escribe un tempo entre 40 y 240');
        refreshSheet();
      }
      if (a === 'metro') { S.settings.metronome = engine.metronome = !S.settings.metronome; saveSettings(); refreshSheet(); if (engine.playing) startPlayback(); }
      if (a === 'snap') { S.settings.snap = !S.settings.snap; saveSettings(); refreshSheet(); }
      if (a === 'export') { closeSheet(); exportSong(); }
      if (a === 'sync') toast(SOON.sync);
    };
  });
}
$('#menu').addEventListener('click', projectSheet);
$('#title-btn').addEventListener('click', projectSheet);
$('#undo').addEventListener('click', undo);
$('#redo').addEventListener('click', redo);

// =====================================================================
// Importar, grabar y exportar
// =====================================================================
let importTarget = null;
function pickFiles(trackId) { importTarget = trackId; $('#file-input').value = ''; $('#file-input').click(); }
$('#import-btn').addEventListener('click', () => pickFiles(null));

function guessType(name) {
  const n = name.toLowerCase();
  if (/coro|choir|backing|harmon/.test(n)) return 'CHOIR';
  if (/voz|vocal|voice|acapella|lead/.test(n)) return 'VOCAL';
  if (/drum|bater|perc|kick|snare/.test(n)) return 'DRUMS';
  if (/bass|bajo|808/.test(n)) return 'BASS';
  if (/inst|beat|music|pista|track/.test(n)) return 'INSTRUMENTAL';
  return 'OTHER';
}

$('#file-input').addEventListener('change', async (e) => {
  const files = [...e.target.files];
  if (!files.length) return;
  const done = busy(files.length > 1 ? `Importando ${files.length} pistas…` : 'Importando audio…');
  const target = importTarget && findTrack(importTarget);
  const added = [];
  try {
    for (const file of files) {
      const audioId = uid();
      const buf = await engine.addBuffer(audioId, await file.arrayBuffer());
      await store.saveAudio(audioId, file, file.name);
      const name = file.name.replace(/\.[^.]+$/, '');
      added.push({ name, audioId, length: buf.duration });
    }
    commit((p) => {
      added.forEach((a, i) => {
        const region = { id: uid(), name: a.name, audioId: a.audioId, start: target ? engine.position : 0, offset: 0, length: a.length };
        if (target && i === 0) { target.regions.push(region); return; }
        const t = makeTrack(p, guessType(a.name), a.name.slice(0, 40));
        t.regions.push(region);
        p.tracks.push(t);
      });
    });
    toast(added.length > 1 ? `${added.length} pistas importadas ✨` : 'Audio importado ✨');
  } catch (err) {
    console.error(err);
    toast('No se pudo leer ese archivo de audio');
  } finally {
    done();
  }
});

async function toggleRecord() {
  if (S.recording) {
    const rec = S.recording;
    S.recording = null;
    $('#record').classList.remove('on');
    const blob = await engine.stopRecording();
    stopPlayback();
    if (!blob || !blob.size) { renderStudio(); return toast('No se grabó audio'); }
    const done = busy('Guardando toma…');
    try {
      const audioId = uid();
      const buf = await engine.addBuffer(audioId, await blob.arrayBuffer());
      await store.saveAudio(audioId, blob, 'grabacion');
      const lat = S.settings.latencyMs / 1000;
      const t = findTrack(rec.trackId);
      const n = t.regions.length + 1;
      commit(() => {
        t.regions.push({ id: uid(), name: `Toma ${n}`, audioId, start: rec.start, offset: Math.min(lat + 0.06, buf.duration / 2), length: Math.max(0.1, buf.duration - lat - 0.06) });
      }, { restart: false });
      toast('¡Toma guardada! 🎙️');
    } catch (err) {
      console.error(err); toast('No se pudo guardar la grabación'); renderStudio();
    } finally { done(); }
    return;
  }
  // Empezar a grabar
  let t = findTrack(S.sel.trackId);
  if (!t) {
    t = makeTrack(S.project, 'VOCAL');
    commit((p) => { p.tracks.push(t); }, { restart: false });
    S.sel = { trackId: t.id, regionId: null };
  }
  try {
    if (engine.playing) stopPlayback();
    await engine.loadProject(S.project);
    await engine.startRecording();
  } catch (err) {
    console.error(err);
    return toast('No se pudo usar el micrófono. Revisa los permisos del navegador.');
  }
  S.recording = { trackId: t.id, start: engine.position };
  $('#record').classList.add('on');
  renderStudio();
  startPlayback();
}
$('#record').addEventListener('click', toggleRecord);

async function exportSong() {
  if (!projectEnd(S.project)) return toast('Agrega audio antes de exportar');
  if (engine.playing) stopPlayback();
  const done = busy('Mezclando tu canción…');
  try {
    const blob = await engine.exportWav(S.project);
    const fileName = `${S.project.title.replace(/[\\/:*?"<>|]/g, '')}.wav`;
    done();
    const file = new File([blob], fileName, { type: 'audio/wav' });
    const canShare = navigator.canShare && navigator.canShare({ files: [file] });
    openSheet((el) => {
      el.innerHTML = sheetHead('Tu canción está lista 🎉') + `<div class="sheet-body">
        <div class="sub" style="margin-bottom:8px">${esc(fileName)} · ${(blob.size / 1048576).toFixed(1)} MB</div>
        <button class="sheet-item" data-a="dl">${icon('ic-download')}Descargar WAV</button>
        ${canShare ? `<button class="sheet-item" data-a="share">${icon('ic-share')}Compartir (WhatsApp, Drive…)</button>` : ''}
      </div>`;
      el.onclick = async (e) => {
        if (e.target.closest('[data-x]')) return closeSheet();
        const a = e.target.closest('[data-a]')?.dataset.a;
        if (a === 'dl') {
          const url = URL.createObjectURL(blob);
          const link = document.createElement('a');
          link.href = url; link.download = fileName; document.body.appendChild(link); link.click(); link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 30000);
        }
        if (a === 'share') { try { await navigator.share({ files: [file], title: S.project.title }); } catch (err) {} }
      };
    });
  } catch (err) {
    console.error(err); done(); toast('No se pudo exportar la canción');
  }
}

// =====================================================================
// Navegación (con #, así el botón "atrás" del cel funciona)
// =====================================================================
async function openProject(p) {
  S.project = p;
  S.sel = { trackId: null, regionId: null };
  S.undo = []; S.redo = [];
  toggleMixer(false, false);
  engine.startPos = 0;
  engine.chains.forEach((c) => { try { c.vol.disconnect(); c.pan.disconnect(); } catch (e) {} });
  engine.chains.clear();
  engine.setMasterVolume(p.masterVolume ?? 1);
  $('#library').classList.add('hidden');
  $('#studio').classList.remove('hidden');
  renderStudio();
  $('#timeline').scrollLeft = 0;
  await engine.loadProject(p);
  if (S.project === p) renderStudio();
}

async function route() {
  closeSheet();
  const m = location.hash.match(/^#p-(.+)$/);
  const p = m && S.projects.find((x) => x.id === m[1] && !x.deletedAt);
  if (S.recording) await toggleRecord();
  if (engine.playing) stopPlayback();
  if (p) {
    if (S.project !== p) await openProject(p);
  } else {
    if (S.project) { clearTimeout(saveTimer); await store.saveProject(S.project); }
    S.project = null;
    $('#studio').classList.add('hidden');
    $('#library').classList.remove('hidden');
    renderLibrary();
  }
}
$('#back').addEventListener('click', () => { location.hash = ''; });
window.addEventListener('hashchange', route);
window.addEventListener('pagehide', () => { if (S.project) store.saveProject(S.project); });

// =====================================================================
// Arranque
// =====================================================================
$('#app-version').textContent = 'v' + VERSION;
(async function init() {
  try { S.projects = await store.loadProjects(); } catch (e) { S.projects = []; }
  if (!S.projects.length && !S.settings.seeded) {
    const demo = demoProject();
    S.projects.push(demo);
    await store.saveProject(demo);
    S.settings.seeded = true; saveSettings();
  }
  store.askPersistence();
  await route();
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).then((reg) => reg.update()).catch(() => {});
    // Cuando llega una versión nueva, recarga una sola vez para usarla (si no estás grabando ni reproduciendo).
    let reloaded = false;
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (reloaded || S.recording || engine.playing) return;
      reloaded = true;
      location.reload();
    });
  }
})();
