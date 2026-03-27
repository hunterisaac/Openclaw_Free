function bglog(...args) {
  console.log('[BG]', ...args);
}

chrome.action.onClicked.addListener(() => {
  bglog('Toolbar icon clicked; opening chat UI');
  chrome.tabs.create({
    url: chrome.runtime.getURL('gemini-shell.html')
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  bglog('onMessage received:', msg);
  if (msg.action !== 'runGemini') return;

  const attachments = msg.attachments || (msg.attachment ? [msg.attachment] : []);

  runGeminiFlow(msg.prompt, attachments)
    .then(reply => {
      bglog('runGeminiFlow resolved:', reply);
      sendResponse({ status: 'success', reply });
    })
    .catch(err => {
      bglog('runGeminiFlow failed:', err);
      sendResponse({ status: 'error', reply: 'Error: ' + err });
    });

  return true;
});

let _lastOpenRequestTs = 0;
let _openInProgress = false;
const OPEN_COOLDOWN_MS = 5000;

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'openNewGemini') {
    const now = Date.now();
    const force = !!msg.force;
    if (!force) {
      if (_openInProgress) {
        bglog('openNewGemini suppressed because open already in progress');
        sendResponse({ ok: false, reason: 'in-progress' });
        return true;
      }
      if (now - _lastOpenRequestTs < OPEN_COOLDOWN_MS) {
        bglog('openNewGemini suppressed by cooldown');
        sendResponse({ ok: false, reason: 'cooldown' });
        return true;
      }
    }
    _lastOpenRequestTs = now;
    _openInProgress = true;

    const clearOpenFlagTimer = setTimeout(() => {
      _openInProgress = false;
      bglog('openNewGemini: clearing in-progress flag by timeout');
    }, OPEN_COOLDOWN_MS * 2);

    bglog('openNewGemini requested — closing existing Gemini tabs and opening fresh one');

    if (force) {
      chrome.tabs.query({ url: 'https://gemini.google.com/*' }, tabs => {
        if (tabs && tabs.length) {
          const ids = tabs.map(t => t.id).filter(Boolean);
          bglog('force: closing Gemini tabs', ids);
          chrome.tabs.remove(ids, () => {
            bglog('force: closed Gemini tabs, opening fresh Gemini tab');
            chrome.tabs.create({ url: 'https://gemini.google.com/' }, newTab => {
              clearTimeout(clearOpenFlagTimer);
              _openInProgress = false;
              sendResponse({ ok: true, opened: true, tabId: newTab.id, forced: true });
            });
          });
        } else {
          bglog('force: no existing Gemini tabs, opening Gemini');
          chrome.tabs.create({ url: 'https://gemini.google.com/' }, newTab => {
            clearTimeout(clearOpenFlagTimer);
            _openInProgress = false;
            sendResponse({ ok: true, opened: true, tabId: newTab.id, forced: true });
          });
        }
      });
    } else {
      chrome.tabs.query({ url: chrome.runtime.getURL('gemini-shell.html') }, extTabs => {
        if (extTabs && extTabs.length) {
          const t = extTabs[0];
          bglog('found existing extension shell tab, focusing', t.id);
          chrome.tabs.update(t.id, { active: true }, () => {
            clearTimeout(clearOpenFlagTimer);
            _openInProgress = false;
            sendResponse({ ok: true, focused: true });
          });
          return;
        }

        chrome.tabs.query({ url: 'https://gemini.google.com/*' }, tabs => {
          if (tabs && tabs.length) {
            const t = tabs[0];
            bglog('reusing existing Gemini tab', t.id);
            chrome.tabs.update(t.id, { active: true }, () => {
              clearTimeout(clearOpenFlagTimer);
              _openInProgress = false;
              sendResponse({ ok: true, reused: true, tabId: t.id });
            });
          } else {
            bglog('no existing tabs, opening extension page');
            chrome.tabs.create({ url: chrome.runtime.getURL('gemini-shell.html') }, newTab => {
              clearTimeout(clearOpenFlagTimer);
              _openInProgress = false;
              sendResponse({ ok: true, opened: true, tabId: newTab.id });
            });
          }
        });
      });
    }

    return true;
  }
});

