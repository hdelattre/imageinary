// Zoob.js
const zoobPromptBuilder = require('./zoobPromptBuilder');

// --- Constants ---
const INPUT_DURATION_SECONDS = 40; // Time for players to input actions
const VOTING_DURATION_SECONDS = 15; // Time for players to vote
const RESULTS_DURATION_SECONDS = 10; // Time to show winning action before next round starts
const MAX_HISTORY_LENGTH = 25; // Maximum number of entries to keep in history

// AI timing constants similar to imageinary.js
const AI_TIMING = {
    firstChatMinTime: 3500,  // ms minimum time for first chat after round starts
    firstChatMaxTime: 10000,  // ms maximum time for first chat after round starts
    actionMinTime: 15000,     // ms minimum time before AI suggests an action
    actionMaxTime: 18000,    // ms maximum time before AI suggests an action
    chatIntervalMin: 10000,  // ms minimum time between chats
    chatIntervalMax: 20000,  // ms maximum time between chats
    chatProbability: 0.4,    // Chance to chat after sufficient interval
    voteDelayMin: 2000,      // ms minimum delay before AI votes
    voteDelayMax: 8000       // ms maximum delay before AI votes
};

const INITIAL_WORLD_STATE = {
    description: "You are standing in an open field west of a white house, with a boarded front door. There is a small mailbox here.",
    imagePrompt: "Illustration of an open field west of a white house with a boarded front door, small mailbox nearby, daytime, fantasy art style.", // Initial image prompt
    imageSrc: null, // Will be generated on game start
    history: [],
    inventory: []
};

const MAX_ACTION_RESULTS = 8; // Limit how many actions we generate/show to prevent overload
// Use a slightly more descriptive fallback image if possible, or keep the minimal one
const FALLBACK_BLANK_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwAB/aurH8kAAAAASUVORK5CYII='; // 1x1 white pixel

class ZoobGame {
    constructor(roomCode, io, initialPlayers, gameConfig, callbacks) {
        this.roomCode = roomCode;
        // this.io = io; // Keep reference if direct emits are ever needed
        this.players = new Map(); // Map<playerId, { score: number }> - Score might be votes received? TBD
        this.aiPlayers = new Map(); // Map<aiPlayerId, { lastChatTime: number, lastActionTime: number }>
        this.callbacks = callbacks; // Functions provided by server.js

        // --- Game State ---
        this.round = 1;
        this.gameState = 'initializing'; // 'initializing', 'describing', 'input', 'generatingActions', 'voting', 'generatingResult', 'results', 'ended'

        // World State
        this.worldDescription = INITIAL_WORLD_STATE.description;
        this.worldImageSrc = INITIAL_WORLD_STATE.imageSrc; // Initially null
        this.history = [...INITIAL_WORLD_STATE.history];
        this.inventory = [...INITIAL_WORLD_STATE.inventory]; // Shared inventory

        // Round State (cleared each round)
        this.playerActions = new Map();   // Map<playerId, actionPromptString>
        this.actionResults = [];        // Array of { playerId, playerName, actionPrompt, resultText, resultImageSrc, failed }
        this.votes = new Map();           // Map<voterPlayerId, votedForPlayerId> // votedForPlayerId is the ID of the player whose action was voted for
        this.winningActionData = null;    // Stores the { playerId, actionPrompt } of the winning action

        // --- AI Timers ---
        this.aiChatTimers = new Map();    // Map<aiPlayerId, timerId>
        this.aiActionTimers = new Map();  // Map<aiPlayerId, timerId>
        this.aiVoteTimers = new Map();    // Map<aiPlayerId, timerId>

        // --- Configuration ---
        this.inputDuration = (gameConfig.inputDuration || INPUT_DURATION_SECONDS) * 1000;
        this.votingDuration = (gameConfig.votingDuration || VOTING_DURATION_SECONDS) * 1000;
        this.resultsDuration = (gameConfig.resultsDuration || RESULTS_DURATION_SECONDS) * 1000;
        this.aiTiming = { ...AI_TIMING, ...(gameConfig.aiTiming || {}) }; // Use defaults with custom overrides
        // Add other config if needed (e.g., image style)
        this.imageStyle = gameConfig.imageStyle || "fantasy illustration"; // Default style

        // Initialize players
        initialPlayers.forEach((playerData, playerId) => {
            this.addPlayer(playerId, playerData);
        });

        // Initial generation of the starting scene image - slight delay
        setTimeout(() => this.initializeGame(), 100);
    }

    updateCustomPrompts(prompts) {
        if (prompts.worldDescription) {
            this.worldDescription = prompts.worldDescription;
        }
    }

    // --- Core Game Flow Methods ---

    async initializeGame() {
        console.log(`Room ${this.roomCode}| Initializing Zoob...`);
        // Prevent re-initialization
        if (this.gameState !== 'initializing') {
            console.log(`Room ${this.roomCode}| Initialization already completed or in progress.`);
            return;
        }

        try {
            // Generate initial image for the starting description using the image-only prompt
            const initialImagePrompt = zoobPromptBuilder.buildImagePrompt(INITIAL_WORLD_STATE.description, this.imageStyle);
            // Request image generation
            const imageResult = await this.callbacks.requestGeminiImage(initialImagePrompt);

            if (imageResult && imageResult.imageData) {
                this.worldImageSrc = `data:image/png;base64,${imageResult.imageData}`;
                console.log(`Room ${this.roomCode}| Initial world image generated.`);
            } else {
                console.warn(`Room ${this.roomCode}| Failed to generate initial world image. Using fallback.`);
                // Use the defined fallback image
                this.worldImageSrc = FALLBACK_BLANK_IMAGE;
            }

            this.gameState = 'describing'; // Mark initialization complete
            this.startRound(); // Start the first round

        } catch (error) {
            console.error(`Room ${this.roomCode}| Error initializing game:`, error);
            this.callbacks.sendSystemMessage("Error setting up the game world. Please try again later.", true);
            this.gameState = 'ended';
            this.callbacks.updateGameState();
        }
    }


