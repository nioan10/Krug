// Isolated WebView2 bridge smoke test. No network or media devices are used.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const desktop = process.argv.includes('--desktop');
const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self'"><script src="/fixture.js"></script>`;
const script = `
(async () => {
  try {
    const before = await window.krugDesktop.getUpdateState();
    await window.krugDesktop.setCallActive(true);
    const after = await window.krugDesktop.getUpdateState();
    const audio = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Synthetic audio timed out')), 5000);
      window.krugDesktop.onAudio(bytes => { clearTimeout(timer); resolve([...bytes]); });
    });
    let audioRejected = false, started = false;
    if (${desktop}) started = await window.krugDesktop.startAudio();
    else {
      try { await window.krugDesktop.startAudio(); } catch { audioRejected = true; }
      window.chrome.webview.postMessage({type:'test-audio-start'});
    }
    const captured = await audio;
    if (${desktop}) await window.krugDesktop.stopAudio();
    window.chrome.webview.postMessage({type:'test-result', before, after, audioRejected, started, audio:captured});
  } catch (error) {
    window.chrome.webview.postMessage({type:'test-result', error:String(error)});
  }
})();`;
const fixture = resolve('.local/webview-test-fixture.html');
const fixtureScript = resolve('.local/webview-test-fixture.js');
const result = resolve('.local/webview-test-result.json');
const trace = resolve('.local/webview-test-trace.txt');
const fakeHelper = resolve('tests/webview-audio/bin/Release/net48/WebviewAudio.Tests.exe');
rmSync(result, { force: true }); rmSync(trace, { force: true });
writeFileSync(fixture, html);
writeFileSync(fixtureScript, script);
const executable = desktop ? 'desktop/webview/desktop-test/bin/Release/net48/Krug.Desktop.Test.exe' : 'desktop/webview/bin/Release/net48/Krug.Webview.exe';
const child = spawn(resolve(executable), desktop ? ['--experimental'] : [], {
  windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'],
  env: { ...process.env, KRUG_WEBVIEW_TEST_HIDDEN: '1', KRUG_WEBVIEW_TEST_TRACE: trace,
    KRUG_WEBVIEW_TEST_HTML: fixture, KRUG_WEBVIEW_TEST_SCRIPT: fixtureScript, KRUG_WEBVIEW_TEST_RESULT: result, KRUG_WEBVIEW_TEST_FAKE_AUDIO_HELPER: fakeHelper },
});
let diagnostics = '';
child.stderr.on('data', chunk => { diagnostics += chunk.toString().slice(0, 4096); });
try {
  let output;
  for (let i = 0; i < 150; i++) {
    await new Promise(resolveWait => setTimeout(resolveWait, 100));
    try { output = JSON.parse(readFileSync(result, 'utf8')); break; } catch (error) {
      if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
    }
    if (child.exitCode !== null) throw new Error(`Prototype exited early (${child.exitCode}): ${diagnostics}`);
  }
  if (!output) {
    let steps = ''; try { steps = readFileSync(trace, 'utf8'); } catch {}
    throw new Error(`WebView fixture timed out: ${diagnostics}; steps: ${steps}`);
  }
  assert.equal(output.error, undefined);
  assert.equal(output.before.state, 'idle');
  if (desktop) { assert.equal(output.started, true); assert.equal(output.before.testCookieIsolation, true); }
  else {
    assert.equal(output.before.callActive, false);
    assert.equal(output.after.callActive, true);
    assert.equal(output.audioRejected, true);
  }
  assert.deepEqual(output.audio, [1, 2, 3, 4, 5, 6, 7, 8]);
  console.log('Isolated WebView2 bridge: passed; no network or devices accessed.');
} finally {
  if (child.exitCode === null) child.kill();
}
