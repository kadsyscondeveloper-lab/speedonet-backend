// services/videoKycAiService.js
// Uses Hugging Face Inference API — no local model files, no compilation.
// Free tier: ~30,000 requests/month with rate limiting.
// Model: google/owlvit-base-patch32 (open-vocabulary detection, detects "human face")

const path    = require('path');
const fs      = require('fs');
const os      = require('os');
const Jimp    = require('jimp');
const ffmpeg  = require('fluent-ffmpeg');
const { HfInference } = require('@huggingface/inference');
const logger  = require('../utils/logger');

const hf = new HfInference(process.env.HF_TOKEN);

const FRAMES_TO_SAMPLE       = 6;
const THRESHOLD_AUTO_APPROVE = 80;
const THRESHOLD_MANUAL       = 50;

// ── Frame extractor ───────────────────────────────────────────────────────────

function extractFrames(videoPath, count) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkyc-'));

    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);

      const duration  = meta.format.duration || 10;
      const interval  = duration / (count + 1);
      const timestamps = Array.from({ length: count }, (_, i) =>
        ((i + 1) * interval).toFixed(2)
      );

      const framePaths = [];
      let done = 0;

      for (let i = 0; i < timestamps.length; i++) {
        const outPath = path.join(tmpDir, `frame_${i}.jpg`);
        framePaths.push(outPath);

        ffmpeg(videoPath)
          .seekInput(timestamps[i])
          .frames(1)
          .output(outPath)
          .on('end', () => { done++; if (done === timestamps.length) resolve({ framePaths, tmpDir }); })
          .on('error', () => { done++; if (done === timestamps.length) resolve({ framePaths, tmpDir }); })
          .run();
      }
    });
  });
}

// ── Analyse one frame via HF API ──────────────────────────────────────────────

async function analyzeFrame(framePath) {
  if (!fs.existsSync(framePath)) return { detected: false, confidence: 0 };

  try {
    const imageData = fs.readFileSync(framePath);

    // Use object detection — looks for "face" or "person" labels
    const results = await hf.objectDetection({
      model: 'hustvl/yolos-tiny',
      data:  new Blob([imageData], { type: 'image/jpeg' }),
    });

    // Filter for face/person detections with decent confidence
    const faceDetections = results.filter(r =>
      ['face', 'person', 'human face'].some(label =>
        r.label.toLowerCase().includes(label)
      ) && r.score >= 0.5
    );

    if (faceDetections.length === 0) return { detected: false, confidence: 0 };

    const best = faceDetections.reduce((a, b) => a.score > b.score ? a : b);

    // Estimate face ratio from bounding box
    const image      = await Jimp.read(framePath);
    const frameWidth = image.bitmap.width;
    const boxWidth   = (best.box.xmax - best.box.xmin);
    const faceRatio  = boxWidth / frameWidth;

    return { detected: true, confidence: best.score, faceRatio };

  } catch (err) {
    logger.warn(`[VideoKycAI] HF API error on frame: ${err.message}`);
    return { detected: false, confidence: 0, faceRatio: 0 };
  }
}

function cleanupTmp(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function analyzeVideoKyc(videoPath) {
  logger.info(`[VideoKycAI] Analysing: ${videoPath}`);

  let framePaths = [], tmpDir = null;

  try {
    ({ framePaths, tmpDir } = await extractFrames(videoPath, FRAMES_TO_SAMPLE));
  } catch (err) {
    logger.error(`[VideoKycAI] Frame extraction failed: ${err.message}`);
    return {
      score: 0, decision: 'under_review', rejection_reason: null,
      agent_notes: `AI could not extract frames — manual review required.`,
      detail: { error: err.message },
    };
  }

  const results = [];
  for (const fp of framePaths) {
    const r = await analyzeFrame(fp);
    results.push(r);
    logger.info(`[VideoKycAI] ${path.basename(fp)}: detected=${r.detected} conf=${(r.confidence||0).toFixed(2)}`);
  }

  cleanupTmp(tmpDir);

  return _scoreAndDecide(results);
}

function _scoreAndDecide(results) {
  const valid    = results.filter(Boolean);
  const detected = valid.filter(r => r.detected);
  const detRate  = valid.length > 0 ? detected.length / valid.length : 0;
  const avgConf  = detected.length > 0
    ? detected.reduce((s, r) => s + r.confidence, 0) / detected.length : 0;
  const avgRatio = detected.length > 0
    ? detected.reduce((s, r) => s + (r.faceRatio || 0), 0) / detected.length : 0;
  const faceTooSmall = avgRatio > 0 && avgRatio < 0.10;

  const score = Math.round((detRate * 60) + (avgConf * 30) + (Math.min(avgRatio / 0.25, 1) * 10));

  const detail = {
    frames_analysed: valid.length, frames_with_face: detected.length,
    detection_rate: `${(detRate * 100).toFixed(0)}%`,
    avg_confidence: avgConf.toFixed(2), score,
  };

  logger.info(`[VideoKycAI] Score=${score} | ${JSON.stringify(detail)}`);

  if (score >= THRESHOLD_AUTO_APPROVE && !faceTooSmall) {
    return { score, decision: 'completed', rejection_reason: null,
      agent_notes: `AI verified (score ${score}/100). Face detected in ${detail.detection_rate} of frames.`, detail };
  }

  if (score < THRESHOLD_MANUAL) {
    let reason = 'Face not clearly visible in the video.';
    if (detRate < 0.3)       reason = 'Face was detected in very few frames. Please ensure your face is fully visible throughout.';
    else if (faceTooSmall)   reason = 'Face appears too far from camera. Please hold your device closer.';
    else if (avgConf < 0.5)  reason = 'Video quality too low. Please ensure good lighting.';
    return { score, decision: 'rejected', rejection_reason: reason,
      agent_notes: `AI rejected (score ${score}/100). ${reason}`, detail };
  }

  return { score, decision: 'under_review', rejection_reason: null,
    agent_notes: `AI confidence insufficient (score ${score}/100) — flagged for manual review.`, detail };
}

async function loadModels() {
  logger.info('[VideoKycAI] Using Hugging Face Inference API — no local models needed.');
}

module.exports = { analyzeVideoKyc, loadModels };