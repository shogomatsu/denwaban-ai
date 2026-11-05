// データベース（Supabase）への保存
//
// 必要な環境変数（Vercel の Environment Variables、手元なら .env）：
//   SUPABASE_URL         プロジェクトの URL（https://xxxx.supabase.co）
//   SUPABASE_SECRET_KEY  秘密のキー（sb_secret_ で始まる。古いプロジェクトでは service_role キー）
//
// どちらかが空のときは何も保存せず、会話はそのまま続けます（保存は「おまけ」で、通話を止めない）。
// 秘密のキーは RLS を通り抜けて全部読み書きできるので、絶対にブラウザ（docs/）に出さないこと。

import { createClient } from '@supabase/supabase-js';

let client = null;

function getClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SECRET_KEY;
  if (!url || !key) return null;
  if (!client) client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return client;
}

export function isDbConfigured() {
  return Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_SECRET_KEY);
}

// 困りごとを保存する。保存できたら id、できなければ null
export async function saveHelpRequest(req) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db
    .from('help_requests')
    .insert({
      call_id: req.callId,
      user_name: req.userName,
      area: req.area || null,
      category: req.category,
      detail: req.detail,
      when_text: req.when || null,
      where_text: req.where || null,
      consent_quote: req.consentQuote,
    })
    .select('id')
    .single();
  if (error) {
    console.error('[db] 困りごとを保存できませんでした', error.message);
    return null;
  }
  return data.id;
}

// 通話の記録を保存する（同じ通話は1件にまとめる）
export async function saveCall(call) {
  const db = getClient();
  if (!db) return false;
  const { error } = await db.from('calls').upsert(
    {
      call_id: call.callId,
      user_name: call.userName,
      call_date: call.callDate,
      health: call.health || null,
      today_plan: call.todayPlan || null,
      needs: call.needs || [],
      summary: call.summary || null,
    },
    { onConflict: 'call_id' },
  );
  if (error) {
    console.error('[db] 通話の記録を保存できませんでした', error.message);
    return false;
  }
  return true;
}

// ---- 調整係・LINE の受け口で使う ----

export async function getHelpRequest(id) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db.from('help_requests').select('*').eq('id', id).maybeSingle();
  if (error) console.error('[db] 困りごとを読めませんでした', error.message);
  return data || null;
}

// 調整係に渡す協力者の一覧（LINE のIDやポイントは渡さない）
export async function listHelpers() {
  const db = getClient();
  if (!db) return [];
  const { data, error } = await db.from('helpers').select('id, display_name, can_do, area, available, has_car, line_user_id').order('created_at');
  if (error) console.error('[db] 協力者を読めませんでした', error.message);
  return data || [];
}

export async function getHelper(id) {
  const db = getClient();
  if (!db) return null;
  const { data } = await db.from('helpers').select('*').eq('id', id).maybeSingle();
  return data || null;
}

// この困りごとで、すでに声をかけた協力者のID
export async function offeredHelperIds(helpRequestId) {
  const db = getClient();
  if (!db) return [];
  const { data } = await db.from('offers').select('helper_id').eq('help_request_id', helpRequestId);
  return (data || []).map((r) => r.helper_id);
}

export async function saveAssessments(helpRequestId, assessments) {
  const db = getClient();
  if (!db) return;
  const { error } = await db.from('help_requests').update({ assessments }).eq('id', helpRequestId);
  if (error) console.error('[db] 選んだ理由を保存できませんでした', error.message);
}

export async function createOffer(offer) {
  const db = getClient();
  if (!db) return null;
  const { data, error } = await db
    .from('offers')
    .insert({ help_request_id: offer.helpRequestId, helper_id: offer.helperId, reason: offer.reason, message: offer.message })
    .select('id')
    .single();
  if (error) {
    console.error('[db] 声かけを保存できませんでした', error.message);
    return null;
  }
  return data.id;
}

export async function getOffer(id) {
  const db = getClient();
  if (!db) return null;
  const { data } = await db.from('offers').select('*').eq('id', id).maybeSingle();
  return data || null;
}

export async function setOfferStatus(id, status) {
  const db = getClient();
  if (!db) return;
  await db.from('offers').update({ status }).eq('id', id);
}

// 「探している」ものだけを状態変更する。先に誰かが引き受けていたら false（早い者勝ち）
export async function setHelpRequestStatusIfSearching(id, status) {
  const db = getClient();
  if (!db) return false;
  const { data, error } = await db.from('help_requests').update({ status }).eq('id', id).eq('status', 'searching').select('id');
  if (error) console.error('[db] 困りごとの状態を変えられませんでした', error.message);
  return Boolean(data && data.length);
}

export async function addThanksPoint(helperId) {
  const db = getClient();
  if (!db) return;
  const helper = await getHelper(helperId);
  if (helper) await db.from('helpers').update({ points: (helper.points || 0) + 1 }).eq('id', helperId);
}

