const SUPABASE_URL = 'https://wwtrgltfiektsqtezwyz.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_gItD0TNYjD5S3AMRqjdovQ_UMx8ZOX9';

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Store user callsign locally
let currentCallsign = localStorage.getItem('callsign') || 'Ghost_' + Math.floor(Math.random() * 1000);
localStorage.setItem('callsign', currentCallsign);

let currentRoomId = null;
let realtimeSubscription = null;
const dmSubscriptions = {}; // Holds channel subscriptions for open DMs

const roomStorageKey = 'waffle-suite-room-id';

function getMessageContainer() {
  return document.getElementById('messages-container') || document.getElementById('messagesList');
}

async function initializeRealtimeChat() {
  bindCallsignInput();

  let roomId = localStorage.getItem(roomStorageKey);

  if (!roomId) {
    roomId = await createRoom('general');
    if (roomId) localStorage.setItem(roomStorageKey, roomId);
  }

  if (roomId) {
    currentRoomId = roomId;
    await registerCallsign(roomId, currentCallsign);
    await switchRoom(roomId);
  }

  // Listen for newly created DM rooms that include this callsign
  subscribeToPersonalDMs();
}

function bindCallsignInput() {
  const input = document.getElementById('callsignInput');
  if (!input) return;

  input.value = currentCallsign;
  input.addEventListener('change', () => {
    const nextCallsign = input.value.trim().replace(/\s+/g, '_').slice(0, 24);
    currentCallsign = nextCallsign || `Ghost_${Math.floor(Math.random() * 1000)}`;
    input.value = currentCallsign;
    localStorage.setItem('callsign', currentCallsign);
    if (currentRoomId) registerCallsign(currentRoomId, currentCallsign);
  });
}

async function registerCallsign(roomId, callsign) {
  const { data: existingMember, error: lookupError } = await supabaseClient
    .from('room_members')
    .select('room_id')
    .eq('room_id', roomId)
    .eq('callsign', callsign)
    .limit(1)
    .maybeSingle();

  if (lookupError) {
    console.error('Error checking callsign registration:', lookupError);
    return false;
  }

  if (existingMember) return true;

  const { error: insertError } = await supabaseClient
    .from('room_members')
    .insert([{ room_id: roomId, callsign }]);

  if (insertError) {
    console.error('Error registering callsign:', insertError);
    return false;
  }

  return true;
}

async function handleRealtimeSend(event) {
  event.preventDefault();
  const input = document.getElementById('chatInput');
  if (!input) return;

  await sendMessage(input.value);
  input.value = '';
}

window.addEventListener('load', initializeRealtimeChat);

// 1. Create a Public Room
async function createRoom(roomName) {
  const { data: room, error } = await supabaseClient
    .from('rooms')
    .insert([{ name: roomName, is_dm: false }])
    .select()
    .single();

  if (error) return console.error('Error creating room:', error);
  return room.id;
}

// 2. Start a 1-on-1 DM with another Callsign
async function startDM(targetCallsign) {
  const knownCallsign = await findCallsign(targetCallsign);
  if (!knownCallsign) {
    console.error('Callsign is not registered in room_members:', targetCallsign);
    return null;
  }

  // Check if a DM room already exists between both users
  const { data: existingMembers, error: searchError } = await supabaseClient
    .from('room_members')
    .select('room_id')
    .eq('callsign', currentCallsign);

  if (!searchError && existingMembers) {
    const roomIds = existingMembers.map(m => m.room_id);
    if (roomIds.length > 0) {
      const { data: targetMembers } = await supabaseClient
        .from('room_members')
        .select('room_id')
        .in('room_id', roomIds)
        .eq('callsign', targetCallsign);

      if (targetMembers && targetMembers.length > 0) {
        return targetMembers[0].room_id; // Return existing DM room
      }
    }
  }

  // Create new DM container if none exists
  const { data: room, error } = await supabaseClient
    .from('rooms')
    .insert([{ is_dm: true }])
    .select()
    .single();

  if (error) return console.error('Error starting DM:', error);

  // Add both callsigns as members
  await supabaseClient.from('room_members').insert([
    { room_id: room.id, callsign: currentCallsign },
    { room_id: room.id, callsign: targetCallsign }
  ]);

  return room.id;
}

