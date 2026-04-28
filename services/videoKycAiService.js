// services/videoKycAiService.js
// Node 20 compatible - no tfjs-node required
// Install:
// npm install @tensorflow/tfjs @vladmandic/face-api canvas fluent-ffmpeg

const path = require('path');
const fs = require('fs');
const os = require('os');
const ffmpeg = require('fluent-ffmpeg');

const tf = require('@tensorflow/tfjs');
global.tf = tf;

const faceapi = require('@vladmandic/face-api');
const canvas = require('canvas');

const logger = require('../utils/logger');

const { Canvas, Image, ImageData, loadImage } = canvas;

faceapi.env.monkeyPatch({
  Canvas,
  Image,
  ImageData
});

const FRAMES_TO_SAMPLE = 6;
const THRESHOLD_AUTO_APPROVE = 80;
const THRESHOLD_MANUAL = 50;

let MODELS_LOADED = false;

// -----------------------------------------------------
// Load Models
// -----------------------------------------------------
async function loadModels() {
  if (MODELS_LOADED) return;

  await tf.ready();
  await tf.setBackend('cpu');

  const modelPath = path.join(process.cwd(), 'models');

  await faceapi.nets.tinyFaceDetector.loadFromDisk(modelPath);

  MODELS_LOADED = true;

  logger.info('[VideoKycAI] TensorFlow backend: ' + tf.getBackend());
  logger.info('[VideoKycAI] TinyFaceDetector loaded');
}

// -----------------------------------------------------
// Extract Frames
// -----------------------------------------------------
function extractFrames(videoPath, count) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkyc-'));

    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);

      const duration = meta.format?.duration || 10;
      const interval = duration / (count + 1);

      const timestamps = Array.from({ length: count }, (_, i) =>
        ((i + 1) * interval).toFixed(2)
      );

      const framePaths = [];
      let completed = 0;

      timestamps.forEach((ts, i) => {
        const output = path.join(tmpDir, `frame_${i}.jpg`);
        framePaths.push(output);

        ffmpeg(videoPath)
          .seekInput(ts)
          .frames(1)
          .output(output)
          .on('end', () => {
            completed++;
            if (completed === timestamps.length) {
              resolve({ framePaths, tmpDir });
            }
          })
          .on('error', () => {
            completed++;
            if (completed === timestamps.length) {
              resolve({ framePaths, tmpDir });
            }
          })
          .run();
      });
    });
  });
}

// -----------------------------------------------------
// Cleanup Temp Folder
// -----------------------------------------------------
function cleanupTmp(tmpDir) {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch (_) {}
}

// -----------------------------------------------------
// Analyze Single Frame
// -----------------------------------------------------
async function analyzeFrame(framePath) {
  try {
    if (!fs.existsSync(framePath)) {
      return {
        detected: false,
        confidence: 0,
        faceRatio: 0
      };
    }

    const img = await loadImage(framePath);

    const detection = await faceapi.detectSingleFace(
      img,
      new faceapi.TinyFaceDetectorOptions({
        inputSize: 416,
        scoreThreshold: 0.4
      })
    );

    if (!detection) {
      return {
        detected: false,
        confidence: 0,
        faceRatio: 0
      };
    }

    const box = detection.box;

    const ratio = Math.min(box.width / img.width, 1);

    return {
      detected: true,
      confidence: detection.score || 0.7,
      faceRatio: ratio
    };
  } catch (err) {
    logger.warn(
      `[VideoKycAI] Frame failed (${path.basename(framePath)}): ${err.message}`
    );

    return {
      detected: false,
      confidence: 0,
      faceRatio: 0,
      error: err.message
    };
  }
}

// -----------------------------------------------------
// Score Logic
// -----------------------------------------------------
function scoreAndDecide(results) {
  const valid = results.filter(Boolean);
  const detected = valid.filter(r => r.detected);

  const detRate =
    valid.length > 0 ? detected.length / valid.length : 0;

  const avgConf =
    detected.length > 0
      ? detected.reduce((sum, r) => sum + r.confidence, 0) /
        detected.length
      : 0;

  const avgRatio =
    detected.length > 0
      ? detected.reduce((sum, r) => sum + r.faceRatio, 0) /
        detected.length
      : 0;

  const faceTooSmall =
    detected.length > 0 &&
    avgRatio > 0 &&
    avgRatio < 0.08;

  const score = Math.round(
    detRate * 60 +
    avgConf * 30 +
    Math.min(avgRatio / 0.25, 1) * 10
  );

  const detail = {
    model: 'TinyFaceDetector',
    frames_analysed: valid.length,
    frames_with_face: detected.length,
    detection_rate: `${(detRate * 100).toFixed(0)}%`,
    avg_confidence: avgConf.toFixed(2),
    avg_face_ratio: avgRatio.toFixed(2),
    score
  };

  logger.info('[VideoKycAI] Score=' + score);

  if (score >= THRESHOLD_AUTO_APPROVE && !faceTooSmall) {
    return {
      score,
      decision: 'completed',
      rejection_reason: null,
      agent_notes: `AI verified (${score}/100).`,
      detail
    };
  }

  if (score < THRESHOLD_MANUAL) {
    let reason = 'Face not clearly visible.';

    if (detRate < 0.3) {
      reason = 'Face missing in most frames.';
    } else if (faceTooSmall) {
      reason = 'Move closer to camera.';
    } else if (avgConf < 0.5) {
      reason = 'Poor lighting or blur.';
    }

    return {
      score,
      decision: 'rejected',
      rejection_reason: reason,
      agent_notes: `AI rejected (${score}/100). ${reason}`,
      detail
    };
  }

  return {
    score,
    decision: 'under_review',
    rejection_reason: null,
    agent_notes: `Borderline score (${score}/100). Manual review required.`,
    detail
  };
}

// -----------------------------------------------------
// Main Analyze Video
// -----------------------------------------------------
async function analyzeVideoKyc(videoPath) {
  await loadModels();

  logger.info(`[VideoKycAI] Analysing: ${videoPath}`);

  let framePaths = [];
  let tmpDir = null;

  try {
    const extracted = await extractFrames(
      videoPath,
      FRAMES_TO_SAMPLE
    );

    framePaths = extracted.framePaths;
    tmpDir = extracted.tmpDir;
  } catch (err) {
    logger.error(
      `[VideoKycAI] Frame extraction failed: ${err.message}`
    );

    return {
      score: 0,
      decision: 'under_review',
      rejection_reason: null,
      agent_notes: 'Could not process video.',
      detail: { error: err.message }
    };
  }

  const results = [];

  for (const fp of framePaths) {
    const result = await analyzeFrame(fp);
    results.push(result);

    logger.info(
      `[VideoKycAI] ${path.basename(fp)}: ` +
      `detected=${result.detected} ` +
      `conf=${(result.confidence || 0).toFixed(2)} ` +
      `ratio=${(result.faceRatio || 0).toFixed(2)}`
    );
  }

  cleanupTmp(tmpDir);

  return scoreAndDecide(results);
}

module.exports = {
  analyzeVideoKyc,
  loadModels
};