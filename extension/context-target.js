// Isolated content script: remember only the user's last right-click position.
// No page data is sent and the native context menu remains unchanged.
document.addEventListener('contextmenu',event=>{
 globalThis.__assetnestContextTarget={x:event.clientX,y:event.clientY,at:Date.now(),pageURL:location.href};
},true);
