'use strict';

// Local yt-dlp web app. Binds to loopback only and never reads browser cookies.
import http from 'node:http';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STATE_DIR = path.resolve(process.env.FRAME_DOWNLOADER_DATA_DIR || HERE);
const PUBLIC = path.join(HERE, 'index.html');
const DOWNLOADS = path.join(STATE_DIR, 'downloads');
const STATIC = new Map([
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json; charset=utf-8']],
  ['/sw.js', ['sw.js', 'application/javascript; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/icon-180.png', ['icon-180.png', 'image/png']],
  ['/Frame.apk', ['android/Frame.apk', 'application/vnd.android.package-archive']]
]);
const HOST = '127.0.0.1';
// 0.0.0.0 makes the app reachable from phones on the same Wi-Fi.
// Set BIND=127.0.0.1 to lock it back to this PC only.
const BIND = process.env.BIND || '0.0.0.0';
const PORT = Number(process.env.PORT || 10120);
// Hosted services are reached through their public domain, which is not a
// local/LAN name. ANY of these switches counts as a public deployment:
//   ALLOW_PUBLIC=1, RENDER / RENDER_EXTERNAL_URL / PUBLIC_ORIGIN present,
//   a known hosting domain in the Host header, or a reverse-proxy header.
// Origin and Sec-Fetch-Site checks still run, so other websites cannot drive
// this API from a visitor's browser.
const PUBLIC_MODE = process.env.ALLOW_PUBLIC === '1' || process.env.ALLOW_PUBLIC === 'true' ||
  Boolean(process.env.RENDER) || Boolean(process.env.RENDER_EXTERNAL_URL) || Boolean(process.env.PUBLIC_ORIGIN);
const HOSTED_DOMAINS = ['onrender.com', 'render.com', 'railway.app', 'up.railway.app', 'fly.dev', 'koyeb.app', 'adaptable.app'];
function hostedHostname(hostname) {
  return HOSTED_DOMAINS.some(domain => hostname === domain || hostname.endsWith(`.${domain}`));
}
function behindProxy(req) {
  return Boolean(req.headers['x-forwarded-host'] || req.headers['x-forwarded-proto'] ||
    req.headers['cf-connecting-ip'] || req.headers['x-real-ip']);
}
const CERTS = path.join(HERE, 'certs');
const PFX_FILE = path.join(CERTS, 'server.pfx');
const PFX_PASS_FILE = path.join(CERTS, 'pfx-pass.txt');
const SETUP_PORT = Number(process.env.SETUP_PORT || 10121);
const HTTPS_ENABLED = process.env.HTTPS === '1' && fs.existsSync(PFX_FILE) && fs.existsSync(PFX_PASS_FILE);
const COOKIE_FILE = path.join(STATE_DIR, 'cookies.txt');
const AUDIO_FORMATS = new Set(['best', 'mp3', 'm4a']);
const FILE_TYPES = {
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.opus': 'audio/ogg',
  '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.flac': 'audio/flac', '.wav': 'audio/wav'
};
const MAX_COOKIE_BYTES = 512 * 1024;
const MAX_REQUEST_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 1024 ** 3;
const JOB_TIMEOUT_MS = 15 * 60 * 1000;
const PROCESS_TIMEOUT_MS = 20 * 60 * 1000;
const JOB_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_ACTIVE_JOBS = 2;
const MEDIA_EXTS = new Set([
  '.mp4', '.webm', '.mkv', '.mov', '.m4v',
  '.m4a', '.mp3', '.aac', '.opus', '.ogg', '.oga', '.flac', '.wav'
]);
const JOBS = new Map();
fs.mkdirSync(DOWNLOADS, { recursive: true });

// yt-dlp is a PyInstaller bundle that unpacks itself into %TEMP% on every run.
// On machines with a nearly full system drive that extraction fails with
// "Failed to extract ... return code -1", so give it a temp folder next to the
// app (same drive as the downloads) and clear leftovers from earlier runs.
const TMP_DIR = path.join(STATE_DIR, '.tmp');
const YTDLP_TMP = path.join(TMP_DIR, 'yt-dlp');
const YTDLP_CACHE = path.join(STATE_DIR, '.cache', 'yt-dlp');
fs.mkdirSync(YTDLP_TMP, { recursive: true });
fs.mkdirSync(YTDLP_CACHE, { recursive: true });
try {
  const cutoff = Date.now() - 6 * 60 * 60 * 1000;
  for (const name of fs.readdirSync(YTDLP_TMP)) {
    if (!name.startsWith('_MEI')) continue;
    const dir = path.join(YTDLP_TMP, name);
    try { if (fs.statSync(dir).mtimeMs < cutoff) fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
} catch {}
function mediaEnv() { return { ...process.env, TEMP: YTDLP_TMP, TMP: YTDLP_TMP, TMPDIR: YTDLP_TMP }; }

const PRIVATE_V4 = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24],
  ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function sendJson(res, code, data) {
  const body = Buffer.from(JSON.stringify(data));
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(body);
}
function ipv4Num(ip) { return ip.split('.').reduce((n, part) => (n << 8n) | BigInt(Number(part)), 0n); }
function inRange(ip, network, prefix) { return (ipv4Num(ip) >> BigInt(32 - prefix)) === (ipv4Num(network) >> BigInt(32 - prefix)); }
function publicV4(ip) { return net.isIPv4(ip) && !PRIVATE_V4.some(([network, prefix]) => inRange(ip, network, prefix)); }

async function validateVideoUrl(raw) {
  let u;
  const input = String(raw || '').trim().replace(/^[\"'“”‘’]+|[\"'“”‘’]+$/g, '').trim();
  try { u = new URL(input); } catch { throw new Error('Enter a valid video URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http:// and https:// links are supported.');
  if (u.username || u.password) throw new Error('URLs with embedded usernames or passwords are not accepted.');
  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  u.hash = '';
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error('Local and private-network URLs are not accepted.');
  }
  if (net.isIPv6(host)) throw new Error('IPv6-only links are not supported by this local app.');
  if (net.isIPv4(host)) {
    if (!publicV4(host)) throw new Error('Private or reserved network addresses are not accepted.');
    return u;
  }
  let records;
  try { records = await dns.lookup(host, { all: true, verbatim: true }); }
  catch { throw new Error('Could not resolve this host. Check the URL and your connection.'); }
  const v4 = records.filter(x => x.family === 4);
  if (!v4.length) throw new Error('This host has no supported public IPv4 address.');
  if (v4.some(x => !publicV4(x.address))) throw new Error('The host resolves to a private or reserved network address.');
  return u;
}

function runVersion(command, args = ['--version'], timeoutMs = 8000) {
  return new Promise(resolve => {
    let child, done = false, text = '';
    const finish = result => { if (done) return; done = true; clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => { try { child?.kill(); } catch {} finish({ ok: false, version: '', error: 'Timed out' }); }, timeoutMs);
    try {
      child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: mediaEnv() });
      child.stdout.on('data', b => { text = (text + b.toString()).slice(0, 500); });
      child.stderr.on('data', b => { text = (text + b.toString()).slice(0, 500); });
      child.on('error', e => finish({ ok: false, version: '', error: e.code === 'ENOENT' ? 'Not found on PATH' : e.message }));
      child.on('close', code => finish({ ok: code === 0, version: text.trim().split(/\r?\n/)[0] || '', error: code === 0 ? '' : `Exit ${code}` }));
    } catch (e) { finish({ ok: false, version: '', error: e.message }); }
  });
}

let toolsPromise = null;
let toolsCache = null;
let toolsCachedAt = 0;
async function checkTools() {
  const now = Date.now();
  const ready = toolsCache && toolsCache.ytDlp && toolsCache.ffmpeg;
  if (toolsCache && (ready || now - toolsCachedAt < 30 * 1000)) return toolsCache;
  if (!toolsPromise) {
    toolsPromise = (async () => {
      // yt-dlp can take a while to start on Windows (PyInstaller + antivirus),
      // so allow much longer than the generic probe.
      const yt = await runVersion(process.env.YT_DLP_BIN || 'yt-dlp', ['--version'], 45000);
      let ffmpegBin = process.env.FFMPEG_LOCATION || '';
      if (ffmpegBin) {
        const explicit = await runVersion(ffmpegBin, ['-version']);
        if (!explicit.ok) ffmpegBin = '';
      }
      if (!ffmpegBin && process.platform === 'win32' && fs.existsSync('C:/ffmpeg/ffmpeg.exe')) {
        const configured = await runVersion('C:/ffmpeg/ffmpeg.exe', ['-version']);
        if (configured.ok) ffmpegBin = 'C:/ffmpeg/ffmpeg.exe';
      }
      const ff = ffmpegBin ? await runVersion(ffmpegBin, ['-version']) : await runVersion('ffmpeg', ['-version']);
      if (ff.ok && !ffmpegBin) ffmpegBin = 'ffmpeg';
      return { ytDlp: yt.ok, ytDlpVersion: yt.version, ytDlpError: yt.error, ffmpeg: ff.ok, ffmpegVersion: ff.version, ffmpegBin, ffmpegError: ff.error };
    })().catch(error => ({ ytDlp: false, ffmpeg: false, ytDlpError: error.message, ffmpegError: error.message }))
      .then(result => { toolsCache = result; toolsCachedAt = Date.now(); return result; })
      .finally(() => { toolsPromise = null; });
  }
  return toolsPromise;
}

async function readJson(req, limit = MAX_REQUEST_BYTES) {
  const chunks = []; let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > limit) throw new Error('Request is too large.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Invalid JSON request.'); }
}