async function findCallsign(callsign) {
  const normalizedCallsign = callsign.trim();
  if (!normalizedCallsign) return null;

  const { data, error } = await supabaseClient
    .from('room_members')
    .select('callsign')
    .eq('callsign', normalizedCallsign)
    .limit(1);

  if (error) {
    console.error('Error looking up callsign:', error);
    return null;
  }

  return data?.[0]?.callsign || null;
}

// Send a Message
async function sendMessage(content) {
  return sendMessageToRoom(currentRoomId, content);
}

async function sendMessageToRoom(roomId, content) {
  if (!roomId || !content.trim()) return false;

  const { error } = await supabaseClient
    .from('messages')
    .insert([
      { room_id: roomId, sender_callsign: currentCallsign, content: content.trim() }
    ]);

  if (error) {
    console.error('Error sending message:', error);
    return false;
  }

  return true;
}

// Load Past Messages & Subscribe to Realtime Updates for Main Room
async function switchRoom(roomId) {
  currentRoomId = roomId;
  const container = getMessageContainer();
  if (!container) return;
  container.innerHTML = '';

  const { data: messages } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('room_id', roomId)
    .order('created_at', { ascending: true });

  if (messages) {
    messages.forEach(msg => appendMessageToUI(msg));
  }

  if (realtimeSubscription) {
    supabaseClient.removeChannel(realtimeSubscription);
  }

  realtimeSubscription = supabaseClient
    .channel(`room:${roomId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${roomId}` },
      (payload) => {
        appendMessageToUI(payload.new);
      }
    )
    .subscribe();
}

function appendMessageToUI(msg) {
  const container = getMessageContainer();
  if (!container) return;
  const msgEl = document.createElement('div');
  msgEl.className = 'flex items-start gap-3 group p-1.5 rounded-xl';
  msgEl.innerHTML = `
    <div class="w-8 h-8 rounded-full bg-red-100 text-red-600 flex items-center justify-center shrink-0 font-semibold text-xs">${escapeHtml(msg.sender_callsign.slice(0, 2).toUpperCase())}</div>
    <div class="min-w-0">
      <div class="flex items-center gap-2"><span class="font-semibold text-xs text-zinc-900">${escapeHtml(msg.sender_callsign)}</span><span class="text-[10px] text-zinc-400">${formatMessageTime(msg.created_at)}</span></div>
      <div class="text-xs text-zinc-700 leading-relaxed mt-0.5 break-words">${escapeHtml(msg.content)}</div>
    </div>`;
  container.appendChild(msgEl);
  container.parentElement.scrollTop = container.parentElement.scrollHeight;
}

// --- DM Realtime Integration ---

