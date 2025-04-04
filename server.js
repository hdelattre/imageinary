const express = require('express');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const geminiService = require('./geminiService');
const promptBuilder = require('./promptBuilder');

// Import shared configuration and validation
const PROMPT_CONFIG = require('./public/shared-config');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

// Initialize Gemini service with API key
geminiService.initializeGeminiService(process.env.GEMINI_API_KEY);

// In-memory storage
const games = new Map(); // roomCode -> gameData
const drawings = new Map(); // roomCode -> drawingData
const lastMessageTimes = new Map(); // Tracks last message time per player
const publicRooms = new Map(); // Stores public room data for listing

// User consts
const MAX_USERNAME_LENGTH = 24;
const MAX_AI_NAME_LENGTH = 20;

// Predefined prompts for the drawer
const prompts = [
    "cat", "dog", "house", "tree", "car", "sun", "moon", "star", "flower", "boat",
    "airplane", "bicycle", "book", "chair", "computer", "door", "window", "table", "shoe", "hat"
];

// AI player configuration
const AI_PLAYER_PREFIX = "🤖 ";
const AI_PLAYER_COLORS = [
    "#3498db", // Blue
    "#2ecc71", // Green
    "#e74c3c", // Red
    "#9b59b6", // Purple
    "#f39c12", // Orange
    "#1abc9c", // Teal
];
const AI_NAMES = [
    "Rusty", "Velgorath", "Spritz", "Junebug", "Flarp", "Tango", "Zorn", "Pippin",
    "Klyster", "Moxie", "Brontz", "Slyvie", "Cinder", "Raxus", "Twitch", "Larkspur",
    "Gizmo", "Vex", "Saffron", "Drifty", "Korvax", "Blitz"
];

// AI player timing configuration
const aiTiming = {
    minGuessTime: 4000,      // 4 seconds
    maxGuessTime: 12000,     // 12 seconds
    guessInterval: 30000,    // 30 seconds between guesses
    lastChanceTime: 10000,   // 10 seconds left
    drawingTime: 3000,       // 3 seconds to create drawing
    chatProbability: 0.4     // 40% chance of sending a chat message
};

// Game configuration
const roundDuration = 45; // seconds

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function isSocketRoomHost(game, socketId) {
    const players = Array.from(game.players.keys());
    return players.length > 0 && players[0] === socketId;
}

