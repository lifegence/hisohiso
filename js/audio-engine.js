// マスキング音の生成エンジン(Web Audio API)。
// 3つのレイヤーを合成する:
//   1. 音声帯域ノイズ   … 会話の周波数分布に合わせたノイズ(エネルギー的マスキング)
//   2. 擬似会話(バブル) … 母音フォルマントを合成した意味のない声(情報マスキング)
//   3. 環境音           … せせらぎ/空調音でマスキング音の不快感を和らげる

export const DEFAULTS = Object.freeze({
  master: 60,
  noise: 70,
  tilt: -8,
  babble: 60,
  voices: 4,
  ambient: 'stream',
  ambientVol: 40,
});

// 日本語5母音のフォルマント周波数(成人男性の目安, Hz)
const VOWELS = [
  [800, 1200, 2500], // あ
  [300, 2300, 3000], // い
  [350, 1300, 2400], // う
  [500, 1900, 2500], // え
  [500, 850, 2400], // お
];

const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

/** スライダー値(0–100)を音量に変換。100で0dB、1で約-40dB、0で無音。 */
export const sliderToGain = (v) => (v <= 0 ? 0 : 10 ** (((v - 100) * 0.4) / 20));

export function pinkGen(d) {
  // Paul Kellet のピンクノイズフィルタ
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    d[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
}

function brownGen(d) {
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    last = (last + 0.02 * (Math.random() * 2 - 1)) / 1.02;
    d[i] = last * 3.5;
  }
}

function whiteGen(d) {
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

/** ループ再生用のステレオバッファ。末尾と先頭をクロスフェードして継ぎ目のクリックを消す。 */
export function loopBuffer(ctx, seconds, gen) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const fade = Math.floor(sr * 0.05);
  const buf = ctx.createBuffer(2, len, sr);
  for (let ch = 0; ch < 2; ch++) {
    const raw = new Float32Array(len + fade);
    gen(raw);
    const out = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) {
      out[i] = i < fade ? raw[i] * (i / fade) + raw[len + i] * (1 - i / fade) : raw[i];
    }
  }
  return buf;
}

function biquad(ctx, type, frequency, Q = 1, gain = 0) {
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = frequency;
  f.Q.value = Q;
  f.gain.value = gain;
  return f;
}

function gainNode(ctx, value) {
  const g = ctx.createGain();
  g.gain.value = value;
  return g;
}

function hold(param, t) {
  if (param.cancelAndHoldAtTime) {
    param.cancelAndHoldAtTime(t);
  } else {
    const v = param.value;
    param.cancelScheduledValues(t);
    param.setValueAtTime(v, t);
  }
}

function ramp(param, value, t, tc = 0.05) {
  hold(param, t);
  param.setTargetAtTime(value, t, tc);
}

function loopSource(ctx, buffer) {
  const s = ctx.createBufferSource();
  s.buffer = buffer;
  s.loop = true;
  s.start(0, rand(0, buffer.duration));
  return s;
}

/** 擬似話者1人分。声帯音(のこぎり波)を3つのフォルマントフィルタに通し、音節単位で母音とピッチを変える。 */
class Voice {
  constructor(ctx, out, whiteBuf, female) {
    this.ctx = ctx;
    this.scale = female ? 1.15 : 1;
    this.base = female ? rand(190, 240) : rand(100, 140);
    this.pitch = this.base;
    this.phraseLeft = 0;
    this.next = ctx.currentTime + rand(0.05, 0.8);

    this.pan = ctx.createStereoPanner();
    this.pan.pan.value = rand(-0.6, 0.6);
    this.pan.connect(out);

    this.osc = ctx.createOscillator();
    this.osc.type = 'sawtooth';
    this.osc.frequency.value = this.base;
    this.voiced = gainNode(ctx, 0);
    this.osc.connect(this.voiced);
    this.formants = [[8, 1], [12, 0.5], [15, 0.25]].map(([q, g]) => {
      const f = biquad(ctx, 'bandpass', 500, q);
      this.voiced.connect(f).connect(gainNode(ctx, g)).connect(this.pan);
      return f;
    });

    // 子音(摩擦音・破裂音)用の高域ノイズ
    this.noise = loopSource(ctx, whiteBuf);
    this.fric = gainNode(ctx, 0);
    this.noise.connect(biquad(ctx, 'highpass', 2500, 0.7)).connect(this.fric).connect(this.pan);

    this.osc.start();
    this.osc.onended = () => this.pan.disconnect();
  }

  schedule(until) {
    const now = this.ctx.currentTime;
    if (this.next < now) this.next = now + 0.05; // タブが一時停止していた場合
    while (this.next < until) this.#syllable();
  }

