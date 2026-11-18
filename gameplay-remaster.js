/* Live health indicator, reading the authoritative HP value from the game module. */
(function(){
  "use strict";
  const root=document.getElementById("combatVitals");
  if(!root)return;
  const number=document.getElementById("currentHealth");
  const fill=document.getElementById("healthFill");
  let last=-1;
  function update(){
    if(typeof window.__sxGetHealth!=="function")return;
    const value=Math.max(0,Math.min(100,Number(window.__sxGetHealth())||0));
    if(value===last)return;
    last=value;
    if(number)number.textContent=String(Math.round(value));
    if(fill)fill.style.width=value+"%";
    root.classList.toggle("is-low",value>0&&value<=50);
    root.classList.toggle("is-critical",value>0&&value<=25);
    root.classList.toggle("is-dead",value<=0);
  }
  update();
  window.setInterval(update,100);
  document.addEventListener("visibilitychange",update);
})();
