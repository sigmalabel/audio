export const NOTE_NAMES = ["C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B"];

export function detectBitDepth(file, bytes) {
  const view = new DataView(bytes);
  const ext = file.name.split(".").pop()?.toLowerCase();
  const fourCC = (offset) => offset + 4 <= view.byteLength
    ? String.fromCharCode(view.getUint8(offset), view.getUint8(offset + 1), view.getUint8(offset + 2), view.getUint8(offset + 3)) : "";

  if (fourCC(0) === "RIFF" && fourCC(8) === "WAVE") {
    let offset = 12;
    while (offset + 8 < view.byteLength) {
      const size = view.getUint32(offset + 4, true);
      if (fourCC(offset) === "fmt " && offset + 24 <= view.byteLength) return `${view.getUint16(offset + 22, true)} bit`;
      offset += 8 + size + (size % 2);
    }
  }
  if (fourCC(0) === "FORM") {
    let offset = 12;
    while (offset + 8 < view.byteLength) {
      const size = view.getUint32(offset + 4, false);
      if (fourCC(offset) === "COMM" && offset + 16 <= view.byteLength) return `${view.getUint16(offset + 14, false)} bit`;
      offset += 8 + size + (size % 2);
    }
  }
  if (fourCC(0) === "fLaC" && view.byteLength >= 22) {
    const packed = view.getUint32(18, false);
    return `${((packed >>> 4) & 31) + 1} bit`;
  }
  if (["mp3", "m4a", "aac", "ogg", "oga", "opus", "wma"].includes(ext)) return "Lossy";
  return "—";
}

export function makeMono(buffer) {
  const length = Math.min(buffer.length, Math.round(buffer.sampleRate * 180));
  const mono = new Float32Array(length);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i += 1) mono[i] += data[i] / buffer.numberOfChannels;
  }
  return mono;
}

export function analyzeEqSpectrum(buffer, frequencies) {
  const mono = makeMono(buffer);
  const size = Math.min(4096, 2 ** Math.floor(Math.log2(Math.max(256, mono.length))));
  const windowCount = Math.min(32, Math.max(6, Math.floor(mono.length / size)));
  const window = Float32Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / Math.max(1, size - 1)));
  const levels = frequencies.map((center) => {
    if (center >= buffer.sampleRate * .46) return null;
    const probes = [center / 1.32, center, center * 1.32].filter((frequency) => frequency > 20 && frequency < buffer.sampleRate * .46);
    let totalPower = 0;
    let readings = 0;
    for (let w = 0; w < windowCount; w += 1) {
      const start = Math.max(0, Math.floor((mono.length - size) * (w + .5) / windowCount));
      for (const frequency of probes) {
        const coefficient = 2 * Math.cos(2 * Math.PI * frequency / buffer.sampleRate);
        let s1 = 0;
        let s2 = 0;
        for (let i = 0; i < size; i += 1) {
          const s0 = (mono[start + i] || 0) * window[i] + coefficient * s1 - s2;
          s2 = s1;
          s1 = s0;
        }
        totalPower += Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2) / (size * size);
        readings += 1;
      }
    }
    return 10 * Math.log10(totalPower / Math.max(1, readings) + 1e-12);
  });
  return { levels, sampleRate: buffer.sampleRate };
}

