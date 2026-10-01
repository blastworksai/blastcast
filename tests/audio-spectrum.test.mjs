import test from 'node:test';
import assert from 'node:assert/strict';
import { toneAmplitudes } from './helpers/audio-spectrum.cjs';

test('tone power distinguishes attenuation, silence and both voices across phase changes', () => {
  for (const guest of [0, .02, .1, .2]) {
    const samples = Float32Array.from({length:8192}, (_,i) => .15*Math.sin(2*Math.PI*431*i/48000) + guest*Math.sin(2*Math.PI*997*i/48000 + Math.floor(i/1000)*1.7));
    const [host, measured] = toneAmplitudes(samples,48000);
    assert.ok(Math.abs(host-.15)<.004, 'host amplitude unchanged');
    assert.ok(Math.abs(measured-guest)<.008, 'phase changes do not masquerade as gain');
  }
});
