const socket = io();
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
let drawing = false;
let isEraser = false;
let undoStack = [];
let lastDrawingSent = null;
let drawingUpdateBuffer = 0;

ctx.lineCap = 'round';
ctx.lineJoin = 'round';

// Initialize the canvas with a white background
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
    
    // Add keystroke handlers for the lobby form
    usernameInput.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            // If room code is filled, join room, otherwise create room
            const roomCode = document.getElementById('roomCode').value.trim();
            if (roomCode) {
                joinRoom();
            } else {
                createRoom();
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
                    <p>Please enter a username to join room ${roomParam}</p>
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

function createRoom() {
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
        socket.emit('createRoom', username);
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
        socket.emit('joinRoom', { roomCode, username });
    }
}

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

canvas.addEventListener('mousedown', (e) => {
    if (socket.id === document.getElementById('drawer').dataset.id) {
        drawing = true;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        ctx.beginPath();
        ctx.moveTo(x, y);
        undoStack.push(canvas.toDataURL());
    }
});

canvas.addEventListener('mousemove', (e) => {
    if (drawing) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        ctx.strokeStyle = isEraser ? '#ffffff' : document.getElementById('colorPicker').value;
        ctx.lineWidth = document.getElementById('brushSize').value;
        ctx.lineTo(x, y);
        ctx.stroke();
        
        // Throttle updates to prevent flooding the server
        drawingUpdateBuffer++;
        if (drawingUpdateBuffer >= 5) { // Send every 5 drawing movements
            drawingUpdateBuffer = 0;
            sendDrawingUpdate();
        }
    }
});

canvas.addEventListener('mouseup', () => {
    drawing = false;
    // Always send final state after finishing a stroke
    if (socket.id === document.getElementById('drawer').dataset.id) {
        sendDrawingUpdate();
    }
});

canvas.addEventListener('mouseleave', () => {
    drawing = false;
    // Always send final state after finishing a stroke
    if (socket.id === document.getElementById('drawer').dataset.id) {
        sendDrawingUpdate();
    }
});

// Touch event handlers for drawing
canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
canvas.addEventListener('touchend', handleTouchEnd, { passive: false });

function handleTouchStart(e) {
    e.preventDefault(); // Prevent scrolling/zooming
    if (socket.id === document.getElementById('drawer').dataset.id) {
        drawing = true;
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (touch.clientX - rect.left) * scaleX;
        const y = (touch.clientY - rect.top) * scaleY;
        ctx.beginPath();
        ctx.moveTo(x, y);
        undoStack.push(canvas.toDataURL());
    }
}

function handleTouchMove(e) {
    e.preventDefault();
    if (drawing) {
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (touch.clientX - rect.left) * scaleX;
        const y = (touch.clientY - rect.top) * scaleY;
        ctx.strokeStyle = isEraser ? '#ffffff' : document.getElementById('colorPicker').value;
        ctx.lineWidth = document.getElementById('brushSize').value;
        ctx.lineTo(x, y);
        ctx.stroke();
        drawingUpdateBuffer++;
        if (drawingUpdateBuffer >= 5) {
            drawingUpdateBuffer = 0;
            sendDrawingUpdate();
        }
    }
}

