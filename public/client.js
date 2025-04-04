const socket = io();

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Local game state
let currentPlayers = [];

// Drawing state
let isEraser = false;
let undoStack = [];
let lastDrawingSent = null;

// Variables for rate limiting refreshes
let lastRoomsRefresh = 0;
const REFRESH_COOLDOWN = 3000; // 3 seconds minimum between refreshes
const REFRESH_INTERVAL = 15000; // 15 seconds auto-refresh interval

// Current AI player count (accessible to all functions)
let aiPlayerCount = 0;

ctx.lineCap = 'round';
ctx.lineJoin = 'round';

// List of fun placeholder names
const placeholderNames = [
    "ArtistAnon", "SketchWiz", "PixelPro", "DoodleDiva",
    "ScribbleGuru", "DrawMaster", "PenPal", "Picasso2.0",
    "InkInspired", "CanvasChamp", "BrushBaron", "SketchSage"
];

// Get a random name from the list
function getRandomName() {
    return placeholderNames[Math.floor(Math.random() * placeholderNames.length)];
}

// Set up app
window.addEventListener('load', () => {
    clearDrawCanvas();

    // Load saved username from localStorage
    const savedUsername = localStorage.getItem('imageinary_username');
    const usernameInput = document.getElementById('username');

    if (savedUsername) {
        usernameInput.value = savedUsername;
    } else {
        // Set a random placeholder name
        usernameInput.placeholder = getRandomName();
    }

    // Initialize the prompt editor functionality
    promptEditor.initPromptEditor();
    aiPersonalityEditor.initAIPersonalityEditor();


    // Set up auto-refresh for the rooms list
    restartRoomRefreshInterval();

    // Handle tab visibility changes to prevent refresh buildup when tab is inactive
    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            // Pause the refresh interval when the tab is hidden
            clearRoomRefreshInterval();
        } else {
            // Reset last refresh time and restart interval when tab becomes visible again
            restartRoomRefreshInterval();
        }
    });

    // Set up manual refresh button for public rooms
    document.getElementById('refreshRooms').addEventListener('click', () => {
        // Reset the refresh timer when manually refreshed
        restartRoomRefreshInterval();
    });

    // Add keystroke handlers for the lobby form
    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            // If room code is filled, join room, otherwise create private room
            const roomCode = document.getElementById('roomCode').value.trim();
            if (roomCode) {
                joinRoom();
            } else {
                createRoom(false); // Create private room on Enter key
            }
        }
    });

    document.getElementById('roomCode').addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinRoom();
        }
    });

    // Check for room param in URL
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');

    if (roomParam) {
        // Update the room code input with the URL parameter
        document.getElementById('roomCode').value = roomParam;

        // If we have a username in local storage, join directly
        if (savedUsername) {
            joinRoom();
        } else {
            // Show username prompt modal
            const modal = document.createElement('div');
            modal.className = 'modal';
            modal.innerHTML = `
                <div class="modal-content">
                    <h2>Enter Your Username</h2>
                    <p>Please enter a username to join room</p>
                    <input type="text" id="modalUsername" placeholder="${getRandomName()}">
                    <button id="joinWithUsername">Join Game</button>
                </div>
            `;
            document.body.appendChild(modal);

            // Auto-focus the username input
            setTimeout(() => document.getElementById('modalUsername').focus(), 100);

            // Handle modal join button
            document.getElementById('joinWithUsername').addEventListener('click', () => {
                const modalUsername = document.getElementById('modalUsername').value.trim() ||
                    document.getElementById('modalUsername').placeholder;

                // Save username to localStorage
                localStorage.setItem('imageinary_username', modalUsername);

                // Update the main username field
                document.getElementById('username').value = modalUsername;

                // Remove the modal and join
                document.body.removeChild(modal);
                joinRoom();
            });

            // Handle enter key in modal
            document.getElementById('modalUsername').addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    document.getElementById('joinWithUsername').click();
                }
            });
        }
    } else {
        // Auto-focus the username field if empty, otherwise the room code field
        if (!usernameInput.value) {
            usernameInput.focus();
        } else {
            document.getElementById('roomCode').focus();
        }
    }
});

// Function to clear canvas with white background
function clearDrawCanvas() {
    ctx.fillStyle = 'white';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.beginPath();
}

function copyToClipboard(text) {
    navigator.clipboard.writeText(text)
        .then(() => {
            // If copying the room link (not the room code itself)
            if (text.includes('?room=')) {
                const inviteBtn = document.getElementById('inviteBtn');
                const originalIcon = inviteBtn.innerHTML;
                inviteBtn.innerHTML = `<span class="icon">✓</span>`;
                inviteBtn.style.backgroundColor = '#4CAF50';
                setTimeout(() => {
                    inviteBtn.innerHTML = originalIcon;
                    inviteBtn.style.backgroundColor = '';
                }, 1500);
            } else {
                // Flash effect to indicate success for room code copy
                const roomElement = document.getElementById('currentRoom');
                roomElement.style.backgroundColor = '#4CAF50';
                roomElement.style.color = 'white';
                setTimeout(() => {
                    roomElement.style.backgroundColor = '';
                    roomElement.style.color = '';
                }, 500);
            }
        })
        .catch(err => console.error('Failed to copy: ', err));
}