export function createEqMatchCurve(sourceSpectrum, referenceSpectrum, strength = 1) {
  const pairs = sourceSpectrum.levels.map((source, index) => ({ source, reference: referenceSpectrum.levels[index] }));
  const usable = pairs.filter(({ source, reference }) => Number.isFinite(source) && Number.isFinite(reference));
  if (!usable.length) return pairs.map(() => 0);
  const sourceMean = usable.reduce((sum, pair) => sum + pair.source, 0) / usable.length;
  const referenceMean = usable.reduce((sum, pair) => sum + pair.reference, 0) / usable.length;
  const raw = pairs.map(({ source, reference }) => Number.isFinite(source) && Number.isFinite(reference)
    ? (reference - referenceMean) - (source - sourceMean) : null);
  const smoothed = raw.map((value, index) => {
    if (!Number.isFinite(value)) return null;
    const values = [raw[index - 1], value, value, raw[index + 1]].filter(Number.isFinite);
    return values.reduce((sum, item) => sum + item, 0) / values.length;
  });
  const finite = smoothed.filter(Number.isFinite);
  const offset = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  return smoothed.map((value) => Number.isFinite(value)
    ? Math.max(-10.5, Math.min(10.5, (value - offset) * Math.max(0, Math.min(1, strength))))
    : 0);
}

export function detectBpm(mono, sampleRate) {
  const targetRate = 11025;
  const stride = Math.max(1, Math.round(sampleRate / targetRate));
  const maxSamples = Math.min(mono.length, Math.round(sampleRate * 120));
  const frameSize = 256;
  const envelope = [];
  let previous = 0;
  for (let source = 0; source + frameSize * stride < maxSamples; source += frameSize * stride) {
    let energy = 0;
    for (let i = 0; i < frameSize; i += 1) {
      const value = mono[source + i * stride];
      energy += value * value;
    }
    energy = Math.sqrt(energy / frameSize);
    envelope.push(Math.max(0, energy - previous));
    previous = energy;
  }
  if (envelope.length < 30) return { bpm: null, confidence: 0 };
  const mean = envelope.reduce((sum, value) => sum + value, 0) / envelope.length;
  for (let i = 0; i < envelope.length; i += 1) envelope[i] = Math.max(0, envelope[i] - mean * .45);
  const frameRate = targetRate / frameSize;
  const minLag = Math.max(2, Math.floor(frameRate * 60 / 200));
  const maxLag = Math.min(envelope.length - 2, Math.ceil(frameRate * 60 / 55));
  let bestLag = minLag;
  let bestScore = -Infinity;
  let totalScore = 0;
  const scores = [];
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let cross = 0;
    let left = 0;
    let right = 0;
    for (let i = lag; i < envelope.length; i += 1) {
      cross += envelope[i] * envelope[i - lag];
      left += envelope[i] * envelope[i];
      right += envelope[i - lag] * envelope[i - lag];
    }
    const score = cross / Math.sqrt(left * right + 1e-12);
    scores[lag] = score;
    totalScore += Math.max(0, score);
    if (score > bestScore) { bestScore = score; bestLag = lag; }
  }
  let refinedLag = bestLag;
  if (scores[bestLag - 1] !== undefined && scores[bestLag + 1] !== undefined) {
    const left = scores[bestLag - 1];
    const middle = scores[bestLag];
    const right = scores[bestLag + 1];
    const denominator = left - 2 * middle + right;
    if (Math.abs(denominator) > 1e-8) refinedLag += .5 * (left - right) / denominator;
  }
  let bpm = 60 * frameRate / refinedLag;
  while (bpm < 78) bpm *= 2;
  while (bpm > 190) bpm /= 2;
  const average = totalScore / Math.max(1, maxLag - minLag + 1);
  return { bpm: Math.round(bpm), confidence: Math.min(1, Math.max(0, bestScore / (average + 1e-6) / 2)) };
}

