// Manifest scripts do not run retroactively in already-open pages on install.
// Best effort: restricted tabs/frames must not prevent other tabs from working.
export async function installContextTracking(browser=chrome){
 const tabs=await browser.tabs.query({url:['http://*/*','https://*/*']});
 await Promise.allSettled(tabs.filter(tab=>Number.isInteger(tab.id)).map(tab=>
  browser.scripting.executeScript({target:{tabId:tab.id,allFrames:true},files:['context-target.js']})
 ));
}
