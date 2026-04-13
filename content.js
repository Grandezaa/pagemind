(() => {
  if (document.getElementById('pagemind-root')) return;

  // ─── Root ──────────────────────────────────────────────────────────────────
  const root = document.createElement('div');
  root.id = 'pagemind-root';
  document.body.appendChild(root);

  // ─── State & Settings ──────────────────────────────────────────────────────
  let isLoading = false;
  let isListening = false;
  let isDragged = false;
  let orbHoldTimer = null;
  let recognition = null;
  let clickCount = 0;
  let clickTimer = null;
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
    geminiKey = data.geminiKey || FALLBACK_KEY;
    if (!data.geminiKey) chrome.storage.sync.set({ geminiKey: FALLBACK_KEY });
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.geminiKey) geminiKey = changes.geminiKey.newValue;
  });

  // ─── 🌗 Dark/Light Adaptive Detection ──────────────────────────────────────
  function detectPageTheme() {
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const match = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!match) return 'dark'; // default to dark
    const brightness = (parseInt(match[1]) * 299 + parseInt(match[2]) * 587 + parseInt(match[3]) * 114) / 1000;
    return brightness > 128 ? 'light' : 'dark';
  }

  function applyTheme() {
    const theme = detectPageTheme();
    root.setAttribute('data-pm-theme', theme);
  }

  // Apply on load and watch for dynamic changes
  setTimeout(applyTheme, 500);
  new MutationObserver(applyTheme).observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });

  // ─── UI Elements ───────────────────────────────────────────────────────────
  const orb = document.createElement('div');
  orb.id = 'pagemind-orb';
  orb.title = 'PageMind AI';
  root.appendChild(orb);

  const panel = document.createElement('div');
  panel.id = 'pagemind-panel';
  panel.className = 'pm-stacked-bar';
  panel.innerHTML = `
    <div class="pm-top-row">
      <textarea id="pagemind-input" placeholder="Ask me anything..." rows="1"></textarea>
      <button class="pm-action-btn" id="pagemind-mic" title="Voice">🎙</button>
      <button class="pm-action-btn" id="pagemind-send">➤</button>
      <button class="pm-action-btn" id="pagemind-close">✕</button>
    </div>
    <div id="pagemind-response" class="pm-response-row">
      <div id="pm-response-text">3-click for summary · 4-click to chat · Select text + click to explain</div>
      <div id="pagemind-ghost"><div id="pm-ghost-ring"></div></div>
    </div>
  `;
  root.appendChild(panel);

  const inputArea = panel.querySelector('#pagemind-input');
  const responseArea = panel.querySelector('#pm-response-text');
  const ghost = panel.querySelector('#pagemind-ghost');

  // ─── ⏱ Auto-Hide Timer (30s inactivity) ────────────────────────────────────
  function resetAutoHide() {
    if (autoHideTimer) clearTimeout(autoHideTimer);
    if (activeBarType) {
      autoHideTimer = setTimeout(() => {
        hidePanel();
      }, 30000); // 30 seconds
    }
  }

  // Reset timer on any interaction inside the panel
  panel.addEventListener('mousemove', resetAutoHide);
  panel.addEventListener('click', resetAutoHide);
  panel.addEventListener('keydown', resetAutoHide);

  // ─── Actions ───────────────────────────────────────────────────────────────
  function showPanel(type) {
    activeBarType = type;
    lastActiveBarType = type;
    panel.classList.add('pm-bar-visible');
    
    if (type === 'chat') {
      inputArea.placeholder = "Ask me anything...";
      inputArea.focus();
    } else if (type === 'explain') {
      inputArea.placeholder = "Explaining selection...";
    } else {
      inputArea.placeholder = "Summarizing page...";
    }
    resetAutoHide();
  }

  function hidePanel() {
    panel.classList.remove('pm-bar-visible');
    activeBarType = null;
    stopListening();
    if (autoHideTimer) clearTimeout(autoHideTimer);
  }

  // ─── 📝 Explain Selection ──────────────────────────────────────────────────
  function getSelectedText() {
    return window.getSelection().toString().trim();
  }

  async function explainSelection(selectedText) {
    if (isLoading || !selectedText) return;
    const key = await ensureKey();
    isLoading = true;
    showPanel('explain');
    responseArea.innerHTML = `<i>Explaining: "${selectedText.slice(0, 60)}${selectedText.length > 60 ? '...' : ''}"</i>`;
    ghost.classList.add('pm-ghost-active');

    try {
      const prompt = `The user highlighted the following text on a webpage and wants a clear, concise explanation:\n\n"${selectedText}"\n\nPage title: ${document.title}\n\nProvide a helpful explanation. Be concise but thorough.`;
      const res = await callGemini(key, prompt);
      responseArea.innerHTML = res.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    } catch (err) {
      responseArea.innerText = `⚠️ ${err.message}`;
    } finally {
      isLoading = false;
      ghost.classList.remove('pm-ghost-active');
      resetAutoHide();
    }
  }

  // ─── Orb Interactions ──────────────────────────────────────────────────────
  orb.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    isDragged = false; dragStart(e);
    orbHoldTimer = setTimeout(() => { if (!isDragged) { showPanel('chat'); startListening(); } }, 400);
  });

  orb.addEventListener('click', () => {
    if (isDragged) return;

    // 📝 Check for selected text FIRST — if text is highlighted, explain it immediately
    const selected = getSelectedText();
    if (selected && selected.length > 2) {
      explainSelection(selected);
      return; // Skip click counting
    }

    clickCount++;
    if (clickTimer) clearTimeout(clickTimer);
    clickTimer = setTimeout(async () => {
      if (clickCount === 1) activeBarType ? hidePanel() : showPanel(lastActiveBarType);
      else if (clickCount === 2) showPanel(lastActiveBarType);
      else if (clickCount === 3) await triggerSummary();
      else if (clickCount === 4) showPanel('chat');
      clickCount = 0;
    }, 350);
  });

  panel.querySelector('#pagemind-close').addEventListener('click', hidePanel);

  // ─── Logic ─────────────────────────────────────────────────────────────────
  async function triggerSummary() {
    if (isLoading) return;
    const key = await ensureKey();
    isLoading = true;
    showPanel('summary');
    responseArea.innerHTML = '<i>Reading and summarizing...</i>';
    ghost.classList.add('pm-ghost-active');

    try {
      const prompt = `Provide a concise 3-4 line summary of this page content:\n\n${getPageContext()}`;
      const res = await callGemini(key, prompt);
      responseArea.innerHTML = res.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    } catch (err) {
      responseArea.innerText = `⚠️ ${err.message}`;
    } finally {
      isLoading = false;
      ghost.classList.remove('pm-ghost-active');
      resetAutoHide();
    }
  }

  async function sendMessage() {
    const text = inputArea.value.trim();
    if (!text || isLoading) return;
    const key = await ensureKey();
    
    inputArea.value = '';
    responseArea.innerHTML = `<b>You:</b> ${text}<br><br><i>Thinking...</i>`;
    isLoading = true;
    ghost.classList.add('pm-ghost-active');

    try {
      let contextPrefix = "";
      if (text.startsWith('/search ')) {
        const query = text.replace('/search ', '').trim();
        const searchRes = await chrome.runtime.sendMessage({ type: 'SEARCH_WEB', query });
        contextPrefix = `Search results for "${query}":\n${searchRes.data}\n\n`;
      }
      const prompt = `You are PageMind, a helpful AI assistant. You can answer ANY question on any topic using your general knowledge. The user is currently browsing a webpage — here is some context from it in case it's relevant (but don't limit yourself to it):\n${getPageContext()}\n\n${contextPrefix}User Question: ${text}`;
      const reply = await callGemini(key, prompt);
      responseArea.innerHTML = reply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
    } catch (err) {
      responseArea.innerHTML = `⚠️ ${err.message}`;
    } finally {
      isLoading = false;
      ghost.classList.remove('pm-ghost-active');
      resetAutoHide();
    }
  }

  async function callGemini(key, prompt) {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.7, maxOutputTokens: 2048 }
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    return data.candidates?.[0]?.content?.parts?.[0]?.text || 'No response.';
  }

  function getPageContext() {
    return `Title: ${document.title}\nContent: ${document.body.innerText.slice(0, 4500)}`;
  }

  panel.querySelector('#pagemind-send').addEventListener('click', sendMessage);
  inputArea.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); } });

  // ─── Voice ─────────────────────────────────────────────────────────────────
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const micBtn = panel.querySelector('#pagemind-mic');
  if (SpeechRecognition) {
    recognition = new SpeechRecognition();
    recognition.continuous = false;
    recognition.interimResults = true;
    recognition.onstart = () => { isListening = true; micBtn.classList.add('pm-mic-active'); };
    recognition.onresult = (e) => {
      const transcript = Array.from(e.results).map(r => r[0].transcript).join('');
      inputArea.value = transcript;
      if (e.results[e.results.length - 1].isFinal) { stopListening(); sendMessage(); }
    };
    recognition.onerror = () => stopListening();
    recognition.onend = () => stopListening();
    micBtn.addEventListener('click', () => isListening ? stopListening() : startListening());
  } else { micBtn.style.display = 'none'; }
  function startListening() { if (recognition && !isListening) try { recognition.start(); } catch(e){} }
  function stopListening() { if (recognition && isListening) { isListening = false; micBtn.classList.remove('pm-mic-active'); try { recognition.stop(); } catch(e){} } }

  // ─── Draggable ORB ─────────────────────────────────────────────────────────
  let dragging = false; let dX = 0, dY = 0;
  function dragStart(e) {
    dragging = true;
    dX = e.clientX - orb.getBoundingClientRect().left;
    dY = e.clientY - orb.getBoundingClientRect().top;
    orb.style.transition = 'none';
  }
  document.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    isDragged = true;
    orb.style.right = 'auto'; orb.style.bottom = 'auto';
    orb.style.left = (e.clientX - dX) + 'px';
    orb.style.top = (e.clientY - dY) + 'px';
  });
  document.addEventListener('mouseup', () => { 
    dragging = false; orb.style.transition = '';
    setTimeout(() => isDragged = false, 100);
  });

})();