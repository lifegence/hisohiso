import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyze, sii, subtractBackground, transmissionLoss, requiredBoost, verdict } from '../js/privacy.js';

const flat = (v) => Array(6).fill(v);

test('SII: 全帯域 +15dB で 1、-15dB で 0', () => {
  assert.ok(Math.abs(sii(flat(15)) - 1) < 1e-9);
  assert.equal(sii(flat(-15)), 0);
  assert.ok(Math.abs(sii(flat(0)) - 0.5) < 1e-9);
});

test('背景雑音の差し引き', () => {
  assert.ok(Math.abs(subtractBackground(53, 50) - 50) < 0.05); // 50+50 ≈ 53
  assert.equal(subtractBackground(51, 50), null);
});

test('試験音が埋もれた帯域は下限値', () => {
  const tl = transmissionLoss(flat(90), [60, 60, 60, 60, 41, 40], flat(40));
  assert.equal(tl[0].lowerBound, false);
  assert.ok(Math.abs(tl[0].tl - 30) < 0.1);
  assert.equal(tl[5].lowerBound, true);
  assert.equal(tl[5].tl, 50);
});

test('遮音30dB・静かな隣室では聞き取られ、マスキングで改善', () => {
  const r = analyze({
    speech: flat(70), testSrc: flat(90), testRecv: flat(60),
    background: flat(25), masked: flat(45),
  });
  // 隣室の声 40dB、暗騒音 25dB → SNR +15 → SII 1
  assert.ok(r.piBg < 5);
  assert.equal(verdict(r.piBg).level, 'poor');
  // マスキング 45dB → SNR -5 → SII 0.333
  assert.ok(Math.abs(r.piMask - 66.7) < 0.5);
  // SII ≤ 0.05 には SNR ≤ -13.5 → +8.5dB
  assert.equal(r.boost, 8.5);
});

test('requiredBoost: 既に十分なら 0', () => {
  assert.equal(requiredBoost(flat(20), flat(40)), 0);
});
