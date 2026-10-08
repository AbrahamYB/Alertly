import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import os from "os";
import crypto from "crypto";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";
import { replaceFileSync } from "./file-utils.js";

const TARGET_SIZE_BYTES = 2 * 1024 * 1024;

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { timeout: options.timeout || 60000, ...options }, (error, stdout, stderr) => {
      if (error) {
        return reject(new Error(`${command} failed: ${error.message}\n${stderr || stdout}`));
      }
      resolve({ stdout, stderr });
    });
  });
}

// Prefer an explicit or local binary before the bundled dependency and PATH.
export function getFfmpegPath() {
  if (process.env.FFMPEG_PATH && fs.existsSync(process.env.FFMPEG_PATH)) {
    return process.env.FFMPEG_PATH;
  }
  const localBin = path.join(process.cwd(), "bin", process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  if (ffmpegInstaller?.path && fs.existsSync(ffmpegInstaller.path)) {
    return ffmpegInstaller.path;
  }
  return "ffmpeg";
}

// FFprobe follows the same lookup order as FFmpeg.
export function getFfprobePath() {
  if (process.env.FFPROBE_PATH && fs.existsSync(process.env.FFPROBE_PATH)) {
    return process.env.FFPROBE_PATH;
  }
  const localBin = path.join(process.cwd(), "bin", process.platform === "win32" ? "ffprobe.exe" : "ffprobe");
  if (fs.existsSync(localBin)) {
    return localBin;
  }
  if (ffprobeInstaller?.path && fs.existsSync(ffprobeInstaller.path)) {
    return ffprobeInstaller.path;
  }
  return "ffprobe";
}

let _hasFfmpegCache = null;
export async function hasFfmpeg() {
  if (_hasFfmpegCache !== null) return _hasFfmpegCache;
  try {
    await runCommand(getFfmpegPath(), ["-version"]);
    await runCommand(getFfprobePath(), ["-version"]);
    _hasFfmpegCache = true;
  } catch {
    _hasFfmpegCache = false;
  }
  return _hasFfmpegCache;
}

export async function probeMedia(filePath) {
  const isAvailable = await hasFfmpeg();
  if (!isAvailable) {
    return { isVideo: false, isImage: false, size: fs.statSync(filePath).size };
  }

  const args = [
    "-v", "error",
    "-show_entries", "format=duration,size,bit_rate:stream=index,codec_type,codec_name,width,height,r_frame_rate",
    "-of", "json",
    filePath,
  ];

  const { stdout } = await runCommand(getFfprobePath(), args);
  const data = JSON.parse(stdout || "{}");

  const streams = data.streams || [];
  const format = data.format || {};

  const videoStream = streams.find(s => s.codec_type === "video");
  const audioStream = streams.find(s => s.codec_type === "audio");

  const isVideo = Boolean(videoStream && (format.duration || streams.length > 1 || videoStream.r_frame_rate !== "0/0"));
  const isImage = Boolean(videoStream && !format.duration && streams.length === 1);

  return {
    isVideo,
    isImage,
    width: videoStream?.width ? parseInt(videoStream.width, 10) : 0,
    height: videoStream?.height ? parseInt(videoStream.height, 10) : 0,
    duration: format.duration ? parseFloat(format.duration) : 0,
    frameRate: (() => {
      const [numerator, denominator] = String(videoStream?.r_frame_rate || "0/1").split("/").map(Number);
      return denominator > 0 ? numerator / denominator : 0;
    })(),
    size: format.size ? parseInt(format.size, 10) : (fs.existsSync(filePath) ? fs.statSync(filePath).size : 0),
    videoCodec: videoStream?.codec_name || "",
    audioCodec: audioStream?.codec_name || "",
    hasAudio: Boolean(audioStream),
  };
}

// Build up to two 4x4 contact sheets from a bounded frame sample.
export async function extractVideoContactSheets(filePath, options = {}) {
  if (!fs.existsSync(filePath) || !(await hasFfmpeg())) return [];
  const probe = await probeMedia(filePath);
  if (!probe.isVideo || !probe.duration) return [];

  const maxSheets = Math.max(1, Math.min(2, Number(options.maxSheets) || 2));
  const maxSnapshots = maxSheets * 16;
  const estimatedFrames = Math.max(1, Math.round(probe.duration * (probe.frameRate || 24)));
  const sampleCount = Math.min(maxSnapshots, Math.max(1, Math.ceil(estimatedFrames * 0.05)));
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "alertly_contact_"));

  try {
    let sceneTimes = [];
    try {
      const { stderr } = await runCommand(getFfmpegPath(), [
        "-v", "info", "-i", filePath,
        "-vf", "select=gt(scene\\,0.30),showinfo", "-an", "-f", "null",
        process.platform === "win32" ? "NUL" : "/dev/null",
      ], { timeout: 60000 });
      sceneTimes = [...String(stderr).matchAll(/pts_time:([0-9.]+)/g)]
        .map((match) => Number(match[1]))
        .filter((value) => Number.isFinite(value) && value >= 0 && value < probe.duration);
    } catch (error) {
      console.warn(`[MEDIA-COMPRESSOR] Scene detection unavailable; using timeline sampling: ${error.message}`);
    }

    // Mix scene changes with stratified random samples so the full timeline is represented.
    sceneTimes.sort(() => crypto.randomInt(0, 3) - 1);
    const selectedScenes = sceneTimes.slice(0, Math.min(sceneTimes.length, Math.floor(sampleCount / 2)));
    const timelineCount = sampleCount - selectedScenes.length;
    const timestamps = [...selectedScenes];
    for (let index = 0; index < timelineCount; index += 1) {
      const stratumStart = (probe.duration * index) / timelineCount;
      const stratumLength = probe.duration / timelineCount;
      const randomOffset = crypto.randomInt(0, 1_000_000) / 1_000_000;
      timestamps.push(Math.min(stratumStart + stratumLength * randomOffset, Math.max(0, probe.duration - 0.02)));
    }
    timestamps.sort((a, b) => a - b);

    const framePaths = [];
    for (let index = 0; index < timestamps.length; index += 1) {
      const outputPath = path.join(workDir, `frame_${String(index).padStart(3, "0")}.jpg`);
      await runCommand(getFfmpegPath(), [
        "-y", "-ss", timestamps[index].toFixed(3), "-i", filePath,
        "-frames:v", "1", "-vf", "scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2", "-q:v", "5", outputPath,
      ], { timeout: 30000 });
      if (fs.existsSync(outputPath)) framePaths.push(outputPath);
    }

    const sheets = [];
    for (let offset = 0; offset < framePaths.length; offset += 16) {
      const framesInSheet = Math.min(16, framePaths.length - offset);
      const sheetPath = path.join(workDir, `sheet_${offset / 16}.jpg`);
      await runCommand(getFfmpegPath(), [
        "-y", "-framerate", "1", "-start_number", String(offset),
        "-i", path.join(workDir, "frame_%03d.jpg"),
        "-vf", `tile=4x4:nb_frames=${framesInSheet}:padding=4:margin=4:color=black`,
        "-frames:v", "1", "-q:v", "4", sheetPath,
      ], { timeout: 30000 });
      if (fs.existsSync(sheetPath)) sheets.push(`data:image/jpeg;base64,${fs.readFileSync(sheetPath).toString("base64")}`);
    }
    return sheets;
  } catch (error) {
    console.warn(`[MEDIA-COMPRESSOR] Could not build video contact sheets: ${error.message}`);
    return [];
  } finally {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch {}
  }
}