function createRoom(isPublic = false) {
    let username = document.getElementById('username').value.trim();
    let isAutoName = false;

    // If no username is provided, use the placeholder
    if (!username) {
        username = document.getElementById('username').placeholder;
        isAutoName = true;
    }

    if (username) {
        // Only save user-entered names, not auto-generated ones
        if (!isAutoName) {
            localStorage.setItem('imageinary_username', username);
        }

        // Include custom prompt when creating room (get from promptEditor)
        socket.emit('createRoom', username, promptEditor.getCustomPrompt(), isPublic);
    }
}

function joinRoom() {
    let username = document.getElementById('username').value.trim();
    let isAutoName = false;

    // If no username is provided, use the placeholder but not "Enter your name"
    if (!username) {
        // Make sure we don't use the placeholder text "Enter your name" as a username
        if (document.getElementById('username').placeholder === "Enter your name") {
            username = getRandomName();
        } else {
            username = document.getElementById('username').placeholder;
        }
        isAutoName = true;
    }

    const roomCode = document.getElementById('roomCode').value.trim().toUpperCase() || new URLSearchParams(window.location.search).get('room');

    if (username && roomCode) {
        // Only save user-entered names, not auto-generated ones
        if (!isAutoName) {
            localStorage.setItem('imageinary_username', username);
        }
        // Include custom prompt when joining room
        socket.emit('joinRoom', { roomCode, username });
    }
}

function toggleEraser() {
    isEraser = !isEraser;
    const eraserBtn = document.getElementById('eraserBtn');
    const colorPicker = document.getElementById('colorPicker');

    if (isEraser) {
        eraserBtn.classList.add('eraser-active');
        colorPicker.disabled = true;
    } else {
        eraserBtn.classList.remove('eraser-active');
        colorPicker.disabled = false;
    }
}

function sendDrawingUpdate() {
    const drawingData = canvas.toDataURL();

    // Only send if different from last sent data
    if (drawingData !== lastDrawingSent) {
        lastDrawingSent = drawingData;
        const roomCode = document.getElementById('currentRoom').textContent;
        socket.emit('drawing', { roomCode, drawingData });
    }
}

function undo() {
    if (socket.id === document.getElementById('drawer')?.dataset?.id && undoStack.length > 0) {
        const lastState = undoStack.pop();
        const img = new Image();
        img.onload = () => {
            clearDrawCanvas();
            // Scale and center the image to fit the canvas while maintaining aspect ratio
            const scale = Math.min(
                canvas.width / img.width,
                canvas.height / img.height
            );
            const x = (canvas.width - img.width * scale) / 2;
            const y = (canvas.height - img.height * scale) / 2;
            ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
            sendDrawingUpdate();
        };
        img.src = lastState;
    }
}

function clearCanvas() {
    if (socket.id === document.getElementById('drawer')?.dataset?.id) {
        undoStack.push(canvas.toDataURL());
        clearDrawCanvas();
        sendDrawingUpdate();
    }
}

let roomsRefreshInterval = null;
function restartRoomRefreshInterval() {
    if (roomsRefreshInterval) {
        clearInterval(roomsRefreshInterval);
    }
    roomsRefreshInterval = setInterval(() => loadPublicRooms(), REFRESH_INTERVAL);
    // Immediate refresh
    loadPublicRooms();
}

function clearRoomRefreshInterval() {
    if (roomsRefreshInterval) {
        clearInterval(roomsRefreshInterval);
        roomsRefreshInterval = null;
    }
}

// Load and display public rooms with rate limiting
function loadPublicRooms() {
    const now = Date.now();

    // Check if we're trying to refresh too quickly
    if (now - lastRoomsRefresh < REFRESH_COOLDOWN) {
        console.log("Refresh rate limited, skipping");
        return;
    }

    lastRoomsRefresh = now;
    socket.emit('getPublicRooms');

    // Show loading indicator
    const publicRoomsList = document.getElementById('publicRoomsList');
    publicRoomsList.innerHTML = '<div class="loading-rooms">Loading rooms...</div>';
}

