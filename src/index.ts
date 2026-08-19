import { Hono } from "hono";
import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync, writeFileSync, unlinkSync } from "fs";

const execAsync = promisify(exec);
const app = new Hono();

// Health check
app.get("/health", (c) => {
  return c.json({ status: "ok", service: "ffmpeg-processor" });
});

// Convert video format
app.post("/convert-video", async (c) => {
  try {
    const body = await c.req.json();
    const { inputBase64, inputFormat, outputFormat, bitrate = "1024k" } = body;

    if (!inputBase64 || !inputFormat || !outputFormat) {
      return c.json(
        { error: "Missing inputBase64, inputFormat, or outputFormat" },
        400
      );
    }

    const inputFile = `/tmp/input.${inputFormat}`;
    const outputFile = `/tmp/output.${outputFormat}`;

    const buffer = Buffer.from(inputBase64, "base64");
    writeFileSync(inputFile, buffer);

    await execAsync(
      `ffmpeg -i ${inputFile} -b:v ${bitrate} -y ${outputFile}`
    );

    const outputBuffer = readFileSync(outputFile);
    const outputBase64 = outputBuffer.toString("base64");

    unlinkSync(inputFile);
    unlinkSync(outputFile);

    return c.json({
      success: true,
      outputBase64,
      outputFormat,
      message: "Video converted successfully",
    });
  } catch (error) {
    console.error("Conversion error:", error);
    return c.json(
      { error: String(error), message: "Video conversion failed" },
      500
    );
  }
});

// Extract audio from video
app.post("/extract-audio", async (c) => {
  try {
    const body = await c.req.json();
    const { inputBase64, inputFormat, audioFormat = "mp3" } = body;

    if (!inputBase64 || !inputFormat) {
      return c.json(
        { error: "Missing inputBase64 or inputFormat" },
        400
      );
    }

    const inputFile = `/tmp/input.${inputFormat}`;
    const outputFile = `/tmp/output.${audioFormat}`;

    const buffer = Buffer.from(inputBase64, "base64");
    writeFileSync(inputFile, buffer);

    await execAsync(
      `ffmpeg -i ${inputFile} -q:a 0 -map a -y ${outputFile}`
    );

    const outputBuffer = readFileSync(outputFile);
    const outputBase64 = outputBuffer.toString("base64");

    unlinkSync(inputFile);
    unlinkSync(outputFile);

    return c.json({
      success: true,
      outputBase64,
      audioFormat,
      message: "Audio extracted successfully",
    });
  } catch (error) {
    console.error("Audio extraction error:", error);
    return c.json(
      { error: String(error), message: "Audio extraction failed" },
      500
    );
  }
});

// Compress video
app.post("/compress-video", async (c) => {
  try {
    const body = await c.req.json();
    const {
      inputBase64,
      inputFormat,
      outputFormat = "mp4",
      quality = 23,
    } = body;

    if (!inputBase64 || !inputFormat) {
      return c.json(
        { error: "Missing inputBase64 or inputFormat" },
        400
      );
    }

    const inputFile = `/tmp/input.${inputFormat}`;
    const outputFile = `/tmp/output.${outputFormat}`;

    const buffer = Buffer.from(inputBase64, "base64");
    writeFileSync(inputFile, buffer);

    await execAsync(
      `ffmpeg -i ${inputFile} -crf ${quality} -preset fast -y ${outputFile}`
    );

    const outputBuffer = readFileSync(outputFile);
    const outputBase64 = outputBuffer.toString("base64");

    unlinkSync(inputFile);
    unlinkSync(outputFile);

    return c.json({
      success: true,
      outputBase64,
      outputFormat,
      message: "Video compressed successfully",
    });
  } catch (error) {
    console.error("Compression error:", error);
    return c.json(
      { error: String(error), message: "Video compression failed" },
      500
    );
  }
});