  #syllable() {
    let t = this.next;
    if (this.phraseLeft <= 0) {
      this.phraseLeft = randInt(4, 12);
      t += rand(0.15, 0.6); // 息継ぎ
      this.pitch = this.base * rand(1.05, 1.2);
    }
    if (Math.random() < 0.35) {
      const d = rand(0.04, 0.09);
      const g = this.fric.gain;
      g.setValueAtTime(0, t);
      g.linearRampToValueAtTime(rand(0.15, 0.3), t + 0.01);
      g.linearRampToValueAtTime(0, t + d);
      t += d * 0.7;
    }

    const dur = rand(0.09, 0.22);
    const vowel = pick(VOWELS);
    this.formants.forEach((f, i) => {
      f.frequency.setTargetAtTime(vowel[i] * this.scale * rand(0.92, 1.08), t, 0.02);
    });
    // 文末に向かって下がっていくイントネーション
    this.pitch = Math.min(this.base * 1.3, Math.max(this.base * 0.8, this.pitch * rand(0.94, 1.03)));
    this.osc.frequency.setTargetAtTime(this.pitch, t, 0.03);

    this.phraseLeft--;
    const g = this.voiced.gain;
    g.setTargetAtTime(rand(0.5, 1), t, 0.012);
    g.setTargetAtTime(this.phraseLeft > 0 ? 0.05 : 0, t + dur, 0.03);
    this.next = t + dur + rand(0.01, 0.05);
  }

  stop(t) {
    ramp(this.voiced.gain, 0, t);
    ramp(this.fric.gain, 0, t);
    this.osc.stop(t + 0.3);
    this.noise.stop(t + 0.3);
  }
}

export class MaskingEngine {
  constructor(settings = DEFAULTS) {
    this.settings = { ...DEFAULTS, ...settings };
    this.ctx = null;
    this.nodes = null;
    this.timer = null;
  }

  get running() {
    return this.nodes !== null;
  }

  /** AudioContext の状態('running' / 'suspended' / iOS の 'interrupted' など)。未生成なら null。 */
  get state() {
    return this.ctx?.state ?? null;
  }

  async start() {
    if (this.nodes) return;
    if (!this.ctx) this.ctx = new AudioContext({ latencyHint: 'playback' });
    const ctx = this.ctx;
    // iOS は操作の直後でないと音を出す許可が下りないので、重い処理より先に resume を呼ぶ
    const resumed = ctx.resume();
    this.buffers ??= {
      pink: loopBuffer(ctx, 20, pinkGen),
      brown: loopBuffer(ctx, 20, brownGen),
      white: loopBuffer(ctx, 2, whiteGen),
    };
    await resumed;

    const n = (this.nodes = { sources: [], voices: [] });
    n.master = gainNode(ctx, 0);
    const limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -3;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;
    n.analyser = ctx.createAnalyser();
    n.analyser.fftSize = 2048;
    n.master.connect(limiter).connect(n.analyser).connect(ctx.destination);

    this.#buildNoise();
    this.#buildBabble();
    this.#buildAmbient();

    n.master.gain.setTargetAtTime(sliderToGain(this.settings.master), ctx.currentTime, 0.6);
    this.timer = setInterval(() => this.#tick(), 200);
    this.#tick();
  }

  /** 電話の着信などで止められた音を再開する */
  async resume() {
    if (this.nodes && this.ctx.state !== 'running') await this.ctx.resume();
  }

  async stop() {
    const n = this.nodes;
    if (!n) return;
    this.nodes = null;
    clearInterval(this.timer);
    const ctx = this.ctx;
    ramp(n.master.gain, 0, ctx.currentTime, 0.3);
    await new Promise((r) => setTimeout(r, 1500));
    for (const s of [...n.sources, ...n.ambient.sources]) s.stop();
    n.voices.forEach((v) => v.stop(ctx.currentTime));
    setTimeout(() => n.master.disconnect(), 500);
    if (!this.nodes) await ctx.suspend(); // フェード中に再開されていなければ停止
  }

  set(key, value) {
    this.settings[key] = value;
    const n = this.nodes;
    if (!n) return;
    const t = this.ctx.currentTime;
    switch (key) {
      case 'master': ramp(n.master.gain, sliderToGain(value), t); break;
      case 'noise': ramp(n.noiseGain.gain, sliderToGain(value), t); break;
      case 'tilt': ramp(n.tilt.gain, value, t); break;
      case 'babble': ramp(n.babbleBus.gain, sliderToGain(value), t); break;
      case 'voices': this.#setVoices(value); break;
      case 'ambient': this.#buildAmbient(); break;
      case 'ambientVol': ramp(n.ambient.bus.gain, sliderToGain(value), t); break;
    }
  }

  /** 出力レベル(dBFS)。停止中は -Infinity。 */
  outputLevel() {
    if (!this.nodes) return -Infinity;
    const data = new Float32Array(this.nodes.analyser.fftSize);
    this.nodes.analyser.getFloatTimeDomainData(data);
    let sum = 0;
    for (const v of data) sum += v * v;
    return 10 * Math.log10(sum / data.length);
  }

  #buildNoise() {
    const { ctx, nodes: n, settings: s } = this;
    const src = loopSource(ctx, this.buffers.pink);
    n.sources.push(src);
    n.tilt = biquad(ctx, 'highshelf', 1500, 1, s.tilt);
    n.noiseGain = gainNode(ctx, sliderToGain(s.noise));
    src
      .connect(biquad(ctx, 'highpass', 120, 0.7))
      .connect(biquad(ctx, 'peaking', 500, 1, 3))
      .connect(n.tilt)
      .connect(biquad(ctx, 'lowpass', 7000, 0.7))
      .connect(n.noiseGain)
      .connect(n.master);
  }

