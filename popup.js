// popup.js

// --- Global Variables / Model Loading ---
let aiModelLocal; // To hold the loaded TensorFlow.js model in popup for direct interaction if needed

async function loadAIModelForPopup() {
  try {
    // IMPORTANT: Ensure 'tfjs_models/' is correctly configured in manifest.json's web_accessible_resources
    aiModelLocal = await tf.loadLayersModel(chrome.runtime.getURL('tfjs_models/model.json'));
    console.log('CogniFlow Popup: AI Model loaded successfully.');
    // You might want to update a UI element to indicate model is ready
  } catch (error) {
    console.warn('CogniFlow Popup: Error loading AI model locally (popup won\'t classify directly):', error);
    // Fallback: popup can still send messages to background for classification
    aiModelLocal = null;
  }
}

// --- Event Listeners ---
document.addEventListener('DOMContentLoaded', async () => {
  await loadAIModelForPopup(); // Load AI model when popup opens
  renderUI(); // Initial rendering of all sections
});

// Helper to re-render all dynamic parts of the UI
async function renderUI() {
    await renderWorkspaces();
    await renderOpenTabs();
    await renderSitesToReview();
    await updateHeaderSummary();
    loadCategoryChartPlaceholder(); // Load initial empty chart or placeholder
}

// Attach event listeners to buttons
document.getElementById('setGoalBtn').addEventListener('click', setSessionGoal);
document.getElementById('toggleFocusMode').addEventListener('click', toggleFocusMode);
document.getElementById('analyzeSession').addEventListener('click', analyzeCurrentSession);
document.getElementById('createNewWorkspace').addEventListener('click', createNewWorkspace);
document.getElementById('oneClickCleanup').addEventListener('click', oneClickCleanup);
document.getElementById('viewHistoryBtn').addEventListener('click', viewFullHistory);
document.getElementById('openSettingsBtn').addEventListener('click', openSettingsPage);

// --- Functions for UI Rendering and Data Display ---

async function renderWorkspaces() {
  const workspacesContainer = document.getElementById('workspacesContainer');
  workspacesContainer.innerHTML = '<p class="placeholder-item">No workspaces created yet.</p>'; // Default placeholder

  const result = await chrome.storage.local.get('workspaces');
  const workspaces = result.workspaces || {};

  if (Object.keys(workspaces).length > 0) {
    workspacesContainer.innerHTML = ''; // Clear placeholder if workspaces exist
    for (const id in workspaces) {
      const workspace = workspaces[id];
      const wsDiv = document.createElement('div');
      wsDiv.className = 'workspace-item';
      wsDiv.innerHTML = `
        <h3>${escapeHTML(workspace.name)} (${workspace.urls.length} tabs saved)</h3>
        <p>Goal: ${escapeHTML(workspace.goal || 'Not set')}</p>
        <div class="workspace-controls">
          <button data-ws-id="${id}" class="load-workspace">Load</button>
          <button data-ws-id="${id}" class="focus-workspace">Focus</button>
          <button data-ws-id="${id}" class="suspend-workspace">Suspend</button>
          <button data-ws-id="${id}" class="edit-workspace">Edit</button>
          <button data-ws-id="${id}" class="delete-workspace">Delete</button>
        </div>
      `;
      workspacesContainer.appendChild(wsDiv);
    }
    // Attach event listeners for dynamically created buttons
    workspacesContainer.querySelectorAll('.load-workspace').forEach(btn => {
      btn.addEventListener('click', (e) => loadWorkspace(e.target.dataset.wsId));
    });
    workspacesContainer.querySelectorAll('.focus-workspace').forEach(btn => {
      btn.addEventListener('click', (e) => focusOnWorkspace(e.target.dataset.wsId));
    });
    workspacesContainer.querySelectorAll('.suspend-workspace').forEach(btn => {
      btn.addEventListener('click', (e) => suspendWorkspace(e.target.dataset.wsId));
    });
    workspacesContainer.querySelectorAll('.edit-workspace').forEach(btn => {
      btn.addEventListener('click', (e) => editWorkspace(e.target.dataset.wsId));
    });
    workspacesContainer.querySelectorAll('.delete-workspace').forEach(btn => {
      btn.addEventListener('click', (e) => deleteWorkspace(e.target.dataset.wsId));
    });
  }
}