async function runGeminiFlow(prompt, attachments) {
  bglog('→ start runGeminiFlow for prompt:', prompt);

  const tab = await findOrCreateTab();
  bglog('→ using tab:', tab.id, tab.url);

  await waitForLoad(tab.id);
  bglog('→ page loaded');

  await retryEnsureInput(tab.id, 3, 1000);
  bglog('→ input ready');

  // Convert prompt to prompt.txt and drag-drop it onto the composer
  bglog('→ converting prompt to prompt.txt');
  const promptDataURL = 'data:text/plain;charset=utf-8,' + encodeURIComponent(prompt);
  let fileAttached = false;
  try {
    await injectFileIntoPage(tab.id, { name: 'prompt.txt', type: 'text/plain', dataURL: promptDataURL });
    bglog('→ prompt.txt attached successfully');
    fileAttached = true;
    await new Promise(r => setTimeout(r, 50));
  } catch (err) {
    bglog('→ prompt.txt drag-drop failed:', err);
  }

  // Any extra caller-supplied attachments
  if (attachments && attachments.length) {
    for (const att of attachments) {
      if (!att) continue;
      bglog('→ attaching extra file:', att.name);
      try {
        if (att.dataURL) {
          await injectFileIntoPage(tab.id, att);
        } else if (att.data && att.type && att.name) {
          const dataURL = `data:${att.type};charset=utf-8,` + encodeURIComponent(att.data);
          await injectFileIntoPage(tab.id, { name: att.name, type: att.type, dataURL });
        } else {
          bglog('→ extra attachment missing fields, skipping', att);
          continue;
        }
        bglog('→ extra attachment injected');
      } catch (err) {
        bglog('→ extra attachment injection failed:', err);
      }
      await new Promise(r => setTimeout(r, 50));
    }
  }

  if (fileAttached) {
    // File was attached — just send a short trigger to enable the Send button
    await sendPrompt(tab.id, 'Please read and respond to the attached file.');
    bglog('→ trigger message sent');
  } else {
    // Drag-drop failed — fall back to pasting the prompt as plain text
    bglog('→ falling back to plain text prompt');
    await sendPrompt(tab.id, prompt);
    bglog('→ fallback prompt injected');
  }

  const reply = await waitForResponse(tab.id, 60000, 2000);
  bglog('→ response received');
  return reply;
}

function findOrCreateTab() {
  return new Promise(resolve => {
    chrome.tabs.query({ url: 'https://gemini.google.com/*' }, tabs => {
      if (tabs.length) {
        bglog('findOrCreateTab: found existing tab', tabs[0].id);
        return resolve(tabs[0]);
      }
      bglog('findOrCreateTab: creating new tab');
      chrome.tabs.create(
        { url: 'https://gemini.google.com/', active: false },
        newTab => {
          bglog('findOrCreateTab: new tab opened', newTab.id);
          resolve(newTab);
        }
      );
    });
  });
}