// Optional, user-supplied cookies. The app never reads the browser's cookie
// store; the user pastes or loads a Netscape cookies.txt file exported from
// their own signed-in browser session.
function cookieRows(text) {
  return String(text || '').split(/\r?\n/).filter(line => line.split('\t').length >= 7);
}
function hasCookieFile() {
  try { const stat = fs.statSync(COOKIE_FILE); return stat.isFile() && stat.size > 0; } catch { return false; }
}
function cookieStatus() {
  try {
    const stat = fs.statSync(COOKIE_FILE);
    if (!stat.isFile() || stat.size === 0) return { hasCookies: false, updatedAt: 0, count: 0 };
    const text = fs.readFileSync(COOKIE_FILE, 'utf8');
    return { hasCookies: text.trim().length > 0, updatedAt: stat.mtimeMs, count: cookieRows(text).length };
  } catch { return { hasCookies: false, updatedAt: 0, count: 0 }; }
}
function normalizeCookies(input) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('Paste the contents of a cookies.txt file.');
  const text = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (Buffer.byteLength(text, 'utf8') > MAX_COOKIE_BYTES) throw new Error('That cookie file is too large. 512 KB is the maximum.');
  if (!cookieRows(text).length) {
    throw new Error('That does not look like a Netscape cookies.txt file. Export it with a “Get cookies.txt” browser extension and paste the whole file.');
  }
  return text.endsWith('\n') ? text : `${text}\n`;
}
function saveCookies(text) {
  const temp = `${COOKIE_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, text, { mode: 0o600 });
  fs.renameSync(temp, COOKIE_FILE);
  try { fs.chmodSync(COOKIE_FILE, 0o600); } catch {}
}
function removeCookies() {
  try { fs.unlinkSync(COOKIE_FILE); } catch {}
}

function privateV4(ip) {
  if (!net.isIPv4(ip)) return false;
  return ip.startsWith('127.') || ip.startsWith('10.') || ip.startsWith('192.168.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
function hostnameOf(hostHeader) {
  const raw = String(hostHeader || '').trim().toLowerCase();
  if (!raw) return '';
  if (raw.startsWith('[')) { const end = raw.indexOf(']'); return end > 2 ? raw.slice(1, end) : ''; }
  return raw.replace(/:\d+$/, '');
}
function lanUrls(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const info of list || []) {
      if (info.family === 'IPv4' && !info.internal && privateV4(info.address)) urls.push(`http://${info.address}:${port}`);
    }
  }
  return urls;
}
function requestHost(req) {
  const forwarded = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim().toLowerCase();
  return forwarded || String(req.headers.host || '').trim().toLowerCase();
}
function localRequestAllowed(req) {
  const host = requestHost(req);
  const hostname = hostnameOf(host);
  if (!hostname) return false;
  if (!PUBLIC_MODE && !hostedHostname(hostname) && !behindProxy(req)) {
    const machine = os.hostname().toLowerCase();
    const allowed = hostname === 'localhost' || hostname === '::1' || hostname === machine ||
      hostname === `${machine}.local` || privateV4(hostname);
    if (!allowed) return false;
  }
  const origin = req.headers.origin;
  if (origin) {
    try { if (new URL(origin).host.toLowerCase() !== host) return false; }
    catch { return false; }
  }
  const site = req.headers['sec-fetch-site'];
  return !site || site === 'same-origin' || site === 'none';
}

