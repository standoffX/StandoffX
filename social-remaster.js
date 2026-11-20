/* StandoffX social UI: friend context menu, full private chats, profiles and modal invitations. */
(function(){
"use strict";
const byId=id=>document.getElementById(id);
const esc=value=>String(value==null?"":value).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]});
const avatar=user=>esc(user&&user.playerAvatar||"/avatars/default.jpg");
const notify=message=>{if(typeof notifyToast==="function")notifyToast(message);else console.info("[SOCIAL]",message)};
const apiGet=async url=>{const r=await fetch(url,{credentials:"same-origin"});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||"Не вдалося завантажити дані.");return d};
const apiPost=async(url,body)=>{const r=await fetch(url,{method:"POST",credentials:"same-origin",headers:{"Content-Type":"application/json"},body:JSON.stringify(body||{})});const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.message||"Не вдалося виконати дію.");return d};
const guest=()=>Boolean(typeof me!=="undefined"&&me&&me.isGuest);
let socketRef=null,friendMap=new Map(),activeFriend=null,chatMessages=[],chatDialogs=[],unread=new Map(),pendingInvites=new Map(),activeLobby=null,clanInvite=null,chatOpen=false,editingId=null,noticeId=0,contextFriend=null;
const menu=byId("sxFriendMenu"),chatModal=byId("sxChatModal"),profileModal=byId("sxPlayerProfileModal"),lobbyModal=byId("sxLobbyModal"),clanModal=byId("sxClanInviteModal"),noticeStack=byId("sxNoticeStack");
const setOpen=(node)=>node&&node.classList.add("show");
const setClosed=(node)=>node&&node.classList.remove("show");