function handleTouchEnd(e) {
    e.preventDefault();
    drawing = false;
    if (socket.id === document.getElementById('drawer').dataset.id) {
        sendDrawingUpdate();
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

document.getElementById('colorPicker').addEventListener('change', () => {
    if (isEraser) {
        // Switch out of eraser mode when a color is picked
        isEraser = false;
        document.getElementById('eraserBtn').classList.remove('eraser-active');
        document.getElementById('colorPicker').disabled = false;
    }
});

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
            ctx.drawImage(img, 0, 0);
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

socket.on('roomCreated', ({ roomCode, username, inviteLink }) => startGame(roomCode, username, inviteLink));
socket.on('roomJoined', ({ roomCode, username }) => startGame(roomCode, username));

function startGame(roomCode, username, inviteLink) {
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('currentRoom').textContent = roomCode;
    
    // Initialize timer
    document.getElementById('timer').textContent = getTimeString('--');
    
    // Generate shareable link if not provided
    if (!inviteLink) {
        inviteLink = `${window.location.origin}/?room=${roomCode}`;
    }
    
    // We'll use an icon in the game info section instead of a separate invite button
    
    // Ensure the game interface is visible and scrollable
    document.body.style.overflow = 'auto';
}

socket.on('gameState', ({ players, currentDrawer, round, voting }) => {
    document.getElementById('round').textContent = round;
    document.getElementById('drawer').textContent = players.find(p => p.id === currentDrawer).username;
    document.getElementById('drawer').dataset.id = currentDrawer;

    const playersDiv = document.getElementById('players');
    playersDiv.innerHTML = ''; // Clear existing content
    
    // Add each player with proper DOM methods to prevent XSS
    players.forEach(p => {
        const playerDiv = document.createElement('div');
        
        const nameSpan = document.createElement('span');
        nameSpan.style.color = p.color || '#000';
        nameSpan.textContent = p.username;
        
        playerDiv.appendChild(nameSpan);
        playerDiv.appendChild(document.createTextNode(': ' + p.score));
        
        playersDiv.appendChild(playerDiv);
    });

    document.getElementById('chatInput').disabled = voting || socket.id === currentDrawer;
    document.getElementById('toolbar').style.display = socket.id === currentDrawer ? 'block' : 'none';
});

// Function to add system messages to chat
function addSystemMessage(message) {
    const chatDiv = document.getElementById('chat');
    const messageDiv = document.createElement('div');
    messageDiv.className = 'system-message';
    messageDiv.textContent = message;
    chatDiv.appendChild(messageDiv);
    chatDiv.scrollTop = chatDiv.scrollHeight;
}

socket.on('newTurn', ({ drawer, drawerId, round }) => {
    document.getElementById('drawer').textContent = drawer;
    document.getElementById('drawer').dataset.id = drawerId;
    document.getElementById('round').textContent = round;
    
    // Reset drawing state
    clearDrawCanvas();
    undoStack = [];
    lastDrawingSent = null;
    drawingUpdateBuffer = 0;
    
    // Reset UI
    document.getElementById('chat').innerHTML = '';
    document.getElementById('voting').style.display = 'none';
    document.getElementById('voteResults').style.display = 'none';
    document.getElementById('prompt').style.display = 'none';
    
    // Show drawing view
    document.getElementById('drawing-view').style.display = 'block';
    
    // Ensure timer is visible and reset
    document.getElementById('timer').textContent = getTimeString('--');
    document.getElementById('timer').style.color = '';
    
    // Show drawing tools only for the drawer
    document.getElementById('toolbar').style.display = socket.id === drawerId ? 'block' : 'none';
    
    // Reset color picker and eraser state
    isEraser = false;
    document.getElementById('colorPicker').disabled = false;
    document.getElementById('eraserBtn').classList.remove('eraser-active');
    
    // Add system message about new turn
    addSystemMessage(`Round ${round}: ${drawer} is now drawing!`);
});

socket.on('newPrompt', (prompt) => {
    if (socket.id === document.getElementById('drawer').dataset.id) {
        document.getElementById('promptText').textContent = prompt;
        document.getElementById('prompt').style.display = 'block';
    }
});

socket.on('drawingUpdate', (drawingData) => {
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
        ctx.drawImage(img, 0, 0);
    };
    img.src = drawingData;
});

socket.on('newMessage', ({ username, message, timestamp, color }) => {
    const chatDiv = document.getElementById('chat');
    const messageDiv = document.createElement('div');
    
    const usernameSpan = document.createElement('span');
    usernameSpan.style.color = color;
    usernameSpan.textContent = `${username}: `;
    
    const messageText = document.createTextNode(message);
    
    // Add both elements to the message div
    messageDiv.appendChild(usernameSpan);
    messageDiv.appendChild(messageText);
    
    chatDiv.appendChild(messageDiv);
    chatDiv.scrollTop = chatDiv.scrollHeight; // Auto-scroll to bottom
});

socket.on('startVoting', (generatedImages) => {
    // Hide drawing view and show voting view
    document.getElementById('drawing-view').style.display = 'none';
    
    // Show the voting area
    const votingArea = document.getElementById('voting');
    const votingImagesContainer = document.getElementById('voting-images');
    votingImagesContainer.innerHTML = ''; // Clear any previous images
    
    // Create an element for each generated image
    generatedImages.forEach(imageData => {
        const imageContainer = document.createElement('div');
        imageContainer.className = 'image-vote-container';
        
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
        
        // Add the vote button
        const voteButton = document.createElement('button');
        voteButton.textContent = 'Vote';
        voteButton.className = 'vote-button';
        voteButton.onclick = () => vote(imageData.playerId);
        
        // Add all elements to the container
        imageContainer.appendChild(img);
        imageContainer.appendChild(infoDiv);
        imageContainer.appendChild(voteButton);
        
        // Add the container to the voting area
        votingImagesContainer.appendChild(imageContainer);
    });
    
    // Hide the vote results initially
    document.getElementById('voteResults').style.display = 'none';
    votingArea.style.display = 'block';
    
    // Add system message about voting starting
    addSystemMessage("Time to vote! Pick your favorite image.");
});

function vote(imagePlayerId) {
    const roomCode = document.getElementById('currentRoom').textContent;
    socket.emit('vote', { roomCode, imagePlayerId });
    
    // Disable all vote buttons after voting
    document.querySelectorAll('.vote-button').forEach(btn => {
        btn.disabled = true;
        btn.classList.add('voted');
    });
}

socket.on('votingResults', ({ message, scores }) => {
    document.getElementById('voteResults').textContent = message;
    document.getElementById('voteResults').style.display = 'block';
    
    const playersDiv = document.getElementById('players');
    playersDiv.innerHTML = ''; // Clear existing content
    
    const titleEl = document.createElement('strong');
    titleEl.textContent = 'Players';
    playersDiv.appendChild(titleEl);
    
    // Add each player with proper DOM methods to prevent XSS
    scores.forEach(s => {
        const playerDiv = document.createElement('div');
        
        const nameSpan = document.createElement('span');
        nameSpan.style.color = s.color || '#000';
        nameSpan.textContent = s.username;
        
        playerDiv.appendChild(nameSpan);
        playerDiv.appendChild(document.createTextNode(': ' + s.score));
        
        playersDiv.appendChild(playerDiv);
    });
    
    // Add system message about voting results
    addSystemMessage(message);
});

socket.on('error', (message) => console.error(message));

// Track the current timer interval so we can clear it
let currentTimerInterval = null;

// Helper function to format time with the clock emoji
function getTimeString(seconds) {
    return `⏱️ ${seconds}`;
}

function startTimer(seconds) {
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

// Listen for timer start events from the server
socket.on('startTimer', (seconds) => {
    startTimer(seconds);
});

// Function to copy the room link
function copyRoomLink() {
    const roomCode = document.getElementById('currentRoom').textContent;
    const roomLink = `${window.location.origin}/?room=${roomCode}`;
    copyToClipboard(roomLink);
}