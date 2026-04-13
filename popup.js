const apiKeyInput = document.getElementById('apiKey');
const saveBtn = document.getElementById('saveBtn');
const statusEl = document.getElementById('status');

// Load saved key
chrome.storage.sync.get(['groqKey'], (data) => {
  if (data.groqKey) {
    apiKeyInput.value = data.groqKey;
    showStatus('✓ Active', 'success');
  }
});

// Save & verify
saveBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (!key) { showStatus('Enter your Groq API key.', 'error'); return; }

  saveBtn.textContent = 'Verifying…';
  saveBtn.disabled = true;

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: 'Say OK.' }],
        max_tokens: 5
      })
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error.error || data.error.message);

    await chrome.storage.sync.set({ groqKey: key });
    showStatus('✓ Saved & verified', 'success');
  } catch (err) {
    showStatus(`✗ ${err.message}`, 'error');
  } finally {
    saveBtn.textContent = 'Save';
    saveBtn.disabled = false;
  }
});

function showStatus(msg, type) {
  statusEl.textContent = msg;
  statusEl.className = `status ${type}`;
  setTimeout(() => { statusEl.className = 'status'; }, 4000);
}
