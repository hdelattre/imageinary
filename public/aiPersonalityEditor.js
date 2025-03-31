// AI Personality Editor Module
let aiPlayers = []; // Store current AI players
let editorModal = null; // Store the modal element reference
let savedPersonalities = []; // Store saved AI personalities

// Load saved personalities from local storage
function loadSavedPersonalities() {
    const saved = localStorage.getItem('imageinary_ai_personalities');
    if (saved) {
        try {
            savedPersonalities = JSON.parse(saved);
        } catch (e) {
            console.error("Failed to parse saved AI personalities");
            savedPersonalities = [];
        }
    }
    return savedPersonalities;
}

// Save personalities to local storage
function savePersonalitiesToStorage() {
    localStorage.setItem('imageinary_ai_personalities', JSON.stringify(savedPersonalities));
}

function initAIPersonalityEditor() {
    loadSavedPersonalities();

    // Set up socket listeners for in-game mode
    socket.on('aiPlayersList', (data) => {
        aiPlayers = data.aiPlayers;
        updateInGameAIPlayersList();
    });
    socket.on('aiPlayerUpdated', (data) => {
        if (data.success) {
            showNotification('AI player personality updated successfully!', 'success');
            closeAIPersonalityEditor();
        } else {
            showNotification(data.error || 'Failed to update AI player', 'error');
        }
    });
    socket.on('aiPlayerCreated', (data) => {
        if (data.success) {
            showNotification('New AI player created successfully!', 'success');
            closeAIPersonalityEditor();
        } else {
            showNotification(data.error || 'Failed to create AI player', 'error');
        }
    });

    createEditorUI();
    setupEventListeners();
}

