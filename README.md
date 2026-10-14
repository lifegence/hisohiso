# Hisohiso

**Sound masking for office speech privacy** — keep conversations from being understood in the next room.
A browser app (PWA) that runs on smartphones and PCs. No install, no server, no data leaves the device.

[日本語は下にあります](#日本語)

## Features

- **Masking sound generator** — mixes three layers in real time with the Web Audio API:
  - *Speech-band noise*: covers the frequency range of speech (energetic masking)
  - *Synthetic babble*: meaningless voice-like sound built from vowel formants, which disrupts word recognition at lower volume than plain noise (informational masking)
  - *Ambient sound*: stream or HVAC sound to make the masking less intrusive
- **Leak measurement** — with two phones, measure how much speech leaks from a meeting room into the next room, and estimate:
  - sound insulation per octave band (250 Hz – 8 kHz)
  - Privacy Index (PI, after ASTM E1130) with and without masking
  - how many dB more masking is needed to reach confidential level (PI ≥ 95)
- Auto-stop timer, screen wake lock, offline support

## Quick start

```sh
npm start   # python3 -m http.server 8000 → open http://localhost:8000
npm test    # unit tests for the privacy calculations
```

The microphone (leak measurement) requires **HTTPS**. To try it on a phone, put the files on any static host (GitHub Pages, Cloudflare Pages, …) or use a tunnel such as `cloudflared tunnel --url http://localhost:8000`.

## Tips

- Play the masking sound **on the listener's side** (outside the door, in the corridor, by the shared wall), not inside the meeting room.
- Speech that passes through walls is mostly low-frequency. Phone speakers can't reproduce it well, so use an external (e.g. Bluetooth) speaker.
- Seal door gaps and ducts first. Masking complements sound insulation; it does not replace it.

## Limitations

- On iOS, audio may stop when the screen is locked.
- The microphone is uncalibrated, so all levels are relative dB. Differences between measurements on the same device are still valid.
- The SII is a simplified version of the ANSI S3.5 octave-band method. Treat the results as a guide and confirm by listening.

## Project layout

| File | Role |
|---|---|
| `js/audio-engine.js` | Masking sound synthesis (Web Audio API) |
| `js/measure.js` | Octave-band level measurement via microphone; test signal |
| `js/privacy.js` | Insulation / SII / PI calculations (pure functions, tested in `test/`) |
| `js/app.js` | UI |

## License

[MIT](LICENSE)

---

## 日本語

**Hisohiso（ひそひそ）— 会話マスカー**
オフィスの会話を、隣室や通路から聞き取られにくくするアプリです。ブラウザで動くアプリ（PWA）なので、スマホでもPCでもインストールせずに使えます。サーバーは不要で、データが端末の外に出ることもありません。

### できること

- **マスキング音の生成**：次の3種類の音を混ぜて鳴らします
  - 音声帯域ノイズ：会話と同じ周波数帯を覆います（エネルギー的マスキング）
  - 擬似会話：母音を合成した意味のない声です。言葉の聞き取りを邪魔するので、小さい音量でも効きます（情報マスキング）
  - 環境音：せせらぎや空調音で、耳障りさを和らげます
- **漏れ測定**：スマホを2台使い、会議室から隣室への音の漏れを測って、次を推定します
  - 音の高さ（オクターブバンド）ごとの遮音量
  - プライバシー指数（PI）。マスキングを鳴らした場合と鳴らさない場合を比べられます
  - 機密レベル（PI 95以上）にするには、マスキングをあと何dB大きくすればよいか
- 自動停止タイマー、再生中に画面が消えない機能、オフラインでの起動

### 使い方

```sh
npm start   # http://localhost:8000 を開く
npm test    # 計算ロジックのテスト
```

マイクを使う漏れ測定は、HTTPSで開いたときだけ動きます。スマホで使うときは、GitHub Pages などの静的ホスティングに置くか、`cloudflared tunnel --url http://localhost:8000` などのトンネルを使ってください。

### 効果を高めるコツ

- マスキング音は**聞かれたくない側**（ドアの外、通路、隣室との壁ぎわ）で鳴らしてください。
- 壁を通った声は低い音が中心です。スマホ本体のスピーカーでは低音が出ないので、外部スピーカーを使ってください。
- ドアの隙間やダクトを先にふさいでください。マスキングは遮音の代わりにはならず、補うものです。

### 制約

- iPhoneでは画面をロックすると音が止まることがあります。
- マイクは校正していないので、値はすべて相対値（dB）です。同じ端末で測った値どうしの差は有効です。
- 結果は目安です。最終的には、実際に人の耳で聞き取れるかを確かめてください。

### ライセンス

[MIT](LICENSE)
