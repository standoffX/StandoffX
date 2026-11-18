/* Small live-presence bridge for the existing menu application. */
(function(){
  "use strict";
  let lastRefresh=0;
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
  bindPresence();
  window.setInterval(bindPresence,1000);
  window.setInterval(function(){refreshFriends(false)},12000);
  window.addEventListener("focus",function(){refreshFriends(true)});
  document.addEventListener("visibilitychange",function(){if(!document.hidden)refreshFriends(true)});
})();
