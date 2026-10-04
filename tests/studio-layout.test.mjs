// ClaudeBWAI — regression for e50d78d: Recordings panel children must not shrink under their text, and mic/camera "off" must share one filled style.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/studio.css', import.meta.url), 'utf8').replace(/\s+/g, '');

describe('studio.css layout guards', () => {
  it('panel body children never shrink (Recordings status overlapped Open recording)', () => {
    assert.ok(css.includes('.bc-panel__body>*{flex-shrink:0}'));
  });
  it('mic and camera off states share one filled rule', () => {
    const match = css.match(/#mute-microphone\[aria-pressed=true\],#toggle-camera\[aria-pressed=true\]\{([^}]*)\}/);
    assert.ok(match, 'combined selector list present');
    assert.match(match[1], /background:var\(--ink\)/);
    assert.match(match[1], /color:var\(--surface\)/);
  });
  it('no separate mic-only off rule remains', () => {
    assert.equal(css.split('#mute-microphone[aria-pressed=true]').length - 1, 1);
  });
});

// ClaudeBWAI — einh 3 Oct, "A: line under Record": the disabled reason is visible, not screen-reader-only, and its box is
// reserved (fixed width, one line, min-height) so showing or clearing it never moves another control.
const html = readFileSync(new URL('../src/index.html', import.meta.url), 'utf8');
describe('Record disabled reason is a visible line under Record', () => {
  it('the reason element sits inside the Record trigger, after the button, and is not sr-only', () => {
    const trigger = html.match(/<span id="record-trigger"[^>]*>(.*?)<\/span><\/span>/);
    assert.ok(trigger, 'record trigger present');
    assert.match(trigger[0], /aria-describedby="record-disabled-reason"/);
    assert.match(trigger[1], /<button id="record"[^>]*>.*<\/button><span id="record-disabled-reason" class="record-reason">/);
    assert.doesNotMatch(trigger[1], /record-disabled-reason" class="[^"]*sr-only/);
  });
  it('the trigger reserves one line under the button; the reason is a positioned, truncating, muted line in it', () => {
    assert.ok(css.includes('.record-trigger{padding-bottom:16px}'));
    const rule = css.match(/\.record-reason\{([^}]*)\}/);
    assert.ok(rule, 'record-reason rule present');
    for (const part of ['position:absolute', 'bottom:0', 'max-width:360px', 'height:14px', 'line-height:14px', 'font-size:11px', 'color:var(--ink-muted)', 'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis'])
      assert.ok(rule[1].includes(part), part);
  });
});
