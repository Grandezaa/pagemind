const apiKeyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');
const showAllToggle = document.getElementById('showAll');
const voiceReplyToggle = document.getElementById('voiceReply');

// Load saved settings
chrome.storage.sync.get(['geminiKey', 'showAll', 'voiceReply'], (data) => {
  if (data.geminiKey) {
    apiKeyInput.value = data.geminiKey;
    showStatus('✓ PageMind is active', 'success');
  }
  if (typeof data.showAll !== 'undefined') showAllToggle.checked = data.showAll;
  if (typeof data.voiceReply !== 'undefined') voiceReplyToggle.checked = data.voiceReply;
});

// Save settings
saveBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();

  if (!key) {
    showStatus('Please enter your Gemini API key.', 'error');
    return;
  }

  if (!key.startsWith('AIza')) {
    showStatus('That doesn\'t look like a valid Gemini key (should start with AIza…)', 'error');
    return;
  }

  saveBtn.textContent = 'Verifying…';
  saveBtn.disabled = true;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: 'Say "OK" only.' }] }],
          generationConfig: { maxOutputTokens: 5 }
        })
      }
    );

    const data = await res.json();
    if (data.error) throw new Error(data.error.message);

    await chrome.storage.sync.set({
      geminiKey: key,
      showAll: showAllToggle.checked,
      voiceReply: voiceReplyToggle.checked
    });

    showStatus('✓ API key verified and saved!', 'success');
  } catch (err) {
    showStatus(`✗ ${err.message}`, 'error');
  } finally {
    saveBtn.textContent = 'Save Settings';
    saveBtn.disabled = false;
  }
});

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  setTimeout(() => { statusEl.className = 'status'; }, 4000);
}