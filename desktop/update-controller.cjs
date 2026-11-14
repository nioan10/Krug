// Native installation is deferred until the renderer explicitly reports no active call.
function createUpdateController({ install, report, schedule = setTimeout, prepare, onPrepareError = () => {} }) {
  let inCall = null, ready = false, requested = false, scheduled = false, preparing = false;
  function maybeInstall() {
    if (!ready || !requested || inCall !== false || scheduled || preparing) return;
    scheduled = true;
    schedule(() => {
      scheduled = false;
      if (!ready || !requested || inCall !== false) return;
      function finish() {
        preparing = false;
        if (!ready || !requested || inCall !== false) return;
        ready = false; requested = false; report({ state: 'installing' }); install();
      }
      if (!prepare) return finish();
      preparing = true;
      Promise.resolve().then(prepare).then(finish, () => {
        preparing = false; ready = false; report({ state: 'error' }); onPrepareError();
      });
    }, 1000);
  }
  return {
    setCallActive(value) { inCall = value; if (ready) report({ state: requested && value ? 'queued' : 'ready' }); maybeInstall(); },
    downloaded() { ready = true; report({ state: requested && inCall === true ? 'queued' : 'ready' }); maybeInstall(); },
    requestInstall() { requested = true; if (ready) report({ state: inCall === true ? 'queued' : 'ready' }); maybeInstall(); },
    cancel() { requested = false; if (ready) report({ state: 'ready' }); },
    resetCallState() { inCall = null; },
  };
}
module.exports = { createUpdateController };
