// imageinary.js
const promptBuilder = require('./promptBuilder');
const PROMPT_CONFIG = require('../../public/shared-config');

// --- Constants ---
const ROUND_DURATION_SECONDS = 45;
const VOTING_DURATION_SECONDS = 20;
const RESULTS_DURATION_SECONDS = 8; // Time to show results before next turn

const AI_TIMING = {
    minGuessTime: 4000,      // ms
    maxGuessTime: 12000,     // ms
    guessInterval: 30000,    // ms between guesses
    lastChanceTime: 10,      // seconds before round end to trigger last chance check
    drawingTime: 3000,       // ms delay before AI starts drawing
    chatIntervalMin: 10000,  // ms minimum time between chats (increased to 10-20s for later chats)
    chatIntervalMax: 20000,  // ms maximum time between chats (increased for more natural pacing)
    firstChatMinTime: 2000,  // ms minimum time for first chat after drawing starts
    firstChatMaxTime: 7000,  // ms maximum time for first chat after drawing starts
    firstGuessMinTime: 3000, // ms minimum time for first guess after first chat
    firstGuessMaxTime: 8000, // ms maximum time for first guess after first chat
    chatProbability: 0.4,    // Chance to chat after sufficient interval
    voteDelayMin: 2000,      // ms minimum delay before AI votes
    voteDelayMax: 8000,      // ms maximum delay before AI votes
    lastChanceGuessDelayMin: 500, // ms
    lastChanceGuessDelayMax: 2000 // ms
};

// Fallback blank image data URL (1x1 white pixel)
const FALLBACK_BLANK_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwAB/aurH8kAAAAASUVORK5CYII=';


class ImageinaryGame {
    constructor(roomCode, io, initialPlayers, gameConfig, callbacks) {
        this.roomCode = roomCode;
        // this.io = io; // Keep reference if direct emits are ever needed, but callbacks are preferred
        this.players = new Map(); // Map<playerId, { score: number }> - Game-specific player state
        this.aiPlayers = new Map(); // Map<aiPlayerId, { lastGuessTime: number, lastChatTime: number }> - AI game state
        this.callbacks = callbacks; // Functions provided by server.js for interaction

        // --- Game State ---
        this.currentDrawerId = null;
        this.round = 1;
        this.gameState = 'waiting'; // 'waiting', 'drawing', 'generating', 'voting', 'results', 'ended'
        this.lastGuesses = new Map(); // Map<playerId, guessString>
        this.votes = new Map();       // Map<voterPlayerId, votedForPlayerId>
        this.generatedImages = [];    // Array of { playerId, playerName, guess, imageSrc, text }

        // --- Timers (IDs managed by this class, execution via setTimeout) ---
        this.aiGuessTimers = new Map(); // Map<aiPlayerId, timerId>
        this.aiChatTimers = new Map();  // Map<aiPlayerId, timerId>
        this.aiVoteTimers = new Map();  // Map<aiPlayerId, timerId>
        this.aiDrawingTimer = null;     // TimerId for AI drawer action
        this.lastChanceTimer = null;    // TimerId for triggering last chance AI guesses

        // --- Game-specific Messages ---
        this.tipMessages = {
            welcome: "TIP: Use /g followed by your guess to submit a guess that will be used for image generation. Regular chat messages won't be used for generating images."
            // Add other tips if needed
        };

        // --- Configuration ---
        this.roundDuration = (gameConfig.roundDuration || ROUND_DURATION_SECONDS) * 1000;
        this.votingDuration = (gameConfig.votingDuration || VOTING_DURATION_SECONDS) * 1000;
        this.resultsDuration = (gameConfig.resultsDuration || RESULTS_DURATION_SECONDS) * 1000;
        this.aiTiming = { ...AI_TIMING, ...(gameConfig.aiTiming || {}) };
        // Get initial custom prompts from server config
        this.customImageGenPrompt = PROMPT_CONFIG.IMAGE_GEN_PROMPT;
        this.customChatPrompt = PROMPT_CONFIG.CHAT_PROMPT;
        this.customGuessPrompt = PROMPT_CONFIG.GUESS_PROMPT;

        console.log(`Room ${this.roomCode}| ImageinaryGame instance created.`);

        // Initialize players based on the map provided by the server
        initialPlayers.forEach((playerData, playerId) => {
            this.addPlayer(playerId, playerData);
        });
    }

    // --- Core Game Flow Methods ---

    startGameLoop() {
        // Can be called by server or internally (e.g., after enough players join)
        // Check if there's at least one player
        if (this.gameState === 'waiting' && this.getPlayerCount() >= 1) {
            console.log(`Room ${this.roomCode}| Starting Imageinary game loop with ${this.getPlayerCount()} player(s).`);
            this.startTurn();
        } else if (this.gameState === 'waiting') {
            console.log(`Room ${this.roomCode}| Waiting for players to start game loop.`);
            // Optionally send a message: "Waiting for more players..."
            this.callbacks.sendSystemMessage("Waiting for players...", false); // Don't store in history?
        }
    }