    startRound() {
        // *** Ensure game is initialized before starting a round ***
        if (this.gameState === 'initializing') {
            console.log(`Room ${this.roomCode}| Waiting for initialization before starting round.`);
            return;
        }
        console.log(`Room ${this.roomCode}| Starting Zoob Round ${this.round}`);
        this.gameState = 'describing'; // Indicate we're setting the scene
        // Reset round-specific state
        this.playerActions.clear();
        this.actionResults = [];
        this.votes.clear();
        this.winningActionData = null;

        // Update players with the current world state (including the potentially generated initial image)
        this.callbacks.emitToRoom('zoobWorldUpdate', {
            description: this.worldDescription,
            imageSrc: this.worldImageSrc,
            inventory: this.inventory
        });

        // Add a friendly system message about starting a new round
        if (this.round > 1) {
            this.callbacks.sendSystemMessage(`🧙‍♂️ Beginning round ${this.round} of your adventure!`, true);
        } else {
            this.callbacks.sendSystemMessage(`🧙‍♂️ Welcome to  Zoob! Your text adventure begins now.`, true);
        }

        // Wait a tiny bit for the update to render, then start input
        setTimeout(() => this.startInputPhase(), 100);
    }

    startInputPhase() {
        // Prevent starting input if not in the correct preceding state
        if (this.gameState !== 'describing') {
            console.warn(`Room ${this.roomCode}| Attempted to start input phase from invalid state: ${this.gameState}`);
            return;
        }
        console.log(`Room ${this.roomCode}| Entering input phase.`);
        this.gameState = 'input';
        this.callbacks.updateGameState(); // Sync state like gameState name

        // Format inventory more attractively
        let inventoryString;
        if (this.inventory.length === 0) {
            inventoryString = "📦 Inventory: Empty";
        } else {
            inventoryString = `📦 Inventory: ${this.inventory.join(', ')}`;
        }

        this.callbacks.sendSystemMessage(`Round ${this.round}. ${this.worldDescription}\n\n${inventoryString}\n\n🔍 What do you do?`, true);

        // Start timer for player input
        this.callbacks.startTimer(this.inputDuration, 'inputEnd');
        this.callbacks.emitToRoom('startDisplayTimer', this.inputDuration / 1000); // Show timer on client

        // Schedule AI chats and actions
        this.clearAllAITimers(); // Clear any lingering timers first
        this.aiPlayers.forEach((aiData, aiPlayerId) => {
            // Reset timestamps for new round
            aiData.lastChatTime = 0;
            aiData.lastActionTime = 0;

            // Schedule initial AI interactions
            this.scheduleAIChat(aiPlayerId);
            this.scheduleAIAction(aiPlayerId);
        });
    }

    async endInputPhase() {
        if (this.gameState !== 'input') return; // Prevent duplicate calls

        console.log(`Room ${this.roomCode}| Input phase ended. Generating action results...`);
        this.callbacks.clearTimer('inputEnd'); // Clear the input timer
        this.gameState = 'generatingActions';
        this.callbacks.updateGameState();
        this.callbacks.emitToRoom('stopDisplayTimer'); // Clear client timer

        if (this.playerActions.size === 0) {
            this.callbacks.sendSystemMessage("🧙‍♂️ No actions submitted this round. The world remains unchanged.", true);
            this.round++;
            this.startRound();
            return;
        }

        const actionCount = this.playerActions.size;
        this.callbacks.sendSystemMessage(`🧙‍♂️ Time's up! Received ${actionCount} action${actionCount !== 1 ? 's' : ''} to process. Imagining the possibilities...`, true);

        const actionPromises = [];
        const serverPlayers = this.callbacks.getPlayers();
        const actionsToProcess = Array.from(this.playerActions.entries()).slice(0, MAX_ACTION_RESULTS);

        if (actionsToProcess.length < this.playerActions.size) {
            this.callbacks.sendSystemMessage(`🧙‍♂️ (Due to magical constraints, I'll be processing the first ${MAX_ACTION_RESULTS} actions only)`, true);
        }

        for (const [playerId, actionPrompt] of actionsToProcess) {
            const playerData = serverPlayers.get(playerId);
            if (!playerData) continue;

            actionPromises.push(
                this.generateSingleActionResult(playerId, playerData.username, actionPrompt)
            );
        }

        try {
            const results = await Promise.allSettled(actionPromises);
            this.actionResults = results.filter(res => res.value != null).map(res => res.value);

            if (this.actionResults.length === 0) {
                // This case should be rare now due to fallbacks in generateSingleActionResult
                this.callbacks.sendSystemMessage("Failed to generate results for any actions this round.", true);
                this.round++;
                this.startRound();
                return;
            }

            this.startVotingPhase();

        } catch (error) {
            console.error(`Room ${this.roomCode}| Error generating action results batch:`, error);
            this.callbacks.sendSystemMessage("An error occurred while processing actions.", true);
            this.round++;
            this.startRound();
        }
    }