export function calculateTargetBitrate(durationSeconds, targetSizeBytes = TARGET_SIZE_BYTES, hasAudio = true) {
  const safeDuration = Math.max(0.5, Number(durationSeconds) || 1);
  const totalTargetBits = targetSizeBytes * 8 * 0.94;
  const totalBitrateBps = Math.floor(totalTargetBits / safeDuration);
  const totalBitrateKbps = Math.floor(totalBitrateBps / 1000);

  let audioKbps = hasAudio ? 64 : 0;
  if (hasAudio && totalBitrateKbps < 250) {
    audioKbps = 48;
  }
  if (hasAudio && totalBitrateKbps < 160) {
    audioKbps = 32;
  }

  let videoKbps = Math.max(80, totalBitrateKbps - audioKbps);

  // Avoid spending excess bitrate on short 720p clips.
  videoKbps = Math.min(2600, videoKbps);

  return {
    totalBitrateKbps,
    videoBitrateKbps: videoKbps,
    audioBitrateKbps: audioKbps,
  };
}

export function get720pScaleFilter(width = 0, height = 0) {
  // x264 requires even dimensions.
  if (width > 0 && height > 0 && ((width <= 1280 && height <= 720) || (width <= 720 && height <= 1280))) {
    return "pad=ceil(iw/2)*2:ceil(ih/2)*2";
  }

  return "scale='if(gt(iw,ih),min(1280,iw),-2)':'if(gt(iw,ih),-2,min(720,ih))',pad=ceil(iw/2)*2:ceil(ih/2)*2";
}

