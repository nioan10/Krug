// Native installation is deferred until the renderer explicitly reports no active call.
function createUpdateController({ install, report, schedule = setTimeout }) {
  let inCall = null, ready = false, scheduled = false;
  function maybeInstall() {
    if (!ready || inCall !== false || scheduled) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      if (!ready || inCall !== false) return;
      ready = false; report({ state: 'installing' }); install();
    }, 1000);
  }
  return {
    setCallActive(value) { inCall = value; if (ready) report({ state: value ? 'queued' : 'ready' }); maybeInstall(); },
    downloaded() { ready = true; report({ state: inCall === true ? 'queued' : 'ready' }); maybeInstall(); },
    resetCallState() { inCall = null; },
  };
}
module.exports = { createUpdateController };
