const socket = io();

const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

// Local game state
let currentPlayers = [];
let currentGameInstance = null;

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

// Resets all drawing state (canvas, undo stack, eraser, etc.)
function resetDrawingState() {
    clearDrawCanvas();
    undoStack = [];
    lastDrawingSent = null;
    isEraser = false;

    // Reset UI elements
    document.getElementById('colorPicker').disabled = false;
    document.getElementById('eraserBtn').classList.remove('eraser-active');
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

    // Get selected game type
    const gameTypeSelect = document.getElementById('gameTypeSelect');
    const gameType = gameTypeSelect ? gameTypeSelect.value : 'imageinary';

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

        const customPrompts = promptEditor.getCustomPrompts();

        // Include custom prompt when creating room (get from promptEditor)
        socket.emit('createRoom', username, customPrompts, isPublic, gameType);
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

function startGame(roomCode, username, inviteLink, gameType = 'imageinary') {
    // Clear the rooms refresh interval when game starts
    clearRoomRefreshInterval();

    // Reset currentPlayers
    currentPlayers = [];

    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('currentRoom').textContent = roomCode;

    // Initialize the appropriate game module
    if (gameType === 'zoob') {
        currentGameInstance = window.zoob;
        currentGameInstance.init(socket); // Pass socket instance
        addSystemMessage(`Welcome to Zoob, room ${roomCode}! You joined as ${username}`, 'system-message welcome-message');
    } else { // Default to imageinary
        currentGameInstance = window.imageinary;
        currentGameInstance.init(socket); // Pass socket instance
        addSystemMessage(`Welcome to Imageinary, room ${roomCode}! You joined as ${username}`, 'system-message welcome-message');
    }

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
    // Call cleanup on the current game instance BEFORE resetting UI
    if (currentGameInstance) {
        currentGameInstance.cleanup();
        currentGameInstance = null;
    }

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

function updateGameState(gameData) {
    // Common updates for all game types
    document.getElementById('round').textContent = gameData.round;

    // Delegate game-specific updates to the current game instance
    if (currentGameInstance && typeof currentGameInstance.updateState === 'function') {
        currentGameInstance.updateState(gameData);
    }

    if (currentPlayers.length > 0) {
        // Detect player joins and leaves
        const newPlayers = gameData.players.map(p => p.id);
        const oldPlayers = currentPlayers.map(p => p.id);

        // Find players who just joined (in new but not in old)
        const joinedPlayers = gameData.players.filter(p => !oldPlayers.includes(p.id));

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
            const wasDrawer = player.id === gameData.currentDrawer;

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
            if (wasDrawer && gameData.gameType !== 'zoob') {
                messageDiv.appendChild(document.createTextNode(' (was drawing)'));
            }

            chatDiv.appendChild(messageDiv);
            chatDiv.scrollTop = chatDiv.scrollHeight;
        });
    }

    // Update current players
    currentPlayers = [...gameData.players];

    updatePlayersList();

    // Update prompt button styling when host changes
    const isHost = gameData.players.length > 0 && gameData.players[0].id === socket.id;
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

        // Show game type badge
        const gameType = room.gameType || 'imageinary';
        const gameTypeBadge = gameType === 'zoob' ? '🧙‍♂️ Zoob' : '🎨 Imageinary';

        details.textContent = `${gameTypeBadge} • ${room.playerCount} player${room.playerCount !== 1 ? 's' : ''} • Round ${room.round}`;

        const roomControls = document.createElement('div');
        roomControls.className = 'room-controls';

        // Only show prompt button for Imageinary rooms
        if (gameType !== 'zoob') {
            const promptBtn = document.createElement('button');
            promptBtn.className = 'icon-btn';
            promptBtn.title = 'View AI Prompt';
            promptBtn.innerHTML = '<span class="icon">🔮</span>';
            promptBtn.onclick = (e) => {
                e.stopPropagation();
                promptEditor.showPromptModal(room.customPrompts);
            };
            roomControls.appendChild(promptBtn);
        }

        const joinBtn = document.createElement('button');
        joinBtn.className = 'room-join';
        joinBtn.textContent = 'Join';
        joinBtn.onclick = (e) => {
            e.stopPropagation();
            joinPublicRoom(room.roomCode);
        };

        roomInfo.appendChild(hostName);
        roomInfo.appendChild(details);

        roomControls.appendChild(joinBtn);

        roomItem.appendChild(roomInfo);
        roomItem.appendChild(roomControls);

        // Make the whole room item clickable
        roomItem.onclick = () => joinPublicRoom(room.roomCode);

        publicRoomsList.appendChild(roomItem);
    });
}

