const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Replace with your actual Gemini API key and model configuration
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({
    model: "gemini-2.0-flash-exp-image-generation",
    generationConfig: {
        responseModalities: ['Text', 'Image']
    },
  });

// In-memory storage
const games = new Map(); // roomCode -> gameData
const drawings = new Map(); // roomCode -> drawingData
const lastMessageTimes = new Map(); // Tracks last message time per player

// Predefined prompts for the drawer
const prompts = [
    "cat", "dog", "house", "tree", "car", "sun", "moon", "star", "flower", "boat",
    "airplane", "bicycle", "book", "chair", "computer", "door", "window", "table", "shoe", "hat"
];

const roundDuration = 45;

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    socket.on('createRoom', (username) => {
        const roomCode = uuidv4().slice(0, 6).toUpperCase();
        socket.join(roomCode);
        initializeGame(roomCode, socket.id, username);
        socket.emit('roomCreated', { roomCode, username, inviteLink: `http://localhost:3000/?room=${roomCode}` });
    });

    socket.on('joinRoom', ({ roomCode, username }) => {
        if (games.has(roomCode)) {
            socket.join(roomCode);
            const game = games.get(roomCode);
            let uniqueUsername = username;
            let counter = 2;
            while (Array.from(game.players.values()).some(p => p.username === uniqueUsername)) {
                uniqueUsername = `${username}(${counter})`;
                counter++;
            }
            game.players.set(socket.id, { username: uniqueUsername, score: 0, color: getRandomColor() });
            socket.emit('roomJoined', { roomCode, username: uniqueUsername });
            
            // Send current drawing state to the new player
            const currentDrawing = drawings.get(roomCode);
            if (currentDrawing) {
                socket.emit('drawingUpdate', currentDrawing);
            }
            
            // Sync the timer for the new player
            if (game.timerEnd > Date.now()) {
                // If we're in drawing phase
                const remainingSeconds = Math.ceil((game.timerEnd - Date.now()) / 1000);
                if (remainingSeconds > 0) {
                    socket.emit('startTimer', remainingSeconds);
                }
            } else if (game.votingTimerEnd > Date.now()) {
                // If we're in voting phase
                const remainingSeconds = Math.ceil((game.votingTimerEnd - Date.now()) / 1000);
                if (remainingSeconds > 0) {
                    socket.emit('startTimer', remainingSeconds);
                }
            }
            
            updateGameState(roomCode);
        } else {
            socket.emit('error', 'Room not found');
        }
    });

    socket.on('drawing', ({ roomCode, drawingData }) => {
        // Store the drawing data
        drawings.set(roomCode, drawingData);
        
        // Send the update to all other players in the room
        socket.to(roomCode).emit('drawingUpdate', drawingData);
    });

    socket.on('sendMessage', ({ roomCode, message }) => {
        const game = games.get(roomCode);
        if (game && socket.id !== game.currentDrawer) {
            const now = Date.now();
            const lastTime = lastMessageTimes.get(socket.id) || 0;
            
            // Spam control: 1 message/sec
            if (now - lastTime < 1000) return;
            lastMessageTimes.set(socket.id, now);

            const timestamp = new Date().toLocaleTimeString();
            const username = game.players.get(socket.id).username;
            const color = game.players.get(socket.id).color || '#000000'; // Default color if not set
            
            game.chatHistory.push({ playerId: socket.id, username, message, timestamp, color });
            game.lastMessages.set(socket.id, message);
            
            io.to(roomCode).emit('newMessage', { username, message, timestamp, color });
        }
    });

    socket.on('vote', ({ roomCode, vote }) => {
        const game = games.get(roomCode);
        if (game && game.voting) {
            game.votes.set(socket.id, vote);
            if (game.votes.size === game.players.size) {
                clearTimeout(game.votingTimer);
                tallyVotes(roomCode);
            }
        }
    });

    socket.on('disconnect', () => {
        games.forEach((game, roomCode) => {
            if (game.players.has(socket.id)) {
                game.players.delete(socket.id);
                if (game.players.size === 0) {
                    games.delete(roomCode);
                    drawings.delete(roomCode);
                } else if (game.currentDrawer === socket.id) {
                    nextTurn(roomCode);
                }
                updateGameState(roomCode);
            }
        });
    });
});

function getRandomColor() {
    // Preset list of readable colors
    const colors = [
        '#3498db', // Blue
        '#2ecc71', // Green
        '#e74c3c', // Red
        '#9b59b6', // Purple
        '#f39c12', // Orange
        '#1abc9c', // Teal
        '#d35400', // Dark Orange
        '#8e44ad', // Dark Purple
        '#c0392b', // Dark Red
        '#16a085', // Dark Teal
        '#27ae60', // Dark Green
        '#2980b9'  // Dark Blue
    ];
    
    return colors[Math.floor(Math.random() * colors.length)];
}

function initializeGame(roomCode, socketId, username) {
    games.set(roomCode, {
        players: new Map([[socketId, { username, score: 0, color: getRandomColor() }]]),
        currentDrawer: socketId,
        round: 1,
        timer: null,
        timerEnd: 0,
        votingTimer: null,
        votingTimerEnd: 0,
        currentPrompt: '',
        chatHistory: [],
        lastMessages: new Map(),
        votes: new Map(),
        imageSrc: '',
        voting: false,
    });
    startTurn(roomCode);
}

