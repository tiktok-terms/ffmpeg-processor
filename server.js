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
const VERSION = "v5-animated";

// Шрифты (устанавливаются в Dockerfile: fonts-dejavu-core / fonts-dejavu-extra)
const FONT_DIR = "/usr/share/fonts/truetype/dejavu";
const FONTS = {
  serif: `${FONT_DIR}/DejaVuSerif.ttf`,
  elegant: `${FONT_DIR}/DejaVuSerif-Italic.ttf`,
  sans: `${FONT_DIR}/DejaVuSans.ttf`,
  bold: `${FONT_DIR}/DejaVuSans-Bold.ttf`,
};

// --- Простая проверка токена ---
function checkAuth(req, res) {
  if (!AUTH_TOKEN) return true;
  const header = req.get("authorization") || "";
  const token = header.replace(/^Bearer\s+/i, "").trim();
  if (token !== AUTH_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

// --- Скачать файл по URL во временный путь ---
async function download(url, filePath) {
  const resp = await fetch(url, { redirect: "follow" });
  if (!resp.ok) throw new Error(`Не удалось скачать ${url}: HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  await writeFile(filePath, buf);
}

// --- Запустить процесс, собрать stderr ---
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args);
    let stderr = "";
    let stdout = "";
    proc.stderr.on("data", (d) => (stderr += d.toString()));
    proc.stdout.on("data", (d) => (stdout += d.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${cmd} failed: ` + stderr.slice(-2000)));
    });
  });
}

// --- Длительность аудио через ffprobe ---
async function probeDuration(path) {
  try {
    const { stdout } = await run("ffprobe", [
      "-v", "error",
      "-show_entries", "format=duration",
      "-of", "default=nokey=1:noprint_wrappers=1",
      path,
    ]);
    const d = parseFloat(String(stdout).trim());
    return isFinite(d) && d > 0 ? d : null;
  } catch {
    return null;
  }
}

// --- Перенос текста по словам на строки ---
function wrapText(text, maxChars) {
  const words = String(text || "").trim().split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + " " + w).length <= maxChars) cur += " " + w;
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [""];
}

function clamp(n, min, max, dflt) {
  const v = Number(n);
  if (!isFinite(v)) return dflt;
  return Math.min(max, Math.max(min, v));
}

function safeColor(c) {
  return typeof c === "string" && /^#?[0-9a-fA-F]{6}$/.test(c.trim())
    ? (c.trim().startsWith("#") ? c.trim() : "#" + c.trim())
    : "#FFFFFF";
}

// --- Построить фильтр zoompan (эффект Кена Бёрнса) ---
function buildZoompan(anim, totalFrames, fps) {
  const type = (anim && anim.type) || "zoom_in";
  const intensity = (anim && anim.intensity) || "medium";
  const zmax = intensity === "subtle" ? 1.12 : intensity === "strong" ? 1.5 : 1.28;
  const incr = ((zmax - 1) / totalFrames).toFixed(6);
  const T = totalFrames;
  const cx = "x='iw/2-(iw/zoom/2)'";
  const cy = "y='ih/2-(ih/zoom/2)'";
  const panZ = intensity === "subtle" ? 1.1 : intensity === "strong" ? 1.35 : 1.2;
  const common = `d=${T}:s=1080x1920:fps=${fps}`;

  switch (type) {
    case "zoom_out":
      return `zoompan=z='max(${zmax}-on*${incr},1)':${cx}:${cy}:${common}`;
    case "pan_left":
      return `zoompan=z=${panZ}:x='(iw-iw/zoom)*(1-on/${T})':${cy}:${common}`;
    case "pan_right":
      return `zoompan=z=${panZ}:x='(iw-iw/zoom)*(on/${T})':${cy}:${common}`;
    case "pan_up":
      return `zoompan=z=${panZ}:${cx}:y='(ih-ih/zoom)*(1-on/${T})':${common}`;
    case "pan_down":
      return `zoompan=z=${panZ}:${cx}:y='(ih-ih/zoom)*(on/${T})':${common}`;
    case "zoom_in":
    default:
      return `zoompan=z='min(1+on*${incr},${zmax})':${cx}:${cy}:${common}`;
  }
}

app.get("/", (_req, res) => res.json({ ok: true, service: "ffmpeg-tiktok", version: VERSION }));
app.get("/health", (_req, res) => res.json({ ok: true, version: VERSION }));

