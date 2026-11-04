// 電話の窓口（Twilio の Voice Webhook）
//
// Twilio が「電話がつながった」「本人が話した」たびにここを呼ぶ。
// 本人の言葉（SpeechResult）を Claude に渡し、返事を読み上げて、また聞く。を繰り返す。
// 会話の履歴は Supabase の call_sessions に置く（電話にはブラウザのような入れ物がないため）。
//
// ?purpose=callback&request=<困りごとのID> のときは、協力者が決まったことを伝える折り返しの電話になる。

import { randomUUID } from 'node:crypto';
import { runTurn, voiceMessagePlayedNote, voiceMessageStartText } from '../../lib/conversation.js';
import {
  acceptedHelperName, getCallSession, getHelpRequest, isDbConfigured, markVoicePlayed, nextVoiceMessage, saveCallSession,
} from '../../lib/db.js';
import { todayInJapan } from '../../lib/prompt.js';
import {
  allowedCaller, baseUrl, readForm, twimlSayAndHangup, twimlSayAndListen, twimlSayPlayAndListen, validTwilioSignature,
} from '../../lib/twilio.js';

const MAX_SILENT = 2; // 続けて無言だったら、やさしく切る
const MAX_MESSAGES = 80;

export default async function handler(req, res) {
  const params = readForm(req);
  if (!validTwilioSignature(req, params)) {
    res.statusCode = 403;
    return res.end();
  }
  const reply = (xml) => { res.statusCode = 200; res.setHeader('Content-Type', 'text/xml; charset=utf-8'); res.end(xml); };

  if (!isDbConfigured()) {
    return reply(twimlSayAndHangup('すみません、ただいま準備中です。失礼します。'));
  }

  // かかってきた電話は、登録した番号からだけ受ける（知らない人からの電話で料金を使わないため）
  if (params.Direction === 'inbound' && !allowedCaller(params.From)) {
    return reply(twimlSayAndHangup('この電話番号は、まだ登録されていません。失礼します。'));
  }

  const url = new URL(req.url, 'http://x');
  const purpose = url.searchParams.get('purpose') === 'callback' ? 'callback' : 'morning';
  const actionUrl = baseUrl(req) + url.pathname + url.search; // 次も同じ窓口に来てもらう

  const callSid = params.CallSid;
  const speech = String(params.SpeechResult || '').trim().slice(0, 500);
  let session = await getCallSession(callSid);

  try {
    if (!session) {
      // 電話がつながった：AI からあいさつする
      session = { callSid, callId: randomUUID(), callDate: todayInJapan(), purpose, messages: [], silent: 0 };
      // 毎朝の電話で、ご家族の声の伝言が届いていれば、あいさつのあとに流す
      const voice = purpose === 'morning' ? await nextVoiceMessage() : null;
      const startText = purpose === 'callback' ? await callbackStartText(url.searchParams.get('request'))
        : voice ? voiceMessageStartText(voice.fromName) : undefined;
      const result = await runTurn({ history: [], text: '', callDate: session.callDate, callId: session.callId, startText });
      if (voice && !result.ended) {
        await saveCallSession({ ...session, messages: [...result.messages, voiceMessagePlayedNote(voice.fromName)] });
        await markVoicePlayed(voice.id);
        return reply(twimlSayPlayAndListen(result.reply, voice.url, actionUrl));
      }
      await saveCallSession({ ...session, messages: result.messages });
      return reply(result.ended ? twimlSayAndHangup(result.reply) : twimlSayAndListen(result.reply, actionUrl));
    }

    session = { callSid, callId: session.call_id, callDate: session.call_date, purpose: session.purpose, messages: session.messages || [], silent: session.silent || 0 };

    if (!speech) {
      // 声が聞こえなかった
      session.silent += 1;
      await saveCallSession(session);
      if (session.silent >= MAX_SILENT) {
        return reply(twimlSayAndHangup('お声が聞こえないようなので、いったん失礼しますね。また明日の朝、お電話しますね。'));
      }
      return reply(twimlSayAndListen('すみません、もう一度お願いできますか。', actionUrl));
    }

    if (session.messages.length > MAX_MESSAGES) {
      return reply(twimlSayAndHangup('長くお話しいただき、ありがとうございました。また明日の朝、お電話しますね。失礼します。'));
    }

    const result = await runTurn({ history: session.messages, text: speech, callDate: session.callDate, callId: session.callId });
    await saveCallSession({ ...session, messages: result.messages, silent: 0 });
    return reply(result.ended ? twimlSayAndHangup(result.reply) : twimlSayAndListen(result.reply, actionUrl));
  } catch (e) {
    console.error('[twilio-voice] エラー', e?.status || '', e?.message || e);
    return reply(twimlSayAndHangup('すみません、うまくつながりませんでした。またあとでお電話しますね。'));
  }
}

// 折り返しの電話で、AI に最初に渡す合図
async function callbackStartText(requestId) {
  const request = requestId ? await getHelpRequest(requestId) : null;
  const helper = requestId ? await acceptedHelperName(requestId) : null;
  if (!request || !helper) {
    return '（ゆげ丸からの電話です。あいさつから始めてください。）';
  }
  return `（ゆげ丸からの折り返しの電話です。最初に名乗ってから、次のことを短く伝えてください：「${request.when_text || '日時はご相談'}の${request.category}を、ご近所の${helper}が引き受けてくださいました」。相手の返事を受けたら、お別れのあいさつをして end_call を呼んでください。体調の確認や、ほかの困りごとの聞き取りはしなくてかまいません。）`;
}