    async generateSingleActionResult(playerId, playerName, actionPrompt) {
        try {
            console.log(`Room ${this.roomCode}| Generating result for ${playerName}: "${actionPrompt}"`);

            // Get chat history for context
            const chatHistory = await this.callbacks.getChatHistory();

            // Create history entries array for the prompt builder
            const historyEntries = [];

            // Add stored world state updates to history
            if (this.history && this.history.length > 0) {
                this.history.forEach(entry => {
                    historyEntries.push(entry);
                });
            }

            // Add recent chat messages
            if (chatHistory && chatHistory.length > 0) {
                chatHistory.forEach(message => {
                    if (message.isSystem) {
                        // Skip system messages about voting or game mechanics
                        if (!message.content.includes('votes') &&
                            !message.content.includes('submitted an action') &&
                            !message.content.includes('Time to vote') &&
                            !message.content.includes('Time\'s up')) {
                            historyEntries.push({
                                type: 'world',
                                content: message.content
                            });
                        }
                    } else {
                        historyEntries.push({
                            type: 'chat',
                            username: message.username,
                            content: message.content
                        });
                    }
                });
            }

            // Limit history to most recent entries
            const recentHistory = historyEntries.slice(-MAX_HISTORY_LENGTH);

            // Step 1: Generate the text description only first
            const textPrompt = zoobPromptBuilder.buildActionResultTextPrompt(
                this.worldDescription, this.inventory, actionPrompt, playerName, recentHistory
            );

            // Request text-only description
            const textResult = await this.callbacks.requestGeminiText(textPrompt, null);

            if (!textResult || !textResult.text) {
                throw new Error("Failed to generate text description for action");
            }

            const actionDescription = textResult.text.trim();

            // Step 2: Generate the image based on the text description
            const imagePrompt = zoobPromptBuilder.buildActionImageFromTextPrompt(
                actionDescription, this.imageStyle
            );

            // Request image based on the text description
            const imageResult = await this.callbacks.requestGeminiImage(imagePrompt);

            if (imageResult && imageResult.imageData) {
                // Success case - both text and image were generated successfully
                return {
                    playerId,
                    playerName,
                    actionPrompt,
                    resultText: actionDescription,
                    resultImageSrc: `data:image/png;base64,${imageResult.imageData}`,
                    failed: false // Explicitly mark as success
                };
            } else {
                // Partial success - text generated but image failed
                console.warn(`Room ${this.roomCode}| Failed to generate image for ${playerName}'s action. Using text only.`);
                return {
                    playerId,
                    playerName,
                    actionPrompt,
                    resultText: actionDescription,
                    resultImageSrc: FALLBACK_BLANK_IMAGE, // Use defined fallback
                    failed: false // Not marking as failed since we have text
                };
            }
        } catch (error) {
            // Error case (exception during generation/callback)
            console.error(`Room ${this.roomCode}| Error in generateSingleActionResult for ${playerId}:`, error);
            return {
                playerId,
                playerName,
                actionPrompt,
                resultText: `(An error occurred trying to '${actionPrompt}')`,
                resultImageSrc: FALLBACK_BLANK_IMAGE, // Use defined fallback
                failed: true // Mark as failed
            };
        }
    }

    startVotingPhase() {
        // Should only be called from endInputPhase after generation
        if (this.gameState !== 'generatingActions' || this.actionResults.length === 0) {
            console.warn(`Room ${this.roomCode}| Attempted to start voting phase from invalid state or with no results.`);
            return;
        }

        console.log(`Room ${this.roomCode}| Starting voting phase.`);
        this.gameState = 'voting';
        this.votes.clear();

        // Send results to clients
        this.callbacks.emitToRoom('zoobActionResults', this.actionResults);

        this.callbacks.startTimer(this.votingDuration, 'votingEnd');
        this.callbacks.emitToRoom('startDisplayTimer', this.votingDuration / 1000);

        // More engaging voting message
        const voteCountdown = Math.floor(this.votingDuration / 1000);
        this.callbacks.sendSystemMessage(`🔮 Choose your path! ${this.actionResults.length} possible futures await. You have ${voteCountdown} seconds to vote for the action you want the group to take!`, true);
        this.callbacks.updateGameState();

        // Schedule AI voting
        this.clearAllAITimers(); // Clear any lingering timers first
        this.scheduleAIVotes();
    }

    tallyVotes() {
        if (this.gameState !== 'voting') return;
        console.log(`Room ${this.roomCode}| Tallying Zoob votes.`);
        this.gameState = 'generatingResult';
        this.callbacks.clearTimer('votingEnd');
        this.callbacks.emitToRoom('stopDisplayTimer');

        // Announce vote counting
        const voteCount = this.votes.size;
        this.callbacks.sendSystemMessage(`🧮 Time's up! Counting ${voteCount} vote${voteCount !== 1 ? 's' : ''}...`, true);

        const voteCounts = new Map();
        // *** Initialize vote counts ONLY for non-failed actions ***
        this.actionResults.forEach(result => {
            if (!result.failed) {
                voteCounts.set(result.playerId, 0);
            }
        });

        // Tally votes only for players whose actions were successfully generated
        this.votes.forEach((votedForPlayerId) => {
            if (voteCounts.has(votedForPlayerId)) { // Check if the voted action is in the valid map
                voteCounts.set(votedForPlayerId, voteCounts.get(votedForPlayerId) + 1);
            }
        });

        let maxVotes = -1; // Start at -1 to handle zero votes correctly
        voteCounts.forEach(count => {
            if (count > maxVotes) {
                maxVotes = count;
            }
        });

        const winningPlayerIds = [];
        // Make sure we have a non-negative maxVotes before proceeding
        if (maxVotes >= 0) {
            voteCounts.forEach((count, playerId) => {
                if (count === maxVotes) {
                    winningPlayerIds.push(playerId);
                }
            });
        }

        let winnerPlayerId;
        let winningActionPrompt;
        let noValidWinner = false;

        if (winningPlayerIds.length === 0) {
            // No votes cast, or only votes for players whose actions failed initially.
            // Pick a random *non-failed* action if possible.
            const validActions = this.actionResults.filter(r => !r.failed);
            if (validActions.length > 0) {
                console.log(`Room ${this.roomCode}| No decisive votes. Picking random valid action.`);
                const randomWinner = validActions[Math.floor(Math.random() * validActions.length)];
                winnerPlayerId = randomWinner.playerId;
                // winningActionPrompt = randomWinner.actionPrompt; // Get prompt below
            } else {
                // All actions shown must have failed generation - edge case
                console.warn(`Room ${this.roomCode}| All action generations failed. Cannot determine winner.`);
                noValidWinner = true;
            }
        } else if (winningPlayerIds.length === 1) {
            winnerPlayerId = winningPlayerIds[0];
        } else {
            console.log(`Room ${this.roomCode}| Vote tie. Picking random winner.`);
            winnerPlayerId = winningPlayerIds[Math.floor(Math.random() * winningPlayerIds.length)];
        }

        // Get the prompt even if picked randomly (if not noValidWinner)
        if (!noValidWinner) {
            const winnerAction = this.actionResults.find(r => r.playerId === winnerPlayerId);
            if (winnerAction) {
                winningActionPrompt = winnerAction.actionPrompt; // Found the winning prompt
            } else {
                console.error(`Room ${this.roomCode}| Could not find action data for determined winner ID ${winnerPlayerId}.`);
                noValidWinner = true;
            }
        }

        // Handle case where no valid action could be determined
        if (noValidWinner) {
            this.callbacks.sendSystemMessage("No valid action chosen this round. The world remains unchanged.", true);
            this.round++;
            this.startRound();
            return;
        }

        // Store winner and proceed to generate final result
        this.winningActionData = { playerId: winnerPlayerId, actionPrompt: winningActionPrompt };

        // Get winner's username for more personalized message
        const serverPlayers = this.callbacks.getPlayers();
        const winnerUsername = serverPlayers.get(winnerPlayerId)?.username || 'Someone';

        console.log(`Room ${this.roomCode}| Winning action: "${winningActionPrompt}" by player ${winnerPlayerId}. Generating final result...`);

        // More engaging system message about the chosen action
        this.callbacks.sendSystemMessage(`🏆 The votes are in! "${winningActionPrompt}" by ${winnerUsername} will be our path forward! Creating your adventure...`, true);

        this.callbacks.updateGameState();
        this.generateWinningResult();
    }

