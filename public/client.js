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

function createRoom() {
    const username = document.getElementById('username').value.trim();
    if (username) socket.emit('createRoom', username);
}

function joinRoom() {
    const username = document.getElementById('username').value.trim();
    const roomCode = document.getElementById('roomCode').value.trim().toUpperCase() || new URLSearchParams(window.location.search).get('room');
    if (username && roomCode) socket.emit('joinRoom', { roomCode, username });
}

function submitGuess() {
    const guess = document.getElementById('guessInput').value.trim();
    const roomCode = document.getElementById('currentRoom').textContent;
    if (guess && roomCode) {
        socket.emit('submitGuess', { roomCode, guess });
        document.getElementById('guessInput').value = '';
    }
}

canvas.addEventListener('mousedown', (e) => {
    if (socket.id === document.getElementById('drawer').dataset.id) {
        drawing = true;
        ctx.beginPath();
        ctx.moveTo(e.offsetX, e.offsetY);
        undoStack.push(canvas.toDataURL());
    }
});

canvas.addEventListener('mousemove', (e) => {
    if (drawing) {
        ctx.strokeStyle = isEraser ? '#ffffff' : document.getElementById('colorPicker').value;
        ctx.lineWidth = document.getElementById('brushSize').value;
        ctx.lineTo(e.offsetX, e.offsetY);
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

function setEraser() {
    isEraser = true;
    document.getElementById('colorPicker').disabled = true;
}

document.getElementById('colorPicker').addEventListener('change', () => {
    isEraser = false;
    document.getElementById('colorPicker').disabled = false;
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
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.drawImage(img, 0, 0);
            sendDrawingUpdate();
        };
        img.src = lastState;
    }
}

function clearCanvas() {
    if (socket.id === document.getElementById('drawer')?.dataset?.id) {
        undoStack.push(canvas.toDataURL());
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        sendDrawingUpdate();
    }
}

socket.on('roomCreated', ({ roomCode, username, inviteLink }) => startGame(roomCode, username, inviteLink));
socket.on('roomJoined', ({ roomCode, username }) => startGame(roomCode, username));

function startGame(roomCode, username, inviteLink) {
    document.getElementById('lobby').style.display = 'none';
    document.getElementById('game').style.display = 'block';
    document.getElementById('currentRoom').textContent = roomCode;
    if (inviteLink) {
        const inviteDiv = document.getElementById('inviteLink');
        inviteDiv.style.display = 'block';
        inviteDiv.innerHTML = `Invite others: <a href="${inviteLink}" target="_blank">${inviteLink}</a>`;
    }
}

socket.on('gameState', ({ players, currentDrawer, round, voting }) => {
    document.getElementById('round').textContent = round;
    document.getElementById('drawer').textContent = players.find(p => p.id === currentDrawer).username;
    document.getElementById('drawer').dataset.id = currentDrawer;

    const playersDiv = document.getElementById('players');
    playersDiv.innerHTML = 'Players:<br>' + players.map(p => `${p.username}: ${p.score}`).join('<br>');

    document.getElementById('guessInput').disabled = voting || socket.id === currentDrawer;
    document.getElementById('toolbar').style.display = socket.id === currentDrawer ? 'block' : 'none';
});

socket.on('newTurn', ({ drawer, drawerId, round }) => {
    document.getElementById('drawer').textContent = drawer;
    document.getElementById('drawer').dataset.id = drawerId;
    document.getElementById('round').textContent = round;
    
    // Reset drawing state
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    undoStack = [];
    lastDrawingSent = null;
    drawingUpdateBuffer = 0;
    
    // Reset UI
    document.getElementById('guesses').innerHTML = '';
    document.getElementById('voting').style.display = 'none';
    document.getElementById('voteResults').style.display = 'none';
    document.getElementById('prompt').style.display = 'none';
    
    // Show drawing tools only for the drawer
    document.getElementById('toolbar').style.display = socket.id === drawerId ? 'block' : 'none';
    
    // Reset color picker state
    isEraser = false;
    document.getElementById('colorPicker').disabled = false;
    
    startTimer(40);
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
        ctx.clearRect(0, 0, canvas.width, canvas.height);
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
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0);
    };
    img.src = drawingData;
});

socket.on('newGuess', ({ username, guess }) => {
    const guessesDiv = document.getElementById('guesses');
    const existing = Array.from(guessesDiv.children).find(div => div.dataset.username === username);
    if (existing) {
        existing.textContent = `${username}: ${guess}`;
    } else {
        const div = document.createElement('div');
        div.dataset.username = username;
        div.textContent = `${username}: ${guess}`;
        guessesDiv.appendChild(div);
    }
});

socket.on('startVoting', (imageSrc) => {
    document.getElementById('generatedImage').src = imageSrc;
    document.getElementById('voting').style.display = 'block';
    document.querySelectorAll('#voting button').forEach(btn => btn.disabled = false);
    startTimer(20);
});

function vote(choice) {
    const roomCode = document.getElementById('currentRoom').textContent;
    socket.emit('vote', { roomCode, vote: choice });
    document.querySelectorAll('#voting button').forEach(btn => btn.disabled = true);
}

socket.on('votingResults', ({ message, scores }) => {
    document.getElementById('voteResults').textContent = message;
    document.getElementById('voteResults').style.display = 'block';
    const playersDiv = document.getElementById('players');
    playersDiv.innerHTML = 'Players:<br>' + scores.map(s => `${s.username}: ${s.score}`).join('<br>');
});

socket.on('error', (message) => alert(message));

function startTimer(seconds) {
    let timeLeft = seconds;
    const timer = document.getElementById('timer');
    timer.textContent = `Time: ${timeLeft}s`;
    const interval = setInterval(() => {
        timeLeft--;
        timer.textContent = `Time: ${timeLeft}s`;
        if (timeLeft <= 0) clearInterval(interval);
    }, 1000);
}

if (new URLSearchParams(window.location.search).get('room')) joinRoom();