    startTurn() {
        console.log(`Room ${this.roomCode}| Starting Round ${this.round}`);
        // 1. Clear previous turn state
        this.clearAllAITimers(); // Clear AI action timers first
        this.votes.clear();
        this.lastGuesses.clear();
        this.generatedImages = [];
        this.gameState = 'drawing';

        // 2. Get players
        const playerIds = Array.from(this.players.keys());
        if (playerIds.length === 0) {
            console.log(`Room ${this.roomCode}| No players, stopping game loop.`);
            this.gameState = 'waiting'; // Revert state
            this.callbacks.updateGameState();
            return;
        }

        // 3. Select next drawer
        this.currentDrawerId = playerIds[(this.round - 1) % playerIds.length];
        // Ensure drawer is still valid (might have left) - loop until valid one found
        let attempts = 0;
        while (!this.players.has(this.currentDrawerId) && attempts < playerIds.length) {
            console.warn(`Room ${this.roomCode}| Invalid drawer ${this.currentDrawerId} detected, selecting next.`);
            this.currentDrawerId = playerIds[(this.round + attempts) % playerIds.length]; // Check next potential index
            attempts++;
        }
        if (!this.players.has(this.currentDrawerId)) {
            console.error(`Room ${this.roomCode}| Could not find a valid drawer. Stopping.`);
            this.gameState = 'waiting';
            this.callbacks.updateGameState();
            return;
        }


        // 4. Get drawer's username (from server's authoritative player data)
        const serverPlayers = this.callbacks.getPlayers(); // Get current data from server
        const drawerPlayerData = serverPlayers.get(this.currentDrawerId);
        const drawerUsername = drawerPlayerData ? drawerPlayerData.username : 'Unknown Drawer';

        // 7. Announce new turn to everyone
        this.callbacks.emitToRoom('newTurn', {
            drawer: drawerUsername,
            drawerId: this.currentDrawerId,
            round: this.round,
        });

        // 8. Start server-managed round timer
        this.callbacks.startTimer(this.roundDuration, 'roundEnd');

        // 9. Start client-side display timer
        this.callbacks.emitToRoom('startDisplayTimer', this.roundDuration / 1000);

        // 10. Reset AI guessing logic for the new turn
        this.resetAIPlayerGuessTimers(); // Sets up last chance timer too

        // 11. If drawer is AI, schedule its drawing action
        if (this.aiPlayers.has(this.currentDrawerId)) {
            this.scheduleAIDrawing();
        }

        // 12. Clear the drawing canvas for all players
        this.callbacks.setDrawingData(''); // Use callback to set and broadcast blank state

        // 13. Update overall game state for UI synchronization
        this.callbacks.updateGameState();
    }

    endRound() {
        console.log(`Room ${this.roomCode}| Ending drawing phase for round ${this.round}.`);
        // Clear the main round timer via server callback
        this.callbacks.clearTimer('roundEnd');

        // Stop any pending AI actions (guesses, chats, last chance)
        this.clearAllAITimers();

        // Check conditions for generating images
        const humanGuessers = Array.from(this.lastGuesses.keys()).filter(id => id !== this.currentDrawerId && !this.aiPlayers.has(id));
        // Require at least one human guess OR multiple AI guesses if only AIs are playing? Let's keep simple: require any guesser.
        const hasValidGuesses = this.lastGuesses.size > 0; // Ensure at least one guess exists

        if (this.getPlayerCount() >= 1 && hasValidGuesses) { // Allow generation even with 1 player if they guessed (e.g., AI drew, human guessed)
            this.gameState = 'generating';
            console.log(`Room ${this.roomCode}| Proceeding to image generation.`);
            this.callbacks.updateGameState(); // Update UI state
            this.generateImages(); // Start async generation
        } else {
            console.log(`Room ${this.roomCode}| Skipping image generation (Players: ${this.getPlayerCount()}, Guesses: ${this.lastGuesses.size}).`);
            this.callbacks.sendSystemMessage("Not enough players or guesses to generate images this round.", true);
            this.nextTurn();
        }
    }

    // Imageinary-specific function for generating images based on player guesses
    async requestImageGeneration(playerId, guess, drawingData, generationPrompt) {
        try {
            const serverPlayers = this.callbacks.getPlayers();
            const guessPlayer = serverPlayers.get(playerId);
            if (!guessPlayer) throw new Error('Player not found for image generation');

            // Use Gemini to generate an image based on the drawing and prompt
            const result = await this.callbacks.requestGeminiImage(generationPrompt, drawingData);
            const imageData = result.imageData;
            if (!imageData) throw new Error('No image data from Gemini');

            // Save the generated image using the server callback
            const imageSrc = await this.callbacks.saveGeneratedImage(imageData, {
                playerId: playerId,
                round: this.round
            });

            if (!imageSrc) throw new Error('Failed to save generated image');

            // Return the metadata about the generated image
            return {
                playerId: playerId,
                playerName: guessPlayer.username,
                guess: guess,
                imageSrc: imageSrc,
                text: result.text || ''
            };
        } catch (error) {
            console.error(`Room ${this.roomCode}| Error in requestImageGeneration for ${playerId}:`, error);
            return null; // Indicate failure
        }
    }

    async generateImages() {
        try {
            const drawingData = await this.callbacks.getDrawingData(); // Fetch drawing from server cache

            // Safety check for drawing data (though endRound should prevent this)
            if (!drawingData) {
                console.warn(`Room ${this.roomCode}| No drawing data found during image generation phase.`);
                this.callbacks.sendSystemMessage("No drawing...", true);
                this.nextTurn();
                return;
            }

            // Filter valid guesses (not the drawer, player still exists)
            const validGuesses = [];
            const serverPlayers = this.callbacks.getPlayers(); // Get current player list
            this.lastGuesses.forEach((guess, playerId) => {
                if (playerId !== this.currentDrawerId && serverPlayers.has(playerId)) {
                    validGuesses.push({
                        playerId,
                        playerName: serverPlayers.get(playerId).username,
                        guess
                    });
                }
            });

            if (validGuesses.length === 0) {
                console.log(`Room ${this.roomCode}| No valid guesses remaining for image generation.`);
                this.callbacks.sendSystemMessage("No valid guesses to generate images from.", true);
                this.nextTurn();
                return;
            }

            this.callbacks.sendSystemMessage("Generating images based on guesses...", true);

            const generationPromises = validGuesses.map(guessData => {
                const generationPrompt = promptBuilder.buildImageGenerationPrompt(
                    guessData.guess,
                    this.customImageGenPrompt // Use the potentially room-customized prompt
                );
                // Generate the image using our own method instead of server callback
                return this.requestImageGeneration(
                    guessData.playerId,
                    guessData.guess,
                    drawingData,
                    generationPrompt
                );
            });

            const results = await Promise.allSettled(generationPromises);
            const successfulImages = results
                .filter(res => res.status === 'fulfilled' && res.value !== null)
                .map(res => res.value);

            if (successfulImages.length === 0) {
                console.warn(`Room ${this.roomCode}| All image generations failed.`);
                this.callbacks.sendSystemMessage("Failed to generate any images from the guesses.", true);
                this.nextTurn();
                return;
            }

            // Store successful images and proceed to voting
            this.generatedImages = successfulImages;
            console.log(`Room ${this.roomCode}| Generated ${successfulImages.length} images.`);
            this.startVoting();

        } catch (error) {
            console.error(`Room ${this.roomCode}| Error during generateImages:`, error);
            this.callbacks.sendSystemMessage("An error occurred while generating images.", true);
            this.nextTurn(); // Move to next turn on error
        }
    }

