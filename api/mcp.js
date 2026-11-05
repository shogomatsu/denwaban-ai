// 家族が Claude のアプリから様子を聞ける窓口（MCP サーバー・読み取り専用）
//
// Claude のアプリの「コネクタ」にこの窓口のアドレスを登録すると、
// 「今週の母の様子は？」「木曜の通院は決まった？」と聞けるようになる。
//
// - できるのは「読む」ことだけ。電話をかける・LINE を送る・書きかえる道具は置かない
// - 鍵（MCP_ACCESS_KEY）が空なら、この窓口は閉じたまま（何も返さない）
// - 鍵は「Authorization: Bearer 鍵」か、アドレスの ?key=鍵 で受け取る（アプリによってはヘッダーを付けられないため）
//   鍵入りのアドレスは合言葉と同じ扱い。人に見せない・どこにも貼らない
// - 協力者の LINE のID、本人の住所・電話番号は返さない
//
// 仕組み：MCP の「Streamable HTTP」の、状態を持たない最小の形（POST で JSON-RPC を受けて、JSON で返す）

import { createHash, timingSafeEqual } from 'node:crypto';
import { isDbConfigured, listRecentCalls, listRecentRequests } from '../lib/db.js';

const SUPPORTED_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

const HEALTH = { good: '元気', so_so: 'まあまあ', unwell: '具合が悪い', urgent: '緊急', unknown: 'わからない' };
const STATUS = { searching: '協力者を探しているところ', matched: '協力者が決まった', not_found: '協力者が見つからなかった' };
const OFFER = { asked: '返事待ち', accepted: '引き受けた', declined: '今回は難しい', closed: 'ほかの方に決まった' };

const NOTE = '※電話番AI（AIのゆげ丸）が毎朝の電話で聞いた内容のまとめです。AI は医療の判断をしません。'
  + '体調のことは、ご本人やかかりつけのお医者さんに確かめてください。緊急のときは119番へ。';

const TOOLS = [
  {
    name: 'get_recent_calls',
    title: '最近の電話のようす',
    description: '毎朝の見守り電話の記録を、新しい順に返します（日付・体調・今日の予定・会話のまとめ）。'
      + '「今週の母の様子は？」のような質問に使います。体調の言葉は本人が電話で話したことのまとめで、診断ではありません。'
      + '答えるときは医療の判断や助言をせず、気になることがあればご家族から本人に連絡するようすすめてください。',
    inputSchema: {
      type: 'object',
      properties: { days: { type: 'integer', minimum: 1, maximum: 14, description: '何日前までさかのぼるか（1〜14。ふつうは7）' } },
      additionalProperties: false,
    },
    annotations: { title: '最近の電話のようす', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'get_help_requests',
    title: '困りごとの状況',
    description: '電話の中で本人が「頼みたい」と言った困りごと（通院の送り迎え・買い物など）と、地域の協力者が決まったかどうかを、新しい順に返します。'
      + '「木曜の通院は決まった？」のような質問に使います。協力者の連絡先は返しません。',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'integer', minimum: 1, maximum: 10, description: '何件まで返すか（1〜10。ふつうは5）' } },
      additionalProperties: false,
    },
    annotations: { title: '困りごとの状況', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
];

export default async function handler(req, res) {
  const send = (status, body) => {
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    if (body === undefined) return res.end();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.end(JSON.stringify(body));
  };

  if (!process.env.MCP_ACCESS_KEY) return send(404);
  if (!validKey(req)) return send(401, { error: 'unauthorized' });
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return send(405);
  }

  let msg;
  try {
    msg = typeof req.body === 'object' && req.body !== null && !Buffer.isBuffer(req.body) ? req.body : JSON.parse(String(req.body || ''));
  } catch {
    return send(400, rpcError(null, -32700, 'Parse error'));
  }
  if (Array.isArray(msg)) return send(400, rpcError(null, -32600, 'Batch is not supported'));
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return send(400, rpcError(msg?.id ?? null, -32600, 'Invalid Request'));

  // 通知（id のないもの）には返事をしない
  if (msg.id === undefined || msg.id === null) return send(202);

  const result = await handle(msg.method, msg.params || {});
  if (result.error) return send(200, { jsonrpc: '2.0', id: msg.id, error: result.error });
  return send(200, { jsonrpc: '2.0', id: msg.id, result: result.ok });
}