// LAN hints are only useful for a local run, never for a public deployment.
function publicUrls() {
  return PUBLIC_MODE || BIND !== '0.0.0.0' ? [] : lanUrls(PORT);
}

function normalizeAudioFormat(value) {
  const format = String(value || '').toLowerCase();
  return AUDIO_FORMATS.has(format) ? format : 'best';
}
function cleanTitle(name) {
  return String(name || 'video').replace(/[\\/\u0000-\u001f\u007f"<>:*?|]/g, '_').trim().slice(0, 180) || 'video';
}
function formatSize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return bytes < 1024 ** 2 ? `${Math.round(bytes / 1024)} KB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}
function removeJobFiles(id) {
  try {
    for (const name of fs.readdirSync(DOWNLOADS)) {
      if (name.startsWith(`${id}__`)) try { fs.unlinkSync(path.join(DOWNLOADS, name)); } catch {}
    }
  } catch {}
}
function parseOutput(job, text) {
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim(); if (!line) continue;
    if (line.includes('__FINAL_PATH__:')) {
      const candidate = line.slice(line.indexOf('__FINAL_PATH__:') + '__FINAL_PATH__:'.length).trim();
      if (candidate) job.outputPath = path.resolve(candidate);
    }
    if (line.includes('__TITLE__:')) {
      const title = line.slice(line.indexOf('__TITLE__:') + '__TITLE__:'.length).trim();
      if (title) job.title = title;
    }
    const custom = line.match(/__PROGRESS__:\s*([0-9.]+)%\s*\|\s*([^|]*)\|\s*([^|]*)/i);
    const standard = line.match(/\b([0-9.]+)%\s+of\s+.*?\bat\s+([^\s]+).*?\bETA\s+([0-9:]+)/i);
    const m = custom || standard;
    if (m) {
      job.status = 'downloading'; job.message = job.kind === 'audio' ? 'Downloading audio' : 'Downloading video';
      const pct = Number.parseFloat(m[1]); if (Number.isFinite(pct)) job.progress = Math.max(0, Math.min(100, pct));
      job.speed = m[2].trim().replace(/^NA$/i, ''); job.eta = m[3].trim().replace(/^NA$/i, '');
    }
    if (/\[ExtractAudio\]|\[Metadata\]|\[ThumbnailsConvertor\]/i.test(line)) { job.status = 'merging'; job.message = 'Preparing the audio file'; }
    else if (/\[Merger\]|Merging formats|\[VideoRemuxer\]/i.test(line)) { job.status = 'merging'; job.message = 'Merging the original streams'; }
    else if (/Extracting URL|Downloading webpage|Downloading.*API JSON|Downloading m3u8 information|Downloading MPD manifest/i.test(line) && job.status !== 'downloading') {
      job.status = 'extracting'; job.message = 'Reading video page';
    }
    if (/ERROR:/i.test(line)) job.lastError = (job.lastError + '\n' + line).slice(-2400);
  }
}
// ---------------------------------------------------------------------------
// Finalizing: merge stray streams, strip metadata, make an upload-ready MP4
// ---------------------------------------------------------------------------

function jobFiles(id) {
  let names = [];
  try { names = fs.readdirSync(DOWNLOADS); } catch { return []; }
  return names
    .filter(name => name.startsWith(`${id}__`) && MEDIA_EXTS.has(path.extname(name).toLowerCase()))
    .map(name => path.join(DOWNLOADS, name))
    .filter(file => { try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0; } catch { return false; } });
}

function removeJobFilesExcept(id, keep) {
  try {
    for (const name of fs.readdirSync(DOWNLOADS)) {
      if (!name.startsWith(`${id}__`)) continue;
      const full = path.join(DOWNLOADS, name);
      if (keep && path.resolve(full) === path.resolve(keep)) continue;
      try { fs.unlinkSync(full); } catch {}
    }
  } catch {}
}

// Runs yt-dlp, FFmpeg or a probe and always resolves. FFmpeg exits with code 1
// when it is only asked to print file information, so callers ignore the code.
function runTool(command, args, timeoutMs, job) {
  return new Promise(resolve => {
    let child = null;
    let stderr = '';
    let done = false;
    let timedOut = false;
    const finish = result => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (job && job.child === child) job.child = null;
      resolve({ timedOut, stderr, ...result });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (job) job.timeoutExpired = true;
      try { stopChild(child); } catch {}
      finish({ ok: false, code: -1, error: 'The media tool timed out.' });
    }, timeoutMs);
    try {
      child = spawn(command, args, { windowsHide: true, shell: false, stdio: ['ignore', 'ignore', 'pipe'], env: mediaEnv() });
    } catch (error) {
      finish({ ok: false, code: -1, error: error.message });
      return;
    }
    if (job) job.child = child;
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString('utf8')).slice(-200000); });
    child.on('error', error => finish({ ok: false, code: -1, error: error.message }));
    child.on('close', code => finish({ ok: code === 0, code }));
  });
}

async function probeMedia(ffmpegBin, file) {
  const result = await runTool(ffmpegBin, ['-hide_banner', '-nostdin', '-i', file], 20000);
  const text = result.stderr || '';
  const video = /Stream #0:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?: Video: ([^,\s]+)/.exec(text);
  const audio = /Stream #0:\d+(?:\[[^\]]+\])?(?:\([^)]*\))?: Audio: ([^,\s]+)/.exec(text);
  const dims = video ? /Video: [^\n]*?(\d{2,5})x(\d{2,5})/.exec(text) : null;
  return {
    video: Boolean(video),
    vcodec: video ? video[1].toLowerCase() : '',
    audio: Boolean(audio),
    acodec: audio ? audio[1].toLowerCase() : '',
    width: dims ? Number(dims[1]) : 0,
    height: dims ? Number(dims[2]) : 0
  };
}

function isH264(codec) { return /^(h264|avc1)/.test(codec || ''); }
function isAac(codec) { return /^(aac|mp4a)/.test(codec || ''); }

// Strips global metadata, chapters and encoder signatures. GPS/location,
// author, device and creation-time tags all live at this level.
function metadataArgs(hasAudio = true) {
  const args = ['-map_metadata', '-1', '-map_chapters', '-1', '-fflags', '+bitexact', '-flags:v', '+bitexact'];
  if (hasAudio) args.push('-flags:a', '+bitexact');
  return args;
}

async function finalizeAudio(job, ffmpegBin, options) {
  const entries = [];
  for (const file of jobFiles(job.id)) {
    const info = await probeMedia(ffmpegBin, file);
    if (info.audio) entries.push({ file, info });
  }
  if (!entries.length) return { ok: false, error: 'No audio file was produced.' };
  entries.sort((a, b) => {
    try { return fs.statSync(b.file).size - fs.statSync(a.file).size; } catch { return 0; }
  });
  const best = entries[0];
  if (!options.removeMetadata) return { ok: true, path: best.file };
  if (job.cancelRequested) return { ok: false, canceled: true };

  const ext = path.extname(best.file).toLowerCase() || '.m4a';
  const output = path.join(DOWNLOADS, `${job.id}__final${ext}`);
  job.message = 'Removing metadata…';
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', best.file, '-map', '0:a:0', '-c:a', 'copy'];
  args.push(...metadataArgs());
  if (ext === '.mp3') args.push('-write_id3v1', '0', '-id3v2_version', '0');
  if (ext === '.m4a' || ext === '.mp4') args.push('-movflags', '+faststart', '-write_tmcd', '0');
  args.push(output);
  const result = await runTool(ffmpegBin, args, PROCESS_TIMEOUT_MS, job);
  if (result.ok && fs.existsSync(output)) {
    removeJobFilesExcept(job.id, output);
    return { ok: true, path: output };
  }
  try { fs.unlinkSync(output); } catch {}
  // Keeping the untouched file is better than losing the download.
  return { ok: true, path: best.file, warning: 'metadata could not be removed' };
}

async function finalizeVideo(job, ffmpegBin, options) {
  const entries = [];
  for (const file of jobFiles(job.id)) {
    const info = await probeMedia(ffmpegBin, file);
    if (info.video || info.audio) entries.push({ file, info });
  }
  if (!entries.length) return { ok: false, error: 'yt-dlp finished but no media file was produced.' };

  // Pick the highest-resolution video. If yt-dlp failed to merge Instagram's
  // separate DASH streams, the audio-only file is merged back in here.
  const video = entries
    .filter(entry => entry.info.video)
    .sort((a, b) => (b.info.width * b.info.height) - (a.info.width * a.info.height))[0];
  if (!video) return { ok: false, error: 'audio-only' };
  const mergedAudio = video.info.audio;
  // Use a lone audio stream, or the audio track of another combined file, when
  // the highest-resolution video stream has no sound of its own.
  const audioOnly = entries.find(entry => !entry.info.video && entry.info.audio);
  const combinedOther = entries.find(entry => entry.file !== video.file && entry.info.audio);
  const audioSource = mergedAudio ? null : (audioOnly || combinedOther || null);
  const hasAudio = mergedAudio || Boolean(audioSource);
  const audioCodec = mergedAudio ? video.info.acodec : (audioSource ? audioSource.info.acodec : '');
  if (job.cancelRequested) return { ok: false, canceled: true };

  const uploadReady = options.uploadReady !== false;
  const outputExt = uploadReady ? 'mp4' : (isH264(video.info.vcodec) ? 'mp4' : 'mkv');
  const output = path.join(DOWNLOADS, `${job.id}__final.${outputExt}`);
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', video.file];
  let audioInput = 0;
  if (audioSource) { args.push('-i', audioSource.file); audioInput = 1; }
  args.push('-map', '0:v:0');
  if (hasAudio) args.push('-map', `${audioInput}:a:0`);
  args.push('-dn', '-sn');

  const videoCopy = !uploadReady || isH264(video.info.vcodec);
  if (videoCopy) {
    args.push('-c:v', 'copy');
  } else {
    // TikTok/YouTube can serve HEVC, VP9 or AV1. Those are not accepted by
    // every upload target, so convert once to H.264 at upload-friendly settings.
    job.message = 'Optimizing the video for upload…';
    args.push(
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
      '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-level', '4.2',
      '-vf', 'scale=1920:1920:force_original_aspect_ratio=decrease:force_divisible_by=2'
    );
  }
  if (hasAudio) {
    const audioCopy = !uploadReady || isAac(audioCodec);
    if (audioCopy) args.push('-c:a', 'copy');
    else args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }
  if (options.removeMetadata) args.push(...metadataArgs(hasAudio));
  if (outputExt === 'mp4') args.push('-movflags', '+faststart', '-write_tmcd', '0');
  args.push(output);

  job.message = options.removeMetadata ? 'Removing metadata and finalizing…' : 'Finalizing the file…';
  const result = await runTool(ffmpegBin, args, PROCESS_TIMEOUT_MS, job);
  if (result.ok && fs.existsSync(output)) {
    removeJobFilesExcept(job.id, output);
    return { ok: true, path: output };
  }
  try { fs.unlinkSync(output); } catch {}
  if (job.cancelRequested) return { ok: false, canceled: true };
  if (mergedAudio) {
    // Fall back to the already-combined file rather than failing the download.
    removeJobFilesExcept(job.id, video.file);
    return { ok: true, path: video.file, warning: 'the file was saved without cleanup' };
  }
  return { ok: false, error: `Could not merge the video and audio streams${result.stderr ? `: ${result.stderr.trim().slice(-600)}` : '.'}` };
}

function finalizeDownload(job, ffmpegBin, options) {
  return job.kind === 'audio' ? finalizeAudio(job, ffmpegBin, options) : finalizeVideo(job, ffmpegBin, options);
}

function failureMessage(job, code, detail) {
  const text = String(detail || '').trim();
  if (/login|sign in|cookies|private video|members.only|members only|not a bot|age.restricted/i.test(text)) {
    const hint = hasCookieFile()
      ? 'Saved cookies were used; they may be expired or from an account without access. Export a fresh cookies.txt and save it again.'
      : 'Open “Signed-in videos” on this page, add your own cookies.txt, then try again.';
    return `This video needs a signed-in session (private, members-only, age-restricted, or a “confirm you’re not a bot” check). ${hint}`;
  }
  if (/DRM|protected|This video is DRM protected/i.test(text)) {
    return 'This video is DRM-protected and cannot be downloaded by this app.';
  }
  if (/Requested format is not available|No video formats found/i.test(text)) {
    return job.kind === 'audio'
      ? 'No downloadable audio stream was found for this URL.'
      : 'No downloadable video format was available for this URL.';
  }
  return `yt-dlp could not download this URL${text ? `: ${text.slice(-900)}` : ` (exit ${code})`}`;
}
function launchDownload(job, url, ffmpegBin, options = {}) {
  const audio = options.mode === 'audio';
  const outputTemplate = path.join(DOWNLOADS, `${job.id}__%(title).150B.%(ext)s`);
  const args = [
    '--ignore-config', '--cache-dir', YTDLP_CACHE, '--no-playlist', '--newline', '--progress',
    '--progress-template', 'download:__PROGRESS__:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
    '--print', 'before_dl:__TITLE__:%(title)s',
    '--print', 'after_move:__FINAL_PATH__:%(filepath)s',
    '--socket-timeout', '20', '--retries', '3', '--fragment-retries', '3',
    '--concurrent-fragments', '32'
  ];
  if (audio) {
    const format = normalizeAudioFormat(options.audioFormat);
    args.push(
      '-f', 'bestaudio/best',
      '--extract-audio', '--audio-format', format, '--audio-quality', '0'
    );
    // Metadata and cover art are embedded only when the user did not ask for
    // them to be removed. The "best" path keeps the source container (often
    // Opus) untouched so the audio is never re-encoded.
    if (!options.removeMetadata) {
      args.push('--embed-metadata');
      if (format === 'mp3' || format === 'm4a') args.push('--embed-thumbnail', '--convert-thumbnails', 'jpg');
    }
  } else {
    // Prefer H.264 + AAC at up to 1080p so YouTube and Instagram download
    // without a re-encode. Instagram only publishes separate DASH streams, so
    // bestvideo+bestaudio is required; the old "best single format" path could
    // leave the audio file as the only usable result. Capping both width and
    // height keeps 1080x1920 reels at full quality (height<=1080 rejected them).
    const cap = '[width<=1920][height<=1920]';
    args.push(
      '-f', [
        `bv*${cap}[vcodec^=avc1]+ba[acodec^=mp4a]`,
        `bv*${cap}[vcodec^=h264]+ba[acodec^=mp4a]`,
        `bv*${cap}+ba`,
        `b${cap}`,
        'b'
      ].join('/'),
      '--merge-output-format', 'mp4'
    );
  }
  args.push('--max-filesize', '1G', '-o', outputTemplate);
  if (ffmpegBin) args.push('--ffmpeg-location', ffmpegBin);
  if (hasCookieFile()) args.push('--cookies', COOKIE_FILE);
  args.push(url);
  job.kind = audio ? 'audio' : 'video';
  job.status = 'extracting'; job.message = 'Starting yt-dlp'; job.startedAt = Date.now();
  const child = spawn(process.env.YT_DLP_BIN || 'yt-dlp', args, { cwd: HERE, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'], env: mediaEnv() });
  job.child = child;
  let outBuffer = '', errBuffer = '';
  const readLines = (stream, key) => stream.on('data', chunk => {
    const bufferKey = key === 'stdout' ? 'stdoutBuffer' : 'stderrBuffer';
    job[bufferKey] = (job[bufferKey] || '') + chunk.toString('utf8');
    const lines = job[bufferKey].split(/\r?\n/); job[bufferKey] = lines.pop() || '';
    for (const line of lines) { parseOutput(job, line); if (key === 'stderr') errBuffer = (errBuffer + '\n' + line).slice(-3000); else outBuffer = (outBuffer + '\n' + line).slice(-1500); }
  });
  readLines(child.stdout, 'stdout'); readLines(child.stderr, 'stderr');
  const timeout = setTimeout(() => { job.timeoutExpired = true; stopChild(child); }, JOB_TIMEOUT_MS);
  child.on('error', error => {
    clearTimeout(timeout); job.child = null; job.finishedAt = Date.now();
    job.status = 'error'; job.error = error.code === 'ENOENT' ? 'yt-dlp was not found. Install yt-dlp, add it to PATH, and restart this app.' : error.message;
  });
  child.on('close', code => void (async () => {
    clearTimeout(timeout); job.child = null; job.finishedAt = Date.now();
    if (job.cancelRequested) { removeJobFiles(job.id); job.status = 'canceled'; job.message = 'Download canceled'; return; }
    if (job.timeoutExpired) {
      removeJobFiles(job.id); job.status = 'error';
      job.error = 'Download timed out after 15 minutes. Try again or use a shorter video.';
      return;
    }

    const files = jobFiles(job.id);
    if (!files.length) {
      job.status = 'error';
      job.error = code === 0
        ? 'yt-dlp finished but no media file was found.'
        : failureMessage(job, code, errBuffer || outBuffer);
      return;
    }

    // When yt-dlp fails to merge Instagram's DASH streams it leaves both a
    // video-only and an audio-only file. Finalizing merges them and never hands
    // the user an audio-only file for a video request.
    if (!job.title) {
      const largest = files.slice().sort((a, b) => {
        try { return fs.statSync(b).size - fs.statSync(a).size; } catch { return 0; }
      })[0];
      job.title = path.basename(largest).replace(`${job.id}__`, '').replace(/\.[^.]+$/, '').replace(/\.f(?:dash|hls)[-_a-z0-9]*$/i, '');
    }
    job.status = 'merging'; job.message = 'Finalizing the file…';
    const finalized = await finalizeDownload(job, ffmpegBin, options);

    if (job.cancelRequested) { removeJobFiles(job.id); job.status = 'canceled'; job.message = 'Download canceled'; return; }
    if (job.timeoutExpired) {
      removeJobFiles(job.id); job.status = 'error';
      job.error = 'Processing the file took too long. Try a shorter video.';
      return;
    }
    if (!finalized.ok) {
      removeJobFiles(job.id); job.status = 'error';
      if (finalized.error === 'audio-only') {
        job.error = 'Only the audio stream was available for this link, so a video could not be saved. If this is a private or age-restricted post, add your own cookies and try again.';
      } else {
        job.error = finalized.error || failureMessage(job, code, errBuffer || outBuffer);
      }
      return;
    }

    const output = finalized.path;
    let stat; try { stat = fs.statSync(output); } catch {}
    if (!stat || stat.size > MAX_OUTPUT_BYTES) {
      removeJobFiles(job.id); job.status = 'error';
      job.error = !stat ? 'The finished file could not be found.' : 'The video exceeds the 1 GB download limit.';
      return;
    }
    job.outputPath = output;
    job.filename = `${cleanTitle(job.title || (job.kind === 'audio' ? 'audio' : 'video'))}${path.extname(output)}`;
    job.filesize = formatSize(stat.size); job.progress = 100; job.status = 'done';
    job.message = finalized.warning
      ? `Download complete — ${finalized.warning}`
      : (job.kind === 'video' && options.uploadReady !== false
        ? 'Download complete · upload-ready MP4'
        : 'Download complete');
  })().catch(error => {
    removeJobFiles(job.id);
    job.status = 'error';
    job.error = `The file could not be finalized: ${error.message}`;
  }));
}
function stopChild(child) {
  if (!child || child.killed) return;
  if (process.platform === 'win32' && child.pid) {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false, stdio: 'ignore' });
    killer.on('error', () => { try { child.kill(); } catch {} });
  } else { try { child.kill('SIGTERM'); } catch {} }
}
function publicJob(job) {
  return { id: job.id, kind: job.kind, status: job.status, progress: job.progress, speed: job.speed, eta: job.eta, message: job.message, filename: job.filename, filesize: job.filesize, error: job.error };
}
function cleanOldJobs() {
  const now = Date.now();
  for (const [id, job] of JOBS) {
    if (job.finishedAt && now - job.finishedAt > JOB_TTL_MS) { removeJobFiles(id); JOBS.delete(id); }
  }
}

async function handle(req, res) {
  const requestUrl = new URL(req.url, `http://${HOST}:${PORT}`);
  if (!localRequestAllowed(req)) return sendJson(res, 403, {
    error: 'This local downloader accepts requests only from its own page.',
    host: requestHost(req) || '(missing)',
    hint: 'Hosted deployment? Set ALLOW_PUBLIC=1 in the environment, or deploy the Dockerfile/render.yaml from this repo.'
  });

  if (req.method === 'GET' && (requestUrl.pathname === '/' || requestUrl.pathname === '/index.html')) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    fs.createReadStream(PUBLIC).pipe(res); return;
  }
  const asset = STATIC.get(requestUrl.pathname);
  if (req.method === 'GET' && asset) {
    const file = path.join(HERE, asset[0]);
    if (!fs.existsSync(file)) return sendJson(res, 404, { error: 'Not found.' });
    const stat = fs.statSync(file);
    const headers = {
      'Content-Type': asset[1], 'Content-Length': stat.size,
      'Cache-Control': requestUrl.pathname === '/sw.js' ? 'no-cache' : 'public, max-age=3600',
      'X-Content-Type-Options': 'nosniff'
    };
    if (requestUrl.pathname === '/sw.js') headers['Service-Worker-Allowed'] = '/';
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res); return;
  }
  if (req.method === 'GET' && requestUrl.pathname === '/api/health') {
    const tools = await checkTools(); return sendJson(res, 200, { ok: true, ytDlp: tools.ytDlp, ytDlpVersion: tools.ytDlpVersion, ytDlpError: tools.ytDlpError, ffmpeg: tools.ffmpeg, ffmpegVersion: tools.ffmpegVersion, ffmpegError: tools.ffmpegError, cookies: cookieStatus().hasCookies, lanUrls: publicUrls() });
  }
  if (requestUrl.pathname === '/api/cookies') {
    if (req.method === 'GET') return sendJson(res, 200, cookieStatus());
    if (req.method === 'POST') {
      const body = await readJson(req, MAX_COOKIE_BYTES + 4096);
      const text = normalizeCookies(body.text);
      saveCookies(text);
      return sendJson(res, 200, cookieStatus());
    }
    if (req.method === 'DELETE') { removeCookies(); return sendJson(res, 200, cookieStatus()); }
    return sendJson(res, 405, { error: 'Method not allowed.' });
  }
  if (req.method === 'POST' && requestUrl.pathname === '/api/jobs') {
    const body = await readJson(req); const safeUrl = await validateVideoUrl(body.url || '');
    const mode = body.mode === 'audio' ? 'audio' : 'video';
    const audioFormat = mode === 'audio' ? normalizeAudioFormat(body.audioFormat) : '';
    const tools = await checkTools();
    if (!tools.ytDlp) return sendJson(res, 503, { error: `yt-dlp is required but was not found (${tools.ytDlpError}). Install yt-dlp and restart this app.` });
    if (!tools.ffmpeg) return sendJson(res, 503, { error: `FFmpeg is required to merge separate video/audio streams (${tools.ffmpegError}). Install FFmpeg and restart this app.` });
    const running = [...JOBS.values()].filter(j => ['extracting', 'downloading', 'merging', 'queued'].includes(j.status)).length;
    if (running >= MAX_ACTIVE_JOBS) return sendJson(res, 429, { error: 'The downloader is busy. Wait for the current download to finish.' });
    // Cleaning is on by default: metadata (GPS, device, author, timestamps) is
    // removed and video is delivered as an upload-ready H.264/AAC MP4.
    const removeMetadata = body.removeMetadata !== false;
    const uploadReady = mode === 'video' && body.uploadReady !== false;
    const job = { id: crypto.randomUUID(), kind: mode, audioFormat, status: 'queued', progress: 0, speed: '', eta: '', message: 'Queued', filename: '', filesize: '', error: '', lastError: '', createdAt: Date.now(), finishedAt: 0, child: null, cancelRequested: false };
    JOBS.set(job.id, job); launchDownload(job, safeUrl.href, tools.ffmpegBin, { mode, audioFormat, removeMetadata, uploadReady });
    return sendJson(res, 202, publicJob(job));
  }
  const jobMatch = requestUrl.pathname.match(/^\/api\/jobs\/([0-9a-f-]{36})$/i);
  if (jobMatch && req.method === 'GET') {
    const job = JOBS.get(jobMatch[1]); return job ? sendJson(res, 200, publicJob(job)) : sendJson(res, 404, { error: 'Download job not found or expired.' });
  }
  if (jobMatch && req.method === 'DELETE') {
    const job = JOBS.get(jobMatch[1]);
    if (!job) return sendJson(res, 404, { error: 'Download job not found.' });
    if (!['extracting', 'downloading', 'merging', 'queued'].includes(job.status)) return sendJson(res, 409, { error: 'This download is already finished.' });
    job.cancelRequested = true; job.status = 'canceled'; job.message = 'Stopping download'; stopChild(job.child);
    return sendJson(res, 200, { ok: true });
  }
  const fileMatch = requestUrl.pathname.match(/^\/api\/file\/([0-9a-f-]{36})$/i);
  if (fileMatch && req.method === 'GET') {
    const job = JOBS.get(fileMatch[1]);
    if (!job || job.status !== 'done' || !job.outputPath || !fs.existsSync(job.outputPath)) return sendJson(res, 404, { error: 'Download file not found or expired.' });
    const stat = fs.statSync(job.outputPath); const ext = path.extname(job.outputPath).toLowerCase();
    const type = FILE_TYPES[ext] || 'application/octet-stream';
    const ascii = (job.filename || 'video').replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Content-Disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(job.filename || 'video')}`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const stream = fs.createReadStream(job.outputPath); stream.on('error', () => res.destroy()); stream.pipe(res); return;
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

function requestHandler(req, res) {
  handle(req, res).catch(error => { if (!res.headersSent) sendJson(res, 400, { error: error.message || 'Request failed.' }); else res.destroy(error); });
}

let server;
if (HTTPS_ENABLED) {
  const passphrase = fs.readFileSync(PFX_PASS_FILE, 'utf8').trim();
  server = https.createServer({ pfx: fs.readFileSync(PFX_FILE), passphrase }, requestHandler);
} else {
  server = http.createServer(requestHandler);
}

server.on('error', error => {
  if (error.code === 'EADDRINUSE') console.error(`Port ${PORT} is already in use. Stop the other local app or change PORT in server.js.`);
  else console.error(error);
  process.exitCode = 1;
});

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

function setupPage(httpsUrl) {
  const href = escapeHtml(httpsUrl);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Frame / HTTPS setup</title>
<style>
:root{color-scheme:dark;font-family:Inter,ui-sans-serif,system-ui,"Segoe UI",sans-serif}
body{margin:0;background:#101920;color:#eef2ed;padding:24px 18px 48px}
main{max-width:600px;margin:auto}h1{font-size:27px;letter-spacing:-.04em;margin:0 0 6px}
p{color:#a7b4b2;font-size:14px;line-height:1.7}
a.btn{display:inline-block;background:#d5ef73;color:#1a2415;text-decoration:none;font-weight:700;padding:13px 18px;border-radius:9px;margin:8px 0 4px}
.card{background:#18252d;border:1px solid #34444c;border-radius:14px;padding:18px;margin:18px 0}
code{background:#0b141a;padding:2px 6px;border-radius:5px;font-size:12px;word-break:break-all;color:#84d5dd}
ol{padding-left:20px;color:#c9d3ce;font-size:14px;line-height:1.8}
.note{color:#ff9a83;font-size:13px}
</style></head><body><main>
<h1>One-time HTTPS setup</h1>
<p>Install the local certificate on this phone, then open the downloader over HTTPS. This removes the browser warning and allows "Install app".</p>
<div class="card"><a class="btn" href="/frame-ca.crt" download="frame-ca.crt">Download certificate</a>
<p>File: <code>frame-ca.crt</code></p>
<p>If that file is not accepted, try the DER version: <a href="/frame-ca.cer" download="frame-ca.cer" style="color:#84d5dd">frame-ca.cer</a>.</p></div>
<div class="card"><strong>Android</strong>
<ol><li>Download the certificate above.</li>
<li>Open Settings → Security (or Biometrics and security) → More security settings → Encryption &amp; credentials → Install a certificate → <b>CA certificate</b>.</li>
<li>Choose <code>frame-ca.crt</code> from Downloads, then confirm "Install anyway".</li>
<li>Open <code>${href}</code> in Chrome.</li></ol>
<strong>iPhone / iPad</strong>
<ol><li>Download the certificate in Safari.</li>
<li>Settings → Profile Downloaded → Install.</li>
<li>Settings → General → About → Certificate Trust Settings → enable "Frame Local CA".</li>
<li>Open <code>${href}</code> in Safari.</li></ol></div>
<div class="card"><strong>After setup</strong>
<p>Open <code>${href}</code>. In Chrome, use the menu → <b>Install app</b> (or the Install app button on the page) to add it to the home screen.</p>
<p class="note">This certificate is only trusted by devices you install it on. Remove it after use if you no longer need HTTPS.</p>
<p>If you cannot install the certificate, you can still use the downloader over HTTP (shortcut only, no app install): <a href="/app" style="color:#84d5dd">continue without HTTPS</a>.</p></div>
</main></body></html>`;
}

