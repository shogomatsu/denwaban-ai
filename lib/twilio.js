// Twilio（電話）まわりの小さな道具
//
// 必要な環境変数：
//   TWILIO_ACCOUNT_SID   アカウントID（AC で始まる）
//   TWILIO_AUTH_TOKEN    Auth Token（秘密。届いた知らせが本当に Twilio からかを確かめるのにも使う）
//   TWILIO_PHONE_NUMBER  買ったアメリカの番号（+1 で始まる）
//   TWILIO_CALL_TO       電話をかける相手（本人の電話番号。+81 で始まる形。例：+8190xxxxxxxx）
//   TWILIO_ALLOWED_NUMBERS かかってきた電話を受けてよい番号（カンマ区切り。空なら TWILIO_CALL_TO だけ）
//   TWILIO_VOICE         読み上げの声（空なら Polly.Kazuha-Neural）
//   PUBLIC_BASE_URL      公開アドレス（例：https://denwaban-ai.vercel.app）。署名の確認と、電話の窓口の場所に使う

import { createHmac, timingSafeEqual } from 'node:crypto';

export function isTwilioConfigured() {
  return Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_PHONE_NUMBER);
}

export function baseUrl(req) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  return `https://${host}`;
}

// 電話の窓口に届いたフォームの中身
export function readForm(req) {
  if (req.body && typeof req.body === 'object') return { ...req.body };
  return Object.fromEntries(new URLSearchParams(String(req.body || '')));
}

// Twilio の署名を確かめる（URL ＋ パラメータを名前順に並べてつなげ、Auth Token で HMAC-SHA1）
export function validTwilioSignature(req, params) {
  const token = process.env.TWILIO_AUTH_TOKEN;
  const signature = req.headers['x-twilio-signature'];
  if (!token || !signature) return false;
  const url = baseUrl(req) + req.url;
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const expected = createHmac('sha1', token).update(data).digest();
  const given = Buffer.from(String(signature), 'base64');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export function allowedCaller(number) {
  const list = (process.env.TWILIO_ALLOWED_NUMBERS || process.env.TWILIO_CALL_TO || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(String(number || '').trim());
}

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function say(text) {
  const voice = process.env.TWILIO_VOICE || 'Polly.Kazuha-Neural';
  return `<Say language="ja-JP" voice="${esc(voice)}">${esc(text)}</Say>`;
}

// 話して、そのまま聞く
export function twimlSayAndListen(text, actionUrl) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? say(text) : ''}`
    + `<Gather input="speech" language="ja-JP" speechTimeout="auto" timeout="7" actionOnEmptyResult="true" method="POST" action="${esc(actionUrl)}"/>`
    + '</Response>';
}

// 話して、電話を切る
export function twimlSayAndHangup(text) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? say(text) : ''}<Hangup/></Response>`;
}

// Twilio から電話をかける。url は、つながったときに呼ばれる電話の窓口
export async function placeCall({ to, url }) {
  const sid = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Calls.json`, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ To: to, From: process.env.TWILIO_PHONE_NUMBER, Url: url, Method: 'POST' }),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error('[twilio] 発信できませんでした', res.status, data?.code, data?.message);
    return { ok: false, status: res.status, code: data?.code, message: data?.message };
  }
  return { ok: true, sid: data.sid };
}
