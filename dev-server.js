// 手元のパソコンで試すための小さなサーバー（Vercel に置くときは使いません）
//
//   npm run dev
//
// で起動し、ブラウザで http://localhost:3000 を開きます。
// .env の中身（API キーや合言葉）を読み込み、
// docs/ の画面と api/chat.js の窓口を、Vercel と同じ形で動かします。

import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

if (existsSync('.env')) process.loadEnvFile('.env');

// api/ の下のファイルを、Vercel と同じ場所（/api/〇〇）で動かす
const apiHandlers = {};
for (const name of ['chat', 'line-webhook', 'status', 'twilio/voice', 'twilio/call']) {
  apiHandlers[`/api/${name}`] = (await import(`./api/${name}.js`)).default;
}

const PORT = Number(process.env.PORT) || 3000;
const DOCS_DIR = path.resolve('docs');
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (apiHandlers[url.pathname]) {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    req.body = raw;
    req.rawBody = raw;
    try {
      await apiHandlers[url.pathname](req, res);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    }
    return;
  }

  // docs/ の中のファイルを返す
  let filePath = path.join(DOCS_DIR, decodeURIComponent(url.pathname));
  if (!filePath.startsWith(DOCS_DIR)) {
    res.statusCode = 403;
    return res.end();
  }
  if (existsSync(filePath) && statSync(filePath).isDirectory()) filePath = path.join(filePath, 'index.html');
  if (!existsSync(filePath)) {
    res.statusCode = 404;
    return res.end('Not Found');
  }
  res.setHeader('Content-Type', TYPES[path.extname(filePath)] || 'application/octet-stream');
  res.end(readFileSync(filePath));
}).listen(PORT, () => {
  console.log(`電話番AI 開発用サーバー: http://localhost:${PORT}`);
  if (!process.env.ANTHROPIC_API_KEY) console.log('※ .env に ANTHROPIC_API_KEY がまだありません');
  if (!process.env.ACCESS_PASSCODE) console.log('※ .env に ACCESS_PASSCODE（合言葉）がまだありません');
});
