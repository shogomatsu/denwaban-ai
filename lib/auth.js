// 合言葉（ACCESS_PASSCODE）の確認。画面・状況画面・電話をかけるボタンで共通。

import { createHash, timingSafeEqual } from 'node:crypto';

// リクエストの X-Passcode ヘッダーが合言葉と同じなら true
export function checkPasscode(req) {
  const passcode = process.env.ACCESS_PASSCODE;
  if (!passcode) return false;
  return sameText(normalizePasscode(decodeHeader(req.headers['x-passcode'])), normalizePasscode(passcode));
}

// 画面からは、日本語も送れるように「%E3%81%86…」の形に変えて送ってくる
function decodeHeader(value) {
  try {
    return decodeURIComponent(String(value || ''));
  } catch {
    return '';
  }
}

// 全角・半角のちがいや、前後の空白は気にしない（「ＡＢＣ」と「ABC」を同じにする）
function normalizePasscode(text) {
  return String(text).normalize('NFKC').trim();
}

// 合言葉を、かかる時間から推測されにくい方法で比べる
function sameText(a, b) {
  const ha = createHash('sha256').update(String(a)).digest();
  const hb = createHash('sha256').update(String(b)).digest();
  return timingSafeEqual(ha, hb);
}

