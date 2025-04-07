// imageinary.js - Game-specific client code for Imageinary

let imageinarySocket = null; // Store socket instance

/**
 * Initializes the Imageinary game UI and binds listeners
 * @param {Socket} socket - The socket.io instance
 */
function initImageinaryUI(socket) {
    imageinarySocket = socket; // Store socket

    // Show Imageinary view, hide Zoob view
    document.getElementById('zoob-view').style.display = 'none';
    document.getElementById('drawing-view').style.display = 'block';
    document.getElementById('drawerInfo').style.display = 'inline-block';
    document.getElementById('viewPromptBtn').style.display = 'block';
    document.getElementById('toolbar').style.display = 'flex'; // Show toolbar

    // Update page title
    document.querySelector('h1').textContent = 'Imageinary';

    // --- Bind Imageinary Specific Listeners ---
    imageinarySocket.on('newTurn', handleNewTurn);
    imageinarySocket.on('newPrompt', handleNewPrompt);
    imageinarySocket.on('startVoting', handleStartVoting);

    console.log("Imageinary Initialized and Listeners Bound");
}

/**
 * Cleans up Imageinary UI and unbinds listeners
 */
function cleanupImageinaryUI() {
    if (imageinarySocket) {
        // --- Unbind Imageinary Specific Listeners ---
        imageinarySocket.off('newTurn', handleNewTurn);
        imageinarySocket.off('newPrompt', handleNewPrompt);
        imageinarySocket.off('startVoting', handleStartVoting);
        console.log("Imageinary Listeners Unbound");
    }
    imageinarySocket = null;

    // Optional: Hide specific UI elements if needed
    document.getElementById('prompt').style.display = 'none';
    document.getElementById('voting').style.display = 'none'; // Hide voting area
}

/**
 * Updates the game state specifically for Imageinary
 * @param {Object} gameData - The game state data
 */
function updateImageinaryState(gameData) {
    const { players, currentDrawer, voting } = gameData;

    // Update drawer information
    const drawerPlayer = players.find(p => p.id === currentDrawer);
    document.getElementById('drawer').textContent = drawerPlayer ? drawerPlayer.username : "Unknown";
    document.getElementById('drawer').dataset.id = currentDrawer;

    // Only disable chat for drawer during drawing phase (not during voting)
    refreshChatEnabled(voting, currentDrawer);

    // Always show toolbar but disable it if not the drawer
    const toolbar = document.getElementById('toolbar');
    toolbar.style.display = 'flex';
    if (imageinarySocket.id === currentDrawer) {
        toolbar.classList.remove('disabled');
    } else {
        toolbar.classList.add('disabled');
    }
}

// --- Event Handlers (called by socket listeners) ---

function handleNewTurn(turnData) {
    const { drawer, drawerId, round } = turnData;

    document.getElementById('drawer').textContent = drawer;
    document.getElementById('drawer').dataset.id = drawerId;
    // document.getElementById('round').textContent = round; // Round is updated in generic updateGameState

    // Reset all drawing state (uses function from client.js)
    resetDrawingState();

    // Only reset the voting area and prompt, keep the chat history
    document.getElementById('voting').style.display = 'none';
    document.getElementById('prompt').style.display = 'none';

    // Show drawing view
    document.getElementById('drawing-view').style.display = 'block';
    document.getElementById('zoob-view').style.display = 'none'; // Ensure Zoob view is hidden

    // Show drawing tools but disable if not the drawer
    const toolbar = document.getElementById('toolbar');
    toolbar.style.display = 'flex';
    if (imageinarySocket.id === drawerId) {
        toolbar.classList.remove('disabled');
    } else {
        toolbar.classList.add('disabled');
    }

    // Add system message about new turn
    addSystemMessage(`Round ${round}: ${drawer} is now drawing!`);
}

function handleNewPrompt(prompt) {
    if (imageinarySocket.id === document.getElementById('drawer').dataset.id) {
        document.getElementById('promptText').textContent = prompt;
        document.getElementById('prompt').style.display = 'block';
    }
}

function handleStartVoting(generatedImages) {
    // Re-enable chat for drawer
    refreshChatEnabled(true, null);

    // Prepare options for the generic display function
    const options = generatedImages.map(imgData => ({
        playerId: imgData.playerId,
        displayData: {
            type: 'imageinaryGuess', // Custom type identifier
            imageSrc: imgData.imageSrc,
            name: imgData.playerName,
            guess: imgData.guess
        }
    }));

    // Define the callback for when a vote is cast
    const voteCallback = (votedPlayerId) => {
        const roomCode = document.getElementById('currentRoom').textContent;
        console.log(`Imageinary vote cast for: ${votedPlayerId}`);
        imageinarySocket.emit('vote', { roomCode, votePlayerId: votedPlayerId });
    };

    // Call the generic display function from client.js
    displayVotingOptions(options, voteCallback);
}

/**
 * Handles refreshing chat input state
 * @param {boolean} voting - Whether the game is in voting phase
 * @param {string} currentDrawer - Current drawer's ID
 */
function refreshChatEnabled(voting, currentDrawer) {
    const chatDisabled = !voting && imageinarySocket.id === currentDrawer;
    const chatInput = document.getElementById('chatInput');
    chatInput.disabled = chatDisabled;
    chatInput.placeholder = chatDisabled ? "Drawing..." :
        voting ? "Chat..." : "/g to guess...";
}

// Expose functions to global scope
window.imageinary = {
    init: initImageinaryUI,
    cleanup: cleanupImageinaryUI,
    updateState: updateImageinaryState
};