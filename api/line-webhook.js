// LINE の受け口（Webhook）
//
// LINE Developers の「Messaging API設定」→「Webhook URL」に
//   https://（Vercelのアドレス）/api/line-webhook
// を入れて、「Webhookの利用」をオンにする。
//
// - 協力者が「引き受ける」「今回は難しい」を押したときの処理
// - 友だち追加されたときに、その人のユーザーIDをログに出す（協力者やご家族の登録に使う）
//
// 必要な環境変数：LINE_CHANNEL_SECRET（届いた知らせが本当に LINE からかを確かめる）、LINE_CHANNEL_ACCESS_TOKEN

import { createHmac, timingSafeEqual } from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { coordinate } from '../lib/coordinator.js';
import {
  addThanksPoint, getHelpRequest, getHelper, getOffer, setHelpRequestStatusIfSearching, setOfferStatus,
} from '../lib/db.js';
import { replyTo, sendFamilyLine, text } from '../lib/line.js';
import { getProfile } from '../lib/profile.js';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.statusCode = 200;
    return res.end('ok'); // LINE の「検証」ボタンやブラウザで開いたとき
  }

  const secret = process.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    console.error('[line-webhook] LINE_CHANNEL_SECRET が設定されていません');
    res.statusCode = 500;
    return res.end();
  }

  const raw = await readRawBody(req);
  if (!validSignature(raw, req.headers['x-line-signature'], secret)) {
    res.statusCode = 401;
    return res.end();
  }

  let events = [];
  try {
    events = JSON.parse(raw).events || [];
  } catch {
    res.statusCode = 400;
    return res.end();
  }

  for (const event of events) {
    try {
      await handleEvent(event);
    } catch (e) {
      console.error('[line-webhook] 処理エラー', e);
    }
  }
  res.statusCode = 200;
  res.end('ok');
}

async function handleEvent(event) {
  if (event.type === 'follow') {
    // 協力者やご家族を登録するために、ユーザーIDを Vercel のログに出す（ここだけは名前ではなくIDなので出してよい）
    console.log('[line-webhook] 友だち追加 userId =', event.source?.userId);
    await replyTo(event.replyToken, [text('友だち追加ありがとうございます。電話番AIからのお知らせやお手伝いのお願いを、ここにお送りします。')]);
    return;
  }
  if (event.type !== 'postback') return;

  const params = new URLSearchParams(event.postback?.data || '');
  const offerId = params.get('offer');
  const action = params.get('a');
  const offer = offerId ? await getOffer(offerId) : null;
  if (!offer) return;

  // 押した人が、声をかけた本人かを確かめる
  const helper = await getHelper(offer.helper_id);
  if (!helper || helper.line_user_id !== event.source?.userId) return;

  if (offer.status !== 'asked') {
    await replyTo(event.replyToken, [text('このお願いには、すでにお返事をいただいています。ありがとうございました。')]);
    return;
  }

  if (action === 'decline') {
    await setOfferStatus(offer.id, 'declined');
    await replyTo(event.replyToken, [text('承知しました。お返事ありがとうございます。またの機会によろしくお願いします。')]);
    // ほかの方に声をかける（返事は待たずに、裏で進める）
    waitUntil(coordinate(offer.help_request_id).catch((e) => console.error('[line-webhook] 次の方への声かけに失敗', e)));
    return;
  }

  if (action !== 'accept') return;

  // 早い者勝ち：まだ「探している」ときだけ確定する
  const won = await setHelpRequestStatusIfSearching(offer.help_request_id, 'matched');
  if (!won) {
    await setOfferStatus(offer.id, 'closed');
    await replyTo(event.replyToken, [text('ありがとうございます。今回は、ほかの方が引き受けてくださいました。またの機会によろしくお願いします。')]);
    return;
  }
  await setOfferStatus(offer.id, 'accepted');
  await addThanksPoint(helper.id);

  const request = await getHelpRequest(offer.help_request_id);
  const profile = getProfile();
  // 引き受けた1人にだけ、ご本人の連絡先を伝える
  await replyTo(event.replyToken, [text([
    'ありがとうございます！とても助かります。',
    '',
    `ご本人：${profile.userName}（${request.area || profile.area}）`,
    `ご自宅：${profile.address}`,
    `お電話：${profile.phone}`,
    `日時：${request.when_text || '（ご本人と相談）'}`,
    `内容：${request.category}・${request.detail}${request.where_text ? `（行き先：${request.where_text}）` : ''}`,
    '',
    'ご本人には、ゆげ丸からお伝えします。ありがとうポイントを1つお付けしました。',
  ].join('\n'))]);

  // ご家族に報告
  await sendFamilyLine(`【電話番AI】${profile.userName}の「${request.category}（${request.when_text || '日時はご本人と相談'}）」を、ご近所の協力者の${helper.display_name}が引き受けてくださいました。`);
  console.log('[line-webhook] matched');
}

// 署名の確認には「届いたままの文字」が要る。req.body に触ると Vercel が先に読んでしまうので、
// まず生のデータを直接読む（dev-server.js からは rawBody で渡される）
async function readRawBody(req) {
  if (typeof req.rawBody === 'string') return req.rawBody;
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  if (chunks.length) return Buffer.concat(chunks).toString('utf8');
  // 念のため：すでに読まれていた場合（LINE は空白なしの JSON を送るので、そのまま戻せば一致する）
  return req.body && typeof req.body === 'object' ? JSON.stringify(req.body) : String(req.body || '');
}

function validSignature(raw, signature, secret) {
  if (!signature) return false;
  const expected = createHmac('sha256', secret).update(raw).digest();
  let given;
  try {
    given = Buffer.from(String(signature), 'base64');
  } catch {
    return false;
  }
  return given.length === expected.length && timingSafeEqual(given, expected);
}