function waitForLoad(tabId) {
  return new Promise(resolve => {
    chrome.tabs.get(tabId, tab => {
      if (tab.status === 'complete') {
        bglog('waitForLoad: already complete');
        return resolve();
      }
      bglog('waitForLoad: waiting for load on tab', tabId);
      const listener = (id, info) => {
        if (id === tabId && info.status === 'complete') {
          bglog('waitForLoad: load event fired');
          chrome.tabs.onUpdated.removeListener(listener);
          resolve();
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
    });
  });
}

async function retryEnsureInput(tabId, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      bglog(`retryEnsureInput: attempt ${i + 1}`);
      await ensureInputReady(tabId);
      return;
    } catch (err) {
      bglog(`retryEnsureInput: attempt ${i + 1} failed:`, err);
      if (i === retries - 1) throw err;
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

function ensureInputReady(tabId) {
  bglog('ensureInputReady: injecting script');

  return chrome.scripting.executeScript({
    target: { tabId },
    func: (timeout) => {
      return new Promise((res, rej) => {
        const find = () =>
          document.querySelector('div[contenteditable="true"]') ||
          document.querySelector('rich-textarea') ||
          document.querySelector('[role="textbox"]');

        if (find()) return res();

        const obs = new MutationObserver(() => {
          if (find()) { obs.disconnect(); res(); }
        });
        obs.observe(document.body, { childList: true, subtree: true });
        setTimeout(() => { obs.disconnect(); rej('Timeout waiting for Gemini input'); }, timeout);
      });
    },
    args: [8000]
  }).then(() => {
    bglog('ensureInputReady: Gemini input found');
  });
}

async function sendPrompt(tabId, prompt) {
  bglog('sendPrompt: injecting text into Gemini');

  await chrome.scripting.executeScript({
    target: { tabId },
    func: async text => {

      const input =
        document.querySelector('div[contenteditable="true"]') ||
        document.querySelector('rich-textarea div[contenteditable]') ||
        document.querySelector('[role="textbox"]');

      if (!input) throw 'Gemini composer element not found';

      input.focus();

      input.focus();
      input.innerHTML = '';

      try {

        await navigator.clipboard.writeText(text);
        document.execCommand('paste');
      } catch (e) {

        console.warn('Clipboard paste failed, using innerText fallback:', e);
        input.innerText = text;
      }

      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: text }));

      return new Promise(resolve => setTimeout(() => {

        const sendBtn =
          document.querySelector('button[aria-label="Send message"]') ||
          document.querySelector('button[aria-label="Send"]') ||
          document.querySelector('button[aria-label*="Send"][aria-label*="message"]') ||
          document.querySelector('button[aria-label*="send"][aria-label*="message"]') ||
          document.querySelector('button:has(mat-icon[data-mat-icon-name="send"])') ||
          document.querySelector('button:has(mat-icon[fonticon="send"])') ||
          (() => {

            const composerRoot =
              input.closest('form') ||
              input.closest('[class*="input"]') ||
              input.closest('[class*="composer"]') ||
              input.closest('[class*="footer"]') ||
              input.parentElement;

            if (!composerRoot) return null;

            const candidates = Array.from(composerRoot.querySelectorAll('button, [role="button"]'))
              .filter(n => n.offsetParent !== null && !n.hasAttribute('disabled'));

            const byLabel = candidates.find(n => {
              const label = (n.getAttribute('aria-label') || n.title || '').toLowerCase();
              return label.includes('send') && !label.includes('share') && !label.includes('feedback');
            });
            if (byLabel) return byLabel;

            return candidates[candidates.length - 1] || null;
          })();

        if (sendBtn && !sendBtn.hasAttribute('disabled')) {
          sendBtn.click();
        } else {

          input.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
            bubbles: true, cancelable: true, composed: true
          }));
        }
        resolve();
      }, 20));
    },
    args: [prompt]
  });
}

