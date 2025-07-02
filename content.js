// content.js
// This script runs inside each webpage to extract content for AI analysis

(async () => {
  const url = window.location.href;
  const title = document.title;
  let mainText = '';

  // Skip internal chrome pages or extension pages for content extraction
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    console.log(`CogniFlow Content: Skipping non-web page: ${url}`);
    return;
  }

  // Extract main text content. This can be complex and may need refinement.
  // A robust approach often involves identifying main content areas.
  // This is a simple example that selects common elements.
  const selectors = 'h1, h2, h3, h4, h5, h6, p, li, article, section, main, pre';
  const elements = document.querySelectorAll(selectors);

  for (const el of elements) {
    if (el.offsetWidth > 0 || el.offsetHeight > 0) { // Check if element is visible
      const text = el.textContent || '';
      // Limit text per element and total text to avoid huge strings
      mainText += text.substring(0, 200) + ' '; // Take first 200 chars from each element
      if (mainText.length > 2000) break; // Limit total text length for AI analysis
    }
  }

  // Basic cleanup: remove excessive whitespace and trim
  mainText = mainText.replace(/\s+/g, ' ').trim();

  // Send extracted data to background script
  try {
    const tabId = await getCurrentTabId();
    if (tabId !== null) {
        await chrome.runtime.sendMessage({
            type: 'contentExtracted',
            url: url,
            title: title,
            mainText: mainText,
            tabId: tabId
        });
        // console.log('CogniFlow Content: Sent content to background for:', url);
    } else {
        console.warn('CogniFlow Content: Could not determine tabId for message.');
    }
  } catch (error) {
    // This error often happens if the background script isn't ready or message fails
    // or if the content script is injected into a page where messaging is restricted.
    console.warn('CogniFlow Content: Error sending content to background (might be expected for some pages):', error);
  }
})();

// Helper function to get the current tab ID from content script
// This is necessary because content scripts don't directly know their tabId.
async function getCurrentTabId() {
    // This sends a message to the background script and waits for a response
    // containing the tabId based on the sender information.
    return new Promise(resolve => {
        chrome.runtime.sendMessage({ type: 'getTabId' }, response => {
            if (chrome.runtime.lastError) {
                // Handle cases where background script is not ready or message fails
                console.error("CogniFlow Content: Error getting tab ID:", chrome.runtime.lastError.message);
                resolve(null);
            } else {
                resolve(response ? response.tabId : null);
            }
        });
    });
}