// Function to update the players list
function updatePlayersList() {
    const players = currentPlayers;
    const playersDiv = document.getElementById('players');
    playersDiv.innerHTML = ''; // Clear existing content

    // Check if the current user is host
    const isHost = players.length > 0 && players[0].id === socket.id;

    // Reset AI player count
    aiPlayerCount = 0;

    // Add each player with proper DOM methods to prevent XSS
    players.forEach(p => {
        const playerDiv = document.createElement('div');

        const nameSpan = document.createElement('span');
        nameSpan.style.color = p.color || '#000';
        nameSpan.textContent = p.username;

        playerDiv.appendChild(nameSpan);
        playerDiv.appendChild(document.createTextNode(': ' + p.score));

        // Add AI player class if this is an AI
        if (p.isAI) {
            playerDiv.className = 'ai-player';
            aiPlayerCount++;

            // Add remove button if user is host
            if (isHost) {
                const removeBtn = document.createElement('span');
                removeBtn.className = 'remove-ai-btn';
                removeBtn.innerHTML = '✖';
                removeBtn.title = 'Remove AI player';
                removeBtn.onclick = () => removeAIPlayer(p.id);
                playerDiv.appendChild(removeBtn);
            }
        }

        playersDiv.appendChild(playerDiv);
    });

    // Update AI add AI based on current count
    const addAIBtn = document.getElementById('addAIBtn');

    // Only show the Add AI button if we're below the max limit
    if (addAIBtn) {
        if (!isHost || aiPlayerCount >= PROMPT_CONFIG.MAX_AI_PLAYERS) {
            addAIBtn.style.display = 'none';
        } else {
            addAIBtn.style.display = 'inline-block';
        }
    }
}

// Join a public room
function joinPublicRoom(roomCode) {
    // Set the room code input
    document.getElementById('roomCode').value = roomCode;
    // Join the room
    joinRoom();
}

function startGame(roomCode, username, inviteLink) {
    // Clear the rooms refresh interval when game starts
    clearRoomRefreshInterval();

    // Reset currentPlayers
    currentPlayers = [];

    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('currentRoom').textContent = roomCode;

    // Add welcome message for the player (only visible to them)
    addSystemMessage(`Welcome to room ${roomCode}! You joined as ${username}`, 'system-message welcome-message');

    // Initialize timer
    document.getElementById('timer').textContent = getTimeString('--');

    // Generate shareable link if not provided
    if (!inviteLink) {
        inviteLink = `${window.location.origin}/?room=${roomCode}`;
    }

    // Ensure the game interface is visible and scrollable
    document.body.style.overflow = 'auto';
}

function isInGame() {
    return document.getElementById('game').style.display !== 'none';
}

// Function to add an AI player
function addAIPlayer() {
    if (aiPlayerCount >= PROMPT_CONFIG.MAX_AI_PLAYERS) return;

    const roomCode = document.getElementById('currentRoom').textContent;

    // Check if we have saved personalities
    const savedPersonalities = aiPersonalityEditor.getSavedPersonalities();

    if (savedPersonalities && savedPersonalities.length > 0) {
        // Use the AI personality selector from aiPersonalityEditor.js
        aiPersonalityEditor.createAIPersonalitySelector(savedPersonalities, roomCode, (personality) => {
            // Callback when an AI is selected
            if (personality) {
                // Send selected custom personality to server
                socket.emit('addAIPlayer', {
                    roomCode: roomCode,
                    personality: personality
                });
            } else {
                // Add default AI player
                socket.emit('addAIPlayer', roomCode);
            }
        });
    } else {
        // Just add a default AI player
        socket.emit('addAIPlayer', roomCode);
    }
}

// Function to remove an AI player by ID
function removeAIPlayer(aiPlayerId) {
    if (aiPlayerCount <= 0) return;

    const roomCode = document.getElementById('currentRoom').textContent;
    socket.emit('removeAIPlayer', { roomCode, aiPlayerId });
}

// Function to remove the last AI player added
function removeLastAIPlayer() {
    if (aiPlayerCount <= 0) return;

    const roomCode = document.getElementById('currentRoom').textContent;
    socket.emit('removeLastAIPlayer', roomCode);
}

// Function to display system messages in chat
function addSystemMessage(message, className = 'system-message') {
    const chatDiv = document.getElementById('chat');
    const messageDiv = document.createElement('div');
    messageDiv.className = className;
    messageDiv.textContent = message;
    chatDiv.appendChild(messageDiv);
    chatDiv.scrollTop = chatDiv.scrollHeight;

    limitChatMessages();
}

function addPlayerMessage({ username, message, timestamp, color, isGuess }) {
    const chatDiv = document.getElementById('chat');
    const messageDiv = document.createElement('div');

    // Add guess class if this is a guess message
    if (isGuess) {
        messageDiv.classList.add('guess-message');
    }

    const usernameSpan = document.createElement('span');
    usernameSpan.style.color = color;
    usernameSpan.textContent = `${username}: `;

    const messageText = document.createTextNode(message);

    // Add both elements to the message div
    messageDiv.appendChild(usernameSpan);
    messageDiv.appendChild(messageText);

    chatDiv.appendChild(messageDiv);
    chatDiv.scrollTop = chatDiv.scrollHeight; // Auto-scroll to bottom

    limitChatMessages();
}

function limitChatMessages(maxMessages = 100) {
    const chatDiv = document.getElementById('chat');
    if (!chatDiv) return; // Early return if element not found

    const messages = Array.from(chatDiv.children); // Convert to static array
    const excessCount = messages.length - maxMessages;

    if (excessCount > 0) {
        // Remove multiple nodes at once using a range
        const range = document.createRange();
        range.setStartBefore(messages[0]);
        range.setEndAfter(messages[excessCount - 1]);
        range.deleteContents();
    }
}

