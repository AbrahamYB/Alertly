import test from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import path from "path";
import os from "os";
import { execSync } from "child_process";
import {
  calculateTargetBitrate,
  get720pScaleFilter,
  hasFfmpeg,
  probeMedia,
  compressVideo,
  compressImage,
  autoCompressFile,
  extractVideoContactSheets,
} from "../lib/media-compressor.js";

test("calculateTargetBitrate dynamically computes bitrates for 2MB target with container headroom", () => {
  const targetBytes = 2 * 1024 * 1024; // 2MB

  // 10 second video
  const { totalBitrateKbps, videoBitrateKbps, audioBitrateKbps } = calculateTargetBitrate(10, targetBytes, true);
  assert.ok(totalBitrateKbps > 1000, `Expected >1000 kbps for 10s 2MB, got ${totalBitrateKbps}`);
  assert.equal(audioBitrateKbps, 64);
  assert.equal(videoBitrateKbps, totalBitrateKbps - 64);

  // Total bits check: (video + audio) * duration must be <= targetBytes * 8
  const estimatedTotalBits = (videoBitrateKbps + audioBitrateKbps) * 1000 * 10;
  assert.ok(estimatedTotalBits <= targetBytes * 8, "Estimated bits must not exceed target size");
});

test("get720pScaleFilter outputs valid FFmpeg scaling expressions", () => {
  // 1080p downscaling
  const filter1080 = get720pScaleFilter(1920, 1080);
  assert.ok(filter1080.includes("1280") || filter1080.includes("720"));

  // Native 720p stays without downscaling
  const filter720 = get720pScaleFilter(1280, 720);
  assert.ok(filter720.includes("pad="));
});

test("FFmpeg is detected and probes media attributes accurately", async () => {
  const isAvailable = await hasFfmpeg();
  assert.equal(isAvailable, true, "FFmpeg should be detected on this system");

  const tempVideo = path.join(os.tmpdir(), `probe_test_${Date.now()}.mp4`);
  execSync(`ffmpeg -y -f lavfi -i testsrc=size=1920x1080:rate=25 -t 1 -c:v libx264 -pix_fmt yuv420p "${tempVideo}"`, { stdio: "ignore" });

  try {
    const probe = await probeMedia(tempVideo);
    assert.equal(probe.isVideo, true);
    assert.equal(probe.width, 1920);
    assert.equal(probe.height, 1080);
    assert.ok(probe.duration >= 0.9);
  } finally {
    if (fs.existsSync(tempVideo)) fs.unlinkSync(tempVideo);
  }
});

test("autoCompressFile automatically compresses video down to 720p and <= 2MB", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcomp_test_"));
  const inputVideo = path.join(tempDir, "sample_1080p.mp4");

  // Create 3-second 1080p video with large artificial bitrate
  execSync(`ffmpeg -y -f lavfi -i testsrc=size=1920x1080:rate=30 -t 3 -c:v libx264 -b:v 8M -pix_fmt yuv420p "${inputVideo}"`, { stdio: "ignore" });
  const initialSize = fs.statSync(inputVideo).size;

  const result = await autoCompressFile(inputVideo, { targetSizeMB: 2, maxResolution: 720 });
  assert.equal(result.success, true);
  assert.equal(result.type, "video");
  assert.ok(result.compressedSize <= 2 * 1024 * 1024, `Expected <= 2MB, got ${result.compressedSize}`);

  // Probe resulting file dimensions
  const probe = await probeMedia(result.finalPath);
  assert.equal(probe.width, 1280);
  assert.equal(probe.height, 720);

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("autoCompressFile automatically compresses large images down to 720p", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcomp_img_test_"));
  const inputImage = path.join(tempDir, "highres_photo.png");

  // Create 1920x1080 test image
  execSync(`ffmpeg -y -f lavfi -i color=c=green:s=1920x1080 -frames:v 1 "${inputImage}"`, { stdio: "ignore" });

  const result = await autoCompressFile(inputImage, { maxResolution: 720 });
  assert.equal(result.success, true);
  assert.equal(result.type, "image");

  const probe = await probeMedia(result.finalPath);
  assert.equal(probe.width, 1280);
  assert.equal(probe.height, 720);

  // Clean up
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("autoCompressFile converts non-MP4 videos (e.g. AVI) into standard 720p MP4", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "dcomp_avi_test_"));
  const inputAvi = path.join(tempDir, "clip.avi");

  execSync(`ffmpeg -y -f lavfi -i testsrc=size=1920x1080:rate=24 -t 2 -c:v mjpeg -q:v 3 "${inputAvi}"`, { stdio: "ignore" });

  const result = await autoCompressFile(inputAvi, { targetSizeMB: 2 });
  assert.equal(result.success, true);
  assert.equal(result.type, "video");
  assert.equal(path.extname(result.finalPath), ".mp4");
  assert.equal(fs.existsSync(inputAvi), false, "Original AVI should be deleted");
  assert.equal(fs.existsSync(result.finalPath), true, "New MP4 should exist");

  const probe = await probeMedia(result.finalPath);
  assert.equal(probe.videoCodec, "h264");
  assert.equal(probe.width, 1280);
  assert.equal(probe.height, 720);
  assert.ok(result.compressedSize <= 2 * 1024 * 1024);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("extractVideoContactSheets packs sampled frames into JPEG contact sheets", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "alertly_frames_test_"));
  const inputVideo = path.join(tempDir, "sample.mp4");
  execSync(`ffmpeg -y -f lavfi -i testsrc=size=640x360:rate=20 -t 2 -c:v libx264 -pix_fmt yuv420p "${inputVideo}"`, { stdio: "ignore" });
  const sheets = await extractVideoContactSheets(inputVideo, { maxSheets: 2 });
  assert.equal(sheets.length, 1); // Two sampled frames fit on one 4x4 sheet.
  assert.ok(sheets.every((sheet) => sheet.startsWith("data:image/jpeg;base64,")));
  fs.rmSync(tempDir, { recursive: true, force: true });
});