    startVoting() {
        console.log(`Room ${this.roomCode}| Starting voting phase.`);
        this.gameState = 'voting';
        this.votes.clear(); // Reset votes for the new phase

        // Send generated images to clients
        this.callbacks.emitToRoom('startVoting', this.generatedImages);

        // Start server-managed voting timer
        this.callbacks.startTimer(this.votingDuration, 'votingEnd');

        // Start client display timer
        this.callbacks.emitToRoom('startDisplayTimer', this.votingDuration / 1000);

        // Schedule AI votes
        this.scheduleAIPlayerVotes();

        // Update game state for UI
        this.callbacks.updateGameState();
    }

    tallyVotes() {
        console.log(`Room ${this.roomCode}| Tallying votes.`);
        this.gameState = 'results';
        this.callbacks.clearTimer('votingEnd'); // Stop the voting timer
        this.clearAllAITimers(); // Stop any pending AI votes

        // 1. Count votes for each image (based on the player who submitted the guess)
        const voteCounts = new Map();
        this.generatedImages.forEach(image => {
            voteCounts.set(image.playerId, 0); // Initialize count for each generated image
        });

        this.votes.forEach((votedForPlayerId /* image owner */, voterId) => {
            if (voteCounts.has(votedForPlayerId)) {
                voteCounts.set(votedForPlayerId, voteCounts.get(votedForPlayerId) + 1);
            }
        });

        // 2. Determine winner(s) - requires > 50% of votes cast
        const serverPlayers = this.callbacks.getPlayers();
        // Drawer doesn't vote
        const potentialVoters = serverPlayers.size - (serverPlayers.has(this.currentDrawerId) ? 1 : 0);
        const votesCast = this.votes.size; // Actual number of votes received
        const winThreshold = votesCast / 2; // Need strictly more than half the votes CAST

        const winners = [];
        voteCounts.forEach((count, playerId) => {
            if (count > winThreshold) {
                winners.push(playerId);
            }
        });

        // 3. Award points and format message
        const scoreUpdates = new Map(); // Map<playerId, pointsToAdd>
        let resultMessage = '';

        // Filter winners who are still in the game
        const validWinners = winners.filter(id => serverPlayers.has(id));

        if (validWinners.length > 0) {
            validWinners.forEach(winnerId => {
                scoreUpdates.set(winnerId, 1); // Award 1 point
            });

            if (validWinners.length === 1) {
                const winnerName = serverPlayers.get(validWinners[0]).username;
                const votes = voteCounts.get(validWinners[0]);
                resultMessage = `${winnerName}'s image won with ${votes} vote${votes !== 1 ? 's' : ''}! They get a point!`;
            } else {
                const winnersList = validWinners.map(id =>
                    `${serverPlayers.get(id).username} (${voteCounts.get(id)} votes)`
                ).join(', ');
                resultMessage = `Multiple winners! ${winnersList} each get a point!`;
            }
        } else {
            resultMessage = `No image received a majority of votes (>50%). No points awarded.`;
        }

        // 4. Apply score updates via callback
        this.callbacks.updatePlayersData(scoreUpdates);

        // 5. Prepare vote counts object for client display
        const voteCountsObj = {};
        voteCounts.forEach((count, playerId) => {
            voteCountsObj[playerId] = count;
        });

        // 6. Emit results to all clients
        // Get potentially updated scores from server state
        const finalPlayersState = this.callbacks.getPlayers();
        this.callbacks.emitToRoom('votingResults', {
            message: resultMessage,
            scores: Array.from(finalPlayersState.entries()).map(([id, data]) => ({
                id,
                score: data.score // Send final scores
            })),
            votes: voteCountsObj // Send vote counts for display
        });

        // 7. Schedule next turn after results display duration
        this.callbacks.startTimer(this.resultsDuration, 'resultsEnd');

        // 8. Update game state
        this.callbacks.updateGameState();
    }

    nextTurn() {
        console.log(`Room ${this.roomCode}| Moving to next turn.`);
        this.round++;

        // Clear any potentially lingering timers from the previous phase
        this.callbacks.clearTimer('roundEnd');
        this.callbacks.clearTimer('votingEnd');
        this.callbacks.clearTimer('resultsEnd');
        this.clearAllAITimers(); // Ensure all AI timers are gone

        // Start the new turn
        this.startTurn();
    }

    canPlayerChat(playerId) {
        const isVoting = this.gameState === 'voting';
        // Allow drawer to send messages if in voting phase, otherwise block
        if (playerId === this.currentDrawerId && !isVoting) {
            return false;
        }
        return true;
    }

    // --- Event Handlers (Called by server.js via callbacks) ---