function clearChat() {
    document.getElementById('chat').innerHTML = '';
}

// Helper function to format time with the clock emoji
function getTimeString(seconds) {
    return `⏱️ ${seconds}`;
}

let currentTimerInterval = null;
function startDisplayTimer(seconds) {
    // Clear any existing timer
    if (currentTimerInterval) {
        clearInterval(currentTimerInterval);
    }

    let timeLeft = seconds;
    const timer = document.getElementById('timer');
    timer.textContent = getTimeString(timeLeft);

    currentTimerInterval = setInterval(() => {
        timeLeft--;
        timer.textContent = getTimeString(timeLeft);

        // Add visual indicator when time is running low
        if (timeLeft <= 10) {
            timer.style.color = '#e74c3c';
        } else {
            timer.style.color = '';
        }

        if (timeLeft <= 0) {
            clearInterval(currentTimerInterval);
            currentTimerInterval = null;
        }
    }, 1000);
}

function clearDisplayTimer() {
    if (currentTimerInterval) {
        clearInterval(currentTimerInterval);
        currentTimerInterval = null;
    }
    timer.textContent = getTimeString(0);
}

// Function to copy the room link
function copyRoomLink() {
    const roomCode = document.getElementById('currentRoom').textContent;
    const roomLink = `${window.location.origin}/?room=${roomCode}`;
    copyToClipboard(roomLink);
}

// Function to return to lobby
function returnToLobby() {
    clearDisplayTimer();
    clearChat();

    // Reset game state
    document.getElementById('game').style.display = 'none';
    document.getElementById('lobby').style.display = 'block';

    // Clear the game elements
    document.getElementById('players').innerHTML = '';
    document.getElementById('currentRoom').textContent = '';
    document.getElementById('drawer').textContent = '';
    document.getElementById('drawer').dataset.id = '';
    document.getElementById('round').textContent = '';
    document.getElementById('timer').textContent = '';

    // Reset drawing state
    clearDrawCanvas();

    // Restart the public rooms refresh interval
    restartRoomRefreshInterval();
}

// Function to handle setting drawing data when receiving drawing updates
function setDrawingData(drawingData) {
    if (!drawingData) {
        // Clear canvas if empty data is received
        clearDrawCanvas();
        lastDrawingSent = '';
        return;
    }

    // Check if we're the drawer - if so, only apply updates if they don't match our last sent state
    // This prevents flickering from our own updates
    if (socket.id === document.getElementById('drawer')?.dataset?.id) {
        if (drawingData === lastDrawingSent) {
            return;
        }
    }

    const img = new Image();
    img.onload = () => {
        clearDrawCanvas();
        // Scale and center the image to fit the canvas while maintaining aspect ratio
        const scale = Math.min(
            canvas.width / img.width,
            canvas.height / img.height
        );
        const x = (canvas.width - img.width * scale) / 2;
        const y = (canvas.height - img.height * scale) / 2;
        ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
    };
    img.src = drawingData;
}

function updateGameState({ players, currentDrawer, round, voting }) {
    document.getElementById('round').textContent = round;
    const drawerPlayer = players.find(p => p.id === currentDrawer);
    document.getElementById('drawer').textContent = drawerPlayer ? drawerPlayer.username : "Unknown";
    document.getElementById('drawer').dataset.id = currentDrawer;

    if (currentPlayers.length > 0) {
        // Detect player joins and leaves
        const newPlayers = players.map(p => p.id);
        const oldPlayers = currentPlayers.map(p => p.id);

        // Find players who just joined (in new but not in old)
        const joinedPlayers = players.filter(p => !oldPlayers.includes(p.id));

        // Find players who just left (in old but not in new)
        const leftPlayers = currentPlayers.filter(p => !newPlayers.includes(p.id));

        // Add join messages
        joinedPlayers.forEach(player => {
            // For colored usernames we need to use DOM manipulation
            const chatDiv = document.getElementById('chat');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'system-message join-message';

            const nameSpan = document.createElement('span');
            nameSpan.style.color = player.color || '#000';
            nameSpan.textContent = player.username;

            messageDiv.appendChild(document.createTextNode('👋 '));
            messageDiv.appendChild(nameSpan);
            messageDiv.appendChild(document.createTextNode(' has joined the game'));

            chatDiv.appendChild(messageDiv);
            chatDiv.scrollTop = chatDiv.scrollHeight;
        });

        // Add leave messages
        leftPlayers.forEach(player => {
            const wasDrawer = player.id === currentDrawer;

            // For colored usernames we need to use DOM manipulation
            const chatDiv = document.getElementById('chat');
            const messageDiv = document.createElement('div');
            messageDiv.className = 'system-message leave-message';

            const nameSpan = document.createElement('span');
            nameSpan.style.color = player.color || '#000';
            nameSpan.textContent = player.username;

            messageDiv.appendChild(document.createTextNode('🚶 '));
            messageDiv.appendChild(nameSpan);
            messageDiv.appendChild(document.createTextNode(' has left the game'));

            // Additional context if they were the drawer
            if (wasDrawer) {
                messageDiv.appendChild(document.createTextNode(' (was drawing)'));
            }

            chatDiv.appendChild(messageDiv);
            chatDiv.scrollTop = chatDiv.scrollHeight;
        });
    }

    // Update current players
    currentPlayers = [...players];

    updatePlayersList();

    // Update prompt button styling when host changes
    const isHost = players.length > 0 && players[0].id === socket.id;
    const viewPromptBtn = document.getElementById('viewPromptBtn');
    if (viewPromptBtn) {
        if (isHost) {
            viewPromptBtn.classList.add('host-prompt-btn');
            viewPromptBtn.title = 'Edit AI Prompt (Host Only)';
        } else {
            viewPromptBtn.classList.remove('host-prompt-btn');
            viewPromptBtn.title = 'View AI Prompt';
        }
    }

    // Only disable chat for drawer during drawing phase (not during voting)
    refreshChatEnabled(voting, currentDrawer);

    // Always show toolbar but disable it if not the drawer
    const toolbar = document.getElementById('toolbar');
    toolbar.style.display = 'flex';
    if (socket.id === currentDrawer) {
        toolbar.classList.remove('disabled');
    } else {
        toolbar.classList.add('disabled');
    }
}

