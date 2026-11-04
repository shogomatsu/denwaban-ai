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
  const result = await placeCall({ to: process.env.TWILIO_CALL_TO, url: `${baseUrl(req)}/api/twilio/voice` });
  if (!result.ok) {
    const hint = result.code === 21215 || result.code === 21408
      ? 'Twilio の「Geo permissions」で Japan が許可されていないようです'
      : '電話をかけられませんでした。Twilio の設定を確かめてください';
    return send(502, { error: `${hint}（コード ${result.code || result.status}）` });
  }
  return send(200, { ok: true });
}
