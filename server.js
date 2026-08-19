import express from "express";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const app = express();
app.use(express.json({ limit: "5mb" }));

const PORT = process.env.PORT || 3000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || "";

function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  const header = req.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token !== AUTH_TOKEN) { res.status(401).json({ error: "Unauthorized" }); return false; }
  return true;
}

async function download(url, filePath) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Не удалось скачать ${url}: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(filePath, buf);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const proc = spawn("ffmpeg", args);
    let stderr = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => code === 0 ? resolve() : reject(new Error("ffmpeg failed: " + stderr.slice(-2000))));
  });
}

app.get("/", (_req, res) => res.json({ ok: true, service: "ffmpeg-tiktok" }));
app.get("/health", (_req, res) => res.json({ ok: true }));

app.post("/render", async (req, res) => {
  if (!checkAuth(req, res)) return;
  const { image_url, music_url, width = 1080, height = 1920 } = req.body || {};
  if (!image_url || !music_url) return res.status(400).json({ error: "image_url и music_url обязательны" });

  const dir = await mkdtemp(join(tmpdir(), "render-"));
  const imgPath = join(dir, "image.png");
  const musicPath = join(dir, "audio.mp3");
  const outPath = join(dir, `${randomUUID()}.mp4`);

  try {
    await Promise.all([download(image_url, imgPath), download(music_url, musicPath)]);
    const args = [
      "-y", "-loop", "1", "-i", imgPath, "-i", musicPath,
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},format=yuv420p`,
      "-c:v", "libx264", "-preset", "veryfast", "-tune", "stillimage", "-r", "30",
      "-c:a", "aac", "-b:a", "192k", "-shortest", "-movflags", "+faststart", outPath,
    ];
    await runFfmpeg(args);
    const video = await readFile(outPath);
    res.setHeader("Content-Type", "video/mp4");
    res.setHeader("Content-Disposition", 'attachment; filename="video.mp4"');
    res.send(video);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err.message || err) });
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

app.listen(PORT, () => console.log(`FFmpeg service listening on ${PORT}`));
