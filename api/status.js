// 状況画面（docs/status.html）用：最近の困りごとと、調整係が選んだ理由・声かけの状況を返す
// 合言葉（X-Passcode）が必要。協力者の LINE のIDや、本人の住所・電話番号は返さない。

import { checkPasscode } from '../lib/auth.js';
import { isDbConfigured, listRecentRequests } from '../lib/db.js';
import { isTwilioConfigured } from '../lib/twilio.js';

export default async function handler(req, res) {
  const send = (status, data) => {
    res.statusCode = status;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.end(JSON.stringify(data));
  };
  if (!checkPasscode(req)) return send(401, { error: '合言葉がちがいます' });
  if (!isDbConfigured()) return send(500, { error: 'データベース（Supabase）の設定がまだです' });
  const requests = await listRecentRequests(5);
  return send(200, {
    requests: requests.map((r) => ({
      id: r.id,
      userName: r.user_name,
      area: r.area,
      category: r.category,
      detail: r.detail,
      when: r.when_text,
      where: r.where_text,
      consentQuote: r.consent_quote,
      status: r.status,
      createdAt: r.created_at,
      assessments: r.assessments || [],
      offers: r.offers.map((o) => ({ helperName: o.helper_name, reason: o.reason, message: o.message, status: o.status })),
    })),
    phoneReady: isTwilioConfigured() && Boolean(process.env.TWILIO_CALL_TO),
  });
}
