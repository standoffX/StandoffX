/* StandoffX mobile orientation helper.
   Fullscreen and orientation locking require a user gesture on Android browsers.
   The user can always leave fullscreen with the system gesture/button. */
(()=>{
  const coarse=matchMedia("(pointer:coarse)").matches||navigator.maxTouchPoints>0;
  if(!coarse)return;
  const prompt=(()=>{
    const node=document.createElement("div");
    node.id="sxOrientationPrompt";
    node.dataset.visible="false";
    node.innerHTML='<div class="sx-orient-card"><div class="sx-orient-icon" aria-hidden="true"><svg viewBox="0 0 100 100" width="76" height="76" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><rect x="27" y="8" width="46" height="82" rx="7" transform="rotate(90 50 49)"/><path d="M42 27h16M42 70h16"/><path d="M12 19c8-8 18-12 29-12M12 19l2-10M12 19l10-1"/></svg></div><h2>АЛЬБОМНА ОРІЄНТАЦІЯ</h2><p>Поверни телефон боком. Якщо повний екран не ввімкнувся автоматично, натисни кнопку нижче.</p><div class="sx-orient-actions"><button type="button" id="sxOrientationRetry">ПОВНИЙ ЕКРАН</button><button type="button" class="sx-orient-skip" id="sxOrientationSkip">ПРОДОВЖИТИ</button></div></div>';
    document.body.appendChild(node);
    node.querySelector("#sxOrientationSkip").addEventListener("click",()=>{node.dataset.visible="false";node.dataset.dismissed="true"});
    node.querySelector("#sxOrientationRetry").addEventListener("click",()=>requestLandscape());
    return node;
  })();
  let requesting=false,attempted=false;
  const portrait=()=>innerHeight>innerWidth;
  function update(){
    if(prompt.dataset.dismissed==="true"){prompt.dataset.visible="false";return}
    prompt.dataset.visible=portrait()?"true":"false";
  }
  async function requestLandscape(){
    if(requesting)return;
    requesting=true;attempted=true;
    try{
      const root=document.documentElement;
      if(!document.fullscreenElement){
        const full=root.requestFullscreen||root.webkitRequestFullscreen;
        if(full){try{await full.call(root,{navigationUI:"hide"})}catch{}}
      }
      const orientation=screen.orientation;
      if(orientation&&typeof orientation.lock==="function"){
        try{await orientation.lock("landscape")}catch{}
      }
    }finally{
      requesting=false;
      update();
    }
  }
  // The very first touch anywhere in the menu/game is the valid browser gesture.
  document.addEventListener("pointerdown",event=>{
    if(event.pointerType==="touch"||event.pointerType==="pen"||event.pointerType===""){
      if(!attempted)requestLandscape();
    }
  },{capture:true,passive:true,once:true});
  document.addEventListener("click",()=>{
    if(!attempted)requestLandscape();
  },{capture:true,once:true});
  update();
  window.addEventListener("resize",update,{passive:true});
  window.addEventListener("orientationchange",()=>setTimeout(update,120),{passive:true});
  screen.orientation?.addEventListener?.("change",update);
  document.addEventListener("fullscreenchange",update);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)update()});
})();