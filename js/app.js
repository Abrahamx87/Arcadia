// Arcadia — interfaz de la app (biblioteca + estudio).
import * as store from './store.js';
import { Engine, projectEnd, DEMO } from './engine.js';
import { EFFECTS, PRESETS, defaultParams } from './effects.js';

// =====================================================================
// Constantes y utilidades
// =====================================================================
const HEADER_W = 132;
const ZOOMS = [8, 12, 20, 30, 40, 60, 90, 130, 200];
const COLORS = ['#FF4D6D', '#FFB020', '#4DD68A', '#3DB8FF', '#B26BFF', '#FF7A3D',
  '#2EE6D0', '#FF5CC8', '#C6F432', '#7C8CFF', '#FFD84D', '#FF8FA3'];
const TYPES = {
  VOCAL: { label: 'Voz', icon: 'ic-mic' },
  INSTRUMENTAL: { label: 'Instrumental', icon: 'ic-note' },
  CHOIR: { label: 'Coros', icon: 'ic-choir' },
  DRUMS: { label: 'Batería', icon: 'ic-drums' },
  BASS: { label: 'Bajo', icon: 'ic-bass' },
  OTHER: { label: 'Otro', icon: 'ic-other' },
};
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
  zoom: 4,
  undo: [],
  redo: [],
  recording: null,
  settings: loadSettings(),
};
engine.metronome = S.settings.metronome;
const pps = () => ZOOMS[S.zoom];

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
function openSheet(render) {
  sheetRender = render;
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
function closeSheet() { $('#overlay').innerHTML = ''; sheetRender = null; endLive(); }
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

function renderStudio() {
  const p = S.project; if (!p) return;
  const scale = pps();
  const total = timelineLength();
  const width = Math.ceil(total * scale);
  $('#studio-title').textContent = p.title;
  $('#studio-sub').textContent = `${p.tracks.length} pistas · ${p.bpm} BPM`;
  $('#bpm-label').textContent = `${p.bpm} BPM`;
  $('#t-total').textContent = '/ ' + fmtTime(Math.max(projectEnd(p), 0));
  $('#tl-inner').style.width = HEADER_W + width + 'px';
  drawRuler(p, width, scale);

  const beatPx = (60 / p.bpm) * scale, barPx = beatPx * 4;
  const grid = `repeating-linear-gradient(90deg, var(--grid-bar) 0 1px, transparent 1px ${barPx}px)` +
    (beatPx > 14 ? `, repeating-linear-gradient(90deg, var(--grid) 0 1px, transparent 1px ${beatPx}px)` : '');
  const anySolo = p.tracks.some((t) => t.solo);
  const rows = p.tracks.map((t, i) => {
    const dim = t.muted || (anySolo && !t.solo);
    const fxOn = (t.effects || []).some((e) => e.enabled);
    const regions = t.regions.map((r) => {
      const loading = !engine.buffers.has(r.audioId);
      return `<div class="region ${S.sel.regionId === r.id ? 'selected' : ''} ${loading ? 'loading' : ''}" data-region="${r.id}" data-track="${t.id}"
        style="left:${r.start * scale}px;width:${Math.max(4, r.length * scale)}px;background:${t.color};opacity:${dim ? 0.35 : 1}">
        <div class="rname">${esc(r.name)}</div><canvas></canvas></div>`;
    }).join('');
    return `<div class="track-row">
      <div class="track-head ${S.sel.trackId === t.id ? 'selected' : ''}" data-head="${t.id}">
        <div class="stripe" style="background:${t.color}"></div>
        <div class="body">
          <div class="tname" style="color:${t.color}">${icon(TYPES[t.type]?.icon || 'ic-other')}<span style="color:var(--text)">${esc(t.name)}</span></div>
          <div class="toggles">
            <button class="toggle m ${t.muted ? 'on' : ''}" data-mute="${t.id}">M</button>
            <button class="toggle s ${t.solo ? 'on' : ''}" data-solo="${t.id}">S</button>
            ${fxOn ? `<span class="fx-dot on" style="background:${t.color}">FX</span>` : ''}
          </div>
        </div>
      </div>
      <div class="lane" data-lane="${t.id}" style="width:${width}px;background-color:${i % 2 ? 'var(--lane-alt)' : 'var(--lane)'};background-image:${grid}">
        ${regions}
        ${S.recording && S.recording.trackId === t.id ? `<div class="rec-region" id="rec-region" style="left:${S.recording.start * scale}px;width:0"></div>` : ''}
      </div>
    </div>`;
  }).join('');
  $('#tracks').innerHTML = rows || '<div class="empty" style="position:sticky;left:0;width:100vw">Este proyecto está vacío.<br>Toca <b>+ Pista</b> para grabar tu voz o <b>Importar</b> para subir tus pistas de IA.</div>';

  // Formas de onda
  p.tracks.forEach((t) => t.regions.forEach((r) => {
    const el = $(`[data-region="${r.id}"] canvas`);
    if (el) drawWave(el, r);
  }));
  $('#playhead').style.height = (30 + Math.max(1, p.tracks.length) * 79) + 'px';
  renderEditBar();
  updatePlayhead();
  updateUndoButtons();
}

function drawWave(canvas, r) {
  const peaks = engine.peaks.get(r.audioId);
  if (!peaks) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = Math.min(canvas.clientWidth, 6000), h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = Math.floor(w * dpr); canvas.height = Math.floor(h * dpr);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  const mid = h / 2;
  const n = peaks.min.length;
  for (let x = 0; x < w; x++) {
    const t0 = r.offset + (x / w) * r.length, t1 = r.offset + ((x + 1) / w) * r.length;
    let a = Math.floor(t0 * peaks.rate), b = Math.max(a + 1, Math.floor(t1 * peaks.rate));
    if (a >= n) break;
    b = Math.min(b, n);
    let lo = 0, hi = 0;
    for (let i = a; i < b; i++) { if (peaks.min[i] < lo) lo = peaks.min[i]; if (peaks.max[i] > hi) hi = peaks.max[i]; }
    const g = r.gain ?? 1;
    const y1 = mid - Math.min(1, hi * g) * mid, y2 = mid - Math.max(-1, lo * g) * mid;
    ctx.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
}

function drawRuler(p, width, scale) {
  const ruler = $('#ruler');
  ruler.style.width = width + 'px';
  ruler.querySelectorAll('canvas').forEach((c) => c.remove());
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const h = 30, TILE = 4000;
  const beat = 60 / p.bpm;
  const beatPx = beat * scale;
  const barEvery = beatPx * 4 < 28 ? 4 : 1; // con poco zoom, numera cada 4 compases
  for (let x0 = 0; x0 < width; x0 += TILE) {
    const w = Math.min(TILE, width - x0);
    const cv = document.createElement('canvas');
    cv.width = w * dpr; cv.height = h * dpr;
    cv.style.cssText = `position:absolute;left:${x0}px;top:0;width:${w}px;height:${h}px`;
    const ctx = cv.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.font = '600 10px system-ui, sans-serif';
    const b0 = Math.floor(x0 / beatPx), b1 = Math.ceil((x0 + w) / beatPx);
    for (let b = b0; b <= b1; b++) {
      const x = Math.round(b * beatPx - x0) + 0.5;
      const isBar = b % 4 === 0;
      if (!isBar && beatPx < 8) continue;
      ctx.strokeStyle = isBar ? '#55555f' : '#26262e';
      ctx.beginPath(); ctx.moveTo(x, isBar ? 8 : h * 0.62); ctx.lineTo(x, h); ctx.stroke();
      if (isBar && (b / 4) % barEvery === 0) { ctx.fillStyle = '#9b9ba8'; ctx.fillText(String(b / 4 + 1), x + 4, 16); }
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
function updatePlayhead(follow = false) {
  const pos = engine.position;
  const x = pos * pps();
  $('#playhead').style.transform = `translateX(${HEADER_W + x}px)`;
  $('#ph-tri').style.transform = `translateX(${x}px)`;
  $('#t-now').textContent = fmtTime(pos);
  if (follow) {
    const tl = $('#timeline');
    const visible = tl.clientWidth - HEADER_W;
    const rel = x - tl.scrollLeft;
    if (rel > visible * 0.85 || rel < 0) tl.scrollLeft = Math.max(0, x - visible * 0.15);
  }
}
function tick() {
  if (!engine.playing) return;
  updatePlayhead(true);
  if (S.recording) {
    const rr = $('#rec-region');
    if (rr) rr.style.width = Math.max(0, (engine.position - S.recording.start) * pps()) + 'px';
    if (engine.position * pps() > parseFloat($('#tl-inner').style.width) - HEADER_W - 200) renderStudio();
  } else if (engine.position > timelineLength()) {
    stopPlayback();
  }
  raf = requestAnimationFrame(tick);
}
function startPlayback() {
  engine.ensure();
  engine.setMasterVolume(S.project.masterVolume ?? 1);
  engine.play(S.project, engine.position);
  $('#play-icon').setAttribute('href', '#ic-pause');
  cancelAnimationFrame(raf);
  raf = requestAnimationFrame(tick);
}
function stopPlayback() {
  engine.stop();
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
  updatePlayhead();
}

$('#play').addEventListener('click', async () => {
  if (S.recording) return toggleRecord();
  if (engine.playing) return stopPlayback();
  engine.ensure();
  await engine.loadProject(S.project);
  startPlayback();
});
$('#rewind').addEventListener('click', () => { if (S.recording) return; seek(0); $('#timeline').scrollLeft = 0; });
document.addEventListener('keydown', (e) => {
  if (!S.project || e.target.matches('input, select, textarea')) return;
  if (e.code === 'Space') { e.preventDefault(); $('#play').click(); }
  if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
});

// ---------- Zoom ----------
function setZoom(z) {
  const tl = $('#timeline');
  const visible = tl.clientWidth - HEADER_W;
  const centerSec = (tl.scrollLeft + visible / 2) / pps();
  S.zoom = clamp(z, 0, ZOOMS.length - 1);
  renderStudio();
  tl.scrollLeft = Math.max(0, centerSec * pps() - visible / 2);
}
$('#zoom-in').addEventListener('click', () => setZoom(S.zoom + 1));
$('#zoom-out').addEventListener('click', () => setZoom(S.zoom - 1));

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
  const head = e.target.closest('[data-head]');
  if (head) { S.sel = { trackId: head.dataset.head, regionId: null }; renderStudio(); trackSheet(head.dataset.head); return; }
  const reg = e.target.closest('[data-region]');
  if (reg) { S.sel = { trackId: reg.dataset.track, regionId: reg.dataset.region }; renderStudio(); return; }
  const lane = e.target.closest('[data-lane]');
  if (lane) {
    seek((e.clientX - lane.getBoundingClientRect().left) / pps());
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
      if (a === 'del') {
        const ok = await dialog({ title: `¿Eliminar "${t.name}"?`, text: 'Puedes recuperarla con Deshacer.', ok: 'Eliminar', danger: true });
        if (ok) { commit((p) => { p.tracks = p.tracks.filter((x) => x !== t); }); S.sel = { trackId: null, regionId: null }; closeSheet(); renderStudio(); }
      }
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
$('#add-track-inline').addEventListener('click', addTrackSheet);

// ---------- Mezclador ----------
function mixerSheet() {
  openSheet((el) => {
    const p = S.project;
    el.innerHTML = sheetHead('Mezclador') + `<div class="sheet-body">
      ${rangeField('Volumen general', 'master', 0, 1.5, 0.01, p.masterVolume ?? 1, volToDb(p.masterVolume ?? 1) + ' dB')}
      ${p.tracks.map((t) => `<div class="mixer-row">
        <div class="bar" style="background:${t.color}"></div>
        <div>
          <div class="nm"><span>${esc(t.name)}</span><span class="sub" data-show="v-${t.id}">${volToDb(t.volume)} dB · ${fmtPan(t.pan)}</span></div>
          <div class="mini"><span>Vol</span><input type="range" data-range="v-${t.id}" min="0" max="1.5" step="0.01" value="${t.volume}" aria-label="Volumen ${esc(t.name)}"></div>
          <div class="mini"><span>Pan</span><input type="range" data-range="p-${t.id}" min="-1" max="1" step="0.02" value="${t.pan}" aria-label="Paneo ${esc(t.name)}"></div>
        </div>
        <div class="toggles" style="flex-direction:column">
          <button class="toggle m ${t.muted ? 'on' : ''}" data-mm="${t.id}">M</button>
          <button class="toggle s ${t.solo ? 'on' : ''}" data-ms="${t.id}">S</button>
        </div>
      </div>`).join('') || '<div class="empty">No hay pistas todavía.</div>'}
    </div>`;
    const handlers = { master: (v) => { p.masterVolume = v; engine.setMasterVolume(v); return volToDb(v) + ' dB'; } };
    p.tracks.forEach((t) => {
      const label = () => `${volToDb(t.volume)} dB · ${fmtPan(t.pan)}`;
      handlers['v-' + t.id] = (v) => { t.volume = v; el.querySelector(`[data-show="v-${t.id}"]`).textContent = label(); };
      handlers['p-' + t.id] = (v) => { t.pan = Math.abs(v) < 0.04 ? 0 : v; el.querySelector(`[data-show="v-${t.id}"]`).textContent = label(); };
    });
    bindRanges(el, handlers);
    el.onclick = (e) => {
      if (e.target.closest('[data-x]')) return closeSheet();
      const m = e.target.closest('[data-mm]'), s = e.target.closest('[data-ms]');
      if (m || s) {
        const t = findTrack((m || s).dataset.mm || (m || s).dataset.ms);
        commit(() => { if (m) t.muted = !t.muted; else t.solo = !t.solo; }, { restart: false });
        refreshSheet();
      }
    };
  });
}
$('#open-mixer').addEventListener('click', mixerSheet);

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
      if (!pd.options) handlers[`${fx.id}:${pd.key}`] = (v) => { fx.params[pd.key] = v; return fmtParam(pd, v); };
    }));
    bindRanges(el, handlers);
    el.querySelectorAll('[data-sel]').forEach((s) => s.addEventListener('change', () => {
      const [id, key] = s.dataset.sel.split(':');
      const fx = t.effects.find((x) => x.id === id);
      commit(() => { fx.params[key] = s.value; }, { restart: false, render: false });
    }));
    el.onclick = async (e) => {
      if (e.target.closest('[data-x]')) return closeSheet();
      const pr = e.target.closest('[data-preset]'), my = e.target.closest('[data-mypreset]');
      if (pr || my) {
        const preset = pr ? PRESETS[pr.dataset.preset] : mine[my.dataset.mypreset];
        commit(() => { t.effects = preset.effects.map((x) => makeEffect(x.type, x.params)); }, { restart: false });
        toast(`Preset "${preset.name}" aplicado`);
        return refreshSheet();
      }
      const tg = e.target.closest('[data-toggle]');
      if (tg) { const fx = t.effects.find((x) => x.id === tg.dataset.toggle); commit(() => { fx.enabled = !fx.enabled; }, { restart: false }); return refreshSheet(); }
      const del = e.target.closest('[data-delfx]');
      if (del) { commit(() => { t.effects = t.effects.filter((x) => x.id !== del.dataset.delfx); }, { restart: false }); return refreshSheet(); }
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
      commit(() => { t.effects = [...(t.effects || []), makeEffect(b.dataset.fx)]; }, { restart: false });
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
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
})();