function createEditorUI() {
    // Only create UI once
    if (document.getElementById('aiPersonalityEditorModal')) {
        return;
    }

    // Create the modal container
    editorModal = document.createElement('div');
    editorModal.id = 'aiPersonalityEditorModal';
    editorModal.className = 'modal';
    editorModal.style.display = 'none';

    // Create the modal content
    const modalContent = document.createElement('div');
    modalContent.className = 'modal-content ai-personality-editor';

    // Create the header
    const header = document.createElement('h2');
    header.textContent = 'AI Personality Editor';
    modalContent.appendChild(header);

    // Create the editor container
    const editorContainer = document.createElement('div');
    editorContainer.className = 'ai-editor-container';

    // Create AI player selection section
    const selectionDiv = document.createElement('div');
    selectionDiv.className = 'ai-selection';

    const selectLabel = document.createElement('label');
    selectLabel.setAttribute('for', 'aiPlayerSelect');
    selectLabel.textContent = 'Select AI Player:';
    selectionDiv.appendChild(selectLabel);

    const selectElement = document.createElement('select');
    selectElement.id = 'aiPlayerSelect';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.textContent = '-- Select an AI Player --';
    selectElement.appendChild(defaultOption);

    const createNewOption = document.createElement('option');
    createNewOption.value = 'create_new';
    createNewOption.textContent = 'Create New AI Player';
    selectElement.appendChild(createNewOption);

    selectionDiv.appendChild(selectElement);
    editorContainer.appendChild(selectionDiv);

    // Create form container
    const formContainer = document.createElement('div');
    formContainer.id = 'aiPersonalityFormContainer';
    formContainer.style.display = 'none';

    // Create "Create New AI" form
    const createNewForm = document.createElement('div');
    createNewForm.id = 'createNewAIForm';
    createNewForm.style.display = 'none';

    const createNewHeader = document.createElement('h4');
    createNewHeader.textContent = 'Create New AI Player';
    createNewForm.appendChild(createNewHeader);

    // Name input group
    const nameGroup = document.createElement('div');
    nameGroup.className = 'form-group';

    const nameLabel = document.createElement('label');
    nameLabel.setAttribute('for', 'newAIName');
    nameLabel.textContent = 'AI Name:';
    nameGroup.appendChild(nameLabel);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.id = 'newAIName';
    nameInput.placeholder = 'Enter AI player name';
    nameGroup.appendChild(nameInput);

    createNewForm.appendChild(nameGroup);

    // Chat prompt group
    const chatGroup = document.createElement('div');
    chatGroup.className = 'form-group';

    const chatLabel = document.createElement('label');
    chatLabel.setAttribute('for', 'newAIChatPrompt');
    chatLabel.textContent = 'Chat Personality Prompt:';
    chatGroup.appendChild(chatLabel);

    const chatTextarea = document.createElement('textarea');
    chatTextarea.id = 'newAIChatPrompt';
    chatTextarea.rows = 5;
    chatTextarea.placeholder = 'Enter chat prompt for AI personality';
    // Default chat prompt
    chatTextarea.value = "You're playing a drawing game with friends. Look at this drawing and the chat history, then send a single casual, funny message as if you're a player. Don't guess what the drawing is. Instead, comment on the drawing process, react to other messages, or make a light joke. But surprising and sometimes controversial. Respond with your only chat message and nothing else.";
    chatGroup.appendChild(chatTextarea);

    const chatHint = document.createElement('p');
    chatHint.className = 'form-hint';
    chatHint.textContent = 'This prompt controls how the AI behaves when chatting (not guessing)';
    chatGroup.appendChild(chatHint);

    createNewForm.appendChild(chatGroup);

    // Guess prompt group
    const guessGroup = document.createElement('div');
    guessGroup.className = 'form-group';

    const guessLabel = document.createElement('label');
    guessLabel.setAttribute('for', 'newAIGuessPrompt');
    guessLabel.textContent = 'Guess Personality Prompt:';
    guessGroup.appendChild(guessLabel);

    const guessTextarea = document.createElement('textarea');
    guessTextarea.id = 'newAIGuessPrompt';
    guessTextarea.rows = 5;
    guessTextarea.placeholder = 'Enter guess prompt for AI personality';
    // Default guess prompt
    guessTextarea.value = "You are playing Pictionary. Look at this drawing and make a fun creative guess of what it represents. Your guess will be remixed with the drawing by an AI, so you should avoid obvious answers and guess something whacky and interesting that will result in something fun and surprising. Your guess can be a word or phrase. If the drawing seems incomplete or unclear, make your best guess anyway. Respond with just your guess.";
    guessGroup.appendChild(guessTextarea);

    const guessHint = document.createElement('p');
    guessHint.className = 'form-hint';
    guessHint.textContent = 'This prompt controls how the AI makes guesses';
    guessGroup.appendChild(guessHint);

    createNewForm.appendChild(guessGroup);

    // Cancel button
    const cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.id = 'cancelCreateAIBtn';
    cancelBtn.className = 'secondary-btn';
    cancelBtn.textContent = 'Cancel';
    createNewForm.appendChild(cancelBtn);

    formContainer.appendChild(createNewForm);

    // Create "Existing AI" form
    const existingForm = document.createElement('div');
    existingForm.id = 'existingAIForm';
    existingForm.style.display = 'none';

    const existingHeader = document.createElement('h4');
    existingHeader.innerHTML = 'Edit AI Player: <span id="aiPlayerName"></span>';
    existingForm.appendChild(existingHeader);

    // Chat prompt group
    const existingChatGroup = document.createElement('div');
    existingChatGroup.className = 'form-group';

    const existingChatLabel = document.createElement('label');
    existingChatLabel.setAttribute('for', 'aiChatPrompt');
    existingChatLabel.textContent = 'Chat Personality Prompt:';
    existingChatGroup.appendChild(existingChatLabel);

    const existingChatTextarea = document.createElement('textarea');
    existingChatTextarea.id = 'aiChatPrompt';
    existingChatTextarea.rows = 5;
    existingChatTextarea.placeholder = 'Enter chat prompt for AI personality';
    existingChatGroup.appendChild(existingChatTextarea);

    const existingChatHint = document.createElement('p');
    existingChatHint.className = 'form-hint';
    existingChatHint.textContent = 'This prompt controls how the AI behaves when chatting (not guessing)';
    existingChatGroup.appendChild(existingChatHint);

    existingForm.appendChild(existingChatGroup);

    // Guess prompt group
    const existingGuessGroup = document.createElement('div');
    existingGuessGroup.className = 'form-group';

    const existingGuessLabel = document.createElement('label');
    existingGuessLabel.setAttribute('for', 'aiGuessPrompt');
    existingGuessLabel.textContent = 'Guess Personality Prompt:';
    existingGuessGroup.appendChild(existingGuessLabel);

    const existingGuessTextarea = document.createElement('textarea');
    existingGuessTextarea.id = 'aiGuessPrompt';
    existingGuessTextarea.rows = 5;
    existingGuessTextarea.placeholder = 'Enter guess prompt for AI personality';
    existingGuessGroup.appendChild(existingGuessTextarea);

    const existingGuessHint = document.createElement('p');
    existingGuessHint.className = 'form-hint';
    existingGuessHint.textContent = 'This prompt controls how the AI makes guesses';
    existingGuessGroup.appendChild(existingGuessHint);

    existingForm.appendChild(existingGuessGroup);

    formContainer.appendChild(existingForm);
    editorContainer.appendChild(formContainer);

    // Create button row
    const buttonRow = document.createElement('div');
    buttonRow.className = 'button-row';

    const saveBtn = document.createElement('button');
    saveBtn.type = 'button';
    saveBtn.id = 'saveAIPersonalityBtn';
    saveBtn.className = 'primary-btn';
    saveBtn.textContent = 'Save AI Personality';
    buttonRow.appendChild(saveBtn);

    editorContainer.appendChild(buttonRow);
    modalContent.appendChild(editorContainer);

    // Create close button
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.id = 'closeAIPersonalityEditorBtn';
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '&times;';
    modalContent.appendChild(closeBtn);

    editorModal.appendChild(modalContent);
    document.body.appendChild(editorModal);
}

