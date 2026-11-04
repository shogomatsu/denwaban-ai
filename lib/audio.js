// 音声の形式を変える（LINE のボイスメッセージ m4a → 電話で流せる mp3）
// Twilio の <Play> は m4a を流せないため。ffmpeg（ffmpeg-static）を使う。

import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import ffmpegPath from 'ffmpeg-static';

export async function toMp3(input) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'voice-'));
  const src = path.join(dir, 'in.m4a');
  const dst = path.join(dir, 'out.mp3');
  try {
    await writeFile(src, input);
    await new Promise((resolve, reject) => {
      // 電話向けに、1チャンネル・22kHz・64kbps にする（小さくて十分に聞き取れる）
      execFile(ffmpegPath, ['-y', '-loglevel', 'error', '-i', src, '-ac', '1', '-ar', '22050', '-b:a', '64k', dst],
        { timeout: 20000 }, (err, _out, stderr) => (err ? reject(new Error(stderr || err.message)) : resolve()));
    });
    return await readFile(dst);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
