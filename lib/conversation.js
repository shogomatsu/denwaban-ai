// 1回分のやりとり（本人の言葉 → Claude の返事）。ブラウザ（api/chat.js）と電話（api/twilio/voice.js）で共通。
//
// 会話の履歴は呼び出し側が持つ（ブラウザ、または電話なら Supabase の call_sessions）。
// 履歴は追記のみ。システムプロンプトは通話の日付（callDate）で固定し、途中で変えない。

import Anthropic from '@anthropic-ai/sdk';
import { waitUntil } from '@vercel/functions';
import { getProfile } from './profile.js';
import { buildFamilyMessage, sendFamilyLine } from './line.js';
import { saveCall, saveHelpRequest } from './db.js';
import { coordinate } from './coordinator.js';
import { buildSystemPrompt, getTools } from './prompt.js';

// 電話がつながった合図（画面には出さない）。これを受けて AI があいさつする
export const CALL_START_TEXT = '（電話がつながりました。あいさつから始めてください。）';

// うまく返事が作れなかったときに読み上げる言葉
export const FALLBACK_REPLY = 'すみません、うまくお返事できませんでした。もう一度お話しいただけますか。';

const MAX_MODEL_CALLS_PER_TURN = 4; // ツールを使うときの往復の上限

// history：これまでの会話、text：本人の言葉（空なら、通話の始まり）
// startText：通話の始まりに AI に渡す合図（折り返しの電話などで差し替える）
export async function runTurn({ history, text, callDate, callId, startText = CALL_START_TEXT }) {
  const messages = [...history];
  if (messages.length === 0) messages.push({ role: 'user', content: startText });
  if (text) messages.push({ role: 'user', content: text });

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
      console.warn('[refusal]', response.stop_details?.category);
      refused = true;
      break;
    }

    // 考えた内容（thinking）も含めて、返ってきたものをそのまま会話に残す
    messages.push({ role: 'assistant', content: response.content });
    for (const block of response.content) {
      if (block.type === 'text' && block.text.trim()) replyParts.push(block.text.trim());
    }

    if (response.stop_reason !== 'tool_use') break;

    // ---- ツールの処理（notify_family / request_help / end_call）----
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

  const reply = replyParts.join('') || (ended ? '' : FALLBACK_REPLY);
  return { reply, messages, callDate, callId, notifications, helpRequests, lineResults, ended, endReport, refused, model, elapsedMs: Date.now() - startedAt };
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
    // 調整係（Sonnet）に、協力者探しを頼む。通話は待たせずに、裏で進める
    if (id) waitUntil(coordinate(id).catch((e) => console.error('[coordinator] 失敗', e)));
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