function setupEventListeners() {
    // We don't bind the main menu button here since it uses inline onclick
    // Find and bind to buttons created by createEditorUI
    document.getElementById('aiPersonalityEditorBtn').addEventListener('click', openSavedPersonalitiesEditor);

    // For dynamically created elements we still need delegation
    // Close editor button click
    document.getElementById('closeAIPersonalityEditorBtn').addEventListener('click', closeAIPersonalityEditor);

    // Save button click
    document.getElementById('saveAIPersonalityBtn').addEventListener('click', saveAIPersonality);

    // Create New AI button click
    document.getElementById('cancelCreateAIBtn').addEventListener('click', hideCreateNewAIForm);

    // AI player selection change
    document.getElementById('aiPlayerSelect').addEventListener('change', onAIPlayerSelect);
}

// Open the editor for saved personalities (called from main menu)
function openSavedPersonalitiesEditor() {
    // Ensure UI is created
    createEditorUI();

    // Show saved personalities
    updateSavedPersonalitiesList();

    // Show the modal
    if (editorModal) {
        editorModal.style.display = 'flex';
    }

    // Hide create new AI form initially
    hideCreateNewAIForm();
}

// Open the editor for in-game AI players (called during game)
function openAIPersonalityEditor() {
    // Ensure UI is created
    createEditorUI();

    // Request current AI players from server
    const roomCode = document.getElementById('currentRoom').textContent;
    socket.emit('getAIPlayers', roomCode);

    // Show the modal
    if (editorModal) {
        editorModal.style.display = 'flex';
    }

    // Hide create new AI form initially
    hideCreateNewAIForm();
}

function closeAIPersonalityEditor() {
    if (editorModal) {
        editorModal.style.display = 'none';
    }
}

// Update the list of saved AI personalities (for main menu)
function updateSavedPersonalitiesList() {
    const selectElement = document.getElementById('aiPlayerSelect');
    if (!selectElement) return;

    // Clear existing options
    selectElement.innerHTML = '<option value="">-- Select an AI Player --</option>';

    // Add option to create new AI player
    selectElement.innerHTML += '<option value="create_new">Create New AI Player</option>';

    // Show saved personalities
    savedPersonalities.forEach((personality, index) => {
        const option = document.createElement('option');
        option.value = `saved-${index}`;
        option.textContent = personality.name || `Saved AI ${index + 1}`;
        selectElement.appendChild(option);
    });

    // Reset form
    const form = document.getElementById('aiPersonalityFormContainer');
    if (form) {
        form.style.display = 'none';
    }
}

