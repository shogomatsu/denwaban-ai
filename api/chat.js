// 電話番AI の会話窓口（Vercel のサーバーレス関数）
//
// ブラウザから「これまでの会話」と「今回の言葉」を受け取り、Claude の返事を返します。
// - API キー（ANTHROPIC_API_KEY）はサーバー側の環境変数からだけ読みます。ブラウザには出しません。
// - 合言葉（ACCESS_PASSCODE）を知っている人だけが使えます。
// - サーバーは会話を保存しません。会話はブラウザが持ち、毎回まとめて送ってきます。

import Anthropic from '@anthropic-ai/sdk';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { getProfile } from '../lib/profile.js';
import { buildFamilyMessage, sendFamilyLine } from '../lib/line.js';
import { saveCall, saveHelpRequest } from '../lib/db.js';
import { buildSystemPrompt, getTools, todayInJapan } from '../lib/prompt.js';

// 電話がつながった合図（画面には出しません）。これを受けて AI があいさつします。
const CALL_START_TEXT = '（電話がつながりました。あいさつから始めてください。）';

// うまく返事が作れなかったときに読み上げる言葉
const FALLBACK_REPLY = 'すみません、うまくお返事できませんでした。もう一度お話しいただけますか。';

// 悪用・使いすぎ防止の上限
const MAX_HISTORY_MESSAGES = 80; // 1回の通話で送れる会話の数
const MAX_TEXT_LENGTH = 500; // 1回に話せる文字数
const MAX_BODY_BYTES = 300_000;
const MAX_MODEL_CALLS_PER_TURN = 4; // ツールを使うときの往復の上限

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
  if (!sameText(normalizePasscode(decodeHeader(req.headers['x-passcode'])), normalizePasscode(passcode))) {
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

  const messages = [...history];
  if (messages.length === 0) messages.push({ role: 'user', content: CALL_START_TEXT });
  if (text) messages.push({ role: 'user', content: text });

  // ---- Claude を呼ぶ ----
  const model = process.env.AI_MODEL || 'claude-haiku-5-5';
  const effort = process.env.AI_EFFORT || 'low';
  const profile = getProfile();
  const system = buildSystemPrompt(profile, callDate);
  const tools = getTools();
  const client = new Anthropic();

  const startedAt = Date.now();
  const replyParts = [];
  const notifications = [];
  const lineResults = []; // LINE に送った（送ろうとした）お知らせ
  const helpRequests = []; // この返事の中で受け付けた困りごと
  let ended = false;
  let endReport = null;
  let refused = false;

  try {
    for (let i = 0; i < MAX_MODEL_CALLS_PER_TURN; i++) {
      const response = await client.messages.create({
        model,
        max_tokens: 4000,
        system,
        tools,
        output_config: { effort },
        messages,
      });

      if (response.stop_reason === 'refusal') {
        // 断られた返事は会話に残さず、聞き返す
        console.warn('[refusal]', response.stop_details);
        refused = true;
        break;
      }

      // 考えた内容（thinking）も含めて、返ってきたものをそのまま会話に残す
      messages.push({ role: 'assistant', content: response.content });
      for (const block of response.content) {
        if (block.type === 'text' && block.text.trim()) replyParts.push(block.text.trim());
      }

      if (response.stop_reason !== 'tool_use') break;

      // ---- ツールの処理（notify_family / end_call）----
      const toolResults = [];
      for (const block of response.content) {
        if (block.type !== 'tool_use') continue;
        const ctx = { notifications, lineResults, helpRequests, profile, messages, callId, callDate, onEnd: (report) => { ended = true; endReport = report; } };
        toolResults.push(await runTool(block, ctx));
      }
      messages.push({ role: 'user', content: toolResults });

      // お別れのあとは、もう AI を呼ばない
      if (ended) break;
    }
  } catch (error) {
    return sendApiError(res, error);
  }

  const reply = replyParts.join('') || (ended ? '' : FALLBACK_REPLY);

  return send(res, 200, {
    reply,
    messages,
    callDate,
    callId,
    notifications,
    helpRequests,
    lineResults,
    ended,
    endReport,
    refused,
    model,
    elapsedMs: Date.now() - startedAt,
  });
}

