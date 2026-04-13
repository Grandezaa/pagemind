(() => {
  if (document.getElementById('_rt_host')) return;

  // ─── Shadow DOM (closed) — invisible to page scripts & proctoring scanners ─
  const hostEl = document.createElement('div');
  hostEl.id = '_rt_host';
  document.documentElement.appendChild(hostEl);
  const shadow = hostEl.attachShadow({ mode: 'closed' });

  const styleLink = document.createElement('link');
  styleLink.rel = 'stylesheet';
  styleLink.href = chrome.runtime.getURL('content.css');
  shadow.appendChild(styleLink);

  // ─── State ────────────────────────────────────────────────────────────────
  let isLoading = false;
  let isListening = false;
  let recognition = null;
  let activeBarType = null;
  let lastActiveBarType = 'chat';
  let geminiKey = '';
  let autoHideTimer = null;

  async function ensureKey() {
    if (geminiKey) return geminiKey;
    const data = await chrome.storage.sync.get(['geminiKey']);
    geminiKey = data.geminiKey || '';
    return geminiKey;
  }

  chrome.storage.sync.get(['geminiKey'], (data) => {
    geminiKey = data.geminiKey || '';
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.geminiKey) geminiKey = changes.geminiKey.newValue;
  });

  // ─── Theme Detection ──────────────────────────────────────────────────────
  function applyTheme() {
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return;
    const brightness = (parseInt(match[1]) * 299 + parseInt(match[2]) * 587 + parseInt(match[3]) * 114) / 1000;
    panel.setAttribute('data-pm-theme', brightness > 128 ? 'light' : 'dark');
  }

  // ─── UI Panel ─────────────────────────────────────────────────────────────
  const panel = document.createElement('div');
  panel.className = 'pm-bar';
  panel.innerHTML = `
    <div class="pm-top-row">
      <textarea id="pm-input" placeholder="Ask anything... (/summarize, /search query)" rows="1"></textarea>
      <button class="pm-btn" id="pm-mic" title="Voice">🎙</button>
      <button class="pm-btn" id="pm-send">➤</button>
      <button class="pm-btn pm-btn-close" id="pm-close">✕</button>
    </div>
    <div class="pm-response-row">
      <div id="pm-text">Ctrl+Shift+Y to toggle · Esc to close · /key AIza... to set API key</div>
      <div id="pm-ghost"><div id="pm-ring"></div></div>
    </div>
  `;
  shadow.appendChild(panel);

  const inputArea = panel.querySelector('#pm-input');
  const responseArea = panel.querySelector('#pm-text');
  const ghost = panel.querySelector('#pm-ghost');

  setTimeout(applyTheme, 300);
  new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });

  // ─── Auto-Hide (60s inactivity) ───────────────────────────────────────────
  function resetAutoHide() {
    if (autoHideTimer) clearTimeout(autoHideTimer);
    if (activeBarType) autoHideTimer = setTimeout(hidePanel, 60000);
  }

  panel.addEventListener('mousemove', resetAutoHide);
  panel.addEventListener('click', resetAutoHide);
  panel.addEventListener('keydown', resetAutoHide);

  // ─── Show / Hide ──────────────────────────────────────────────────────────
  function showPanel(type) {
    activeBarType = type;
    lastActiveBarType = type;
    panel.classList.add('pm-visible');
    if (type === 'chat') {
      inputArea.placeholder = "Ask anything... (/summarize, /search query)";
      inputArea.focus();
    } else if (type === 'explain') {
      inputArea.placeholder = "Explaining selection...";
    }
    resetAutoHide();
  }

  function hidePanel() {
    panel.classList.remove('pm-visible');
    activeBarType = null;
    stopListening();
    if (autoHideTimer) clearTimeout(autoHideTimer);
  }

  // ─── Keyboard Shortcuts ───────────────────────────────────────────────────
  // Use capture phase so it fires before the page can intercept
  document.addEventListener('keydown', (e) => {
    // Ctrl+Shift+Y — toggle
    if (e.ctrlKey && e.shiftKey && e.key === 'Y') {
      e.preventDefault();
      e.stopPropagation();
      if (activeBarType) {
        hidePanel();
      } else {
        const sel = getSelectedText();
        sel.length > 2 ? explainSelection(sel) : showPanel(lastActiveBarType || 'chat');
      }
      return;
    }
    // Escape — instant panic hide
    if (e.key === 'Escape' && activeBarType) {
      hidePanel();
    }
  }, true);

  // ─── Auto-hide on window blur (Alt+Tab, screen share focus check, etc.) ───
  window.addEventListener('blur', hidePanel);

  // ─── Explain Selection ────────────────────────────────────────────────────
  function getSelectedText() {
    return window.getSelection().toString().trim();
  }

  async function explainSelection(selectedText) {
    if (isLoading || !selectedText) return;
    const key = await ensureKey();
    if (!key) { showPanel('chat'); responseArea.innerText = '⚠ No API key — open extension settings.'; return; }
    isLoading = true;
    showPanel('explain');
    responseArea.innerHTML = `<i>Explaining: "${selectedText.slice(0, 60)}${selectedText.length > 60 ? '...' : ''}"</i>`;
    ghost.classList.add('pm-spin');
    try {
      const res = await callGemini(key, `Explain this clearly and concisely:\n\n"${selectedText}"\n\nPage: ${document.title}`);
      responseArea.innerHTML = fmt(res);
    } catch (err) {
      responseArea.innerText = `⚠ ${err.message}`;
    } finally {
      isLoading = false;
      ghost.classList.remove('pm-spin');
      resetAutoHide();
    }
  }

  // ─── Send Message ─────────────────────────────────────────────────────────
  async function sendMessage() {
    const text = inputArea.value.trim();
    if (!text || isLoading) return;
    const key = await ensureKey();
    if (!key) { responseArea.innerText = '⚠ No API key — open extension settings.'; return; }

    inputArea.value = '';
    isLoading = true;
    ghost.classList.add('pm-spin');
    responseArea.innerHTML = `<i>Thinking...</i>`;

    try {
      let prompt;
      if (text.startsWith('/key ')) {
        const newKey = text.replace('/key ', '').trim();
        await chrome.storage.sync.set({ geminiKey: newKey });
        geminiKey = newKey;
        isLoading = false;
        ghost.classList.remove('pm-spin');
        responseArea.innerText = '✓ API key saved.';
        return;
      } else if (text === '/summarize' || text === '/sum') {
        responseArea.innerHTML = `<i>Summarizing...</i>`;
        prompt = `Summarize this page in 3-4 concise sentences:\n\n${pageContext()}`;
      } else if (text.startsWith('/search ')) {
        const query = text.replace('/search ', '').trim();
        const searchRes = await chrome.runtime.sendMessage({ type: 'SEARCH_WEB', query });
        prompt = `Search results for "${query}":\n${searchRes.data}\n\nAnswer briefly based on these results.`;
      } else {
        prompt = `You are a helpful assistant. The user is on "${document.title}". Use this page context only if relevant:\n${pageContext()}\n\nUser: ${text}`;
      }
      const reply = await callGemini(key, prompt);
      responseArea.innerHTML = fmt(reply);
    } catch (err) {
      responseArea.innerHTML = `⚠ ${err.message}`;
    } finally {
      isLoading = false;
      ghost.classList.remove('pm-spin');
      resetAutoHide();
    }
  }

  // ─── Gemini API ───────────────────────────────────────────────────────────
  async function callGemini(key, prompt) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${key}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
        })
      }
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
  }

  function pageContext() {
    return `Title: ${document.title}\n${document.body.innerText.slice(0, 4500)}`;
  }

  function fmt(text) {
    return text
      .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      .replace(/\n/g, '<br>');
  }

  // ─── Panel Events ─────────────────────────────────────────────────────────
  panel.querySelector('#pm-close').addEventListener('click', hidePanel);
  panel.querySelector('#pm-send').addEventListener('click', sendMessage);
  inputArea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // ─── Voice ────────────────────────────────────────────────────────────────
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = panel.querySelector('#pm-mic');
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => { isListening = true; micBtn.classList.add('pm-mic-on'); };
    recognition.onresult = (e) => {
      const t = Array.from(e.results).map(r => r[0].transcript).join('');
      inputArea.value = t;
      if (e.results[e.results.length - 1].isFinal) { stopListening(); sendMessage(); }
    };
    recognition.onerror = () => stopListening();
    recognition.onend = () => stopListening();
    micBtn.addEventListener('click', () => isListening ? stopListening() : startListening());
  } else {
    micBtn.style.display = 'none';
  }

  function startListening() { if (recognition && !isListening) try { recognition.start(); } catch(e){} }
  function stopListening() {
    if (recognition && isListening) {
      isListening = false;
      micBtn.classList.remove('pm-mic-on');
      try { recognition.stop(); } catch(e){}
    }
  }

})();