io.on('connection', (socket) => {
    console.log('Player connected:', socket.id);

    // Add an AI player to the room
    socket.on('addAIPlayer', (data) => {
        // Handle both string roomCode and object with personality
        let roomCode, personality;
        if (typeof data === 'string') {
            roomCode = data;
            personality = null;
        } else {
            roomCode = data.roomCode;
            personality = data.personality;
        }

        const game = games.get(roomCode);

        // Check if the room exists and the requester is the host
        if (!game) {
            socket.emit('error', 'Room not found');
            return;
        }

        if (!isSocketRoomHost(game, socket.id)) {
            socket.emit('error', 'Only the host can add AI players');
            return;
        }

        // Check AI player limit using shared configuration
        if (game.aiPlayers.size >= PROMPT_CONFIG.MAX_AI_PLAYERS) {
            socket.emit('error', `Maximum of ${PROMPT_CONFIG.MAX_AI_PLAYERS} AI players allowed per room`);
            return;
        }

        // Create AI player with personality if provided
        let aiPlayerId = createAIPlayer(roomCode, personality);

        if (aiPlayerId) {
            // Update game state for all players
            updateGameState(roomCode);

            // Update public rooms list if this is a public room
            if (game.isPublic) {
                updatePublicRoomsList(roomCode);
            }
        }
    });

    // Remove the last AI player added to the room
    socket.on('removeLastAIPlayer', (roomCode) => {
        const game = games.get(roomCode);
        if (!game) {
            socket.emit('error', 'Room not found');
            return;
        }

        if (!isSocketRoomHost(game, socket.id) || game.aiPlayers.size === 0) {
            socket.emit('error', 'Only the host can remove AI players');
            return;
        }

        // Get the last AI player ID in the room
        const aiPlayersList = Array.from(game.aiPlayers.keys());
        const lastAiPlayerId = aiPlayersList[aiPlayersList.length - 1];

        removeAIPlayer(roomCode, lastAiPlayerId);
    });

    // Remove an AI player from the room by ID
    socket.on('removeAIPlayer', ({ roomCode, aiPlayerId }) => {
        const game = games.get(roomCode);
        if (!game) {
            socket.emit('error', 'Room not found');
            return;
        }

        if (!isSocketRoomHost(game, socket.id) || !game.aiPlayers.has(aiPlayerId)) {
            socket.emit('error', 'Only the host can remove AI players');
            return;
        }

        removeAIPlayer(roomCode, aiPlayerId);
    });

    socket.on('createRoom', (username, customPrompt, isPublic = false) => {
        username = sanitizeMessage(username, '', 24);

        const roomCode = uuidv4().slice(0, 6).toUpperCase();
        socket.join(roomCode);

        console.log(`Room ${roomCode}| Created by ${username}, isPublic: ${isPublic}`);

        // Initialize the game
        createRoom(roomCode, isPublic);
        const game = games.get(roomCode);

        addPlayer(game, socket.id, username);

        // Store custom prompt if provided
        if (customPrompt) {
            // Validate the prompt
            customPrompt = sanitizeMessage(customPrompt, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
            const validation = PROMPT_CONFIG.validatePrompt(customPrompt);
            if (validation.valid) {
                game.customPrompt = customPrompt;
            }
        }

        // If room is public, add it to the public rooms list
        if (isPublic) {
            updatePublicRoomsList(roomCode);
        }

        socket.emit('roomCreated', { roomCode, username, inviteLink: `http://localhost:${port}/?room=${roomCode}`, isPublic });

        sendSystemMessage("TIP: Use /g followed by your guess to submit a guess that will be used for image generation. Regular chat messages won't be used for generating images.")

        startGame(roomCode);
    });

    // Set up rate limiting
    const publicRoomsRefreshRates = new Map(); // socketId -> last refresh time
    const imageGenerationTimes = new Map(); // socketId -> last image generation time
    const REFRESH_COOLDOWN = 3000; // 3 seconds minimum between refreshes
    const IMAGE_GEN_COOLDOWN = 8000; // 8 seconds between image generation requests

    // Add endpoint to get public rooms
    socket.on('getPublicRooms', () => {
        const now = Date.now();
        const lastRefresh = publicRoomsRefreshRates.get(socket.id) || 0;

        // Rate limit refreshes
        if (now - lastRefresh < REFRESH_COOLDOWN) {
            console.log(`Rate limit: Blocking public rooms request from ${socket.id}`);
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
        if (!game) return;
        // Check if this socket is the host (first player)
        const players = Array.from(game.players.keys());
        const isHost = players.length > 0 && players[0] === socket.id;

        // Return the prompt and host status in one response
        socket.emit('roomPrompt', {
            prompt: game.customPrompt,
            isHost: isHost
        });
    });

    // Endpoint to update a room's prompt
    socket.on('updateRoomPrompt', ({ roomCode, prompt }) => {
        const game = games.get(roomCode);
        if (!game) return;
        // Verify this is the host
        const players = Array.from(game.players.keys());
        const isHost = players.length > 0 && players[0] === socket.id;

        if (isHost) {
            // Validate the prompt
            prompt = sanitizeMessage(prompt, PROMPT_CONFIG.VALID_CHARS);
            const validation = PROMPT_CONFIG.validatePrompt(prompt);
            if (validation.valid) {
                // Update the custom prompt with the validated prompt
                game.customPrompt = prompt;
                console.log(`Room ${roomCode}| Prompt updated by host: ${game.customPrompt}`);

                // If this is a public room, update the public room list
                if (game.isPublic) {
                    updatePublicRoomsList(roomCode);
                }
            } else {
                console.log(`Room ${roomCode}| Invalid prompt submitted by host - ${validation.error}`);
            }
        }
    });

    socket.on('testGenerateImage', async ({ drawingData, guess, promptTemplate }) => {
        try {
            // Rate limiting check
            const now = Date.now();
            const lastGenTime = imageGenerationTimes.get(socket.id) || 0;

            // If the user has generated an image too recently, reject the request
            if (now - lastGenTime < IMAGE_GEN_COOLDOWN) {
                const waitTimeSeconds = Math.ceil((IMAGE_GEN_COOLDOWN - (now - lastGenTime)) / 1000);
                socket.emit('testImageResult', {
                    error: `Please wait ${waitTimeSeconds} second${waitTimeSeconds !== 1 ? 's' : ''} before requesting another image.`
                });
                return;
            }

            // Update the last generation time
            imageGenerationTimes.set(socket.id, now);

            // Validate the prompt template
            promptTemplate = sanitizeMessage(promptTemplate, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
            const validation = PROMPT_CONFIG.validatePrompt(promptTemplate);
            if (!validation.valid) {
                socket.emit('testImageResult', { error: 'Invalid prompt template: ' + validation.error });
                return;
            }

            const generationPrompt = promptBuilder.buildImageGenerationPrompt(guess, promptTemplate);

            const result = await geminiService.requestGeminiResponse(generationPrompt, drawingData);

            const imageData = result.imageData;
            if (!imageData) {
                throw new Error('No image data returned from Gemini API');
            }

            const buffer = Buffer.from(imageData, 'base64');

            // Generate a unique filename for the test image
            const testId = Date.now().toString();
            const filename = `test-${testId}.png`;
            const filePath = path.join(__dirname, 'public', 'generated', filename);

            // Ensure the directory exists
            fs.mkdirSync(path.dirname(filePath), { recursive: true });
            fs.writeFileSync(filePath, buffer);

            // Send back the image URL and any text generated
            socket.emit('testImageResult', {
                imageSrc: `/generated/${filename}`,
                text: result.text || '',
                success: true
            });

        } catch (error) {
            console.error('Error generating test image:', error);
            socket.emit('testImageResult', { error: 'Failed to generate image: ' + error.message });
        }
    });

    socket.on('joinRoom', ({ roomCode, username }) => {
        username = sanitizeMessage(username, '', MAX_USERNAME_LENGTH);

        if (games.has(roomCode)) {
            socket.join(roomCode);
            const game = games.get(roomCode);

            let uniqueUsername = username;
            let counter = 2;
            while (Array.from(game.players.values()).some(p => p.username === uniqueUsername)) {
                uniqueUsername = `${username}(${counter})`;
                counter++;
            }

            addPlayer(game, socket.id, uniqueUsername);

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

            // Send chat history to the new player
            game.chatHistory.forEach(msg => {
                if (msg.playerId) {
                    // Regular player message
                    socket.emit('newMessage', {
                        username: msg.username,
                        message: msg.message,
                        timestamp: msg.timestamp,
                        color: msg.color,
                        isGuess: msg.isGuess
                    });
                } else {
                    // System message
                    socket.emit('systemMessage', {
                        message: msg.message,
                        timestamp: msg.timestamp
                    });
                }
            });

            // Sync the timer for the new player
            if (game.timerEnd > Date.now()) {
                // If we're in drawing phase
                const remainingSeconds = Math.ceil((game.timerEnd - Date.now()) / 1000);
                if (remainingSeconds > 0) {
                    socket.emit('startDisplayTimer', remainingSeconds);
                }
            } else if (game.votingTimerEnd > Date.now()) {
                // If we're in voting phase
                const remainingSeconds = Math.ceil((game.votingTimerEnd - Date.now()) / 1000);
                if (remainingSeconds > 0) {
                    socket.emit('startDisplayTimer', remainingSeconds);
                }
            }

            updateGameState(roomCode);

            // Send help message about the /g command
            sendSystemMessage(roomCode, "TIP: Use /g followed by your guess to submit a guess that will be used for image generation. Regular chat messages won't be used for generating images.");

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

        // Process drawing update for AI players
        handleAIPlayerDrawingUpdate(roomCode, drawingData);
    });

    socket.on('sendMessage', ({ roomCode, message }) => {
        const game = games.get(roomCode);
        if (!game) return;
        // Allow drawer to send messages if in voting phase, otherwise continue blocking
        if (socket.id === game.currentDrawer && !game.voting) {
            return; // Drawer can't chat during drawing phase
        }

        const now = Date.now();
        const lastTime = lastMessageTimes.get(socket.id) || 0;

        // Spam control: 1 message/sec
        if (now - lastTime < 1000) return;
        lastMessageTimes.set(socket.id, now);

        message = sanitizeMessage(message, '/.?!');

        let displayMessage = message;
        // Check if this is a guess command (/g)
        const isGuess = message.startsWith('/g');
        if (isGuess) {
            // Find the first whitespace and remove everything up to and including it
            const firstSpaceIndex = message.indexOf(' ');
            if (firstSpaceIndex !== -1) {
                displayMessage = message.substring(firstSpaceIndex + 1).trim();
            } else {
                // No guess to send
                return;
            }
        }
        else if (message.startsWith('/')) {
            // Ignore invalid command
            return;
        }

        sendPlayerMessage(roomCode, socket.id, displayMessage, isGuess);
    });

    socket.on('vote', ({ roomCode, imagePlayerId }) => {
        setPlayerVote(roomCode, socket.id, imagePlayerId);
    });

    // AI Personality Editor endpoints
    socket.on('getAIPlayers', (roomCode) => {
        const game = games.get(roomCode);
        if (!game) {
            socket.emit('error', 'Room not found');
            return;
        }

        // Check if the requester is the host
        if (!isSocketRoomHost(game, socket.id)) {
            socket.emit('error', 'Only the host can manage AI players');
            return;
        }

        // Create a list of AI players with their data
        const aiPlayersList = [];
        game.aiPlayers.forEach((aiData, aiPlayerId) => {
            const playerData = game.players.get(aiPlayerId);
            if (playerData) {
                aiPlayersList.push({
                    id: aiPlayerId,
                    username: playerData.username,
                    color: playerData.color,
                    corePersonalityPrompt: aiData.corePersonalityPrompt,
                    chatPrompt: aiData.chatPrompt,
                    guessPrompt: aiData.guessPrompt
                });
            }
        });

        // Send the list to the client
        socket.emit('aiPlayersList', { aiPlayers: aiPlayersList });
    });

    // Update AI player personality
    socket.on('updateAIPlayer', ({ roomCode, aiPlayerId, corePersonalityPrompt, chatPrompt, guessPrompt }) => {
        const game = games.get(roomCode);
        if (!game) {
            socket.emit('aiPlayerUpdated', { success: false, error: 'Room not found' });
            return;
        }

        // Check if the requester is the host
        if (!isSocketRoomHost(game, socket.id)) {
            socket.emit('aiPlayerUpdated', { success: false, error: 'Only the host can update AI players' });
            return;
        }

        // Check if the AI player exists
        if (!game.aiPlayers.has(aiPlayerId)) {
            socket.emit('aiPlayerUpdated', { success: false, error: 'AI player not found' });
            return;
        }

        // Update the AI player's prompts
        const aiData = game.aiPlayers.get(aiPlayerId);

        // For core personality prompt
        if (corePersonalityPrompt) {
            const sanitized = sanitizeMessage(corePersonalityPrompt, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
            // Check if it matches the default (null it if it does)
            if (sanitized === PROMPT_CONFIG.CORE_PERSONALITY_PROMPT) {
                aiData.corePersonalityPrompt = null;
            } else {
                aiData.corePersonalityPrompt = sanitized;
            }
        }

        // For chat prompt
        if (chatPrompt) {
            const sanitized = sanitizeMessage(chatPrompt, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
            // Check if it matches the default (null it if it does)
            if (sanitized === promptBuilder.DEFAULT_CHAT_PROMPT) {
                aiData.chatPrompt = null;
            } else {
                aiData.chatPrompt = sanitized;
            }
        }

        // For guess prompt
        if (guessPrompt) {
            const sanitized = sanitizeMessage(guessPrompt, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
            // Check if it matches the default (null it if it does)
            if (sanitized === PROMPT_CONFIG.GUESS_PROMPT) {
                aiData.guessPrompt = null;
            } else {
                aiData.guessPrompt = sanitized;
            }
        }

        console.log(`Room ${roomCode}| AI player ${aiPlayerId} personality updated`);

        // Send success response
        socket.emit('aiPlayerUpdated', { success: true });
    });

    // Create new AI player with custom personality
    socket.on('createAIPlayer', ({ roomCode, name, chatPrompt, guessPrompt, corePersonalityPrompt }) => {
        const game = games.get(roomCode);
        if (!game) {
            socket.emit('aiPlayerCreated', { success: false, error: 'Room not found' });
            return;
        }

        // Check if the requester is the host
        if (!isSocketRoomHost(game, socket.id)) {
            socket.emit('aiPlayerCreated', { success: false, error: 'Only the host can create AI players' });
            return;
        }

        // Check AI player limit using shared configuration
        if (game.aiPlayers.size >= PROMPT_CONFIG.MAX_AI_PLAYERS) {
            socket.emit('aiPlayerCreated', {
                success: false,
                error: `Maximum of ${PROMPT_CONFIG.MAX_AI_PLAYERS} AI players allowed per room`
            });
            return;
        }

        try {
            // Sanitize the name
            const sanitizedName = sanitizeMessage(name, '', MAX_AI_NAME_LENGTH);

            // Handle chat prompt - set to null if it matches default
            let sanitizedChatPrompt = null;
            if (chatPrompt) {
                const sanitized = sanitizeMessage(chatPrompt, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
                if (sanitized !== promptBuilder.DEFAULT_CHAT_PROMPT) {
                    sanitizedChatPrompt = sanitized;
                }
            }

            // Handle guess prompt - set to null if it matches default
            let sanitizedGuessPrompt = null;
            if (guessPrompt) {
                const sanitized = sanitizeMessage(guessPrompt, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
                if (sanitized !== PROMPT_CONFIG.GUESS_PROMPT) {
                    sanitizedGuessPrompt = sanitized;
                }
            }

            // Handle core personality - set to null if it matches default
            let sanitizedCorePrompt = null;
            if (corePersonalityPrompt) {
                const sanitized = sanitizeMessage(corePersonalityPrompt, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
                if (sanitized !== PROMPT_CONFIG.CORE_PERSONALITY_PROMPT) {
                    sanitizedCorePrompt = sanitized;
                }
            }

            // Create the AI player with custom properties
            const personality = {
                name: sanitizedName,
                chatPrompt: sanitizedChatPrompt,
                guessPrompt: sanitizedGuessPrompt,
                corePersonalityPrompt: sanitizedCorePrompt
            };
            const aiPlayerId = createAIPlayer(roomCode, personality);

            if (aiPlayerId) {
                // Update game state for all players
                updateGameState(roomCode);

                // Update public rooms list if this is a public room
                if (game.isPublic) {
                    updatePublicRoomsList(roomCode);
                }

                // Send success response
                socket.emit('aiPlayerCreated', {
                    success: true,
                    aiPlayerId,
                    name: game.players.get(aiPlayerId).username
                });
            } else {
                socket.emit('aiPlayerCreated', { success: false, error: 'Failed to create AI player' });
            }
        } catch (error) {
            console.error(`Error creating AI player: ${error.message}`);
            socket.emit('aiPlayerCreated', { success: false, error: 'Internal server error' });
        }
    });

    socket.on('disconnect', () => {
        // Clean up player from games
        games.forEach((game, roomCode) => {
            if (game.players.has(socket.id)) {
                // Store this info before removing the player
                const wasDrawer = game.currentDrawer === socket.id;
                const wasHost = Array.from(game.players.keys())[0] === socket.id;

                // Now remove the player
                game.players.delete(socket.id);

                // Get count of real human players (non-AI)
                const humanPlayerCount = game.players.size - game.aiPlayers.size;

                // Check player count after removal
                if (game.players.size === 0) {
                    // Set the empty room timestamp instead of immediately deleting
                    game.emptyRoomTimestamp = Date.now();

                    // For public rooms in immediate cleanup mode, remove immediately
                    if (!game.isPublic) {
                        // For private rooms, allow cleanup to handle it
                        console.log(`Room ${roomCode}| Now empty. Will expire in 60 seconds if no one joins.`);
                    } else {
                        console.log(`Room ${roomCode}| Now empty (public). Will expire in 30 seconds if no one joins.`);
                    }

                    // Clean up all AI players if the room is empty
                    game.aiPlayers.forEach((aiData, aiPlayerId) => {
                        if (aiData.guessTimer) clearTimeout(aiData.guessTimer);
                        if (aiData.drawingTimer) clearTimeout(aiData.drawingTimer);
                        if (aiData.chatTimer) clearTimeout(aiData.chatTimer);
                    });
                    game.aiPlayers.clear();

                // If only AI players remain, clear them all
                } else if (humanPlayerCount === 0 && game.aiPlayers.size > 0) {
                    console.log(`Room ${roomCode}| Only contains AI players now. Removing all AI players.`);

                    // Remove all AI players
                    game.aiPlayers.forEach((aiData, aiPlayerId) => {
                        // Clean up AI player data
                        if (aiData.guessTimer) clearTimeout(aiData.guessTimer);
                        if (aiData.drawingTimer) clearTimeout(aiData.drawingTimer);
                        if (aiData.chatTimer) clearTimeout(aiData.chatTimer);

                        // Remove from players list
                        game.players.delete(aiPlayerId);
                    });
                    game.aiPlayers.clear();

                    // Set the empty room timestamp
                    game.emptyRoomTimestamp = Date.now();
                } else if (game.players.size === 1 && game.isPublic) {
                    // Public room with only one player remaining
                    game.singlePlayerTimestamp = Date.now();
                    console.log(`Room ${roomCode}| Now has only 1 player (public). Will expire in 15 minutes if it stays that way.`);
                } else {
                    // Reset single player timestamp if we have more players
                    game.singlePlayerTimestamp = null;
                }

                // If the drawer left and there are still players, start a new turn
                if (wasDrawer && game.players.size > 0) {
                    nextTurn(roomCode);
                }

                // If host left, reassign host status to the first remaining player
                if (wasHost && game.players.size > 0) {
                    // The new first player is now the host
                    const newHostId = Array.from(game.players.keys())[0];
                    const newHostName = Array.from(game.players.values())[0].username;
                    console.log(`Room ${roomCode}| Host left, new host: ${newHostId}`);
                    sendSystemMessage(roomCode, `The host has left! ${newHostName} is now the host.`, true);
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
        imageGenerationTimes.delete(socket.id);
    });
});

function sanitizeMessage(message, allowedPunctuation = '', maxLength = null) {
    // Trim whitespace first
    message = message.trim();

    // Apply length limit if provided
    if (maxLength !== null && typeof maxLength === 'number') {
        message = message.slice(0, maxLength);
    }

    // Then sanitize characters
    const escapedPunctuation = allowedPunctuation.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
    const regex = new RegExp(`[^a-zA-Z0-9\\s${escapedPunctuation}]`, 'g');
    return message.replace(regex, '');
}

function sendSystemMessage(roomCode, message, in_history = false) {
    const timestamp = new Date().toLocaleTimeString();
    const systemMessage = {
        message: message,
        timestamp
    };

    // Store system message in chat history
    const game = games.get(roomCode);
    if (in_history && game) {
        game.chatHistory.push(systemMessage);
    }

    io.to(roomCode).emit('systemMessage', systemMessage);
}

function sendPlayerMessage(roomCode, playerId, message, isGuess) {
    const game = games.get(roomCode);
    if (!game) return;
    const player = game.players.get(playerId);
    if (!player) return;
    const timestamp = new Date().toLocaleTimeString();
    const username = player.username;
    const color = player.color || '#000000';
    const messageData = {
        username,
        message: message,
        timestamp,
        color,
        isGuess
    }

    game.chatHistory.push({
        playerId: playerId,
        ...messageData
    });

    if (isGuess) {
        game.lastGuesses.set(playerId, message);
    }

    io.to(roomCode).emit('newMessage', messageData);
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

function createRoom(roomCode, isPublic = false) {
    games.set(roomCode, {
        players: new Map(),
        currentDrawer: null,
        round: 1,
        timer: null,
        timerEnd: 0,
        votingTimer: null,
        votingTimerEnd: 0,
        currentPrompt: '',
        chatHistory: [],
        lastGuesses: new Map(),
        votes: new Map(),
        generatedImages: [],
        voting: false,
        isPublic: isPublic,
        createdAt: Date.now(),
        emptyRoomTimestamp: null,     // Track when the room becomes empty
        singlePlayerTimestamp: null,  // Track when the room has only one player
        // Default AI generation prompt template
        customPrompt: PROMPT_CONFIG.IMAGE_GEN_PROMPT,
        aiPlayers: new Map(),         // Store AI player metadata (ID -> data),
        lastChanceTimer: null         // Timer to alert AI last chance to guess
    });
}

function deleteRoom(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    // Clean up AI player resources
    if (game.aiPlayers && game.aiPlayers.size > 0) {
        game.aiPlayers.forEach((aiData, aiPlayerId) => {
            if (aiData.guessTimer) clearTimeout(aiData.guessTimer);
            if (aiData.drawingTimer) clearTimeout(aiData.drawingTimer);
        });
    }

    // Clean up game timers
    if (game.lastChanceTimer) clearTimeout(game.lastChanceTimer);

    games.delete(roomCode);
    drawings.delete(roomCode);
    publicRooms.delete(roomCode);
}

function addPlayer(game, playerId, username) {
    // Add the player to the game
    game.players.set(playerId, {
        username: username,
        score: 0,
        color: getRandomColor()
    });

    reorderPlayers(game);
}

// Reorder players so human players come before AI players
function reorderPlayers(game) {
    if (game.players.size <= 1) return; // Nothing to reorder

    // Get all players and separate them into humans and AIs
    const allPlayers = Array.from(game.players.entries());
    const humanPlayers = allPlayers.filter(([id, data]) => !id.startsWith('ai-'));
    const aiPlayers = allPlayers.filter(([id, data]) => id.startsWith('ai-'));

    // Clear the current players Map
    game.players.clear();

    // Re-add human players first, then AI players
    [...humanPlayers, ...aiPlayers].forEach(([id, data]) => {
        game.players.set(id, data);
    });
}

// Create an AI player
function createAIPlayer(roomCode, personality = null) {
    const game = games.get(roomCode);
    if (!game) return null;

    // Generate a unique AI player ID
    const aiPlayerId = `ai-${uuidv4()}`;

    // Extract personality properties
    const customName = personality?.name || null;
    const chatPrompt = personality?.chatPrompt;
    const guessPrompt = personality?.guessPrompt;
    const corePersonalityPrompt = personality?.corePersonalityPrompt;

    // Use custom name if provided, otherwise select random name
    let aiName;
    if (customName) {
        aiName = `${AI_PLAYER_PREFIX}${customName}`;
    } else {
        const nameIndex = Math.floor(Math.random() * AI_NAMES.length);
        aiName = `${AI_PLAYER_PREFIX}${AI_NAMES[nameIndex]}`;
    }

    // Select a random color
    const colorIndex = Math.floor(Math.random() * AI_PLAYER_COLORS.length);
    const aiColor = AI_PLAYER_COLORS[colorIndex];

    // Make sure the name is unique in this room
    let uniqueAiName = aiName;
    let counter = 2;
    while (Array.from(game.players.values()).some(p => p.username === uniqueAiName)) {
        uniqueAiName = `${aiName}${counter}`;
        counter++;
    }

    // Add the AI player to the game
    game.players.set(aiPlayerId, {
        username: uniqueAiName,
        score: 0,
        color: aiColor,
        isAI: true
    });

    // Initialize AI player data within the game object
    game.aiPlayers.set(aiPlayerId, {
        roomCode: roomCode,
        lastDrawingData: null,
        lastGuessTime: 0,
        guessTimer: null,
        drawingTimer: null,
        lastChatTime: 0,
        chatTimer: null,
        // Core personality prompt that defines the AI's character
        corePersonalityPrompt: corePersonalityPrompt,
        // Store custom prompts
        chatPrompt: chatPrompt,
        guessPrompt: guessPrompt
    });

    console.log(`Room ${roomCode}| AI player ${uniqueAiName} (${aiPlayerId}) added${customName ? ' with custom name' : ''}${personality ? ' with custom personality' : ''}`);

    return aiPlayerId;
}

function removeAIPlayer(roomCode, aiPlayerId) {
    const game = games.get(roomCode);
    if (!game) return null;

    // Remove the AI player
    game.players.delete(aiPlayerId);

    // Clean up timers and other resources
    const aiData = game.aiPlayers.get(aiPlayerId);
    if (aiData) {
        if (aiData.guessTimer) clearTimeout(aiData.guessTimer);
        if (aiData.drawingTimer) clearTimeout(aiData.drawingTimer);
        if (aiData.chatTimer) clearTimeout(aiData.chatTimer);
        game.aiPlayers.delete(aiPlayerId);
    }

    // If the current drawer was this AI, start a new turn
    if (game.currentDrawer === aiPlayerId) {
        nextTurn(roomCode);
    } else {
        // Otherwise just update the game state
        updateGameState(roomCode);
    }

    // Update public rooms list if this is a public room
    if (game.isPublic) {
        updatePublicRoomsList(roomCode);
    }
}

function startGame(roomCode) {
    startTurn(roomCode);
}

function startTurn(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    // Check if there are any players in the game
    if (game.players.size === 0) {
        console.log(`Room ${roomCode}| No players, can't start turn`);
        return;
    }

    game.voting = false;
    game.votes.clear();

    // Keep the existing chat history (but limit it to 25 messages)
    const maxOldMessages = 25;
    if (game.chatHistory.length > maxOldMessages) {
        game.chatHistory = game.chatHistory.slice(-maxOldMessages);
    }

    game.lastGuesses.clear();
    game.imageSrc = '';

    // Clear the current drawing data
    drawings.set(roomCode, '');

    const players = Array.from(game.players.keys());
    game.currentDrawer = players[(game.round - 1) % players.length];

    // Verify that the drawer exists in the player list
    if (!game.players.has(game.currentDrawer)) {
        // Select a new drawer if the current one doesn't exist
        if (players.length > 0) {
            game.currentDrawer = players[0];
        } else {
            return;
        }
    }

    const drawerUsername = game.players.get(game.currentDrawer).username;

    game.currentPrompt = prompts[Math.floor(Math.random() * prompts.length)];

    io.to(game.currentDrawer).emit('newPrompt', game.currentPrompt);
    io.to(roomCode).emit('newTurn', {
        drawer: drawerUsername,
        drawerId: game.currentDrawer,
        round: game.round,
    });

    const roundMs = roundDuration * 1000;
    game.timerEnd = Date.now() + roundMs;
    game.timer = setTimeout(() => endRound(roomCode), roundMs);

    // Start the timer on all clients
    io.to(roomCode).emit('startDisplayTimer', roundDuration);

    updateGameState(roomCode);

    // Send the initial blank canvas to all players
    io.to(roomCode).emit('drawingUpdate', '');

    // Also send the current state of the drawing if available when a player joins mid-game
    const drawingData = drawings.get(roomCode);
    if (drawingData) {
        io.to(roomCode).emit('drawingUpdate', drawingData);
    }

    // If the current drawer is an AI player, schedule the drawing
    const aiData = game.aiPlayers.get(game.currentDrawer);
    if (aiData) {
        // Schedule the drawing after a short delay
        aiData.drawingTimer = setTimeout(() => {
            createAIDrawing(roomCode, game.currentDrawer, game.currentPrompt);
        }, aiTiming.drawingTime);
    }

    // Reset AI player guessing timers
    resetAIPlayerGuessTimers(roomCode);
}

function nextTurn(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    clearTimeout(game.timer);
    if (game.votingTimer) {
        clearTimeout(game.votingTimer);
        game.votingTimer = null;
    }
    if (game.lastChanceTimer) {
        clearTimeout(game.lastChanceTimer);
        game.lastChanceTimer = null;
    }
    game.round++;
    startTurn(roomCode);
}

// Handle drawing updates for AI players
function handleAIPlayerDrawingUpdate(roomCode, drawingData) {
    const game = games.get(roomCode);
    if (!game || !drawingData) return;

    // Only process if there are AI players and we're not in voting phase
    if (game.aiPlayers.size === 0 || game.voting) return;

    // Process for each AI player
    game.aiPlayers.forEach((aiData, aiPlayerId) => {
        // Skip if this AI is the drawer
        if (aiPlayerId === game.currentDrawer) return;

        // Store the current drawing data for comparison
        const hasChanges = aiData.lastDrawingData !== drawingData;
        aiData.lastDrawingData = drawingData;

        if (!hasChanges || aiData.guessTimer) return;

        const timeNow = Date.now();
        const timeLeft = game.timerEnd - timeNow;
        const timeSinceLastGuess = timeNow - aiData.lastGuessTime;

        if (timeLeft < 5) {
            return;
        }
        // Normal timed guess (not last chance)
        else if (timeSinceLastGuess > aiTiming.guessInterval) {
            // Pick a random time between MIN and MAX for the guess
            const guessDelay = aiTiming.minGuessTime + Math.random() * (aiTiming.maxGuessTime - aiTiming.minGuessTime);
            aiData.guessTimer = setTimeout(() => {
                makeAIGuess(roomCode, aiPlayerId, drawingData);
            }, guessDelay);

            // Randomly decide if we should also send a chat message before the guess
            if (Math.random() < aiTiming.chatProbability && guessDelay > 8000) {
                // Add a chat message that comes before the guess
                const chatDelay = Math.min(3000 + Math.random() * 3000, guessDelay - 3000);
                aiData.chatTimer = setTimeout(() => {
                    makeAIChat(roomCode, aiPlayerId, drawingData);
                }, chatDelay);
            }
        }
        // Maybe just add a chat message if it's too soon for a guess
        else if (timeSinceLastGuess > 6000 && Math.random() < 0.3) {
            aiData.chatTimer = setTimeout(() => {
                makeAIChat(roomCode, aiPlayerId, drawingData);
            }, 2000 + Math.random() * 3000);
        }
    });
}

// Reset AI player timers at the start of a new turn
function resetAIPlayerGuessTimers(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    // Clear all existing AI timers
    game.aiPlayers.forEach((aiData, aiPlayerId) => {
        // Clear guess timer
        if (aiData.guessTimer) {
            clearTimeout(aiData.guessTimer);
            aiData.guessTimer = null;
        }

        // Clear chat timer
        if (aiData.chatTimer) {
            clearTimeout(aiData.chatTimer);
            aiData.chatTimer = null;
        }

        // Reset timers and data
        aiData.lastGuessTime = 0;
        aiData.lastChatTime = 0;
        aiData.lastDrawingData = null;
    });

    // Set up last chance timer for all AI players at exactly lastChanceTime before round end
    const lastChanceTime = (roundDuration * 1000) - aiTiming.lastChanceTime;
    game.lastChanceTimer = setTimeout(() => {
        const drawingData = drawings.get(roomCode);
        if (!drawingData) return;

        game.aiPlayers.forEach((aiData, aiPlayerId) => {
            if (aiPlayerId !== game.currentDrawer) {
                // Force a guess at the end (no chat) to make sure AI players take a guess
                // Only make a last chance guess if AI hasn't interacted recently
                if (Date.now() - aiData.lastGuessTime > roundDuration * 0.7) {
                    // Clear any existing guess timer
                    if (aiData.guessTimer) {
                        clearTimeout(aiData.guessTimer);
                    }
                    // Make a guess soon (within 2-3 seconds)
                    const lastChanceDelay = 1000 + Math.random() * 2000;
                    aiData.guessTimer = setTimeout(() => {
                        // Force a guess (not chat) for last chance timer
                        makeAIGuess(roomCode, aiPlayerId, drawingData);
                    }, lastChanceDelay);
                }
            }
        });
    }, lastChanceTime);
}

// Make an AI player guess
async function makeAIGuess(roomCode, aiPlayerId, drawingData) {
    const game = games.get(roomCode);
    if (!game) return;

    const aiData = game.aiPlayers.get(aiPlayerId);
    if (!aiData || game.voting) return;

    try {
        // Only make a guess if there's actual drawing data
        if (!drawingData) return;

        // Get player username and core personality
        const username = game.players.get(aiPlayerId).username;
        const corePersonalityPrompt = aiData.corePersonalityPrompt;

        // Build the AI guess prompt
        const prompt = promptBuilder.buildAIGuessPrompt(
            game.chatHistory,
            username,
            corePersonalityPrompt,
            aiData.guessPrompt
        );

        // Use textOnly=true to utilize the faster model for guesses
        const result = await geminiService.requestGeminiResponse(prompt, drawingData, true);

        let guess = result.text.trim();

        // Update the last guess time
        aiData.lastGuessTime = Date.now();

        // Send the guess as a message
        sendPlayerMessage(roomCode, aiPlayerId, guess, true);

        // Maybe schedule a follow-up chat message
        if (Math.random() < 0.3) {
            const chatDelay = 5000 + Math.random() * 5000;
            aiData.chatTimer = setTimeout(() => {
                makeAIChat(roomCode, aiPlayerId, drawingData);
            }, chatDelay);
        }

    } catch (error) {
        console.error(`Error making AI guess: ${error.message}`);
    }
}

// Make an AI player chat
async function makeAIChat(roomCode, aiPlayerId, drawingData) {
    const game = games.get(roomCode);
    if (!game) return;

    const aiData = game.aiPlayers.get(aiPlayerId);
    if (!aiData || game.voting) return;

    try {
        // Record chat time
        aiData.lastChatTime = Date.now();
        aiData.chatTimer = null;

        // Get player username and core personality
        const username = game.players.get(aiPlayerId).username;
        const corePersonalityPrompt = aiData.corePersonalityPrompt;

        // Build the AI chat prompt
        const prompt = promptBuilder.buildAIChatPrompt(
            game.chatHistory,
            username,
            corePersonalityPrompt,
            aiData.chatPrompt
        );
        const textOnly = true;

        const result = await geminiService.requestGeminiResponse(prompt, drawingData, textOnly);

        let message = result.text.trim();

        sendPlayerMessage(roomCode, aiPlayerId, message, false);

    } catch (error) {
        console.error(`Error making AI chat: ${error.message}`);
    }
}

// Make AI players vote on generated images
async function makeAIPlayersVote(roomCode) {
    const game = games.get(roomCode);
    if (!game || !game.voting || !game.generatedImages || game.generatedImages.length === 0 || game.aiPlayers.length === 0) return;

    // Create a combined image with all options for the AI to see
    // This would normally be a visual process, but we'll provide the AI with text descriptions
    const imageDescriptions = game.generatedImages.map((img, index) => {
        return `Image ${index + 1}: Created based on guess "${img.guess}" by ${img.playerName}`;
    }).join('\n');

    // Only make AI players vote if they're not the drawer
    game.aiPlayers.forEach(async (aiData, aiPlayerId) => {
        if (aiPlayerId !== game.currentDrawer) {
            try {
                // Add a random delay so all AI players don't vote at the exact same time
                const delay = 2000 + Math.random() * 8000;
                setTimeout(async () => {
                    // Check if voting is still active
                    if (!game.voting) return;

                    // Get player username and core personality
                    const username = game.players.get(aiPlayerId).username;
                    const corePersonalityPrompt = aiData.corePersonalityPrompt;

                    // Build the AI voting prompt
                    const prompt = promptBuilder.buildAIVotingPrompt(
                        game.chatHistory,
                        username,
                        corePersonalityPrompt,
                        game.generatedImages
                    );

                    // Get AI vote
                    const result = await geminiService.requestGeminiResponse(prompt, null, true);
                    const responseText = result.text.trim();

                    // Try to extract vote number and message
                    let vote, message;
                    try {
                        // Try to extract vote number
                        const voteMatch = responseText.match(/Vote:\s*(\d+)/i);
                        if (voteMatch && voteMatch[1]) {
                            vote = parseInt(voteMatch[1]);
                        }

                        // Try to extract reason
                        const reasonMatch = responseText.match(/Reason:\s*(.+)(?:\n|$)/i);
                        if (reasonMatch && reasonMatch[1]) {
                            message = reasonMatch[1].trim();
                        } else {
                            // If no reason found, use the whole response as message
                            message = responseText;
                        }

                        // Validate the vote
                        if (isNaN(vote) || vote < 1 || vote > game.generatedImages.length) {
                            throw new Error("Invalid vote number");
                        }

                        // Adjust vote to be 0-indexed to match the image array
                        vote = vote - 1;
                    } catch (parseError) {
                        console.error(`Error parsing AI vote response: ${parseError.message}`);
                    }

                    // Get the player ID associated with the selected image
                    const selectedImagePlayerId = game.generatedImages[vote].playerId;

                    // Send a message about the vote
                    sendPlayerMessage(roomCode, aiPlayerId, message, false);

                    setPlayerVote(roomCode, aiPlayerId, selectedImagePlayerId);

                }, delay);

            } catch (error) {
                console.error(`Error making AI vote: ${error.message}`);
            }
        }
    });
}

// Create an AI drawing
async function createAIDrawing(roomCode, aiPlayerId, prompt) {
    const game = games.get(roomCode);
    if (!game) return;

    const aiData = game.aiPlayers.get(aiPlayerId);
    if (!aiData || game.currentDrawer !== aiPlayerId) return;

    try {
        // Get player username and core personality
        const username = game.players.get(aiPlayerId).username;
        const corePersonalityPrompt = aiData.corePersonalityPrompt;

        // Build the AI drawing concept prompt
        const prompt = promptBuilder.buildAIDrawingConceptPrompt(
            game.chatHistory,
            username,
            corePersonalityPrompt,
            game.currentPrompt
        );

        // Get drawing concept from AI
        const conceptResult = await geminiService.requestGeminiResponse(prompt, null, true);
        const drawingConcept = conceptResult.text.trim();

        // Build the prompt for creating the actual drawing
        const doodlePrompt = promptBuilder.buildAIDrawingCreationPrompt(game.currentPrompt);

        const result = await geminiService.requestGeminiResponse(doodlePrompt);

        // Check if we got image data
        if (!result.imageData) {
            throw new Error('No image data returned from Gemini API for AI drawing');
        }

        // Create a data URL from the base64 image data
        const drawingData = `data:image/png;base64,${result.imageData}`;

        // Store the drawing data
        drawings.set(roomCode, drawingData);

        // Send the drawing to all players
        io.to(roomCode).emit('drawingUpdate', drawingData);

        // Send a message about how the AI is approaching the drawing
        sendPlayerMessage(roomCode, aiPlayerId, drawingConcept, false);

        handleAIPlayerDrawingUpdate(roomCode, drawingData);
    } catch (error) {
        console.error(`Error creating AI drawing: ${error.message}`);

        // If AI failed to generate, use a fallback approach - a blank canvas with a system message
        const blankCanvasData = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAmQAAAGQCAYAAAAnTe0YAAAABGdBTUEAALGPC/xhBQAAAAlwSFlzAAAOwwAADsMBx2+oZAAAABh0RVh0U29mdHdhcmUAcGFpbnQubmV0IDQuMS4xYyqcSwAAArpJREFUeF7t1cEJwDAQBEFTuftM5i7MQsA6WJiBBy78rLUuAEDlEQCAkggAQEkEAKAkAgBQEgEAKIkAAJREAABKIgAAJREAgJIIAEBJBACgJAIAUBIBACiJAACURAAASiIAACURAICSCABASQQAoCQCAFASAQAoiQAAlEQAAEoiAAAlEQCAkggAQEkEAKAkAgBQEgEAKIkAAJREAABKIgAAJREAgJIIAEBJBACgJAIAUBIBACiJAACURAAASiIAACURAICSCABASQQAoCQCAFASAQAoiQAAlEQAAEoiAAAlEQCAkggAQEkEAKAkAgBQEgEAKIkAAJREAABKIgAAJREAgJIIAEBJBACgJAIAUBIBACiJAACURAAASiIAACURAICSCABASQQAoCQCAFASAQAoiQAAlEQAAEoiAAAlEQCAkggAQEkEAKAkAgBQEgEAKIkAAJREAABKIgAAJREAgJIIAEBJBACgJAIAUBIBACiJAACURAAASiIAACURAICSCABASQQAoCQCAFASAQAoiQAAlEQAAEoiAAAlEQCAkggAQEkEAKAkAgBQEgEAKIkAAJREAABKIgAAJREAgJIIAEBJBACgJAIAUBIBACiJAACURAAASiIAACURAICSCABASQQAoCQCAFASAQAoiQAAlEQAAEoiAAAlEQCAkggAQEkEAKAkAgBQEgEAKIkAAJREAABKIgAAJREAgJIIAEBJBACgJAIAUBIBACiJAACURAAASiIAACURAICSCABASQQAoCQCAFASAQAoiQAAlEQAAEoiAAAlEQCAkggAQEkEAKAkAgBQEgEAKIkAAJREAABKIgAAJREAgJIIAEBJBACgJAIAUBIBAOjs3A+u1hUP+gYgfAAAAABJRU5ErkJggg==';
        drawings.set(roomCode, blankCanvasData);
        io.to(roomCode).emit('drawingUpdate', blankCanvasData);

        // Let clients know about the AI drawing failure
        sendSystemMessage(roomCode, `AI player had trouble drawing "${prompt}"`);
    }
}

function endRound(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    clearTimeout(game.timer);

    // Check if we have at least 2 players and valid guesses before generating images
    if (game.players.size >= 2 && game.lastGuesses.size > 0) {
        generateNewImage(roomCode);
    } else {
        // Skip to next turn if we can't generate images
        nextTurn(roomCode);
    }
}

async function generateNewImage(roomCode) {
    const game = games.get(roomCode);
    const drawingData = drawings.get(roomCode);

    try {
        if (!game || !drawingData) {
            throw new Error(`Missing game or drawing data for roomCode: ${roomCode}`);
        }

        // Generate an array of valid guesses with player info
        const guessesWithPlayers = [];
        game.lastGuesses.forEach((guess, playerId) => {
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
            nextTurn(roomCode);
            return;
        }

        // Create a directory for this room's generated images if it doesn't exist
        const generatedDir = path.join(__dirname, 'public', 'generated');
        fs.mkdirSync(generatedDir, { recursive: true });

        // Send a system message to let players know images are being generated
        sendSystemMessage(roomCode, "Generating images from your guesses...");

        // Create array of image generation promises to run in parallel
        const imageGenerationPromises = guessesWithPlayers.map(async (guessData) => {
            try {
                const guessPlayer = game.players.get(guessData.playerId);
                const username = guessPlayer.username;

                // Build image generation prompt with the custom template if available
                const generationPrompt = promptBuilder.buildImageGenerationPrompt(
                    guessData.guess,
                    game.customPrompt
                );

                const result = await geminiService.requestGeminiResponse(generationPrompt, drawingData);
                const imageData = result.imageData;

                // Check if we actually got image data back
                if (!imageData) {
                    throw new Error('No image data returned from Gemini API');
                }

                const buffer = Buffer.from(imageData, 'base64');

                // Sanitize filename components to prevent path traversal
                const safeRoomCode = roomCode.replace(/[^a-zA-Z0-9]/g, '');
                const safePlayerId = guessData.playerId.replace(/[^a-zA-Z0-9-]/g, '');
                const safeRound = String(game.round).replace(/[^0-9]/g, '');
                const filename = `generated-${safeRoomCode}-${safeRound}-${safePlayerId}.png`;
                const filePath = path.join(generatedDir, filename);

                // Validate the path is within the generated directory
                const safePath = path.normalize(filePath);
                if (!safePath.startsWith(generatedDir)) {
                    throw new Error('Invalid file path detected');
                }

                // Write the image file
                fs.writeFileSync(safePath, buffer);

                // Return the image data object
                return {
                    playerId: guessData.playerId,
                    playerName: username,
                    guess: guessData.guess,
                    imageSrc: `/generated/${filename}`,
                    text: result.text || ''
                };
            } catch (error) {
                console.error(`Error generating image for guess "${guessData.guess}":`, error.message);
                // Return null for failed generations
                return null;
            }
        });

        // Wait for all image generation promises to complete
        const imageResults = await Promise.all(imageGenerationPromises);

        // Filter out any failed generations (null results)
        const generatedImages = imageResults.filter(result => result !== null);

        // If we couldn't generate any images, start next turn
        if (generatedImages.length === 0) {
            sendSystemMessage(roomCode, "Failed to generate any images from the guesses.");
            nextTurn(roomCode);
            return;
        }

        // Store the generated images in the game state
        game.generatedImages = generatedImages;

        // Start the voting phase
        startVoting(roomCode);

    } catch (error) {
        console.error('Error in image generation process:', error.message, error.stack);
        io.to(roomCode).emit('error', 'Failed to generate images');

        // Skip to next turn
        nextTurn(roomCode);
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
    io.to(roomCode).emit('startDisplayTimer', 20);

    // Make AI players vote
    makeAIPlayersVote(roomCode);
}

function setPlayerVote(roomCode, playerId, voteId) {
    const game = games.get(roomCode);
    if (!game || !game.voting) return;
    // Don't allow voting twice
    if (game.votes.get(playerId)) return;
    // Store which player's image was voted for
    game.votes.set(playerId, voteId);

    // Get the voter's information to send to other clients
    const voter = game.players.get(playerId);
    if (voter) {
        // Emit playerVoted event to everyone in the room except the voter
        io.to(roomCode).emit('playerVoted', {
            playerId: voteId,
            voterName: voter.username,
            voterColor: voter.color
        });
    }

    // If everyone has voted, end voting early
    if (game.votes.size === game.players.size - 1) { // -1 for the drawer who doesn't vote
        tallyVotes(roomCode);
    }
}

function tallyVotes(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;
    if (game.votingTimer) {
        clearTimeout(game.votingTimer);
        game.votingTimer = null;
    }
    if (!game.voting) return;
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
            // Check if the player still exists before adding score
            if (game.players.has(winnerId)) {
                game.players.get(winnerId).score += 1;
            }
        });

        // Get vote counts for the message
        const winnerVotes = new Map();
        winners.forEach(winnerId => {
            winnerVotes.set(winnerId, voteCount.get(winnerId));
        });

        // Filter out winners who are no longer in the game
        const validWinners = winners.filter(id => game.players.has(id));

        if (validWinners.length === 0) {
            resultMessage = `The winner is no longer in the game. No points awarded.`;
        } else if (validWinners.length === 1) {
            const winnerName = game.players.get(validWinners[0]).username;
            const votes = voteCount.get(validWinners[0]);
            resultMessage = `${winnerName}'s image won with ${votes} votes! They get a point!`;
        } else {
            const winnersList = validWinners.map(id =>
                `${game.players.get(id).username} (${voteCount.get(id)} votes)`
            ).join(', ');
            resultMessage = `Multiple winners! ${winnersList} each get a point!`;
        }
    } else {
        resultMessage = `No image received more than 50% of votes. No points awarded.`;
    }

    // Convert vote count Map to object for client
    const voteCountObj = {};
    voteCount.forEach((count, playerId) => {
        voteCountObj[playerId] = count;
    });

    io.to(roomCode).emit('votingResults', {
        message: resultMessage,
        scores: Array.from(game.players.entries()).map(([id, data]) => ({
            id,
            score: data.score
        })),
        votes: voteCountObj
    });

    setTimeout(() => {
        nextTurn(roomCode);
    }, 8000);
}

function updateGameState(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    // Ensure we have players
    if (game.players.size === 0) {
        console.log(`Room ${roomCode}| No players to update game state`);
        return;
    }

    const players = Array.from(game.players.entries()).map(([id, data]) => ({
        id,
        ...data
    }));

    // Ensure we have a valid drawer
    if (!game.currentDrawer || !game.players.has(game.currentDrawer)) {
        // If drawer is invalid, select first player
        const firstPlayer = Array.from(game.players.keys())[0];
        game.currentDrawer = firstPlayer;
        console.log(`Room ${roomCode}| Invalid drawer, selecting new drawer: ${firstPlayer}`);
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
                console.log(`Room ${roomCode}| Has been empty for ${Math.floor(emptyDuration/1000)} seconds. Removing.`);

                deleteRoom(roomCode);
                return; // Skip further checks for this room
            }
        }

        // Single player public room cleanup (only applies to public rooms)
        if (game.isPublic && game.singlePlayerTimestamp !== null && game.players.size === 1) {
            const singlePlayerDuration = now - game.singlePlayerTimestamp;

            if (singlePlayerDuration > publicRoomSinglePlayerExpiryMs) {
                console.log(`Room ${roomCode}| Has had only 1 player for ${Math.floor(singlePlayerDuration/60000)} minutes (public). Removing.`);

                // Notify the last player before removing the room
                const lastPlayerId = Array.from(game.players.keys())[0];
                io.to(lastPlayerId).emit('error', 'This room has expired due to inactivity. Please create or join a new room.');

                deleteRoom(roomCode);
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

// Run the cleanup at intervals (default 12 hours)
const IMAGE_CLEANUP_INTERVAL = (process.env.IMAGEINARY_IMAGE_CLEAN_INTERVAL || (12 * 60)) * 60 * 1000;
setInterval(cleanupOldImages, IMAGE_CLEANUP_INTERVAL);
// Run the rooms cleanup every 15 seconds
setInterval(cleanupRooms, 15 * 1000);

// Log total users and rooms every 5 minutes
setInterval(() => {
    // Count total users across all rooms
    let totalUsers = 0;
    let totalAIPlayers = 0;
    let activeRooms = 0;
    let publicRoomsCount = 0;

    games.forEach(game => {
        const humanPlayerCount = game.players.size - game.aiPlayers.size;
        totalUsers += humanPlayerCount;
        totalAIPlayers += game.aiPlayers.size;
        activeRooms++;
        if (game.isPublic) publicRoomsCount++;
    });

    console.log(`Server stats: ${totalUsers} users, ${totalAIPlayers} AI players, ${activeRooms} active rooms (${publicRoomsCount} public)`);
}, 5 * 60 * 1000);

server.listen(port, '0.0.0.0', () => console.log(`Server running on port ${port}`));