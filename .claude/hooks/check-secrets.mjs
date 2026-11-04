// Claude Code のフック：git commit の前に、秘密のキーや本物の電話番号がまざっていないかを確かめる
// （.claude/settings.json の PreToolUse から呼ばれる。見つけたら終了コード 2 でコミットを止める）
//
// 止めるもの：
//   - API キー・トークンの形（sk-ant-…、sb_secret_…、Twilio の Account SID など）
//   - .env ファイルそのもの
//   - 電話番号の形（090-1234-5678、+81… など）。ただし見本の番号は通す
import { execSync } from 'node:child_process';

let input = '';
for await (const chunk of process.stdin) input += chunk;
let command = '';
try { command = JSON.parse(input).tool_input?.command || ''; } catch { process.exit(0); }
if (!/\bgit\b[^\n]*\bcommit\b/.test(command)) process.exit(0);

const staged = execSync('git diff --cached --name-only', { encoding: 'utf8' }).split('\n').filter(Boolean);
const problems = [];
for (const f of staged) {
  if (/(^|\/)\.env(\.|$)/.test(f) && !f.endsWith('.env.example')) problems.push(`${f}：.env ファイルはコミットしない`);
}

const SAMPLES = ['+819012345678', '090-1234-5678', '000-0000-0000', '+15551234567', '+15550001111', '+819000000000'];
const RULES = [
  [/sk-ant-[A-Za-z0-9_-]{10,}/, 'Claude の API キー'],
  [/sb_secret_[A-Za-z0-9_-]{10,}/, 'Supabase の秘密のキー'],
  [/\bAC[0-9a-f]{32}\b/, 'Twilio の Account SID'],
  [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./, 'トークン（JWT）'],
  [/(?<![\d-])0\d{1,4}-\d{1,4}-\d{4}(?![\d-])/, '電話番号'],
  [/\+81\d{9,10}\b/, '電話番号'],
];
const diff = execSync('git diff --cached -U0', { encoding: 'utf8', maxBuffer: 50 * 1024 * 1024 });
let file = '';
for (const line of diff.split('\n')) {
  if (line.startsWith('+++ b/')) { file = line.slice(6); continue; }
  if (!line.startsWith('+') || line.startsWith('+++')) continue;
  const text = SAMPLES.reduce((t, s) => t.split(s).join(''), line.slice(1));
  for (const [re, label] of RULES) {
    if (re.test(text)) problems.push(`${file}：${label}らしきものがあります → ${line.slice(1).trim().slice(0, 80)}`);
  }
}

if (problems.length) {
  console.error('コミットを止めました。秘密の情報や本物の個人情報がまざっていないか確かめてください（CLAUDE.md の方針）。\n' + problems.join('\n'));
  process.exit(2);
}
