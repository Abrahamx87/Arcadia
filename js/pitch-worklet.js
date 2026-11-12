// Arcadia — cambiador de tono (pitch shifter) para el eco angelical (Shimmer).
// Técnica de "dos cabezas de lectura": lee el audio de un búfer circular a otra velocidad
// con dos lecturas desfasadas que se cruzan suavemente (ventana senoidal) para que no se escuchen cortes.

class PitchShiftProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{ name: 'ratio', defaultValue: 2, minValue: 0.25, maxValue: 4, automationRate: 'k-rate' }];
  }

  constructor() {
    super();
    this.size = 1 << 15;                       // ~0.7 s de memoria a 48 kHz
    this.mask = this.size - 1;
    this.grain = Math.round(sampleRate * 0.07); // tamaño de cada "grano": 70 ms
    this.buffers = [];
    this.write = 0;
    this.phase = 0;
  }

  process(inputs, outputs, params) {
    const input = inputs[0], output = outputs[0];
    const ratio = params.ratio[0];
    const step = (ratio - 1) / this.grain;      // cuánto avanza la fase por muestra
    const n = output[0] ? output[0].length : 128;
    const chans = output.length;
    while (this.buffers.length < chans) this.buffers.push(new Float32Array(this.size));
    let phase = 0, write = 0;
    for (let c = 0; c < chans; c++) {
      const inp = input[c] || input[0];
      const out = output[c];
      const buf = this.buffers[c];
      phase = this.phase; write = this.write;
      for (let i = 0; i < n; i++) {
        buf[write] = inp ? inp[i] : 0;
        // Dos lecturas desfasadas media ventana
        let p1 = phase, p2 = phase + 0.5; if (p2 >= 1) p2 -= 1;
        const d1 = p1 * this.grain + 1, d2 = p2 * this.grain + 1;
        const w1 = Math.sin(Math.PI * p1), w2 = Math.sin(Math.PI * p2);
        out[i] = this.read(buf, write - d1) * w1 * w1 + this.read(buf, write - d2) * w2 * w2;
        write = (write + 1) & this.mask;
        phase -= step;
        if (phase < 0) phase += 1; else if (phase >= 1) phase -= 1;
      }
    }
    this.phase = phase; this.write = write;
    return true;
  }

  read(buf, pos) {
    const i = Math.floor(pos), f = pos - i;
    const a = buf[i & this.mask], b = buf[(i + 1) & this.mask];
    return a + (b - a) * f;
  }
}

registerProcessor('pitch-shift', PitchShiftProcessor);
