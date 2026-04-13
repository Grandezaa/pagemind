chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === 'SEARCH_WEB') {
    fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(request.query)}`)
      .then(res => res.text())
      .then(html => {
        // Basic parsing of DDG HTML to extract text snippets
        const text = html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        sendResponse({ data: text });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true; // Keep channel open for async fetch
  }

  if (request.type === 'BROWSE_URL') {
    fetch(request.url)
      .then(res => res.text())
      .then(html => {
        const text = html.replace(/<[^>]*>?/gm, ' ').replace(/\s+/g, ' ').trim().slice(0, 8000);
        sendResponse({ data: text });
      })
      .catch(err => sendResponse({ error: err.message }));
    return true;
  }
});