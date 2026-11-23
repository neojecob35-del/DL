# Frame — Video & Audio Downloader

A small web app that downloads public video/audio links with **yt-dlp + FFmpeg**
and hands back an upload-ready MP4 (H.264/AAC, metadata stripped) or the best
audio stream. Node built-ins only — no `npm install` needed for the app itself.

This copy is prepared for **GitHub + Render**. Everything runs in one Docker
image that already contains yt-dlp and FFmpeg.

## What is inside

| File | Purpose |
| --- | --- |
| `server.js` | HTTP server, job queue, yt-dlp/FFmpeg runner |
| `index.html` | The single-page UI |
| `Dockerfile` | Node 22 + FFmpeg + latest yt-dlp |
| `render.yaml` | Render Blueprint (Docker web service) |
| `manifest.webmanifest`, `sw.js`, `icon-*.png` | Optional "install app" support |

## Deploy on Render

1. Push this folder to a new GitHub repository (see `DEPLOY.md` in the zip's
   parent folder for click-by-click steps).
2. In Render: **New → Blueprint**, pick the repo — `render.yaml` is detected.
3. Open the service URL. On first load the header must say
   **"yt-dlp + FFmpeg ready"**.

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `10120` | Set automatically by Render |
| `BIND` | `0.0.0.0` | Keep `0.0.0.0` on a host, `127.0.0.1` locally |
| `ALLOW_PUBLIC` | `1` in the image | Accept the public domain instead of only localhost/LAN |
| `FRAME_DOWNLOADER_DATA_DIR` | file's folder | Downloads, cookies, yt-dlp cache (`/tmp/frame-data` in Docker) |
| `YT_DLP_BIN` | `yt-dlp` | Custom yt-dlp executable path |
| `FFMPEG_LOCATION` | `ffmpeg` | Custom FFmpeg executable path |

## Run locally

```bash
node server.js            # http://127.0.0.1:10120
```

Requires yt-dlp and FFmpeg on PATH (the Windows `start.bat` from the original
app still works if you keep it next to `server.js`).

## Limits to know about

- Render **free** instances sleep after ~15 minutes idle and have ephemeral
  storage: finished downloads, saved cookies, and yt-dlp cache reset on every
  restart. The app itself keeps working; you just re-add cookies if needed.
- Free instances have 512 MB RAM. Very large 1080p merges can be slow or fail;
  try a shorter video.
- Downloads are capped at 1 GB, jobs time out after 15 minutes, and finished
  files are removed after 3 hours (same rules as the desktop version).
- Only public links are supported without cookies. Private / members-only /
  age-restricted / "confirm you're not a bot" videos need a `cookies.txt`
  exported from your own signed-in browser ("Get cookies.txt LOCALLY"
  extension) and loaded from the page's **Signed-in videos** panel.
- Anyone with the URL can start downloads on your deployment. Share it only
  with people you trust.
