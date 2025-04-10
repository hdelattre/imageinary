// zoob.js - Game-specific client code for Zoob

let zoobSocket = null; // Store socket instance

/**
 * Initializes the Zoob game UI and binds listeners
 * @param {Socket} socket - The socket.io instance
 */
function initZoobUI(socket) {
    zoobSocket = socket; // Store socket

    // Show Zoob view, hide Imageinary view
    document.getElementById('zoob-view').style.display = 'block';
    document.getElementById('drawing-view').style.display = 'none';
    document.getElementById('drawerInfo').style.display = 'none';
    document.getElementById('toolbar').style.display = 'none';
    document.getElementById('viewPromptBtn').style.display = 'none';
    document.getElementById('voting').style.display = 'none'; // Ensure generic voting area is hidden initially

    // Update page title
    document.querySelector('h1').textContent = 'Zoob';

    // --- Bind Zoob Specific Listeners ---
    zoobSocket.on('zoobWorldUpdate', handleWorldUpdate);
    zoobSocket.on('zoobActionResults', handleActionResults);
    zoobSocket.on('zoobPlayerVoted', handleZoobVote);
    zoobSocket.on('zoobFinalResult', handleFinalResult);

    console.log("Zoob Initialized and Listeners Bound");
}

/**
 * Cleans up Zoob UI and unbinds listeners
 */
function cleanupZoobUI() {
    if (zoobSocket) {
        // --- Unbind Zoob Specific Listeners ---
        zoobSocket.off('zoobWorldUpdate', handleWorldUpdate);
        zoobSocket.off('zoobActionResults', handleActionResults);
        zoobSocket.off('zoobPlayerVoted', handleZoobVote);
        zoobSocket.off('zoobFinalResult', handleFinalResult);
        console.log("Zoob Listeners Unbound");
    }
    zoobSocket = null;

    // Optional: Hide specific UI elements if needed
    document.getElementById('zoob-view').style.display = 'none';
    document.getElementById('voting').style.display = 'none'; // Hide generic voting area
}

/**
 * Updates the game state specifically for Zoob
 * @param {Object} gameData - The game state data
 */
function updateZoobState(gameData) {
    const { zoobGameState } = gameData; // Assumes server sends this in gameState

    // Update chat placeholder based on game state
    const chatInput = document.getElementById('chatInput');
    chatInput.disabled = false; // Zoob generally doesn't disable chat
    if (zoobGameState === 'input') {
        chatInput.placeholder = 'Use /g [your action] during input phase';
    } else if (zoobGameState === 'voting') {
        chatInput.placeholder = 'Voting on next action... Chat is open!';
    } else {
        chatInput.placeholder = 'Chat...';
    }
}

// --- Event Handlers ---

function handleWorldUpdate(data) {
    const { description, imageSrc, inventory } = data;

    // Update the world description
    document.getElementById('zoob-world-description').textContent = description;

    // Update the world image if provided
    const worldImage = document.getElementById('zoobWorldImage');
    if (imageSrc) {
        worldImage.src = imageSrc;
        worldImage.style.display = 'block'; // Ensure visible
    } else {
        worldImage.style.display = 'none'; // Hide if no image
    }

    // Update inventory display
    const inventoryElement = document.getElementById('zoob-inventory');
    if (inventory && inventory.length > 0) {
        inventoryElement.innerHTML = `
            <h3>Inventory</h3>
            <ul>${inventory.map(item => `<li>${item}</li>`).join('')}</ul>
        `;
    } else {
        inventoryElement.innerHTML = '<h3>Inventory: Empty</h3>';
    }

    // Ensure main Zoob view is shown, hide voting
    document.getElementById('zoob-view').style.display = 'block';
    document.getElementById('voting').style.display = 'none'; // Hide generic voting area
}

function handleActionResults(actionResults) {
    // Prepare options for the generic display function
    const options = actionResults.map(result => ({
        playerId: result.playerId,
        displayData: {
            type: 'zoobAction', // Custom type identifier
            imageSrc: result.resultImageSrc, // Can be fallback image
            name: result.playerName,
            action: result.actionPrompt,
            result: result.resultText
        }
    }));

    // Define the callback for when a vote is cast
    const voteCallback = (votedPlayerId) => {
        const roomCode = document.getElementById('currentRoom').textContent;
        console.log(`Zoob vote cast for: ${votedPlayerId}`);
        zoobSocket.emit('vote', { roomCode, votePlayerId: votedPlayerId });
    };

    // Call the generic display function from client.js
    displayVotingOptions(options, voteCallback);
}

/**
 * Handles vote animations for Zoob
 * @param {Object} voteData - Data about the vote cast
 */
function handleZoobVote(voteData) {
    // Use the common vote handler from client.js
    handleCommonPlayerVote(voteData);
}

function handleFinalResult(data) {
    const { description, imageSrc, inventory, winningAction, winnerPlayerId, winnerPlayerName } = data;

    // Update the world description and image (using the existing handler)
    handleWorldUpdate({ description, imageSrc, inventory });

    // Show winner message
    addSystemMessage(`Chosen action: "${winningAction}" by ${winnerPlayerName}`, 'system-message zoob-winner-message');
}

// Expose functions to global scope
window.zoob = {
    init: initZoobUI,
    cleanup: cleanupZoobUI,
    updateState: updateZoobState
};