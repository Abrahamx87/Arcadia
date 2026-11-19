// Arma un archivo .mp4 (video H.264 + audio AAC u Opus) a partir de lo que entregan los
// codificadores del celular (WebCodecs). Escrito a mano para no depender de librerías externas.
// El índice (moov) va al principio ("faststart"), así WhatsApp, Instagram o YouTube lo leen sin problema.

const enc = new TextEncoder();

function u8(n) { return [n & 255]; }
function u16(n) { return [(n >> 8) & 255, n & 255]; }
function u32(n) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function str(s) { return [...enc.encode(s)]; }
function concat(parts) {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
function bytes(arr) { return arr instanceof Uint8Array ? arr : Uint8Array.from(arr); }
/** Una caja MP4: tamaño (4 bytes) + nombre (4 letras) + contenido. */
function box(type, ...content) {
  const body = concat(content.map(bytes));
  return concat([bytes(u32(body.length + 8)), bytes(str(type)), body]);
}
function fullbox(type, version, flags, ...content) {
  return box(type, [version, (flags >> 16) & 255, (flags >> 8) & 255, flags & 255], ...content);
}
const MATRIX = [...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x00010000), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];

/** Descriptor MPEG-4 (para el esds del audio AAC). */
function descr(tag, payload) {
  const len = payload.length;
  return [tag, 0x80 | ((len >> 21) & 127), 0x80 | ((len >> 14) & 127), 0x80 | ((len >> 7) & 127), len & 127, ...payload];
}

export class Mp4Muxer {
  /**
   * @param {{video:{width:number,height:number,description:Uint8Array},
   *          audio:{codec:'aac'|'opus',sampleRate:number,channels:number,description?:Uint8Array}}} opt
   */
  constructor(opt) {
    this.opt = opt;
    this.v = { samples: [], timescale: 90000 };
    this.a = { samples: [], timescale: opt.audio.sampleRate };
  }

  /** timestamp y duración en microsegundos (como los da WebCodecs). */
  addVideo(data, timestampUs, durationUs, key) {
    this.v.samples.push({ data, dur: Math.round((durationUs * this.v.timescale) / 1e6), key, ts: timestampUs });
  }
  addAudio(data, timestampUs, durationUs) {
    this.a.samples.push({ data, dur: Math.round((durationUs * this.a.timescale) / 1e6), key: true, ts: timestampUs });
  }

  _stts(samples) {
    const runs = [];
    for (const s of samples) {
      const last = runs[runs.length - 1];
      if (last && last[1] === s.dur) last[0]++;
      else runs.push([1, s.dur]);
    }
    return fullbox('stts', 0, 0, u32(runs.length), ...runs.map(([c, d]) => [...u32(c), ...u32(d)]));
  }

  _stbl(track, entry, offsets, video) {
    const s = track.samples;
    const parts = [
      fullbox('stsd', 0, 0, u32(1), entry),
      this._stts(s),
    ];
    if (video) {
      const keys = [];
      s.forEach((x, i) => { if (x.key) keys.push(i + 1); });
      parts.push(fullbox('stss', 0, 0, u32(keys.length), ...keys.map(u32)));
    }
    parts.push(fullbox('stsc', 0, 0, u32(1), u32(1), u32(1), u32(1)));            // 1 muestra por bloque
    parts.push(fullbox('stsz', 0, 0, u32(0), u32(s.length), ...s.map((x) => u32(x.data.length))));
    parts.push(fullbox('stco', 0, 0, u32(offsets.length), ...offsets.map(u32)));
    return box('stbl', ...parts);
  }