async function renderOpenTabs() {
  const openTabsList = document.getElementById('openTabsList');
  openTabsList.innerHTML = '<li class="placeholder-item">No tabs open.</li>'; // Default placeholder

  const tabs = await chrome.tabs.query({currentWindow: true}); // Only current window for simplicity
  document.getElementById('openTabsCount').textContent = tabs.length;

  if (tabs.length === 0) return;

  openTabsList.innerHTML = ''; // Clear placeholder if tabs exist

  const result = await chrome.storage.local.get(['tab_metadata', 'workspaces']);
  const tabMetadata = result.tab_metadata || {};
  const workspaces = result.workspaces || {};

  const groupedTabs = {};
  tabs.forEach(tab => {
    // Only process http/https tabs
    if (!tab.url || (!tab.url.startsWith('http://') && !tab.url.startsWith('https://'))) return;

    const metadata = tabMetadata[tab.id] || {};
    const wsId = metadata.assigned_workspace || 'unassigned';
    if (!groupedTabs[wsId]) {
      groupedTabs[wsId] = [];
    }
    groupedTabs[wsId].push({ tab: tab, metadata: metadata });
  });

  for (const wsId in groupedTabs) {
    const groupName = wsId === 'unassigned' ? 'Unassigned Tabs' : workspaces[wsId]?.name || 'Unknown Workspace';
    const groupHeader = document.createElement('li');
    groupHeader.className = 'tab-group-header';
    groupHeader.innerHTML = `<h3>${escapeHTML(groupName)} (${groupedTabs[wsId].length})</h3>`;
    openTabsList.appendChild(groupHeader);

    groupedTabs[wsId].forEach(({ tab, metadata }) => {
      const li = document.createElement('li');
      li.className = 'tab-item';
      li.dataset.tabId = tab.id;
      // Draggable is for future drag-and-drop implementation
      li.draggable = true;
      li.innerHTML = `
        <img src="${tab.favIconUrl || 'icons/default_favicon.png'}" class="favicon" alt="Favicon">
        <span class="tab-title">${escapeHTML(tab.title || tab.url)}</span>
        <span class="tab-category">${escapeHTML(metadata.user_category || metadata.ai_category || 'Uncategorized')} <span class="edit-category-btn" data-tab-id="${tab.id}">✎</span></span>
        <span class="tab-workspace">${metadata.assigned_workspace ? escapeHTML(workspaces[metadata.assigned_workspace]?.name) : 'Unassigned'} <span class="assign-workspace-btn" data-tab-id="${tab.id}">+</span></span>
      `;
      openTabsList.appendChild(li);

      li.querySelector('.edit-category-btn').addEventListener('click', (e) => showCategoryEditDropdown(e.target.dataset.tabId, e.target));
      li.querySelector('.assign-workspace-btn').addEventListener('click', (e) => showAssignWorkspaceDropdown(e.target.dataset.tabId, e.target));
    });
  }
}

async function renderSitesToReview() {
  const reviewList = document.getElementById('reviewList');
  reviewList.innerHTML = '<li class="placeholder-item">No sites awaiting review.</li>'; // Default placeholder

  const result = await chrome.storage.local.get('sites_to_review');
  const sitesToReview = result.sites_to_review || [];

  document.getElementById('reviewCount').textContent = sitesToReview.length;

  if (sitesToReview.length > 0) {
    reviewList.innerHTML = ''; // Clear placeholder if sites exist
    sitesToReview.forEach(item => {
      const li = document.createElement('li');
      li.className = 'review-item';
      li.innerHTML = `
        <span>${escapeHTML(item.url)}</span> (AI guess: ${escapeHTML(item.ai_guess || 'N/A')})
        <select class="review-category-select" data-url="${escapeHTML(item.url)}">
          <option value="">Select Category</option>
          <option value="Work">Work</option>
          <option value="Social">Social</option>
          <option value="Entertainment">Entertainment</option>
          <option value="Learning">Learning</option>
          <option value="Shopping">Shopping</option>
          <option value="Neutral">Neutral</option>
          </select>
        <button class="apply-review-btn" data-url="${escapeHTML(item.url)}">Apply</button>
      `;
      reviewList.appendChild(li);

      li.querySelector('.apply-review-btn').addEventListener('click', async (e) => {
        const url = e.target.dataset.url;
        const select = li.querySelector('.review-category-select');
        const newCategory = select.value;
        if (newCategory) {
          const response = await chrome.runtime.sendMessage({ type: 'updateCategoryFromReview', url: url, newCategory: newCategory });
          if (response.success) {
            console.log(`Category for ${url} updated to ${newCategory}.`);
            renderUI(); // Re-render all sections to reflect changes
          } else {
            alert(`Error updating category: ${response.message}`);
          }
        } else {
          alert('Please select a category.');
        }
      });
    });
  }
}

