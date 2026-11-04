# ☎ 電話番AI

毎朝 AI が高齢者に電話をかけ、会話を通じて **見守り** と **地域の助け合い**（買い物・通院・農作業の手伝いのマッチング）につなぐサービスです。
長崎県雲仙市の高齢者を対象にしたハッカソンプロジェクトです。

## デモ

`docs/index.html` は、ブラウザで動く音声会話のデモです。

1. 大きなマイクボタンを押すと、電話番AIがあいさつします
2. もう一度ボタンを押して、日本語で話しかけます（下の欄に文字を入れても話せます）
3. 話した内容が文字で表示され、AI（Claude）の返事が音声で読み上げられます

- 使用技術：Web Speech API（音声認識・音声合成）＋ Claude API（サーバー経由）
- 対応ブラウザ：Android の Chrome、iPhone の Safari、PC の Chrome / Edge（Firefox は音声認識非対応）
- 注意：Chrome などでは、音声認識のため音声がブラウザ提供元（Google など）のサーバーに送られます。デモで個人情報を話さないでください
- 初回はマイクの使用許可を求められるので「許可」を選んでください

## GitHub Pages で公開する

1. このリポジトリの **Settings → Pages** を開く
2. **Source** を「Deploy from a branch」にする
3. **Branch** を `main`、フォルダを `/docs` にして **Save**
4. 数分後に `https://<ユーザー名>.github.io/denwaban-ai/` で公開されます

> 音声認識は HTTPS でしか動きません。GitHub Pages は HTTPS なのでそのままスマホで試せます。

## AI の返事（ステップ2：Claude API）

画面の返事は、サーバー（`api/chat.js`）経由で Claude が作ります。

- API キーはサーバーの環境変数 `ANTHROPIC_API_KEY` からだけ読みます。ブラウザには出しません
- 合言葉 `ACCESS_PASSCODE` を知っている人だけが使えます（画面で一度入れると、その端末に保存されます）
- システムプロンプトとツール定義は `docs/conversation-design.md` から直接読み込みます。会話設計を書きかえれば、AI の話し方も変わります
- `notify_family`（家族への通知）は LINE で送ります。緊急はその場で、体調が悪いという話はお電話のあとに1通にまとめて送ります。LINE の設定が空なら送らず、画面に表示するだけです
- 文字入力欄があるので、声を出さなくても試せます

### 環境変数

| 名前 | 内容 |
| --- | --- |
| `ANTHROPIC_API_KEY` | 必須。Claude Console で発行した API キー |
| `ACCESS_PASSCODE` | 必須。画面で入れてもらう合言葉 |
| `AI_MODEL` | AI の種類。空なら `claude-haiku-5-5`。比べるときは `claude-sonnet-5-5` |
| `AI_EFFORT` | 考える深さ（`low` / `medium` / `high`）。空なら `low`（速さ優先） |
| `AI_NAME` / `USER_NAME` / `FAMILY_NAME` / `USER_NOTES` / `WEATHER` | 人物の設定。空なら `lib/profile.js` の架空のデモ用の値 |
| `SUPABASE_URL` / `SUPABASE_SECRET_KEY` | データベース（Supabase）。空なら保存しない。表は `supabase/schema.sql` |
| `USER_AREA` | 本人の地区（例：国見町）。協力者を探すときに使う |
| `LINE_CHANNEL_ACCESS_TOKEN` | LINE のチャネルアクセストークン（長期）。空なら LINE は送らない |
| `LINE_TO_USER_IDS` | 送り先のユーザーID（カンマ区切り）。空なら公式アカウントの友だち全員 |
| `LINE_CHANNEL_SECRET` | LINE のチャネルシークレット。「引き受ける」ボタンの受け口（`/api/line-webhook`）で使う |
| `COORDINATOR_MODEL` | 調整係のモデル。空なら `claude-sonnet-5-5` |
| `USER_ADDRESS` / `USER_PHONE` | 引き受けた協力者1人にだけ伝える本人の連絡先。空ならデモ用の架空の値 |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` / `TWILIO_PHONE_NUMBER` | 電話（Twilio）。空なら電話は使わない |
| `TWILIO_CALL_TO` | ゆげ丸が電話をかける相手（本人の電話、+81 の形） |
| `TWILIO_ALLOWED_NUMBERS` | かかってきた電話を受けてよい番号。空なら `TWILIO_CALL_TO` だけ |
| `TWILIO_VOICE` | 読み上げの声。空なら `Polly.Kazuha-Neural` |
| `PUBLIC_BASE_URL` | 公開アドレス（例：`https://denwaban-ai.vercel.app`）。Twilio の署名の確認に使う |
| `ALLOWED_ORIGINS` | GitHub Pages 版の画面から呼ぶときの許可先。空なら `https://shogomatsu.github.io` |

実際のご家族の名前は `lib/profile.js` に書かず、Vercel の環境変数（手元なら `.env`）に入れてください。

### Vercel で公開する

Vercel にこのリポジトリを取り込むと、画面（`docs/`）と窓口（`/api/chat`）が同じアドレスで公開されます（設定は `vercel.json`）。
11/5 の Twilio の着信窓口も、`api/` にファイルを足せば同じ場所で動きます。

1. Vercel で「Add New → Project」からこのリポジトリを Import
2. 「Environment Variables」に `ANTHROPIC_API_KEY` と `ACCESS_PASSCODE` を登録して Deploy
3. 環境変数を変えたときは、Deployments から Redeploy すると反映されます

GitHub Pages 版の画面から使うときは、`docs/index.html` の `VERCEL_URL_FOR_GITHUB_PAGES` に Vercel のアドレスを入れます。

## ローカルで動かす

Node.js（20.12 以上）が必要です。`localhost` なら HTTP でもマイクが使えます。

```bash
npm install
```

```bash
cp .env.example .env
```

`.env` に API キーと合言葉を入れてから：

```bash
npm run dev
```

ブラウザで http://localhost:3000 を開きます。

## ディレクトリ構成

```
api/chat.js                 Claude につなぐ窓口（Vercel の関数）
lib/prompt.js               会話設計からシステムプロンプトとツールを読み込む
lib/profile.js              人物の設定（架空のデモ用の値）
lib/line.js                 ご家族への LINE 通知
docs/index.html             音声会話デモの画面
docs/status.html            困りごとの状況画面（/status.html）
docs/conversation-design.md 毎朝の電話の会話設計（システムプロンプト）
dev-server.js               手元で試すためのサーバー
vercel.json                 Vercel の設定
.env.example                環境変数の見本（.env はコミットしない）
CLAUDE.md                   プロジェクト概要と開発方針
```

開発方針の詳細は [CLAUDE.md](./CLAUDE.md) を参照してください。
