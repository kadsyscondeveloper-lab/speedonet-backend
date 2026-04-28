// services/videoKycAiService.js
// Lazy-loaded AI deps — server starts even if packages are missing.
// Works on Windows without @tensorflow/tfjs-node native bindings.

const path = require('path');
const fs   = require('fs');
const os   = require('os');

const logger = require('../utils/logger');

let tf      = null;
let faceapi = null;
let canvas  = null;
let ffmpeg  = null;

// ── Redirect @tensorflow/tfjs-node → @tensorflow/tfjs ────────────────────────
// @vladmandic/face-api's Node build hard-requires tfjs-node internally.
// We intercept that require and hand it our already-loaded pure-JS tfjs instead,
// so we never need the native C++ bindings (no Visual Studio build tools needed).

function _patchTfjsRequire() {
  const Module = require('module');
  const orig   = Module._resolveFilename.bind(Module);

  Module._resolveFilename = function (request, parent, isMain, options) {
    if (
      request === '@tensorflow/tfjs-node' ||
      request === '@tensorflow/tfjs-node-gpu'
    ) {
      request = '@tensorflow/tfjs';
    }
    return orig(request, parent, isMain, options);
  };
}

function _loadDeps() {
  if (tf && faceapi && canvas && ffmpeg) return;

  try {
    // 1. Load pure-JS tfjs first and expose as global so face-api finds it
    tf        = require('@tensorflow/tfjs');
    global.tf = tf;

    // 2. Patch module resolver BEFORE face-api is required
    _patchTfjsRequire();

    // 3. Now face-api's internal require('@tensorflow/tfjs-node') resolves to tfjs
    faceapi = require('@vladmandic/face-api');
    canvas  = require('canvas');
    ffmpeg  = require('fluent-ffmpeg');

    const { Canvas, Image, ImageData } = canvas;
    faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

    logger.info('[VideoKycAI] Dependencies loaded (pure-JS tfjs backend)');
  } catch (err) {
    const detail = err.code === 'MODULE_NOT_FOUND' ? err.message : err.stack;
    logger.error(`[VideoKycAI] Failed to load AI deps — AI verification disabled: ${detail}`);
    logger.error('[VideoKycAI] Run: npm install @tensorflow/tfjs @vladmandic/face-api canvas fluent-ffmpeg');
    throw Object.assign(
      new Error('AI verification unavailable — required packages are not installed.'),
      { statusCode: 503, aiUnavailable: true }
    );
  }
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FRAMES_TO_SAMPLE       = 6;
const THRESHOLD_AUTO_APPROVE = 80;
const THRESHOLD_MANUAL       = 50;

let MODELS_LOADED = false;

// ── Load Models ───────────────────────────────────────────────────────────────

async function loadModels() {
  _loadDeps();
  if (MODELS_LOADED) return;

  await tf.ready();
  await tf.setBackend('cpu');

  const modelPath = path.join(process.cwd(), 'models');
  await faceapi.nets.tinyFaceDetector.loadFromDisk(modelPath);

  MODELS_LOADED = true;
  logger.info('[VideoKycAI] Backend: ' + tf.getBackend());
  logger.info('[VideoKycAI] TinyFaceDetector loaded');
}

// ── Extract Frames ────────────────────────────────────────────────────────────

function extractFrames(videoPath, count) {
  return new Promise((resolve, reject) => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vkyc-'));

    ffmpeg.ffprobe(videoPath, (err, meta) => {
      if (err) return reject(err);

      const duration   = meta.format?.duration || 10;
      const interval   = duration / (count + 1);
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
          .on('end',   () => { if (++completed === timestamps.length) resolve({ framePaths, tmpDir }); })
          .on('error', () => { if (++completed === timestamps.length) resolve({ framePaths, tmpDir }); })
          .run();
      });
    });
  });
}

function cleanupTmp(tmpDir) {
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
}

// ── Analyse Single Frame ──────────────────────────────────────────────────────