async function updateHeaderSummary() {
  const result = await chrome.storage.local.get(['current_goal', 'score_history']);
  const currentGoal = result.current_goal || 'Not set';
  document.getElementById('currentFocusGoal').textContent = `Goal: ${escapeHTML(currentGoal)}`;

  const scoreHistory = result.score_history || [];
  if (scoreHistory.length > 0) {
    const lastScore = scoreHistory[scoreHistory.length - 1].score;
    document.getElementById('overallProductivityScore').textContent = `Score: ${lastScore}/100`;
  } else {
    document.getElementById('overallProductivityScore').textContent = `Score: --/100`;
  }
}

let categoryChartInstance = null; // To hold the Chart.js instance

function loadCategoryChartPlaceholder() {
  const ctx = document.getElementById('categoryChart').getContext('2d');
  if (categoryChartInstance) { // Destroy existing chart if it exists
    categoryChartInstance.destroy();
  }
  categoryChartInstance = new Chart(ctx, {
    type: 'pie',
    data: {
      labels: ['Work', 'Social', 'Entertainment', 'Learning', 'Others'],
      datasets: [{
        data: [1, 1, 1, 1, 1], // Small dummy data for visibility
        backgroundColor: ['#36a2eb', '#ff6384', '#ffcd56', '#4bc0c0', '#999']
      }]
    },
    options: {
      responsive: true,
      plugins: {
        legend: {
          position: 'top',
          labels: { color: '#eee' }
        },
        title: {
          display: true,
          text: 'Current Session Category Distribution',
          color: '#eee'
        }
      }
    }
  });
}

// --- User Interaction Functions ---

function setSessionGoal() {
  const goal = prompt("What's your main goal for this session?");
  if (goal) {
    chrome.storage.local.set({ current_goal: goal.trim() }, () => {
      updateHeaderSummary();
      alert(`Session goal set: ${goal}`);
    });
  }
}

async function toggleFocusMode() {
  const response = await chrome.runtime.sendMessage({ type: 'toggleFocusMode' });
  if (response.success) {
    alert(`Focus Mode is now ${response.newState ? 'ON' : 'OFF'}`);
    // Optionally update button text or style based on response.newState
  } else {
    alert(`Failed to toggle Focus Mode: ${response.message}`);
  }
}

async function analyzeCurrentSession() {
  document.getElementById('sessionDetails').innerHTML = '<p>Analyzing...</p>';
  const response = await chrome.runtime.sendMessage({ type: 'analyzeTabsAndScore' });

  if (response && response.categories && response.score) {
    const ctx = document.getElementById('categoryChart').getContext('2d');
    if (categoryChartInstance) {
        categoryChartInstance.destroy();
    }
    categoryChartInstance = new Chart(ctx, {
      type: 'pie',
      data: {
        labels: Object.keys(response.categories),
        datasets: [{
          data: Object.values(response.categories),
          backgroundColor: ['#36a2eb', '#ff6384', '#ffcd56', '#4bc0c0', '#999', '#a0a0ff', '#f0a0f0'] // More colors for more categories
        }]
      },
      options: {
        responsive: true,
        plugins: {
          legend: { position: 'top', labels: { color: '#eee' } },
          title: { display: true, text: 'Current Session Category Distribution', color: '#eee' }
        }
      }
    });

    document.getElementById('sessionDetails').innerHTML = `
      <p><strong>Total Tabs:</strong> ${response.totalTabs}</p>
      <p><strong>Productivity Score:</strong> ${response.score}/100</p>
      <p><strong>Time Spent by Category (Minutes):</strong></p>
      <ul>
        ${Object.entries(response.timePerCategory).map(([cat, time]) => `<li>${escapeHTML(cat)}: ${(time / 60000).toFixed(1)} min</li>`).join('')}
      </ul>
      <p><strong>Top Time Sinks:</strong> ${response.timeSinks.map(url => `<a href="${escapeHTML(url)}" target="_blank">${escapeHTML(new URL(url).hostname)}</a>`).join(', ') || 'None'}</p>
    `;
    updateHeaderSummary();
  } else {
      document.getElementById('sessionDetails').innerHTML = '<p>Analysis failed or no data. Open some tabs!</p>';
  }
}