// Load history and subscribe to live updates for a specific DM
async function loadAndSubscribeDM(dmObject) {
  if (!dmObject || !dmObject.roomId) return;

  // 1. Fetch message history
  const { data: messages, error } = await supabaseClient
    .from('messages')
    .select('*')
    .eq('room_id', dmObject.roomId)
    .order('created_at', { ascending: true });

  if (!error && messages) {
    dmObject.messages = messages.map(m => ({
      sender: m.sender_callsign,
      text: m.content,
      time: formatMessageTime(m.created_at),
      isMe: m.sender_callsign === currentCallsign
    }));
    renderFloatingDMStack();
  }

  // 2. Unsubscribe previous listener if it exists
  if (dmSubscriptions[dmObject.roomId]) {
    supabaseClient.removeChannel(dmSubscriptions[dmObject.roomId]);
  }

  // 3. Subscribe to incoming DM messages
  dmSubscriptions[dmObject.roomId] = supabaseClient
    .channel(`dm:${dmObject.roomId}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `room_id=eq.${dmObject.roomId}` },
      (payload) => {
        const newMsg = payload.new;
        // Avoid duplicate message push for the sender (handled locally on submit)
        if (newMsg.sender_callsign !== currentCallsign) {
          dmObject.messages.push({
            sender: newMsg.sender_callsign,
            text: newMsg.content,
            time: formatMessageTime(newMsg.created_at),
            isMe: false
          });
          if (dmObject.minimized) {
            document.getElementById('unreadDMBadge')?.classList.remove('hidden');
          }
          renderFloatingDMStack();
        }
      }
    )
    .subscribe();
}

function subscribeToPersonalDMs() {
  supabaseClient
    .channel(`personal_dms:${currentCallsign}`)
    .on(
      'postgres_changes',
      { 
        event: 'INSERT', 
        schema: 'public', 
        table: 'room_members', 
        filter: `callsign=eq.${currentCallsign}` 
      },
      async (payload) => {
        const roomId = payload.new.room_id;
        
        // Verify this room is actually a DM
        const { data: roomData } = await supabaseClient
          .from('rooms')
          .select('is_dm')
          .eq('id', roomId)
          .single();

        if (!roomData || !roomData.is_dm) return;

        // Find the other user's callsign in this DM room
        const { data: otherMembers } = await supabaseClient
          .from('room_members')
          .select('callsign')
          .eq('room_id', roomId)
          .neq('callsign', currentCallsign);

        if (otherMembers && otherMembers.length > 0) {
          const senderCallsign = otherMembers[0].callsign;
          
          // 1. Add sender to contact list
          let friend = state.friends.find(f => f.callsign === senderCallsign);
          if (!friend) {
            friend = { id: `contact-${senderCallsign}`, callsign: senderCallsign, status: 'online' };
            state.friends.push(friend);
          }

          // 2. Add room to state and active DMs list
          let dm = state.openDMs.find(d => d.roomId === roomId);
          if (!dm) {
            dm = {
              id: 'dm_' + friend.id,
              friendId: friend.id,
              roomId: roomId,
              minimized: false,
              messages: []
            };
            state.openDMs.push(dm);
          }

          // 3. Re-render UI and listen for incoming messages on this channel
          renderFriendsSidebar();
          renderFriendsModalList();
          await loadAndSubscribeDM(dm);
          
          showToast(`New DM started with ${senderCallsign}`);
        }
      }
    )
    .subscribe();
}
function escapeHtml(value) {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

function formatMessageTime(timestamp) {
  if (!timestamp) return '';
  return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}
// Fetch all existing DM rooms for the current user and render them in the UI
async function loadUserDMs() {
  const { data: dmRooms, error } = await supabaseClient
    .from('user_dm_rooms')
    .select('*')
    .eq('user_callsign', currentCallsign);

  if (error) {
    console.error('Error fetching DM list:', error);
    return;
  }

  dmRooms.forEach(dm => {
    // Add peer to friends/contacts state if missing
    let friend = state.friends.find(f => f.callsign === dm.peer_callsign);
    if (!friend) {
      friend = { 
        id: `contact-${dm.peer_callsign}`, 
        callsign: dm.peer_callsign, 
        status: 'online' 
      };
      state.friends.push(friend);
    }

    // Ensure the DM entry exists in state
    let openDm = state.openDMs.find(d => d.roomId === dm.room_id);
    if (!openDm) {
      openDm = {
        id: 'dm_' + friend.id,
        friendId: friend.id,
        roomId: dm.room_id,
        minimized: true, // Keep minimized by default until clicked
        messages: []
      };
      state.openDMs.push(openDm);
      
      // Subscribe to real-time updates for this DM channel
      loadAndSubscribeDM(openDm);
    }
  });

  renderFriendsSidebar();
  renderFriendsModalList();
}

// Modify initializeRealtimeChat to fetch existing DMs on load
async function initializeRealtimeChat() {
  bindCallsignInput();

  let roomId = localStorage.getItem(roomStorageKey);

  if (!roomId) {
    roomId = await createRoom('general');
    if (roomId) localStorage.setItem(roomStorageKey, roomId);
  }

  if (roomId) await switchRoom(roomId);

  // Load existing DMs and listen for new ones incoming
  await loadUserDMs();
  subscribeToPersonalDMs();
}