function startTurn(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    game.voting = false;
    game.votes.clear();
    game.chatHistory = [];
    game.lastMessages.clear();
    game.imageSrc = '';
    
    // Clear the current drawing data
    drawings.set(roomCode, '');
    
    const players = Array.from(game.players.keys());
    game.currentDrawer = players[game.round % players.length];
    game.currentPrompt = prompts[Math.floor(Math.random() * prompts.length)];
    io.to(game.currentDrawer).emit('newPrompt', game.currentPrompt);
    io.to(roomCode).emit('newTurn', {
        drawer: game.players.get(game.currentDrawer).username,
        drawerId: game.currentDrawer,
        round: game.round,
    });

    const roundMs = roundDuration * 1000;
    game.timerEnd = Date.now() + roundMs;
    game.timer = setTimeout(() => endRound(roomCode), roundMs);
    
    // Start the timer on all clients
    io.to(roomCode).emit('startTimer', roundDuration);
    
    updateGameState(roomCode);
    
    // Send the initial blank canvas to all players
    io.to(roomCode).emit('drawingUpdate', '');
    
    // Also send the current state of the drawing if available when a player joins mid-game
    const drawingData = drawings.get(roomCode);
    if (drawingData) {
        io.to(roomCode).emit('drawingUpdate', drawingData);
    }
}

function endRound(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    clearTimeout(game.timer);
    generateNewImage(roomCode);
}

async function generateNewImage(roomCode) {
    const game = games.get(roomCode);
    const drawingData = drawings.get(roomCode);
    if (!game || !drawingData) {
        console.error(`Missing game or drawing data for roomCode: ${roomCode}`);
        return;
    }

    try {
        // Extract base64 string from data URL
        const base64Data = drawingData.split(',')[1];
        if (!base64Data) {
            throw new Error('Invalid drawingData format: no base64 content found');
        }

        const guesses = Array.from(game.lastMessages.values()).filter(guess => guess);
        const prompt = `The provided image is a Pictionary sketch. Draw it realistically and looking like a ${guesses.join(', ')}`;

        // Send request to the model
        const response = await model.generateContent([
            prompt,
            { inlineData: { data: base64Data, mimeType: 'image/png' } },
        ]);

        // Log the full response for debugging
        console.log('Full API Response:', JSON.stringify(response, null, 2));
        if (response.response.candidates.length === 0) {
            console.error('No candidates returned by the model');
            throw new Error('Model returned no candidates');
        }

        // Extract the generated image
        const candidate = response.response.candidates[0];

        if (candidate.finishReason === 'RECITATION') {
            console.log('Model rejected input due to RECITATION. Using original drawing as fallback.');
            game.imageSrc = drawings.get(roomCode); // Fallback to original drawing
            startVoting(roomCode);
            return;
        }

        if (!candidate || !candidate.content || !candidate.content.parts) {
            throw new Error('No valid candidate content in response');
        }

        const imagePart = candidate.content.parts.find(part => part.inlineData);
        if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
            throw new Error('No inline image data found in response');
        }

        const imageData = imagePart.inlineData.data;
        const buffer = Buffer.from(imageData, 'base64');
        const filename = `generated-${roomCode}-${game.round}.png`;
        const filePath = path.join(__dirname, 'public', 'generated', filename);

        // Ensure the directory exists
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, buffer);

        // Verify the output file
        console.log(`Generated image saved: ${filePath}`);
        game.imageSrc = `/generated/${filename}`;
        startVoting(roomCode);
    } catch (error) {
        console.error('Error generating image:', error.message, error.stack);
        io.to(roomCode).emit('error', 'Failed to generate image');
    }
}

function startVoting(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    game.voting = true;
    io.to(roomCode).emit('startVoting', game.imageSrc);
    game.votingTimerEnd = Date.now() + 20000;
    game.votingTimer = setTimeout(() => tallyVotes(roomCode), 20000);
    
    // Start the voting timer on all clients
    io.to(roomCode).emit('startTimer', 20);
}

function tallyVotes(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    game.voting = false;
    const likes = Array.from(game.votes.values()).filter(v => v === 'like').length;
    const totalPlayers = game.players.size;
    let resultMessage = '';
    if (likes > totalPlayers / 2) {
        game.players.get(game.currentDrawer).score += 1;
        resultMessage = `The image got ${likes} likes out of ${totalPlayers}. Drawer gets a point!`;
    } else {
        const correctGuessers = [];
        game.lastMessages.forEach((message, id) => {
            if (message.toLowerCase() === game.currentPrompt.toLowerCase()) {
                correctGuessers.push(id);
            }
        });
        if (correctGuessers.length > 0) {
            correctGuessers.forEach(id => {
                game.players.get(id).score += 1;
            });
            resultMessage = `No majority likes. Correct guessers get points!`;
        } else {
            resultMessage = `No majority likes and no correct guesses. No points awarded.`;
        }
    }
    io.to(roomCode).emit('votingResults', {
        message: resultMessage,
        scores: Array.from(game.players.entries()).map(([id, data]) => ({ 
            username: data.username, 
            score: data.score,
            color: data.color 
        })),
    });
    setTimeout(() => {
        game.round++;
        startTurn(roomCode);
    }, 5000);
}

function nextTurn(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;
    
    clearTimeout(game.timer);
    clearTimeout(game.votingTimer);
    game.round++;
    startTurn(roomCode);
}

function updateGameState(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    const players = Array.from(game.players.entries()).map(([id, data]) => ({
        id,
        username: data.username,
        score: data.score,
        color: data.color,
    }));

    io.to(roomCode).emit('gameState', {
        players,
        currentDrawer: game.currentDrawer,
        round: game.round,
        voting: game.voting,
    });
}

server.listen(3000, () => console.log('Server running on port 3000'));