function refreshChatEnabled(voting, currentDrawer) {
    const chatDisabled = !voting && socket.id === currentDrawer;
    const chatInput = document.getElementById('chatInput');
    chatInput.disabled = chatDisabled;
    chatInput.placeholder = chatDisabled ? "Drawing..." :
        voting ? "Chat..." : "/g to guess...";
}

function startNewTurn({ drawer, drawerId, round }) {
    document.getElementById('drawer').textContent = drawer;
    document.getElementById('drawer').dataset.id = drawerId;
    document.getElementById('round').textContent = round;

    // Reset drawing state
    clearDrawCanvas();
    undoStack = [];
    lastDrawingSent = null;

    // Only reset the voting area and prompt, keep the chat history
    document.getElementById('voting').style.display = 'none';
    document.getElementById('prompt').style.display = 'none';

    // Show drawing view
    document.getElementById('drawing-view').style.display = 'block';

    // Ensure timer is visible and reset
    document.getElementById('timer').textContent = getTimeString('--');
    document.getElementById('timer').style.color = '';

    // Show drawing tools but disable if not the drawer
    const toolbar = document.getElementById('toolbar');
    toolbar.style.display = 'flex';
    if (socket.id === drawerId) {
        toolbar.classList.remove('disabled');
    } else {
        toolbar.classList.add('disabled');
    }

    // Reset color picker and eraser state
    isEraser = false;
    document.getElementById('colorPicker').disabled = false;
    document.getElementById('eraserBtn').classList.remove('eraser-active');

    limitChatMessages(30);

    // Add system message about new turn
    addSystemMessage(`Round ${round}: ${drawer} is now drawing!`);
}

function showPrompt(prompt) {
    if (socket.id === document.getElementById('drawer').dataset.id) {
        document.getElementById('promptText').textContent = prompt;
        document.getElementById('prompt').style.display = 'block';
    }
}

function displayPublicRooms(rooms) {
    const publicRoomsList = document.getElementById('publicRoomsList');
    publicRoomsList.innerHTML = '';

    if (rooms.length === 0) {
        publicRoomsList.innerHTML = '<div class="no-rooms">No public rooms available</div>';
        return;
    }

    // Sort rooms: newer rooms first
    rooms.sort((a, b) => b.createdAt - a.createdAt);

    // Create a room item for each public room
    rooms.forEach(room => {
        const roomItem = document.createElement('div');
        roomItem.className = 'room-item';
        roomItem.dataset.roomCode = room.roomCode;

        const roomInfo = document.createElement('div');
        roomInfo.className = 'room-info';

        const hostName = document.createElement('div');
        hostName.className = 'room-host';
        hostName.textContent = room.hostName;

        const details = document.createElement('div');
        details.className = 'room-details';
        details.textContent = `${room.playerCount} player${room.playerCount !== 1 ? 's' : ''} • Round ${room.round}`;

        const roomControls = document.createElement('div');
        roomControls.className = 'room-controls';

        const promptBtn = document.createElement('button');
        promptBtn.className = 'icon-btn';
        promptBtn.title = 'View AI Prompt';
        promptBtn.innerHTML = '<span class="icon">🔮</span>';
        promptBtn.onclick = (e) => {
            e.stopPropagation();
            promptEditor.showPromptModal(room.prompt);
        };

        const joinBtn = document.createElement('button');
        joinBtn.className = 'room-join';
        joinBtn.textContent = 'Join';
        joinBtn.onclick = (e) => {
            e.stopPropagation();
            joinPublicRoom(room.roomCode);
        };

        roomInfo.appendChild(hostName);
        roomInfo.appendChild(details);

        roomControls.appendChild(promptBtn);
        roomControls.appendChild(joinBtn);

        roomItem.appendChild(roomInfo);
        roomItem.appendChild(roomControls);

        // Make the whole room item clickable
        roomItem.onclick = () => joinPublicRoom(room.roomCode);

        publicRoomsList.appendChild(roomItem);
    });
}

