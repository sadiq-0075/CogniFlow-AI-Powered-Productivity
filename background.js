// background.js

// --- Global State & AI Model ---
let aiModel; // Will hold the TensorFlow.js model once loaded
let focusModeActive = false; // State of focus mode

// --- Data Structures for Storage (Initial Defaults) ---
// These will be loaded from chrome.storage.local on startup
const defaultInitialState = {
  focus_mode: false,
  current_goal: null,
  score_history: [], // [{ date: '...', score: 85, timeSpent: {...}, timeSinks: [...] }]
  workspaces: {}, // { 'wsId': { name: '...', goal: '...', urls: ['...', ...], active_tabs_ids: [...], metrics: {...} } }
  user_categories: ['Work', 'Social', 'Entertainment', 'Learning', 'Shopping', 'Neutral'],
  user_defined_rules: { // Domain-based rules have highest priority for categorization
    'github.com': 'Work',
    'notion.so': 'Work',
    'jira.atlassian.net': 'Work',
    'trello.com': 'Work',
    'stackoverflow.com': 'Learning',
    'developer.mozilla.org': 'Learning',
    'youtube.com': 'Entertainment', // youtube.com is often mixed, this is a placeholder
    'netflix.com': 'Entertainment',
    'facebook.com': 'Social',
    'twitter.com': 'Social',
    'instagram.com': 'Social',
    'reddit.com': 'Social'
  },
  sites_to_review: [], // [{ url: '...', ai_guess: '...', timestamp: ... }]
  tab_metadata: {}, // { 'tabId': { url: '...', title: '...', ai_category: 'Work', user_category: null, assigned_workspace: 'wsId1', time_active: 12345, last_activated: Date.now() } }
  session_start_time: Date.now() // For current session duration calculation
};


// --- Initialization: Load AI Model and State from Storage ---
chrome.runtime.onInstalled.addListener(async () => {
  // Set initial default state on installation if not already set
  const storedState = await chrome.storage.local.get(Object.keys(defaultInitialState));
  const stateToSet = {};
  for (const key in defaultInitialState) {
    if (storedState[key] === undefined) {
      stateToSet[key] = defaultInitialState[key];
    }
  }
  if (Object.keys(stateToSet).length > 0) {
    await chrome.storage.local.set(stateToSet);
  }
  console.log('CogniFlow installed/updated. Initial state set or merged.');
  loadInitialData(); // Load the rest
});

// Load persistent data and AI model when service worker starts
async function loadInitialData() {
  const result = await chrome.storage.local.get([
    'focus_mode', 'current_goal', 'user_defined_rules', 'session_start_time'
  ]);
  focusModeActive = result.focus_mode || false;
  // Deep copy for rules to prevent mutation issues with directly stored object
  // (though service worker reloads frequently, good practice)
  const storedRules = result.user_defined_rules || {};
  for (const key in storedRules) {
    categoryRules[key] = storedRules[key];
  }

  // Set session start time if it's not already there (e.g., first run)
  if (!result.session_start_time) {
      await chrome.storage.local.set({ session_start_time: Date.now() });
  }

  // Load TensorFlow.js model (if AI is enabled)
  try {
    // IMPORTANT: Ensure 'tfjs_models/' is correctly configured in manifest.json's web_accessible_resources
    aiModel = await tf.loadLayersModel(chrome.runtime.getURL('tfjs_models/model.json'));
    console.log('CogniFlow Background: AI Model loaded successfully.');
    // Warm up the model (optional, for faster first inference)
    aiModel.predict(tf.zeros([1, 128])); // IMPORTANT: Adjust [1, 128] to your model's actual input shape!
  } catch (error) {
    console.warn('CogniFlow Background: Failed to load AI model (AI features disabled):', error);
    aiModel = null; // Mark as null if loading fails, fall back to rule-based or 'Others'
  }
}
loadInitialData(); // Run on service worker startup

