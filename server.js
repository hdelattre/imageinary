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
    model: 'gemini-2.0-flash-exp-image-generation',
    generationConfig: { responseModalities: ['Text', 'Image'] },
});

// In-memory storage
const games = new Map(); // roomCode -> gameData
const drawings = new Map(); // roomCode -> drawingData

// Predefined prompts for the drawer
const prompts = [
    "cat", "dog", "house", "tree", "car", "sun", "moon", "star", "flower", "boat",
    "airplane", "bicycle", "book", "chair", "computer", "door", "window", "table", "shoe", "hat"
];

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
            game.players.set(socket.id, { username: uniqueUsername, score: 0 });
            socket.emit('roomJoined', { roomCode, username: uniqueUsername });
            
            // Send current drawing state to the new player
            const currentDrawing = drawings.get(roomCode);
            if (currentDrawing) {
                socket.emit('drawingUpdate', currentDrawing);
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

    socket.on('submitGuess', ({ roomCode, guess }) => {
        const game = games.get(roomCode);
        if (game && socket.id !== game.currentDrawer) {
            game.lastGuesses.set(socket.id, guess);
            io.to(roomCode).emit('newGuess', {
                username: game.players.get(socket.id).username,
                guess,
            });
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

function initializeGame(roomCode, socketId, username) {
    games.set(roomCode, {
        players: new Map([[socketId, { username, score: 0 }]]),
        currentDrawer: socketId,
        round: 1,
        timer: null,
        timerEnd: 0,
        votingTimer: null,
        votingTimerEnd: 0,
        currentPrompt: '',
        lastGuesses: new Map(),
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
    game.lastGuesses.clear();
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

    game.timerEnd = Date.now() + 40000;
    game.timer = setTimeout(() => endRound(roomCode), 40000);
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
    if (!game || !drawingData) return;

    try {
        const drawingBuffer = Buffer.from(drawingData.split(',')[1], 'base64');
        const guesses = Array.from(game.lastGuesses.values()).filter(guess => guess);
        const prompt = `Create a realistic 3D rendered image based on this drawing and these descriptions: ${guesses.join(', ')}`;

        const response = await model.generateContent([
            prompt,
            { inlineData: { data: drawingBuffer.toString('base64'), mimeType: 'image/png' } },
        ]);

        const imagePart = response.response.candidates[0].content.parts.find(part => part.inlineData);
        if (imagePart) {
            const imageData = imagePart.inlineData.data;
            const buffer = Buffer.from(imageData, 'base64');
            const filename = `generated-${roomCode}-${game.round}.png`;
            fs.writeFileSync(path.join(__dirname, 'public', 'generated', filename), buffer);
            game.imageSrc = `/generated/${filename}`;
            startVoting(roomCode);
        }
    } catch (error) {
        console.error('Error generating image:', error);
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
        game.lastGuesses.forEach((guess, id) => {
            if (guess.toLowerCase() === game.currentPrompt.toLowerCase()) {
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
        scores: Array.from(game.players.entries()).map(([id, data]) => ({ username: data.username, score: data.score })),
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
    }));

    io.to(roomCode).emit('gameState', {
        players,
        currentDrawer: game.currentDrawer,
        round: game.round,
        voting: game.voting,
    });
}

server.listen(3000, () => console.log('Server running on port 3000'));