    handlePlayerJoin(playerId, playerData) {
        console.log(`Room ${this.roomCode}| Game Logic: Player joined ${playerData.username} (${playerId})`);
        this.addPlayer(playerId, playerData); // Add to internal game maps

        // Send game-specific welcome/tip message to the room
        this.callbacks.sendSystemMessage(this.tipMessages.welcome, false, playerId); // Don't store tip in history repeatedly

        // If the game was waiting, see if it can start now
        if (this.gameState === 'waiting') {
            this.startGameLoop(); // Attempt to start the game
        } else {
            // If game is in progress, ensure the new player gets the current state
            this.callbacks.updateGameState();
            // Also send the current drawing state immediately
            this.callbacks.getDrawingData().then(drawingData => {
                this.callbacks.emitToPlayer(playerId, 'drawingUpdate', drawingData || '');
            });
        }
    }

    handlePlayerLeave(playerId) {
        const serverPlayers = this.callbacks.getPlayers();
        const leavingPlayer = serverPlayers.get(playerId);
        const username = leavingPlayer ? leavingPlayer.username : 'Someone';
        console.log(`Room ${this.roomCode}| Game Logic: Player leaving ${username} (${playerId})`);

        const wasDrawer = this.currentDrawerId === playerId;
        const wasPlaying = this.players.has(playerId); // Check if they were actually part of the game instance

        if (!wasPlaying) {
            console.log(`Room ${this.roomCode}| Leaving player ${username} was not in the active game.`);
            return; // Nothing to do if they weren't in the game logic state
        }

        // Remove player from internal game state
        this.removePlayer(playerId);

        // --- Handle game state implications ---

        // If no players left, cleanup game state (server handles room deletion)
        if (this.getPlayerCount() === 0) {
            console.log(`Room ${this.roomCode}| Game Logic: Last player left.`);
            this.cleanup();
            this.gameState = 'waiting'; // Reset state
            this.callbacks.updateGameState();
            return;
        }

        // If the drawer left mid-round
        if (wasDrawer && this.gameState === 'drawing') {
            this.callbacks.sendSystemMessage(`${username} (the drawer) left! Starting next turn.`, true);
            this.nextTurn(); // Advance immediately
        }
        // If a player left during voting
        else if (this.gameState === 'voting') {
            // Remove their vote if they cast one
            if (this.votes.has(playerId)) {
                this.votes.delete(playerId);
                this.callbacks.sendSystemMessage(`${username}'s vote was removed as they left.`, true);
            }
            // Check if their departure completes the voting
            this.checkVotingComplete();
            // Update state regardless to remove player from lists
            this.callbacks.updateGameState();
        }
        // If a player left during results or waiting
        else if (this.gameState === 'results' || this.gameState === 'waiting') {
            // Just update the state for player lists
            this.callbacks.updateGameState();
        }

        // Check if only AI players remain
        if (this.getHumanPlayerCount() === 0 && this.aiPlayers.size > 0 && this.gameState !== 'waiting') {
            console.log(`Room ${this.roomCode}| Game Logic: Only AI players remain. Stopping game.`);
            this.callbacks.sendSystemMessage("All human players have left. Ending Imageinary game.", true);
            this.cleanup();
            this.gameState = 'waiting'; // Reset state
            this.callbacks.updateGameState();
            // Server needs separate logic if it should remove the AI entities themselves
        }
    }

    handlePlayerCommand(playerId, commandName, commandValue) {
        // Let game logic handle any '/g*' guess command during the drawing phase
        if (this.gameState === 'drawing' && playerId !== this.currentDrawerId) {
            commandName = commandName.toLowerCase();
            if (commandName.startsWith('g')) {
                this.lastGuesses.set(playerId, commandValue)
                console.log(`Room ${this.roomCode}| Player ${playerId} guessed: ${commandValue}`);
                return { handled: true, displayMessage: commandValue, isGuess: true };
            }
        }
        return { handled: false };
    }

    handleVote(playerId, votedForPlayerId) {
        // Validate voting conditions
        if (this.gameState !== 'voting') { return; } // Not voting phase
        if (playerId === this.currentDrawerId) { return; } // Drawer can't vote
        if (this.votes.has(playerId)) { return; } // Already voted
        if (!this.generatedImages.some(img => img.playerId === votedForPlayerId)) { return; } // Voted for invalid image owner

        this.votes.set(playerId, votedForPlayerId);
        console.log(`Room ${this.roomCode}| Player ${playerId} voted for image by ${votedForPlayerId}`);

        // Notify all clients about the vote (for animation/feedback)
        const serverPlayers = this.callbacks.getPlayers();
        const voterData = serverPlayers.get(playerId);
        if (voterData) {
            this.callbacks.emitToRoom('playerVoted', {
                playerId: votedForPlayerId, // The ID of the player whose image was voted for
                voterName: voterData.username,
                voterColor: voterData.color
            });
        }

        // Check if voting is now complete
        this.checkVotingComplete();
    }

    handleTimerExpiration(timerType) {
        console.log(`Room ${this.roomCode}| Game Timer expired: ${timerType}`);
        switch (timerType) {
            case 'roundEnd':
                // Prevent acting if state already changed (e.g., by early end)
                if (this.gameState === 'drawing') {
                    this.endRound();
                }
                break;
            case 'votingEnd':
                // Prevent acting if state already changed (e.g., by early end)
                if (this.gameState === 'voting') {
                    this.tallyVotes();
                }
                break;
            case 'resultsEnd':
                // Prevent acting if state already changed
                if (this.gameState === 'results') {
                    this.nextTurn();
                }
                break;
            // AI timers ('aiGuess', 'aiChat', 'aiVote') are handled internally by their setTimeout callbacks
        }
    }

    handleDrawingUpdate(drawingData) {
        // Notify AI logic that the drawing has changed
        if (this.gameState === 'drawing') {
            this.scheduleAIGuessesAndChats(drawingData);
        }
    }

    // --- AI Control Methods ---