    async generateWinningResult() {
        if (this.gameState !== 'generatingResult' || !this.winningActionData) return;

        const { playerId, actionPrompt } = this.winningActionData;
        const serverPlayers = this.callbacks.getPlayers();
        const playerName = serverPlayers.get(playerId)?.username || 'Someone';

        try {
            // Get chat history for context
            const chatHistory = await this.callbacks.getChatHistory();

            // Create history entries array for the prompt builder
            const historyEntries = [];

            // Add stored world state updates to history
            if (this.history && this.history.length > 0) {
                this.history.forEach(entry => {
                    historyEntries.push(entry);
                });
            }

            // Add recent chat messages
            if (chatHistory && chatHistory.length > 0) {
                chatHistory.forEach(message => {
                    if (message.isSystem) {
                        // Skip system messages about voting or game mechanics
                        if (!message.content.includes('votes') &&
                            !message.content.includes('submitted an action') &&
                            !message.content.includes('Time to vote') &&
                            !message.content.includes('Time\'s up')) {
                            historyEntries.push({
                                type: 'world',
                                content: message.content
                            });
                        }
                    } else {
                        historyEntries.push({
                            type: 'chat',
                            username: message.username,
                            content: message.content
                        });
                    }
                });
            }

            // Limit history to most recent entries
            const recentHistory = historyEntries.slice(-MAX_HISTORY_LENGTH);

            // Step 1: Generate text description and structured data
            const textPrompt = zoobPromptBuilder.buildCanonicalResultTextPrompt(
                this.worldDescription, this.inventory, actionPrompt, playerName, recentHistory
            );

            // Request text-only description with structured data
            const textResult = await this.callbacks.requestGeminiStructuredText(textPrompt);

            if (!textResult || !textResult.text || !textResult.data) {
                throw new Error("Failed to generate text description for winning action");
            }

            const worldDescription = textResult.text.trim();
            const structuredData = textResult.data;

            // Step 2: Generate the image based on the text description
            const imagePrompt = zoobPromptBuilder.buildActionImageFromTextPrompt(
                worldDescription, this.imageStyle
            );

            // Request image based on the text description
            const imageResult = await this.callbacks.requestGeminiImage(imagePrompt);

            if (imageResult && imageResult.imageData) {
                // Process success - both text and image were generated
                this.processWinningResult(worldDescription, imageResult.imageData, structuredData);
            } else {
                // Partial success - text generated but image failed, use fallback image
                console.warn(`Room ${this.roomCode}| Failed to generate image for winning action. Using text with fallback image.`);
                // Convert an empty 1x1 pixel to base64 as fallback
                this.processWinningResult(worldDescription, FALLBACK_BLANK_IMAGE.split(',')[1], structuredData);
            }

        } catch (error) {
            console.error(`Room ${this.roomCode}| Error generating winning result for action "${actionPrompt}":`, error);
            this.callbacks.sendSystemMessage(`An error occurred processing the action: "${actionPrompt}". The world remains unchanged.`, true);
            this.round++;
            this.startRound();
        }
    }

    processWinningResult(newDescription, newImageDataB64, structuredData) {
        // Should only be called from generateWinningResult on success
        if (this.gameState !== 'generatingResult') return;

        console.log(`Room ${this.roomCode}| Processing winning result.`);
        this.gameState = 'results';

        // 1. Update World State
        this.worldDescription = newDescription;
        this.worldImageSrc = `data:image/png;base64,${newImageDataB64}`;

        // Add this world update to history
        this.history.push({
            type: 'world',
            content: newDescription
        });

        // Keep history manageable - limit to MAX_HISTORY_LENGTH
        if (this.history.length > MAX_HISTORY_LENGTH) {
            this.history = this.history.slice(-MAX_HISTORY_LENGTH);
        }

        // 2. Update Inventory and report changes to players
        try { // Wrap inventory update in try-catch in case structuredData is malformed
            if (structuredData) {
                const itemsAdded = structuredData.items_added || [];
                const itemsRemoved = structuredData.items_removed || [];
                let inventoryChanged = false;
                const inventoryMessages = [];

                // Process removals first
                itemsRemoved.forEach(itemToRemove => {
                    const lowerItemToRemove = typeof itemToRemove === 'string' ? itemToRemove.toLowerCase() : '';
                    if (!lowerItemToRemove) return; // Skip if item is not a string
                    const index = this.inventory.findIndex(item => item.toLowerCase() === lowerItemToRemove);
                    if (index > -1) {
                        console.log(`Room ${this.roomCode}| Removing item: ${this.inventory[index]}`);
                        inventoryMessages.push(`📤 You lost: ${this.inventory[index]}`);
                        this.inventory.splice(index, 1);
                        inventoryChanged = true;
                    }
                });

                // Then process additions
                itemsAdded.forEach(itemToAdd => {
                    const lowerItemToAdd = typeof itemToAdd === 'string' ? itemToAdd.toLowerCase() : '';
                    if (!lowerItemToAdd) return; // Skip if item is not a string
                    if (!this.inventory.some(item => item.toLowerCase() === lowerItemToAdd)) {
                        console.log(`Room ${this.roomCode}| Adding item: ${itemToAdd}`);
                        inventoryMessages.push(`📥 You gained: ${itemToAdd}`);
                        this.inventory.push(itemToAdd); // Add the original casing
                        inventoryChanged = true;
                    }
                });

                // Report inventory changes
                if (inventoryChanged) {
                    console.log(`Room ${this.roomCode}| Inventory updated: [${this.inventory.join(', ')}]`);

                    // Send inventory update messages
                    if (inventoryMessages.length > 0) {
                        setTimeout(() => {
                            this.callbacks.sendSystemMessage(inventoryMessages.join('\n'), true);
                        }, 2000); // Short delay to show after the main result
                    }
                }
            }
        } catch (invError) {
            console.error(`Room ${this.roomCode}| Error processing inventory update:`, invError);
            // Continue without inventory changes if parsing failed
        }


        // 3. Emit final result
        const serverPlayers = this.callbacks.getPlayers();
        const winnerPlayer = serverPlayers.get(this.winningActionData.playerId);
        this.callbacks.emitToRoom('zoobFinalResult', {
            description: this.worldDescription,
            imageSrc: this.worldImageSrc,
            inventory: this.inventory,
            winningAction: this.winningActionData.actionPrompt,
            winnerPlayerId: this.winningActionData.playerId,
            winnerPlayerName: winnerPlayer ? winnerPlayer.username : 'Someone' // Add name for convenience
        });

        // 4. Check for Game Over
        const lowerDesc = this.worldDescription.toLowerCase();
        if (lowerDesc.includes("you have died") || lowerDesc.includes("eaten by a grue")) {
            console.log(`Room ${this.roomCode}| Game Over condition detected.`);
            this.callbacks.sendSystemMessage(`GAME OVER. ${this.worldDescription}`, true);
            this.cleanup();
            return; // Don't schedule next round
        }

        // 5. Schedule next round
        this.callbacks.startTimer(this.resultsDuration, 'nextRoundStart');
        this.callbacks.updateGameState();
    }