  #buildBabble() {
    const { ctx, nodes: n, settings: s } = this;
    n.babbleBus = gainNode(ctx, sliderToGain(s.babble));
    n.babbleNorm = gainNode(ctx, 1);
    n.babbleNorm.connect(n.babbleBus).connect(n.master);
    this.#setVoices(s.voices);
  }

  #setVoices(count) {
    const { ctx, nodes: n } = this;
    const t = ctx.currentTime;
    while (n.voices.length > count) n.voices.pop().stop(t);
    while (n.voices.length < count) {
      n.voices.push(new Voice(ctx, n.babbleNorm, this.buffers.white, n.voices.length % 2 === 1));
    }
    // 話者数が増えても全体の音量がほぼ一定になるように正規化
    ramp(n.babbleNorm.gain, 6 / Math.sqrt(count), t);
  }

  #buildAmbient() {
    const { ctx, nodes: n, settings: s } = this;
    if (n.ambient) {
      const old = n.ambient;
      ramp(old.bus.gain, 0, ctx.currentTime, 0.2);
      setTimeout(() => {
        old.sources.forEach((src) => src.stop());
        old.bus.disconnect();
      }, 1000);
    }
    const a = (n.ambient = { kind: s.ambient, sources: [], bus: gainNode(ctx, 0), nextBubble: 0, nextWander: 0 });
    a.bus.connect(n.master);
    ramp(a.bus.gain, sliderToGain(s.ambientVol), ctx.currentTime, 0.3);

    if (a.kind === 'stream') {
      const hiss = loopSource(ctx, this.buffers.pink);
      a.wander = gainNode(ctx, 0.8);
      hiss
        .connect(biquad(ctx, 'highpass', 500, 0.7))
        .connect(biquad(ctx, 'lowpass', 2500, 0.7))
        .connect(a.wander)
        .connect(a.bus);
      const body = loopSource(ctx, this.buffers.brown);
      body.connect(biquad(ctx, 'bandpass', 250, 0.8)).connect(gainNode(ctx, 0.6)).connect(a.bus);
      a.sources.push(hiss, body);
    } else if (a.kind === 'hvac') {
      const rumble = loopSource(ctx, this.buffers.brown);
      rumble.connect(biquad(ctx, 'lowpass', 350, 0.7)).connect(gainNode(ctx, 1.5)).connect(a.bus);
      const air = loopSource(ctx, this.buffers.pink);
      air.connect(biquad(ctx, 'lowpass', 1200, 0.7)).connect(gainNode(ctx, 0.15)).connect(a.bus);
      a.sources.push(rumble, air);
    }
  }

  /** 水の泡がはじける音: 周波数が上がっていく短い正弦波 */
  #bubble(t, bus) {
    const ctx = this.ctx;
    const d = rand(0.02, 0.07);
    const f = rand(500, 1600);
    const o = ctx.createOscillator();
    o.frequency.setValueAtTime(f, t);
    o.frequency.exponentialRampToValueAtTime(f * rand(1.3, 2), t + d);
    const g = gainNode(ctx, 0);
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(rand(0.03, 0.1), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(bus);
    o.start(t);
    o.stop(t + d + 0.02);
    o.onended = () => g.disconnect();
  }

  // 先読みスケジューラ。音が鳴っているタブはブラウザのタイマー間引きの対象外。
  #tick() {
    const n = this.nodes;
    if (!n) return;
    const now = this.ctx.currentTime;
    const until = now + 1.0;
    n.voices.forEach((v) => v.schedule(until));

    const a = n.ambient;
    if (a.kind === 'stream') {
      a.nextBubble = Math.max(a.nextBubble, now);
      while (a.nextBubble < until) {
        this.#bubble(a.nextBubble, a.bus);
        a.nextBubble += -Math.log(1 - Math.random()) / 12; // 平均12個/秒
      }
      if (now >= a.nextWander) {
        a.wander.gain.setTargetAtTime(rand(0.5, 1), now, 0.2);
        a.nextWander = now + 0.4;
      }
    }
  }
}
