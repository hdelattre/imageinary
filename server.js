const express = require('express');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const http = require('http');
const { v4: uuidv4 } = require('uuid');

// Import shared configuration and validation
const CONFIG = require('./public/shared-config');

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
const publicRooms = new Map(); // Stores public room data for listing

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

    socket.on('createRoom', (username, customPrompt, isPublic = false) => {
        username = sanitizeMessage(username, '');
        
        const roomCode = uuidv4().slice(0, 6).toUpperCase();
        socket.join(roomCode);
        
        // Initialize the game
        initializeGame(roomCode, socket.id, username, isPublic);
        
        // Store custom prompt if provided
        if (customPrompt) {
            const game = games.get(roomCode);
            // Validate the prompt
            const validation = CONFIG.validatePrompt(customPrompt);
            if (validation.valid) {
                // Sanitize the validated prompt
                game.customPrompt = sanitizeMessage(validation.prompt, './!?-,\'');
            }
        }
        
        // If room is public, add it to the public rooms list
        if (isPublic) {
            updatePublicRoomsList(roomCode);
        }
        
        socket.emit('roomCreated', { roomCode, username, inviteLink: `http://localhost:${port}/?room=${roomCode}`, isPublic });
    });
    
    // Set up rate limiting for public rooms requests
    const publicRoomsRefreshRates = new Map(); // socketId -> last refresh time
    const REFRESH_COOLDOWN = 3000; // 3 seconds minimum between refreshes
    
    // Add endpoint to get public rooms
    socket.on('getPublicRooms', () => {
        const now = Date.now();
        const lastRefresh = publicRoomsRefreshRates.get(socket.id) || 0;
        
        // Rate limit refreshes
        if (now - lastRefresh < REFRESH_COOLDOWN) {
            console.log(`Rate limiting public rooms request from ${socket.id}`);
            // Don't respond to too-frequent requests
            return;
        }
        
        // Update last refresh time
        publicRoomsRefreshRates.set(socket.id, now);
        
        const roomsList = Array.from(publicRooms.values());
        socket.emit('publicRoomsList', roomsList);
    });
    
    // Endpoint to get a room's prompt
    socket.on('getRoomPrompt', (roomCode) => {
        const game = games.get(roomCode);
        if (game) {
            // Check if this socket is the host (first player)
            const players = Array.from(game.players.keys());
            const isHost = players.length > 0 && players[0] === socket.id;
            
            // Return the prompt and host status in one response
            socket.emit('roomPrompt', {
                prompt: game.customPrompt,
                isHost: isHost
            });
        }
    });
    
    // Endpoint to update a room's prompt
    socket.on('updateRoomPrompt', ({ roomCode, prompt }) => {
        const game = games.get(roomCode);
        if (game) {
            // Verify this is the host
            const players = Array.from(game.players.keys());
            const isHost = players.length > 0 && players[0] === socket.id;
            
            if (isHost) {
                // Validate the prompt
                const validation = CONFIG.validatePrompt(prompt);
                if (validation.valid) {
                    // Update the custom prompt with the validated prompt
                    game.customPrompt = sanitizeMessage(validation.prompt, './!?-,\'');
                    console.log(`Room ${roomCode} prompt updated by host`);
                    
                    // If this is a public room, update the public room list
                    if (game.isPublic) {
                        updatePublicRoomsList(roomCode);
                    }
                } else {
                    console.log(`Invalid prompt submitted by host in room ${roomCode}: ${validation.error}`);
                }
            }
        }
    });
    
    socket.on('testGenerateImage', async ({ drawingData, guess, promptTemplate }) => {
        try {
            // Extract base64 string from data URL
            const base64Data = drawingData.split(',')[1];
            if (!base64Data) {
                socket.emit('testImageResult', { error: 'Invalid drawing data' });
                return;
            }
            
            // Validate the prompt template
            const validation = CONFIG.validatePrompt(promptTemplate);
            if (!validation.valid) {
                socket.emit('testImageResult', { error: 'Invalid prompt template: ' + validation.error });
                return;
            }
            // Use the validated prompt (might have been trimmed)
            promptTemplate = validation.prompt;
            
            const generationPrompt = promptTemplate.replace('{guess}', guess);
            
            // Send request to the model
            const response = await model.generateContent([
                generationPrompt,
                { inlineData: { data: base64Data, mimeType: 'image/png' } },
            ]);
            
            if (response.response.candidates.length === 0) {
                socket.emit('testImageResult', { error: 'No candidates returned by the model' });
                return;
            }
            
            // Extract the generated image
            const candidate = response.response.candidates[0];
            
            if (candidate.finishReason === 'RECITATION') {
                socket.emit('testImageResult', { error: 'Model rejected input' });
                return;
            }
            
            if (!candidate || !candidate.content || !candidate.content.parts) {
                socket.emit('testImageResult', { error: 'Invalid response from model' });
                return;
            }
            
            const imagePart = candidate.content.parts.find(part => part.inlineData);
            if (!imagePart || !imagePart.inlineData || !imagePart.inlineData.data) {
                socket.emit('testImageResult', { error: 'No image data found in response' });
                return;
            }
            
            const imageData = imagePart.inlineData.data;
            const buffer = Buffer.from(imageData, 'base64');
            
            // Generate a unique filename for the test image
            const testId = Date.now().toString();
            const filename = `test-${testId}.png`;
            const filePath = path.join(__dirname, 'public', 'generated', filename);
            
            // Ensure the directory exists
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, buffer);
            
            // Send back the image URL
            socket.emit('testImageResult', { 
                imageSrc: `/generated/${filename}`,
                success: true
            });
            
        } catch (error) {
            console.error('Error generating test image:', error);
            socket.emit('testImageResult', { error: 'Failed to generate image: ' + error.message });
        }
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
            
            // Reset emptiness timestamp since we have a new player
            game.emptyRoomTimestamp = null;
            
            // Check if room had only one player before this join, and reset that timestamp if needed
            if (game.players.size >= 2 && game.singlePlayerTimestamp !== null) {
                // At least 2 players now (including this new one), so reset single player timestamp
                game.singlePlayerTimestamp = null;
            }
            
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
            
            // Update public rooms list if this is a public room
            if (game.isPublic) {
                updatePublicRoomsList(roomCode);
            }
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
        if (game) {
            // Allow drawer to send messages if in voting phase, otherwise continue blocking
            if (socket.id === game.currentDrawer && !game.voting) {
                return; // Drawer can't chat during drawing phase
            }
            
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
        // Clean up player from games
        games.forEach((game, roomCode) => {
            if (game.players.has(socket.id)) {
                // Store this info before removing the player
                const wasDrawer = game.currentDrawer === socket.id;
                
                // Now remove the player
                game.players.delete(socket.id);
                
                // Check player count after removal
                if (game.players.size === 0) {
                    // Set the empty room timestamp instead of immediately deleting
                    game.emptyRoomTimestamp = Date.now();
                    
                    // For public rooms in immediate cleanup mode, remove immediately
                    if (!game.isPublic) {
                        // For private rooms, allow cleanup to handle it
                        console.log(`Room ${roomCode} is now empty. Will expire in 60 seconds if no one joins.`);
                    } else {
                        console.log(`Public room ${roomCode} is now empty. Will expire in 30 seconds if no one joins.`);
                    }
                } else if (game.players.size === 1 && game.isPublic) {
                    // Public room with only one player remaining
                    game.singlePlayerTimestamp = Date.now();
                    console.log(`Public room ${roomCode} now has only 1 player. Will expire in 15 minutes if it stays that way.`);
                } else {
                    // Reset single player timestamp if we have more players
                    game.singlePlayerTimestamp = null;
                }
                
                // If the drawer left and there are still players, start a new turn
                if (wasDrawer && game.players.size > 0) {
                    nextTurn(roomCode);
                }
                
                // Update game state for remaining players if there are any
                if (game.players.size > 0) {
                    updateGameState(roomCode);
                }
                
                // Update public rooms list if this is a public room
                if (game.isPublic) {
                    updatePublicRoomsList(roomCode);
                }
            }
        });
        
        // Clean up rate limiting data
        publicRoomsRefreshRates.delete(socket.id);
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

function initializeGame(roomCode, socketId, username, isPublic = false) {
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
        isPublic: isPublic,
        createdAt: Date.now(),
        emptyRoomTimestamp: null,     // Track when the room becomes empty
        singlePlayerTimestamp: null,  // Track when the room has only one player
        // Default AI generation prompt template
        customPrompt: CONFIG.DEFAULT_PROMPT
    });
    
    // If it's a public room, add it to the public rooms list
    if (isPublic) {
        updatePublicRoomsList(roomCode);
    }
    
    // For a new room with a single player, set the single player timestamp
    if (isPublic) {
        games.get(roomCode).singlePlayerTimestamp = Date.now();
    }
    
    startTurn(roomCode);
}