// Update the list of in-game AI players
function updateInGameAIPlayersList() {
    const selectElement = document.getElementById('aiPlayerSelect');
    if (!selectElement) return;

    // Clear existing options
    selectElement.innerHTML = '<option value="">-- Select an AI Player --</option>';

    // Add option to create new AI player
    selectElement.innerHTML += '<option value="create_new">Create New AI Player</option>';

    // Show active AI players
    aiPlayers.forEach(player => {
        const option = document.createElement('option');
        option.value = player.id;
        option.textContent = player.username.replace('🤖 ', ''); // Remove AI prefix for cleaner display
        selectElement.appendChild(option);
    });

    // Reset form
    const form = document.getElementById('aiPersonalityFormContainer');
    if (form) {
        form.style.display = 'none';
    }
}

function onAIPlayerSelect(event) {
    const selectedValue = event.target.value;

    if (selectedValue === 'create_new') {
        showCreateNewAIForm();
    } else if (selectedValue) {
        // Show existing AI form - handle differently for saved vs in-game
        showExistingAIForm(selectedValue);
    } else {
        // Hide form when no selection
        const form = document.getElementById('aiPersonalityFormContainer');
        if (form) {
            form.style.display = 'none';
        }
    }
}

function showCreateNewAIForm() {
    const formContainer = document.getElementById('aiPersonalityFormContainer');
    const createNewForm = document.getElementById('createNewAIForm');
    const existingAIForm = document.getElementById('existingAIForm');

    if (!formContainer || !createNewForm || !existingAIForm) return;

    // Show create new AI form
    createNewForm.style.display = 'block';
    existingAIForm.style.display = 'none';
    formContainer.style.display = 'block';

    // Reset form fields - Don't reset for better UX, keep last values
    // document.getElementById('newAIName').value = '';
    // Don't reset prompt fields as they contain default text
}

function hideCreateNewAIForm() {
    const formContainer = document.getElementById('aiPersonalityFormContainer');
    const selectElement = document.getElementById('aiPlayerSelect');

    if (!formContainer || !selectElement) return;

    formContainer.style.display = 'none';
    selectElement.selectedIndex = 0;
}

function showExistingAIForm(aiPlayerId) {
    let aiPlayer = null;

    // Handle saved personalities
    if (aiPlayerId.startsWith('saved-')) {
        const index = parseInt(aiPlayerId.replace('saved-', ''));
        if (index >= 0 && index < savedPersonalities.length) {
            aiPlayer = savedPersonalities[index];
        }
    } else {
        // Handle in-game AI players
        aiPlayer = aiPlayers.find(player => player.id === aiPlayerId);
    }

    if (!aiPlayer) {
        console.error('AI player not found:', aiPlayerId);
        return;
    }

    const formContainer = document.getElementById('aiPersonalityFormContainer');
    const createNewForm = document.getElementById('createNewAIForm');
    const existingAIForm = document.getElementById('existingAIForm');
    const aiPlayerName = document.getElementById('aiPlayerName');
    const aiChatPrompt = document.getElementById('aiChatPrompt');
    const aiGuessPrompt = document.getElementById('aiGuessPrompt');

    if (!formContainer || !createNewForm || !existingAIForm || !aiPlayerName || !aiChatPrompt || !aiGuessPrompt) return;

    // Show existing AI form
    createNewForm.style.display = 'none';
    existingAIForm.style.display = 'block';
    formContainer.style.display = 'block';

    // Default prompts
    const defaultChatPrompt = "You're playing a drawing game with friends. Look at this drawing and the chat history, then send a single casual, funny message as if you're a player. Don't guess what the drawing is. Instead, comment on the drawing process, react to other messages, or make a light joke. But surprising and sometimes controversial. Respond with your only chat message and nothing else.";
    const defaultGuessPrompt = "You are playing Pictionary. Look at this drawing and make a fun creative guess of what it represents. Your guess will be remixed with the drawing by an AI, so you should avoid obvious answers and guess something whacky and interesting that will result in something fun and surprising. Your guess can be a word or phrase. If the drawing seems incomplete or unclear, make your best guess anyway. Respond with just your guess.";

    // Fill in the form with AI player data
    if (aiPlayerId.startsWith('saved-')) {
        aiPlayerName.textContent = aiPlayer.name || `Saved AI ${aiPlayerId.replace('saved-', '')}`;
    } else {
        aiPlayerName.textContent = aiPlayer.username || 'AI Player';
    }

    aiChatPrompt.value = aiPlayer.chatPrompt || defaultChatPrompt;
    aiGuessPrompt.value = aiPlayer.guessPrompt || defaultGuessPrompt;
}

