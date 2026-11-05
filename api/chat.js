// 電話番AI の会話窓口（Vercel のサーバーレス関数）
//
// ブラウザから「これまでの会話」と「今回の言葉」を受け取り、Claude の返事を返します。
// - API キー（ANTHROPIC_API_KEY）はサーバー側の環境変数からだけ読みます。ブラウザには出しません。
// - 合言葉（ACCESS_PASSCODE）を知っている人だけが使えます。
// - サーバーは会話を保存しません。会話はブラウザが持ち、毎回まとめて送ってきます。

import Anthropic from '@anthropic-ai/sdk';
import { randomUUID } from 'node:crypto';
import { checkPasscode } from '../lib/auth.js';
import { runTurn, voiceMessageAfterText, voiceMessagePlayedNote, voiceMessageStartText } from '../lib/conversation.js';
import { markVoicePlayed, nextVoiceMessage } from '../lib/db.js';
import { todayInJapan } from '../lib/prompt.js';

// 悪用・使いすぎ防止の上限
const MAX_HISTORY_MESSAGES = 80; // 1回の通話で送れる会話の数
const MAX_TEXT_LENGTH = 500; // 1回に話せる文字数
const MAX_BODY_BYTES = 300_000;

const DEFAULT_ALLOWED_ORIGINS = ['https://shogomatsu.github.io'];

export default async function handler(req, res) {
  setCors(req, res);
  if (req.method === 'OPTIONS') return send(res, 204);
  if (req.method !== 'POST') return send(res, 405, { error: 'POST で呼んでください' });

  // ---- 設定の確認 ----
  const passcode = process.env.ACCESS_PASSCODE;
  if (!passcode) {
    return send(res, 500, { error: 'サーバーに合言葉（ACCESS_PASSCODE）が設定されていません' });
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    return send(res, 500, { error: 'サーバーに API キー（ANTHROPIC_API_KEY）が設定されていません' });
  }

  // ---- 合言葉の確認 ----
  if (!checkPasscode(req)) {
    return send(res, 401, { error: '合言葉がちがいます' });
  }

  // ---- 受け取った内容の確認 ----
  let body;
  try {
    body = readBody(req);
  } catch (e) {
    return send(res, 400, { error: e.message });
  }
  const history = Array.isArray(body.messages) ? body.messages : [];
  const text = typeof body.text === 'string' ? body.text.trim() : '';
  if (history.length > MAX_HISTORY_MESSAGES) {
    return send(res, 400, { error: '通話が長くなりすぎました。いったん電話を切って、かけ直してください' });
  }
  if (!history.every((m) => m && (m.role === 'user' || m.role === 'assistant'))) {
    return send(res, 400, { error: '会話の形がおかしいようです' });
  }
  if (text.length > MAX_TEXT_LENGTH) {
    return send(res, 400, { error: `一度に話せるのは${MAX_TEXT_LENGTH}文字までです` });
  }

  // 通話の日付は、通話の最初に決めたものを使い続ける
  // （途中でシステムプロンプトが変わると、AI の考えた内容が引き継げなくなるため）
  const callDate = typeof body.callDate === 'string' && body.callDate ? body.callDate.slice(0, 30) : todayInJapan();
  // 1回の通話を表すID（通話の記録と困りごとを結びつける）
  const callId = typeof body.callId === 'string' && /^[0-9a-f-]{36}$/.test(body.callId) ? body.callId : randomUUID();

  try {
    // 通話の始まりで、ご家族の声の伝言が届いていれば、あいさつのあとに画面で流す
    const voice = history.length === 0 && !text ? await nextVoiceMessage() : null;
    const startText = voice ? voiceMessageStartText(voice.fromName) : undefined;
    const result = await runTurn({ history, text, callDate, callId, startText });
    if (voice && !result.ended) {
      result.messages.push(voiceMessagePlayedNote(voice.fromName));
      result.voiceMessage = { url: voice.url, fromName: voice.fromName, afterText: voiceMessageAfterText(voice.fromName) };
      await markVoicePlayed(voice.id);
    }
    return send(res, 200, result);
  } catch (error) {
    return sendApiError(res, error);
  }
}

// ---- 小さな道具 ----
function send(res, status, data) {
  res.statusCode = status;
  if (data === undefined) return res.end();
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

function setCors(req, res) {
  // 画面と同じ場所（Vercel）から呼ぶときは不要。GitHub Pages 版の画面から呼ぶときのための設定
  const allowed = (process.env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const origins = allowed.length ? allowed : DEFAULT_ALLOWED_ORIGINS;
  const origin = req.headers.origin;
  if (origin && (origins.includes(origin) || /^http:\/\/localhost(:\d+)?$/.test(origin))) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Passcode');
  }
}

function readBody(req) {
  let body = req.body;
  if (typeof body === 'string') {
    if (body.length > MAX_BODY_BYTES) throw new Error('送られてきた内容が大きすぎます');
    try {
      body = JSON.parse(body);
    } catch {
      throw new Error('送られてきた内容が読めませんでした');
    }
  }
  if (!body || typeof body !== 'object') throw new Error('送られてきた内容が空です');
  if (JSON.stringify(body).length > MAX_BODY_BYTES) throw new Error('送られてきた内容が大きすぎます');
  return body;
}

function sendApiError(res, error) {
  console.error('[claude error]', error);
  if (error instanceof Anthropic.AuthenticationError) {
    return send(res, 500, { error: 'API キーが正しくないようです。Vercel の設定を確かめてください' });
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    return send(res, 500, { error: 'この API キーでは、このAIを使えないようです' });
  }
  if (error instanceof Anthropic.NotFoundError) {
    return send(res, 500, { error: 'AI の種類（AI_MODEL）の名前がちがうようです' });
  }
  if (error instanceof Anthropic.RateLimitError) {
    return send(res, 429, { error: 'いま混み合っています。少し待ってからお試しください' });
  }
  if (error instanceof Anthropic.BadRequestError) {
    return send(res, 400, { error: '会話の内容をうまく送れませんでした。電話をかけ直してください' });
  }
  if (error instanceof Anthropic.APIError) {
    return send(res, 502, { error: 'AI のサーバーにつながりませんでした。少し待ってからお試しください' });
  }
  return send(res, 500, { error: 'サーバーで思わぬエラーが起きました' });
}
