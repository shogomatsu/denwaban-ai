// docs/conversation-design.md から、システムプロンプトとツール定義を読み込みます。
// 会話設計を書きかえれば、サーバーのコードを変えなくても AI の話し方が変わります。

import { readFileSync } from 'node:fs';
import path from 'node:path';

const DESIGN_PATH = path.join(process.cwd(), 'docs', 'conversation-design.md');

let cache = null;

function loadDesign() {
  if (cache) return cache;
  const md = readFileSync(DESIGN_PATH, 'utf8');

  // 「## システムプロンプト」より後ろにある、最初の ```text と ```json を使う
  const start = md.indexOf('## システムプロンプト');
  if (start === -1) throw new Error('conversation-design.md に「## システムプロンプト」が見つかりません');
  const rest = md.slice(start);

  const promptMatch = rest.match(/```text\n([\s\S]*?)\n```/);
  const toolsMatch = rest.match(/```json\n([\s\S]*?)\n```/);
  if (!promptMatch) throw new Error('conversation-design.md にシステムプロンプト（```text）が見つかりません');
  if (!toolsMatch) throw new Error('conversation-design.md にツール定義（```json）が見つかりません');

  cache = {
    promptTemplate: promptMatch[1],
    tools: JSON.parse(toolsMatch[1]),
  };
  return cache;
}

export function getTools() {
  return loadDesign().tools;
}

// {{ai_name}} などを、実際の値に置きかえる
export function buildSystemPrompt(profile, today) {
  const values = {
    ai_name: profile.aiName,
    user_name: profile.userName,
    family_name: profile.familyName,
    today,
    weather: profile.weather,
    notes: profile.notes,
  };
  return loadDesign().promptTemplate.replace(/\{\{(\w+)\}\}/g, (whole, key) =>
    key in values ? values[key] : whole,
  );
}

// 日本時間の「11月3日 火曜日」
export function todayInJapan(date = new Date()) {
  const fmt = (opts) => new Intl.DateTimeFormat('ja-JP', { timeZone: 'Asia/Tokyo', ...opts }).format(date);
  return `${fmt({ month: 'long', day: 'numeric' })} ${fmt({ weekday: 'long' })}`;
}