// --- Message Listener from Popup/Content Scripts ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.type) {
    case 'getTabId': // For content.js to get its tabId
        if (sender.tab) {
            sendResponse({ tabId: sender.tab.id });
        } else {
            sendResponse({ tabId: null });
        }
        return true;
    case 'analyzeTabsAndScore':
      analyzeTabsAndScore().then(sendResponse);
      return true;
    case 'notify': // Generic notification request
      chrome.notifications.create('', {
        type: 'basic',
        iconUrl: 'icons/icon48.png',
        title: 'CogniFlow Alert',
        message: request.message
      });
      break;
    case 'toggleFocusMode':
        toggleFocusMode().then(sendResponse);
        return true;
    case 'createNewWorkspace':
      createNewWorkspace(request.name).then(sendResponse);
      return true;
    case 'cleanupDistractions':
      cleanupDistractions().then(sendResponse);
      return true;
    case 'updateTabCategory':
      updateTabCategory(request.tabId, request.newCategory).then(sendResponse);
      return true;
    case 'assignTabToWorkspace':
      assignTabToWorkspace(request.tabId, request.workspaceId).then(sendResponse);
      return true;
    case 'contentExtracted': // From content.js
      classifyAndStoreTab(request.tabId, request.url, request.title, request.mainText).then(sendResponse);
      return true;
    case 'updateCategoryFromReview': // From popup for Sites to Review section
        updateSiteCategoryFromReview(request.url, request.newCategory).then(sendResponse);
        return true;
    case 'addCustomCategory': // From popup when user adds a custom category
        addCustomCategory(request.category).then(sendResponse);
        return true;
    case 'loadWorkspace':
        loadWorkspace(request.workspaceId).then(sendResponse);
        return true;
    case 'focusOnWorkspace':
        focusOnWorkspace(request.workspaceId).then(sendResponse);
        return true;
    case 'suspendWorkspace':
        suspendWorkspace(request.workspaceId).then(sendResponse);
        return true;
    case 'renameWorkspace':
        renameWorkspace(request.workspaceId, request.newName).then(sendResponse);
        return true;
    case 'deleteWorkspace':
        deleteWorkspace(request.workspaceId).then(sendResponse);
        return true;
  }
});

// --- Tab Event Listeners (Core Logic) ---
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  // Ensure the tab has a valid URL and has finished loading before processing
  if (changeInfo.status === 'complete' && tab.url && (tab.url.startsWith('http://') || tab.url.startsWith('https://'))) {
    // Inject content script to extract text for AI analysis
    try {
        await chrome.scripting.executeScript({
            target: { tabId: tabId },
            files: ['content.js']
        });
    } catch (e) {
        console.warn(`CogniFlow: Could not inject content script into tab ${tabId} (e.g., internal page, permissions issue): ${e.message}`);
    }

    // Process tab for focus mode (immediate action for distracting sites)
    await handleFocusMode(tab);
    
    // Update tab metadata (time tracking etc.) for the newly loaded/updated tab
    await updateTabTimeActive(tabId);
  }
});

chrome.tabs.onActivated.addListener(async (activeInfo) => {
    // When a tab becomes active, update its active time.
    await updateTabTimeActive(activeInfo.tabId);
});

chrome.tabs.onRemoved.addListener(async (tabId, removeInfo) => {
    // Clean up tab_metadata for removed tabs
    const result = await chrome.storage.local.get('tab_metadata');
    if (result.tab_metadata && result.tab_metadata[tabId]) {
        delete result.tab_metadata[tabId];
        await chrome.storage.local.set({ 'tab_metadata': result.tab_metadata });
    }
});