    scheduleAIDrawing() {
        const drawerId = this.currentDrawerId;
        if (!this.aiPlayers.has(drawerId)) return; // Should not happen if called correctly

        console.log(`Room ${this.roomCode}| Scheduling drawing action for AI: ${drawerId}`);
        this.clearAITimer(drawerId, 'drawing'); // Clear previous drawing timer if any

        const timerId = setTimeout(async () => {
            // Double-check if still the drawer and in drawing phase
            if (this.currentDrawerId !== drawerId || this.gameState !== 'drawing') {
                console.log(`Room ${this.roomCode}| AI ${drawerId} drawing action cancelled (state changed).`);
                return;
            }

            try {
                // 1. Get drawing concept (optional, for flavor)
                const drawingConcept = await this.getAIDrawingConcept(drawerId);
                if (drawingConcept) {
                    this.callbacks.sendPlayerMessage(drawerId, drawingConcept, false); // Send concept as chat
                }

                // 2. Generate the actual drawing image
                const drawingData = await this.createAIDrawing(drawerId);

                // 3. Set and broadcast the drawing data (or fallback)
                this.callbacks.setDrawingData(drawingData || FALLBACK_BLANK_IMAGE);

                if (drawingData) {
                    // Trigger updates for other AIs based on the new drawing
                    this.handleDrawingUpdate(drawingData);
                } else {
                    this.callbacks.sendSystemMessage(`AI player ${this.callbacks.getPlayers().get(drawerId)?.username || drawerId} had trouble drawing`, true);
                }
            } catch (error) {
                console.error(`Room ${this.roomCode}| Error during AI ${drawerId} drawing action:`, error);
                this.callbacks.sendSystemMessage(`AI player encountered an error while drawing.`, true);
                this.callbacks.setDrawingData(FALLBACK_BLANK_IMAGE); // Fallback on error
            } finally {
                this.aiDrawingTimer = null; // Clear timer ref after execution/error
            }
        }, this.aiTiming.drawingTime);

        this.aiDrawingTimer = timerId; // Store timer ref
    }

    async getAIDrawingConcept(aiPlayerId) {
        try {
            const aiDetails = await this.callbacks.getAIDetails(aiPlayerId);
            if (!aiDetails) throw new Error("AI details not found");
            const chatHistory = await this.callbacks.getChatHistory();

            const prompt = promptBuilder.buildAIDrawingConceptPrompt(
                chatHistory,
                aiDetails.username,
                aiDetails.corePersonalityPrompt
            );
            const result = await this.callbacks.requestGeminiText(prompt);
            return result?.text?.trim() || null;
        } catch (error) {
            console.error(`Room ${this.roomCode}| Error getting AI drawing concept for ${aiPlayerId}:`, error);
            return null;
        }
    }

    async createAIDrawing(aiPlayerId) {
        try {
            const doodlePrompt = promptBuilder.buildAIDrawingCreationPrompt();
            const result = await this.callbacks.requestGeminiImage(doodlePrompt);

            if (result && result.imageData) {
                return `data:image/png;base64,${result.imageData}`;
            }
            return null;
        } catch (error) {
            console.error(`Room ${this.roomCode}| Error creating AI drawing image for ${aiPlayerId}:`, error);
            return null;
        }
    }

    scheduleAIGuessesAndChats(drawingData) {
        if (this.gameState !== 'drawing') return; // Only schedule during drawing phase

        const now = Date.now();
        const roundEndTime = this.callbacks.getTimerEndTime('roundEnd') || 0;
        const timeLeft = roundEndTime - now;

        // Don't schedule if very little time left
        if (timeLeft <= Math.max(this.aiTiming.minGuessTime, 5000)) return;

        this.aiPlayers.forEach((aiData, aiPlayerId) => {
            if (aiPlayerId === this.currentDrawerId) return; // Drawer doesn't guess/chat

            const timeSinceLastGuess = now - (aiData.lastGuessTime || 0);
            const timeSinceLastChat = now - (aiData.lastChatTime || 0);
            const isFirstChat = aiData.lastChatTime === 0;
            const hasChattedButNotGuessed = aiData.lastChatTime > 0 && aiData.lastGuessTime === 0;

            // --- Schedule First Chat (2-7 seconds after drawing starts) ---
            if (isFirstChat && !this.aiChatTimers.has(aiPlayerId)) {
                const firstChatDelay = this.aiTiming.firstChatMinTime +
                    Math.random() * (this.aiTiming.firstChatMaxTime - this.aiTiming.firstChatMinTime);

                if (now + firstChatDelay < roundEndTime - 1000) {
                    const timerId = setTimeout(() => {
                        if (this.gameState === 'drawing' && this.aiPlayers.has(aiPlayerId)) {
                            this.makeAIChat(aiPlayerId, drawingData);
                        }
                        this.aiChatTimers.delete(aiPlayerId);
                    }, firstChatDelay);
                    this.setAITimer(aiPlayerId, 'chat', timerId);
                }
            }
            // --- Schedule First Guess (3-8 seconds after first chat) ---
            else if (hasChattedButNotGuessed && !this.aiGuessTimers.has(aiPlayerId)) {
                const firstGuessDelay = this.aiTiming.firstGuessMinTime +
                    Math.random() * (this.aiTiming.firstGuessMaxTime - this.aiTiming.firstGuessMinTime);

                if (now + firstGuessDelay < roundEndTime - 1000) {
                    const timerId = setTimeout(() => {
                        if (this.gameState === 'drawing' && this.aiPlayers.has(aiPlayerId)) {
                            this.makeAIGuess(aiPlayerId, drawingData);
                        }
                        this.aiGuessTimers.delete(aiPlayerId);
                    }, firstGuessDelay);
                    this.setAITimer(aiPlayerId, 'guess', timerId);
                }
            }
            // --- Schedule Regular Guesses ---
            else if (aiData.lastGuessTime > 0 && timeSinceLastGuess > this.aiTiming.guessInterval && !this.aiGuessTimers.has(aiPlayerId)) {
                const guessDelay = this.aiTiming.minGuessTime + Math.random() * (this.aiTiming.maxGuessTime - this.aiTiming.minGuessTime);
                if (now + guessDelay < roundEndTime - 1000) { // Ensure it happens before round ends
                    const timerId = setTimeout(() => {
                        // Check state again inside timeout
                        if (this.gameState === 'drawing' && this.aiPlayers.has(aiPlayerId)) {
                            this.makeAIGuess(aiPlayerId, drawingData);
                        }
                        this.aiGuessTimers.delete(aiPlayerId);
                    }, guessDelay);
                    this.setAITimer(aiPlayerId, 'guess', timerId);
                }
            }

            // --- Schedule Regular Chats ---
            // Only for non-first chats, using longer intervals (10-20s)
            if (!isFirstChat && timeSinceLastChat >
                (this.aiTiming.chatIntervalMin + Math.random() * (this.aiTiming.chatIntervalMax - this.aiTiming.chatIntervalMin)) &&
                !this.aiChatTimers.has(aiPlayerId) && Math.random() < this.aiTiming.chatProbability) {

                const chatDelay = 1000 + Math.random() * 3000; // Chat relatively quickly after interval
                if (now + chatDelay < roundEndTime - 1000) {
                    const timerId = setTimeout(() => {
                        if (this.gameState === 'drawing' && this.aiPlayers.has(aiPlayerId)) {
                            this.makeAIChat(aiPlayerId, drawingData);
                        }
                        this.aiChatTimers.delete(aiPlayerId);
                    }, chatDelay);
                    this.setAITimer(aiPlayerId, 'chat', timerId);
                }
            }
        });
    }