function startVoting(generatedImages) {
    // Hide drawing view and show voting view
    document.getElementById('drawing-view').style.display = 'none';

    // Re-enable chat for drawer
    refreshChatEnabled(true, null);

    // Show the voting area
    const votingArea = document.getElementById('voting');
    const votingImagesContainer = document.getElementById('voting-images');
    votingImagesContainer.innerHTML = ''; // Clear any previous images

    // Create an element for each generated image
    generatedImages.forEach(imageData => {
        const imageContainer = document.createElement('div');
        imageContainer.className = 'image-vote-container';
        imageContainer.dataset.playerId = imageData.playerId;

        // Add the image
        const img = document.createElement('img');
        img.src = imageData.imageSrc;
        img.className = 'vote-image';

        // Add the player info and guess
        const infoDiv = document.createElement('div');
        infoDiv.className = 'image-info';

        const nameElement = document.createElement('strong');
        nameElement.textContent = imageData.playerName;

        infoDiv.appendChild(nameElement);
        infoDiv.appendChild(document.createTextNode(': "' + imageData.guess + '"'));

        // Add vote counter
        const voteCounter = document.createElement('div');
        voteCounter.className = 'vote-counter';
        voteCounter.textContent = '0';
        voteCounter.dataset.votes = '0';

        // Add animation container for flying votes
        const animationContainer = document.createElement('div');
        animationContainer.className = 'vote-animation-container';

        // Add the vote button
        const voteButton = document.createElement('button');
        voteButton.textContent = 'Vote';
        voteButton.className = 'vote-button';
        voteButton.onclick = (e) => vote(imageData.playerId, e.target);

        // Add all elements to the container
        imageContainer.appendChild(img);
        imageContainer.appendChild(infoDiv);
        imageContainer.appendChild(voteCounter);
        imageContainer.appendChild(animationContainer);
        imageContainer.appendChild(voteButton);

        // Add the container to the voting area
        votingImagesContainer.appendChild(imageContainer);
    });

    // Start the voting phase
    votingArea.style.display = 'block';

    // Add system message about voting starting
    addSystemMessage("Time to vote! Pick your favorite image.");
}

function vote(imagePlayerId, buttonElement) {
    const roomCode = document.getElementById('currentRoom').textContent;

    socket.emit('vote', { roomCode, imagePlayerId });

    // Mark all other vote buttons as unselected and the voted one as selected
    document.querySelectorAll('.vote-button').forEach(btn => {
        btn.disabled = true;

        // Get the parent container to determine if this is the voted image
        const container = btn.closest('.image-vote-container');
        const isVotedImage = container.dataset.playerId === imagePlayerId;

        if (isVotedImage) {
            btn.classList.add('voted-selected'); // Green for selected

            // Get vote counter element
            const voteCounter = container.querySelector('.vote-counter');
            const animationContainer = container.querySelector('.vote-animation-container');

            // Update vote count
            let currentVotes = parseInt(voteCounter.dataset.votes || '0');
            currentVotes++;
            voteCounter.textContent = currentVotes;
            voteCounter.dataset.votes = currentVotes;
            voteCounter.classList.add('has-votes');

            // Create flying vote animation
            createFlyingVoteAnimation(buttonElement, voteCounter, animationContainer);
        } else {
            btn.classList.add('voted-unselected'); // Grey for unselected
        }
    });
}

// Function to create a flying vote animation
function createFlyingVoteAnimation(sourceElement, targetElement, container) {
    // Create a flying vote element
    const flyingVote = document.createElement('div');
    flyingVote.className = 'flying-vote';
    flyingVote.textContent = '+1';

    // Get source position (the vote button)
    const sourceRect = sourceElement.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();

    // Get target position (the vote counter)
    const targetRect = targetElement.getBoundingClientRect();

    // Calculate start and end points relative to the animation container
    const startX = sourceRect.left + sourceRect.width/2 - containerRect.left;
    const startY = sourceRect.top + sourceRect.height/2 - containerRect.top;
    const endX = targetRect.left + targetRect.width/2 - containerRect.left;
    const endY = targetRect.top + targetRect.height/2 - containerRect.top;

    // Set custom properties for the animation
    flyingVote.style.setProperty('--start-x', startX + 'px');
    flyingVote.style.setProperty('--start-y', startY + 'px');
    flyingVote.style.setProperty('--end-x', endX + 'px');
    flyingVote.style.setProperty('--end-y', endY + 'px');

    // Position the flying vote at the start position
    flyingVote.style.left = startX + 'px';
    flyingVote.style.top = startY + 'px';

    // Add to container and remove after animation completes
    container.appendChild(flyingVote);
    setTimeout(() => {
        container.removeChild(flyingVote);
    }, 1000);
}