// --- AI Classification and Data Storage ---
async function classifyAndStoreTab(tabId, url, title, mainText) {
  let aiCategory = 'Others'; // Default category if nothing else matches
  let confidence = 0;
  let userCategory = null; // User override
  let assignedWorkspace = null; // Assigned workspace

  const storedState = await chrome.storage.local.get(['tab_metadata', 'user_defined_rules']);
  const tabMetadata = storedState.tab_metadata || {};
  const userDefinedRules = storedState.user_defined_rules || {};

  // Retrieve existing user category/workspace if tab was already processed
  const existingMetadata = tabMetadata[tabId];
  if (existingMetadata) {
      userCategory = existingMetadata.user_category;
      assignedWorkspace = existingMetadata.assigned_workspace;
  }

  // 1. Check User-Defined Rules First (Highest Priority)
  // Iterate through rules to find a match. Order of rules might matter for more complex setups.
  for (const ruleUrlPattern in userDefinedRules) {
    try {
        // Simple wildcard match for now. For regex, use `new RegExp(ruleUrlPattern).test(url)`
        if (url.includes(ruleUrlPattern) || new RegExp(ruleUrlPattern.replace(/\./g, '\\.').replace(/\*/g, '.*')).test(url)) {
            aiCategory = userDefinedRules[ruleUrlPattern];
            console.log(`CogniFlow: Tab ${tabId} (${url}) categorized by user rule: ${aiCategory}`);
            // If a user rule exists, it overrides AI and we don't need to add to sites to review.
            userCategory = aiCategory; // Set userCategory as it's a direct user rule
            break; // Found a match, stop
        }
    } catch (e) {
        console.error(`CogniFlow: Invalid regex rule: ${ruleUrlPattern}`, e);
    }
  }

  // 2. If no user rule, use AI (if model loaded and sufficient text)
  if (userCategory === null && aiModel && mainText && mainText.length > 50) { // Require sufficient text for AI
    try {
      // --- AI Model Prediction Logic (THIS IS THE CORE AI PART YOU MUST IMPLEMENT) ---
      // This part is highly dependent on your specific TensorFlow.js model.
      // You'll need to implement a tokenizer and possibly a vocabulary.
      const cleanedText = mainText.substring(0, 512); // Limit input size for performance
      // Example placeholder:
      const inputTensor = await encodeTextForAI(cleanedText); // This function needs to be implemented by you
      if (inputTensor) {
          const prediction = aiModel.predict(inputTensor);
          // Assuming a classification model where output is probabilities for categories
          const predictionArray = prediction.dataSync(); // Get numerical prediction values
          const categoryLabels = ['Work', 'Social', 'Entertainment', 'Learning', 'Shopping', 'Neutral', 'Others']; // IMPORTANT: Must match your model's output order!

          const maxConfidenceIndex = prediction.argMax(-1).dataSync()[0];
          aiCategory = categoryLabels[maxConfidenceIndex];
          confidence = predictionArray[maxConfidenceIndex];

          console.log(`CogniFlow: Tab ${tabId} (${url}) categorized by AI: ${aiCategory} (Confidence: ${confidence.toFixed(2)})`);

          // If AI is not confident, add to review list (only if no existing user rule)
          if (confidence < 0.7 && !userDefinedRules[new URL(url).hostname]) { // Threshold and no existing user rule
            await addToSitesToReview(url, aiCategory);
          }
      } else {
          console.warn("CogniFlow: Text encoding for AI failed or returned null.");
      }
    } catch (e) {
      console.error(`CogniFlow: AI classification failed for ${url}:`, e);
      aiCategory = 'Others'; // Fallback if AI errors
    }
  }

  // 3. Store/Update Tab Metadata
  tabMetadata[tabId] = {
    url: url,
    title: title,
    ai_category: aiCategory,
    user_category: userCategory, // Will be null unless user has explicitly overridden/ruled
    assigned_workspace: assignedWorkspace,
    time_active: 0, // Reset for this new load/activation
    last_activated: Date.now() // Track for time active calculations
  };
  await chrome.storage.local.set({ tab_metadata: tabMetadata });
}


/**
 * IMPORTANT: You MUST implement this function to convert raw text into a format
 * that your TensorFlow.js model expects (e.g., token IDs, embeddings).
 * This typically involves:
 * 1. Tokenization (splitting text into words/subwords)
 * 2. Vocabulary lookup (mapping tokens to numerical IDs)
 * 3. Padding/Truncation (making all input sequences the same length)
 *
 * Example (conceptual, requires external tokenizer/vocab):
 * `const tokenizer = await SomeTFJSTokenizer.load();`
 * `const sequence = tokenizer.textsToSequences([text]);`
 * `const paddedSequence = tf.keras.preprocessing.sequence.padSequences(sequence, {maxlen: YOUR_MODEL_INPUT_LENGTH});`
 * `return tf.tensor(paddedSequence);`
 */
async function encodeTextForAI(text) {
  // Placeholder: Return a dummy tensor. Replace with actual text processing.
  // This will likely involve loading a tokenizer model and a vocabulary.
  console.warn("CogniFlow: `encodeTextForAI` is a placeholder. Implement your AI model's specific text preprocessing here.");
  return tf.zeros([1, 128]); // Example for a model expecting [batch_size, sequence_length]
}