async function injectFileIntoPage(tabId, attachment) {
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (att, timeout) => {
      return new Promise((resolve, reject) => {
        try {
          // Build File object from dataURL
          const parts = att.dataURL.split(',');
          const meta = parts[0];
          const isBase64 = meta.indexOf('base64') !== -1;
          const matches = /data:([^;]+)(;base64)?/.exec(meta);
          const mime = matches ? matches[1] : att.type || 'application/octet-stream';
          const raw = parts[1];
          let binStr = isBase64 ? atob(raw) : decodeURIComponent(raw);
          const u8 = new Uint8Array(binStr.length);
          for (let i = 0; i < binStr.length; i++) u8[i] = binStr.charCodeAt(i);
          const blob = new Blob([u8], { type: mime });
          const file = new File([blob], att.name, { type: mime });

          const composer =
            document.querySelector('div[contenteditable="true"]') ||
            document.querySelector('rich-textarea') ||
            document.querySelector('[role="textbox"]');

          if (!composer) { reject('Gemini composer not found'); return; }

          // Snapshot existing chips so we only resolve on a NEW one
          const existingChips = new Set(Array.from(document.querySelectorAll('mat-chip')));

          // Paste file via ClipboardEvent — works without isTrusted
          composer.focus();
          const dt = new DataTransfer();
          dt.items.add(file);
          const pasteEvent = new ClipboardEvent('paste', {
            bubbles: true,
            cancelable: true,
            clipboardData: dt
          });
          composer.dispatchEvent(pasteEvent);

          // Wait for a NEW mat-chip to appear
          const start = Date.now();
          const check = () => {
            const newChip = Array.from(document.querySelectorAll('mat-chip'))
              .find(c => !existingChips.has(c));
            if (newChip) {
              console.log('[inject] attachment chip appeared:', newChip.textContent.trim());
              return resolve(true);
            }
            const preview = document.querySelector('[data-test-id*="attachment"]') ||
                            document.querySelector('[data-test-id*="chip"]') ||
                            document.querySelector('.file-chip') ||
                            document.querySelector('.attachment-preview');
            if (preview) return resolve(true);
            if (Date.now() - start > timeout) {
              return reject('Timeout: no attachment chip appeared after paste');
            }
            setTimeout(check, 50);
          };
          setTimeout(check, 50);

        } catch (err) {
          reject(err?.toString?.() || String(err));
        }
      });
    },
    args: [attachment, 5000]
  }).then(() => true);
}


async function waitForResponse(tabId, timeout = 60000, settleTime = 3500) {
  bglog('waitForResponse: injecting Gemini observer script');
  return chrome.scripting.executeScript({
    target: { tabId },
    func: (timeout, settleTime) => {
      return new Promise((resolve, reject) => {

        const responseSelectors = [
          '.model-response-text p',
          '.message-content p',
          'div[class*="message-text"] p',
          'model-response p',
          '.response-container p',
          'message-content p',
          '.response-text p'
        ];

        const isTyping = () => {

          const stopBtn =
            document.querySelector('button[aria-label="Stop generating"]') ||
            document.querySelector('button[aria-label*="Stop"]') ||
            document.querySelector('[data-test-id="stop-button"]');
          if (stopBtn && stopBtn.offsetParent !== null) return true;

          if (document.querySelector('mat-progress-bar')) return true;
          if (document.querySelector('.typing-indicator')) return true;
          if (document.querySelector('[aria-label*="loading"]')) return true;
          if (document.querySelector('[aria-label*="Generating"]')) return true;

          const sendBtn =
            document.querySelector('button[aria-label*="Send"]') ||
            document.querySelector('button[aria-label*="send"]');
          if (sendBtn && sendBtn.hasAttribute('disabled')) return true;

          return false;
        };

        const getLatestText = () => {
          for (const sel of responseSelectors) {
            const els = document.querySelectorAll(sel);
            if (els.length) {
              return Array.from(els)
                .map(p => p.innerText.trim())
                .filter(Boolean)
                .join('\n\n');
            }
          }
          return '';
        };

        let lastText = '';
        let settleTimer = null;
        let hasSeenContent = false;

        const trySettle = () => {

          const text = getLatestText();
          if (!text) return;
          hasSeenContent = true;

          if (text !== lastText || isTyping()) {
            lastText = text;
            clearTimeout(settleTimer);
            settleTimer = null;
            if (isTyping()) return; 

          }

          if (settleTimer === null) {
            settleTimer = setTimeout(() => {

              if (isTyping()) {
                settleTimer = null;
                return;
              }
              observer.disconnect();
              clearTimeout(timeoutId);
              resolve(getLatestText());
            }, settleTime);
          }
        };

        const observer = new MutationObserver(trySettle);
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        const pollId = setInterval(trySettle, 500);

        const timeoutId = setTimeout(() => {
          observer.disconnect();
          clearInterval(pollId);
          clearTimeout(settleTimer);
          const text = getLatestText();
          if (text) resolve(text);
          else reject('Timeout waiting for Gemini response');
        }, timeout);
      });
    },
    args: [timeout, settleTime]
  }).then(r => r[0].result);
}