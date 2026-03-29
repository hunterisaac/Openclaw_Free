const BRIDGE_URL = 'http://localhost:8765';
let pollInterval = null;
const POLL_DELAY = 500;
let requestsInFlight = 0;

function log(...args) {
  const msg = '[Bridge] ' + args.join(' ');
  console.log(msg);

  try {
    window.postMessage({ __bridge_event__: true, message: args.join(' ') }, '*');
  } catch (e) {}
}

function updateUiState(state) {
  try {
    const el = document.getElementById('wsState');
    if (el) el.textContent = state;
    window.postMessage({ __bridge_event__: true, state, message: 'State → ' + state }, '*');
  } catch (e) {}
}

async function pollForRequests() {
  try {
    const response = await fetch(`${BRIDGE_URL}/queue`);

    if (response.status === 204) {

      return;
    }

    if (!response.ok) {
      log('Poll failed with status:', response.status);
      updateUiState('error');
      return;
    }

    const request = await response.json();
    log(`Received request id=${request.id} prompt="${request.prompt.substring(0, 80)}${request.prompt.length > 80 ? '…' : ''}"`);

    log(`Forwarding request ${request.id} to background.js`);
    requestsInFlight++;
    chrome.runtime.sendMessage(
      {
        action: 'runGemini',
        prompt: request.prompt,
        attachments: request.attachments
      },
      (bgResponse) => {
        if (chrome.runtime.lastError) {
          log(`ERROR from background for ${request.id}:`, chrome.runtime.lastError.message);
          requestsInFlight = Math.max(0, requestsInFlight - 1);

          fetch(`${BRIDGE_URL}/response/${request.id}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json; charset=utf-8' },
            body: JSON.stringify({ reply: `Error: ${chrome.runtime.lastError.message}` })
          }).catch(() => {});
          return;
        }

        const reply = bgResponse?.reply || bgResponse?.response || '';
        log(`Got reply from background for ${request.id} — status=${bgResponse?.status} length=${reply.length}`);
        log(`Reply preview for ${request.id}: "${reply.substring(0, 120)}${reply.length > 120 ? '…' : ''}"`);

        if (!reply) {
          log(`WARNING: Empty reply for ${request.id} — bgResponse was:`, JSON.stringify(bgResponse));
        }

        log(`POSTing reply to ${BRIDGE_URL}/response/${request.id}`);
        fetch(`${BRIDGE_URL}/response/${request.id}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify({ reply })
        })
          .then(async r => {
            const text = await r.text();
            log(`/response/${request.id} → HTTP ${r.status}: ${text}`);
            if (!r.ok) {
              log(`ERROR: Server rejected response for ${request.id}: ${text}`);
            }

            try {
              requestsInFlight = Math.max(0, requestsInFlight - 1);
              if (requestsInFlight === 0) {
                log(`Requesting openNewGemini (force) after delivering ${request.id}`);
                chrome.runtime.sendMessage({ action: 'openNewGemini', force: true });
              } else {
                log(`Skipping openNewGemini — ${requestsInFlight} request(s) still in flight`);
              }
            } catch (e) {
              requestsInFlight = Math.max(0, requestsInFlight - 1);
              log('Failed to reopen Gemini:', e.message);
            }
          })
          .catch(err => log(`FETCH ERROR sending response for ${request.id}:`, err.message));
      }
    );

  } catch (err) {
    log('Poll error:', err.message);
  }
}

async function connect() {
  log('Attempting to connect to HTTP bridge at', BRIDGE_URL);
  try {
    const response = await fetch(BRIDGE_URL);
    if (response.ok) {
      log('Connected to HTTP bridge successfully');
      updateUiState('connected');

      if (!pollInterval) {
        pollInterval = setInterval(pollForRequests, POLL_DELAY);
        log('Polling started — interval', POLL_DELAY + 'ms');
      }

      return true;
    } else {
      log('Bridge returned non-OK status:', response.status);
      updateUiState('disconnected');
      setTimeout(connect, 2000);
    }
  } catch (err) {
    log('Connection failed:', err.message, '— retrying in 2s');
    updateUiState('disconnected');
    setTimeout(connect, 2000);
  }
  return false;
}

window.addEventListener('message', ev => {
  if (!ev.data || !ev.data.__bridge__) return;
  const cmd = ev.data.cmd;

  if (cmd === 'closeWs') {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = null;
    updateUiState('closed');
    log('Polling stopped by user');
  } else if (cmd === 'reconnectWs') {
    if (pollInterval) clearInterval(pollInterval);
    pollInterval = null;
    updateUiState('connecting');
    log('Reconnecting by user request');
    connect();
  }
});

updateUiState('connecting');
connect();
log('HTTP Bridge initialized');