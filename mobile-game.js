/* StandoffX mobile orientation helper.
   Android browsers can lock landscape after a user gesture. iOS may require physical rotation. */
(()=>{
  const coarse=matchMedia("(pointer:coarse)").matches||navigator.maxTouchPoints>0;
  if(!coarse)return;
  const inMatch=Boolean(document.getElementById("game"));
  let armed=inMatch,dismissed=false,requesting=false;
  const portrait=()=>innerHeight>innerWidth;
  const prompt=(()=>{
    const node=document.createElement("div");
    node.id="sxOrientationPrompt";
    node.dataset.visible="false";
    node.innerHTML='<div class="sx-orient-card"><div class="sx-orient-icon" aria-hidden="true"><svg viewBox="0 0 100 100" width="94" height="94" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"><rect x="27" y="8" width="46" height="82" rx="7" transform="rotate(90 50 49)"/><path d="M42 27h16M42 70h16"/><path d="M12 19c8-8 18-12 29-12M12 19l2-10M12 19l10-1"/><path d="M88 81c-8 8-18 12-29 12M88 81l-2 10M88 81l-10 1"/></svg></div><h2>ПОВЕРНИ ТЕЛЕФОН</h2><p>StandoffX найкраще працює в альбомній орієнтації. Поверни пристрій боком, щоб розкрити весь HUD і сенсорне керування.</p><div class="sx-orient-actions"><button type="button" id="sxOrientationRetry">ПОВЕРНУТИ / ПОВНИЙ ЕКРАН</button><button type="button" class="sx-orient-skip" id="sxOrientationSkip">ПРОДОВЖИТИ ТАК</button></div></div>';
    document.body.appendChild(node);
    node.querySelector("#sxOrientationSkip").addEventListener("click",()=>{dismissed=true;node.dataset.visible="false"});
    node.querySelector("#sxOrientationRetry").addEventListener("click",()=>requestLandscape(true));
    return node;
  })();
  function update(){
    if(dismissed||!armed){prompt.dataset.visible="false";return}
    prompt.dataset.visible=portrait()?"true":"false";
  }
  async function requestLandscape(fromButton=false){
    if(requesting)return;
    requesting=true;
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
  function shouldRequest(target){
    if(!target?.closest)return false;
    return Boolean(target.closest("#playBtn,#confirmModeBtn,#overlay,#sxOrientationRetry,[data-start-match],#startMatchBtn"));
  }
  document.addEventListener("pointerdown",event=>{
    if(shouldRequest(event.target)){armed=true;requestLandscape()}
  },{capture:true,passive:true});
  document.addEventListener("click",event=>{
    if(shouldRequest(event.target)){armed=true;requestLandscape()}
  },{capture:true});
  if(inMatch)update();
  window.addEventListener("resize",update,{passive:true});
  window.addEventListener("orientationchange",()=>setTimeout(update,100),{passive:true});
  screen.orientation?.addEventListener?.("change",update);
  document.addEventListener("fullscreenchange",update);
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)update()});
})();
