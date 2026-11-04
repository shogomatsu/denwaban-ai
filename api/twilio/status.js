// 通話が終わったときの知らせ（Twilio の StatusCallback）
// 毎朝の電話に出なかった（出ない・話し中・つながらない）ときに、ご家族に LINE で知らせる
// 会話設計「4. 家族へのLINE通知」の「電話に出ない」。再発信はまだしない（構想）

import { sendFamilyLine } from '../../lib/line.js';
import { getProfile } from '../../lib/profile.js';
import { readForm, validTwilioSignature } from '../../lib/twilio.js';

const NOT_ANSWERED = ['no-answer', 'busy', 'failed'];

export default async function handler(req, res) {
  const params = readForm(req);
  if (!validTwilioSignature(req, params)) {
    res.statusCode = 403;
    return res.end();
  }
  if (NOT_ANSWERED.includes(params.CallStatus)) {
    const profile = getProfile();
    const time = new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', hour: 'numeric', minute: '2-digit' }).format(new Date());
    const result = await sendFamilyLine(`【電話番AI】${profile.userName}が今朝の電話に出られませんでした（${time}）。念のためご確認ください。`);
    console.log('[twilio-status]', params.CallStatus, result.sent ? 'family_notified' : `not_sent_${result.reason}`);
  }
  res.statusCode = 200;
  res.end();
}