    // --- Event Handlers ---

    handlePlayerJoin(playerId, playerData) {
        console.log(`Room ${this.roomCode}| Zoob Logic: Player joined ${playerData.username} (${playerId})`);
        this.addPlayer(playerId, playerData);

        // Send current world state *only* to the joining player
        if (this.gameState !== 'initializing') { // Don't send if game hasn't even loaded initial state
            this.callbacks.emitToPlayer(playerId, 'zoobWorldUpdate', {
                description: this.worldDescription,
                imageSrc: this.worldImageSrc,
                inventory: this.inventory
            });
            // If voting is in progress, send the current options
            if (this.gameState === 'voting') {
                this.callbacks.emitToPlayer(playerId, 'zoobActionResults', this.actionResults);
            }
        }
        this.callbacks.sendSystemMessage(`🧙‍♂️ Welcome, ${playerData.username}! In this text adventure, use "/g [action]" to submit actions during the input phase (e.g., "/g open mailbox" or "/g go north"). After everyone submits actions, you'll vote on which one to take!`, false, playerId);
        this.callbacks.updateGameState(); // Update lists for everyone
    }

    handlePlayerLeave(playerId) {
        const serverPlayers = this.callbacks.getPlayers();
        const leavingPlayer = serverPlayers.get(playerId);
        const username = leavingPlayer ? leavingPlayer.username : 'Someone';
        console.log(`Room ${this.roomCode}| Zoob Logic: Player leaving ${username} (${playerId})`);

        if (!this.players.has(playerId)) return; // Not in this game instance

        this.removePlayer(playerId);

        if (this.getPlayerCount() === 0) {
            console.log(`Room ${this.roomCode}| Zoob Logic: Last player left.`);
            this.cleanup(); // Triggers server room cleanup eventually
            return;
        }

        // Remove pending action/vote
        this.playerActions.delete(playerId);
        this.votes.delete(playerId);

        // If voting, remove their action result and check completion
        if (this.gameState === 'voting') {
            const index = this.actionResults.findIndex(r => r.playerId === playerId);
            if (index > -1) {
                this.actionResults.splice(index, 1);
                console.log(`Room ${this.roomCode}| Removed action result for leaving player ${username}.`);
                // Re-emit results AFTER removing the item
                this.callbacks.emitToRoom('zoobActionResults', this.actionResults);
            }
            this.checkVotingComplete(); // Check if removing vote completes voting
        }

        this.callbacks.updateGameState(); // Update player lists for others
    }

    handlePlayerCommand(playerId, commandName, commandValue) {
        if (this.gameState === 'input') {
            commandName = commandName.toLowerCase();
            if (commandName.startsWith("g")) {
                if(this.playerActions.has(playerId)){
                    this.callbacks.sendSystemMessage("Action already submitted this round.", false, playerId);
                } else if (this.playerActions.size >= MAX_ACTION_RESULTS) {
                    this.callbacks.sendSystemMessage(`Action limit (${MAX_ACTION_RESULTS}) reached for this round. Please wait.`, false, playerId);
                } else {
                    this.playerActions.set(playerId, commandValue);
                    console.log(`Room ${this.roomCode}| Player ${playerId} action: ${commandValue}`);

                    // Confirmation to the player who submitted the action
                    this.callbacks.sendSystemMessage(`✅ Your action has been recorded: "${commandValue}"`, false, playerId);

                    // Advance round automatically if all players have submitted actions
                    const humanPlayersCount = this.players.size - this.aiPlayers.size;
                    if (this.playerActions.size >= humanPlayersCount && humanPlayersCount > 0) {
                        // Give a small delay before ending input phase
                        setTimeout(() => {
                            if (this.gameState === 'input') {
                                this.callbacks.sendSystemMessage(`🧙‍♂️ All players have submitted their actions!`, true);
                                this.endInputPhase();
                            }
                        }, 1000);
                    }

                    return { handled: true, displayMessage: commandValue, isGuess: true };
                }

                return { handled: true, displayMessage: null, isGuess: false };
            }
        }
        return { handled: false };
    }

