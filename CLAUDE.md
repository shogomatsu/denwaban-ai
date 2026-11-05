# CLAUDE.md — 電話番AI

このファイルは Claude Code（および開発メンバー）がこのリポジトリで作業するときの前提・方針をまとめたものです。

## プロダクト概要

**電話番AI** は、毎朝 AI が高齢者に電話をかけ、何気ない会話を通じて

1. **見守り**：体調・食事・睡眠・気分などの変化に気づき、家族や地域の見守り担当へ知らせる
2. **地域の助け合い**：会話の中から「買い物に行きたい」「通院の足がない」「畑の作業が大変」などの困りごとを拾い、手伝える地域の人とマッチングする

ことを目指すサービスです。

- **対象地域**：長崎県雲仙市
- **対象ユーザー**：雲仙市に暮らす高齢者（特に一人暮らし・高齢夫婦世帯）
- **関係者**：本人／離れて暮らす家族／民生委員・地域包括支援センター／手伝ってくれる地域住民（ボランティア・近所の人）
- **フェーズ**：ハッカソン用プロトタイプ

## 仕様（v2）

- **最新の仕様は [docs/spec.md](docs/spec.md)**。主役は「会話から困りごとを拾い、地域の協力者へつなぐマッチング」。見守りは土台。
- 電話係（Claude Haiku 5.5）と調整係（Claude Sonnet 5.5）の二人体制。協力者の名前・住所・電話番号は、引き受けた1人にだけ渡す。
- 競合調査は [docs/competitive-analysis.md](docs/competitive-analysis.md)。

## 現在の構成（ステップ2）

```
.
├── CLAUDE.md
├── README.md
├── package.json        # 依存は @anthropic-ai/sdk・@supabase/supabase-js・@vercel/functions
├── vercel.json         # Vercel：docs/ を静的公開、api/ を関数として公開
├── .env.example        # 環境変数の見本（.env はコミットしない）
├── dev-server.js       # ローカル確認用（npm run dev → http://localhost:3000）
├── supabase/schema.sql # データベースの表（SQL Editor に貼って実行）
├── api/
│   ├── chat.js         # ブラウザの会話の窓口。合言葉（ACCESS_PASSCODE）で保護
│   ├── status.js       # 状況画面のデータ
│   ├── mcp.js          # 家族が Claude に様子を聞く窓口（MCP・読み取り専用）
│   ├── twilio/voice.js # 電話の窓口（Twilio）
│   ├── twilio/call.js  # テスト用の発信
│   └── line-webhook.js # LINE の受け口（「引き受ける」ボタン・友だち追加）
├── lib/
│   ├── conversation.js # 会話の1往復（ブラウザと電話で共通）
│   ├── auth.js         # 合言葉の確認
│   ├── twilio.js       # 電話（Twilio）の道具
│   ├── audio.js        # 音声の変換（LINE の m4a → 電話で流せる mp3）
│   ├── prompt.js       # conversation-design.md からシステムプロンプトとツール定義を読む
│   ├── line.js         # ご家族への LINE 通知
│   ├── db.js           # Supabase への保存
│   ├── coordinator.js  # 調整係（Sonnet）：協力者を選んで LINE で依頼
│   └── profile.js      # 人物設定（架空のデモ値。実値は環境変数で上書き）
└── docs/               # 画面（Vercel と GitHub Pages で公開）
    ├── index.html      # 音声会話のデモ（1ファイル完結）
    ├── status.html     # 困りごとの状況画面（調整係の判断を見せる）
    ├── conversation-design.md  # 会話設計。システムプロンプトの元
    └── .nojekyll
```

- `docs/index.html` の `makeReply()` が `/api/chat` を呼び、Claude の返事を読み上げる。文字入力欄でも話せる。
- サーバーは会話を保存しない。会話履歴（thinking ブロックを含む）はブラウザが持ち、毎回そのまま送り返す。
  - 履歴は追記のみ。途中の書きかえ・システムプロンプトの変更をしない（通話中は `callDate` を固定）。
- モデルは環境変数 `AI_MODEL`（既定 `claude-haiku-5-5`）、考える深さは `AI_EFFORT`（既定 `low`）。
  - `CLAUDE_` で始まる名前は Claude Code 自身が使うことがあるので避ける。
