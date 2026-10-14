// 測定用: マイクによるオクターブバンドレベル測定と、試験音(ピンクノイズ)の再生。

import { BANDS } from './privacy.js';
import { loopBuffer, pinkGen, sliderToGain } from './audio-engine.js';

export class BandMeter {
  constructor() {
    this.ctx = null;
  }

  async init() {
    if (this.ctx) return;
    // 自動音量調整やノイズ除去が効くと測定値が狂うので、すべて無効にする
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    this.ctx = new AudioContext();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.analyser.smoothingTimeConstant = 0;
    this.ctx.createMediaStreamSource(stream).connect(this.analyser);

    const binHz = this.ctx.sampleRate / this.analyser.fftSize;
    const last = this.analyser.frequencyBinCount - 1;
    this.bins = BANDS.map((fc) => [
      Math.ceil(fc / Math.SQRT2 / binHz),
      Math.min(last, Math.floor((fc * Math.SQRT2) / binHz)),
    ]);
  }

  /** seconds 秒間の平均バンドレベル(相対dB)を返す。onProgress(割合, 現在の全体レベルdB) */
  async measure(seconds, onProgress) {
    await this.init();
    await this.ctx.resume();
    const data = new Float32Array(this.analyser.frequencyBinCount);
    const acc = new Float64Array(BANDS.length);
    let frames = 0;
    const t0 = performance.now();

    return new Promise((resolve) => {
      const id = setInterval(() => {
        this.analyser.getFloatFrequencyData(data);
        let total = 0;
        this.bins.forEach(([lo, hi], b) => {
          let sum = 0;
          for (let k = lo; k <= hi; k++) sum += 10 ** (data[k] / 10);
          acc[b] += sum;
          total += sum;
        });
        frames++;
        const elapsed = (performance.now() - t0) / 1000;
        onProgress?.(Math.min(1, elapsed / seconds), toDb(total));
        if (elapsed >= seconds) {
          clearInterval(id);
          resolve(Array.from(acc, (a) => toDb(a / frames)));
        }
      }, 100);
    });
  }
}

const toDb = (p) => (p > 0 ? 10 * Math.log10(p) : -120);

/** 会議室側で鳴らす試験音。全帯域の漏れを測るためピンクノイズを使う。 */
export class TestSignal {
  constructor() {
    this.ctx = null;
    this.src = null;
  }

  get running() {
    return this.src !== null;
  }

  async start(volume) {
    if (this.src) return;
    if (!this.ctx) {
      this.ctx = new AudioContext();
      this.buffer = loopBuffer(this.ctx, 10, pinkGen);
      this.gain = this.ctx.createGain();
      this.gain.connect(this.ctx.destination);
    }
    await this.ctx.resume();
    this.gain.gain.value = sliderToGain(volume);
    this.src = this.ctx.createBufferSource();
    this.src.buffer = this.buffer;
    this.src.loop = true;
    this.src.connect(this.gain);
    this.src.start();
  }

  setVolume(volume) {
    if (this.gain) this.gain.gain.setTargetAtTime(sliderToGain(volume), this.ctx.currentTime, 0.05);
  }

  stop() {
    if (!this.src) return;
    this.src.stop();
    this.src = null;
  }
}