  _trak(id, track, offsets, video, movieDurMs) {
    const o = this.opt;
    const dur = track.samples.reduce((a, s) => a + s.dur, 0);
    const tkhd = fullbox('tkhd', 0, 3,
      u32(0), u32(0), u32(id), u32(0), u32(movieDurMs), u32(0), u32(0),
      u16(0), u16(0), video ? u16(0) : u16(0x0100), u16(0), MATRIX,
      u32(video ? o.video.width << 16 : 0), u32(video ? o.video.height << 16 : 0));
    const mdhd = fullbox('mdhd', 0, 0, u32(0), u32(0), u32(track.timescale), u32(dur), u16(0x55c4), u16(0));
    const hdlr = fullbox('hdlr', 0, 0, u32(0), str(video ? 'vide' : 'soun'), u32(0), u32(0), u32(0),
      str(video ? 'Arcadia video' : 'Arcadia audio'), [0]);
    const xmhd = video ? fullbox('vmhd', 0, 1, u16(0), u16(0), u16(0), u16(0)) : fullbox('smhd', 0, 0, u16(0), u16(0));
    const dinf = box('dinf', fullbox('dref', 0, 0, u32(1), fullbox('url ', 0, 1)));
    let entry;
    if (video) {
      entry = box('avc1',
        [0, 0, 0, 0, 0, 0], u16(1), new Array(16).fill(0),
        u16(o.video.width), u16(o.video.height), u32(0x00480000), u32(0x00480000), u32(0), u16(1),
        new Array(32).fill(0), u16(0x0018), u16(0xffff),
        box('avcC', o.video.description));
    } else if (o.audio.codec === 'aac') {
      const asc = [...o.audio.description];
      const esds = fullbox('esds', 0, 0, descr(3, [
        ...u16(2), 0,
        ...descr(4, [0x40, 0x15, 0, 0, 0, ...u32(256000), ...u32(256000), ...descr(5, asc)]),
        ...descr(6, [2]),
      ]));
      entry = box('mp4a', [0, 0, 0, 0, 0, 0], u16(1), u32(0), u32(0), u16(o.audio.channels), u16(16), u16(0), u16(0),
        u32(o.audio.sampleRate << 16), esds);
    } else {
      // Opus en MP4 (respaldo si el celular no sabe hacer AAC)
      const dOps = box('dOps', [0], u8(o.audio.channels), u16(312), u32(o.audio.sampleRate), u16(0), [0]);
      entry = box('Opus', [0, 0, 0, 0, 0, 0], u16(1), u32(0), u32(0), u16(o.audio.channels), u16(16), u16(0), u16(0),
        u32(48000 << 16), dOps);
    }
    const stbl = this._stbl(track, entry, offsets, video);
    return box('trak', tkhd, box('mdia', mdhd, hdlr, box('minf', xmhd, dinf, stbl)));
  }

  _moov(vOff, aOff) {
    const vd = this.v.samples.reduce((a, s) => a + s.dur, 0) / this.v.timescale;
    const ad = this.a.samples.reduce((a, s) => a + s.dur, 0) / this.a.timescale;
    const movieDurMs = Math.round(Math.max(vd, ad) * 1000);
    const mvhd = fullbox('mvhd', 0, 0, u32(0), u32(0), u32(1000), u32(movieDurMs), u32(0x00010000), u16(0x0100), u16(0),
      u32(0), u32(0), MATRIX, new Array(24).fill(0), u32(3));
    return box('moov', mvhd, this._trak(1, this.v, vOff, true, movieDurMs), this._trak(2, this.a, aOff, false, movieDurMs));
  }

  /** Devuelve el .mp4 terminado como Blob. */
  finalize() {
    const ftyp = box('ftyp', str('isom'), u32(512), str('isom'), str('iso2'), str('avc1'), str('mp41'));
    // Video y audio intercalados por tiempo (así se reproduce parejo desde el inicio)
    const all = [
      ...this.v.samples.map((s) => ({ s, kind: 'v' })),
      ...this.a.samples.map((s) => ({ s, kind: 'a' })),
    ].sort((x, y) => x.s.ts - y.s.ts);
    const zeros = (n) => new Array(n).fill(0);
    // 1ª pasada: medir el tamaño del moov (no cambia con los valores de los offsets)
    const moovSize = this._moov(zeros(this.v.samples.length), zeros(this.a.samples.length)).length;
    let pos = ftyp.length + moovSize + 8; // + cabecera de mdat
    const vOff = [], aOff = [];
    for (const { s, kind } of all) { (kind === 'v' ? vOff : aOff).push(pos); pos += s.data.length; }
    const moov = this._moov(vOff, aOff);
    const mdatLen = pos - ftyp.length - moov.length;
    const mdatHead = concat([bytes(u32(mdatLen)), bytes(str('mdat'))]);
    return new Blob([ftyp, moov, mdatHead, ...all.map((x) => x.s.data)], { type: 'video/mp4' });
  }
}