function startTurn(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;
    
    // Check if there are any players in the game
    if (game.players.size === 0) {
        console.log(`No players in room ${roomCode}, can't start turn`);
        return;
    }

    game.voting = false;
    game.votes.clear();
    game.chatHistory = [];
    game.lastMessages.clear();
    game.imageSrc = '';
    
    // Clear the current drawing data
    drawings.set(roomCode, '');
    
    const players = Array.from(game.players.keys());
    game.currentDrawer = players[(game.round - 1) % players.length];
    
    // Verify that the drawer exists in the player list
    if (!game.players.has(game.currentDrawer)) {
        console.log(`Current drawer ${game.currentDrawer} not found in players list, selecting new drawer`);
        // Select a new drawer if the current one doesn't exist
        if (players.length > 0) {
            game.currentDrawer = players[0];
        } else {
            console.log(`No players available in room ${roomCode}`);
            return;
        }
    }
    
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
    
    // Check if we have at least 2 players and valid guesses before generating images
    if (game.players.size >= 2 && game.lastMessages.size > 0) {
        generateNewImage(roomCode);
    } else {
        console.log(`Room ${roomCode} has insufficient players or guesses to generate images`);
        // Skip to next turn if we can't generate images
        game.round++;
        startTurn(roomCode);
    }
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
            // Make sure the player still exists in the game
            if (guess && playerId !== game.currentDrawer && game.players.has(playerId)) {
                guessesWithPlayers.push({
                    playerId,
                    playerName: game.players.get(playerId).username,
                    guess
                });
            }
        });

        // No guesses or insufficient players, skip to next turn
        if (guessesWithPlayers.length === 0 || game.players.size < 2) {
            console.log(`Room ${roomCode}: No valid guesses or not enough players. Skipping image generation.`);
            // Move to next turn instead of throwing error
            game.round++;
            startTurn(roomCode);
            return; // Exit the function
        }

        // Generate images for each guess
        const generatedImages = [];
        for (const guessData of guessesWithPlayers) {
            // Use custom prompt template if available, otherwise use default
            const promptTemplate = game.customPrompt || 
                "Make this pictionary sketch look hyperrealistic but also stay faithful to the borders and shapes in the sketch even if it looks weird. It must look like the provided sketch! Do not modify important shapes/silhouettes in the sketch, just fill them in. Make it look like the provided guess: {guess}";
            
            // Replace the placeholder with the actual guess
            const generationPrompt = promptTemplate.replace('{guess}', guessData.guess);
            
            try {
                // Send request to the model
                const response = await model.generateContent([
                    generationPrompt,
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
        game.round++;
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
    
    // Calculate total voters (excluding the drawer)
    const totalVoters = game.players.size - 1;
    
    // Find the winner(s) - now requiring > 50% of votes, not just the most votes
    let winners = [];
    
    voteCount.forEach((votes, playerId) => {
        // Check if player got more than 50% of votes
        if (votes > totalVoters / 2) {
            winners.push(playerId);
        }
    });
    
    // Award points to winners
    let resultMessage = '';
    if (winners.length > 0) {
        winners.forEach(winnerId => {
            game.players.get(winnerId).score += 1;
        });
        
        // Get vote counts for the message
        const winnerVotes = new Map();
        winners.forEach(winnerId => {
            winnerVotes.set(winnerId, voteCount.get(winnerId));
        });
        
        if (winners.length === 1) {
            const winnerName = game.players.get(winners[0]).username;
            const votes = voteCount.get(winners[0]);
            resultMessage = `${winnerName}'s image won with ${votes} votes! They get a point!`;
        } else {
            const winnersList = winners.map(id => 
                `${game.players.get(id).username} (${voteCount.get(id)} votes)`
            ).join(', ');
            resultMessage = `Multiple winners! ${winnersList} each get a point!`;
        }
    } else {
        resultMessage = `No image received more than 50% of votes. No points awarded.`;
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
    
    // Ensure we have players
    if (game.players.size === 0) {
        console.log(`No players in room ${roomCode} to update game state`);
        return;
    }

    const players = Array.from(game.players.entries()).map(([id, data]) => ({
        id,
        username: data.username,
        score: data.score,
        color: data.color,
    }));
    
    // Ensure we have a valid drawer
    if (!game.currentDrawer || !game.players.has(game.currentDrawer)) {
        // If drawer is invalid, select first player
        const firstPlayer = Array.from(game.players.keys())[0];
        game.currentDrawer = firstPlayer;
        console.log(`Invalid drawer, selecting new drawer: ${firstPlayer}`);
    }

    io.to(roomCode).emit('gameState', {
        players,
        currentDrawer: game.currentDrawer,
        round: game.round,
        voting: game.voting,
    });
}

// Function to update the public rooms list
function updatePublicRoomsList(roomCode) {
    const game = games.get(roomCode);
    if (!game || !game.isPublic) return;
    
    // Check if the game has any players before trying to access their data
    const players = Array.from(game.players.values());
    const hostName = players.length > 0 ? players[0].username : "Unknown Host";
    
    // Create a summary of the room for the public listing
    const roomInfo = {
        roomCode,
        playerCount: game.players.size,
        round: game.round,
        createdAt: game.createdAt,
        hostName: hostName,
        prompt: game.customPrompt
    };
    
    publicRooms.set(roomCode, roomInfo);
}

// Function to clean up rooms based on the new expiration rules
function cleanupRooms() {
    const now = Date.now();
    const privateRoomExpiryMs = 60 * 1000;         // 60 seconds for empty private rooms
    const publicRoomEmptyExpiryMs = 30 * 1000;     // 30 seconds for empty public rooms
    const publicRoomSinglePlayerExpiryMs = 15 * 60 * 1000;  // 15 minutes for single-player public rooms
    
    // Check all games for potential cleanup
    games.forEach((game, roomCode) => {
        // Empty room cleanup
        if (game.emptyRoomTimestamp !== null) {
            const emptyDuration = now - game.emptyRoomTimestamp;
            
            // Different expiry times for public vs private rooms
            const expiryTime = game.isPublic ? publicRoomEmptyExpiryMs : privateRoomExpiryMs;
            
            if (emptyDuration > expiryTime) {
                console.log(`Room ${roomCode} has been empty for ${Math.floor(emptyDuration/1000)} seconds. Removing.`);
                games.delete(roomCode);
                drawings.delete(roomCode);
                publicRooms.delete(roomCode);
                return; // Skip further checks for this room
            }
        }
        
        // Single player public room cleanup (only applies to public rooms)
        if (game.isPublic && game.singlePlayerTimestamp !== null && game.players.size === 1) {
            const singlePlayerDuration = now - game.singlePlayerTimestamp;
            
            if (singlePlayerDuration > publicRoomSinglePlayerExpiryMs) {
                console.log(`Public room ${roomCode} has had only 1 player for ${Math.floor(singlePlayerDuration/60000)} minutes. Removing.`);
                
                // Notify the last player before removing the room
                const lastPlayerId = Array.from(game.players.keys())[0];
                io.to(lastPlayerId).emit('error', 'This room has expired due to inactivity. Please create or join a new room.');
                
                games.delete(roomCode);
                drawings.delete(roomCode);
                publicRooms.delete(roomCode);
                return; // Skip further checks for this room
            }
        }
        
        // For rooms that still exist, update public listing
        if (game.isPublic && publicRooms.has(roomCode)) {
            // Get current players to check for host name
            const players = Array.from(game.players.values());
            const hostName = players.length > 0 ? players[0].username : "Unknown Host";
            
            const roomInfo = publicRooms.get(roomCode);
            roomInfo.playerCount = game.players.size;
            roomInfo.round = game.round;
            roomInfo.hostName = hostName; // Make sure host name is updated if host changes
            publicRooms.set(roomCode, roomInfo);
        }
    });
    
    // Clean up any orphaned public room entries (where the game no longer exists)
    publicRooms.forEach((roomInfo, roomCode) => {
        if (!games.has(roomCode)) {
            publicRooms.delete(roomCode);
        }
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
// Run the rooms cleanup every 15 seconds
setInterval(cleanupRooms, 15 * 1000);

server.listen(port, () => console.log(`Server running on port ${port}`));