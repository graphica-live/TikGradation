const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const ffprobe = require('ffprobe-static');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const ffprobePath = ffprobe.path;

if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR);

const upload = multer({
  dest: TEMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype === 'video/mp4' || file.originalname.endsWith('.mp4')) {
      cb(null, true);
    } else {
      cb(new Error('MP4ファイルのみ対応しています'));
    }
  },
});

app.use(express.static(path.join(__dirname, 'public')));

// ─── レート制限 (1時間に2本) ───────────────────────────────────────────────
const rateLimitMap = new Map(); // ip -> [timestamp, ...]
const RATE_LIMIT_MAX = 2;
const RATE_LIMIT_WINDOW_MS = 60 * 60 * 1000; // 1時間

function checkRateLimit(ip) {
  const now = Date.now();
  const timestamps = (rateLimitMap.get(ip) || []).filter(t => now - t < RATE_LIMIT_WINDOW_MS);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    const retryAt = new Date(timestamps[0] + RATE_LIMIT_WINDOW_MS);
    const hh = retryAt.getHours().toString().padStart(2, '0');
    const mm = retryAt.getMinutes().toString().padStart(2, '0');
    return { limited: true, retryTime: `${hh}時${mm}分` };
  }
  timestamps.push(now);
  rateLimitMap.set(ip, timestamps);
  return { limited: false };
}
// ──────────────────────────────────────────────────────────────────────────────

function getVideoInfo(inputPath) {
  return new Promise((resolve, reject) => {
    const ffprobeProcess = spawn(ffprobePath, [
      '-v', 'quiet',
      '-print_format', 'json',
      '-show_format',
      '-show_streams',
      inputPath,
    ]);
    let stdout = '';
    ffprobeProcess.stdout.on('data', d => { stdout += d; });
    ffprobeProcess.on('close', code => {
      if (code !== 0) return reject(new Error('ffprobe failed'));
      try {
        const info = JSON.parse(stdout);
        resolve({
          duration: parseFloat(info.format.duration),
          hasAudio: info.streams.some(s => s.codec_type === 'audio'),
        });
      } catch (e) { reject(e); }
    });
    ffprobeProcess.on('error', reject);
  });
}

/**
 * POST /convert
 * Body (multipart/form-data):
 *   video      — MP4 file (required)
 *   topPercent — 0–100, gradient fade height (default: 30)
 *   fadeIn     — seconds, alpha fade-in at start (default: 0.5)
 *   fadeOut    — seconds, alpha fade-out at end (default: 0.5)
 */
app.post('/convert', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'videoファイルが必要です' });
  }

  const inputPath = req.file.path;

  // レート制限チェック
  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const rl = checkRateLimit(ip);
  if (rl.limited) {
    fs.unlink(inputPath, () => {});
    return res.status(429).json({ error: `処理制限に達しました。${rl.retryTime}以降に再実行してください。` });
  }

  const outputName = `${uuidv4()}.webm`;
  const outputPath = path.join(TEMP_DIR, outputName);

  const topPercent = Math.min(100, Math.max(0, parseFloat(req.body.topPercent ?? 30)));
  const fadeIn  = Math.max(0, parseFloat(req.body.fadeIn  ?? 0.5));
  const fadeOut = Math.max(0, parseFloat(req.body.fadeOut ?? 0.5));
  const ratio = topPercent / 100;

  try {
    const { duration, hasAudio } = await getVideoInfo(inputPath);

    // 30秒制限チェック
    if (duration > 30) {
      fs.unlink(inputPath, () => {});
      return res.status(400).json({ error: '30秒以上の動画はアップロードできません。' });
    }

    // Gradient alpha: transparent at Y=0, opaque at Y=H*ratio
    const alphaExpr = ratio === 0
      ? '255'
      : `if(lt(Y,H*${ratio}),255*Y/(H*${ratio}),255)`;

    const vfFilters = [
      'format=yuva420p',
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'`,
      'format=yuva420p', // geq outputs gbrap; convert back for libvpx-vp9
    ];
    if (fadeIn  > 0) vfFilters.push(`fade=t=in:st=0:d=${fadeIn}:alpha=1`);
    if (fadeOut > 0) vfFilters.push(`fade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut}:alpha=1`);

    const ffmpegArgs = [
      '-i', inputPath,
      '-vf', vfFilters.join(','),
    ];

    if (hasAudio) {
      const afFilters = [];
      if (fadeIn  > 0) afFilters.push(`afade=t=in:st=0:d=${fadeIn}`);
      if (fadeOut > 0) afFilters.push(`afade=t=out:st=${Math.max(0, duration - fadeOut).toFixed(3)}:d=${fadeOut}`);
      if (afFilters.length > 0) ffmpegArgs.push('-af', afFilters.join(','));
      ffmpegArgs.push('-c:a', 'libopus', '-b:a', '128k');
    } else {
      ffmpegArgs.push('-an');
    }

    ffmpegArgs.push(
      '-c:v', 'libvpx-vp9',
      '-auto-alt-ref', '0', // required for VP9 alpha
      '-b:v', '0',
      '-crf', '30',
      '-y',
      outputPath,
    );

    console.log(`[convert] top=${topPercent}% fadeIn=${fadeIn}s fadeOut=${fadeOut}s duration=${duration.toFixed(2)}s audio=${hasAudio}`);

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    let stderr = '';
    ffmpeg.stderr.on('data', d => { stderr += d.toString(); });

    ffmpeg.on('close', code => {
      fs.unlink(inputPath, () => {});
      if (code !== 0) {
        fs.unlink(outputPath, () => {});
        console.error('[ffmpeg error]', stderr);
        return res.status(500).json({ error: 'FFmpeg処理に失敗しました', detail: stderr.slice(-500) });
      }
      const stat = fs.statSync(outputPath);
      res.setHeader('Content-Type', 'video/webm');
      res.setHeader('Content-Disposition', 'attachment; filename="output.webm"');
      res.setHeader('Content-Length', stat.size);
      const stream = fs.createReadStream(outputPath);
      stream.pipe(res);
      stream.on('close', () => fs.unlink(outputPath, () => {}));
    });

    ffmpeg.on('error', err => {
      fs.unlink(inputPath, () => {});
      console.error('[ffmpeg spawn error]', err);
      res.status(500).json({ error: 'FFmpegの起動に失敗しました。' });
    });

  } catch (err) {
    fs.unlink(inputPath, () => {});
    console.error('[error]', err);
    res.status(500).json({ error: err.message });
  }
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`TikGradation server running at http://localhost:${PORT}`);
});