// ---- 電話（Twilio）の通話中の会話 ----

export async function getCallSession(callSid) {
  const db = getClient();
  if (!db) return null;
  const { data } = await db.from('call_sessions').select('*').eq('call_sid', callSid).maybeSingle();
  return data || null;
}

export async function saveCallSession(s) {
  const db = getClient();
  if (!db) return false;
  const { error } = await db.from('call_sessions').upsert({
    call_sid: s.callSid, call_id: s.callId, call_date: s.callDate, purpose: s.purpose || 'morning',
    messages: s.messages, silent: s.silent || 0, updated_at: new Date().toISOString(),
  }, { onConflict: 'call_sid' });
  if (error) console.error('[db] 通話中の会話を保存できませんでした', error.message);
  return !error;
}

// ---- 状況画面 ----

// 最近の困りごと（新しい順）と、声かけの状況
export async function listRecentRequests(limit = 5) {
  const db = getClient();
  if (!db) return [];
  const { data: requests, error } = await db.from('help_requests')
    .select('id, user_name, area, category, detail, when_text, where_text, consent_quote, status, assessments, created_at')
    .order('created_at', { ascending: false }).limit(limit);
  if (error || !requests?.length) return [];
  const { data: offers } = await db.from('offers')
    .select('help_request_id, helper_id, reason, message, status, created_at')
    .in('help_request_id', requests.map((r) => r.id)).order('created_at');
  const { data: helpers } = await db.from('helpers').select('id, display_name, points');
  const nameOf = (id) => helpers?.find((h) => h.id === id)?.display_name || '（不明）';
  return requests.map((r) => ({
    ...r,
    offers: (offers || []).filter((o) => o.help_request_id === r.id).map((o) => ({ ...o, helper_name: nameOf(o.helper_id) })),
  }));
}

// 引き受けてくれた協力者の呼び名（折り返しの電話で使う）
export async function acceptedHelperName(helpRequestId) {
  const db = getClient();
  if (!db) return null;
  const { data } = await db.from('offers').select('helper_id').eq('help_request_id', helpRequestId).eq('status', 'accepted').maybeSingle();
  if (!data) return null;
  const helper = await getHelper(data.helper_id);
  return helper?.display_name || null;
}

// ---- 家族の声の伝言 ----

const VOICE_BUCKET = 'voice-messages';

// 伝言の音声（mp3）を保存する。保存できたら行のID
export async function saveVoiceMessage({ fromName, mp3 }) {
  const db = getClient();
  if (!db) return null;
  // バケットがなければ作る（非公開。すでにあればエラーになるが気にしない）
  await db.storage.createBucket(VOICE_BUCKET, { public: false }).catch(() => {});
  const storagePath = `${new Date().toISOString().slice(0, 10)}/${crypto.randomUUID()}.mp3`;
  const up = await db.storage.from(VOICE_BUCKET).upload(storagePath, mp3, { contentType: 'audio/mpeg' });
  if (up.error) {
    console.error('[db] 伝言の音声を保存できませんでした', up.error.message);
    return null;
  }
  const { data, error } = await db.from('voice_messages').insert({ from_name: fromName, storage_path: storagePath }).select('id').single();
  if (error) {
    console.error('[db] 伝言を保存できませんでした', error.message);
    return null;
  }
  return data.id;
}

// まだ流していない、いちばん新しい伝言（電話で流すための、10分だけ使えるURLつき）
export async function nextVoiceMessage() {
  const db = getClient();
  if (!db) return null;
  const { data } = await db.from('voice_messages').select('*').is('played_at', null).order('created_at', { ascending: false }).limit(1);
  const row = data?.[0];
  if (!row) return null;
  const signed = await db.storage.from(VOICE_BUCKET).createSignedUrl(row.storage_path, 600);
  if (signed.error) {
    console.error('[db] 伝言のURLを作れませんでした', signed.error.message);
    return null;
  }
  return { id: row.id, fromName: row.from_name, url: signed.data.signedUrl };
}

export async function markVoicePlayed(id) {
  const db = getClient();
  if (!db) return;
  await db.from('voice_messages').update({ played_at: new Date().toISOString() }).eq('id', id);
}

// ---- 家族が Claude に様子を聞く（MCP・読み取り専用） ----

// 最近の通話の記録（新しい順）。days 日前から
export async function listRecentCalls(days = 7) {
  const db = getClient();
  if (!db) return [];
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await db.from('calls')
    .select('user_name, call_date, health, today_plan, needs, summary, created_at')
    .gte('created_at', since).order('created_at', { ascending: false }).limit(30);
  if (error) console.error('[db] 通話の記録を読めませんでした', error.message);
  return data || [];
}