// --- Основной эндпоинт рендера ---
// Принимает:
// {
//   image_url, music_url, width?, height?, max_seconds?,
//   quote_text, author,
//   animation: { type, intensity },
//   quote_style: { position, font, font_size, color, background_box, animation },
//   author_style: { position, color, font_size }
// }
app.post("/render", async (req, res) => {
  if (!checkAuth(req, res)) return;

  const b = req.body || {};
  const { image_url, music_url } = b;
  if (!image_url || !music_url) {
    return res.status(400).json({ error: "image_url и music_url обязательны" });
  }

  const width = clamp(b.width, 320, 2160, 1080);
  const height = clamp(b.height, 320, 3840, 1920);
  const maxSeconds = clamp(b.max_seconds, 5, 30, 30); // жёсткий потолок 30с
  const fps = 25;

  const quoteText = String(b.quote_text || "").trim();
  const author = String(b.author || "").trim();
  const qs = b.quote_style || {};
  const as = b.author_style || {};

  const qFont = FONTS[qs.font] || FONTS.bold;
  const qSize = clamp(qs.font_size, 40, 90, 64);
  const qColor = safeColor(qs.color);
  const qPos = ["top", "center", "bottom"].includes(qs.position) ? qs.position : "center";
  const qBox = qs.background_box !== false; // по умолчанию подложка включена
  const qFade = (qs.animation || "fade_in") !== "none";

  const aSize = clamp(as.font_size, 24, 52, 38);
  const aColor = safeColor(as.color);
  const aPos = ["below_quote", "bottom"].includes(as.position) ? as.position : "below_quote";
  const aFont = FONTS.elegant;

  const dir = await mkdtemp(join(tmpdir(), "render-"));
  const imgPath = join(dir, "image.png");
  const musicPath = join(dir, "audio.mp3");
  const quoteFile = join(dir, "quote.txt");
  const authorFile = join(dir, "author.txt");
  const outPath = join(dir, `${randomUUID()}.mp4`);

  try {
    await Promise.all([download(image_url, imgPath), download(music_url, musicPath)]);

    // Длительность = min(длина музыки, 30с)
    const audioDur = await probeDuration(musicPath);
    const dur = Math.max(5, Math.min(maxSeconds, audioDur || maxSeconds));
    const totalFrames = Math.round(dur * fps);

    // Перенос текста цитаты
    const maxChars = Math.max(12, Math.floor((width * 0.9) / (qSize * 0.5)));
    const lines = wrapText(quoteText, maxChars);
    await writeFile(quoteFile, lines.join("\n"));
    const hasAuthor = author && author.length > 0;
    if (hasAuthor) await writeFile(authorFile, "— " + author);

    // Геометрия блока цитаты
    const lineH = Math.round(qSize * 1.35);
    const quoteBlockH = lines.length * lineH;
    let quoteY;
    if (qPos === "top") quoteY = 220;
    else if (qPos === "bottom") quoteY = height - quoteBlockH - 340;
    else quoteY = Math.round((height - quoteBlockH) / 2);
    if (quoteY < 120) quoteY = 120;

    let authorY;
    if (aPos === "bottom") authorY = height - aSize - 160;
    else authorY = quoteY + quoteBlockH + 40;

    // Подложка и анимация появления
    const boxOpt = qBox ? ":box=1:boxcolor=black@0.45:boxborderw=34" : "";
    const alphaOpt = qFade ? ":alpha='if(lt(t,0.8),t/0.8,1)'" : "";
    const aAlphaOpt = qFade ? ":alpha='if(lt(t,1.2),max(0,(t-0.4)/0.8),1)'" : "";

    // Сборка видеофильтра: увеличенная база -> zoompan -> текст -> формат
    const base = `scale=1620:2880:force_original_aspect_ratio=increase,crop=1620:2880`;
    const zp = buildZoompan(b.animation, totalFrames, fps);
    const drawQuote =
      `drawtext=fontfile=${qFont}:textfile=${quoteFile}:fontcolor=${qColor}:fontsize=${qSize}` +
      `:line_spacing=14:x=(w-text_w)/2:y=${quoteY}${boxOpt}${alphaOpt}`;
    const drawAuthor = hasAuthor
      ? `,drawtext=fontfile=${aFont}:textfile=${authorFile}:fontcolor=${aColor}:fontsize=${aSize}` +
        `:x=(w-text_w)/2:y=${authorY}${aAlphaOpt}`
      : "";
    const vf = `${base},${zp},${drawQuote}${drawAuthor},format=yuv420p`;

    // Плавное затухание музыки в конце
    const afade = dur > 3 ? `afade=t=out:st=${(dur - 1).toFixed(2)}:d=1` : "anull";

    const args = [
      "-y",
      "-i", imgPath,
      "-i", musicPath,
      "-map", "0:v:0",
      "-map", "1:a:0",
      "-vf", vf,
      "-af", afade,
      "-t", String(dur),
      "-r", String(fps),
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-pix_fmt", "yuv420p",
      "-c:a", "aac",
      "-b:a", "160k",
      "-movflags", "+faststart",
      outPath,
    ];

    await run("ffmpeg", args);

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

app.listen(PORT, () => console.log(`FFmpeg service ${VERSION} listening on ${PORT}`));