async function createNewWorkspace() {
  const wsName = prompt("Enter a name for the new workspace:");
  if (!wsName || wsName.trim() === '') {
    alert("Workspace name cannot be empty.");
    return;
  }

  // Simple validation for workspace names
  if (wsName.includes(" ") || wsName.includes("/") || wsName.includes("\\") || wsName.includes(".")) {
      alert("Invalid workspace name. Avoid spaces, slashes, and periods.");
      return;
  }

  const response = await chrome.runtime.sendMessage({ type: 'createNewWorkspace', name: wsName.trim() });
  if (response.success) {
    alert(`Workspace '${wsName}' created!`);
    renderWorkspaces(); // Refresh UI
  } else {
    alert(`Error: ${response.message}`);
  }
}

async function oneClickCleanup() {
  const confirmClean = confirm("Are you sure you want to close all tabs categorized as Social, Entertainment, or Shopping?");
  if (confirmClean) {
    const response = await chrome.runtime.sendMessage({ type: 'cleanupDistractions' });
    if (response.success) {
      alert(`Closed ${response.closedCount} distracting tabs!`);
      renderOpenTabs(); // Update UI after tabs are closed
    } else {
      alert(`No distracting tabs found to close.`);
    }
  }
}

function viewFullHistory() {
  chrome.tabs.create({ url: chrome.runtime.getURL('history.html') });
}

function openSettingsPage() {
  chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
}

// --- Category & Workspace Assignment Dropdowns (In-Popup) ---

let currentDropdown = null; // Track currently open dropdown

async function showCategoryEditDropdown(tabId, targetElement) {
  if (currentDropdown) currentDropdown.remove(); // Close existing dropdown

  const result = await chrome.storage.local.get('user_categories');
  const userCategories = result.user_categories || [];

  const dropdown = document.createElement('select');
  dropdown.className = 'category-edit-dropdown';
  dropdown.innerHTML = '<option value="">Select New Category</option>';
  userCategories.forEach(cat => {
    dropdown.innerHTML += `<option value="${escapeHTML(cat)}">${escapeHTML(cat)}</option>`;
  });
  dropdown.innerHTML += `<option value="custom">Add Custom...</option>`;

  // Position the dropdown near the target element
  dropdown.style.position = 'absolute';
  const rect = targetElement.getBoundingClientRect();
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.top = `${rect.top + rect.height + 5}px`; // 5px below the element
  document.body.appendChild(dropdown);
  currentDropdown = dropdown; // Set as current dropdown

  dropdown.addEventListener('change', async () => {
    const selectedValue = dropdown.value;
    if (selectedValue === 'custom') {
      const customCat = prompt("Enter a new custom category name:");
      if (customCat && customCat.trim() !== '') {
        const response = await chrome.runtime.sendMessage({ type: 'addCustomCategory', category: customCat.trim() });
        if (response.success) {
            // Re-open dropdown with new category selected
            showCategoryEditDropdown(tabId, targetElement);
            dropdown.value = customCat.trim(); // Attempt to pre-select
        } else {
            alert(`Failed to add custom category: ${response.message}`);
        }
      }
    } else if (selectedValue) {
      const response = await chrome.runtime.sendMessage({ type: 'updateTabCategory', tabId: parseInt(tabId), newCategory: selectedValue });
      if (response.success) {
        alert(`Category updated to ${selectedValue}.`);
        renderUI(); // Re-render all to show change
      } else {
        alert(`Failed to update category: ${response.message}`);
      }
      dropdown.remove();
      currentDropdown = null;
    }
  });

  // Close dropdown if clicked outside
  const closeDropdown = (e) => {
    if (currentDropdown && !currentDropdown.contains(e.target) && e.target !== targetElement) {
      currentDropdown.remove();
      currentDropdown = null;
      document.removeEventListener('click', closeDropdown);
    }
  };
  document.addEventListener('click', closeDropdown);
}