// Save AI personality locally
function saveLocalAIPersonality() {
    const selectedAI = document.getElementById('aiPlayerSelect').value;

    if (selectedAI === 'create_new') {
        // Creating a new AI personality
        const newAIName = document.getElementById('newAIName').value.trim();
        const newAIChatPrompt = document.getElementById('newAIChatPrompt').value.trim();
        const newAIGuessPrompt = document.getElementById('newAIGuessPrompt').value.trim();

        if (!newAIName) {
            showNotification('Please enter a name for the new AI player', 'error');
            return;
        }

        // Create new local personality
        const newPersonality = {
            name: newAIName,
            chatPrompt: newAIChatPrompt,
            guessPrompt: newAIGuessPrompt
        };

        // Add to saved personalities
        savedPersonalities.push(newPersonality);
        savePersonalitiesToStorage();

        showNotification('AI personality saved successfully!', 'success');
        closeAIPersonalityEditor();
    }
    else if (selectedAI && selectedAI.startsWith('saved-')) {
        // Updating existing saved personality
        const index = parseInt(selectedAI.replace('saved-', ''));
        if (index >= 0 && index < savedPersonalities.length) {
            const aiChatPrompt = document.getElementById('aiChatPrompt').value.trim();
            const aiGuessPrompt = document.getElementById('aiGuessPrompt').value.trim();

            // Update the saved personality
            savedPersonalities[index].chatPrompt = aiChatPrompt;
            savedPersonalities[index].guessPrompt = aiGuessPrompt;
            savePersonalitiesToStorage();

            showNotification('AI personality updated successfully!', 'success');
            closeAIPersonalityEditor();
        }
    }
}

// Save AI personality in game
function saveAIPersonality() {
    const selectedAI = document.getElementById('aiPlayerSelect').value;
    const roomCode = document.getElementById('currentRoom')?.textContent;

    // Check if we're in a room (in-game)
    if (!roomCode) {
        // If not in a room, save locally
        saveLocalAIPersonality();
        return;
    }

    if (selectedAI === 'create_new') {
        // Creating a new AI player in game
        const newAIName = document.getElementById('newAIName').value.trim();
        const newAIChatPrompt = document.getElementById('newAIChatPrompt').value.trim();
        const newAIGuessPrompt = document.getElementById('newAIGuessPrompt').value.trim();

        if (!newAIName) {
            showNotification('Please enter a name for the new AI player', 'error');
            return;
        }

        // Send request to create new AI with personality
        socket.emit('createAIPlayer', {
            roomCode,
            name: newAIName,
            chatPrompt: newAIChatPrompt,
            guessPrompt: newAIGuessPrompt
        });
    }
    else if (selectedAI && !selectedAI.startsWith('saved-')) {
        // Updating existing AI player
        const aiChatPrompt = document.getElementById('aiChatPrompt').value.trim();
        const aiGuessPrompt = document.getElementById('aiGuessPrompt').value.trim();

        // Send request to update AI personality
        socket.emit('updateAIPlayer', {
            roomCode,
            aiPlayerId: selectedAI,
            chatPrompt: aiChatPrompt,
            guessPrompt: aiGuessPrompt
        });
    }
}

function showNotification(message, type = 'info') {
    const notification = document.createElement('div');
    notification.className = `notification ${type}`;
    notification.textContent = message;

    // Add to body
    document.body.appendChild(notification);

    // Fade in
    setTimeout(() => {
        notification.style.opacity = '1';
    }, 10);

    // Fade out and remove
    setTimeout(() => {
        notification.style.opacity = '0';
        setTimeout(() => {
            document.body.removeChild(notification);
        }, 500);
    }, 3000);
}

// Get saved AI personalities
function getSavedPersonalities() {
    return loadSavedPersonalities();
}

// Export functions to global scope
window.aiPersonalityEditor = {
    initAIPersonalityEditor,
    openAIPersonalityEditor,
    openSavedPersonalitiesEditor,
    getSavedPersonalities
};