async function addToSitesToReview(url, aiGuess) {
  const result = await chrome.storage.local.get('sites_to_review');
  const sites = result.sites_to_review || [];
  // Add only if not already in the review list and not explicitly defined by a user rule
  const domain = new URL(url).hostname;
  const storedRules = (await chrome.storage.local.get('user_defined_rules')).user_defined_rules || {};

  if (!sites.some(s => s.url === url) && !storedRules[domain]) {
    sites.push({ url: url, ai_guess: aiGuess, timestamp: Date.now() });
    await chrome.storage.local.set({ sites_to_review: sites });
    // Notify popup to update its review list
    chrome.runtime.sendMessage({ type: 'uiUpdate' });
  }
}

async function updateSiteCategoryFromReview(urlToUpdate, newCategory) {
    const result = await chrome.storage.local.get(['sites_to_review', 'user_defined_rules', 'tab_metadata']);
    let sitesToReview = result.sites_to_review || [];
    let userDefinedRules = result.user_defined_rules || {};
    let tabMetadata = result.tab_metadata || {};

    // 1. Remove from sites_to_review
    sitesToReview = sitesToReview.filter(item => item.url !== urlToUpdate);

    // 2. Add/Update user-defined rule for this domain
    try {
        const domain = new URL(urlToUpdate).hostname;
        userDefinedRules[domain] = newCategory;
        // Update the global categoryRules object in memory
        categoryRules[domain] = newCategory;
    } catch (e) {
        console.error("CogniFlow: Invalid URL for rule creation:", urlToUpdate, e);
        // Continue without adding rule if URL is invalid
    }


    // 3. Update existing tab metadata for this URL/domain/tab if it's currently open
    const allTabs = await chrome.tabs.query({});
    for (const tab of allTabs) {
        if (tab.url && tab.url.includes(urlToUpdate) && tabMetadata[tab.id]) {
            tabMetadata[tab.id].user_category = newCategory; // Set user-defined override
            tabMetadata[tab.id].ai_category = newCategory; // Also update AI category for immediate reflection
        }
    }

    await chrome.storage.local.set({
        sites_to_review: sitesToReview,
        user_defined_rules: userDefinedRules,
        tab_metadata: tabMetadata
    });

    console.log(`CogniFlow: Category for ${urlToUpdate} updated to ${newCategory} by user.`);
    return { success: true };
}

async function addCustomCategory(newCategory) {
    const result = await chrome.storage.local.get('user_categories');
    const userCategories = result.user_categories || [];

    if (userCategories.includes(newCategory)) {
        return { success: false, message: "Category already exists." };
    }

    userCategories.push(newCategory);
    await chrome.storage.local.set({ user_categories: userCategories });
    return { success: true };
}


// --- Tab Time Tracking ---
async function updateTabTimeActive(activeTabId) {
    const result = await chrome.storage.local.get('tab_metadata');
    const tabMetadata = result.tab_metadata || {};
    const now = Date.now();

    // Iterate through all tabs in metadata to update time
    for (const id in tabMetadata) {
        const metadata = tabMetadata[id];
        // Only calculate if the tab was active just before this update
        if (metadata.last_activated && parseInt(id) !== activeTabId) {
            const timeDiff = now - metadata.last_activated;
            metadata.time_active = (metadata.time_active || 0) + timeDiff;
            metadata.last_activated = null; // Mark as no longer active
        }
    }

    // Set the currently active tab's last_activated time
    if (tabMetadata[activeTabId]) {
        tabMetadata[activeTabId].last_activated = now;
    } else {
        // If metadata for activeTabId doesn't exist yet (e.g., first time opening after install)
        const tab = await chrome.tabs.get(activeTabId);
        if (tab) {
             // Re-trigger classification for this tab if it's new
            await classifyAndStoreTab(tab.id, tab.url, tab.title, ''); // Empty text for now, will be updated by content.js
        }
    }

    await chrome.storage.local.set({ tab_metadata: tabMetadata });
}