function handleVotingResults({ message, scores, votes }) {
    // Update players scores
    scores.forEach(playerScore => {
        const playerIndex = currentPlayers.findIndex(p => p.id === playerScore.id);
        if (playerIndex !== -1) {
            currentPlayers[playerIndex].score = playerScore.score;
        }
    });

    updatePlayersList();

    // Process votes if provided by the server
    if (votes) {
        // Calculate total votes and determine winners
        let totalVotes = 0;
        let winningPlayerIds = [];

        // First pass: calculate total votes
        Object.values(votes).forEach(voteCount => {
            totalVotes += voteCount;
        });

        // Minimum threshold for a win - more than 50% of votes
        const winThreshold = totalVotes > 0 ? totalVotes / 2 : 0;

        // Second pass: find players who received more than 50% of votes
        Object.entries(votes).forEach(([playerId, voteCount]) => {
            if (voteCount > winThreshold) {
                winningPlayerIds.push(playerId);
            }
        });

        // Delay to allow current user's vote animation to complete
        setTimeout(() => {
            // For each player who received votes
            Object.entries(votes).forEach(([playerId, voteCount]) => {
                // Skip if vote count is 0
                if (voteCount === 0) return;

                const container = document.querySelector(`.image-vote-container[data-player-id="${playerId}"]`);
                if (container) {
                    const voteCounter = container.querySelector('.vote-counter');
                    const animationContainer = container.querySelector('.vote-animation-container');
                    const voteButton = container.querySelector('.vote-button');

                    // Update vote count
                    voteCounter.textContent = voteCount;
                    voteCounter.dataset.votes = voteCount;
                    voteCounter.classList.add('has-votes');

                    // Create multiple flying votes with small delays for a cascade effect
                    for (let i = 0; i < voteCount; i++) {
                        // Create a random start position around the image for incoming votes
                        setTimeout(() => {
                            // For votes from others, create a flying animation from a random edge
                            createRandomVoteAnimation(voteCounter, animationContainer);
                        }, i * 200); // Stagger animations by 200ms
                    }

                    // If this is a winning player, highlight their vote counter
                    if (winningPlayerIds.includes(playerId)) {
                        // Add a slight delay before highlighting winner to let animations finish
                        setTimeout(() => {
                            voteCounter.classList.add('winner');

                            // Create winning celebration effect
                            celebrateWinner(container);
                        }, voteCount * 220 + 500); // Delay based on the number of vote animations + 500ms buffer
                    }
                }
            });
        }, 500); // Give time for the user's own vote animation to complete
    }

    // Add system message about voting results
    addSystemMessage(message);
}

// Function to create a celebration effect for winning images
function celebrateWinner(container) {
    // Add subtle background flash to the image container
    const flashEffect = document.createElement('div');
    flashEffect.style.position = 'absolute';
    flashEffect.style.top = '0';
    flashEffect.style.left = '0';
    flashEffect.style.right = '0';
    flashEffect.style.bottom = '0';
    flashEffect.style.backgroundColor = 'rgba(46, 204, 113, 0.2)';
    flashEffect.style.borderRadius = '8px';
    flashEffect.style.opacity = '0';
    flashEffect.style.pointerEvents = 'none';
    flashEffect.style.transition = 'opacity 0.3s ease-in-out';
    flashEffect.style.zIndex = '3';

    container.appendChild(flashEffect);

    // Animate the flash
    setTimeout(() => {
        flashEffect.style.opacity = '1';

        setTimeout(() => {
            flashEffect.style.opacity = '0';

            // Remove the element after animation is complete
            setTimeout(() => {
                if (container.contains(flashEffect)) {
                    container.removeChild(flashEffect);
                }
            }, 500);
        }, 800);
    }, 100);
}

// Handle a vote from another player
function handlePlayerVote(targetPlayerId, voterName, voterColor) {
    // Check if this is our own vote - we've already handled it locally
    const ourPlayer = currentPlayers.find(p => p.id === socket.id);
    const isOurVote = ourPlayer && ourPlayer.username === voterName;
    if (isOurVote) return;

    // Find the container for the image that was voted for
    const container = document.querySelector(`.image-vote-container[data-player-id="${targetPlayerId}"]`);
    if (!container) return;

    // Get the counter and animation container
    const voteCounter = container.querySelector('.vote-counter');
    const animationContainer = container.querySelector('.vote-animation-container');

    // Update vote count
    let currentVotes = parseInt(voteCounter.dataset.votes || '0');
    currentVotes++;
    voteCounter.textContent = currentVotes;
    voteCounter.dataset.votes = currentVotes;
    voteCounter.classList.add('has-votes');

    // Create flying vote animation from a random edge
    createRandomVoteAnimation(voteCounter, animationContainer, voterName, voterColor);

    // Add a subtle system message
    const message = `${voterName} voted for an image`;
    addSystemMessage(message, 'system-message vote-message');
}