    handleVote(playerId, votedForPlayerId) {
        if (this.gameState !== 'voting' || this.votes.has(playerId)) return;
        // Ensure the player they voted for has a valid (non-failed) action result displayed
        if (!this.actionResults.some(r => r.playerId === votedForPlayerId && !r.failed)) {
            console.log(`Room ${this.roomCode}| Player ${playerId} attempted to vote for invalid/failed action owner ${votedForPlayerId}.`);
            return;
        }

        this.votes.set(playerId, votedForPlayerId);
        console.log(`Room ${this.roomCode}| Player ${playerId} voted for action by ${votedForPlayerId}`);

        const serverPlayers = this.callbacks.getPlayers();
        const voterData = serverPlayers.get(playerId);
        if (voterData) {
            this.callbacks.emitToRoom('zoobPlayerVoted', {
                votedForPlayerId: votedForPlayerId,
                voterName: voterData.username,
                voterColor: voterData.color
            });
        }
        this.checkVotingComplete();
    }

    handleTimerExpiration(timerType) {
        console.log(`Room ${this.roomCode}| Zoob Timer expired: ${timerType}`);
        switch (timerType) {
            case 'inputEnd':
                if (this.gameState === 'input') { this.endInputPhase(); }
                break;
            case 'votingEnd':
                if (this.gameState === 'voting') { this.tallyVotes(); }
                break;
            case 'nextRoundStart':
                if (this.gameState === 'results') {
                    this.round++;
                    this.startRound();
                }
                break;
        }
    }

    // --- Utility Methods ---

    addPlayer(playerId, playerData) {
        this.players.set(playerId, { score: 0 }); // Basic state for now

        // Add AI tracking if it's an AI player
        if (playerData.isAI) {
            this.aiPlayers.set(playerId, {
                lastChatTime: 0,
                lastActionTime: 0
            });

            // If we're in input phase, schedule AI chat and action
            if (this.gameState === 'input') {
                this.scheduleAIChat(playerId);
                this.scheduleAIAction(playerId);
            }
        }

        console.log(`Room ${this.roomCode}| Player added to Zoob game: ${playerId}. Total: ${this.players.size}, AI: ${this.aiPlayers.size}`);
    }

    removePlayer(playerId) {
        this.players.delete(playerId);

        // Clear AI timers and state if it was an AI
        if (this.aiPlayers.has(playerId)) {
            this.clearAllAITimersForPlayer(playerId);
            this.aiPlayers.delete(playerId);
        }

        this.playerActions.delete(playerId);
        this.votes.delete(playerId);
        console.log(`Room ${this.roomCode}| Player removed from Zoob game: ${playerId}. Remaining: ${this.players.size}, AI: ${this.aiPlayers.size}`);
    }

    getPlayerCount() { return this.players.size; }

    checkVotingComplete() {
        if (this.gameState !== 'voting') return;
        const expectedVotes = this.players.size; // All players can vote
        // Check if votes received match the number of players currently in the game instance
        if (this.votes.size >= this.players.size && this.players.size > 0) {
            console.log(`Room ${this.roomCode}| All expected Zoob votes received (${this.votes.size}/${this.players.size}). Ending voting early.`);
            this.tallyVotes();
        }
    }

    getGameStateSnapshot() {
        return {
            // Required by server's current updateGameState structure:
            currentDrawerId: null, // Not applicable
            round: this.round,
            voting: this.gameState === 'voting',
            // Zoob specific state info:
            zoobGameState: this.gameState, // Send specific Zoob state name
            gameType: 'Zoob' // Explicitly state game type
        };
    }

    // --- AI Methods ---

    scheduleAIChat(aiPlayerId) {
        const aiData = this.aiPlayers.get(aiPlayerId);
        if (!aiData || this.gameState !== 'input') return;

        const now = Date.now();
        const inputEndTime = this.callbacks.getTimerEndTime('inputEnd') || 0;
        const timeLeft = inputEndTime - now;

        // Don't schedule if very little time left
        if (timeLeft <= 5000) return;

        const isFirstChat = aiData.lastChatTime === 0;
        const timeSinceLastChat = now - (aiData.lastChatTime || 0);

        // Calculate delay based on whether this is the first chat or a subsequent one
        let chatDelay;
        if (isFirstChat) {
            chatDelay = this.aiTiming.firstChatMinTime +
                        Math.random() * (this.aiTiming.firstChatMaxTime - this.aiTiming.firstChatMinTime);
        } else if (timeSinceLastChat >
                  (this.aiTiming.chatIntervalMin + Math.random() * (this.aiTiming.chatIntervalMax - this.aiTiming.chatIntervalMin))) {
            // Only schedule follow-up chats after sufficient interval and with probability check
            if (Math.random() < this.aiTiming.chatProbability) {
                chatDelay = 1000 + Math.random() * 3000; // Chat relatively quickly after interval
            } else {
                return; // Skip this opportunity
            }
        } else {
            return; // Not enough time has passed since last chat
        }

        // Ensure chat happens before input phase ends
        if (now + chatDelay < inputEndTime - 1000) {
            const timerId = setTimeout(async () => {
                // Verify state is still valid
                if (this.gameState === 'input' && this.aiPlayers.has(aiPlayerId)) {
                    await this.makeAIChat(aiPlayerId);
                    // Schedule another chat opportunity
                    this.scheduleAIChat(aiPlayerId);
                }
                this.aiChatTimers.delete(aiPlayerId);
            }, chatDelay);

            this.setAITimer(aiPlayerId, 'chat', timerId);
        }
    }

    scheduleAIAction(aiPlayerId) {
        const aiData = this.aiPlayers.get(aiPlayerId);
        if (!aiData || this.gameState !== 'input' || this.playerActions.has(aiPlayerId)) return;

        const now = Date.now();
        const inputEndTime = this.callbacks.getTimerEndTime('inputEnd') || 0;
        const timeLeft = inputEndTime - now;

        // Don't schedule if very little time left, or if AI has already submitted an action
        if (timeLeft <= 5000) return;

        // Wait for a defined time before taking an action
        const actionDelay = this.aiTiming.actionMinTime +
                           Math.random() * (this.aiTiming.actionMaxTime - this.aiTiming.actionMinTime);

        // Ensure action happens before input phase ends
        if (now + actionDelay < inputEndTime - 1000) {
            const timerId = setTimeout(async () => {
                // Verify state is still valid
                if (this.gameState === 'input' && this.aiPlayers.has(aiPlayerId) && !this.playerActions.has(aiPlayerId)) {
                    await this.makeAIAction(aiPlayerId);
                }
                this.aiActionTimers.delete(aiPlayerId);
            }, actionDelay);

            this.setAITimer(aiPlayerId, 'action', timerId);
        } else {
            // If regular timing would put us too close to the end, schedule a last-minute action
            // This ensures AI always submits an action before the phase ends
            const lastChanceDelay = Math.max(1000, timeLeft - 3000);

            const timerId = setTimeout(async () => {
                if (this.gameState === 'input' && this.aiPlayers.has(aiPlayerId) && !this.playerActions.has(aiPlayerId)) {
                    await this.makeAIAction(aiPlayerId);
                }
                this.aiActionTimers.delete(aiPlayerId);
            }, lastChanceDelay);

            this.setAITimer(aiPlayerId, 'action', timerId);
        }
    }