// --- Focus Mode Logic ---
async function toggleFocusMode() {
  focusModeActive = !focusModeActive;
  await chrome.storage.local.set({ focus_mode: focusModeActive });
  console.log(`CogniFlow: Focus Mode is now ${focusModeActive ? 'ON' : 'OFF'}`);
  return { success: true, newState: focusModeActive };
}

async function handleFocusMode(tab) {
  const result = await chrome.storage.local.get('focus_mode');
  if (!result.focus_mode) return; // Focus mode not active

  const tabMetadataResult = await chrome.storage.local.get('tab_metadata');
  const tabMetadata = tabMetadataResult.tab_metadata?.[tab.id];
  // Prioritize user category if available, otherwise use AI category
  const category = tabMetadata?.user_category || tabMetadata?.ai_category;

  if (['Social', 'Entertainment', 'Shopping'].includes(category)) {
    console.log(`CogniFlow: Focus Mode: Blocking distracting tab (${category}): ${tab.url}`);
    const pausePageUrl = chrome.runtime.getURL('mindful_pause.html') + `?blockedUrl=${encodeURIComponent(tab.url)}`;
    try {
      await chrome.tabs.update(tab.id, { url: pausePageUrl });
      chrome.runtime.sendMessage({ type: 'notify', message: `CogniFlow: Blocked distracting site: ${tab.title || tab.url}` });
    } catch (e) {
      console.error("CogniFlow: Failed to redirect tab for focus mode:", e);
    }
  }
}

// Function to allow overriding the block from mindful_pause.html
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'overrideBlock' && sender.tab) {
        chrome.tabs.update(sender.tab.id, { url: request.url }, () => {
            sendResponse({ success: true });
        });
        return true;
    }
});


// --- Workspace Management ---
async function createNewWorkspace(name) {
  const result = await chrome.storage.local.get('workspaces');
  const workspaces = result.workspaces || {};
  const newWsId = `ws_${Date.now()}`; // Simple unique ID

  if (Object.values(workspaces).some(ws => ws.name.toLowerCase() === name.toLowerCase())) {
    return { success: false, message: 'Workspace with this name already exists.' };
  }

  workspaces[newWsId] = {
    id: newWsId,
    name: name,
    goal: null, // User can set later
    urls: [], // URLs of tabs saved in this workspace (snapshot)
    active_tabs_ids: [], // IDs of currently open tabs belonging to this workspace
    created_date: new Date().toISOString(),
    last_accessed: new Date().toISOString(),
    metrics: { total_time_spent: 0, avg_focus_score: 0 }
  };
  await chrome.storage.local.set({ workspaces: workspaces });
  chrome.runtime.sendMessage({ type: 'uiUpdate' }); // Notify popup to refresh
  return { success: true, id: newWsId };
}

async function assignTabToWorkspace(tabId, workspaceId) {
    const result = await chrome.storage.local.get(['tab_metadata', 'workspaces']);
    const tabMetadata = result.tab_metadata || {};
    const workspaces = result.workspaces || {};

    if (!tabMetadata[tabId]) {
        return { success: false, message: "Tab metadata not found. Is tab currently open?" };
    }

    // Remove from old workspace if assigned
    const oldWsId = tabMetadata[tabId].assigned_workspace;
    if (oldWsId && workspaces[oldWsId]) {
        workspaces[oldWsId].active_tabs_ids = workspaces[oldWsId].active_tabs_ids.filter(id => id !== tabId);
        // Only remove URL from saved list if this was the *last* instance of it in the workspace
        if (!workspaces[oldWsId].active_tabs_ids.some(tid => tabMetadata[tid]?.url === tabMetadata[tabId].url)) {
             workspaces[oldWsId].urls = workspaces[oldWsId].urls.filter(url => url !== tabMetadata[tabId].url);
        }
    }

    // Assign to new workspace
    if (workspaceId) {
        if (!workspaces[workspaceId]) {
            return { success: false, message: "Target workspace not found." };
        }
        tabMetadata[tabId].assigned_workspace = workspaceId;
        workspaces[workspaceId].active_tabs_ids.push(tabId);
        // Add URL to workspace's saved URLs if not already there
        if (!workspaces[workspaceId].urls.includes(tabMetadata[tabId].url)) {
             workspaces[workspaceId].urls.push(tabMetadata[tabId].url);
        }
    } else {
        tabMetadata[tabId].assigned_workspace = null; // Unassign
    }

    await chrome.storage.local.set({ tab_metadata: tabMetadata, workspaces: workspaces });
    chrome.runtime.sendMessage({ type: 'uiUpdate' });
    return { success: true };
}

