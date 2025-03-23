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
const port = process.env.PORT || 3000;

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
        username = sanitizeMessage(username, '');
        
        const roomCode = uuidv4().slice(0, 6).toUpperCase();
        socket.join(roomCode);
        initializeGame(roomCode, socket.id, username);
        socket.emit('roomCreated', { roomCode, username, inviteLink: `http://localhost:${port}/?room=${roomCode}` });
    });

    socket.on('joinRoom', ({ roomCode, username }) => {
        username = sanitizeMessage(username, '');
        
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

            message = sanitizeMessage(message, '.?!/');

            const timestamp = new Date().toLocaleTimeString();
            const username = game.players.get(socket.id).username;
            const color = game.players.get(socket.id).color || '#000000'; // Default color if not set
            
            game.chatHistory.push({ playerId: socket.id, username, message, timestamp, color });
            game.lastMessages.set(socket.id, message);
            
            io.to(roomCode).emit('newMessage', { username, message, timestamp, color });
        }
    });

    socket.on('vote', ({ roomCode, imagePlayerId }) => {
        const game = games.get(roomCode);
        if (game && game.voting) {
            // Store which player's image was voted for
            game.votes.set(socket.id, imagePlayerId);
            
            // If everyone has voted, end voting early
            if (game.votes.size === game.players.size - 1) { // -1 for the drawer who doesn't vote
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

function sanitizeMessage(message, allowedPunctuation = '') {
    const escapedPunctuation = allowedPunctuation.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const regex = new RegExp(`[^a-zA-Z0-9\\s${escapedPunctuation}]`, 'g');
    return message.replace(regex, '');
}

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
        generatedImages: [],
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
    game.currentDrawer = players[(game.round - 1) % players.length];
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

    try {
        if (!game || !drawingData) {
            throw new Error(`Missing game or drawing data for roomCode: ${roomCode}`);
        }

        // Extract base64 string from data URL
        const base64Data = drawingData.split(',')[1];
        if (!base64Data) {
            throw new Error('Invalid drawingData format: no base64 content found');
        }

        // Generate an array of valid guesses with player info
        const guessesWithPlayers = [];
        game.lastMessages.forEach((guess, playerId) => {
            if (guess && playerId !== game.currentDrawer) {
                guessesWithPlayers.push({
                    playerId,
                    playerName: game.players.get(playerId).username,
                    guess
                });
            }
        });

        // No guesses, no images to generate
        if (guessesWithPlayers.length === 0) {
            throw new Error('No valid guesses to generate images from');
        }

        // Generate images for each guess
        const generatedImages = [];
        for (const guessData of guessesWithPlayers) {
            const prompt = `The provided image is a Pictionary sketch. Use the exact same shape/sihouette but draw it realistically and looking like the following guess: ${guessData.guess}`;
            
            try {
                // Send request to the model
                const response = await model.generateContent([
                    prompt,
                    { inlineData: { data: base64Data, mimeType: 'image/png' } },
                ]);

                if (response.response.candidates.length === 0) {
                    console.error('No candidates returned by the model');
                    continue;
                }

                // Extract the generated image
                const candidate = response.response.candidates[0];

                if (candidate.finishReason === 'RECITATION') {
                    console.log('Model rejected input due to RECITATION. Skipping this image.');
                    continue;
                }

                if (!candidate || !candidate.content || !candidate.content.parts) {
                    console.error('No valid candidate content in response');
                    continue;
                }

                const imagePart = candidate.content.parts.find(part => part.inlineData);
                if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
                    console.error('No inline image data found in response');
                    continue;
                }

                const imageData = imagePart.inlineData.data;
                const buffer = Buffer.from(imageData, 'base64');
                
                // Sanitize filename components to prevent path traversal
                const safeRoomCode = roomCode.replace(/[^a-zA-Z0-9]/g, '');
                const safePlayerId = guessData.playerId.replace(/[^a-zA-Z0-9-]/g, '');
                const safeRound = String(game.round).replace(/[^0-9]/g, '');
                const filename = `generated-${safeRoomCode}-${safeRound}-${safePlayerId}.png`;
                const filePath = path.join(__dirname, 'public', 'generated', filename);
                
                // Validate the path is within the generated directory
                const safePath = path.normalize(filePath);
                const generatedDir = path.join(__dirname, 'public', 'generated');
                if (!safePath.startsWith(generatedDir)) {
                    throw new Error('Invalid file path detected');
                }

                // Ensure the directory exists
                fs.mkdirSync(path.dirname(safePath), { recursive: true });
                fs.writeFileSync(safePath, buffer);

                // Verify the output file
                console.log(`Generated image saved: ${filePath}`);
                
                generatedImages.push({
                    playerId: guessData.playerId,
                    playerName: guessData.playerName,
                    guess: guessData.guess,
                    imageSrc: `/generated/${filename}` // Using the sanitized filename
                });
            } catch (error) {
                console.error(`Error generating image for guess "${guessData.guess}":`, error.message);
                continue;
            }
        }

        // If we couldn't generate any images, inform the users
        if (generatedImages.length === 0) {
            throw new Error('No images to vote on');
        }

        // Store the generated images in the game state
        game.generatedImages = generatedImages;
        
        // Start the voting phase
        startVoting(roomCode);
    } catch (error) {
        console.error('Error in image generation process:', error.message, error.stack);
        io.to(roomCode).emit('error', 'Failed to generate images');
        
        // Skip to next turn
        startTurn(roomCode);
    }
}

function startVoting(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    game.voting = true;
    game.votes = new Map(); // Reset votes
    
    // Send all generated images to clients for voting
    io.to(roomCode).emit('startVoting', game.generatedImages);
    
    game.votingTimerEnd = Date.now() + 20000;
    game.votingTimer = setTimeout(() => tallyVotes(roomCode), 20000);
    
    // Start the voting timer on all clients
    io.to(roomCode).emit('startTimer', 20);
}

function tallyVotes(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    game.voting = false;
    
    // Count votes for each image
    const voteCount = new Map();
    game.generatedImages.forEach(image => {
        voteCount.set(image.playerId, 0);
    });
    
    // Tally up the votes
    game.votes.forEach((imagePlayerId, voterId) => {
        if (voteCount.has(imagePlayerId)) {
            voteCount.set(imagePlayerId, voteCount.get(imagePlayerId) + 1);
        }
    });
    
    // Find the winner(s)
    let maxVotes = 0;
    const winners = [];
    
    voteCount.forEach((votes, playerId) => {
        if (votes > maxVotes) {
            maxVotes = votes;
            winners.length = 0;
            winners.push(playerId);
        } else if (votes === maxVotes && maxVotes > 0) {
            winners.push(playerId);
        }
    });
    
    // Award points to winners
    let resultMessage = '';
    if (winners.length > 0 && maxVotes > 0) {
        winners.forEach(winnerId => {
            game.players.get(winnerId).score += 1;
        });
        
        if (winners.length === 1) {
            const winnerName = game.players.get(winners[0]).username;
            resultMessage = `${winnerName}'s image won with ${maxVotes} votes! They get a point!`;
        } else {
            const winnerNames = winners.map(id => game.players.get(id).username).join(', ');
            resultMessage = `Tie! ${winnerNames} each get a point with ${maxVotes} votes!`;
        }
    } else {
        resultMessage = `No votes or tie with 0 votes. No points awarded.`;
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

// Function to clean up old generated images
function cleanupOldImages() {
    const dir = path.join(__dirname, 'public', 'generated');
    
    // Ensure the directory exists before trying to read it
    if (!fs.existsSync(dir)) {
        return;
    }
    
    fs.readdir(dir, (err, files) => {
        if (err) {
            console.error('Error reading generated directory:', err);
            return;
        }
        
        const now = Date.now();
        files.forEach(file => {
            if (!file.startsWith('generated-')) return; // Only process our generated files
            
            const filePath = path.join(dir, file);
            fs.stat(filePath, (err, stats) => {
                if (err) {
                    console.error(`Error stat'ing file ${filePath}:`, err);
                    return;
                }
                
                // Delete files older than 24 hours
                if (now - stats.mtimeMs > 24 * 60 * 60 * 1000) {
                    fs.unlink(filePath, err => {
                        if (err) {
                            console.error(`Error deleting file ${filePath}:`, err);
                        } else {
                            console.log(`Cleaned up old image: ${filePath}`);
                        }
                    });
                }
            });
        });
    });
}

// Run the cleanup every hour
setInterval(cleanupOldImages, 60 * 60 * 1000);

server.listen(port, () => console.log(`Server running on port ${port}`));