    scheduleAIVotes() {
        if (this.gameState !== 'voting' || this.actionResults.length === 0) return;

        console.log(`Room ${this.roomCode}| Scheduling AI votes.`);
        this.aiPlayers.forEach((aiData, aiPlayerId) => {
            // Don't schedule a vote if they already voted
            if (this.votes.has(aiPlayerId)) return;

            const delay = this.aiTiming.voteDelayMin +
                         Math.random() * (this.aiTiming.voteDelayMax - this.aiTiming.voteDelayMin);

            const timerId = setTimeout(async () => {
                // Check if voting is still active and AI exists
                if (this.gameState !== 'voting' || !this.aiPlayers.has(aiPlayerId)) {
                    this.aiVoteTimers.delete(aiPlayerId);
                    return;
                }

                try {
                    await this.makeAIVote(aiPlayerId);
                } catch (error) {
                    console.error(`Room ${this.roomCode}| Error during AI vote for ${aiPlayerId}:`, error);
                } finally {
                    this.aiVoteTimers.delete(aiPlayerId);
                }
            }, delay);

            this.setAITimer(aiPlayerId, 'vote', timerId);
        });
    }

    async makeAIChat(aiPlayerId) {
        try {
            const aiData = this.aiPlayers.get(aiPlayerId);
            if (!aiData || this.gameState !== 'input') return;

            // Get AI personality details and chat history
            const aiDetails = await this.callbacks.getAIDetails(aiPlayerId);
            if (!aiDetails) throw new Error("AI details not found for chat");

            const chatHistory = await this.callbacks.getChatHistory();

            // Create a special prompt for Zoob-themed chat
            const prompt = `You are the AI player ${aiDetails.username} in a text-based adventure game like Zoob.
Your personality: ${aiDetails.corePersonalityPrompt || "friendly and helpful"}

Current game description: ${this.worldDescription}

Inventory: ${this.inventory.length > 0 ? this.inventory.join(', ') : "empty"}

Recent chat history:
${this.formatChatHistory(chatHistory, 10)}

Send a brief, entertaining in-character message reacting to the adventure. Express your excitement, concern, puzzle-solving thoughts, or general reactions to the current situation. Keep it under 1-2 sentences and stay in character. Don't suggest specific actions yet - just react naturally to the adventure.`;

            const result = await this.callbacks.requestGeminiText(prompt);
            const message = result?.text?.trim();

            if (message) {
                aiData.lastChatTime = Date.now();
                // Send chat message via server callback
                this.callbacks.sendPlayerMessage(aiPlayerId, message, false);
            } else {
                console.warn(`Room ${this.roomCode}| AI ${aiPlayerId} failed to generate a chat message.`);
            }
        } catch (error) {
            console.error(`Room ${this.roomCode}| Error making AI chat for ${aiPlayerId}:`, error);
        }
    }

    async makeAIAction(aiPlayerId) {
        try {
            const aiData = this.aiPlayers.get(aiPlayerId);
            if (!aiData || this.gameState !== 'input' || this.playerActions.has(aiPlayerId)) return;

            // Get AI personality details and chat history
            const aiDetails = await this.callbacks.getAIDetails(aiPlayerId);
            if (!aiDetails) throw new Error("AI details not found for action");

            const chatHistory = await this.callbacks.getChatHistory();

            // Create a special prompt for Zoob-themed action
            const prompt = `You are the AI player ${aiDetails.username} in a text-based adventure game like Zoob.
Your personality: ${aiDetails.corePersonalityPrompt || "friendly and helpful"}

Current game description: ${this.worldDescription}

Inventory: ${this.inventory.length > 0 ? this.inventory.join(', ') : "empty"}

Recent chat history:
${this.formatChatHistory(chatHistory, 10)}

Based on the current situation, suggest ONE specific action to take in the game. Actions should be 2-5 words, like "open mailbox", "go north", "examine house", "climb tree", etc. Respond with ONLY the action text, nothing else.`;

            const result = await this.callbacks.requestGeminiText(prompt);
            const action = result?.text?.trim();

            if (action) {
                aiData.lastActionTime = Date.now();

                // Add the action to playerActions map
                this.playerActions.set(aiPlayerId, action);
                console.log(`Room ${this.roomCode}| AI ${aiPlayerId} submitted action: ${action}`);

                // Announcement to everyone
                const username = aiDetails.username || "AI player";
                this.callbacks.sendSystemMessage(`📝 ${username} has submitted an action.`, true);

                // Check if all players have submitted actions
                const humanPlayersCount = this.players.size - this.aiPlayers.size;
                if (this.playerActions.size >= this.players.size && this.players.size > 0) {
                    this.callbacks.sendSystemMessage(`🧙‍♂️ All players have submitted their actions!`, true);
                    // Give a small delay before ending input phase
                    setTimeout(() => {
                        if (this.gameState === 'input') {
                            this.endInputPhase();
                        }
                    }, 1500);
                }
            } else {
                console.warn(`Room ${this.roomCode}| AI ${aiPlayerId} failed to generate an action.`);
            }
        } catch (error) {
            console.error(`Room ${this.roomCode}| Error making AI action for ${aiPlayerId}:`, error);
        }
    }

