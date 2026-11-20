/* StandoffX menu bridge: live friends, player sidebar and in-menu overlays. */
(function(){
  "use strict";
  const $=id=>document.getElementById(id);
  let lastRefresh=0,clanRequest=0;

  function bindPresence(){
    try{
      if(typeof socialSocket!=="undefined"&&socialSocket&&!socialSocket.__sxPresenceBound){
        socialSocket.on("friend_presence",function(){refreshFriends(true)});
        socialSocket.__sxPresenceBound=true;
      }
    }catch(_){}
  }
  function refreshFriends(force){
    const now=Date.now();
    if(!force&&now-lastRefresh<9000)return;
    if(document.hidden)return;
    if(typeof me==="undefined"||!me||typeof loadFriends!=="function")return;
    lastRefresh=now;
    try{Promise.resolve(loadFriends()).catch(function(error){console.warn("[MENU] Friend refresh failed",error)})}
    catch(error){console.warn("[MENU] Friend refresh failed",error)}
  }

  function updateStats(user){
    const stats=user?.stats||{},kills=Number(stats.kills)||0,deaths=Number(stats.deaths)||0;
    const values={
      sxStatKd:(kills/Math.max(1,deaths)).toFixed(2),
      sxStatKills:kills,
      sxStatDeaths:deaths,
      sxStatWins:Number(stats.wins)||0,
      sxStatLosses:Number(stats.losses)||0,
      sxStatMatches:Number(stats.matches)||0
    };
    Object.keys(values).forEach(id=>{const node=$(id);if(node)node.textContent=String(values[id])});
  }

  async function updateClan(){
    const label=$("clanName"),sub=$("sxClanSub"),summary=$("sxClanSummary");
    const user=window.__sxMenuUser;
    if(!label||!sub)return;
    const request=++clanRequest;
    if(!user?.clan){
      label.textContent="НЕМАЄ";
      sub.textContent="ТИ ЩЕ НЕ В КЛАНІ";
      summary?.classList.add("is-empty");
      return;
    }
    label.textContent="["+String(user.clan)+"]";
    sub.textContent="ЗАВАНТАЖЕННЯ КЛАНУ…";
    summary?.classList.remove("is-empty");
    try{
      const response=await fetch("/api/clans/my",{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:"{}"});
      const data=await response.json().catch(()=>({}));
      if(!response.ok)throw new Error(data.message||"Помилка запиту");
      if(request!==clanRequest)return;
      if(!data.clan){label.textContent="НЕМАЄ";sub.textContent="ТИ ЩЕ НЕ В КЛАНІ";summary?.classList.add("is-empty");return}
      label.textContent=data.clan.name||"["+data.clan.tag+"]";
      sub.textContent="["+data.clan.tag+"] · "+Number(data.members?.length||data.clan.memberCount||0)+" УЧАСНИКІВ";
    }catch(error){
      if(request===clanRequest)sub.textContent="КЛАН НЕДОСТУПНИЙ";
    }
  }

  function setRightTab(name){
    const tabs=[...document.querySelectorAll("[data-sx-side-tab]")];
    const views=[...document.querySelectorAll("[data-sx-side-view]")];
    if(!tabs.length)return;
    tabs.forEach(button=>{
      const active=button.dataset.sxSideTab===name;
      button.classList.toggle("active",active);
      button.setAttribute("aria-selected",String(active));
    });
    views.forEach(view=>{
      const active=view.dataset.sxSideView===name;
      view.hidden=!active;
      view.classList.toggle("active",active);
      if(view.id==="homeAgentPanel")view.setAttribute("aria-hidden",String(!active));
    });
    if(name==="stats")updateStats(window.__sxMenuUser);
    if(name==="clan")updateClan();
    if(name==="agent")window.dispatchEvent(new Event("sx:agent-panel-open"));
  }

  function openAdminPanel(){
    let overlay=$("sxAdminOverlay");
    if(!overlay){
      overlay=document.createElement("div");
      overlay.id="sxAdminOverlay";
      overlay.className="sx-admin-overlay";
      overlay.innerHTML='<section class="sx-admin-window" role="dialog" aria-modal="true" aria-label="Панель адміністратора"><header><b>ПАНЕЛЬ АДМІНІСТРАТОРА</b><button type="button" id="sxAdminClose" aria-label="Закрити">×</button></header><iframe title="Панель адміністратора" src="about:blank"></iframe></section>';
      document.body.appendChild(overlay);
      $("sxAdminClose").addEventListener("click",closeAdminPanel);
      overlay.addEventListener("click",event=>{if(event.target===overlay)closeAdminPanel()});
    }
    overlay.classList.add("open");
    const frame=overlay.querySelector("iframe");
    if(frame.getAttribute("src")==="about:blank")frame.src="/admin?embedded=1";
    $("sxAdminClose")?.focus();
  }
  function closeAdminPanel(){
    const overlay=$("sxAdminOverlay");
    if(!overlay)return;
    overlay.classList.remove("open");
    const frame=overlay.querySelector("iframe");
    if(frame)frame.src="about:blank";
  }

  function start(){
    document.querySelectorAll("[data-sx-side-tab]").forEach(button=>{
      button.addEventListener("click",()=>setRightTab(button.dataset.sxSideTab));
    });
    $("sxOpenClanPage")?.addEventListener("click",()=>window.sxShowMenuView?.("clan"));
    $("settingsBack")?.addEventListener("click",()=>window.sxShowMenuView?.("home"));
    $("guestQuickBtn")?.addEventListener("click",async event=>{
      const button=event.currentTarget;
      if(button.disabled)return;
      button.disabled=true;
      try{
        const response=await fetch("/api/guest",{method:"POST",credentials:"same-origin"});
        const data=await response.json().catch(()=>({}));
        if(!response.ok)throw new Error(data.message||"Не вдалося створити гостьовий профіль.");
        location.assign(data.redirect||"/game");
      }catch(error){button.disabled=false;window.notifyToast?.(error.message||"Помилка гостьового входу")}
    });
    window.sxOpenAdminPanel=openAdminPanel;
    window.addEventListener("keydown",event=>{if(event.key==="Escape")closeAdminPanel()});
    window.addEventListener("sx:user-updated",event=>{
      updateStats(event.detail||window.__sxMenuUser);
      updateClan();
    });
    updateStats(window.__sxMenuUser);
    setRightTab("clan");
    bindPresence();
  }

  window.setInterval(bindPresence,1000);
  window.setInterval(()=>refreshFriends(false),12000);
  window.addEventListener("focus",()=>refreshFriends(true));
  document.addEventListener("visibilitychange",()=>{if(!document.hidden)refreshFriends(true)});
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});
  else start();
})();