    // Called by resetAIPlayerGuessTimers via the lastChanceTimer
    triggerAILastChanceGuesses(drawingData) {
        if (this.gameState !== 'drawing') return; // Ensure still drawing

        console.log(`Room ${this.roomCode}| Triggering AI last chance guesses.`);
        const now = Date.now();
        this.aiPlayers.forEach((aiData, aiPlayerId) => {
            if (aiPlayerId === this.currentDrawerId) return;

            // Only trigger if AI hasn't guessed recently (e.g., in last 50% of round duration)
            if (now - (aiData.lastGuessTime || 0) > this.roundDuration * 0.5) {
                this.clearAITimer(aiPlayerId, 'guess'); // Clear any pending regular guess

                const lastChanceDelay = this.aiTiming.lastChanceGuessDelayMin + Math.random() * (this.aiTiming.lastChanceGuessDelayMax - this.aiTiming.lastChanceGuessDelayMin);
                const timerId = setTimeout(() => {
                        if (this.gameState === 'drawing' && this.aiPlayers.has(aiPlayerId)) {
                        this.makeAIGuess(aiPlayerId, drawingData);
                        }
                    this.aiGuessTimers.delete(aiPlayerId);
                }, lastChanceDelay);
                this.setAITimer(aiPlayerId, 'guess', timerId);
            }
        });
    }

    async makeAIGuess(aiPlayerId, drawingData) {
        const aiData = this.aiPlayers.get(aiPlayerId);
        // Ensure AI still exists and we are in drawing phase
        if (!aiData || this.gameState !== 'drawing') {
            this.aiGuessTimers.delete(aiPlayerId); // Clean up timer ref if state is wrong
            return;
        }

        try {
            const aiDetails = await this.callbacks.getAIDetails(aiPlayerId);
            if (!aiDetails) throw new Error("AI details not found for guess");
            const chatHistory = await this.callbacks.getChatHistory();

            const guessPrompt = this.customGuessPrompt;

            const prompt = promptBuilder.buildAIGuessPrompt(
                chatHistory,
                aiDetails.username,
                aiDetails.corePersonalityPrompt,
                guessPrompt
            );

            const result = await this.callbacks.requestGeminiText(prompt, drawingData);
            let guess = result?.text?.trim();

            if (guess) {
                aiData.lastGuessTime = Date.now();
                guess = this.callbacks.sanitizeMessage(guess, PROMPT_CONFIG.CHAT_CHARS);
                const handledResult = this.handlePlayerCommand(aiPlayerId, 'g', guess);
                if (handledResult.handled && handledResult.isGuess) {
                    // If handled successfully, tell server to broadcast the guess message
                    this.callbacks.sendPlayerMessage(aiPlayerId, handledResult.displayMessage, true);
                }
            } else {
                console.warn(`Room ${this.roomCode}| AI ${aiPlayerId} failed to generate a guess text.`);
            }
        } catch (error) {
            console.error(`Room ${this.roomCode}| Error making AI guess for ${aiPlayerId}:`, error);
        } finally {
            // Ensure timer ref is cleared even if AI call fails
            this.aiGuessTimers.delete(aiPlayerId);
        }
    }

    async makeAIChat(aiPlayerId, drawingData) {
        const aiData = this.aiPlayers.get(aiPlayerId);
        // Ensure AI still exists and we are in drawing phase
        if (!aiData || this.gameState !== 'drawing') {
            this.aiChatTimers.delete(aiPlayerId);
            return;
        }

        try {
            const aiDetails = await this.callbacks.getAIDetails(aiPlayerId);
            if (!aiDetails) throw new Error("AI details not found for chat");
            const chatHistory = await this.callbacks.getChatHistory();

            const chatPrompt = this.customChatPrompt;

            const prompt = promptBuilder.buildAIChatPrompt(
                chatHistory,
                aiDetails.username,
                aiDetails.corePersonalityPrompt,
                chatPrompt
            );

            const result = await this.callbacks.requestGeminiText(prompt, drawingData);
            const message = result?.text?.trim();

            if (message) {
                aiData.lastChatTime = Date.now();
                // Send chat message directly via server callback
                this.callbacks.sendPlayerMessage(aiPlayerId, message, false);
            } else {
                console.warn(`Room ${this.roomCode}| AI ${aiPlayerId} failed to generate a chat message.`);
            }
        } catch (error) {
            console.error(`Room ${this.roomCode}| Error making AI chat for ${aiPlayerId}:`, error);
        } finally {
            this.aiChatTimers.delete(aiPlayerId);
        }
    }

