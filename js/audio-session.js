// iOS(WebKit)のオーディオセッション対策。
// iOS では Web Audio の音は「ambient」扱いで、消音スイッチ(マナーモード)がオンだと鳴らない。
// Safari / Chrome とも中身は WebKit なので両方で起きる。用途に合わせてセッションの種類を切り替える。

const isIOS = () =>
  /iP(hone|ad|od)/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); // iPadOS

let silentEl = null;

/** 44バイトのヘッダ + 0.5秒分の無音(8kHz, 8bit mono)のWAV */
function silentWavUrl() {
  const samples = 4000;
  const buf = new ArrayBuffer(44 + samples);
  const v = new DataView(buf);
  const str = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF'); v.setUint32(4, 36 + samples, true); str(8, 'WAVE');
  str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, 8000, true); v.setUint32(28, 8000, true); v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  str(36, 'data'); v.setUint32(40, samples, true);
  new Uint8Array(buf, 44).fill(128); // 8bit PCM の無音は 128
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

/**
 * 'playback'       … 消音スイッチに関係なく鳴らす(マスキング・試験音)
 * 'play-and-record' … マイクを使う(測定)
 * タップなどの操作の中で、音を鳴らす前に同期的に呼ぶこと。
 */
export function setAudioSession(type) {
  try {
    if (navigator.audioSession) {
      navigator.audioSession.type = type;
      return;
    }
  } catch {
    /* 非対応の値など。下の代替策へ */
  }
  // Audio Session API がない古い iOS(16.3以前): 無音の <audio> を再生していると
  // セッションが再生用に切り替わり、Web Audio も消音スイッチを無視して鳴る
  if (type !== 'playback' || !isIOS()) return;
  if (!silentEl) {
    silentEl = new Audio(silentWavUrl());
    silentEl.loop = true;
    silentEl.setAttribute('playsinline', '');
  }
  silentEl.play().catch(() => {});
}