    async makeAIVote(aiPlayerId) {
        try {
            // Skip if AI already voted or state is invalid
            if (this.votes.has(aiPlayerId) || this.gameState !== 'voting' || this.actionResults.length === 0) return;

            const aiDetails = await this.callbacks.getAIDetails(aiPlayerId);
            if (!aiDetails) throw new Error("AI details not found for voting");

            const chatHistory = await this.callbacks.getChatHistory();

            // Create voting options for the prompt
            const votingOptions = this.actionResults
                .filter(result => !result.failed)  // Only show non-failed actions
                .map((result, index) => `${index + 1}. ${result.playerName}: "${result.actionPrompt}"`)
                .join('\n');

            if (!votingOptions) {
                console.warn(`Room ${this.roomCode}| No valid voting options for AI ${aiPlayerId}.`);
                return;
            }

            const prompt = `You are the AI player ${aiDetails.username} in a text-based adventure game like Zoob.
Your personality: ${aiDetails.corePersonalityPrompt || "friendly and helpful"}

Current game description: ${this.worldDescription}

Players have suggested different actions for the group to take next. You need to vote for one.

Available actions:
${votingOptions}

Pick the action you think makes the most sense given the current state of the game. Provide both a vote number and brief reason.

Format your response exactly like this:
Vote: [action number]
Reason: [1-2 sentence explanation for your choice]`;

            const result = await this.callbacks.requestGeminiText(prompt);
            const responseText = result?.text?.trim();

            let selectedActionIndex = -1;
            let message = responseText || "I'm not sure which action to choose...";

            if (responseText) {
                try {
                    // Extract vote number from the response
                    const voteMatch = responseText.match(/Vote:\s*(\d+)/i);
                    if (voteMatch && voteMatch[1]) {
                        const voteNum = parseInt(voteMatch[1], 10);
                        // Convert to 0-based index and validate
                        const validOptions = this.actionResults.filter(r => !r.failed);
                        if (voteNum >= 1 && voteNum <= validOptions.length) {
                            selectedActionIndex = voteNum - 1;
                        }
                    }

                    // Extract reason from the response
                    const reasonMatch = responseText.match(/Reason:\s*([\s\S]+)/i);
                    if (reasonMatch && reasonMatch[1]) {
                        message = reasonMatch[1].trim();
                    }
                } catch (parseError) {
                    console.error(`Room ${this.roomCode}| Error parsing AI vote response:`, parseError);

                    // Fallback to random vote if parsing fails
                    const validOptions = this.actionResults.filter(r => !r.failed);
                    if (validOptions.length > 0) {
                        selectedActionIndex = Math.floor(Math.random() * validOptions.length);
                        message = "I'll go with this option!";
                    }
                }
            } else {
                // Random vote if no response from AI
                const validOptions = this.actionResults.filter(r => !r.failed);
                if (validOptions.length > 0) {
                    selectedActionIndex = Math.floor(Math.random() * validOptions.length);
                    message = "This seems like the best choice.";
                }
            }

            // If a valid vote was determined
            if (selectedActionIndex !== -1) {
                // Get the player ID to vote for
                const validOptions = this.actionResults.filter(r => !r.failed);
                const votedForPlayerId = validOptions[selectedActionIndex].playerId;

                // Send chat message with reason
                this.callbacks.sendPlayerMessage(aiPlayerId, message, false);

                // Submit the vote via the standard handler
                this.handleVote(aiPlayerId, votedForPlayerId);
            } else {
                console.warn(`Room ${this.roomCode}| AI ${aiPlayerId} failed to determine a valid vote.`);
                this.callbacks.sendPlayerMessage(aiPlayerId, "I'm not sure which action to choose...", false);
            }
        } catch (error) {
            console.error(`Room ${this.roomCode}| Error making AI vote for ${aiPlayerId}:`, error);
        }
    }

    // --- AI Timer Management ---

    setAITimer(aiPlayerId, timerType, timerId) {
        // Ensure AI still exists before setting timer
        if (!this.aiPlayers.has(aiPlayerId)) {
            clearTimeout(timerId);
            return;
        }

        // Clear existing timer of same type
        this.clearAITimer(aiPlayerId, timerType);

        // Store new timer ID
        switch (timerType) {
            case 'chat': this.aiChatTimers.set(aiPlayerId, timerId); break;
            case 'action': this.aiActionTimers.set(aiPlayerId, timerId); break;
            case 'vote': this.aiVoteTimers.set(aiPlayerId, timerId); break;
            default: console.warn(`Room ${this.roomCode}| Unknown AI timer type: ${timerType}`);
        }
    }

    clearAITimer(aiPlayerId, timerType) {
        let timerMap;

        switch (timerType) {
            case 'chat': timerMap = this.aiChatTimers; break;
            case 'action': timerMap = this.aiActionTimers; break;
            case 'vote': timerMap = this.aiVoteTimers; break;
            default: return; // Unknown type
        }

        if (timerMap && timerMap.has(aiPlayerId)) {
            const timerId = timerMap.get(aiPlayerId);
            clearTimeout(timerId);
            timerMap.delete(aiPlayerId);
        }
    }

    clearAllAITimersForPlayer(aiPlayerId) {
        this.clearAITimer(aiPlayerId, 'chat');
        this.clearAITimer(aiPlayerId, 'action');
        this.clearAITimer(aiPlayerId, 'vote');
    }

    clearAllAITimers() {
        this.aiPlayers.forEach((_, aiPlayerId) => {
            this.clearAllAITimersForPlayer(aiPlayerId);
        });
        console.log(`Room ${this.roomCode}| Cleared all AI timers.`);
    }

    // Helper function to format chat history
    formatChatHistory(chatHistory, messageCount = 10) {
        return chatHistory.slice(-messageCount).map(msg =>
            `${msg.username || 'System'}: ${msg.content || msg.message}`
        ).join('\n');
    }

    // --- Cleanup ---
    cleanup() {
        console.log(`Room ${this.roomCode}| Cleaning up ZoobGame instance.`);
        this.gameState = 'ended';
        // Clear all timers
        this.clearAllAITimers();
        this.callbacks.clearTimer('inputEnd');
        this.callbacks.clearTimer('votingEnd');
        this.callbacks.clearTimer('nextRoundStart');
        // Clear internal state
        this.players.clear();
        this.aiPlayers.clear();
        this.playerActions.clear();
        this.actionResults = [];
        this.votes.clear();
        console.log(`Room ${this.roomCode}| ZoobGame cleanup complete.`);
    }
}

module.exports = ZoobGame;