async function loadWorkspace(wsId) {
    const result = await chrome.storage.local.get('workspaces');
    const workspace = result.workspaces?.[wsId];
    if (!workspace) {
        return { success: false, message: "Workspace not found." };
    }
    if (workspace.urls.length === 0) {
        return { success: false, message: "Workspace is empty." };
    }

    // Open tabs for the workspace
    for (const url of workspace.urls) {
        try {
            await chrome.tabs.create({ url: url });
        } catch (e) {
            console.error(`CogniFlow: Failed to open tab for URL ${url}:`, e);
        }
    }
    await chrome.storage.local.set({session_start_time: Date.now()}); // Reset session time on loading workspace
    return { success: true, name: workspace.name };
}

async function focusOnWorkspace(wsId) {
    const result = await chrome.storage.local.get(['workspaces', 'tab_metadata']);
    const workspace = result.workspaces?.[wsId];
    if (!workspace) {
        return { success: false, message: "Workspace not found." };
    }

    const tabsToClose = [];
    const allTabs = await chrome.tabs.query({currentWindow: true}); // Only current window
    const tabMetadata = result.tab_metadata || {};

    for (const tab of allTabs) {
        // Skip extension pages, internal chrome pages
        if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) continue;

        const metadata = tabMetadata[tab.id];
        if (!metadata || metadata.assigned_workspace !== wsId) {
            tabsToClose.push(tab.id);
        }
    }

    if (tabsToClose.length > 0) {
        await chrome.tabs.remove(tabsToClose);
    }
    return { success: true, name: workspace.name, closedCount: tabsToClose.length };
}

async function suspendWorkspace(wsId) {
    const result = await chrome.storage.local.get(['workspaces', 'tab_metadata']);
    const workspace = result.workspaces?.[wsId];
    if (!workspace) {
        return { success: false, message: "Workspace not found." };
    }

    const tabsToClose = [];
    const allTabs = await chrome.tabs.query({currentWindow: true});
    const tabMetadata = result.tab_metadata || {};
    let closedCount = 0;

    for (const tab of allTabs) {
        const metadata = tabMetadata[tab.id];
        if (metadata && metadata.assigned_workspace === wsId) {
            tabsToClose.push(tab.id);
            closedCount++;
        }
    }

    if (tabsToClose.length > 0) {
        await chrome.tabs.remove(tabsToClose);
        // The URLs are already saved in workspace.urls (from assignTabToWorkspace)
        // No need to explicitly save again, just ensure metadata is updated when tabs close.
    }
    return { success: true, name: workspace.name, closedCount: closedCount };
}

async function renameWorkspace(wsId, newName) {
    const result = await chrome.storage.local.get('workspaces');
    const workspaces = result.workspaces || {};

    if (!workspaces[wsId]) {
        return { success: false, message: "Workspace not found." };
    }
    if (Object.values(workspaces).some(ws => ws.name.toLowerCase() === newName.toLowerCase() && ws.id !== wsId)) {
        return { success: false, message: "A workspace with this name already exists." };
    }
    if (!newName || newName.trim() === '') {
        return { success: false, message: "Workspace name cannot be empty." };
    }

    workspaces[wsId].name = newName.trim();
    await chrome.storage.local.set({ workspaces: workspaces });
    chrome.runtime.sendMessage({ type: 'uiUpdate' });
    return { success: true, newName: newName.trim() };
}

async function deleteWorkspace(wsId) {
    const result = await chrome.storage.local.get(['workspaces', 'tab_metadata']);
    let workspaces = result.workspaces || {};
    let tabMetadata = result.tab_metadata || {};

    if (!workspaces[wsId]) {
        return { success: false, message: "Workspace not found." };
    }

    // Disassociate any open tabs from this workspace in tab_metadata
    for (const tabId in tabMetadata) {
        if (tabMetadata[tabId].assigned_workspace === wsId) {
            tabMetadata[tabId].assigned_workspace = null;
        }
    }

    delete workspaces[wsId];

    await chrome.storage.local.set({ workspaces: workspaces, tab_metadata: tabMetadata });
    chrome.runtime.sendMessage({ type: 'uiUpdate' });
    return { success: true };
}