// Function to create a random vote animation (for votes from other players)
function createRandomVoteAnimation(targetElement, container, voterName, voterColor) {
    const flyingVote = document.createElement('div');
    flyingVote.className = 'flying-vote';
    flyingVote.textContent = '+1';

    // Apply voter color if provided
    if (voterColor) {
        flyingVote.style.backgroundColor = voterColor;
        flyingVote.style.boxShadow = `0 0 10px ${voterColor}`;
    }

    const containerRect = container.getBoundingClientRect();
    const targetRect = targetElement.getBoundingClientRect();

    // Calculate end point (the vote counter)
    const endX = targetRect.left + targetRect.width/2 - containerRect.left;
    const endY = targetRect.top + targetRect.height/2 - containerRect.top;

    // Random start point from one of the edges
    let startX, startY;
    const side = Math.floor(Math.random() * 4); // 0=top, 1=right, 2=bottom, 3=left

    switch(side) {
        case 0: // top
            startX = Math.random() * containerRect.width;
            startY = -30;
            break;
        case 1: // right
            startX = containerRect.width + 30;
            startY = Math.random() * containerRect.height;
            break;
        case 2: // bottom
            startX = Math.random() * containerRect.width;
            startY = containerRect.height + 30;
            break;
        case 3: // left
            startX = -30;
            startY = Math.random() * containerRect.height;
            break;
    }

    // Set custom properties for the animation
    flyingVote.style.setProperty('--start-x', startX + 'px');
    flyingVote.style.setProperty('--start-y', startY + 'px');
    flyingVote.style.setProperty('--end-x', endX + 'px');
    flyingVote.style.setProperty('--end-y', endY + 'px');

    // Position the flying vote at the start position
    flyingVote.style.left = startX + 'px';
    flyingVote.style.top = startY + 'px';

    // Add tooltip with voter name if provided
    if (voterName) {
        flyingVote.title = `Vote from ${voterName}`;
    }

    // Add to container and remove after animation completes
    container.appendChild(flyingVote);
    setTimeout(() => {
        if (container.contains(flyingVote)) {
            container.removeChild(flyingVote);
        }
    }, 1000);
}

// Event listeners
document.getElementById('chatInput').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
        const message = e.target.value.trim();
        const roomCode = document.getElementById('currentRoom').textContent;
        if (message && roomCode) {
            socket.emit('sendMessage', { roomCode, message });
            e.target.value = '';
        }
    }
});

document.getElementById('colorPicker').addEventListener('change', () => {
    if (isEraser) {
        // Switch out of eraser mode when a color is picked
        isEraser = false;
        document.getElementById('eraserBtn').classList.remove('eraser-active');
        document.getElementById('colorPicker').disabled = false;
    }
});

// Socket event handlers at the bottom
socket.on('publicRoomsList', (rooms) => {
    displayPublicRooms(rooms);
});

socket.on('roomCreated', ({ roomCode, username, inviteLink }) => {
    startGame(roomCode, username, inviteLink);
});

socket.on('roomJoined', ({ roomCode, username }) => {
    startGame(roomCode, username);
});

socket.on('gameState', (gameState) => {
    updateGameState(gameState);
});

socket.on('newTurn', (turnData) => {
    startNewTurn(turnData);
});

socket.on('newPrompt', (prompt) => {
    showPrompt(prompt);
});

socket.on('drawingUpdate', (drawingData) => {
    setDrawingData(drawingData);
});

socket.on('newMessage', (messageData) => {
    addPlayerMessage(messageData);
});

socket.on('systemMessage', ({ message, timestamp }) => {
    addSystemMessage(message);
});

socket.on('startVoting', (generatedImages) => {
    startVoting(generatedImages);
});

socket.on('votingResults', (resultsData) => {
    handleVotingResults(resultsData);
});

socket.on('playerVoted', ({ playerId, voterName, voterColor }) => {
    handlePlayerVote(playerId, voterName, voterColor);
});

socket.on('startDisplayTimer', (seconds) => {
    startDisplayTimer(seconds);
});

socket.on('error', (message) => console.error(message));

// Handle socket connection events
let disconnectTimeout;
socket.on('connect', () => {
    console.log('Connected to server');
    clearTimeout(disconnectTimeout);

    if (!isInGame()) {
        restartRoomRefreshInterval();
    }
});

socket.on('disconnect', () => {
    console.log('Disconnected from server');

    clearRoomRefreshInterval();

    // If we're in a game and got disconnected, show a message and return to lobby
    addSystemMessage('⚠️ Connection lost. Returning to lobby in 5 seconds...');

    // Set a timeout to return to the main menu if reconnection doesn't happen quickly
    disconnectTimeout = setTimeout(() => {
        if (isInGame()) {
            returnToLobby();
        }
    }, 5000); // 5 seconds timeout before returning to lobby
});