async function handle(method, params) {
  switch (method) {
    case 'initialize': {
      const asked = params.protocolVersion;
      return {
        ok: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'denwaban-ai', title: '電話番AI（家族向け・読み取り専用）', version: '0.1.0' },
          instructions: '電話番AIが毎朝の電話で聞いた、高齢のご家族のようすと困りごとの状況を読むための道具です。'
            + '読むだけで、電話をかけたり連絡を送ったりはできません。医療の判断や助言はしないでください。',
        },
      };
    }
    case 'ping':
      return { ok: {} };
    case 'tools/list':
      return { ok: { tools: TOOLS } };
    case 'tools/call':
      return { ok: await callTool(params.name, params.arguments || {}) };
    default:
      return { error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

async function callTool(name, args) {
  if (!TOOLS.some((t) => t.name === name)) return toolText(`「${name}」という道具はありません。`, true);
  if (!isDbConfigured()) return toolText('データベース（Supabase）の設定がまだのため、記録を読めません。', true);

  if (name === 'get_recent_calls') {
    const days = clampInt(args.days, 1, 14, 7);
    const calls = await listRecentCalls(days);
    if (!calls.length) return toolText(`この${days}日間の電話の記録はありません。\n${NOTE}`);
    const lines = calls.map((c) => {
      const parts = [`■ ${c.call_date}（${c.user_name}）`, `体調：${HEALTH[c.health] || 'わからない'}`];
      if (c.today_plan) parts.push(`今日の予定：${c.today_plan}`);
      if (Array.isArray(c.needs) && c.needs.length) parts.push(`困りごと：${c.needs.map(needText).join('、')}`);
      if (c.summary) parts.push(`まとめ：${c.summary}`);
      return parts.join('\n');
    });
    return toolText(`この${days}日間の電話の記録（${calls.length}件・新しい順）\n\n${lines.join('\n\n')}\n\n${NOTE}`);
  }

  // get_help_requests
  const limit = clampInt(args.limit, 1, 10, 5);
  const requests = await listRecentRequests(limit);
  if (!requests.length) return toolText('いま、頼みごとはありません。');
  const lines = requests.map((r) => {
    const accepted = r.offers.find((o) => o.status === 'accepted');
    const parts = [
      `■ ${r.category}（${r.user_name}）`,
      `いつ：${r.when_text || '本人と相談'}`,
      ...(r.where_text ? [`どこへ：${r.where_text}`] : []),
      `状況：${STATUS[r.status] || r.status}${accepted ? `（ご近所の${accepted.helper_name}が引き受けてくださいました）` : ''}`,
      `受け付けた日：${toJapanDate(r.created_at)}`,
    ];
    if (r.offers.length) parts.push(`声をかけた方：${r.offers.map((o) => `${o.helper_name}（${OFFER[o.status] || o.status}）`).join('、')}`);
    return parts.join('\n');
  });
  return toolText(`最近の頼みごと（${requests.length}件・新しい順）\n\n${lines.join('\n\n')}`);
}

function needText(n) {
  if (typeof n === 'string') return n;
  return [n?.category, n?.detail].filter(Boolean).join('：') || '（内容なし）';
}

function toolText(text, isError = false) {
  return { content: [{ type: 'text', text }], isError };
}

function rpcError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function clampInt(v, min, max, fallback) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function toJapanDate(iso) {
  return new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
}

// 鍵の確認（Authorization: Bearer 鍵 か、?key=鍵）。かかる時間から推測されにくい比べ方をする
function validKey(req) {
  const expected = process.env.MCP_ACCESS_KEY;
  const auth = String(req.headers.authorization || '');
  let given = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
  if (!given) {
    try {
      given = new URL(req.url, 'http://localhost').searchParams.get('key') || '';
    } catch {
      given = '';
    }
  }
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return given.length > 0 && timingSafeEqual(a, b);
}