    scheduleAIPlayerVotes() {
        if (this.gameState !== 'voting' || this.generatedImages.length === 0) return;

        console.log(`Room ${this.roomCode}| Scheduling AI votes.`);
        this.aiPlayers.forEach((aiData, aiPlayerId) => {
            if (aiPlayerId === this.currentDrawerId) return; // Drawer doesn't vote

            const delay = this.aiTiming.voteDelayMin + Math.random() * (this.aiTiming.voteDelayMax - this.aiTiming.voteDelayMin);

            const timerId = setTimeout(async () => {
                // Check if voting is still active and AI exists
                if (this.gameState !== 'voting' || !this.aiPlayers.has(aiPlayerId)) {
                    this.aiVoteTimers.delete(aiPlayerId);
                    return;
                }

                try {
                    const aiDetails = await this.callbacks.getAIDetails(aiPlayerId);
                    if (!aiDetails) throw new Error("AI details not found for voting");
                    const chatHistory = await this.callbacks.getChatHistory();

                    const prompt = promptBuilder.buildAIVotingPrompt(
                        chatHistory,
                        aiDetails.username,
                        aiDetails.corePersonalityPrompt,
                        this.generatedImages // Pass image data for context
                    );

                    const result = await this.callbacks.requestGeminiText(prompt);
                    const responseText = result?.text?.trim();

                    let voteIndex = -1;
                    let message = responseText || "I wasn't sure what to say about my vote!"; // Default message

                    if (responseText) {
                        try {
                            // Improved parsing: look for vote number, then reason
                            const voteMatch = responseText.match(/Vote:\s*(\d+)/i);
                            if (voteMatch && voteMatch[1]) {
                                const voteNum = parseInt(voteMatch[1], 10);
                                if (voteNum >= 1 && voteNum <= this.generatedImages.length) {
                                    voteIndex = voteNum - 1;
                                }
                            }

                            const reasonMatch = responseText.match(/Reason:\s*([\s\S]+)/i); // Capture multi-line reasons
                            if (reasonMatch && reasonMatch[1]) {
                                message = reasonMatch[1].trim();
                            } else if (voteIndex !== -1) {
                                // If vote found but no explicit reason, maybe remove the "Vote: X" part
                                message = responseText.replace(/Vote:\s*\d+\s*/i, '').trim();
                            } // else use full response text

                        } catch (parseError) {
                            console.error(`Room ${this.roomCode}| Error parsing AI vote response: ${parseError}`);
                            // Fallback to random vote if parsing fails and images exist
                            if (this.generatedImages.length > 0) {
                                voteIndex = Math.floor(Math.random() * this.generatedImages.length);
                                message = "Hmm, deciding is hard... I'll just pick this one!";
                            }
                        }
                    } else {
                        // Fallback if Gemini returned nothing
                        if (this.generatedImages.length > 0) {
                            voteIndex = Math.floor(Math.random() * this.generatedImages.length);
                        }
                    }

                    // If a valid vote was determined
                    if (voteIndex !== -1) {
                        const votedForPlayerId = this.generatedImages[voteIndex].playerId;
                        // Send chat message (reason/comment)
                        this.callbacks.sendPlayerMessage(aiPlayerId, message, false);
                        // Submit the vote via the standard handler
                        this.handleVote(aiPlayerId, votedForPlayerId);
                    } else {
                        console.warn(`Room ${this.roomCode}| AI ${aiPlayerId} failed to determine a valid vote index.`);
                        this.callbacks.sendPlayerMessage(aiPlayerId, "I couldn't decide who to vote for!", false);
                    }

                } catch (error) {
                    console.error(`Room ${this.roomCode}| Error during AI vote action for ${aiPlayerId}:`, error);
                    this.callbacks.sendPlayerMessage(aiPlayerId, "I had trouble voting...", false);
                } finally {
                    this.aiVoteTimers.delete(aiPlayerId); // Clear timer ref
                }
            }, delay);

            this.setAITimer(aiPlayerId, 'vote', timerId); // Store ref
        });
    }

    // --- Utility Methods ---

    addPlayer(playerId, playerData) {
        // Store only game-specific state needed by this module
        this.players.set(playerId, {
            score: playerData.score || 0,
        });

        if (playerData.isAI) {
            this.aiPlayers.set(playerId, {
                lastGuessTime: 0,
                lastChatTime: 0,
            });
        }
        console.log(`Room ${this.roomCode}| Player ${playerData.username} added to game logic. Total: ${this.players.size}, AI: ${this.aiPlayers.size}`);
    }

    removePlayer(playerId) {
        let wasAI = false;
        this.players.delete(playerId);
        if (this.aiPlayers.has(playerId)) {
            this.clearAllAITimersForPlayer(playerId); // Crucial: stop pending actions
            this.aiPlayers.delete(playerId);
            wasAI = true;
        }
        // Clear any pending guesses/votes from the leaving player
        this.lastGuesses.delete(playerId);
        this.votes.delete(playerId);

        console.log(`Room ${this.roomCode}| Player removed from game logic: ${playerId}. Remaining: ${this.players.size}, AI: ${this.aiPlayers.size}`);
    }

    getPlayerCount() {
        return this.players.size;
    }

    getHumanPlayerCount() {
        // Calculate based on the difference between total players and known AI players
        return this.players.size - this.aiPlayers.size;
    }

    checkVotingComplete() {
        if (this.gameState !== 'voting') return; // Only check during voting

        const serverPlayers = this.callbacks.getPlayers();
        const potentialVoters = serverPlayers.size - (serverPlayers.has(this.currentDrawerId) ? 1 : 0);

        // Check if the number of votes received equals the number of players eligible to vote
        if (this.votes.size >= potentialVoters && potentialVoters > 0) {
            console.log(`Room ${this.roomCode}| All expected votes received (${this.votes.size}/${potentialVoters}). Ending voting early.`);
            this.tallyVotes(); // End voting immediately
        }
    }

