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

const conversionJobs = new Map();
const JOB_TTL_MS = 30 * 60 * 1000;

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

function createJob() {
  const jobId = uuidv4();
  conversionJobs.set(jobId, {
    id: jobId,
    status: 'queued',
    phase: '待機中',
    progress: 0,
    error: null,
    outputPath: null,
    createdAt: Date.now(),
  });
  return jobId;
}

function getJob(jobId) {
  return conversionJobs.get(jobId);
}

function scheduleJobCleanup(jobId) {
  setTimeout(() => {
    const job = conversionJobs.get(jobId);
    if (!job) return;
    if (job.outputPath) {
      fs.unlink(job.outputPath, () => {});
    }
    conversionJobs.delete(jobId);
  }, JOB_TTL_MS);
}

function parseFfmpegProgress(chunk, duration) {
  const matches = chunk.match(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g);
  if (!matches || !duration || duration <= 0) return null;

  const latest = matches[matches.length - 1];
  const parts = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(latest);
  if (!parts) return null;

  const seconds = (parseInt(parts[1], 10) * 3600)
    + (parseInt(parts[2], 10) * 60)
    + parseFloat(parts[3]);

  return Math.max(0, Math.min(99, Math.round((seconds / duration) * 100)));
}

async function processConversion(jobId, inputPath, options) {
  const job = getJob(jobId);
  if (!job) {
    fs.unlink(inputPath, () => {});
    return;
  }

  job.status = 'analyzing';
  job.phase = '動画情報を解析中';
  job.progress = 5;

  try {
    const { duration, hasAudio } = await getVideoInfo(inputPath);

    if (duration > 30) {
      fs.unlink(inputPath, () => {});
      job.status = 'failed';
      job.phase = '失敗';
      job.progress = 0;
      job.error = '30秒以上の動画はアップロードできません。';
      scheduleJobCleanup(jobId);
      return;
    }

    const outputName = `${uuidv4()}.webm`;
    const outputPath = path.join(TEMP_DIR, outputName);
    const ratio = options.topPercent / 100;
    const alphaExpr = ratio === 0
      ? '255'
      : `if(lt(Y,H*${ratio}),255*Y/(H*${ratio}),255)`;

    const vfFilters = [
      'format=yuva420p',
      `geq=r='r(X,Y)':g='g(X,Y)':b='b(X,Y)':a='${alphaExpr}'`,
      'format=yuva420p',
    ];
    if (options.fadeIn > 0) vfFilters.push(`fade=t=in:st=0:d=${options.fadeIn}:alpha=1`);
    if (options.fadeOut > 0) vfFilters.push(`fade=t=out:st=${Math.max(0, duration - options.fadeOut).toFixed(3)}:d=${options.fadeOut}:alpha=1`);

    const ffmpegArgs = [
      '-i', inputPath,
      '-vf', vfFilters.join(','),
    ];

    if (hasAudio) {
      const afFilters = [];
      if (options.fadeIn > 0) afFilters.push(`afade=t=in:st=0:d=${options.fadeIn}`);
      if (options.fadeOut > 0) afFilters.push(`afade=t=out:st=${Math.max(0, duration - options.fadeOut).toFixed(3)}:d=${options.fadeOut}`);
      if (afFilters.length > 0) ffmpegArgs.push('-af', afFilters.join(','));
      ffmpegArgs.push('-c:a', 'libopus', '-b:a', '128k');
    } else {
      ffmpegArgs.push('-an');
    }

    ffmpegArgs.push(
      '-c:v', 'libvpx-vp9',
      '-auto-alt-ref', '0',
      '-b:v', '0',
      '-crf', '30',
      '-y',
      outputPath,
    );

    console.log(`[convert] job=${jobId} top=${options.topPercent}% fadeIn=${options.fadeIn}s fadeOut=${options.fadeOut}s duration=${duration.toFixed(2)}s audio=${hasAudio}`);

    job.status = 'processing';
    job.phase = '変換中';
    job.progress = 10;

    const ffmpeg = spawn(ffmpegPath, ffmpegArgs);
    let stderr = '';

    ffmpeg.stderr.on('data', data => {
      const chunk = data.toString();
      stderr += chunk;
      const progress = parseFfmpegProgress(chunk, duration);
      if (progress !== null) {
        job.progress = Math.max(job.progress, progress);
      }
    });

    ffmpeg.on('close', code => {
      fs.unlink(inputPath, () => {});

      if (code !== 0) {
        fs.unlink(outputPath, () => {});
        console.error('[ffmpeg error]', stderr);
        job.status = 'failed';
        job.phase = '失敗';
        job.progress = 0;
        job.error = 'FFmpeg処理に失敗しました';
        scheduleJobCleanup(jobId);
        return;
      }

      job.status = 'completed';
      job.phase = '完了';
      job.progress = 100;
      job.outputPath = outputPath;
      scheduleJobCleanup(jobId);
    });

    ffmpeg.on('error', err => {
      fs.unlink(inputPath, () => {});
      fs.unlink(outputPath, () => {});
      console.error('[ffmpeg spawn error]', err);
      job.status = 'failed';
      job.phase = '失敗';
      job.progress = 0;
      job.error = 'FFmpegの起動に失敗しました。';
      scheduleJobCleanup(jobId);
    });
  } catch (err) {
    fs.unlink(inputPath, () => {});
    console.error('[error]', err);
    job.status = 'failed';
    job.phase = '失敗';
    job.progress = 0;
    job.error = err.message;
    scheduleJobCleanup(jobId);
  }
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

  const topPercent = Math.min(100, Math.max(0, parseFloat(req.body.topPercent ?? 30)));
  const fadeIn  = Math.max(0, parseFloat(req.body.fadeIn  ?? 0.5));
  const fadeOut = Math.max(0, parseFloat(req.body.fadeOut ?? 0.5));

  const jobId = createJob();
  processConversion(jobId, inputPath, { topPercent, fadeIn, fadeOut });

  return res.json({ jobId });
});

app.get('/jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'ジョブが見つかりません。' });
  }

  return res.json({
    status: job.status,
    phase: job.phase,
    progress: job.progress,
    error: job.error,
    downloadUrl: job.status === 'completed' ? `/jobs/${job.id}/download` : null,
  });
});

app.get('/jobs/:jobId/download', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job || job.status !== 'completed' || !job.outputPath || !fs.existsSync(job.outputPath)) {
    return res.status(404).json({ error: '変換済みファイルが見つかりません。' });
  }

  const stat = fs.statSync(job.outputPath);
  res.setHeader('Content-Type', 'video/webm');
  res.setHeader('Content-Disposition', 'attachment; filename="output.webm"');
  res.setHeader('Content-Length', stat.size);

  const stream = fs.createReadStream(job.outputPath);
  stream.pipe(res);
});

app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(400).json({ error: err.message });
});

app.listen(PORT, () => {
  console.log(`TikGradation server running at http://localhost:${PORT}`);
});