function startSetupServer() {
  const setup = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://setup.local');
    if (url.pathname === '/frame-ca.crt' || url.pathname === '/frame-ca.cer') {
      const file = path.join(CERTS, url.pathname.endsWith('.cer') ? 'frame-ca.cer' : 'frame-ca.crt');
      if (!fs.existsSync(file)) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('Not found'); return; }
      const stat = fs.statSync(file);
      res.writeHead(200, {
        'Content-Type': 'application/x-x509-ca-cert', 'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="frame-ca.crt"', 'Cache-Control': 'no-store'
      });
      fs.createReadStream(file).pipe(res); return;
    }
    const host = String(req.headers.host || '').replace(/:\d+$/, '');
    const httpsUrl = `https://${host}:${PORT}`;
    if (url.pathname === '/app' || url.pathname.startsWith('/app/') || url.pathname.startsWith('/api/') || url.pathname === '/index.html' || STATIC.has(url.pathname)) {
      if (url.pathname === '/app' || url.pathname.startsWith('/app/')) req.url = (url.pathname.slice(4) || '/') + url.search;
      return requestHandler(req, res);
    }
    if (url.pathname !== '/' && url.pathname !== '/setup') {
      res.writeHead(302, { Location: httpsUrl + url.pathname + url.search }); res.end(); return;
    }
    const body = Buffer.from(setupPage(httpsUrl));
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    res.end(body);
  });
  setup.on('error', error => {
    if (error.code === 'EADDRINUSE') console.error(`Setup port ${SETUP_PORT} is already in use; the certificate page is unavailable.`);
    else console.error('Setup server:', error);
  });
  setup.listen(SETUP_PORT, BIND, () => {
    if (BIND !== '0.0.0.0') return;
    const urls = lanUrls(SETUP_PORT);
    if (urls.length) { console.log('Phone setup page (plain HTTP, once):'); for (const u of urls) console.log(`  ${u}`); }
  });
}

