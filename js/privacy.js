// 遮音量・会話明瞭度(SII簡易版)・プライバシー指数(PI)の計算。DOM/音声APIに依存しない純粋関数のみ。
//
// SIIはANSI S3.5のオクターブバンド法を簡略化したもの:
//   各帯域の可聴度 A = clamp((SNR + 15) / 30, 0, 1)、SII = Σ 重み × A
// PI(Privacy Index, ASTM E1130) = (1 - SII) × 100
//   PI ≥ 95: 機密レベル / PI ≥ 80: 通常のプライバシー / それ未満: 聞き取られる

export const BANDS = [250, 500, 1000, 2000, 4000, 8000];
export const WEIGHTS = [0.0617, 0.1671, 0.2373, 0.2648, 0.2142, 0.0549];

const toPow = (db) => 10 ** (db / 10);
const toDb = (p) => 10 * Math.log10(p);

/** total から背景雑音 bg を差し引く。差が minDiff dB 未満なら測定不能として null。 */
export function subtractBackground(total, bg, minDiff = 3) {
  if (total - bg < minDiff) return null;
  return toDb(toPow(total) - toPow(bg));
}

/** 帯域ごとの遮音量。試験音が隣室の暗騒音に埋もれた帯域は下限値(lowerBound)として扱う。 */
export function transmissionLoss(testSrc, testRecv, background) {
  return testSrc.map((src, i) => {
    const recv = subtractBackground(testRecv[i], background[i]);
    if (recv === null) return { tl: src - background[i], lowerBound: true };
    return { tl: src - recv, lowerBound: false };
  });
}

export function sii(snr) {
  return snr.reduce((sum, s, i) => sum + WEIGHTS[i] * Math.min(1, Math.max(0, (s + 15) / 30)), 0);
}

export const privacyIndex = (s) => (1 - s) * 100;

export function verdict(pi) {
  if (pi >= 95) return { level: 'good', label: '機密レベル', text: 'ほぼ聞き取れません' };
  if (pi >= 80) return { level: 'fair', label: '通常のプライバシー', text: '集中すれば一部の言葉が聞き取れます' };
  return { level: 'poor', label: '聞き取られる', text: '会話の内容がかなり聞き取れます' };
}

/** 隣室の雑音を一様に何dB上げれば SII ≤ target になるか。60dB上げても届かなければ null。 */
export function requiredBoost(speechRecv, noise, target = 0.05) {
  for (let d = 0; d <= 60; d += 0.5) {
    if (sii(speechRecv.map((s, i) => s - (noise[i] + d))) <= target) return d;
  }
  return null;
}

/**
 * m: { speech, testSrc, testRecv, background, masked? } 各要素は BANDS 順の dB 配列。
 * マイクは未校正なので値は相対dBだが、すべて同じマイクで測るため差分は有効。
 */
export function analyze(m) {
  const tl = transmissionLoss(m.testSrc, m.testRecv, m.background);
  const speechRecv = m.speech.map((s, i) => s - tl[i].tl);
  const snrBg = speechRecv.map((s, i) => s - m.background[i]);
  const snrMask = m.masked ? speechRecv.map((s, i) => s - m.masked[i]) : null;

  const siiBg = sii(snrBg);
  const siiMask = snrMask ? sii(snrMask) : null;
  return {
    bands: BANDS.map((fc, i) => ({
      fc,
      tl: tl[i].tl,
      lowerBound: tl[i].lowerBound,
      speechRecv: speechRecv[i],
      snrBg: snrBg[i],
      snrMask: snrMask ? snrMask[i] : null,
    })),
    siiBg,
    siiMask,
    piBg: privacyIndex(siiBg),
    piMask: siiMask === null ? null : privacyIndex(siiMask),
    boost: requiredBoost(speechRecv, m.masked ?? m.background),
  };
}