    getGameStateSnapshot() {
        // Provide the necessary data for the server to construct the 'gameState' event
        return {
            currentDrawerId: this.currentDrawerId,
            round: this.round,
            // Client often just needs a boolean 'voting' flag for UI state
            voting: this.gameState === 'voting',
            // Provide the detailed internal state name as well
            gameState: this.gameState
        };
    }

    updateCustomPrompts(prompts) {
        if (prompts.imagePrompt) {
            this.customImageGenPrompt = prompts.imagePrompt;
        }
        if (prompts.chatPrompt) {
            this.customChatPrompt = prompts.chatPrompt;
        }
        if (prompts.guessPrompt) {
            this.customGuessPrompt = prompts.guessPrompt;
        }
    }

    // --- AI Timer Management ---

    setAITimer(aiPlayerId, timerType, timerId) {
        // Ensure AI still exists before setting timer
        if (!this.aiPlayers.has(aiPlayerId)) {
            clearTimeout(timerId); // Clear immediately if AI is gone
            return;
        }
        // Clear existing timer of the same type before setting new one
        this.clearAITimer(aiPlayerId, timerType);

        // Store the new timer ID
        switch (timerType) {
                case 'guess': this.aiGuessTimers.set(aiPlayerId, timerId); break;
                case 'chat': this.aiChatTimers.set(aiPlayerId, timerId); break;
                case 'vote': this.aiVoteTimers.set(aiPlayerId, timerId); break;
                case 'drawing': this.aiDrawingTimer = timerId; break; // Special case for single drawer
                default: console.warn(`Room ${this.roomCode}| Unknown AI timer type: ${timerType}`);
        }
    }

    clearAITimer(aiPlayerId, timerType) {
        let timerId;
        let timerMap;

        switch (timerType) {
                case 'guess': timerMap = this.aiGuessTimers; break;
                case 'chat': timerMap = this.aiChatTimers; break;
                case 'vote': timerMap = this.aiVoteTimers; break;
                case 'drawing': // Special case
                    if (this.aiDrawingTimer) {
                        clearTimeout(this.aiDrawingTimer);
                        this.aiDrawingTimer = null;
                    }
                    return; // Handled drawing timer
                default: return; // Unknown type
        }

        if (timerMap && timerMap.has(aiPlayerId)) {
            timerId = timerMap.get(aiPlayerId);
            clearTimeout(timerId);
            timerMap.delete(aiPlayerId);
        }
    }

    // Clears all *action* timers for a specific AI (guess, chat, vote)
    clearAllAITimersForPlayer(aiPlayerId) {
        this.clearAITimer(aiPlayerId, 'guess');
        this.clearAITimer(aiPlayerId, 'chat');
        this.clearAITimer(aiPlayerId, 'vote');
        // Clear drawing timer only if this AI was the one scheduled to draw
        if (this.currentDrawerId === aiPlayerId && this.aiDrawingTimer) {
            this.clearAITimer(aiPlayerId, 'drawing');
        }
    }

    // Clears all AI timers (actions for all AIs + last chance timer)
    clearAllAITimers() {
        this.aiPlayers.forEach((_, aiPlayerId) => {
            this.clearAllAITimersForPlayer(aiPlayerId);
        });
        // Clear the shared timers managed by the game instance
        if (this.lastChanceTimer) {
            clearTimeout(this.lastChanceTimer);
            this.lastChanceTimer = null;
        }
        if (this.aiDrawingTimer) { // Ensure drawer timer is cleared if active
            clearTimeout(this.aiDrawingTimer);
            this.aiDrawingTimer = null;
        }
        console.log(`Room ${this.roomCode}| Cleared all AI action timers.`);
    }

    // Called at the start of a turn to reset AI state and schedule the last chance check
    resetAIPlayerGuessTimers() {
        // Clear any pending actions from previous turn/phase
        this.clearAllAITimers();

        // Reset last action timestamps for all AIs
        this.aiPlayers.forEach(aiData => {
            aiData.lastGuessTime = 0;
            aiData.lastChatTime = 0;
        });

        // Schedule the timer that will trigger the last chance guesses
        const roundEndTime = this.callbacks.getTimerEndTime('roundEnd') || 0;
        const lastChanceTriggerDelay = roundEndTime - Date.now() - (this.aiTiming.lastChanceTime * 1000);

        if (lastChanceTriggerDelay > 1000) { // Only schedule if there's reasonable time left
            console.log(`Room ${this.roomCode}| Scheduling AI last chance check in ${lastChanceTriggerDelay.toFixed(0)}ms.`);
            this.lastChanceTimer = setTimeout(async () => {
                // Check game state before triggering
                if (this.gameState === 'drawing') {
                    const drawingData = await this.callbacks.getDrawingData(); // Fetch current drawing
                    if (drawingData) {
                        this.triggerAILastChanceGuesses(drawingData);
                    }
                }
                this.lastChanceTimer = null; // Clear ref after execution
            }, lastChanceTriggerDelay);
        } else {
            console.log(`Room ${this.roomCode}| Not scheduling AI last chance check (too little time left).`);
        }
    }

    // Called by server when the room is ending or game is stopped
    cleanup() {
        console.log(`Room ${this.roomCode}| Cleaning up ImageinaryGame instance resources.`);
        this.gameState = 'ended';
        // Stop all pending AI actions and game phase timers
        this.clearAllAITimers();
        this.callbacks.clearTimer('roundEnd');
        this.callbacks.clearTimer('votingEnd');
        this.callbacks.clearTimer('resultsEnd');
        // Clear internal state maps
        this.players.clear();
        this.aiPlayers.clear();
        this.lastGuesses.clear();
        this.votes.clear();
        this.generatedImages = [];
        console.log(`Room ${this.roomCode}| ImageinaryGame cleanup complete.`);
    }
}

module.exports = ImageinaryGame;