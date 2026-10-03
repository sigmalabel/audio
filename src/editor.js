import "./styles.css";
import { FFmpeg } from "@ffmpeg/ffmpeg";
import { fetchFile, toBlobURL } from "@ffmpeg/util";
import { PitchShifter } from "soundtouchjs";
import {
  NOTE_NAMES,
  detectBitDepth,
  makeMono,
  detectBpm,
  detectKey,
  analyzeEqSpectrum,
  createEqMatchCurve,
  measureLoudness,
  calculateVolumeMatch
} from "./audio-analysis.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

const elements = {
  uploadZone: $("#uploadZone"), fileInput: $("#fileInput"), chooseButton: $("#chooseButton"),
  filePanel: $("#filePanel"), editorWorkspace: $("#editorWorkspace"), processingPanel: $("#processingPanel"), fileName: $("#fileName"), fileMeta: $("#fileMeta"),
  outputName: $("#outputName"), format: $("#formatSelect"), rate: $("#rateSelect"), depth: $("#depthSelect"),
  bitrate: $("#bitrateSelect"), channels: $("#channelSelect"), depthField: $("#depthField"),
  bitrateField: $("#bitrateField"), extension: $("#extensionLabel"), convert: $("#convertButton"),
  remove: $("#removeButton"), play: $("#playButton"), waveform: $("#waveform"),
  timeCurrent: $("#timeCurrent"), timeTotal: $("#timeTotal"), progressWrap: $("#progressWrap"),
  progressText: $("#progressText"), progressPercent: $("#progressPercent"), progressBar: $("#progressBar"),
  message: $("#toolMessage"), engineStatus: $("#engineStatus"), bpm: $("#analysisBpm"),
  bpmConfidence: $("#bpmConfidence"), key: $("#analysisKey"), scale: $("#analysisScale"),
  analysisRate: $("#analysisRate"), analysisDepth: $("#analysisDepth"), speed: $("#speedRange"),
  speedValue: $("#speedValue"), naturalPitch: $("#naturalPitchValue"), targetKey: $("#targetKeySelect"),
  pitch: $("#pitchRange"), pitchValue: $("#pitchValue"), volume: $("#volumeRange"), volumeValue: $("#volumeValue"), outputKey: $("#outputKey"),
  outputKeyDetail: $("#outputKeyDetail"), resetMotion: $("#resetMotion"), eqKnobs: $("#eqKnobs"),
  referenceInput: $("#referenceInput"), referenceDrop: $("#referenceDrop"), referencePrompt: $("#referencePrompt"),
  referenceStatus: $("#referenceStatus"), referenceControls: $("#referenceControls"), referenceName: $("#referenceName"),
  referenceRemove: $("#referenceRemove"), matchStrength: $("#matchStrength"), matchStrengthValue: $("#matchStrengthValue"),
  matchVolumeToggle: $("#matchVolumeToggle"), matchVolumeBadge: $("#matchVolumeBadge"), matchVolumeDetail: $("#matchVolumeDetail"),
  waveToolBtns: $$(".wave-tool-btn"), toolContextPanes: $$(".tool-context-pane"),
  trimRangeLabel: $("#trimRangeLabel"), trimDurationLabel: $("#trimDurationLabel"),
  resetTrimBtn: $("#resetTrimBtn"), fadeInToggle: $("#fadeInToggle"),
  fadeInValueLabel: $("#fadeInValueLabel"), fadeOutToggle: $("#fadeOutToggle"),
  fadeOutValueLabel: $("#fadeOutValueLabel"), timelineStatus: $("#timelineStatus"),
};

const EQ_BANDS = [
  [60, "60", "lowshelf"], [170, "170", "peaking"], [310, "310", "peaking"],
  [600, "600", "peaking"], [1000, "1k", "peaking"], [3000, "3k", "peaking"],
  [6000, "6k", "peaking"], [12000, "12k", "peaking"], [14000, "14k", "peaking"],
  [16000, "16k", "highshelf"],
].map(([frequency, label, type]) => ({ frequency, label, type }));
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 3, 1, 0, -1, -1, 0, 1, 1],
  club: [5, 4, 1, -2, -1, 2, 4, 3, 2, 1],
  vocals: [-3, -2, -1, 0, 1, 4, 5, 3, 1, 0],
  warm: [3, 3, 2, 2, 1, 0, -1, -2, -2, -3],
  bright: [-2, -1, 0, 0, 1, 2, 4, 5, 5, 4],
};
const MIME = { wav: "audio/wav", mp3: "audio/mpeg", ogg: "audio/ogg", flac: "audio/flac", m4a: "audio/mp4", aac: "audio/aac", aiff: "audio/aiff" };
const LOSSLESS = new Set(["wav", "flac", "aiff"]);
const LOSSY = new Set(["mp3", "ogg", "m4a", "aac"]);

let sourceFile = null;
let sourceArrayBuffer = null;
let decodedBuffer = null;
let audioContext = null;
let shifter = null;
let nativeSource = null;
let nativePlayStartTime = 0;
let nativePlayStartOffset = 0;
let playbackAnimFrame = null;
let matchGainNode = null;
let masterLimiterNode = null;
let eqNodes = [];
let eqGains = Array(10).fill(0);
let isPlaying = false;
let previewPercent = 0;
let waveformPeaks = [];
let detected = { bpm: null, keyIndex: null, scale: null };
let resultBlob = null;
let resultUrl = null;
let ffmpeg = null;
let engineLoaded = false;
let sourceEqSpectrum = null;
let referenceEqSpectrum = null;
let referenceFile = null;
let sourceLoudness = null;
let referenceLoudness = null;
let matchVolumeEnabled = false;
let matchedVolumeGainDb = 0;
let matchedVolumeGainLinear = 1;
let detectedBitDepthValue = "24";
let trackVolumeDb = 0;
let activeWaveTool = "cursor";
let trimStartPct = 0;
let trimEndPct = 100;
let pointerDragMode = null;
let trimDragAnchorPct = 0;
let fadeInEnabled = false;
let fadeInDurationSec = 2.0;
let fadeOutEnabled = false;
let fadeOutDurationSec = 2.0;
let fadeGainNode = null;