// Get media info
app.post("/get-info", async (c) => {
  try {
    const body = await c.req.json();
    const { inputBase64, inputFormat } = body;

    if (!inputBase64 || !inputFormat) {
      return c.json(
        { error: "Missing inputBase64 or inputFormat" },
        400
      );
    }

    const inputFile = `/tmp/input.${inputFormat}`;
    const buffer = Buffer.from(inputBase64, "base64");
    writeFileSync(inputFile, buffer);

    const { stdout } = await execAsync(
      `ffprobe -v error -show_format -show_streams -print_json ${inputFile}`
    );

    unlinkSync(inputFile);

    return c.json({
      success: true,
      info: JSON.parse(stdout),
    });
  } catch (error) {
    console.error("Info extraction error:", error);
    return c.json(
      { error: String(error), message: "Failed to get media info" },
      500
    );
  }
});

// N8N Webhook integration
app.post("/webhook/n8n", async (c) => {
  try {
    const body = await c.req.json();
    const { action, ...params } = body;

    let result;

    switch (action) {
      case "convert":
        result = await handleConvert(params);
        break;
      case "extract-audio":
        result = await handleExtractAudio(params);
        break;
      case "compress":
        result = await handleCompress(params);
        break;
      case "get-info":
        result = await handleGetInfo(params);
        break;
      default:
        return c.json({ error: "Unknown action" }, 400);
    }

    return c.json({ success: true, ...result });
  } catch (error) {
    console.error("N8N webhook error:", error);
    return c.json(
      { success: false, error: String(error) },
      500
    );
  }
});

// Helper functions
async function handleConvert(params: any) {
  const { inputBase64, inputFormat, outputFormat, bitrate = "1024k" } = params;
  const inputFile = `/tmp/input.${inputFormat}`;
  const outputFile = `/tmp/output.${outputFormat}`;

  const buffer = Buffer.from(inputBase64, "base64");
  writeFileSync(inputFile, buffer);

  await execAsync(
    `ffmpeg -i ${inputFile} -b:v ${bitrate} -y ${outputFile}`
  );

  const outputBuffer = readFileSync(outputFile);
  const outputBase64 = outputBuffer.toString("base64");

  unlinkSync(inputFile);
  unlinkSync(outputFile);

  return { outputBase64, outputFormat };
}

async function handleExtractAudio(params: any) {
  const { inputBase64, inputFormat, audioFormat = "mp3" } = params;
  const inputFile = `/tmp/input.${inputFormat}`;
  const outputFile = `/tmp/output.${audioFormat}`;

  const buffer = Buffer.from(inputBase64, "base64");
  writeFileSync(inputFile, buffer);

  await execAsync(
    `ffmpeg -i ${inputFile} -q:a 0 -map a -y ${outputFile}`
  );

  const outputBuffer = readFileSync(outputFile);
  const outputBase64 = outputBuffer.toString("base64");

  unlinkSync(inputFile);
  unlinkSync(outputFile);

  return { outputBase64, audioFormat };
}

async function handleCompress(params: any) {
  const {
    inputBase64,
    inputFormat,
    outputFormat = "mp4",
    quality = 23,
  } = params;

  const inputFile = `/tmp/input.${inputFormat}`;
  const outputFile = `/tmp/output.${outputFormat}`;

  const buffer = Buffer.from(inputBase64, "base64");
  writeFileSync(inputFile, buffer);

  await execAsync(
    `ffmpeg -i ${inputFile} -crf ${quality} -preset fast -y ${outputFile}`
  );

  const outputBuffer = readFileSync(outputFile);
  const outputBase64 = outputBuffer.toString("base64");

  unlinkSync(inputFile);
  unlinkSync(outputFile);

  return { outputBase64, outputFormat };
}

async function handleGetInfo(params: any) {
  const { inputBase64, inputFormat } = params;
  const inputFile = `/tmp/input.${inputFormat}`;

  const buffer = Buffer.from(inputBase64, "base64");
  writeFileSync(inputFile, buffer);

  const { stdout } = await execAsync(
    `ffprobe -v error -show_format -show_streams -print_json ${inputFile}`
  );

  unlinkSync(inputFile);

  return { info: JSON.parse(stdout) };
}

const port = parseInt(process.env.PORT || "3000", 10);

export default app;