export async function compressVideo(inputPath, outputPath, options = {}) {
  const targetSizeMB = options.targetSizeMB || 2;
  const targetBytes = targetSizeMB * 1024 * 1024;
  const probe = await probeMedia(inputPath);

  const duration = probe.duration || options.duration || 5;
  const { videoBitrateKbps, audioBitrateKbps } = calculateTargetBitrate(duration, targetBytes, probe.hasAudio);
  const scaleFilter = get720pScaleFilter(probe.width, probe.height);

  // Keep both pass logs beside the output. Some Windows sandbox and antivirus
  // setups isolate the global temp directory between FFmpeg invocations.
  const passLogDir = path.dirname(outputPath);
  const passLogPrefix = `dcomp_pass_${crypto.randomUUID()}`;

  try {
    // First pass collects bitrate statistics without producing an output file.
    const pass1Args = [
      "-y",
      "-i", inputPath,
      "-vf", scaleFilter,
      "-c:v", "libx264",
      "-preset", options.preset || "veryfast",
      "-b:v", `${videoBitrateKbps}k`,
      "-pass", "1",
      "-passlogfile", passLogPrefix,
      "-an",
      "-f", "null",
      process.platform === "win32" ? "NUL" : "/dev/null",
    ];
    await runCommand(getFfmpegPath(), pass1Args, { timeout: 90000, cwd: passLogDir });

    // The final encode moves MP4 metadata to the front for streaming.
    // Very old vendor builds of FFmpeg can report a successful first pass on
    // Windows without writing readable stats. Fall back to a one-pass ABR
    // encode in that case; the 6% size headroom still protects the target.
    const finalEncodeArgs = [
      "-y",
      "-i", inputPath,
      "-vf", scaleFilter,
      "-c:v", "libx264",
      "-preset", options.preset || "veryfast",
      "-b:v", `${videoBitrateKbps}k`,
      ...(probe.hasAudio ? ["-c:a", "aac", "-b:a", `${audioBitrateKbps}k`] : ["-an"]),
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outputPath,
    ];
    const hasPassStats = fs.readdirSync(passLogDir).some((file) => {
      if (!file.startsWith(passLogPrefix) || !file.endsWith(".log")) return false;
      try { return fs.statSync(path.join(passLogDir, file)).size > 0; } catch { return false; }
    });
    const pass2Args = hasPassStats
      ? [...finalEncodeArgs.slice(0, 11), "-pass", "2", "-passlogfile", passLogPrefix, ...finalEncodeArgs.slice(11)]
      : finalEncodeArgs;
    await runCommand(getFfmpegPath(), pass2Args, { timeout: 90000, cwd: passLogDir });

    const finalStat = fs.statSync(outputPath);
    return {
      success: true,
      originalSize: probe.size,
      compressedSize: finalStat.size,
      duration,
      videoBitrateKbps,
      width: probe.width,
      height: probe.height,
      underTarget: finalStat.size <= targetBytes,
    };
  } finally {
    try {
      const files = fs.readdirSync(passLogDir);
      const basePrefix = passLogPrefix;
      for (const file of files) {
        if (file.startsWith(basePrefix)) {
          fs.unlinkSync(path.join(passLogDir, file));
        }
      }
    } catch {}
  }
}

