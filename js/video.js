// Video MP4 de una canción: imagen fija + la mezcla final.
// Usa los codificadores del propio celular (WebCodecs): rápido y sin internet.
import { Mp4Muxer } from './mp4mux.js';

const SIZE = 1080;          // video cuadrado 1080×1080 (perfecto para Instagram, WhatsApp, YouTube)
const FPS = 1;              // la imagen no se mueve: 1 cuadro por segundo basta y pesa poquito
const KEY_EVERY = 5;        // un cuadro "completo" cada 5 s para poder adelantar el video

export function videoSupported() {
  return typeof window.VideoEncoder === 'function' && typeof window.AudioEncoder === 'function';
}

/** Dibuja la imagen en el cuadro del video: si no es cuadrada, el fondo es la misma imagen difuminada. */
export function drawCover(ctx, img, size = SIZE) {
  const iw = img.width, ih = img.height;
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  const cover = Math.max(size / iw, size / ih);
  const contain = Math.min(size / iw, size / ih);
  if (Math.abs(iw - ih) > 2) {
    ctx.save();
    ctx.filter = 'blur(40px) brightness(.55)';
    const w = iw * cover * 1.1, h = ih * cover * 1.1;
    ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
    ctx.restore();
  }
  const w = iw * contain, h = ih * contain;
  ctx.drawImage(img, (size - w) / 2, (size - h) / 2, w, h);
}

async function pickVideoConfig() {
  for (const codec of ['avc1.640028', 'avc1.4d0028', 'avc1.42e028']) {
    const cfg = { codec, width: SIZE, height: SIZE, bitrate: 2_000_000, framerate: FPS, avc: { format: 'avc' } };
    try { if ((await VideoEncoder.isConfigSupported(cfg)).supported) return cfg; } catch (e) {}
  }
  throw new Error('Este celular no puede crear video H.264');
}

async function pickAudioConfig(rate, channels) {
  const aac = { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: channels, bitrate: 256_000 };
  try { if ((await AudioEncoder.isConfigSupported(aac)).supported) return { cfg: aac, kind: 'aac' }; } catch (e) {}
  const opus = { codec: 'opus', sampleRate: rate, numberOfChannels: channels, bitrate: 256_000 };
  if ((await AudioEncoder.isConfigSupported(opus)).supported) return { cfg: opus, kind: 'opus' };
  throw new Error('Este celular no puede codificar el audio');
}

/** AudioSpecificConfig de AAC-LC por si el codificador no lo entrega. */
function aacConfig(rate, channels) {
  const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000];
  const idx = Math.max(0, rates.indexOf(rate));
  return Uint8Array.from([(2 << 3) | (idx >> 1), ((idx & 1) << 7) | (channels << 3)]);
}

const nextFrame = () => new Promise((r) => setTimeout(r, 0));

/**
 * @param {AudioBuffer} audio  mezcla final (48 kHz)
 * @param {CanvasImageSource & {width:number,height:number}} image
 * @param {(p:number)=>void} onProgress  0…1
 * @returns {Promise<{blob: Blob, audioCodec: string}>}
 */
export async function makeMp4(audio, image, onProgress = () => {}) {
  const vcfg = await pickVideoConfig();
  const channels = Math.min(2, audio.numberOfChannels);
  const { cfg: acfg, kind } = await pickAudioConfig(audio.sampleRate, channels);

  let vDesc = null, aDesc = null, failed = null;
  const vChunks = [], aChunks = [];
  const copy = (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); return b; };

  const venc = new VideoEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !vDesc) vDesc = new Uint8Array(meta.decoderConfig.description.buffer ?? meta.decoderConfig.description);
      vChunks.push({ data: copy(chunk), ts: chunk.timestamp, dur: chunk.duration, key: chunk.type === 'key' });
    },
    error: (e) => { failed = e; },
  });
  venc.configure(vcfg);

  const aenc = new AudioEncoder({
    output: (chunk, meta) => {
      if (meta?.decoderConfig?.description && !aDesc) aDesc = new Uint8Array(meta.decoderConfig.description.buffer ?? meta.decoderConfig.description);
      aChunks.push({ data: copy(chunk), ts: chunk.timestamp, dur: chunk.duration });
    },
    error: (e) => { failed = e; },
  });
  aenc.configure(acfg);

  // ---- Video: la misma imagen, 1 cuadro por segundo ----
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SIZE;
  drawCover(canvas.getContext('2d'), image);
  const frames = Math.max(1, Math.ceil(audio.duration * FPS));
  for (let i = 0; i < frames; i++) {
    const vf = new VideoFrame(canvas, { timestamp: Math.round((i * 1e6) / FPS), duration: Math.round(1e6 / FPS) });
    venc.encode(vf, { keyFrame: i % (KEY_EVERY * FPS) === 0 });
    vf.close();
    if (venc.encodeQueueSize > 8) await nextFrame();
    if (i % 20 === 0) { onProgress(0.25 * (i / frames)); await nextFrame(); }
    if (failed) throw failed;
  }
  await venc.flush();

  // ---- Audio: se manda en pedacitos ----
  const total = audio.length, block = 4096 * 4;
  const planes = [];
  for (let c = 0; c < channels; c++) planes.push(audio.getChannelData(c));
  for (let off = 0; off < total; off += block) {
    const n = Math.min(block, total - off);
    const data = new Float32Array(n * channels);
    for (let c = 0; c < channels; c++) data.set(planes[c].subarray(off, off + n), c * n);
    const ad = new AudioData({ format: 'f32-planar', sampleRate: audio.sampleRate, numberOfFrames: n, numberOfChannels: channels,
      timestamp: Math.round((off / audio.sampleRate) * 1e6), data });
    aenc.encode(ad);
    ad.close();
    if (aenc.encodeQueueSize > 16) await nextFrame();
    if ((off / block) % 8 === 0) { onProgress(0.25 + 0.7 * (off / total)); await nextFrame(); }
    if (failed) throw failed;
  }
  await aenc.flush();
  venc.close(); aenc.close();
  if (failed) throw failed;
  if (!vDesc) throw new Error('El codificador de video no entregó su configuración');

  // Duraciones que falten (algunos celulares no las ponen)
  const aDefault = kind === 'aac' ? (1024 / audio.sampleRate) * 1e6 : 20000;
  aChunks.forEach((c, i) => {
    if (!c.dur) c.dur = aChunks[i + 1] ? aChunks[i + 1].ts - c.ts : aDefault;
  });

  const mux = new Mp4Muxer({
    video: { width: SIZE, height: SIZE, description: vDesc },
    audio: { codec: kind, sampleRate: audio.sampleRate, channels, description: kind === 'aac' ? (aDesc || aacConfig(audio.sampleRate, channels)) : aDesc },
  });
  vChunks.forEach((c) => mux.addVideo(c.data, c.ts, c.dur || 1e6 / FPS, c.key));
  aChunks.forEach((c) => mux.addAudio(c.data, c.ts, c.dur));
  onProgress(1);
  return { blob: mux.finalize(), audioCodec: kind };
}
