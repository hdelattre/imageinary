const express = require('express');
const fs = require('fs');
const path = require('path');
const socketIo = require('socket.io');
const http = require('http');
const { v4: uuidv4 } = require('uuid');
const geminiService = require('./geminiService');
const promptBuilder = require('./games/imageinary/promptBuilder');
const ImageinaryGame = require('./games/imageinary/imageinary');
const ZoobGame = require('./games/zoob/zoob');

// NOTE: Client-side code has been refactored for better organization:
// 1. Game-specific code is now in separate modules (public/games/*)
// 2. Each game module manages its own socket listeners
// 3. A generic voting UI component handles both game types' voting

// Import shared configuration and validation
const PROMPT_CONFIG = require('./public/shared-config');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);
const port = process.env.PORT || 3000;

// Initialize Gemini service with API key
geminiService.initializeGeminiService(process.env.GEMINI_API_KEY);

// In-memory storage
const games = new Map(); // roomCode -> gameRoomData
const drawings = new Map(); // roomCode -> drawingData
const lastMessageTimes = new Map(); // Tracks last message time per player
const publicRooms = new Map(); // Stores public room data for listing

// User consts
const MAX_USERNAME_LENGTH = 24;
const MAX_AI_NAME_LENGTH = 20;

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

app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

function isSocketRoomHost(game, socketId) {
    const players = Array.from(game.players.keys());
    return players.length > 0 && players[0] === socketId;
}

