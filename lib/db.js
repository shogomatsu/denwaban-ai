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