/**
 * Generic function to display voting options
 * @param {Array<Object>} options - Array of option objects. Each object needs:
 *   - playerId: ID of the player associated with the option
 *   - displayData: Object containing render data based on type
 * @param {function(string)} onVoteCallback - Function to call with playerId when voted
 */
function displayVotingOptions(options, onVoteCallback) {
    // Hide game-specific views
    document.getElementById('drawing-view').style.display = 'none';

    // Show the generic voting area
    const votingArea = document.getElementById('voting');
    const votingContainer = document.getElementById('voting-images');
    votingContainer.innerHTML = ''; // Clear previous options
    votingArea.style.display = 'block';

    // Create container for each option
    options.forEach(option => {
        const itemContainer = document.createElement('div');
        itemContainer.className = 'vote-option-container';
        itemContainer.dataset.playerId = option.playerId;

        // Render based on display data type
        if (option.displayData.type === 'imageinaryGuess') {
            // Imageinary rendering
            itemContainer.classList.add('image-vote-container');
            itemContainer.innerHTML = `
                <img src="${option.displayData.imageSrc}" class="vote-image" alt="Generated image for guess by ${option.displayData.name}">
                <div class="image-info">
                    <strong>${option.displayData.name}</strong>: "${option.displayData.guess}"
                </div>
                <div class="vote-counter" data-votes="0">0</div>
                <div class="vote-animation-container"></div>
                <button class="vote-button">Vote</button>
            `;
        } else if (option.displayData.type === 'zoobAction') {
            // Zoob rendering
            itemContainer.classList.add('zoob-action-item');
            itemContainer.innerHTML = `
                ${option.displayData.imageSrc ? `<img src="${option.displayData.imageSrc}" class="vote-image" alt="Result of ${option.displayData.action}">` : ''}
                <div class="zoob-player-info">
                    <strong>${option.displayData.name}</strong>: "${option.displayData.action}"
                </div>
                <div class="zoob-action-result">${option.displayData.result}</div>
                <div class="vote-counter" data-votes="0">0</div>
                <div class="vote-animation-container"></div>
                <button class="vote-button zoob-action-button">Vote</button>
            `;
        }

        // Attach vote button listener
        const voteButton = itemContainer.querySelector('.vote-button');
        if (voteButton) {
            voteButton.onclick = (e) => {
                // Disable all buttons after a vote
                document.querySelectorAll('.vote-button').forEach(btn => btn.disabled = true);
                // Mark this one as selected
                e.target.classList.add('voted-selected');
                e.target.textContent = 'Voted!';

                // Trigger callback with the player ID
                onVoteCallback(option.playerId);

                // Local animation for the clicked vote
                const voteCounter = itemContainer.querySelector('.vote-counter');
                const animationContainer = itemContainer.querySelector('.vote-animation-container');
                if (voteCounter && animationContainer) {
                    let currentVotes = parseInt(voteCounter.dataset.votes || '0');
                    currentVotes++;
                    voteCounter.textContent = currentVotes;
                    voteCounter.dataset.votes = currentVotes;
                    voteCounter.classList.add('has-votes');
                    createFlyingVoteAnimation(e.target, voteCounter, animationContainer);
                }
            };
        }

        votingContainer.appendChild(itemContainer);
    });

    // Add system message about voting starting
    addSystemMessage("Time to vote! Pick your favorite option.");
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

// Socket event handlers
socket.on('publicRoomsList', (rooms) => {
    displayPublicRooms(rooms);
});

socket.on('roomCreated', ({ roomCode, username, inviteLink, gameType }) => {
    startGame(roomCode, username, inviteLink, gameType);
});

socket.on('roomJoined', ({ roomCode, username, gameType }) => {
    startGame(roomCode, username, null, gameType);
});

socket.on('gameState', (gameState) => {
    updateGameState(gameState);
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

socket.on('votingResults', (resultsData) => {
    // First handle common voting behavior
    handleCommonVotingResults(resultsData);

    // Then delegate to game-specific handler for additional behavior
    if (currentGameInstance && typeof currentGameInstance.handleVotingResults === 'function') {
        currentGameInstance.handleVotingResults(resultsData);
    }
});

socket.on('playerVoted', (voteData) => {
    // First handle common voting behavior
    handleCommonPlayerVote(voteData);

    // Then delegate to game-specific handler for additional behavior
    if (currentGameInstance && typeof currentGameInstance.handlePlayerVote === 'function') {
        currentGameInstance.handlePlayerVote(voteData);
    }
});

/**
 * Handles common voting results behavior across game types
 * @param {Object} resultsData - The voting results data
 */
function handleCommonVotingResults(resultsData) {
    // Update player scores
    if (resultsData.scores) {
        resultsData.scores.forEach(playerScore => {
            const playerIndex = currentPlayers.findIndex(p => p.id === playerScore.id);
            if (playerIndex !== -1) {
                currentPlayers[playerIndex].score = playerScore.score;
            }
        });
        updatePlayersList();
    }

    // Process votes if provided by the server
    if (resultsData.votes) {
        // Calculate total votes and determine winners
        let totalVotes = 0;
        let winningPlayerIds = [];

        Object.values(resultsData.votes).forEach(voteCount => {
            totalVotes += voteCount;
        });
        const winThreshold = totalVotes > 0 ? totalVotes / 2 : 0;

        Object.entries(resultsData.votes).forEach(([playerId, voteCount]) => {
            if (voteCount > winThreshold) {
                winningPlayerIds.push(playerId);
            }
        });

        // Delay to allow current user's vote animation to complete
        setTimeout(() => {
            Object.entries(resultsData.votes).forEach(([playerId, voteCount]) => {
                if (voteCount === 0) return;

                // Find the container using the generic class + data attribute
                const container = document.querySelector(`.vote-option-container[data-player-id="${playerId}"]`);
                if (container) {
                    const voteCounter = container.querySelector('.vote-counter');
                    const animationContainer = container.querySelector('.vote-animation-container');

                    // Update vote count display
                    voteCounter.textContent = voteCount;
                    voteCounter.dataset.votes = voteCount; // Store numeric value
                    voteCounter.classList.add('has-votes');

                    // Trigger incoming vote animations
                    for (let i = 0; i < voteCount; i++) {
                        setTimeout(() => {
                            createRandomVoteAnimation(voteCounter, animationContainer);
                        }, i * 200);
                    }

                    // If this is a winning player, highlight their vote counter
                    if (winningPlayerIds.includes(playerId)) {
                        setTimeout(() => {
                            voteCounter.classList.add('winner');
                            celebrateWinner(container);
                        }, voteCount * 220 + 500);
                    }
                }
            });
        }, 500); // Initial delay
    }

    // Display voting results message
    if (resultsData.message) {
        addSystemMessage(resultsData.message);
    }
}

/**
 * Handles player vote animation for all game types
 * @param {Object} voteData - Data about the vote cast
 */
function handleCommonPlayerVote(voteData) {
    const { playerId, voterName, voterColor } = voteData;

    // We only need to display animations for votes from OTHERS.
    // The local click handler already dealt with our own click's animation.
    // Simply check if this socket is the voter (more reliable than username check)
    if (socket.id === voteData.voterId) return;

    // Find the container for the item that was voted for
    const container = document.querySelector(`.vote-option-container[data-player-id="${playerId}"]`);
    if (!container) return;

    const voteCounter = container.querySelector('.vote-counter');
    const animationContainer = container.querySelector('.vote-animation-container');

    if (!voteCounter || !animationContainer) return; // Safety check

    // Update vote count
    let currentVotes = parseInt(voteCounter.dataset.votes || '0');
    currentVotes++;
    voteCounter.textContent = currentVotes;
    voteCounter.dataset.votes = currentVotes;
    voteCounter.classList.add('has-votes');

    // Create flying vote animation from a random edge
    createRandomVoteAnimation(voteCounter, animationContainer, voterName, voterColor);

    // Add a subtle system message
    addSystemMessage(`${voterName} voted for an option`, 'system-message vote-message');
}

// Create victory celebration animation for a winning option
function celebrateWinner(container) {
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

socket.on('startDisplayTimer', (seconds) => {
    startDisplayTimer(seconds);
});

socket.on('stopDisplayTimer', () => {
    clearDisplayTimer();
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
    else {
        addSystemMessage("✅ Reconnected to server!");
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