function createGameCallbacks(roomCode) {
    const gameRoom = games.get(roomCode);
    if (!gameRoom) return null;

    return {
        // Communication
        emitToRoom: (event, data) => io.to(roomCode).emit(event, data),
        emitToPlayer: (playerId, event, data) => io.to(playerId).emit(event, data),
        sendSystemMessage: (message, inHistory = false, targetPlayerId = null) => {
            if (targetPlayerId) {
                // Send message to specific player only
                const timestamp = new Date().toLocaleTimeString();
                io.to(targetPlayerId).emit('systemMessage', { message, timestamp });
            } else {
                // Use existing server function for room-wide messages
                sendSystemMessage(roomCode, message, inHistory);
            }
        },
        sendPlayerMessage: (playerId, message, isGuess) => {
            // Use existing server function, but source is game logic now
            // Need to ensure the player still exists on the server
            if (gameRoom.players.has(playerId)) {
                sendPlayerMessage(roomCode, playerId, message, isGuess);
            }
        },
        sanitizeMessage: (message, allowedPunctuation = '', maxLength = null) => {
            return sanitizeMessage(message, allowedPunctuation, maxLength);
        },

        // Timers
        startTimer: (durationMs, timerType) => {
            if (!gameRoom.activeTimers) gameRoom.activeTimers = new Map();
            if (!gameRoom.timerEndTimes) gameRoom.timerEndTimes = new Map();

            // Clear existing timer of the same type
            gameRoom.currentGameInstance?.callbacks.clearTimer(timerType);

            const endTime = Date.now() + durationMs;
            const timerId = setTimeout(() => {
                console.log(`Server Timer ${timerType} for ${roomCode} expired.`);
                gameRoom.activeTimers.delete(timerType);
                gameRoom.timerEndTimes.delete(timerType);
                if (gameRoom.currentGameInstance) {
                    gameRoom.currentGameInstance.handleTimerExpiration(timerType);
                }
            }, durationMs);
            gameRoom.activeTimers.set(timerType, timerId);
            gameRoom.timerEndTimes.set(timerType, endTime);
            console.log(`Server Timer ${timerType} for ${roomCode} started (${durationMs}ms).`);
        },
        clearTimer: (timerType) => {
            if (gameRoom.activeTimers && gameRoom.activeTimers.has(timerType)) {
                clearTimeout(gameRoom.activeTimers.get(timerType));
                gameRoom.activeTimers.delete(timerType);
                gameRoom.timerEndTimes.delete(timerType);
                console.log(`Server Timer ${timerType} for ${roomCode} cleared.`);
            }
        },
        getTimerEndTime: (timerType) => {
            return gameRoom.timerEndTimes ? gameRoom.timerEndTimes.get(timerType) || 0 : 0;
        },

        // Data Access / Update
        getPlayers: () => new Map(gameRoom.players), // Return a copy
        getChatHistory: () => [...gameRoom.chatHistory], // Return a copy
        getAIDetails: async (aiPlayerId) => { // Keep async signature if needed later
            const aiPlayerData = gameRoom.players.get(aiPlayerId);
            if (!aiPlayerData) return null;

            // Get AI player data and prompts
            const aiData = gameRoom.aiPlayers.get(aiPlayerId);
            if (!aiData) return null;

            return {
                id: aiPlayerId,
                username: aiPlayerData.username,
                corePersonalityPrompt: aiData.corePersonalityPrompt,
                chatPrompt: aiData.chatPrompt,
                guessPrompt: aiData.guessPrompt
            };
        },
        updatePlayersData: (scoreUpdatesMap) => {
            let updatedScores = [];
            scoreUpdatesMap.forEach((pointsToAdd, playerId) => {
                if (gameRoom.players.has(playerId)) {
                    const playerData = gameRoom.players.get(playerId);
                    playerData.score += pointsToAdd;
                    updatedScores.push({ id: playerId, score: playerData.score });
                }
            });
            // Optionally emit score updates immediately or wait for full gameState update
            updateGameState(roomCode); // Trigger a full state update which includes scores
        },
        getDrawingData: async () => { // Keep async signature
            return drawings.get(roomCode);
        },
        getDrawingDataSync: () => { // Add sync version if needed by AI last chance
            return drawings.get(roomCode);
        },
        setDrawingData: (drawingData) => {
            drawings.set(roomCode, drawingData);
            // Broadcast the drawing update
            io.to(roomCode).emit('drawingUpdate', drawingData);
        },
        updateGameState: () => updateGameState(roomCode), // Trigger server to send gameState

        requestGeminiText: async (prompt, drawingData = null) => {
            return await geminiService.requestGeminiResponse(prompt, drawingData, true);
        },
        requestGeminiImage: async (prompt, drawingData = null) => {
            return await geminiService.requestGeminiResponse(prompt, drawingData, false);
        },
        requestGeminiTextAndImage: async (prompt, drawingData = null) => {
            return await geminiService.requestGeminiResponse(prompt, drawingData, false);
        },
        requestGeminiStructuredText: async (prompt, drawingData = null, textOnly = true) => {
            const result = await geminiService.requestGeminiResponse(prompt, drawingData, textOnly);

            if (result && result.text) {
                const processed = geminiService.processStructuredResponse(result.text);
                if (processed.data) {
                    return { text: processed.text, data: processed.data, image: result.imageData };
                }

                console.warn(`Room ${roomCode}| No JSON data found in Gemini response: ${result.text}`);
                return { text: result.text, data: null, image: result.imageData };
            }

            console.error(`Room ${roomCode}| Gemini response missing text content for structured data request`);
            return { text: null, data: null, image: null };
        },
        saveGeneratedImage: async (imageData, metadata) => {
            try {
                if (!imageData) {
                    throw new Error('No image data provided');
                }

                // Extract metadata
                const { playerId, round } = metadata;
                if (!playerId) {
                    throw new Error('Player ID is required for saving images');
                }

                // Create a buffer from the base64 data
                const buffer = Buffer.from(imageData, 'base64');

                // Ensure the generated directory exists
                const generatedDir = path.join(__dirname, 'public', 'generated');
                fs.mkdirSync(generatedDir, { recursive: true });

                // Create safe filename components
                const safeRoomCode = roomCode.replace(/[^a-zA-Z0-9]/g, '');
                const safePlayerId = playerId.replace(/[^a-zA-Z0-9-]/g, '');
                const safeRound = String(round || 0).replace(/[^0-9]/g, '');

                // Generate a unique filename
                const filename = `generated-${safeRoomCode}-${safeRound}-${safePlayerId}.png`;
                const filePath = path.join(generatedDir, filename);

                // Security check - ensure we're not writing outside the target directory
                const safePath = path.normalize(filePath);
                if (!safePath.startsWith(generatedDir)) {
                    throw new Error('Invalid file path - security violation');
                }

                // Write the file to disk
                fs.writeFileSync(safePath, buffer);

                // Return the public URL path to the saved image
                return `/generated/${filename}`;
            } catch (error) {
                console.error(`Room ${roomCode}| Error saving generated image:`, error);
                return null; // Indicate failure
            }
        },
    };
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
            // Notify game instance about new AI player
            game.currentGameInstance?.handlePlayerJoin(aiPlayerId, game.players.get(aiPlayerId));

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

    socket.on('createRoom', (username, customPrompt, isPublic = false, gameType = 'imageinary') => {
        username = sanitizeMessage(username, '', 24);

        const roomCode = uuidv4().slice(0, 6).toUpperCase();
        socket.join(roomCode);

        console.log(`Room ${roomCode}| Created by ${username}, isPublic: ${isPublic}, gameType: ${gameType}`);

        // Initialize the game room with specified game type
        createRoom(roomCode, isPublic, gameType);
        const game = games.get(roomCode);

        // Store custom prompt if provided (only applicable for Imageinary)
        if (customPrompt && gameType === 'imageinary') {
            // Validate the prompt
            customPrompt = sanitizeMessage(customPrompt, PROMPT_CONFIG.VALID_CHARS, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
            const validation = PROMPT_CONFIG.validatePrompt(customPrompt);
            if (validation.valid) {
                game.roomCustomPrompt = customPrompt;

                // Update the game instance with the custom prompt
                if (game.currentGameInstance) {
                    game.currentGameInstance.updateCustomPrompt(customPrompt);
                }
            }
        }

        socket.emit('roomCreated', {
            roomCode,
            username,
            inviteLink: `http://localhost:${port}/?room=${roomCode}`,
            isPublic,
            gameType: gameType
        });

        // Add the host player
        addPlayer(game, socket.id, username);

        // If room is public, add it to the public rooms list
        if (isPublic) {
            updatePublicRoomsList(roomCode);
        }
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

    // Endpoint to get a room's prompt and game type
    socket.on('getRoomPrompt', (roomCode) => {
        const game = games.get(roomCode);
        if (!game) return;
        // Check if this socket is the host (first player)
        const players = Array.from(game.players.keys());
        const isHost = players.length > 0 && players[0] === socket.id;

        // Return the prompt, game type, and host status in one response
        socket.emit('roomPrompt', {
            prompt: game.roomCustomPrompt,
            isHost: isHost,
            gameType: game.gameType || 'imageinary'
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
                // Update the room's custom prompt
                game.roomCustomPrompt = prompt;

                // Update the game instance
                game.currentGameInstance?.updateCustomPrompt(prompt);

                console.log(`Room ${roomCode}| Prompt updated by host: ${game.roomCustomPrompt}`);

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

            // Add player to the room
            addPlayer(game, socket.id, uniqueUsername);

            socket.emit('roomJoined', { roomCode, username: uniqueUsername, gameType: game.gameType });

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
            const timerEndTimes = game.timerEndTimes || new Map();

            // If we're in drawing phase
            const roundEndTime = timerEndTimes.get('roundEnd');
            if (roundEndTime && roundEndTime > Date.now()) {
                const remainingSeconds = Math.ceil((roundEndTime - Date.now()) / 1000);
                if (remainingSeconds > 0) {
                    socket.emit('startDisplayTimer', remainingSeconds);
                }
            }
            // If we're in voting phase
            else if (timerEndTimes.get('votingEnd') && timerEndTimes.get('votingEnd') > Date.now()) {
                const remainingSeconds = Math.ceil((timerEndTimes.get('votingEnd') - Date.now()) / 1000);
                if (remainingSeconds > 0) {
                    socket.emit('startDisplayTimer', remainingSeconds);
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

        // Forward the drawing data to the game logic
        const game = games.get(roomCode);
        game?.currentGameInstance?.handleDrawingUpdate(drawingData);
    });

    socket.on('sendMessage', ({ roomCode, message }) => {
        const game = games.get(roomCode);
        if (!game) return;
        const gameInstance = game.currentGameInstance;
        const chatAllowed = !gameInstance?.canPlayerChat || gameInstance.canPlayerChat(socket.id);
        if (!chatAllowed) return;

        const now = Date.now();
        const lastTime = lastMessageTimes.get(socket.id) || 0;

        // Spam control: 1 message/sec
        if (now - lastTime < 1000) return;
        lastMessageTimes.set(socket.id, now);

        message = sanitizeMessage(message, PROMPT_CONFIG.CHAT_CHARS);

        let gameHandled = false;
        let displayMessage = message;
        let isGuess = false;

        // Handle commands
        if (message.startsWith('/')) {
            let commandName = null;
            let commandValue = null;

            // Find first whitespace to split command from guess
            const firstSpaceIndex = message.indexOf(' ');
            if (firstSpaceIndex !== -1) {
                commandName = message.substring(1, firstSpaceIndex);
                commandValue = message.substring(firstSpaceIndex + 1).trim();
            }

            if (!commandName) return;
            if (!commandValue) {
                sendSystemMessage(roomCode, `Usage: /${commandName} [message] (use a space after /${commandName})`, false, socket.id);
                return;
            }

            if (game.currentGameInstance) {
                const result = game.currentGameInstance.handlePlayerCommand(socket.id, commandName,  commandValue);
                if (result.handled) {
                    gameHandled = result.handled;
                    displayMessage = result.displayMessage; // May be modified (e.g., /g removed)
                    isGuess = result.isGuess;
                }
                else {
                    sendSystemMessage(roomCode, `Unknown command /${commandName}`, false, socket.id);
                    return;
                }
            }
        }

        if (displayMessage) {
            sendPlayerMessage(roomCode, socket.id, displayMessage, isGuess);
        }
    });

    socket.on('vote', ({ roomCode, votePlayerId }) => {
        const game = games.get(roomCode);
        game?.currentGameInstance?.handleVote(socket.id, votePlayerId);
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

        // Notify the game instance about the personality update
        game.currentGameInstance?.handleAIPlayerPersonalityUpdate(aiPlayerId, {
            corePersonalityPrompt: aiData.corePersonalityPrompt,
            chatPrompt: aiData.chatPrompt,
            guessPrompt: aiData.guessPrompt
        });

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
                // Notify game instance about new AI player
                game.currentGameInstance?.handlePlayerJoin(aiPlayerId, game.players.get(aiPlayerId));

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
                // Store this info before notifying the game instance
                const wasHost = Array.from(game.players.keys())[0] === socket.id;

                // Notify game instance about player leaving
                game.currentGameInstance?.handlePlayerLeave(socket.id);

                // Now remove the player from server's player list
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

                } else if (humanPlayerCount === 0 && game.aiPlayers.size > 0) {
                    console.log(`Room ${roomCode}| Only contains AI players now. Removing all AI players.`);

                    // Remove all AI players
                    game.aiPlayers.forEach((aiData, aiPlayerId) => {
                        // Remove from players list - game instance will handle cleanup internally
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

function createRoom(roomCode, isPublic = false, gameType = 'imageinary') {
    // Initialize game room data
    const gameRoomData = {
        players: new Map(),  // Master player list
        gameType: gameType,  // Identifier for the current game type
        currentGameInstance: null,  // Will hold game instance (Imageinary or Zoob)
        isPublic: isPublic,
        createdAt: Date.now(),
        emptyRoomTimestamp: null,  // Track when the room becomes empty
        singlePlayerTimestamp: null,  // Track when the room has only one player
        chatHistory: [],  // Keep chat history at room level
        aiPlayers: new Map(),  // Store AI player metadata (ID -> data)
        roomCustomPrompt: PROMPT_CONFIG.IMAGE_GEN_PROMPT,  // Default prompt for image generation
        activeTimers: new Map(),  // For tracking server-managed timers
        timerEndTimes: new Map()  // For tracking timer end times
    };

    games.set(roomCode, gameRoomData);

    // Create callback functions for game instance
    const callbacks = createGameCallbacks(roomCode);

    if (callbacks) {
        // Create the game instance based on type
        if (gameType === 'zoob') {
            gameRoomData.currentGameInstance = new ZoobGame(
                roomCode,
                io,
                gameRoomData.players,  // Pass initial player map (empty at this point)
                {  // Pass game config
                    imageStyle: "fantasy illustration",
                    // Add other config overrides here if needed
                },
                callbacks
            );
            console.log(`Room ${roomCode}| Instantiated ZoobGame.`);
        } else {
            // Default to Imageinary game
            gameRoomData.currentGameInstance = new ImageinaryGame(
                roomCode,
                io,
                gameRoomData.players,  // Pass initial player map (empty at this point)
                {  // Pass game config
                    customImageGenPrompt: gameRoomData.roomCustomPrompt
                    // Add other config overrides here if needed
                },
                callbacks
            );
            console.log(`Room ${roomCode}| Instantiated ImageinaryGame.`);
        }
    } else {
        console.error(`Room ${roomCode}| Failed to create game callbacks.`);
    }
}

function deleteRoom(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    // Clean up game instance resources
    if (game.currentGameInstance) {
        game.currentGameInstance.cleanup();
    }

    // Clean up server-managed timers
    if (game.activeTimers) {
        game.activeTimers.forEach(timerId => clearTimeout(timerId));
        game.activeTimers.clear();
        game.timerEndTimes.clear();
    }

    games.delete(roomCode);
    drawings.delete(roomCode);
    publicRooms.delete(roomCode);
}

function addPlayer(game, playerId, username) {
    // Add the player to the game's player list
    game.players.set(playerId, {
        username: username,
        score: 0,
        color: getRandomColor()
    });

    // Notify game instance about the new player
    if (game.currentGameInstance) {
        game.currentGameInstance.handlePlayerJoin(playerId, game.players.get(playerId));
    }

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

    // Add the AI player to the game's player list
    game.players.set(aiPlayerId, {
        username: uniqueAiName,
        score: 0,
        color: aiColor,
        isAI: true
    });

    // Initialize AI player data
    game.aiPlayers.set(aiPlayerId, {
        roomCode: roomCode,
        lastDrawingData: null,
        lastGuessTime: 0,
        lastChatTime: 0,
        // Store custom prompts
        corePersonalityPrompt: corePersonalityPrompt,
        chatPrompt: chatPrompt,
        guessPrompt: guessPrompt
    });

    console.log(`Room ${roomCode}| AI player ${uniqueAiName} (${aiPlayerId}) added${customName ? ' with custom name' : ''}${personality ? ' with custom personality' : ''}`);

    return aiPlayerId;
}

function removeAIPlayer(roomCode, aiPlayerId) {
    const game = games.get(roomCode);
    if (!game) return null;

    // Notify game instance before removing the player
    game.currentGameInstance?.handlePlayerLeave(aiPlayerId);

    // Remove the AI player from server's lists
    game.players.delete(aiPlayerId);
    game.aiPlayers.delete(aiPlayerId);

    // Update game state for remaining players
    updateGameState(roomCode);

    // Update public rooms list if this is a public room
    if (game.isPublic) {
        updatePublicRoomsList(roomCode);
    }
}

function updateGameState(roomCode) {
    const game = games.get(roomCode);
    if (!game) return;

    // Ensure we have players
    if (game.players.size === 0) {
        console.log(`Room ${roomCode}| No players to update game state`);
        return;
    }

    // Create players list to send to clients
    const players = Array.from(game.players.entries()).map(([id, data]) => ({
        id,
        username: data.username,
        color: data.color,
        isAI: data.isAI,
        score: data.score
    }));

    // Get game state snapshot from game instance
    const gameStateSnapshot = game.currentGameInstance?.getGameStateSnapshot() || {};

    // Send game state to all clients in the room
    io.to(roomCode).emit('gameState', {
        players,
        currentDrawer: gameStateSnapshot.currentDrawerId || null,
        round: gameStateSnapshot.round || 1,
        voting: gameStateSnapshot.voting || false,
        // You might add more detailed state info as needed
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
        round: game.currentGameInstance?.round || 1,
        createdAt: game.createdAt,
        hostName: hostName,
        prompt: game.roomCustomPrompt,
        gameType: game.gameType || 'imageinary'
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
            roomInfo.round = game.currentGameInstance?.round || 1;
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