export async function compressImage(inputPath, outputPath, options = {}) {
  const probe = await probeMedia(inputPath);
  const scaleFilter = get720pScaleFilter(probe.width, probe.height);

  const args = [
    "-y",
    "-i", inputPath,
    "-vf", scaleFilter,
    "-q:v", String(options.quality || 3),
    outputPath,
  ];

  await runCommand(getFfmpegPath(), args, { timeout: 30000 });
  const finalStat = fs.statSync(outputPath);

  return {
    success: true,
    originalSize: probe.size,
    compressedSize: finalStat.size,
    width: probe.width,
    height: probe.height,
  };
}

export async function autoCompressFile(filePath, options = {}) {
  const isAvailable = await hasFfmpeg();
  if (!isAvailable || !fs.existsSync(filePath)) {
    return { success: false, fallback: true, path: filePath, size: fs.existsSync(filePath) ? fs.statSync(filePath).size : 0 };
  }

  const originalSize = fs.statSync(filePath).size;
  const ext = path.extname(filePath).toLowerCase();
  const dir = path.dirname(filePath);
  const baseName = path.basename(filePath, ext);

  const videoExtensions = new Set([
    ".mp4", ".webm", ".mov", ".mkv", ".avi", ".flv", ".wmv", ".3gp", ".ts", ".ogv", ".m4v", ".mpg", ".mpeg"
  ]);
  const imageExtensions = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

  let isVideo = videoExtensions.has(ext);
  let isImage = imageExtensions.has(ext);

  if (!isVideo && !isImage) {
    const probe = await probeMedia(filePath);
    if (probe.isVideo) isVideo = true;
    else if (probe.isImage) isImage = true;
    else return { success: false, ignored: true, path: filePath, size: originalSize };
  }

  const targetSizeMB = options.targetSizeMB || 2;
  const targetBytes = targetSizeMB * 1024 * 1024;

  if (isVideo) {
    const tempOutput = path.join(dir, `${baseName}_dcomp_${crypto.randomUUID()}.mp4`);
    try {
      const result = await compressVideo(filePath, tempOutput, { targetSizeMB, ...options });
      if (fs.existsSync(tempOutput) && fs.statSync(tempOutput).size > 0) {
        // Remove original and rename compressed file to standard .mp4
        fs.unlinkSync(filePath);
        const finalPath = path.join(dir, `${baseName}.mp4`);
        replaceFileSync(tempOutput, finalPath);
        const finalSize = fs.statSync(finalPath).size;

        return {
          success: true,
          type: "video",
          originalSize,
          compressedSize: finalSize,
          reductionPercent: Math.max(0, Math.round(((originalSize - finalSize) / originalSize) * 100)),
          finalPath,
          finalFilename: path.basename(finalPath),
          duration: result.duration,
          underTarget: finalSize <= targetBytes,
        };
      }
    } catch (err) {
      if (fs.existsSync(tempOutput)) try { fs.unlinkSync(tempOutput); } catch {}
      console.warn(`[MEDIA-COMPRESSOR] Video compression failed for ${filePath}: ${err.message}`);
      return { success: false, error: err.message, path: filePath, size: originalSize };
    }
  } else if (isImage) {
    const targetExt = ext === ".png" ? ".jpg" : ext;
    const tempOutput = path.join(dir, `${baseName}_dcomp_${crypto.randomUUID()}${targetExt}`);
    try {
      const result = await compressImage(filePath, tempOutput, options);
      if (fs.existsSync(tempOutput) && fs.statSync(tempOutput).size > 0) {
        fs.unlinkSync(filePath);
        const finalPath = path.join(dir, `${baseName}${targetExt}`);
        replaceFileSync(tempOutput, finalPath);
        const finalSize = fs.statSync(finalPath).size;

        return {
          success: true,
          type: "image",
          originalSize,
          compressedSize: finalSize,
          reductionPercent: Math.max(0, Math.round(((originalSize - finalSize) / originalSize) * 100)),
          finalPath,
          finalFilename: path.basename(finalPath),
        };
      }
    } catch (err) {
      if (fs.existsSync(tempOutput)) try { fs.unlinkSync(tempOutput); } catch {}
      console.warn(`[MEDIA-COMPRESSOR] Image compression failed for ${filePath}: ${err.message}`);
      return { success: false, error: err.message, path: filePath, size: originalSize };
    }
  }

  return { success: true, path: filePath, size: originalSize };
}