export function detectKey(mono, sampleRate) {
  const major = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
  const minor = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
  const size = 4096;
  const count = Math.min(36, Math.max(8, Math.floor(mono.length / size)));
  const chroma = Array(12).fill(0);
  const hann = Float32Array.from({ length: size }, (_, i) => .5 - .5 * Math.cos(2 * Math.PI * i / (size - 1)));
  for (let w = 0; w < count; w += 1) {
    const start = Math.floor((mono.length - size) * (w + .5) / count);
    for (let midi = 36; midi <= 95; midi += 1) {
      const frequency = 440 * (2 ** ((midi - 69) / 12));
      if (frequency >= sampleRate * .47) continue;
      const coefficient = 2 * Math.cos(2 * Math.PI * frequency / sampleRate);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < size; i += 1) {
        const s0 = mono[start + i] * hann[i] + coefficient * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      const power = Math.max(0, s1 * s1 + s2 * s2 - coefficient * s1 * s2);
      chroma[midi % 12] += Math.log1p(power);
    }
  }
  const scores = [];
  for (let root = 0; root < 12; root += 1) {
    for (const [scale, profile] of [["Major", major], ["Minor", minor]]) {
      let score = 0;
      for (let i = 0; i < 12; i += 1) score += chroma[(root + i) % 12] * profile[i];
      score += chroma[root] * 4 + chroma[(root + 7) % 12] * 3;
      scores.push({ root, scale, score });
    }
  }
  scores.sort((a, b) => b.score - a.score);
  const confidence = scores[0].score ? Math.min(1, Math.max(0, (scores[0].score - scores[1].score) / scores[0].score * 9)) : 0;
  return { keyIndex: scores[0].root, scale: scores[0].scale, confidence };
}

export function measureLoudness(buffer) {
  const sampleRate = buffer.sampleRate;
  const numChannels = buffer.numberOfChannels;
  const maxSamples = Math.min(buffer.length, Math.round(sampleRate * 300));
  if (maxSamples === 0) return { lufs: -70, rms: 0 };

  const blockSize = Math.max(512, Math.round(sampleRate * 0.4));
  const step = Math.max(256, Math.round(blockSize * 0.5));

  const channelWeights = Array.from({ length: numChannels }, (_, c) => (c < 2 ? 1.0 : 1.41));
  const totalWeight = channelWeights.reduce((a, b) => a + b, 0);

  const blockPowers = [];

  for (let start = 0; start + blockSize <= maxSamples; start += step) {
    let blockEnergy = 0;
    for (let c = 0; c < numChannels; c++) {
      const data = buffer.getChannelData(c);
      let chSum = 0;
      for (let i = 0; i < blockSize; i += 2) {
        const val = data[start + i] || 0;
        chSum += val * val;
      }
      blockEnergy += (chSum / (blockSize * 0.5)) * channelWeights[c];
    }
    const meanPower = blockEnergy / totalWeight;
    if (meanPower > 1e-7) {
      blockPowers.push(meanPower);
    }
  }

  if (blockPowers.length === 0) return { lufs: -70, rms: 0 };

  const unGatedMean = blockPowers.reduce((sum, p) => sum + p, 0) / blockPowers.length;
  const relativeThreshold = unGatedMean * 0.1;

  const gated = blockPowers.filter((p) => p >= relativeThreshold);
  const finalMean = gated.length > 0 ? (gated.reduce((sum, p) => sum + p, 0) / gated.length) : unGatedMean;

  const lufs = -0.691 + 10 * Math.log10(finalMean + 1e-12);
  const rms = Math.sqrt(finalMean);

  return {
    lufs: Math.max(-70, Math.min(3, Math.round(lufs * 10) / 10)),
    rms: Math.round(rms * 1000) / 1000,
  };
}

export function calculateVolumeMatch(sourceLoudness, referenceLoudness) {
  if (!sourceLoudness || !referenceLoudness || !Number.isFinite(sourceLoudness.lufs) || !Number.isFinite(referenceLoudness.lufs)) {
    return { gainDb: 0, sourceLufs: -70, referenceLufs: -70, gainLinear: 1 };
  }
  const delta = referenceLoudness.lufs - sourceLoudness.lufs;
  const clampedDb = Math.max(-16, Math.min(12, Math.round(delta * 10) / 10));
  const gainLinear = 10 ** (clampedDb / 20);
  return {
    gainDb: clampedDb,
    sourceLufs: sourceLoudness.lufs,
    referenceLufs: referenceLoudness.lufs,
    gainLinear,
  };
}
