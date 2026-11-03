// 会話に差し込む「人物の設定」をまとめた場所です。
//
// ここに書いてあるのは架空のデモ用の値です。
// 実際のご家族の名前などは、このファイルを書きかえずに、
// Vercel の「Environment Variables」（手元なら .env）に入れてください。
// 環境変数が入っていれば、そちらが優先されます。
// （本物の個人情報をリポジトリに入れないためです。CLAUDE.md の方針）

const DEMO_PROFILE = {
  aiName: 'ゆげ丸', // AI の名前（名乗りは「AIのゆげ丸です」）
  userName: 'ハナコさん', // お電話する相手の呼び名
  familyName: '娘のミキさん', // 通知を受け取るご家族の呼び名
  area: '国見町', // 住んでいる地区（協力者を探すときに使う。住所は入れない）
  notes: '', // 前回までのメモ（なければ空）
  weather: '', // 雲仙市の天気（なければ空。知らない天気は作らせない）
};

export function getProfile() {
  const env = process.env;
  return {
    aiName: env.AI_NAME || DEMO_PROFILE.aiName,
    userName: env.USER_NAME || DEMO_PROFILE.userName,
    familyName: env.FAMILY_NAME || DEMO_PROFILE.familyName,
    area: env.USER_AREA || DEMO_PROFILE.area,
    notes: env.USER_NOTES || DEMO_PROFILE.notes,
    weather: env.WEATHER || DEMO_PROFILE.weather,
  };
}
