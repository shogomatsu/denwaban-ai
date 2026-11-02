# ☎ 電話番AI

毎朝 AI が高齢者に電話をかけ、会話を通じて **見守り** と **地域の助け合い**（買い物・通院・農作業の手伝いのマッチング）につなぐサービスです。
長崎県雲仙市の高齢者を対象にしたハッカソンプロジェクトです。

## デモ（ステップ1）

`docs/index.html` は、ブラウザだけで動く音声会話のデモです。

1. 大きなマイクボタンを押すと、電話番AIがあいさつします
2. もう一度ボタンを押して、日本語で話しかけます
3. 話した内容が文字で表示され、仮の返事（オウム返し）が音声で読み上げられます

- 使用技術：Web Speech API（音声認識・音声合成）のみ。外部 API・ライブラリ・ビルド不要
- 対応ブラウザ：Android の Chrome、iPhone の Safari、PC の Chrome / Edge（Firefox は音声認識非対応）
- 注意：Chrome などでは、音声認識のため音声がブラウザ提供元（Google など）のサーバーに送られます。デモで個人情報を話さないでください
- 初回はマイクの使用許可を求められるので「許可」を選んでください

## GitHub Pages で公開する

1. このリポジトリの **Settings → Pages** を開く
2. **Source** を「Deploy from a branch」にする
3. **Branch** を `main`、フォルダを `/docs` にして **Save**
4. 数分後に `https://<ユーザー名>.github.io/denwaban-ai/` で公開されます

> 音声認識は HTTPS でしか動きません。GitHub Pages は HTTPS なのでそのままスマホで試せます。

## ローカルで動かす

`localhost` なら HTTP でもマイクが使えます。

```bash
python3 -m http.server 8000 --directory docs
```

ブラウザで http://localhost:8000 を開きます。

## ディレクトリ構成

```
docs/index.html   音声会話デモ（GitHub Pages の公開対象）
CLAUDE.md         プロジェクト概要と開発方針
```

開発方針の詳細は [CLAUDE.md](./CLAUDE.md) を参照してください。