function cleanName(name) {
  let base = (name || "").replace(/\.[^/.]+$/, "").trim();
  base = base.replace(/[\x00-\x1f<>:"/\\|?*]/g, "-").trim();
  base = base.replace(/^[. ]+|[. ]+$/g, "");
  return base || "converted-audio";
}
function bytesLabel(bytes) { return bytes < 1048576 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1048576).toFixed(1)} MB`; }
function timeLabel(seconds) { const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0; return `${Math.floor(safe / 60)}:${Math.floor(safe % 60).toString().padStart(2, "0")}`; }
function signed(value, decimals = 1) { return `${value > 0 ? "+" : ""}${Number(value).toFixed(decimals)}`; }
function showMessage(text, success = false) { elements.message.textContent = text; elements.message.classList.remove("is-hidden", "is-success"); if (success) elements.message.classList.add("is-success"); }
function clearMessage() { elements.message.classList.add("is-hidden"); elements.message.classList.remove("is-success"); }
function setProgress(value, text) { const safe = clamp(Math.round(value), 0, 100); elements.progressWrap.classList.remove("is-hidden"); elements.progressText.textContent = text; elements.progressPercent.textContent = `${safe}%`; elements.progressBar.style.width = `${safe}%`; }
function setRangeFill(input) { const percent = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min)) * 100; input.style.setProperty("--value", `${percent}%`); }
function resetResult() {
  if (resultUrl) URL.revokeObjectURL(resultUrl);
  resultBlob = null; resultUrl = null;
  elements.convert.classList.remove("is-ready");
  elements.convert.querySelector(".convert-label").textContent = "Render edited audio";
  elements.progressWrap.classList.add("is-hidden");
  clearMessage();
}

function updateFormat() {
  const format = elements.format.value;
  elements.extension.textContent = `.${format}`;
  elements.depthField.classList.toggle("is-hidden", !LOSSLESS.has(format));
  elements.bitrateField.classList.toggle("is-hidden", !LOSSY.has(format));
  resetResult();
}

async function analyzeTrack(file, buffer, header) {
  $$(".analysis-card").forEach((card) => card.classList.add("is-loading"));
  elements.bpm.textContent = elements.key.textContent = elements.scale.textContent = "Analyzing";
  elements.analysisRate.textContent = `${(buffer.sampleRate / 1000).toFixed(buffer.sampleRate % 1000 ? 1 : 0)} kHz`;
  const depthStr = detectBitDepth(file, header);
  elements.analysisDepth.textContent = depthStr;
  if (depthStr.includes("32")) detectedBitDepthValue = "32";
  else if (depthStr.includes("24")) detectedBitDepthValue = "24";
  else if (depthStr.includes("16")) detectedBitDepthValue = "16";
  else detectedBitDepthValue = "24";
  await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 20)));
  const mono = makeMono(buffer);
  const tempo = detectBpm(mono, buffer.sampleRate);
  const key = detectKey(mono, buffer.sampleRate);
  detected = { bpm: tempo.bpm, keyIndex: key.keyIndex, scale: key.scale };
  elements.bpm.textContent = tempo.bpm || "—";
  elements.bpmConfidence.textContent = tempo.confidence > .62 ? "Strong estimate" : "Estimated tempo";
  elements.key.textContent = NOTE_NAMES[key.keyIndex];
  elements.scale.textContent = key.scale;
  $$(".analysis-card").forEach((card) => card.classList.remove("is-loading"));
  updateOutputKey();
}

function calculatePeaks(buffer) {
  const samples = buffer.getChannelData(0);
  const bars = 145;
  const block = Math.max(1, Math.floor(samples.length / bars));
  waveformPeaks = Array.from({ length: bars }, (_, index) => {
    let peak = 0;
    const start = index * block;
    const stride = Math.max(1, Math.floor(block / 100));
    for (let i = 0; i < block; i += stride) peak = Math.max(peak, Math.abs(samples[start + i] || 0));
    return Math.max(.045, peak);
  });
}

function drawWaveform(percent = previewPercent) {
  if (!waveformPeaks.length) return;
  const canvas = elements.waveform;
  const ctx = canvas.getContext("2d");
  const ratio = window.devicePixelRatio || 1;
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(width * ratio));
  canvas.height = Math.max(1, Math.floor(height * ratio));
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const gap = 3;
  const barWidth = Math.max(1.5, width / waveformPeaks.length - gap);
  const playedX = width * clamp(percent, 0, 100) / 100;

  const isTrimmed = trimStartPct > 0.5 || trimEndPct < 99.5;
  const trimStartX = (trimStartPct / 100) * width;
  const trimEndX = (trimEndPct / 100) * width;

  // 1. Draw bars
  waveformPeaks.forEach((peak, index) => {
    const x = index * (barWidth + gap);
    const barHeight = Math.max(5, peak * (height - 24));
    const y = (height - barHeight) / 2;
    const isInsideTrim = x + barWidth >= trimStartX && x <= trimEndX;

    const gradient = ctx.createLinearGradient(0, y, 0, y + barHeight);
    if (!isInsideTrim && isTrimmed) {
      gradient.addColorStop(0, "rgba(255,255,255,.07)");
      gradient.addColorStop(1, "rgba(255,255,255,.02)");
    } else if (x <= playedX) {
      gradient.addColorStop(0, "#D8F2EC");
      gradient.addColorStop(1, "#84CFBF");
    } else {
      gradient.addColorStop(0, "rgba(255,255,255,.32)");
      gradient.addColorStop(1, "rgba(255,255,255,.09)");
    }
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.roundRect(x, y, barWidth, barHeight, 3);
    ctx.fill();
  });

  // 2. Cut/Trim Overlays & Handles
  if (isTrimmed || activeWaveTool === "trim") {
    ctx.fillStyle = "rgba(0, 0, 0, 0.52)";
    if (trimStartX > 0) ctx.fillRect(0, 0, trimStartX, height);
    if (trimEndX < width) ctx.fillRect(trimEndX, 0, width - trimEndX, height);

    // Left marker line
    ctx.fillStyle = "#B6D8D0";
    ctx.fillRect(trimStartX - 1, 0, 2, height);
    // Left handle tab
    ctx.beginPath();
    ctx.roundRect(trimStartX - 5, 4, 10, 22, 3);
    ctx.fillStyle = "#FFFFFF"; ctx.fill();
    ctx.fillStyle = "#000000";
    ctx.fillRect(trimStartX - 2, 9, 1, 12);
    ctx.fillRect(trimStartX + 1, 9, 1, 12);

    // Right marker line
    ctx.fillStyle = "#B6D8D0";
    ctx.fillRect(trimEndX - 1, 0, 2, height);
    // Right handle tab
    ctx.beginPath();
    ctx.roundRect(trimEndX - 5, 4, 10, 22, 3);
    ctx.fillStyle = "#FFFFFF"; ctx.fill();
    ctx.fillStyle = "#000000";
    ctx.fillRect(trimEndX - 2, 9, 1, 12);
    ctx.fillRect(trimEndX + 1, 9, 1, 12);
  }

  // 3. Fade In Automation Curve
  const totalDur = processedDuration() || 1;
  const clipDur = isTrimmed ? ((trimEndPct - trimStartPct) / 100) * totalDur : totalDur;
  if ((fadeInEnabled || activeWaveTool === "fadein") && clipDur > 0.1) {
    const fadeInPx = (fadeInDurationSec / totalDur) * width;
    const fadeEndX = Math.min(trimEndX, trimStartX + fadeInPx);
    if (fadeEndX > trimStartX + 4) {
      ctx.beginPath();
      ctx.moveTo(trimStartX, height - 6);
      ctx.quadraticCurveTo(trimStartX + (fadeEndX - trimStartX) * 0.35, 12, fadeEndX, 12);
      ctx.lineTo(fadeEndX, height);
      ctx.lineTo(trimStartX, height);
      ctx.closePath();
      const inGrad = ctx.createLinearGradient(trimStartX, 0, fadeEndX, 0);
      inGrad.addColorStop(0, "rgba(182, 216, 208, 0.02)");
      inGrad.addColorStop(1, fadeInEnabled ? "rgba(182, 216, 208, 0.22)" : "rgba(255, 255, 255, 0.08)");
      ctx.fillStyle = inGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(trimStartX, height - 6);
      ctx.quadraticCurveTo(trimStartX + (fadeEndX - trimStartX) * 0.35, 12, fadeEndX, 12);
      ctx.strokeStyle = fadeInEnabled ? "#B6D8D0" : "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash(fadeInEnabled ? [] : [4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(fadeEndX, 12, 6, 0, Math.PI * 2);
      ctx.fillStyle = fadeInEnabled ? "#7DE05C" : "#FFFFFF";
      ctx.fill();
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = "bold 9px monospace";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`${fadeInDurationSec.toFixed(1)}s in`, Math.max(trimStartX + 6, fadeEndX - 26), 28);
    }
  }

  // 4. Fade Out Automation Curve
  if ((fadeOutEnabled || activeWaveTool === "fadeout") && clipDur > 0.1) {
    const fadeOutPx = (fadeOutDurationSec / totalDur) * width;
    const fadeStartX = Math.max(trimStartX, trimEndX - fadeOutPx);
    if (trimEndX > fadeStartX + 4) {
      ctx.beginPath();
      ctx.moveTo(fadeStartX, 12);
      ctx.quadraticCurveTo(trimEndX - (trimEndX - fadeStartX) * 0.35, 12, trimEndX, height - 6);
      ctx.lineTo(trimEndX, height);
      ctx.lineTo(fadeStartX, height);
      ctx.closePath();
      const outGrad = ctx.createLinearGradient(fadeStartX, 0, trimEndX, 0);
      outGrad.addColorStop(0, fadeOutEnabled ? "rgba(182, 216, 208, 0.22)" : "rgba(255, 255, 255, 0.08)");
      outGrad.addColorStop(1, "rgba(182, 216, 208, 0.02)");
      ctx.fillStyle = outGrad;
      ctx.fill();

      ctx.beginPath();
      ctx.moveTo(fadeStartX, 12);
      ctx.quadraticCurveTo(trimEndX - (trimEndX - fadeStartX) * 0.35, 12, trimEndX, height - 6);
      ctx.strokeStyle = fadeOutEnabled ? "#B6D8D0" : "rgba(255, 255, 255, 0.35)";
      ctx.lineWidth = 2.5;
      ctx.setLineDash(fadeOutEnabled ? [] : [4, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      ctx.beginPath();
      ctx.arc(fadeStartX, 12, 6, 0, Math.PI * 2);
      ctx.fillStyle = fadeOutEnabled ? "#7DE05C" : "#FFFFFF";
      ctx.fill();
      ctx.strokeStyle = "#000000";
      ctx.lineWidth = 2;
      ctx.stroke();

      ctx.font = "bold 9px monospace";
      ctx.fillStyle = "#ffffff";
      ctx.fillText(`${fadeOutDurationSec.toFixed(1)}s out`, Math.min(width - 55, fadeStartX + 6), 28);
    }
  }

  // 5. Playhead
  if (percent > 0 && percent < 100) {
    ctx.fillStyle = "#7DE05C";
    ctx.fillRect(playedX - .5, 6, 1.5, height - 12);
    ctx.beginPath(); ctx.arc(playedX, 6, 3.5, 0, Math.PI * 2); ctx.fill();
  }
  canvas.setAttribute("aria-valuenow", String(Math.round(percent)));
}

function processedDuration() { return decodedBuffer ? decodedBuffer.duration / Number(elements.speed.value) : 0; }
function updateTimeline(percent = previewPercent) {
  const totalDur = processedDuration();
  if (!totalDur) {
    elements.timeCurrent.textContent = "0:00";
    elements.timeTotal.textContent = "0:00";
    return;
  }
  const isTrimmed = trimStartPct > 0.5 || trimEndPct < 99.5;
  if (isTrimmed) {
    const startSec = (trimStartPct / 100) * totalDur;
    const currentSec = Math.max(0, ((clamp(percent, trimStartPct, trimEndPct) - trimStartPct) / 100) * totalDur);
    const clipDur = ((trimEndPct - trimStartPct) / 100) * totalDur;
    elements.timeCurrent.textContent = timeLabel(currentSec);
    elements.timeTotal.textContent = timeLabel(clipDur);
  } else {
    elements.timeCurrent.textContent = timeLabel(totalDur * clamp(percent, 0, 100) / 100);
    elements.timeTotal.textContent = timeLabel(totalDur);
  }
}

function updateTrimUI() {
  const totalDur = processedDuration() || 0;
  const startSec = (trimStartPct / 100) * totalDur;
  const endSec = (trimEndPct / 100) * totalDur;
  const clipDur = Math.max(0, endSec - startSec);
  if (elements.trimRangeLabel) {
    elements.trimRangeLabel.textContent = `${timeLabel(startSec)} – ${timeLabel(endSec)}`;
  }
  if (elements.trimDurationLabel) {
    elements.trimDurationLabel.textContent = timeLabel(clipDur);
  }
  updateTimeline();
}

function updateFadeUI() {
  if (elements.fadeInToggle) elements.fadeInToggle.checked = fadeInEnabled;
  if (elements.fadeOutToggle) elements.fadeOutToggle.checked = fadeOutEnabled;
  if (elements.fadeInValueLabel) {
    elements.fadeInValueLabel.textContent = `${fadeInDurationSec.toFixed(1)}s`;
    elements.fadeInValueLabel.classList.toggle("is-active", fadeInEnabled);
  }
  if (elements.fadeOutValueLabel) {
    elements.fadeOutValueLabel.textContent = `${fadeOutDurationSec.toFixed(1)}s`;
    elements.fadeOutValueLabel.classList.toggle("is-active", fadeOutEnabled);
  }
}

function setWaveTool(tool) {
  activeWaveTool = tool;
  $$(".wave-tool-btn").forEach((btn) => {
    const isActive = btn.dataset.tool === tool;
    btn.classList.toggle("is-active", isActive);
    btn.setAttribute("aria-selected", String(isActive));
  });
  $$(".tool-context-pane").forEach((pane) => {
    pane.classList.toggle("is-hidden", pane.dataset.pane !== tool);
  });
  if (tool === "cursor") {
    elements.waveform.style.cursor = "crosshair";
    if (elements.timelineStatus) elements.timelineStatus.textContent = "Click anywhere on the waveform to seek";
  } else if (tool === "trim") {
    elements.waveform.style.cursor = "col-resize";
    if (elements.timelineStatus) elements.timelineStatus.textContent = "Click or drag handles to set start and end points";
  } else if (tool === "fadein") {
    elements.waveform.style.cursor = "ew-resize";
    if (elements.timelineStatus) elements.timelineStatus.textContent = "Drag handle to adjust fade-in length";
  } else if (tool === "fadeout") {
    elements.waveform.style.cursor = "ew-resize";
    if (elements.timelineStatus) elements.timelineStatus.textContent = "Drag handle to adjust fade-out length";
  }
  drawWaveform();
}

function stopPreview(reset = false) {
  if (playbackAnimFrame) { cancelAnimationFrame(playbackAnimFrame); playbackAnimFrame = null; }
  if (nativeSource) {
    try { nativeSource.onended = null; nativeSource.stop(); nativeSource.disconnect(); } catch {}
    nativeSource = null;
  }
  if (shifter && isPlaying) { try { shifter.disconnect(); } catch { /* disconnected */ } }
  if (fadeGainNode && audioContext) {
    try {
      fadeGainNode.gain.cancelScheduledValues(audioContext.currentTime);
      fadeGainNode.gain.setValueAtTime(1.0, audioContext.currentTime);
    } catch {}
  }
  isPlaying = false; elements.play.classList.remove("is-playing");
  if (reset) {
    previewPercent = trimStartPct;
    if (shifter) shifter.percentagePlayed = trimStartPct / 100;
    drawWaveform(trimStartPct);
    updateTimeline(trimStartPct);
  }
}

function handlePreviewEnd() {
  if (playbackAnimFrame) { cancelAnimationFrame(playbackAnimFrame); playbackAnimFrame = null; }
  if (nativeSource) { try { nativeSource.disconnect(); } catch {} nativeSource = null; }
  if (shifter) { try { shifter.disconnect(); } catch {} }
  if (fadeGainNode && audioContext) {
    try {
      fadeGainNode.gain.cancelScheduledValues(audioContext.currentTime);
      fadeGainNode.gain.setValueAtTime(1.0, audioContext.currentTime);
    } catch {}
  }
  isPlaying = false;
  previewPercent = trimStartPct;
  elements.play.classList.remove("is-playing");
  drawWaveform(trimStartPct);
  updateTimeline(trimStartPct);
}

function buildPreviewGraph() {
  if (!decodedBuffer || !audioContext) return;
  stopPreview(false);
  if (shifter) { try { shifter.disconnect(); } catch {} shifter.off(); shifter = null; }
  eqNodes.forEach((node) => { try { node.disconnect(); } catch {} });
  if (matchGainNode) { try { matchGainNode.disconnect(); } catch {} matchGainNode = null; }
  if (fadeGainNode) { try { fadeGainNode.disconnect(); } catch {} fadeGainNode = null; }
  if (masterLimiterNode) { try { masterLimiterNode.disconnect(); } catch {} masterLimiterNode = null; }

  eqNodes = EQ_BANDS.map((band, index) => {
    const node = audioContext.createBiquadFilter();
    node.type = band.type; node.frequency.value = band.frequency; node.Q.value = 1.05; node.gain.value = eqGains[index];
    return node;
  });
  eqNodes.forEach((node, index) => {
    if (index < eqNodes.length - 1) node.connect(eqNodes[index + 1]);
  });

  matchGainNode = audioContext.createGain();
  matchGainNode.gain.setValueAtTime(matchVolumeEnabled ? matchedVolumeGainLinear : 1.0, audioContext.currentTime);

  fadeGainNode = audioContext.createGain();
  fadeGainNode.gain.setValueAtTime(1.0, audioContext.currentTime);

  masterLimiterNode = audioContext.createDynamicsCompressor();
  masterLimiterNode.threshold.setValueAtTime(-0.3, audioContext.currentTime);
  masterLimiterNode.knee.setValueAtTime(0, audioContext.currentTime);
  masterLimiterNode.ratio.setValueAtTime(20, audioContext.currentTime);
  masterLimiterNode.attack.setValueAtTime(0.002, audioContext.currentTime);
  masterLimiterNode.release.setValueAtTime(0.05, audioContext.currentTime);

  eqNodes[eqNodes.length - 1].connect(matchGainNode);
  matchGainNode.connect(fadeGainNode);
  fadeGainNode.connect(masterLimiterNode);
  masterLimiterNode.connect(audioContext.destination);

  shifter = new PitchShifter(audioContext, decodedBuffer, 4096, handlePreviewEnd);
  shifter.on("play", (detail) => {
    if (Math.abs(Number(elements.pitch.value)) >= 0.01) {
      previewPercent = clamp(detail.percentagePlayed, 0, 100);
      drawWaveform(previewPercent);
      updateTimeline(previewPercent);
      if (previewPercent >= trimEndPct - 0.1) {
        handlePreviewEnd();
      }
    }
  });
  shifter.percentagePlayed = previewPercent / 100;
  applyPreviewProcessing();
}

function scheduleFadePreview(startTime, offsetFromTrimStartSec, trimmedDurationSec) {
  if (!fadeGainNode || !audioContext) return;
  const t = startTime;
  fadeGainNode.gain.cancelScheduledValues(t);
  fadeGainNode.gain.setValueAtTime(1.0, t);

  const speed = Number(elements.speed.value);
  const totalProcessedDur = trimmedDurationSec / speed;
  const currentOffset = offsetFromTrimStartSec / speed;

  // Fade In
  if (fadeInEnabled && fadeInDurationSec > 0.05) {
    const safeFadeIn = Math.min(fadeInDurationSec, totalProcessedDur * 0.49);
    if (currentOffset < safeFadeIn) {
      const initialGain = Math.max(0.0001, currentOffset / safeFadeIn);
      fadeGainNode.gain.setValueAtTime(initialGain, t);
      fadeGainNode.gain.linearRampToValueAtTime(1.0, t + (safeFadeIn - currentOffset));
    }
  }

  // Fade Out
  if (fadeOutEnabled && fadeOutDurationSec > 0.05) {
    const safeFadeOut = Math.min(fadeOutDurationSec, totalProcessedDur * 0.49);
    const fadeOutStartReal = totalProcessedDur - safeFadeOut;
    if (currentOffset < fadeOutStartReal) {
      const startAt = t + (fadeOutStartReal - currentOffset);
      fadeGainNode.gain.setValueAtTime(1.0, startAt);
      fadeGainNode.gain.linearRampToValueAtTime(0.0001, t + (totalProcessedDur - currentOffset));
    } else if (currentOffset < totalProcessedDur) {
      const remainingGain = Math.max(0.0001, (totalProcessedDur - currentOffset) / safeFadeOut);
      fadeGainNode.gain.setValueAtTime(remainingGain, t);
      fadeGainNode.gain.linearRampToValueAtTime(0.0001, t + (totalProcessedDur - currentOffset));
    }
  }
}

function startPlaybackTracking() {
  if (playbackAnimFrame) cancelAnimationFrame(playbackAnimFrame);
  function track() {
    if (!isPlaying || !decodedBuffer) return;
    if (nativeSource) {
      const speed = Number(elements.speed.value);
      const elapsed = (audioContext.currentTime - nativePlayStartTime) * speed;
      const currentSec = nativePlayStartOffset + elapsed;
      previewPercent = clamp((currentSec / decodedBuffer.duration) * 100, 0, 100);
      drawWaveform(previewPercent);
      updateTimeline(previewPercent);
      if (previewPercent >= trimEndPct - 0.1) {
        handlePreviewEnd();
        return;
      }
    }
    playbackAnimFrame = requestAnimationFrame(track);
  }
  playbackAnimFrame = requestAnimationFrame(track);
}

function startNativePreview() {
  if (!decodedBuffer || !audioContext) return;
  const totalDur = decodedBuffer.duration;
  const trimStartSec = (trimStartPct / 100) * totalDur;
  const trimEndSec = (trimEndPct / 100) * totalDur;
  const trimmedDuration = Math.max(0.05, trimEndSec - trimStartSec);

  if (previewPercent < trimStartPct || previewPercent >= trimEndPct - 0.2) {
    previewPercent = trimStartPct;
  }
  if (nativeSource) {
    try { nativeSource.onended = null; nativeSource.stop(); nativeSource.disconnect(); } catch {}
    nativeSource = null;
  }
  nativeSource = audioContext.createBufferSource();
  nativeSource.buffer = decodedBuffer;
  const speed = Number(elements.speed.value);
  nativeSource.playbackRate.value = speed;
  nativeSource.connect(eqNodes[0]);

  const startOffset = clamp((previewPercent / 100) * totalDur, trimStartSec, trimEndSec);
  const remainingSourceDuration = Math.max(0.05, trimEndSec - startOffset);
  nativePlayStartTime = audioContext.currentTime;
  nativePlayStartOffset = startOffset;
  nativeSource.onended = () => {
    if (isPlaying && (!nativeSource || audioContext.currentTime - nativePlayStartTime >= remainingSourceDuration / speed - 0.05)) {
      handlePreviewEnd();
    }
  };
  nativeSource.start(0, startOffset, remainingSourceDuration);
  scheduleFadePreview(nativePlayStartTime, startOffset - trimStartSec, trimmedDuration);
  isPlaying = true;
  elements.play.classList.add("is-playing");
  startPlaybackTracking();
}

function startShifterPreview() {
  if (!shifter || !audioContext) return;
  if (previewPercent < trimStartPct || previewPercent >= trimEndPct - 0.2) {
    previewPercent = trimStartPct;
    shifter.percentagePlayed = trimStartPct / 100;
  }
  shifter.connect(eqNodes[0]);
  isPlaying = true;
  elements.play.classList.add("is-playing");
}

function applyPreviewProcessing() {
  const speed = Number(elements.speed.value);
  const pitch = Number(elements.pitch.value);
  trackVolumeDb = Number(elements.volume?.value || 0);
  const totalVolumeDb = trackVolumeDb + (matchVolumeEnabled ? matchedVolumeGainDb : 0);
  const totalGainLinear = 10 ** (totalVolumeDb / 20);

  if (nativeSource && audioContext) {
    nativeSource.playbackRate.setValueAtTime(speed, audioContext.currentTime);
  }
  if (shifter) {
    shifter.tempo = 1;
    shifter.rate = speed;
    shifter.pitchSemitones = pitch;
  }
  eqNodes.forEach((node, index) => {
    if (node) node.gain.setValueAtTime(eqGains[index], audioContext?.currentTime || 0);
  });
  if (matchGainNode && audioContext) {
    matchGainNode.gain.setTargetAtTime(totalGainLinear, audioContext.currentTime, 0.02);
  }
  updateTimeline();
}

async function togglePreview() {
  if (!decodedBuffer || !audioContext) return;
  await audioContext.resume();
  if (isPlaying) { stopPreview(false); return; }
  const pitch = Number(elements.pitch.value);
  if (Math.abs(pitch) < 0.01) {
    startNativePreview();
  } else {
    startShifterPreview();
  }
}

function seekPreview(percent) {
  if (!decodedBuffer) return;
  const resume = isPlaying;
  if (resume) stopPreview(false);
  const minPct = (trimStartPct > 0.5 || trimEndPct < 99.5) ? trimStartPct : 0;
  const maxPct = (trimStartPct > 0.5 || trimEndPct < 99.5) ? trimEndPct : 100;
  previewPercent = clamp(percent, minPct, maxPct);
  if (shifter) shifter.percentagePlayed = previewPercent / 100;
  drawWaveform(previewPercent);
  updateTimeline(previewPercent);
  if (resume) {
    const pitch = Number(elements.pitch.value);
    if (Math.abs(pitch) < 0.01) {
      startNativePreview();
    } else {
      startShifterPreview();
    }
  }
}

function totalShift() { return Number(elements.pitch.value) + 12 * Math.log2(Number(elements.speed.value)); }
function updateOutputKey() {
  if (detected.keyIndex === null) { elements.outputKey.textContent = "—"; elements.outputKeyDetail.textContent = "Upload a track to detect its key"; return; }
  const shift = totalShift();
  const nearest = Math.round(shift);
  const keyIndex = (detected.keyIndex + nearest + 120) % 12;
  const cents = Math.round((shift - nearest) * 100);
  elements.outputKey.textContent = `${NOTE_NAMES[keyIndex]} ${detected.scale}`;
  elements.outputKeyDetail.textContent = cents ? `${signed(shift)} st · ${signed(cents, 0)} cents from key` : `${signed(shift)} st total shift`;
}
function updateMotionUI() {
  const speed = Number(elements.speed.value);
  const pitch = Number(elements.pitch.value);
  elements.speedValue.textContent = `${speed.toFixed(2)}×`;
  elements.pitchValue.textContent = `${signed(pitch)} st`;
  elements.naturalPitch.textContent = `Natural pitch: ${signed(12 * Math.log2(speed))} st`;
  setRangeFill(elements.speed); setRangeFill(elements.pitch);
  if (elements.volume) setRangeFill(elements.volume);
  $$('[data-speed]').forEach((button) => button.classList.toggle("is-active", Math.abs(Number(button.dataset.speed) - speed) < .005));
  updateOutputKey(); applyPreviewProcessing(); updateTrimUI(); updateFadeUI(); drawWaveform(); resetResult();
}
function applyTargetKey() {
  if (["source", "custom"].includes(elements.targetKey.value) || detected.keyIndex === null) return;
  const desired = Number(elements.targetKey.value);
  let interval = desired - detected.keyIndex;
  while (interval > 6) interval -= 12;
  while (interval < -6) interval += 12;
  const natural = 12 * Math.log2(Number(elements.speed.value));
  elements.pitch.value = String(clamp(Math.round((interval - natural) * 10) / 10, -12, 12));
  updateMotionUI();
}

function updateKnob(index) {
  const knob = elements.eqKnobs.children[index];
  if (!knob) return;
  const gain = eqGains[index];
  knob.setAttribute("aria-valuenow", gain.toFixed(1));
  knob.querySelector(".eq-knob-face").style.setProperty("--angle", `${gain / 12 * 135}deg`);
  knob.querySelector(".eq-knob-face").style.setProperty("--gain", String(gain));
  knob.querySelector("output").textContent = `${signed(gain)} dB`;
  if (eqNodes[index]) eqNodes[index].gain.value = gain;
}
function setEqGain(index, value, manual = true) {
  eqGains[index] = Math.round(clamp(value, -12, 12) * 2) / 2;
  updateKnob(index);
  if (manual) $$('[data-eq-preset]').forEach((button) => button.classList.remove("is-active"));
  resetResult();
}
function buildEqKnobs() {
  elements.eqKnobs.replaceChildren();
  EQ_BANDS.forEach((band, index) => {
    const knob = document.createElement("div");
    knob.className = "eq-knob"; knob.tabIndex = 0;
    knob.setAttribute("role", "slider"); knob.setAttribute("aria-label", `${band.label} hertz gain`);
    knob.setAttribute("aria-valuemin", "-12"); knob.setAttribute("aria-valuemax", "12");
    knob.innerHTML = `<span class="eq-knob-face"><i></i></span><output>0.0 dB</output><strong>${band.label}</strong><small>Hz</small>`;
    let startY = 0; let startGain = 0;
    knob.addEventListener("pointerdown", (event) => { event.preventDefault(); startY = event.clientY; startGain = eqGains[index]; knob.setPointerCapture(event.pointerId); });
    knob.addEventListener("pointermove", (event) => { if (knob.hasPointerCapture(event.pointerId)) setEqGain(index, startGain + (startY - event.clientY) * .12); });
    knob.addEventListener("dblclick", () => setEqGain(index, 0));
    knob.addEventListener("keydown", (event) => {
      if (!["ArrowUp", "ArrowRight", "ArrowDown", "ArrowLeft", "Home"].includes(event.key)) return;
      event.preventDefault();
      if (event.key === "Home") setEqGain(index, 0);
      else setEqGain(index, eqGains[index] + (["ArrowUp", "ArrowRight"].includes(event.key) ? .5 : -.5));
    });
    elements.eqKnobs.append(knob); updateKnob(index);
  });
}
function applyEqPreset(name) {
  if (!EQ_PRESETS[name]) return;
  eqGains = [...EQ_PRESETS[name]]; eqGains.forEach((_, index) => updateKnob(index));
  $$('[data-eq-preset]').forEach((button) => button.classList.toggle("is-active", button.dataset.eqPreset === name));
  resetResult();
}

function updateVolumeMatchUI() {
  if (!referenceLoudness || !sourceLoudness) {
    elements.matchVolumeDetail.textContent = "Upload reference to calculate loudness";
    elements.matchVolumeBadge.textContent = "+0.0 dB";
    elements.matchVolumeBadge.classList.add("is-inactive");
    return;
  }
  const res = calculateVolumeMatch(sourceLoudness, referenceLoudness);
  matchedVolumeGainDb = res.gainDb;
  matchedVolumeGainLinear = res.gainLinear;
  const sign = matchedVolumeGainDb > 0 ? "+" : "";
  elements.matchVolumeBadge.textContent = `${sign}${matchedVolumeGainDb.toFixed(1)} dB`;
  elements.matchVolumeDetail.textContent = `Ref: ${referenceLoudness.lufs.toFixed(1)} LUFS · Track: ${sourceLoudness.lufs.toFixed(1)} LUFS`;
  elements.matchVolumeBadge.classList.toggle("is-inactive", !matchVolumeEnabled);
}

function applyVolumeMatch(enable) {
  matchVolumeEnabled = enable;
  elements.matchVolumeToggle.checked = enable;
  updateVolumeMatchUI();
  applyPreviewProcessing();
  resetResult();
}

function updateVolumeUI() {
  if (!elements.volume) return;
  const val = Number(elements.volume.value);
  trackVolumeDb = val;
  if (elements.volumeValue) {
    elements.volumeValue.textContent = val > 0 ? `+${val.toFixed(1)} dB` : `${val.toFixed(1)} dB`;
  }
  setRangeFill(elements.volume);
  applyPreviewProcessing();
  resetResult();
}

function applyReferenceMatch() {
  if (!sourceEqSpectrum || !referenceEqSpectrum) return;
  const strength = Number(elements.matchStrength.value) / 100;
  eqGains = createEqMatchCurve(sourceEqSpectrum, referenceEqSpectrum, strength)
    .map((gain) => Math.round(gain * 2) / 2);
  eqGains.forEach((_, index) => updateKnob(index));
  $$('[data-eq-preset]').forEach((button) => button.classList.remove("is-active"));
  elements.matchStrengthValue.textContent = `${elements.matchStrength.value}%`;
  updateVolumeMatchUI();
  elements.referenceStatus.textContent = matchVolumeEnabled
    ? "Tone & volume matched · preview ready"
    : "Tone matched · preview ready";
  resetResult();
}

function clearReference(resetEq = true) {
  referenceFile = null;
  referenceEqSpectrum = null;
  referenceLoudness = null;
  matchedVolumeGainDb = 0;
  matchedVolumeGainLinear = 1;
  matchVolumeEnabled = false;
  if (elements.matchVolumeToggle) elements.matchVolumeToggle.checked = false;
  elements.referenceInput.value = "";
  elements.referencePrompt.textContent = "Drop reference audio here";
  elements.referenceStatus.textContent = "or click to browse";
  elements.referenceControls.classList.add("is-hidden");
  elements.referenceDrop.classList.remove("has-reference", "is-analyzing");
  updateVolumeMatchUI();
  if (resetEq) applyEqPreset("flat");
  applyPreviewProcessing();
  resetResult();
}

async function setReferenceFile(file) {
  if (!file || !decodedBuffer || !audioContext) return;
  if (file.size > 500 * 1024 * 1024) { showMessage("Please choose a reference file smaller than 500 MB."); return; }
  referenceFile = file;
  referenceEqSpectrum = null;
  referenceLoudness = null;
  elements.referencePrompt.textContent = file.name;
  elements.referenceStatus.textContent = "Analyzing frequency & loudness…";
  elements.referenceControls.classList.add("is-hidden");
  elements.referenceDrop.classList.remove("has-reference");
  elements.referenceDrop.classList.add("is-analyzing");
  clearMessage();
  try {
    const bytes = await file.arrayBuffer();
    const referenceBuffer = await audioContext.decodeAudioData(bytes.slice(0));
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 10)));
    sourceEqSpectrum ||= analyzeEqSpectrum(decodedBuffer, EQ_BANDS.map((band) => band.frequency));
    sourceLoudness ||= measureLoudness(decodedBuffer);
    const spectrum = analyzeEqSpectrum(referenceBuffer, EQ_BANDS.map((band) => band.frequency));
    const loudness = measureLoudness(referenceBuffer);
    if (referenceFile !== file) return;
    referenceEqSpectrum = spectrum;
    referenceLoudness = loudness;
    elements.referenceName.textContent = file.name;
    elements.referenceControls.classList.remove("is-hidden");
    elements.referenceDrop.classList.remove("is-analyzing");
    elements.referenceDrop.classList.add("has-reference");
    updateVolumeMatchUI();
    applyReferenceMatch();
  } catch (error) {
    console.error(error);
    if (referenceFile !== file) return;
    referenceFile = null;
    referenceEqSpectrum = null;
    referenceLoudness = null;
    elements.referenceDrop.classList.remove("is-analyzing", "has-reference");
    elements.referencePrompt.textContent = "Could not read that reference";
    elements.referenceStatus.textContent = "Try WAV, MP3, FLAC, OGG, AAC, or M4A";
  }
}

async function setFile(file) {
  if (!file) return;
  if (file.size > 500 * 1024 * 1024) { showMessage("Please choose a file smaller than 500 MB so your browser has enough memory to process it."); return; }
  stopPreview(true); sourceFile = file; sourceArrayBuffer = null; sourceEqSpectrum = null; sourceLoudness = null; clearReference(false); applyEqPreset("flat"); resetResult();
  elements.fileName.textContent = file.name;
  elements.fileMeta.textContent = `${bytesLabel(file.size)} · Reading audio details…`;
  elements.outputName.value = cleanName(file.name);
  elements.editorWorkspace.classList.remove("is-hidden"); elements.filePanel.classList.remove("is-hidden"); elements.processingPanel.classList.remove("is-hidden"); elements.uploadZone.classList.add("is-hidden");
  elements.convert.disabled = false; elements.engineStatus.textContent = "Analyzing track locally…";
  try {
    const bytes = await file.arrayBuffer();
    sourceArrayBuffer = bytes;
    if (audioContext) await audioContext.close().catch(() => {});
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    decodedBuffer = await audioContext.decodeAudioData(bytes.slice(0));
    const rate = (decodedBuffer.sampleRate / 1000).toFixed(decodedBuffer.sampleRate % 1000 ? 1 : 0);
    elements.fileMeta.textContent = `${bytesLabel(file.size)} · ${timeLabel(decodedBuffer.duration)} · ${rate} kHz · ${decodedBuffer.numberOfChannels === 1 ? "Mono" : `${decodedBuffer.numberOfChannels} channels`}`;
    calculatePeaks(decodedBuffer); previewPercent = 0;
    trimStartPct = 0; trimEndPct = 100; fadeInEnabled = false; fadeOutEnabled = false;
    if (elements.fadeInToggle) elements.fadeInToggle.checked = false;
    if (elements.fadeOutToggle) elements.fadeOutToggle.checked = false;
    updateTrimUI(); updateFadeUI(); setWaveTool("cursor");
    drawWaveform(0); updateTimeline(0); buildPreviewGraph();
    sourceLoudness = measureLoudness(decodedBuffer);
    await analyzeTrack(file, decodedBuffer, bytes.slice(0, Math.min(bytes.byteLength, 65536)));
    elements.engineStatus.textContent = "Track analyzed · preview ready";
  } catch (error) {
    console.error(error); decodedBuffer = null; elements.processingPanel.classList.add("is-hidden");
    showMessage("This browser could not preview or analyze that source format, but you can still convert it.");
    elements.engineStatus.textContent = "Preview unavailable · converter ready";
  }
}
function removeFile() {
  stopPreview(true); sourceFile = null; sourceArrayBuffer = null; decodedBuffer = null; sourceEqSpectrum = null; sourceLoudness = null; clearReference(false); waveformPeaks = []; detected = { bpm: null, keyIndex: null, scale: null };
  trimStartPct = 0; trimEndPct = 100; fadeInEnabled = false; fadeOutEnabled = false;
  if (elements.fadeInToggle) elements.fadeInToggle.checked = false;
  if (elements.fadeOutToggle) elements.fadeOutToggle.checked = false;
  updateTrimUI(); updateFadeUI(); setWaveTool("cursor");
  resetResult();
  if (shifter) shifter.off(); shifter = null;
  eqNodes.forEach((node) => { try { node.disconnect(); } catch { /* no-op */ } }); eqNodes = [];
  if (matchGainNode) { try { matchGainNode.disconnect(); } catch {} matchGainNode = null; }
  if (fadeGainNode) { try { fadeGainNode.disconnect(); } catch {} fadeGainNode = null; }
  if (masterLimiterNode) { try { masterLimiterNode.disconnect(); } catch {} masterLimiterNode = null; }
  if (audioContext) audioContext.close().catch(() => {}); audioContext = null;
  elements.fileInput.value = ""; elements.editorWorkspace.classList.add("is-hidden"); elements.filePanel.classList.add("is-hidden"); elements.processingPanel.classList.add("is-hidden"); elements.uploadZone.classList.remove("is-hidden");
  if (elements.volume) { elements.volume.value = "0"; elements.volumeValue.textContent = "+0.0 dB"; }
  trackVolumeDb = 0;
  elements.convert.disabled = true; elements.engineStatus.textContent = engineLoaded ? "Engine ready · local mode" : "Engine loads when needed";
}

async function loadEngine() {
  if (engineLoaded) return;
  elements.engineStatus.textContent = "Loading conversion engine…";
  setProgress(4, "Initializing conversion engine…");
  ffmpeg = new FFmpeg();
  ffmpeg.on("progress", ({ progress }) => setProgress(12 + Math.min(progress, 1) * 86, "Rendering your edits…"));
  ffmpeg.on("log", ({ message }) => {
    if (message.includes("time=")) elements.engineStatus.textContent = "Rendering locally";
  });

  let coreURL = null;
  let wasmURL = null;

  try {
    setProgress(6, "Loading conversion engine…");
    const wasmRes = await fetch(`${location.origin}/vendor/ffmpeg/ffmpeg-core.wasm`).catch(() => null);
    if (wasmRes && wasmRes.ok) {
      setProgress(8, "Loading audio engine wasm…");
      const wasmBuf = await wasmRes.arrayBuffer();
      wasmURL = URL.createObjectURL(new Blob([wasmBuf], { type: "application/wasm" }));
    } else {
      setProgress(7, "Loading audio engine parts…");
      const parts = await Promise.all([1, 2].map(async (part) => {
        const response = await fetch(`${location.origin}/vendor/ffmpeg/ffmpeg-core.wasm.part${part}`);
        if (!response.ok) throw new Error(`Missing engine part ${part}`);
        return response.arrayBuffer();
      }));
      wasmURL = URL.createObjectURL(new Blob(parts, { type: "application/wasm" }));
    }

    coreURL = await toBlobURL(`${location.origin}/vendor/ffmpeg/ffmpeg-core.js`, "text/javascript");
    setProgress(10, "Starting audio engine…");
    await ffmpeg.load({ coreURL, wasmURL });
  } catch (localError) {
    console.warn("Local engine load encountered issue, falling back to CDN:", localError);
    setProgress(8, "Loading engine fallback (CDN)…");
    try {
      const baseURL = "https://unpkg.com/@ffmpeg/core@0.12.10/dist/esm";
      coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, "text/javascript");
      wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, "application/wasm");
      await ffmpeg.load({ coreURL, wasmURL });
    } catch (cdnError) {
      console.error("All engine loading methods failed:", cdnError);
      throw new Error("Unable to load conversion engine: " + (localError.message || localError));
    }
  }

  engineLoaded = true;
  elements.engineStatus.textContent = "Engine ready · local mode";
  setProgress(12, "Engine ready");
}

function codecArgs(format) {
  let depth = elements.depth.value;
  if (depth === "original") {
    depth = detectedBitDepthValue || "24";
  }
  if (format === "wav") {
    if (depth === "32") return ["-c:a", "pcm_f32le"];
    return ["-c:a", `pcm_s${depth}le`];
  }
  if (format === "aiff") {
    if (depth === "32") return ["-c:a", "pcm_f32be"];
    return ["-c:a", `pcm_s${depth}be`];
  }
  if (format === "flac") {
    return depth === "16"
      ? ["-c:a", "flac", "-sample_fmt", "s16", "-compression_level", "8"]
      : ["-c:a", "flac", "-sample_fmt", "s32", "-bits_per_raw_sample", "24", "-compression_level", "8"];
  }
  if (format === "mp3") return ["-c:a", "libmp3lame", "-b:a", elements.bitrate.value];
  if (format === "ogg") return ["-c:a", "libvorbis", "-b:a", elements.bitrate.value];
  return ["-c:a", "aac", "-b:a", elements.bitrate.value];
}

function audioFilters() {
  const isOriginalRate = elements.rate.value === "original";
  const sourceRate = decodedBuffer?.sampleRate || 44100;
  const targetRate = isOriginalRate ? sourceRate : Number(elements.rate.value);
  const speed = Number(elements.speed.value);
  const pitchSemitones = Number(elements.pitch.value);
  const pitchRatio = 2 ** (pitchSemitones / 12);
  const hasSpeedChange = Math.abs(speed - 1) > 0.001;
  const hasPitchChange = Math.abs(pitchSemitones) > 0.01;
  const needsResample = !isOriginalRate && targetRate !== sourceRate;

  const filters = [];

  // 1. Cut / Trim filter (applied first before speed/pitch manipulation)
  const sourceDuration = decodedBuffer?.duration || 0;
  let trimmedSourceDur = sourceDuration;
  const isTrimmed = sourceDuration > 0 && (trimStartPct > 0.3 || trimEndPct < 99.7);
  if (isTrimmed) {
    const startSec = Math.max(0, (trimStartPct / 100) * sourceDuration);
    const endSec = Math.min(sourceDuration, (trimEndPct / 100) * sourceDuration);
    trimmedSourceDur = Math.max(0.1, endSec - startSec);
    filters.push(`atrim=start=${startSec.toFixed(3)}:end=${endSec.toFixed(3)},asetpts=PTS-STARTPTS`);
  }

  // 2. Speed and Pitch:
  // Pre-resampling to 48000 guarantees exact retiming ratio regardless of input file sample rate
  if (hasPitchChange) {
    const tempoCorrection = clamp(1 / pitchRatio, 0.5, 2.0);
    filters.push("aresample=48000");
    filters.push(`asetrate=${Math.round(48000 * speed * pitchRatio)}`);
    filters.push(`aresample=${targetRate}`);
    filters.push(`atempo=${tempoCorrection.toFixed(6)}`);
  } else if (hasSpeedChange) {
    filters.push("aresample=48000");
    filters.push(`asetrate=${Math.round(48000 * speed)}`);
    filters.push(`aresample=${targetRate}`);
  } else if (needsResample) {
    filters.push(`aresample=${targetRate}`);
  }

  // 3. 10-Band EQ
  let hasBoost = false;
  EQ_BANDS.forEach((band, index) => {
    const gain = eqGains[index];
    if (Math.abs(gain) >= 0.25 && band.frequency < targetRate * 0.48) {
      filters.push(`equalizer=f=${band.frequency}:t=q:w=1.05:g=${gain.toFixed(1)}`);
      if (gain > 0.4) hasBoost = true;
    }
  });

  // 4. Track volume + Reference volume match
  trackVolumeDb = Number(elements.volume?.value || 0);
  const totalVolumeDb = trackVolumeDb + (matchVolumeEnabled ? matchedVolumeGainDb : 0);
  if (Math.abs(totalVolumeDb) >= 0.05) {
    filters.push(`volume=${totalVolumeDb.toFixed(2)}dB`);
    if (totalVolumeDb > 0.1) hasBoost = true;
  }

  // 5. Fade In & Fade Out
  const processedDur = (trimmedSourceDur > 0 ? trimmedSourceDur : 10) / speed;
  if (fadeInEnabled && fadeInDurationSec > 0.05) {
    const safeFadeIn = Math.min(fadeInDurationSec, processedDur * 0.49);
    filters.push(`afade=t=in:ss=0:d=${safeFadeIn.toFixed(3)}:curve=tri`);
  }
  if (fadeOutEnabled && fadeOutDurationSec > 0.05) {
    const safeFadeOut = Math.min(fadeOutDurationSec, processedDur * 0.49);
    const fadeOutStart = Math.max(0, processedDur - safeFadeOut);
    filters.push(`afade=t=out:st=${fadeOutStart.toFixed(3)}:d=${safeFadeOut.toFixed(3)}:curve=tri`);
  }

  // 6. Studio brickwall limiter to protect against digital clipping on boosts
  if (hasBoost || hasPitchChange || hasSpeedChange) {
    filters.push("alimiter=level_in=1:level_out=1:limit=0.98:attack=5:release=50:asc=1");
  }

  return filters.length ? filters.join(",") : "anull";
}

async function convertAudio() {
  if (!sourceFile) return;
  const format = elements.format.value;
  if (resultBlob && resultUrl) {
    const link = document.createElement("a");
    link.href = resultUrl;
    link.download = `${cleanName(elements.outputName.value)}.${format}`;
    link.click();
    return;
  }
  stopPreview(false);
  clearMessage();
  elements.convert.disabled = true;
  elements.convert.querySelector(".convert-label").textContent = "Rendering…";
  const input = `input-${Date.now()}.${sourceFile.name.split(".").pop()?.toLowerCase() || "audio"}`;
  const output = `output-${Date.now()}.${format}`;
  try {
    await loadEngine();
    setProgress(15, "Transferring audio data…");
    let fileData;
    try {
      if (sourceArrayBuffer) {
        fileData = new Uint8Array(sourceArrayBuffer);
      } else if (sourceFile.arrayBuffer) {
        const buf = await sourceFile.arrayBuffer();
        sourceArrayBuffer = buf;
        fileData = new Uint8Array(buf);
      } else {
        fileData = await fetchFile(sourceFile);
      }
    } catch (readErr) {
      console.warn("Direct buffer read error, fallback to fetchFile:", readErr);
      try {
        fileData = await fetchFile(sourceFile);
      } catch (fallbackErr) {
        throw new Error("Audio file data could not be read. Please re-select your file.");
      }
    }
    await ffmpeg.writeFile(input, fileData);
    const filterString = audioFilters();
    console.log("Exporting with filters:", filterString);
    const args = ["-i", input, "-vn", "-af", filterString];
    if (elements.channels.value !== "original") args.push("-ac", elements.channels.value);
    if (elements.rate.value !== "original") args.push("-ar", elements.rate.value);
    args.push(...codecArgs(format), output);
    console.log("FFmpeg args:", args);
    const ret = await ffmpeg.exec(args);
    if (ret !== 0) {
      throw new Error(`FFmpeg exited with error code ${ret}`);
    }
    const data = await ffmpeg.readFile(output);
    resultBlob = new Blob([data], { type: MIME[format] });
    resultUrl = URL.createObjectURL(resultBlob);
    setProgress(100, "Edited audio ready");
    showMessage(`Ready: ${cleanName(elements.outputName.value)}.${format} · ${bytesLabel(resultBlob.size)}`, true);
    elements.convert.classList.add("is-ready");
    elements.engineStatus.textContent = "Complete · downloaded";
    
    // Automatically trigger instant download
    const link = document.createElement("a");
    link.href = resultUrl;
    link.download = `${cleanName(elements.outputName.value)}.${format}`;
    link.click();

    await ffmpeg.deleteFile(input).catch(() => {});
    await ffmpeg.deleteFile(output).catch(() => {});
  } catch (error) {
    console.error("Render failed:", error);
    showMessage(`Render failed: ${error.message || "Try WAV output or reset filters."}`);
    elements.progressWrap.classList.add("is-hidden");
    elements.engineStatus.textContent = "Render stopped";
  } finally {
    elements.convert.disabled = false;
    if (resultBlob) {
      elements.convert.querySelector(".convert-label").textContent = "Download again";
    } else {
      elements.convert.querySelector(".convert-label").textContent = "Render edited audio";
    }
  }
}

elements.chooseButton.addEventListener("click", (event) => { event.stopPropagation(); elements.fileInput.click(); });
elements.uploadZone.addEventListener("click", () => elements.fileInput.click());
elements.uploadZone.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); elements.fileInput.click(); } });
elements.fileInput.addEventListener("change", () => setFile(elements.fileInput.files?.[0]));
["dragenter", "dragover"].forEach((name) => elements.uploadZone.addEventListener(name, (event) => { event.preventDefault(); elements.uploadZone.classList.add("is-dragging"); }));
["dragleave", "drop"].forEach((name) => elements.uploadZone.addEventListener(name, (event) => { event.preventDefault(); elements.uploadZone.classList.remove("is-dragging"); }));
elements.uploadZone.addEventListener("drop", (event) => setFile(event.dataTransfer.files?.[0]));
elements.remove.addEventListener("click", removeFile); elements.play.addEventListener("click", togglePreview);
elements.waveform.addEventListener("pointerdown", (event) => {
  if (!decodedBuffer) return;
  try { elements.waveform.setPointerCapture(event.pointerId); } catch {}
  const rect = elements.waveform.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const pct = clamp((x / rect.width) * 100, 0, 100);
  const width = rect.width || 1;
  const trimStartX = (trimStartPct / 100) * width;
  const trimEndX = (trimEndPct / 100) * width;
  const totalDur = processedDuration() || 1;

  if (activeWaveTool === "cursor") {
    pointerDragMode = "seek";
    seekPreview(pct);
  } else if (activeWaveTool === "trim") {
    if (Math.abs(x - trimStartX) <= 14) {
      pointerDragMode = "trim-start";
    } else if (Math.abs(x - trimEndX) <= 14) {
      pointerDragMode = "trim-end";
    } else {
      pointerDragMode = "trim-create";
      trimDragAnchorPct = pct;
      if (Math.abs(pct - trimStartPct) <= Math.abs(pct - trimEndPct)) {
        trimStartPct = clamp(pct, 0, trimEndPct - 1);
      } else {
        trimEndPct = clamp(pct, trimStartPct + 1, 100);
      }
      updateTrimUI();
      drawWaveform();
      resetResult();
    }
  } else if (activeWaveTool === "fadein") {
    pointerDragMode = "fadein";
    fadeInEnabled = true;
    const startSec = (trimStartPct / 100) * totalDur;
    const clickSec = (pct / 100) * totalDur;
    const clipDur = ((trimEndPct - trimStartPct) / 100) * totalDur;
    const maxFade = Math.max(0.2, clipDur * 0.49);
    fadeInDurationSec = clamp(Number(Math.max(0.1, clickSec - startSec).toFixed(1)), 0.1, maxFade);
    updateFadeUI();
    drawWaveform();
    resetResult();
  } else if (activeWaveTool === "fadeout") {
    pointerDragMode = "fadeout";
    fadeOutEnabled = true;
    const endSec = (trimEndPct / 100) * totalDur;
    const clickSec = (pct / 100) * totalDur;
    const clipDur = ((trimEndPct - trimStartPct) / 100) * totalDur;
    const maxFade = Math.max(0.2, clipDur * 0.49);
    fadeOutDurationSec = clamp(Number(Math.max(0.1, endSec - clickSec).toFixed(1)), 0.1, maxFade);
    updateFadeUI();
    drawWaveform();
    resetResult();
  }
});

elements.waveform.addEventListener("pointermove", (event) => {
  if (!decodedBuffer) return;
  const rect = elements.waveform.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const pct = clamp((x / rect.width) * 100, 0, 100);
  const width = rect.width || 1;
  const trimStartX = (trimStartPct / 100) * width;
  const trimEndX = (trimEndPct / 100) * width;
  const totalDur = processedDuration() || 1;

  if (!pointerDragMode) {
    if (activeWaveTool === "trim") {
      if (Math.abs(x - trimStartX) <= 14 || Math.abs(x - trimEndX) <= 14) {
        elements.waveform.style.cursor = "ew-resize";
      } else {
        elements.waveform.style.cursor = "col-resize";
      }
    }
    return;
  }

  if (pointerDragMode === "seek") {
    seekPreview(pct);
  } else if (pointerDragMode === "trim-start") {
    trimStartPct = clamp(pct, 0, trimEndPct - 1);
    updateTrimUI();
    drawWaveform();
    resetResult();
  } else if (pointerDragMode === "trim-end") {
    trimEndPct = clamp(pct, trimStartPct + 1, 100);
    updateTrimUI();
    drawWaveform();
    resetResult();
  } else if (pointerDragMode === "trim-create") {
    if (Math.abs(pct - trimDragAnchorPct) > 0.5) {
      trimStartPct = clamp(Math.min(trimDragAnchorPct, pct), 0, 99);
      trimEndPct = clamp(Math.max(trimDragAnchorPct, pct), trimStartPct + 1, 100);
      updateTrimUI();
      drawWaveform();
      resetResult();
    }
  } else if (pointerDragMode === "fadein") {
    const startSec = (trimStartPct / 100) * totalDur;
    const clickSec = (pct / 100) * totalDur;
    const clipDur = ((trimEndPct - trimStartPct) / 100) * totalDur;
    const maxFade = Math.max(0.2, clipDur * 0.49);
    fadeInDurationSec = clamp(Number(Math.max(0.1, clickSec - startSec).toFixed(1)), 0.1, maxFade);
    updateFadeUI();
    drawWaveform();
    resetResult();
  } else if (pointerDragMode === "fadeout") {
    const endSec = (trimEndPct / 100) * totalDur;
    const clickSec = (pct / 100) * totalDur;
    const clipDur = ((trimEndPct - trimStartPct) / 100) * totalDur;
    const maxFade = Math.max(0.2, clipDur * 0.49);
    fadeOutDurationSec = clamp(Number(Math.max(0.1, endSec - clickSec).toFixed(1)), 0.1, maxFade);
    updateFadeUI();
    drawWaveform();
    resetResult();
  }
});

const endWavePointer = (event) => {
  if (pointerDragMode) {
    try { elements.waveform.releasePointerCapture(event.pointerId); } catch {}
    pointerDragMode = null;
  }
};
elements.waveform.addEventListener("pointerup", endWavePointer);
elements.waveform.addEventListener("pointercancel", endWavePointer);

$$(".wave-tool-btn").forEach((button) => {
  button.addEventListener("click", () => setWaveTool(button.dataset.tool));
});

if (elements.resetTrimBtn) {
  elements.resetTrimBtn.addEventListener("click", () => {
    trimStartPct = 0;
    trimEndPct = 100;
    updateTrimUI();
    drawWaveform();
    resetResult();
  });
}

if (elements.fadeInToggle) {
  elements.fadeInToggle.addEventListener("change", (e) => {
    fadeInEnabled = e.target.checked;
    if (fadeInEnabled && fadeInDurationSec < 0.2) fadeInDurationSec = 2.0;
    updateFadeUI();
    drawWaveform();
    resetResult();
  });
}

if (elements.fadeOutToggle) {
  elements.fadeOutToggle.addEventListener("change", (e) => {
    fadeOutEnabled = e.target.checked;
    if (fadeOutEnabled && fadeOutDurationSec < 0.2) fadeOutDurationSec = 2.0;
    updateFadeUI();
    drawWaveform();
    resetResult();
  });
}

elements.waveform.addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const minPct = (trimStartPct > 0.5 || trimEndPct < 99.5) ? trimStartPct : 0;
  const maxPct = (trimStartPct > 0.5 || trimEndPct < 99.5) ? trimEndPct : 100;
  if (event.key === "Home") seekPreview(minPct);
  else if (event.key === "End") seekPreview(maxPct);
  else seekPreview(previewPercent + (event.key === "ArrowRight" ? 5 : -5));
});
elements.format.addEventListener("change", updateFormat);
[elements.rate, elements.depth, elements.bitrate, elements.channels].forEach((control) => control.addEventListener("change", resetResult));
elements.outputName.addEventListener("input", () => { if (resultBlob) showMessage("The downloaded file will use your updated name.", true); });
elements.speed.addEventListener("input", () => { if (!["source", "custom"].includes(elements.targetKey.value)) applyTargetKey(); else updateMotionUI(); });
elements.pitch.addEventListener("input", () => { elements.targetKey.value = "custom"; updateMotionUI(); });
if (elements.volume) {
  elements.volume.addEventListener("input", updateVolumeUI);
  elements.volume.addEventListener("change", updateVolumeUI);
}
elements.targetKey.addEventListener("change", () => { if (elements.targetKey.value === "source") { elements.pitch.value = "0"; updateMotionUI(); } else if (elements.targetKey.value !== "custom") applyTargetKey(); });
elements.resetMotion.addEventListener("click", () => {
  elements.speed.value = "1";
  elements.pitch.value = "0";
  elements.targetKey.value = "source";
  if (elements.volume) {
    elements.volume.value = "0";
    if (elements.volumeValue) elements.volumeValue.textContent = "+0.0 dB";
    setRangeFill(elements.volume);
    trackVolumeDb = 0;
  }
  updateMotionUI();
});
$$('[data-speed]').forEach((button) => button.addEventListener("click", () => { elements.speed.value = button.dataset.speed; if (!["source", "custom"].includes(elements.targetKey.value)) applyTargetKey(); else updateMotionUI(); }));
$$('[data-eq-preset]').forEach((button) => button.addEventListener("click", () => applyEqPreset(button.dataset.eqPreset)));
elements.referenceDrop.addEventListener("click", () => elements.referenceInput.click());
elements.referenceDrop.addEventListener("keydown", (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); elements.referenceInput.click(); } });
elements.referenceInput.addEventListener("change", () => setReferenceFile(elements.referenceInput.files?.[0]));
["dragenter", "dragover"].forEach((name) => elements.referenceDrop.addEventListener(name, (event) => { event.preventDefault(); event.stopPropagation(); elements.referenceDrop.classList.add("is-dragging"); }));
["dragleave", "drop"].forEach((name) => elements.referenceDrop.addEventListener(name, (event) => { event.preventDefault(); event.stopPropagation(); elements.referenceDrop.classList.remove("is-dragging"); }));
elements.referenceDrop.addEventListener("drop", (event) => setReferenceFile(event.dataTransfer.files?.[0]));
elements.referenceRemove.addEventListener("click", () => clearReference(true));
elements.matchStrength.addEventListener("input", () => { setRangeFill(elements.matchStrength); applyReferenceMatch(); });
elements.matchVolumeToggle.addEventListener("change", (event) => applyVolumeMatch(event.target.checked));
elements.convert.addEventListener("click", convertAudio);
window.addEventListener("resize", () => drawWaveform());

buildEqKnobs(); setRangeFill(elements.speed); setRangeFill(elements.pitch); if (elements.volume) setRangeFill(elements.volume); setRangeFill(elements.matchStrength); updateFormat();

if (document.modelContext?.registerTool) {
  try {
    const lifecycle = new AbortController();
    void Promise.resolve(document.modelContext.registerTool({
      name: "configure_audio_edit", title: "Configure audio edit",
      description: "Set output format, sample rate, speed, pitch shift, and an EQ preset in Sigma Audio.",
      inputSchema: { type: "object", properties: {
        format: { type: "string", enum: ["wav", "mp3", "ogg", "flac", "m4a", "aac", "aiff"] },
        sampleRate: { type: "integer", enum: [44100, 48000, 88200, 96000, 192000] },
        speed: { type: "number", minimum: .5, maximum: 1.5 }, pitchSemitones: { type: "number", minimum: -12, maximum: 12 },
        eqPreset: { type: "string", enum: ["flat", "bass", "club", "vocals", "warm", "bright"] },
      }, additionalProperties: false }, annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: async ({ format, sampleRate, speed, pitchSemitones, eqPreset }) => {
        if (format) elements.format.value = format; if (sampleRate) elements.rate.value = String(sampleRate);
        if (speed !== undefined) elements.speed.value = String(clamp(speed, .5, 1.5));
        if (pitchSemitones !== undefined) { elements.pitch.value = String(clamp(pitchSemitones, -12, 12)); elements.targetKey.value = "custom"; }
        if (eqPreset) applyEqPreset(eqPreset); updateFormat(); updateMotionUI();
        return { configured: true, format: elements.format.value, sampleRate: Number(elements.rate.value), speed: Number(elements.speed.value), pitchSemitones: Number(elements.pitch.value), eqPreset: eqPreset || "unchanged" };
      },
    }, { signal: lifecycle.signal })).catch(() => {});
  } catch { /* WebMCP is optional. */ }
}