// ---- ツール ----
// 通知のタイミング（会話設計「4. 家族へのLINE通知」のとおり）
// - urgent（緊急）：その場ですぐに LINE を送る
// - concern（体調が悪いと言った）：お電話のあと（end_call のとき）に、まとめて1通送る
async function runTool(block, { notifications, lineResults, helpRequests, profile, messages, callId, callDate, onEnd }) {
  const input = block.input || {};
  if (block.name === 'notify_family') {
    const note = {
      level: input.level === 'urgent' ? 'urgent' : 'concern',
      quote: String(input.quote || ''),
      summary: String(input.summary || ''),
    };
    notifications.push(note);
    console.log('[notify_family]', note.level);
    if (note.level === 'urgent') {
      const text = buildFamilyMessage(note, profile);
      lineResults.push({ level: 'urgent', text, ...(await sendFamilyLine(text)) });
    }
    return { type: 'tool_result', tool_use_id: block.id, content: 'ご家族への通知を受け付けました。' };
  }
  if (block.name === 'request_help') {
    const req = {
      callId,
      userName: profile.userName,
      area: profile.area,
      category: String(input.category || 'その他'),
      detail: String(input.detail || ''),
      when: String(input.when || ''),
      where: String(input.where || ''),
      consentQuote: String(input.consent_quote || ''),
    };
    if (!req.consentQuote.trim() || !req.detail.trim()) {
      // 同意の言葉がない依頼は受け付けない（安全のための二重チェック）
      return { type: 'tool_result', tool_use_id: block.id, is_error: true,
        content: 'ご本人が頼むと言った言葉（consent_quote）がないため、受け付けませんでした。ご本人に「探してみましょうか？」と聞いてください。' };
    }
    const id = await saveHelpRequest(req);
    helpRequests.push({ ...req, id, saved: Boolean(id) });
    // ログには名前や中身を残さない（機微な情報のため）
    console.log('[request_help]', req.category, id ? 'saved' : 'not_saved');
    return { type: 'tool_result', tool_use_id: block.id,
      content: '依頼を受け付けました。これから協力者を探します。ご本人には「探してみますね。決まったらお知らせしますね。」とだけ伝え、誰が来るかや、必ず見つかるかは約束しないでください。' };
  }
  if (block.name === 'end_call') {
    const report = {
      health: input.health || 'unknown',
      todayPlan: input.today_plan || '',
      needs: Array.isArray(input.needs) ? input.needs : [],
      summary: input.summary || '',
    };
    onEnd(report);
    console.log('[end_call]', report.health);
    await saveCall({ callId, callDate, userName: profile.userName, ...report });

    // この通話で出た「体調が悪い」の言葉を集めて、1通にまとめて送る
    const quotes = collectConcernQuotes(messages);
    if (quotes.length) {
      const text = buildFamilyMessage({ level: 'concern', quote: quotes.join('』『') }, profile);
      lineResults.push({ level: 'concern', text, ...(await sendFamilyLine(text)) });
    }
    return { type: 'tool_result', tool_use_id: block.id, content: '通話を終了しました。' };
  }
  return { type: 'tool_result', tool_use_id: block.id, content: `不明なツールです：${block.name}`, is_error: true };
}

// 会話の中の notify_family（concern）の言葉を、出てきた順に集める（同じ言葉は1回だけ）
function collectConcernQuotes(messages) {
  const quotes = [];
  for (const m of messages) {
    if (m.role !== 'assistant' || !Array.isArray(m.content)) continue;
    for (const b of m.content) {
      if (b.type === 'tool_use' && b.name === 'notify_family' && b.input?.level !== 'urgent' && b.input?.quote) {
        const q = String(b.input.quote).replace(/^[「『]|[」』]$/g, '');
        if (!quotes.includes(q)) quotes.push(q);
      }
    }
  }
  return quotes;
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
