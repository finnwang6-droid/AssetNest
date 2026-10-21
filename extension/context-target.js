// Isolated content script: remember only the user's last right-click position.
// No page data is sent and the native context menu remains unchanged.
if(!globalThis.__assetnestContextTracking){
 globalThis.__assetnestContextTracking=true;
 const remember=event=>{
  if(event.type!=='contextmenu'&&event.button!==2)return;
  globalThis.__assetnestContextTarget={x:event.clientX,y:event.clientY,at:Date.now(),pageURL:location.href};
 };
 // Record before page-level handlers can stop contextmenu propagation.
 window.addEventListener('pointerdown',remember,true);
 window.addEventListener('mousedown',remember,true);
 window.addEventListener('contextmenu',remember,true);
}
