// CodexBWAI — test-only tone power, tolerant of codec/RTC phase discontinuities.
// Positive-frequency energy of a Hann-windowed FFT band, normalized by window
// power. Sum the narrow band, rather than assuming an unchanging phase at one bin.
function toneAmplitudes(samples, sampleRate, frequencies = [431, 997]) {
  const length = Math.min(8192, samples.length);
  const offset = Math.floor((samples.length - length) / 2);
  const windowed = new Float64Array(length);
  let windowPower = 0;
  for (let i = 0; i < length; i++) {
    const weight = .5 - .5 * Math.cos(2 * Math.PI * i / length);
    windowed[i] = samples[offset + i] * weight; windowPower += weight * weight;
  }
  return frequencies.map(frequency => {
    let power = 0;
    const low = Math.max(1, Math.floor((frequency - 60) * length / sampleRate));
    const high = Math.min(Math.floor(length / 2) - 1, Math.ceil((frequency + 60) * length / sampleRate));
    for (let bin = low; bin <= high; bin++) {
      let re = 0, im = 0;
      for (let i = 0; i < length; i++) {
        const angle = 2 * Math.PI * bin * i / length;
        re += windowed[i] * Math.cos(angle); im += windowed[i] * Math.sin(angle);
      }
      power += re * re + im * im;
    }
    return Math.sqrt(4 * power / (length * windowPower));
  });
}
module.exports = { toneAmplitudes };