- `notify_family` → `lib/line.js` で LINE Messaging API に送る。urgent はその場で、concern は `end_call` のときに1通にまとめて送る。
  - `LINE_CHANNEL_ACCESS_TOKEN` が空なら送らず画面表示だけ。`LINE_TO_USER_IDS` が空なら友だち全員（broadcast）、あればその人だけ（multicast）。
- `request_help` → 本人が同意したときだけ呼ばれる。`consent_quote`（同意の言葉）が空なら受け付けない。`lib/db.js` で Supabase の `help_requests` に保存。
- `end_call` → `calls` に通話の記録を保存。表の定義は `supabase/schema.sql`（全表 RLS オン・許可ルールなし＝サーバーの秘密キーだけが読み書きできる）。
  - `SUPABASE_URL` / `SUPABASE_SECRET_KEY` が空なら保存せず、会話はそのまま続ける。
  - ログに名前・体調の言葉・困りごとの中身を出さない。
- 1回の通話は `callId`（サーバーが発行、ブラウザが送り返す）でまとめる。
- 調整係 `lib/coordinator.js`（Claude Sonnet 5.5、`COORDINATOR_MODEL` で変更可）：`request_help` の保存後に `waitUntil` で裏で動く。協力者ごとに「合う・合わない」と理由（`help_requests.assessments`）を残し、1人を選んで LINE で依頼（本文＋「引き受ける／今回は難しい」ボタン）。依頼文に本人の名前・住所・電話・体調を書かせない。
  - server-side fallback（`fallbacks: "default"`）を有効にしている。
- LINE の受け口 `api/line-webhook.js`：署名（`LINE_CHANNEL_SECRET`）を確認。声をかけた本人のボタンだけ受け付け、早い者勝ちで確定。確定した1人にだけ本人の連絡先を返信し、家族に報告、ポイント+1。「今回は難しい」なら次の人を探し、誰もいなければ家族に相談。友だち追加でユーザーIDをログに出す（登録用）。
- 会話の1往復は `lib/conversation.js` の `runTurn()`。ブラウザ（`api/chat.js`）と電話（`api/twilio/voice.js`）で共通。合言葉の確認は `lib/auth.js`。
- 電話（Twilio）`api/twilio/voice.js`：Twilio の署名を確認。`<Say>`（声は `TWILIO_VOICE`、既定 Polly.Kazuha-Neural）→ `<Gather input="speech" language="ja-JP">` を繰り返す。通話中の履歴は Supabase の `call_sessions`。着信は登録した番号（`TWILIO_ALLOWED_NUMBERS`／`TWILIO_CALL_TO`）からだけ受ける。
  - `?purpose=callback&request=<id>` は、協力者が決まったことを伝える折り返しの電話。`api/line-webhook.js` が「引き受ける」のあとに自動で発信する。
  - `api/twilio/call.js`：テスト用の発信。かける相手は `TWILIO_CALL_TO` だけ（画面から番号を指定させない）。
  - `api/twilio/status.js`：通話の終わりの知らせ。毎朝の電話に出なかった（no-answer / busy / failed）ら家族に LINE。折り返しの電話では知らせない。
- 家族の声の伝言：家族（`LINE_TO_USER_IDS` の人）が公式アカウントに LINE のボイスメッセージを送ると、`api/line-webhook.js` が受け取り、`lib/audio.js`（ffmpeg-static）で m4a → mp3 に変換して Supabase Storage（非公開バケット `voice-messages`）と `voice_messages` 表に保存。次の朝の電話のあいさつのあとに `<Play>` で流す（ブラウザ版は画面で流す）。**声を AI で似せることはしない。流すのは家族が録った本物の声だけ。**
- 状況画面 `docs/status.html`（`/status.html`）＋ `api/status.js`：最近の困りごと、調整係の判断と理由、声かけの状況。協力者の LINE ID や本人の連絡先は返さない。
- 家族が Claude に様子を聞く `api/mcp.js`（MCP サーバー・Streamable HTTP の状態を持たない最小形）：道具は `get_recent_calls`（最近の通話のまとめ）と `get_help_requests`（困りごとの状況）の2つで、**読むだけ**。電話・LINE・書きかえの道具は置かない。
  - 鍵 `MCP_ACCESS_KEY` が空なら閉じたまま（404）。鍵は `Authorization: Bearer` か `?key=` で受ける。鍵入りのアドレスは合言葉と同じ扱い。
  - 協力者の LINE ID・本人の住所・電話番号は返さない。返す文には「AI は医療の判断をしない。緊急は119番」を添える。

