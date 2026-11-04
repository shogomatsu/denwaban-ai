// 調整係（Claude Sonnet 5.5）
//
// 電話係（Haiku）が受け付けた困りごとを見て、登録済みの協力者から1人を選び、理由と依頼文を書く。
// 通話のあとに動くので、速さより判断の質を優先して Sonnet を使う。
// 選んだ人に LINE で依頼を送る。合う人がいなければ、ご家族に相談の LINE を送る。

import Anthropic from '@anthropic-ai/sdk';
import { getProfile } from './profile.js';
import {
  createOffer, getHelpRequest, listHelpers, offeredHelperIds, saveAssessments, setHelpRequestStatusIfSearching,
} from './db.js';
import { helperAskMessages, pushTo, sendFamilyLine } from './line.js';

const MODEL = () => process.env.COORDINATOR_MODEL || 'claude-sonnet-5-5';

const SYSTEM = `あなたは「電話番AI」の調整係です。長崎県雲仙市の高齢の方から電話で受け付けた困りごとを、登録済みの地域の協力者につなぎます。
協力者は、社会福祉協議会などで確認済みの、ご近所のボランティアの方々です。

# やること
困りごとと協力者の一覧を見て、choose_helper ツールを1回だけ呼びます。
- 協力者の一人ひとりについて、頼めるかどうか（fit）と、その理由を短く書きます（20文字くらい。例：「木曜は空いていない」「車がなく送迎できない」「同じ地区で木曜の午前が空いている」）
- いちばん合う1人を chosen_helper_id に入れます。合う人がいなければ空文字にします
- 選んだ人に送る依頼文を message_to_helper に書きます

# 選び方
- 困りごとの種類が、その人の「できること」に入っていること
- 日時が、その人の「空いている曜日・時間」に合うこと。日時が分からないときは、合いそうな人を優先
- 送り迎えは、車がある人だけ
- 同じ地区の人を優先
- excluded に入っている人（すでに断った人）は選ばない

# 依頼文の決まり
- 丁寧語で、温かく、120文字以内。最後は「引き受けていただけますか？」で終える
- 書いてよいのは、地区・日時・行き先・手伝いの内容だけ
- ご本人の名前・住所・電話番号・体調のことは、絶対に書かない（引き受けた人にだけ、あとで別に伝えます）
- お礼として「ありがとうポイント」が付くことを一言添えてよい。お金の話はしない`;

const CHOOSE_TOOL = {
  name: 'choose_helper',
  description: '協力者ごとの判断と理由、選んだ1人、その人への依頼文を記録する。',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      assessments: {
        type: 'array',
        description: '協力者一人ひとりの判断',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            helper_id: { type: 'string' },
            fit: { type: 'boolean', description: '頼めるなら true' },
            reason: { type: 'string', description: '理由（20文字くらい）' },
          },
          required: ['helper_id', 'fit', 'reason'],
        },
      },
      chosen_helper_id: { type: 'string', description: '選んだ協力者のID。合う人がいなければ空文字' },
      message_to_helper: { type: 'string', description: '選んだ人に送る依頼文。合う人がいなければ空文字' },
    },
    required: ['assessments', 'chosen_helper_id', 'message_to_helper'],
  },
};

// 困りごと1件の段取りをする。結果を返す（画面やテストで使う）
export async function coordinate(helpRequestId) {
  const request = await getHelpRequest(helpRequestId);
  if (!request || request.status !== 'searching') return { ok: false, reason: 'not_searching' };

  const helpers = await listHelpers();
  const excluded = await offeredHelperIds(helpRequestId);
  const candidates = helpers.map((h) => ({
    helper_id: h.id, name: h.display_name, can_do: h.can_do, area: h.area, available: h.available, has_car: h.has_car,
    excluded: excluded.includes(h.id),
  }));

  const ask = {
    request: {
      category: request.category, detail: request.detail, when: request.when_text || '（未定）',
      where: request.where_text || '（未定）', area: request.area || '（未定）',
    },
    helpers: candidates,
  };

  const client = new Anthropic();
  const response = await client.beta.messages.create({
    model: MODEL(),
    max_tokens: 8000,
    system: SYSTEM,
    tools: [CHOOSE_TOOL],
    output_config: { effort: 'medium' },
    // 安全のための判定で断られたときは、Anthropic のおすすめのモデルで自動的にやり直す
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    messages: [{
      role: 'user',
      content: `次の困りごとについて、choose_helper を呼んでください。\n\n${JSON.stringify(ask, null, 2)}`,
    }],
  });

  if (response.stop_reason === 'refusal') {
    console.warn('[coordinator] refusal', response.stop_details?.category);
    return { ok: false, reason: 'refusal' };
  }
  const call = response.content.find((b) => b.type === 'tool_use' && b.name === 'choose_helper');
  if (!call) return { ok: false, reason: 'no_tool_call' };

  const input = call.input || {};
  const assessments = (Array.isArray(input.assessments) ? input.assessments : []).map((a) => ({
    helper_id: a.helper_id,
    name: helpers.find((h) => h.id === a.helper_id)?.display_name || '（不明）',
    fit: Boolean(a.fit),
    reason: String(a.reason || ''),
  }));
  await saveAssessments(helpRequestId, assessments);

  // 選ばれた人が、本当に候補の中にいて、まだ声をかけていない人かを確かめる
  const chosen = candidates.find((c) => c.helper_id === input.chosen_helper_id && !c.excluded);
  if (!chosen) {
    const found = await setHelpRequestStatusIfSearching(helpRequestId, 'not_found');
    if (found) {
      const profile = getProfile();
      await sendFamilyLine(`【電話番AI】${profile.userName}の「${request.category}（${request.when_text || '日時未定'}）」について、ご近所で引き受けられる方が見つかりませんでした。ご家族で相談していただけますか。`);
    }
    return { ok: true, chosen: null, assessments };
  }

  const reason = assessments.find((a) => a.helper_id === chosen.helper_id)?.reason || '';
  const message = String(input.message_to_helper || '').slice(0, 300);
  const offerId = await createOffer({ helpRequestId, helperId: chosen.helper_id, reason, message });
  const helper = helpers.find((h) => h.id === chosen.helper_id);
  const line = offerId ? await pushTo(helper.line_user_id, helperAskMessages(offerId, message)) : { sent: false, reason: 'no_offer' };
  console.log('[coordinator] asked', offerId ? 'offer_saved' : 'offer_not_saved', line.sent ? 'line_sent' : `line_${line.reason}`);
  return { ok: true, chosen: { helperId: chosen.helper_id, name: chosen.name, reason, message, offerId, line }, assessments };
}
