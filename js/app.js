import { MaskingEngine, DEFAULTS } from './audio-engine.js';
import { BandMeter, TestSignal } from './measure.js';
import { BANDS, analyze, verdict } from './privacy.js';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// 端末に保存する設定。プライベートブラウズ等で使えなくても動くようにする。
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  },
};

// ───────── タブ ─────────
function showTab(id) {
  $$('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === id)));
  $$('[role="tabpanel"]').forEach((p) => (p.hidden = p.id !== `tab-${id}`));
  store.set('tab', id);
}
$$('[data-tab]').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
showTab(store.get('tab', 'mask'));

// ───────── 画面の消灯防止 ─────────
let wakeLock = null;
async function keepAwake(on) {
  try {
    if (on && !wakeLock && 'wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => (wakeLock = null));
    } else if (!on && wakeLock) {
      await wakeLock.release();
    }
  } catch {
    /* 非対応・省電力モード等 */
  }
}
// タブを離れると解除されるので、戻ったときに取り直す
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && (engine.running || testSignal.running)) keepAwake(true);
});

// ───────── マスキング ─────────
const engine = new MaskingEngine(store.get('mask-settings', DEFAULTS));

const formatters = {
  tilt: (v) => `${v}dB`,
  voices: (v) => `${v}人`,
};

$$('[data-setting]').forEach((input) => {
  const key = input.dataset.setting;
  const out = $(`output[data-for="${key}"]`);
  input.value = engine.settings[key];
  const show = () => out && (out.textContent = (formatters[key] ?? String)(input.value));
  show();
  input.addEventListener('input', () => {
    const value = input.type === 'range' ? Number(input.value) : input.value;
    engine.set(key, value);
    show();
    store.set('mask-settings', engine.settings);
  });
});

const playBtn = $('#play');
const timerSel = $('#timer');
timerSel.value = String(store.get('timer', 0));
let stopAt = 0;

function setPlaying(on) {
  playBtn.setAttribute('aria-pressed', String(on));
  $('#play-label').textContent = on ? '停止' : '再生';
  if (!on) $('#status').textContent = '停止中';
  keepAwake(on);
}

async function startMasking() {
  await engine.start();
  const minutes = Number(timerSel.value);
  stopAt = minutes ? Date.now() + minutes * 60_000 : 0;
  setPlaying(true);
  requestAnimationFrame(updateMeter);
}

async function stopMasking() {
  setPlaying(false);
  await engine.stop();
}

playBtn.addEventListener('click', () => (engine.running ? stopMasking() : startMasking()));

timerSel.addEventListener('change', () => {
  const minutes = Number(timerSel.value);
  store.set('timer', minutes);
  if (engine.running) stopAt = minutes ? Date.now() + minutes * 60_000 : 0;
});

function updateMeter() {
  if (!engine.running) {
    $('#meter-bar').style.width = '0';
    return;
  }
  const db = engine.outputLevel();
  $('#meter-bar').style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  if (stopAt) {
    const left = Math.max(0, stopAt - Date.now());
    $('#status').textContent = `再生中・あと${Math.ceil(left / 60_000)}分`;
    if (left === 0) {
      stopMasking();
      return;
    }
  } else {
    $('#status').textContent = '再生中';
  }
  requestAnimationFrame(updateMeter);
}

// 画面が見えないとrequestAnimationFrameが止まるので、自動停止はタイマーでも確認する
setInterval(() => {
  if (engine.running && stopAt && Date.now() >= stopAt) stopMasking();
}, 5000);

// ───────── 試験音（端末A） ─────────
const testSignal = new TestSignal();
const testBtn = $('#test-toggle');
const testVol = $('#test-vol');
testVol.value = store.get('test-vol', 80);
$('#test-vol-out').textContent = testVol.value;

testVol.addEventListener('input', () => {
  $('#test-vol-out').textContent = testVol.value;
  testSignal.setVolume(Number(testVol.value));
  store.set('test-vol', Number(testVol.value));
});

testBtn.addEventListener('click', async () => {
  if (testSignal.running) {
    testSignal.stop();
  } else {
    await testSignal.start(Number(testVol.value));
  }
  testBtn.setAttribute('aria-pressed', String(testSignal.running));
  testBtn.textContent = testSignal.running ? '試験音を止める' : '試験音を鳴らす';
  keepAwake(testSignal.running || engine.running);
});

// ───────── 測定（端末B） ─────────
const STEPS = [
  {
    id: 'speech',
    place: '会議室',
    title: '普段の声で話す',
    detail: '端末Bを会議の席に置き、1mほど離れて普段の声で話し続けてください（資料の音読などでOK）。試験音は止めておきます。',
    secs: 15,
  },
  {
    id: 'testSrc',
    place: '会議室',
    title: '会議室で試験音を測る',
    detail: '話していた位置に端末Aを置いて試験音を鳴らします。端末Bは手順1と同じ場所のままです。',
    secs: 10,
  },
  {
    id: 'testRecv',
    place: '隣室',
    title: '漏れてきた試験音を測る',
    detail: '試験音は鳴らしたまま、端末Bを聞き取られたくない場所（隣室・通路など）へ移動します。',
    secs: 10,
  },
  {
    id: 'background',
    place: '隣室',
    title: '何も鳴らさずに測る',
    detail: '端末Aの試験音を止めます。マスキングも止めた状態で、隣室の普段の静けさを測ります。',
    secs: 10,
  },
  {
    id: 'masked',
    place: '隣室',
    title: 'マスキング中に測る（任意）',
    detail: 'ドアの外などでマスキングを鳴らし（端末Aを使っても構いません）、試験音は止めたまま測ります。',
    secs: 10,
  },
];
const REQUIRED = ['speech', 'testSrc', 'testRecv', 'background'];

