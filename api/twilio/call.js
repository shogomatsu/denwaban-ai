// ゆげ丸から電話をかける（テスト用のボタンから呼ぶ）
// かける相手は環境変数の TWILIO_CALL_TO だけ（画面から番号は指定できない＝知らない番号に電話をかけさせない）

import { checkPasscode } from '../../lib/auth.js';
import { baseUrl, isTwilioConfigured, placeCall } from '../../lib/twilio.js';

export default async function handler(req, res) {
  const send = (status, data) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.end(JSON.stringify(data)); };
  if (req.method !== 'POST') return send(405, { error: 'POST で呼んでください' });
  if (!checkPasscode(req)) return send(401, { error: '合言葉がちがいます' });
  if (!isTwilioConfigured() || !process.env.TWILIO_CALL_TO) {
    return send(500, { error: '電話の設定（TWILIO_ACCOUNT_SID・TWILIO_AUTH_TOKEN・TWILIO_PHONE_NUMBER・TWILIO_CALL_TO）がまだです' });
  }
  const result = await placeCall({
    to: process.env.TWILIO_CALL_TO,
    url: `${baseUrl(req)}/api/twilio/voice`,
    statusUrl: `${baseUrl(req)}/api/twilio/status`, // 出なかったらご家族に知らせる
  });
  if (!result.ok) {
    const HINTS = {
      21215: 'Twilio の「Geo permissions」で Japan が許可されていないようです',
      21408: 'Twilio の「Geo permissions」で Japan が許可されていないようです',
      21211: 'かける相手の番号（TWILIO_CALL_TO）の形がちがうようです。+81 のあとに、先頭の0を取った番号を入れてください',
      21212: 'かける元の番号（TWILIO_PHONE_NUMBER）の形がちがうようです。+1 と数字だけで入れてください',
      21210: 'かける元の番号（TWILIO_PHONE_NUMBER）が、Twilio で買った番号ではないようです',
      21219: 'お試しの状態なので、登録（Verified Caller IDs）していない番号にはかけられません',
      21205: '公開アドレス（PUBLIC_BASE_URL）の形がちがうようです',
      20003: 'Account SID か Auth Token がちがうようです',
    };
    const hint = HINTS[result.code] || '電話をかけられませんでした。Twilio の設定を確かめてください';
    // Twilio からの英語の理由もそのまま出す（設定を直す手がかりになる）
    const detail = result.message ? ` ／ ${String(result.message).slice(0, 200)}` : '';
    return send(502, { error: `${hint}（コード ${result.code || result.status}${detail}）` });
  }
  return send(200, { ok: true });
}