async function cleanupDistractions() {
  const tabsToClose = [];
  const allTabs = await chrome.tabs.query({currentWindow: true});
  const result = await chrome.storage.local.get('tab_metadata');
  const tabMetadata = result.tab_metadata || {};
  let closedCount = 0;

  for (const tab of allTabs) {
    // Skip extension pages, internal chrome pages
    if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) continue;

    const metadata = tabMetadata[tab.id];
    const category = metadata?.user_category || metadata?.ai_category;
    if (['Social', 'Entertainment', 'Shopping'].includes(category)) {
      tabsToClose.push(tab.id);
      closedCount++;
    }
  }

  if (tabsToClose.length > 0) {
    await chrome.tabs.remove(tabsToClose);
  }
  return { success: true, closedCount: closedCount };
}

// --- Analysis Functions (For analyzeCurrentSession) ---
async function analyzeTabsAndScore() {
    const result = await chrome.storage.local.get(['tab_metadata', 'session_start_time']);
    const tabMetadata = result.tab_metadata || {};
    const sessionStartTime = result.session_start_time || Date.now();

    // Ensure all currently open tabs have up-to-date time_active before analysis
    await updateTabTimeActive((await chrome.tabs.query({active: true, currentWindow: true}))[0]?.id || null);

    let categories = { Work: 0, Social: 0, Entertainment: 0, Learning: 0, Shopping: 0, Neutral: 0, Others: 0 };
    let timePerCategory = { Work: 0, Social: 0, Entertainment: 0, Learning: 0, Shopping: 0, Neutral: 0, Others: 0 }; // in ms
    let totalTabs = 0;
    let distractions = 0;
    let timeSinks = []; // URLs of tabs categorized as distractions with significant time

    const now = Date.now();
    let totalSessionTime = now - sessionStartTime;
    if (totalSessionTime < 0) totalSessionTime = 0; // Handle clock changes or resets

    // Collect data for currently open and tracked tabs
    for (const tabId in tabMetadata) {
        const metadata = tabMetadata[tabId];
        const category = metadata.user_category || metadata.ai_category || 'Others';
        categories[category] = (categories[category] || 0) + 1;
        totalTabs++;

        const activeTime = metadata.time_active || 0;
        timePerCategory[category] = (timePerCategory[category] || 0) + activeTime;

        // Identify distractions and time sinks
        if (['Social', 'Entertainment', 'Shopping'].includes(category)) {
            distractions++;
            if (activeTime > 60 * 1000 * 5) { // e.g., > 5 minutes
                timeSinks.push(metadata.url);
            }
        }
    }

    // Calculate score based on total time spent on productive vs. unproductive categories
    const productiveTime = (timePerCategory.Work || 0) + (timePerCategory.Learning || 0) + (timePerCategory.Neutral || 0);
    const unproductiveTime = (timePerCategory.Social || 0) + (timePerCategory.Entertainment || 0) + (timePerCategory.Shopping || 0);
    const totalTrackedTime = productiveTime + unproductiveTime + (timePerCategory.Others || 0);

    let productivityScore = 0;
    if (totalTrackedTime > 0) {
        productivityScore = Math.floor((productiveTime / totalTrackedTime) * 100);
    } else {
        productivityScore = 100; // If no activity tracked, assume 100% focused
    }

    // Save score to history
    const historyResult = await chrome.storage.local.get('score_history');
    const history = historyResult.score_history || [];
    history.push({
        date: new Date().toLocaleString(),
        score: productivityScore,
        timestamp: now,
        categoriesDistribution: categories, // Snapshot of current categories count
        timePerCategory: timePerCategory, // Snapshot of time per category
        totalSessionTime: totalSessionTime, // Time since session started
        timeSinks: [...new Set(timeSinks)]
    });
    await chrome.storage.local.set({ score_history: history });

    return {
        categories: categories,
        timePerCategory: timePerCategory,
        totalTabs: totalTabs,
        score: productivityScore,
        timeSinks: [...new Set(timeSinks)] // Unique time sinks
    };
}