async function analyzeFrame(framePath) {
  try {
    if (!fs.existsSync(framePath)) return { detected: false, confidence: 0, faceRatio: 0 };

    const { loadImage } = canvas;
    const img = await loadImage(framePath);

    const detection = await faceapi.detectSingleFace(
      img,
      new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.4 })
    );

    if (!detection) return { detected: false, confidence: 0, faceRatio: 0 };

    const ratio = Math.min(detection.box.width / img.width, 1);
    return { detected: true, confidence: detection.score || 0.7, faceRatio: ratio };
  } catch (err) {
    logger.warn(`[VideoKycAI] Frame failed (${path.basename(framePath)}): ${err.message}`);
    return { detected: false, confidence: 0, faceRatio: 0, error: err.message };
  }
}

// ── Score Logic ───────────────────────────────────────────────────────────────

function scoreAndDecide(results) {
  const valid    = results.filter(Boolean);
  const detected = valid.filter(r => r.detected);

  const detRate  = valid.length    > 0 ? detected.length / valid.length                                   : 0;
  const avgConf  = detected.length > 0 ? detected.reduce((s, r) => s + r.confidence, 0) / detected.length : 0;
  const avgRatio = detected.length > 0 ? detected.reduce((s, r) => s + r.faceRatio,  0) / detected.length : 0;
  const faceTooSmall = detected.length > 0 && avgRatio > 0 && avgRatio < 0.08;

  const score = Math.round(
    detRate  * 60 +
    avgConf  * 30 +
    Math.min(avgRatio / 0.25, 1) * 10
  );

  const detail = {
    model:            'TinyFaceDetector',
    frames_analysed:  valid.length,
    frames_with_face: detected.length,
    detection_rate:   `${(detRate * 100).toFixed(0)}%`,
    avg_confidence:   avgConf.toFixed(2),
    avg_face_ratio:   avgRatio.toFixed(2),
    score,
  };

  logger.info('[VideoKycAI] Score=' + score);

  if (score >= THRESHOLD_AUTO_APPROVE && !faceTooSmall) {
    return { score, decision: 'completed', rejection_reason: null,
             agent_notes: `AI verified (${score}/100).`, detail };
  }

  if (score < THRESHOLD_MANUAL) {
    let reason = 'Face not clearly visible.';
    if (detRate < 0.3)      reason = 'Face missing in most frames.';
    else if (faceTooSmall)  reason = 'Move closer to camera.';
    else if (avgConf < 0.5) reason = 'Poor lighting or blur.';
    return { score, decision: 'rejected', rejection_reason: reason,
             agent_notes: `AI rejected (${score}/100). ${reason}`, detail };
  }

  return { score, decision: 'under_review', rejection_reason: null,
           agent_notes: `Borderline score (${score}/100). Manual review required.`, detail };
}

// ── Main Entry Point ──────────────────────────────────────────────────────────

async function analyzeVideoKyc(videoPath) {
  try {
    await loadModels();
  } catch (err) {
    if (err.aiUnavailable) {
      logger.warn('[VideoKycAI] Packages not installed — falling back to manual review');
      return {
        score: 0,
        decision: 'under_review',
        rejection_reason: null,
        agent_notes: 'AI verification not available. Manual review required.',
        detail: { error: err.message },
      };
    }
    throw err;
  }

  logger.info(`[VideoKycAI] Analysing: ${videoPath}`);

  let framePaths = [];
  let tmpDir = null;

  try {
    const extracted = await extractFrames(videoPath, FRAMES_TO_SAMPLE);
    framePaths = extracted.framePaths;
    tmpDir     = extracted.tmpDir;
  } catch (err) {
    logger.error(`[VideoKycAI] Frame extraction failed: ${err.message}`);
    return { score: 0, decision: 'under_review', rejection_reason: null,
             agent_notes: 'Could not process video.', detail: { error: err.message } };
  }

  const results = [];
  for (const fp of framePaths) {
    const result = await analyzeFrame(fp);
    results.push(result);
    logger.info(
      `[VideoKycAI] ${path.basename(fp)}: ` +
      `detected=${result.detected} ` +
      `conf=${(result.confidence || 0).toFixed(2)} ` +
      `ratio=${(result.faceRatio  || 0).toFixed(2)}`
    );
  }

  cleanupTmp(tmpDir);
  return scoreAndDecide(results);
}

module.exports = { analyzeVideoKyc, loadModels };