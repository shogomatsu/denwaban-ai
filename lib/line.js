// ご家族への LINE 通知（LINE Messaging API）
//
// 必要な環境変数（Vercel の Environment Variables、手元なら .env）：
//   LINE_CHANNEL_ACCESS_TOKEN  LINE Developers で発行する「チャネルアクセストークン（長期）」
//   LINE_TO_USER_IDS           送り先のユーザーID（U で始まる文字）。カンマ区切りで複数可。
//                              空なら、公式アカウントの「友だち全員」に送る（ブロードキャスト）
//
// トークンが入っていないときは何も送らず、画面にデモ表示するだけです。

const LINE_API = 'https://api.line.me/v2/bot/message';

// 会話設計（docs/conversation-design.md「4. 家族へのLINE通知」）の文面
export function buildFamilyMessage(note, profile) {
  const who = profile.userName;
  if (note.level === 'urgent') {
    return `【電話番AI・至急】${who}が今朝の電話で『${note.quote}』とおっしゃいました。119番への電話をおすすめしています。すぐに連絡を取ってください。`;
  }
  return `【電話番AI】${who}が今朝の電話で『${note.quote}』とおっしゃっていました。様子を見てあげてください。`;
}

// 送れたら { sent: true }、送らなかった・送れなかったら { sent: false, reason }
export async function sendFamilyLine(text) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { sent: false, reason: 'not_configured' };

  const to = (process.env.LINE_TO_USER_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const url = to.length ? `${LINE_API}/multicast` : `${LINE_API}/broadcast`;
  const body = { messages: [{ type: 'text', text: text.slice(0, 5000) }] };
  if (to.length) body.to = to;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error('[line] 送信失敗', res.status, await res.text());
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error('[line] 送信エラー', e);
    return { sent: false, reason: 'network' };
  }
}

// ---- 協力者とのやりとり（調整係・LINE の受け口で使う） ----

async function callLine(path, body) {
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { sent: false, reason: 'not_configured' };
  try {
    const res = await fetch(`${LINE_API}/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      console.error('[line] 送信失敗', path, res.status, await res.text());
      return { sent: false, reason: `http_${res.status}` };
    }
    return { sent: true };
  } catch (e) {
    console.error('[line] 送信エラー', path, e);
    return { sent: false, reason: 'network' };
  }
}

// 1人に送る（協力者への依頼など）
export function pushTo(userId, messages) {
  if (!userId) return Promise.resolve({ sent: false, reason: 'no_user_id' });
  return callLine('push', { to: userId, messages });
}

// 受け取ったイベントに返事をする
export function replyTo(replyToken, messages) {
  if (!replyToken) return Promise.resolve({ sent: false, reason: 'no_reply_token' });
  return callLine('reply', { replyToken, messages });
}

export const text = (t) => ({ type: 'text', text: String(t).slice(0, 5000) });

// 協力者への依頼：本文と「引き受ける／今回は難しい」のボタン
export function helperAskMessages(offerId, message) {
  return [
    text(message),
    {
      type: 'template',
      altText: 'お手伝いのお願い：引き受けていただけますか？',
      template: {
        type: 'buttons',
        text: '引き受けていただけますか？',
        actions: [
          { type: 'postback', label: '引き受ける', data: `offer=${offerId}&a=accept`, displayText: '引き受けます' },
          { type: 'postback', label: '今回は難しい', data: `offer=${offerId}&a=decline`, displayText: '今回は難しいです' },
        ],
      },
    },
  ];
}