## 安全テストと Claude Code の仕組み

- **安全テスト**：`npm run safety`（`scripts/safety-test.js`）。`tests/safety/scenarios.json` の20場面を電話係に話しかけ、ツールの呼び方を機械的に確かめ、返事を採点係の Claude（既定 Opus 5.5、`SAFETY_JUDGE_MODEL`）が採点。結果は `tests/safety/report.md`。LINE・Supabase・Twilio の設定は実行時に外す。
  - **会話設計（`docs/conversation-design.md`）やツール、`lib/conversation.js` を変えたら必ず回す**（スキル `.claude/skills/safety-test`）。
  - PR では GitHub Actions（`.github/workflows/safety.yml`）でも回る（Secrets に `ANTHROPIC_API_KEY` があるとき）。
- **フック**（`.claude/settings.json` → `.claude/hooks/check-secrets.mjs`）：`git commit` の前に、API キー・トークン・本物の電話番号・`.env` がまざっていたら止める。見本の番号（`+819012345678` など）は通す。

## 開発方針

### 高齢者にやさしい UI（最優先）
- 文字は大きく（基準 22px 以上）、ボタンは押しやすく大きく（指で押せる最低 60px、メインボタンはさらに大きく）。
- 1 画面 1 操作。迷わせない。専門用語・カタカナ語・英語を避け、やさしい日本語で。
- 色だけに頼らず、文字でも状態を伝える（「聞いています」「お返事しています」など）。コントラストを十分に。
- 読み上げはややゆっくり（`rate` 0.85 前後）。敬語で、温かく、短い文で話す。
- エラー時は「何が起きて、どうすればよいか」を平易に伝える。

### 動作環境
- スマホ（Android Chrome / iPhone Safari）と PC（Chrome / Edge）のブラウザ。
- iPhone Safari の制約に注意：音声合成・音声認識はユーザー操作（タップ）起点でないと動かないことがある。
- Firefox は音声認識非対応 → 非対応メッセージを表示する。

### 外部サービス・API
- 外部 API は Claude API（サーバー経由）のみ。
  - Web Speech API について：Chrome の音声認識は音声を Google のサーバーに送って処理する（ブラウザ標準機能のため自前の API 呼び出しは不要）。「端末内だけで処理」とは書かないこと。
- 今後、AI 応答（LLM）・電話発信（例：Twilio など）・データ保存を追加する場合は、
  - API キーなどの秘密情報は必ず `.env` に置き、**絶対にコミットしない**（`.gitignore` 済み）。
  - キーはフロントエンド（`docs/`）に埋め込まない。必要ならサーバー側／サーバーレス関数を経由する。
  - 共有用に `.env.example`（値は空）を用意する。

### 個人情報・プライバシー
- 高齢者の氏名・電話番号・住所・健康状態・通話内容は機微情報。**実データをリポジトリに入れない**。
- デモ・テストには架空のデータを使う。
- 見守りで「異変」を検知しても、AI が医療的な判断をしない。家族・見守り担当につなぐことに徹する。緊急時は 119 番等を案内する。

### コーディング規約
- UI 文言・コメントは日本語で OK。変数名・関数名は英語。
- 小さく作って動かす。ハッカソンなので「動くデモ」を最優先し、過度な抽象化はしない。
- 変更したら実機（できればスマホ）で音声の入出力を確認する。

## 今後のロードマップ（案）

1. ✅ ブラウザで音声会話のデモ（オウム返し）
2. ✅ 返事を LLM に差し替え（体調確認の質問フロー、困りごとの聞き取り）
3. 会話から「見守りサイン」「困りごと（買い物・通院・農作業）」を構造化して抽出
4. 家族・見守り担当向けの簡単なダッシュボード
5. 地域の手伝い手とのマッチング（登録・通知）
6. 実際の電話発信（毎朝の定時コール）