function addNotice(title,body,icon,actionText,action){
 const id="sxNotice"+(++noticeId),card=document.createElement("div");
 card.className="sx-notice";card.id=id;
 card.innerHTML='<div class="sx-notice-icon">'+esc(icon||"✉")+'</div><div class="sx-notice-copy"><b>'+esc(title)+'</b><small>'+esc(body)+'</small></div><button type="button" data-notice-action>'+esc(actionText||"ВІДКРИТИ")+'</button><button type="button" class="sx-notice-close" aria-label="Закрити">×</button>';
 card.querySelector("[data-notice-action]").addEventListener("click",function(){try{if(action)action()}finally{card.remove()}});
 card.querySelector(".sx-notice-close").addEventListener("click",function(){card.remove()});
 noticeStack.appendChild(card);
 window.setTimeout(function(){card.remove()},12000);
}
function refreshUnread(){
 const total=Array.from(unread.values()).reduce((a,b)=>a+b,0),badge=byId("sxChatUnread");
 if(badge)badge.hidden=total===0;
 const dock=byId("sxChatDock");
 if(dock)dock.title=total?"Нові повідомлення: "+total:"Повідомлення";
}
function rememberFriends(rows){
 (rows||[]).forEach(function(friend){if(friend&&friend.id)friendMap.set(String(friend.id),friend)});
}
function rowFriend(row){
 if(!row)return null;
 const id=String(row.dataset.friendId||"");
 if(!id)return null;
 const cached=friendMap.get(id)||{};
 const name=row.dataset.friendName||row.querySelector(".home-friend-copy b")?.textContent||row.querySelector("b")?.textContent||cached.nickname||"PLAYER";
 const image=row.querySelector("img")?.src||cached.playerAvatar||"/avatars/default.jpg";
 const status=row.classList.contains("is-online")||Boolean(cached.status);
 return Object.assign({},cached,{id:id,nickname:name,playerAvatar:image,status:status});
}
function hideFriendMenu(){if(menu)menu.classList.remove("open");contextFriend=null}
function showFriendMenu(friend,x,y){
 contextFriend=friend;
 byId("sxContextAvatar").src=friend.playerAvatar||"/avatars/default.jpg";
 byId("sxContextName").textContent=friend.nickname||"PLAYER";
 byId("sxContextStatus").textContent=friend.status?"В МЕРЕЖІ":"НЕ В МЕРЕЖІ";
 const invitePending=pendingInvites.has(String(friend.id));
 byId("sxContextLobbyLabel").textContent=invitePending?"Відмінити запрошення":"Запросити до лобі";
 menu.querySelector('[data-sx-action="lobby"]').disabled=!invitePending&&(!friend.status||guest());
 menu.querySelector('[data-sx-action="clan"]').disabled=guest()||!me?.clan;
 menu.style.left=Math.max(8,Math.min(x,window.innerWidth-236))+"px";
 menu.style.top=Math.max(8,Math.min(y,window.innerHeight-245))+"px";
 menu.classList.add("open");
}
function renderProfile(profile){
 const stats=profile.stats||{},clan=profile.clan;
 let clanHtml=clan
 ?'<div class="sx-profile-clan"><img src="'+esc(clan.avatar||"/avatars/default.jpg")+'" alt=""><div><b>'+esc(clan.name||clan.tag)+'</b><small>['+esc(clan.tag)+'] · '+(Number(clan.memberCount)||0)+' УЧАСНИКІВ</small></div></div>'
 :'<div class="sx-profile-clan"><div><b>БЕЗ КЛАНУ</b><small>Гравець поки не вступив до клану</small></div></div>';
 const canClan=Boolean(me&&me.clan&&!profile.isGuest&&String(me.id)!==String(profile.id));
 byId("sxPlayerProfileBody").innerHTML=
 '<div class="sx-profile-head"><img src="'+avatar(profile)+'" alt=""><div><b>'+esc(profile.nickname||"PLAYER")+(profile.isGuest?" · ГОСТЬ":"")+'</b><small>ID '+esc(profile.id)+(profile.isGuest?" · ТИМЧАСОВИЙ":"")+'</small><small>РІВЕНЬ '+Math.max(1,Math.floor((Number(profile.XP)||0)/1000)+1)+' · '+(Number(profile.XP)||0)+' XP</small></div></div>'+
 clanHtml+
 '<div class="sx-profile-stats">'+
 '<div class="sx-stat"><strong>'+esc(stats.kd||"0.00")+'</strong><small>K/D</small></div>'+
 '<div class="sx-stat"><strong>'+(Number(stats.kills)||0)+'</strong><small>ВБИВСТВА</small></div>'+
 '<div class="sx-stat"><strong>'+(Number(stats.deaths)||0)+'</strong><small>СМЕРТІ</small></div>'+
 '<div class="sx-stat"><strong>'+(Number(stats.wins)||0)+'</strong><small>ПЕРЕМОГИ</small></div>'+
 '<div class="sx-stat"><strong>'+(Number(stats.losses)||0)+'</strong><small>ПОРАЗКИ</small></div>'+
 '<div class="sx-stat"><strong>'+(Number(stats.matches)||0)+'</strong><small>МАТЧІ</small></div>'+
 '</div><div class="sx-modal-note" style="margin-top:10px">MMR: '+(Number(profile.MMRCompetitive)||1000)+' · СОЮЗНИКИ: '+(Number(profile.MMRAllies)||1000)+'</div>'+
 '<div class="sx-profile-actions"><button type="button" data-profile-message="'+esc(profile.id)+'">ПОВІДОМЛЕННЯ</button>'+
 (canClan?'<button type="button" class="primary" data-profile-clan="'+esc(profile.id)+'">ЗАПРОСИТИ ДО КЛАНУ</button>':"")+'</div>';
}
async function openProfile(id){
 setOpen(profileModal);
 byId("sxPlayerProfileBody").innerHTML='<div class="sx-modal-note">Завантаження профілю…</div>';
 try{const data=await apiGet("/api/profile/"+encodeURIComponent(id));renderProfile(data.profile)}
 catch(error){byId("sxPlayerProfileBody").innerHTML='<div class="sx-modal-note">'+esc(error.message)+'</div>'}
}
async function inviteClan(id){
 if(guest())return notify("Гостьовий профіль не може запрошувати до клану.");
 if(!me?.clan)return notify("Ти ще не перебуваєш у клані.");
 try{const result=await apiPost("/api/clans/invite",{userId:id});notify(result.message||"Запрошення надіслано.")}
 catch(error){notify(error.message)}
}
function renderDialogs(){
 const root=byId("sxChatDialogs");
 const q=String(byId("sxChatSearch").value||"").trim().toLowerCase();
 const filtered=chatDialogs.filter(function(friend){return String(friend.nickname||"").toLowerCase().includes(q)||String(friend.id||"").toLowerCase().includes(q)});
 root.innerHTML=filtered.map(function(friend){
  const id=String(friend.id),count=unread.get(id)||0;
  return '<button class="sx-chat-dialog'+(String(activeFriend?.id)===id?" active":"")+'" type="button" data-chat-open="'+esc(id)+'"><img src="'+avatar(friend)+'" alt=""><span><b>'+esc(friend.nickname||"PLAYER")+'</b><small>'+(friend.status?"В МЕРЕЖІ":"НЕ В МЕРЕЖІ")+'</small></span>'+(count?'<em>'+(count>9?"9+":count)+'</em>':"")+'</button>';
 }).join("")||'<div class="sx-chat-empty">Поки що немає друзів для переписки.</div>';
}
async function loadDialogs(){
 if(!me?.id||guest())return;
 const results=await Promise.all([
  apiGet("/api/get-my-friends").catch(()=>({friends:[]})),
  apiGet("/api/chat/active-dialogs/"+encodeURIComponent(me.id)).catch(()=>[])
 ]);
 const friends=Array.isArray(results[0].friends)?results[0].friends:[];
 const dialogs=Array.isArray(results[1])?results[1]:[];
 rememberFriends(friends.concat(dialogs));
 const map=new Map();
 friends.forEach(function(friend){if(friend?.id)map.set(String(friend.id),friend)});
 dialogs.forEach(function(friend){if(friend?.id&&!map.has(String(friend.id)))map.set(String(friend.id),friend)});
 chatDialogs=Array.from(map.values()).sort(function(a,b){return (unread.get(String(b.id))||0)-(unread.get(String(a.id))||0)});
 renderDialogs();
}
function renderThreadHeader(){
 const root=byId("sxChatThreadHead");
 if(!activeFriend){root.innerHTML='<div class="sx-chat-empty">Обери друга, щоб відкрити переписку</div>';return}
 root.innerHTML='<img src="'+avatar(activeFriend)+'" alt=""><div><b>'+esc(activeFriend.nickname||"PLAYER")+'</b><small>'+(activeFriend.status?"В МЕРЕЖІ":"НЕ В МЕРЕЖІ")+'</small></div><button class="close" type="button" style="margin-left:auto" data-chat-profile="'+esc(activeFriend.id)+'" title="Профіль">◉</button>';
}
const reactions=["👍","❤️","😂","😮","😢","🔥","👏"];
function renderMessages(){
 const root=byId("sxChatMessages");
 if(!activeFriend){root.innerHTML='<div class="sx-chat-empty">Тут будуть твої повідомлення.</div>';return}
 if(!chatMessages.length){root.innerHTML='<div class="sx-chat-empty">Переписка порожня. Напиши першим.</div>';return}
 const nearBottom=root.scrollHeight-root.scrollTop-root.clientHeight<100;
 root.innerHTML=chatMessages.map(function(message){
  const mine=String(message.senderId)===String(me?.id),deleted=Boolean(message.deleted),editing=String(editingId||"")===String(message.id);
  const reactionRows=Array.isArray(message.reactions)?message.reactions:[];
  const reactionHtml=reactionRows.map(function(row){return '<button type="button" data-react="'+esc(row.emoji)+'" data-message="'+esc(message.id)+'">'+esc(row.emoji)+' '+(row.users||[]).length+'</button>'}).join("");
  const actions=deleted?"":(mine?'<button type="button" data-edit="'+esc(message.id)+'">ЗМІНИТИ</button><button type="button" data-delete="'+esc(message.id)+'">ВИДАЛИТИ</button>':"")+reactions.slice(0,3).map(function(emoji){return '<button type="button" data-react="'+emoji+'" data-message="'+esc(message.id)+'">'+emoji+'</button>'}).join("");
  let body;
  if(editing){
   body='<textarea data-edit-input="'+esc(message.id)+'">'+esc(message.text||"")+'</textarea><div class="sx-chat-edit-actions"><button type="button" data-edit-cancel="'+esc(message.id)+'">СКАСУВАТИ</button><button class="save" type="button" data-edit-save="'+esc(message.id)+'">ЗБЕРЕГТИ</button></div>';
  }else{
   body='<p>'+(deleted?"Повідомлення видалено":esc(message.text||""))+'</p>';
  }
  return '<article class="sx-chat-message'+(mine?" mine":"")+(deleted?" deleted":"")+'"><div>'+body+'</div><div class="sx-msg-meta">'+esc(nowTime(message.time))+(message.editedAt&&!deleted?" · ред.":"")+'</div>'+(reactionHtml?'<div class="sx-reactions">'+reactionHtml+'</div>':"")+(actions?'<div class="sx-msg-actions">'+actions+'</div>':"")+'</article>';
 }).join("");
 if(nearBottom)root.scrollTop=root.scrollHeight;
}
function leaveActiveChat(){
 if(activeFriend&&socketRef?.connected)socketRef.emit("leave_chat",{friendId:activeFriend.id});
 activeFriend=null;chatMessages=[];editingId=null;
}
function openChat(id){
 if(guest())return notify("Гостьовий профіль не має збережених приватних переписок.");
 const friendId=String(id||"");
 if(!friendId)return;
 if(activeFriend&&String(activeFriend.id)!==friendId)leaveActiveChat();
 activeFriend=friendMap.get(friendId)||chatDialogs.find(function(friend){return String(friend.id)===friendId})||{id:friendId,nickname:"ГРАВЕЦЬ",playerAvatar:"/avatars/default.jpg"};
 chatMessages=[];editingId=null;chatOpen=true;
 setOpen(chatModal);
 unread.delete(friendId);refreshUnread();renderDialogs();renderThreadHeader();renderMessages();
 byId("sxMessageInput").disabled=false;byId("sxSendMessage").disabled=false;
 ensureSocket();
 const join=function(){if(socketRef?.connected)socketRef.emit("join_chat",{friendId:friendId})};
 if(socketRef?.connected)join();else socketRef?.once("connect",join);
}
async function openMessages(){
 if(guest())return notify("Гостьовий профіль не має збережених переписок.");
 setOpen(chatModal);chatOpen=true;
 await loadDialogs();
 renderThreadHeader();renderMessages();
 if(activeFriend)openChat(activeFriend.id);
}
function sendMessage(){
 if(!activeFriend||!socketRef?.connected)return notify("Немає з'єднання з чатом.");
 const input=byId("sxMessageInput"),text=String(input.value||"").trim();
 if(!text)return;
 socketRef.emit("send_msg",{toId:activeFriend.id,text:text});
 input.value="";input.focus();
}
function showClanInvite(invite){
 clanInvite=invite;
 byId("sxClanInviteBody").innerHTML='<div class="sx-clan-invite-details"><img src="'+esc(invite.avatar||"/avatars/default.jpg")+'" alt=""><div><b>'+esc(invite.clanName||invite.tag||"КЛАН")+'</b><small>Запросив '+esc(invite.fromNickname||"ГРАВЕЦЬ")+' · ['+esc(invite.tag||"")+']</small></div></div><div class="sx-modal-note">Після прийняття ти станеш учасником цього клану.</div>';
 setOpen(clanModal);
}
async function respondClanInvite(accept){
 if(!clanInvite)return;
 try{const result=await apiPost("/api/clans/invites/respond",{inviteId:clanInvite.id||clanInvite.inviteId,accept:accept});setClosed(clanModal);clanInvite=null;notify(result.message||"Готово.");if(accept&&typeof loadClan==="function")loadClan()}
 catch(error){notify(error.message)}
}
async function loadClanInvites(){
 if(guest())return;
 try{
  const data=await apiGet("/api/clans/invites");
  (data.invites||[]).forEach(function(invite){
   addNotice("Запрошення до клану",(invite.fromNickname||"Гравець")+" запросив до ["+invite.tag+"].","⬡","ПЕРЕГЛЯНУТИ",function(){showClanInvite(invite)});
  });
 }catch{}
}
function renderLobby(lobby){
 activeLobby=lobby||null;
 const dock=byId("sxLobbyDock");
 dock.hidden=!lobby;
 if(!lobby){setClosed(lobbyModal);return}
 byId("sxLobbyStatus").textContent=String((lobby.members||[]).length);
 const members=Array.isArray(lobby.members)?lobby.members:[];
 const owner=String(lobby.ownerId)===String(me?.id);
 byId("sxLobbyBody").innerHTML='<div class="sx-modal-note">'+esc(lobby.modeName||lobby.mode||"МАТЧ")+' · '+esc(lobby.mapName||lobby.map||"ZONE 9")+' · '+members.length+'/'+lobby.maxPlayers+'</div><div class="sx-lobby-members">'+members.map(function(member){
  return '<div class="sx-lobby-member"><img src="'+avatar(member)+'" alt=""><span><b>'+esc(member.nickname||"PLAYER")+'</b><small>'+(String(member.userId)===String(lobby.ownerId)?"ЛІДЕР":"УЧАСНИК")+'</small></span><em>'+(member.connected===false?"OFFLINE":"ONLINE")+'</em></div>';
 }).join("")+'</div><div class="sx-lobby-actions">'+(owner?'<button class="primary" type="button" id="sxLobbyStart">ПОЧАТИ МАТЧ</button>':"")+'<button type="button" id="sxLobbyLeave">ВИЙТИ З ЛОБІ</button></div>';
 byId("sxLobbyStart")?.addEventListener("click",function(){if(!socketRef?.connected)return notify("Немає з'єднання з лобі.");socketRef.emit("lobby_start_match",{fillWithBots:true});setClosed(lobbyModal)});
 byId("sxLobbyLeave")?.addEventListener("click",function(){socketRef?.emit("lobby_leave");setClosed(lobbyModal)});
}
function setOutgoingInvite(data){
 const id=String(data?.userId||"");
 if(!id)return;
 if(data.success)pendingInvites.set(id,{lobbyId:data.lobbyId||activeLobby?.id});
 else pendingInvites.delete(id);
 if(contextFriend&&String(contextFriend.id)===id)showFriendMenu(contextFriend,parseInt(menu.style.left)||8,parseInt(menu.style.top)||90);
}
function bindSocket(){
 if(typeof socialSocket==="undefined"||!socialSocket||socialSocket===socketRef)return;
 socketRef=socialSocket;
 socketRef.on("connect",function(){if(activeLobby)socketRef.emit("lobby_state_request");loadClanInvites()});
 socketRef.on("lobby_state",renderLobby);
 socketRef.on("lobby_left",function(){renderLobby(null)});
 socketRef.on("lobby_closed",function(){renderLobby(null)});
 socketRef.on("lobby_invite_result",function(data){setOutgoingInvite(data);if(data?.message)notify(data.message)});
 socketRef.on("lobby_invite_cancel_result",function(data){if(data?.userId)pendingInvites.delete(String(data.userId));if(data?.message)notify(data.message)});
 socketRef.on("lobby_invite_received",function(data){
  if(!data?.lobbyId)return;
  addNotice("Запрошення до лобі",(data.inviterNickname||"Друг")+" запросив тебе до "+(data.modeName||"матчу")+".","♟","ВІДКРИТИ",function(){
   if(byId("lobbyInviteText"))byId("lobbyInviteText").textContent=(data.inviterNickname||"Друг")+" запросив тебе до "+(data.modeName||"матчу")+" · "+(data.mapName||data.map)+".";
   setOpen(byId("lobbyInviteModal"));
  });
 });
 socketRef.on("lobby_invite_cancelled",function(data){
  if(typeof pendingLobbyInvite!=="undefined"&&pendingLobbyInvite?.lobbyId===data?.lobbyId)pendingLobbyInvite=null;
  addNotice("Запрошення скасовано","Друг відкликав запрошення до лобі.","×","ЗРОЗУМІЛО",function(){});
 });
 socketRef.on("clan_invite_received",function(data){
  const invite={id:data.inviteId,inviteId:data.inviteId,tag:data.tag,clanName:data.clanName,fromId:data.fromId,fromNickname:data.fromNickname};
  addNotice("Запрошення до клану",(data.fromNickname||"Гравець")+" запросив до ["+data.tag+"].","⬡","ПЕРЕГЛЯНУТИ",function(){showClanInvite(invite)});
 });
 socketRef.on("private_message_notification",function(data){
  if(!data?.fromId)return;
  const fromId=String(data.fromId);
  if(!chatOpen||String(activeFriend?.id)!==fromId)unread.set(fromId,(unread.get(fromId)||0)+1);
  refreshUnread();renderDialogs();
  addNotice("Нове повідомлення",(data.fromNickname||"Друг")+": "+String(data.text||"").slice(0,100),"✉","ВІДПОВІСТИ",function(){openChat(fromId)});
 });
 socketRef.on("chat_history",function(history){chatMessages=Array.isArray(history)?history:[];renderMessages()});
 socketRef.on("new_msg",function(message){
  if(!message)return;
  if(chatOpen&&activeFriend){if(!chatMessages.some(function(item){return String(item.id)===String(message.id)}))chatMessages.push(message);renderMessages()}
  else if(String(message.senderId)!==String(me?.id)){const id=String(message.senderId);unread.set(id,(unread.get(id)||0)+1);refreshUnread();renderDialogs()}
 });
 socketRef.on("msg_updated",function(message){const index=chatMessages.findIndex(function(item){return String(item.id)===String(message.id)});if(index>=0){chatMessages[index]=message;renderMessages()}});
 socketRef.on("msg_deleted",function(data){const message=chatMessages.find(function(item){return String(item.id)===String(data?.id)});if(message){message.deleted=true;message.text="";message.reactions=[];renderMessages()}});
 socketRef.on("msg_reaction",function(data){const message=chatMessages.find(function(item){return String(item.id)===String(data?.id)});if(message){message.reactions=data.reactions||[];renderMessages()}});
 socketRef.on("chat_error",function(data){notify(data?.message||"Помилка переписки.")});
}
function ensureSocket(){
 try{if(typeof initSocialSocket==="function")initSocialSocket()}catch(error){console.warn("[SOCIAL]",error)}
 bindSocket();
}
function inviteLobby(id){
 const userId=String(id);
 if(pendingInvites.has(userId)){
  if(!socketRef?.connected)return notify("Немає з'єднання з лобі.");
  socketRef.emit("lobby_invite_cancel",{userId:userId});
  return;
 }
 if(!activeLobby){
  if(typeof selectedMode!=="undefined"&&selectedMode==="training")return notify("Тренування — соло режим.");
  pendingInvites.set(userId,{creating:true});
  if(typeof inviteToLobby==="function")inviteToLobby(userId);else notify("Не вдалося створити лобі.");
  return;
 }
 ensureSocket();
 if(socketRef?.connected){pendingInvites.set(userId,{sending:true});socketRef.emit("lobby_invite",{userId:userId})}
 else notify("Підключення до лобі…");
}
function friendAction(action){
 const friend=contextFriend;hideFriendMenu();if(!friend)return;
 if(action==="profile")openProfile(friend.id);
 if(action==="message")openChat(friend.id);
 if(action==="clan")inviteClan(friend.id);
 if(action==="lobby")inviteLobby(friend.id);
}
function openFriendRow(row,x,y){
 const friend=rowFriend(row);if(friend)showFriendMenu(friend,x,y);
}
document.addEventListener("contextmenu",function(event){
 const row=event.target.closest("[data-friend-id]");
 if(!row)return;
 event.preventDefault();openFriendRow(row,event.clientX,event.clientY);
});
document.addEventListener("click",function(event){
 const menuTrigger=event.target.closest("[data-friend-menu]");
 if(menuTrigger){const row=menuTrigger.closest("[data-friend-id]");const rect=menuTrigger.getBoundingClientRect();openFriendRow(row,rect.left,rect.bottom+4);return}
 const action=event.target.closest("#sxFriendMenu [data-sx-action]");
 if(action){friendAction(action.dataset.sxAction);return}
 if(!event.target.closest("#sxFriendMenu"))hideFriendMenu();
 const close=event.target.closest("[data-sx-close]");
 if(close){
  const target=byId(close.dataset.sxClose);setClosed(target);
  if(target===chatModal){chatOpen=false;if(activeFriend&&socketRef?.connected)socketRef.emit("leave_chat",{friendId:activeFriend.id});activeFriend=null;chatMessages=[];editingId=null}
  return;
 }
 const profileMessage=event.target.closest("[data-profile-message]");
 if(profileMessage){setClosed(profileModal);openChat(profileMessage.dataset.profileMessage);return}
 const profileClan=event.target.closest("[data-profile-clan]");
 if(profileClan){inviteClan(profileClan.dataset.profileClan);return}
 const chatButton=event.target.closest("[data-chat-open]");
 if(chatButton){openChat(chatButton.dataset.chatOpen);return}
 const chatProfile=event.target.closest("[data-chat-profile]");
 if(chatProfile){openProfile(chatProfile.dataset.chatProfile);return}
 const edit=event.target.closest("[data-edit]");
 if(edit){editingId=edit.dataset.edit;renderMessages();byId("sxChatMessages").querySelector('[data-edit-input="'+CSS.escape(editingId)+'"]')?.focus();return}
 const editCancel=event.target.closest("[data-edit-cancel]");
 if(editCancel){editingId=null;renderMessages();return}
 const editSave=event.target.closest("[data-edit-save]");
 if(editSave){
  const id=editSave.dataset.editSave,input=byId("sxChatMessages").querySelector('[data-edit-input="'+CSS.escape(id)+'"]'),text=String(input?.value||"").trim();
  if(!text)return notify("Повідомлення не може бути порожнім.");
  socketRef?.emit("edit_msg",{toId:activeFriend?.id,messageId:id,text:text});editingId=null;return;
 }
 const deleteButton=event.target.closest("[data-delete]");
 if(deleteButton){const id=deleteButton.dataset.delete;if(window.confirm("Видалити це повідомлення для обох учасників?"))socketRef?.emit("delete_msg",{toId:activeFriend?.id,messageId:id});return}
 const react=event.target.closest("[data-react]");
 if(react){socketRef?.emit("react_msg",{toId:activeFriend?.id,messageId:react.dataset.message,emoji:react.dataset.react});return}
});
function openLobbyModal(){
 if(activeLobby){renderLobby(activeLobby);setOpen(lobbyModal);return}
 ensureSocket();socketRef?.emit("lobby_state_request");notify("Ти зараз не в лобі.");
}
byId("sxChatDock").addEventListener("click",function(){openMessages()});
byId("sxLobbyDock").addEventListener("click",openLobbyModal);
byId("sxChatSearch").addEventListener("input",renderDialogs);
byId("sxSendMessage").addEventListener("click",sendMessage);
byId("sxMessageInput").addEventListener("keydown",function(event){if(event.key==="Enter"&&!event.shiftKey){event.preventDefault();sendMessage()}});
byId("sxClanAccept").addEventListener("click",function(){respondClanInvite(true)});
byId("sxClanDecline").addEventListener("click",function(){respondClanInvite(false)});
window.addEventListener("keydown",function(event){if(event.key==="Escape"){hideFriendMenu();if(chatOpen){setClosed(chatModal);chatOpen=false;if(activeFriend&&socketRef?.connected)socketRef.emit("leave_chat",{friendId:activeFriend.id});activeFriend=null;chatMessages=[]}}});
window.sxOpenMessages=openMessages;
window.sxOpenLobby=openLobbyModal;
window.sxOpenChat=openChat;
window.sxOpenPlayerProfile=openProfile;
window.sxRefreshSocial=loadDialogs;
function start(){
 ensureSocket();
 if(!guest()){loadDialogs().catch(function(){});loadClanInvites()}
 if(typeof currentLobby!=="undefined"&&currentLobby)renderLobby(currentLobby);
}
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",start,{once:true});else start();
window.setInterval(bindSocket,700);
})();