const meter = new BandMeter();
let results = store.get('measure-results', {});
let busy = false;

function renderSteps() {
  const ol = $('#steps');
  ol.replaceChildren(
    ...STEPS.map((step) => {
      const li = document.createElement('li');
      li.className = results[step.id] ? 'done' : '';
      li.innerHTML = `
        <div class="step-title"><span class="place">${step.place}</span>${step.title}</div>
        <div class="note">${step.detail}</div>
        <div class="step-actions">
          <button class="btn">${results[step.id] ? '測り直す' : '測定'}（${step.secs}秒）</button>
          <span class="step-value"></span>
        </div>
        <progress max="1" value="0" hidden></progress>`;
      const btn = li.querySelector('button');
      const value = li.querySelector('.step-value');
      const progress = li.querySelector('progress');
      if (results[step.id]) value.textContent = bandSummary(results[step.id]);
      btn.disabled = busy;
      btn.addEventListener('click', () => runStep(step, btn, value, progress));
      return li;
    }),
  );
}

const bandSummary = (levels) =>
  levels.map((db, i) => `${BANDS[i] >= 1000 ? `${BANDS[i] / 1000}k` : BANDS[i]}:${db.toFixed(0)}`).join(' ');

async function runStep(step, btn, value, progress) {
  busy = true;
  $$('#steps button').forEach((b) => (b.disabled = true));
  progress.hidden = false;
  try {
    const levels = await meter.measure(step.secs, (p, db) => {
      progress.value = p;
      value.textContent = `入力レベル ${db.toFixed(0)} dB`;
    });
    results[step.id] = levels;
    store.set('measure-results', results);
  } catch (err) {
    value.textContent = `マイクを使えません：${err.message}`;
    busy = false;
    $$('#steps button').forEach((b) => (b.disabled = false));
    return;
  }
  busy = false;
  renderSteps();
  renderResults();
}

$('#measure-reset').addEventListener('click', () => {
  if (!confirm('測定結果をすべて消しますか？')) return;
  results = {};
  store.set('measure-results', results);
  renderSteps();
  renderResults();
});

const fmt = (v) => (v === null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(0)}`);

function piCard(title, pi) {
  const v = verdict(pi);
  return `<div class="pi ${v.level}">
    <div class="label">${title}</div>
    <div class="value">${pi.toFixed(0)}</div>
    <div class="verdict">${v.label}</div>
    <div class="note">${v.text}</div>
  </div>`;
}

function renderResults() {
  const box = $('#results');
  if (!REQUIRED.every((id) => results[id])) {
    box.hidden = true;
    return;
  }
  const r = analyze(results);
  const hasMask = r.piMask !== null;

  const advice = [];
  const current = hasMask ? 'マスキング中' : '何も鳴らしていない状態';
  if (r.boost === 0) {
    advice.push(`${current}で、すでに機密レベル（PI 95以上）です。`);
  } else if (r.boost === null) {
    advice.push('マスキングだけで機密レベルにするのは難しい状態です。ドアの隙間をふさぐなど、物理的な遮音を先に改善してください。');
  } else {
    advice.push(`機密レベル（PI 95）にするには、隣室で聞こえる雑音を${current}より<strong>約${r.boost.toFixed(0)}dB</strong>大きくする必要があります。`);
    if (r.boost > 15) advice.push('15dBを超える増加は周りの人に耳障りになりやすいため、物理的な遮音の改善も検討してください。');
  }
  if (r.bands.some((b) => b.lowerBound)) {
    advice.push('「≥」の帯域は試験音が隣室まで届かず、正確に測れませんでした（実際の遮音はこれ以上です）。外部スピーカーで試験音を大きくすると精度が上がります。');
  }

  box.hidden = false;
  box.innerHTML = `
    <h2>結果</h2>
    <div class="summary">
      ${piCard('マスキングなし', r.piBg)}
      ${hasMask ? piCard('マスキングあり', r.piMask) : ''}
    </div>
    ${advice.map((a) => `<p class="note">${a}</p>`).join('')}
    <div class="table-wrap">
      <table>
        <thead><tr>
          <th>帯域</th><th>遮音量</th><th>隣室の声</th><th>声の余裕<br>(なし)</th>${hasMask ? '<th>声の余裕<br>(あり)</th>' : ''}
        </tr></thead>
        <tbody>
          ${r.bands
            .map(
              (b) => `<tr>
                <td>${b.fc >= 1000 ? `${b.fc / 1000}kHz` : `${b.fc}Hz`}</td>
                <td>${b.lowerBound ? '≥' : ''}${b.tl.toFixed(0)} dB</td>
                <td>${b.speechRecv.toFixed(0)}</td>
                <td>${fmt(b.snrBg)}</td>
                ${hasMask ? `<td>${fmt(b.snrMask)}</td>` : ''}
              </tr>`,
            )
            .join('')}
        </tbody>
      </table>
    </div>
    <p class="note">「声の余裕」は、隣室での声と雑音の差です。−15dB以下ならその帯域の言葉はまったく聞こえず、＋15dB以上ならはっきり聞こえます。値は校正していないマイクによる相対値です。</p>`;
}

renderSteps();
renderResults();

// ───────── オフライン対応 ─────────
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