async function showAssignWorkspaceDropdown(tabId, targetElement) {
  if (currentDropdown) currentDropdown.remove(); // Close existing dropdown

  const dropdown = document.createElement('select');
  dropdown.className = 'workspace-assign-dropdown';
  dropdown.innerHTML = '<option value="">Assign to Workspace</option>';

  const result = await chrome.storage.local.get('workspaces');
  const workspaces = result.workspaces || {};
  for (const wsId in workspaces) {
    dropdown.innerHTML += `<option value="${escapeHTML(wsId)}">${escapeHTML(workspaces[wsId].name)}</option>`;
  }
  dropdown.innerHTML += '<option value="unassign">Unassign</option>';

  // Position the dropdown near the target element
  dropdown.style.position = 'absolute';
  const rect = targetElement.getBoundingClientRect();
  dropdown.style.left = `${rect.left}px`;
  dropdown.style.top = `${rect.top + rect.height + 5}px`;
  document.body.appendChild(dropdown);
  currentDropdown = dropdown;

  dropdown.addEventListener('change', async () => {
    const newWsId = dropdown.value;
    if (newWsId) {
        const response = await chrome.runtime.sendMessage({ type: 'assignTabToWorkspace', tabId: parseInt(tabId), workspaceId: newWsId === 'unassign' ? null : newWsId });
        if (response.success) {
            alert(`Tab assigned to workspace.`);
            renderUI(); // Re-render to show change
        } else {
            alert(`Failed to assign: ${response.message}`);
        }
    }
    dropdown.remove();
    currentDropdown = null;
  });

  const closeDropdown = (e) => {
    if (currentDropdown && !currentDropdown.contains(e.target) && e.target !== targetElement) {
      currentDropdown.remove();
      currentDropdown = null;
      document.removeEventListener('click', closeDropdown);
    }
  };
  document.addEventListener('click', closeDropdown);
}

// --- Workspace Action Functions (called from button listeners) ---

async function loadWorkspace(wsId) {
  const response = await chrome.runtime.sendMessage({ type: 'loadWorkspace', workspaceId: wsId });
  if (response.success) {
    alert(`Workspace '${response.name}' loaded.`);
    renderUI();
  } else {
    alert(`Error loading workspace: ${response.message}`);
  }
}

async function focusOnWorkspace(wsId) {
  const response = await chrome.runtime.sendMessage({ type: 'focusOnWorkspace', workspaceId: wsId });
  if (response.success) {
    alert(`Focused on workspace '${response.name}'. Closed ${response.closedCount} non-workspace tabs.`);
    renderUI();
  } else {
    alert(`Error focusing on workspace: ${response.message}`);
  }
}

async function suspendWorkspace(wsId) {
  const response = await chrome.runtime.sendMessage({ type: 'suspendWorkspace', workspaceId: wsId });
  if (response.success) {
    alert(`Suspended workspace '${response.name}'. Closed ${response.closedCount} tabs.`);
    renderUI();
  } else {
    alert(`Error suspending workspace: ${response.message}`);
  }
}

async function editWorkspace(wsId) {
    const result = await chrome.storage.local.get('workspaces');
    const workspace = result.workspaces?.[wsId];
    if (!workspace) {
        alert("Workspace not found.");
        return;
    }

    const newName = prompt(`Edit name for '${workspace.name}':`, workspace.name);
    if (newName && newName.trim() !== '' && newName.trim() !== workspace.name) {
        const response = await chrome.runtime.sendMessage({ type: 'renameWorkspace', workspaceId: wsId, newName: newName.trim() });
        if (response.success) {
            alert(`Workspace renamed to '${response.newName}'.`);
            renderUI();
        } else {
            alert(`Error renaming workspace: ${response.message}`);
        }
    }
    // You could also add prompt for goal edit here
}

async function deleteWorkspace(wsId) {
    const result = await chrome.storage.local.get('workspaces');
    const workspace = result.workspaces?.[wsId];
    if (!workspace) {
        alert("Workspace not found.");
        return;
    }
    const confirmDelete = confirm(`Are you sure you want to delete workspace '${workspace.name}'? This will NOT close open tabs but will remove the saved session.`);
    if (confirmDelete) {
        const response = await chrome.runtime.sendMessage({ type: 'deleteWorkspace', workspaceId: wsId });
        if (response.success) {
            alert(`Workspace '${workspace.name}' deleted.`);
            renderUI();
        } else {
            alert(`Error deleting workspace: ${response.message}`);
        }
    }
}


// --- Utility Function ---
function escapeHTML(str) {
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(str));
    return div.innerHTML;
}

// Listen for messages from background script to trigger UI updates
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.type === 'uiUpdate') {
        renderUI(); // Re-render entire UI for any major data change
        sendResponse({ success: true });
    }
    // You might have more specific UI update messages later if needed
});