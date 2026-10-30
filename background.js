// Clicking the toolbar icon opens the side panel, where all the work happens.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((error) => console.error('Failed to set side panel behavior', error));