server.listen(PORT, BIND, () => {
  const scheme = HTTPS_ENABLED ? 'https' : 'http';
  if (process.env.HTTPS === '1' && !HTTPS_ENABLED) console.error('HTTPS=1 but certs are missing. Run make-cert.ps1 first; starting over HTTP.');
  console.log(`Local yt-dlp downloader: ${scheme}://${HOST}:${PORT}`);
  if (BIND === '0.0.0.0') {
    const urls = lanUrls(PORT);
    if (urls.length) {
      console.log(`Open on your phone (same Wi-Fi, ${scheme}):`);
      for (const url of urls) console.log(`  ${scheme}://${new URL(url).hostname}:${PORT}`);
    } else {
      console.log('No LAN IPv4 address found. Connect this PC to Wi-Fi/Ethernet to use it from a phone.');
    }
  } else {
    console.log(`Bound to ${BIND} only; phone access is disabled.`);
  }
  if (HTTPS_ENABLED) startSetupServer();
  console.log('Public links only; no browser-cookie or sign-in retry. Press Ctrl+C to stop.');
  if (process.platform === 'win32' && process.env.NO_BROWSER !== '1') {
    const browser = spawn(process.env.COMSPEC || 'cmd.exe', ['/c', 'start', '', `${scheme}://${HOST}:${PORT}`], { detached: true, stdio: 'ignore', windowsHide: true });
    browser.on('error', error => console.error('Could not open browser:', error.message)); browser.unref();
  }
});
setInterval(cleanOldJobs, 30 * 60 * 1000).unref();
