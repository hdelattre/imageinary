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

    // Core personality prompt group
    const coreGroup = document.createElement('div');
    coreGroup.className = 'form-group';

    const coreLabel = document.createElement('label');
    coreLabel.setAttribute('for', 'newAICorePrompt');
    coreLabel.textContent = 'Core Personality:';
    coreGroup.appendChild(coreLabel);

    const coreTextarea = document.createElement('textarea');
    coreTextarea.id = 'newAICorePrompt';
    coreTextarea.rows = 2;
    coreTextarea.placeholder = 'Enter core personality description';
    // Default core personality
    coreTextarea.value = PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;
    coreGroup.appendChild(coreTextarea);

    const coreHint = document.createElement('p');
    coreHint.className = 'form-hint';
    coreHint.textContent = 'This defines the AI\'s character traits across all actions';
    coreGroup.appendChild(coreHint);

    createNewForm.appendChild(coreGroup);



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

    const existingHeader = document.createElement('div');
    existingHeader.className = 'ai-header-row';

    const titleHeader = document.createElement('h4');
    titleHeader.innerHTML = 'Edit AI Player: <span id="aiPlayerName"></span>';
    existingHeader.appendChild(titleHeader);

    // Add delete button for saved personalities
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.id = 'deleteAIPersonalityBtn';
    deleteBtn.className = 'danger-btn';
    deleteBtn.textContent = 'Delete';
    deleteBtn.style.display = 'none'; // Only show for saved personalities
    existingHeader.appendChild(deleteBtn);

    existingForm.appendChild(existingHeader);

    // Core personality prompt group
    const existingCoreGroup = document.createElement('div');
    existingCoreGroup.className = 'form-group';

    const existingCoreLabel = document.createElement('label');
    existingCoreLabel.setAttribute('for', 'aiCorePrompt');
    existingCoreLabel.textContent = 'Core Personality:';
    existingCoreGroup.appendChild(existingCoreLabel);

    const existingCoreTextarea = document.createElement('textarea');
    existingCoreTextarea.id = 'aiCorePrompt';
    existingCoreTextarea.rows = 2;
    existingCoreTextarea.placeholder = 'Enter core personality description';
    existingCoreGroup.appendChild(existingCoreTextarea);

    const existingCoreHint = document.createElement('p');
    existingCoreHint.className = 'form-hint';
    existingCoreHint.textContent = 'This defines the AI\'s character traits across all actions';
    existingCoreGroup.appendChild(existingCoreHint);

    existingForm.appendChild(existingCoreGroup);


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

    // Delete button click
    document.getElementById('deleteAIPersonalityBtn').addEventListener('click', deleteAIPersonality);

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
    const aiCorePrompt = document.getElementById('aiCorePrompt');

    if (!formContainer || !createNewForm || !existingAIForm || !aiPlayerName || !aiCorePrompt) return;

    // Show existing AI form
    createNewForm.style.display = 'none';
    existingAIForm.style.display = 'block';
    formContainer.style.display = 'block';

    // Fill in the form with AI player data
    // Show or hide delete button based on whether it's a saved personality
    const deleteBtn = document.getElementById('deleteAIPersonalityBtn');

    if (aiPlayerId.startsWith('saved-')) {
        aiPlayerName.textContent = aiPlayer.name || `Saved AI ${aiPlayerId.replace('saved-', '')}`;
        // Show delete button for saved personalities
        deleteBtn.style.display = 'block';
        // Store the ID for delete operation
        deleteBtn.dataset.personalityId = aiPlayerId;
    } else {
        aiPlayerName.textContent = aiPlayer.username || 'AI Player';
        // Hide delete button for in-game personalities
        deleteBtn.style.display = 'none';
    }

    aiCorePrompt.value = aiPlayer.corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;
}

// Save AI personality locally
function saveLocalAIPersonality() {
    const selectedAI = document.getElementById('aiPlayerSelect').value;

    if (selectedAI === 'create_new') {
        // Creating a new AI personality
        const newAIName = document.getElementById('newAIName').value.trim();

        if (!newAIName) {
            showNotification('Please enter a name for the new AI player', 'error');
            return;
        }

        // Get core personality from the form
        const newAICorePrompt = document.getElementById('newAICorePrompt').value.trim();

        // Create new local personality
        const newPersonality = {
            name: newAIName,
            corePersonalityPrompt: newAICorePrompt != PROMPT_CONFIG.CORE_PERSONALITY_PROMPT ? newAICorePrompt : null
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
            const aiCorePrompt = document.getElementById('aiCorePrompt').value.trim();

            // Update the saved personality
            // Ensure corePersonalityPrompt exists on older saved personalities
            savedPersonalities[index].corePersonalityPrompt = aiCorePrompt || "a witty and sarcastic AI who loves to make clever remarks";
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
        const newAICorePrompt = document.getElementById('newAICorePrompt').value.trim();

        if (!newAIName) {
            showNotification('Please enter a name for the new AI player', 'error');
            return;
        }

        // Send request to create new AI with personality
        socket.emit('createAIPlayer', {
            roomCode,
            name: newAIName,
            corePersonalityPrompt: newAICorePrompt
        });
    }
    else if (selectedAI && !selectedAI.startsWith('saved-')) {
        // Updating existing AI player
        const aiCorePrompt = document.getElementById('aiCorePrompt').value.trim();

        // Send request to update AI personality
        socket.emit('updateAIPlayer', {
            roomCode,
            aiPlayerId: selectedAI,
            corePersonalityPrompt: aiCorePrompt
        });
    }
}

// Function to delete an AI personality
function deleteAIPersonality() {
    const deleteBtn = document.getElementById('deleteAIPersonalityBtn');
    const personalityId = deleteBtn.dataset.personalityId;

    if (!personalityId || !personalityId.startsWith('saved-')) {
        showNotification('No personality selected for deletion', 'error');
        return;
    }

    // Ask for confirmation
    if (!confirm('Are you sure you want to delete this AI personality? This cannot be undone.')) {
        return;
    }

    const index = parseInt(personalityId.replace('saved-', ''));
    if (index >= 0 && index < savedPersonalities.length) {
        // Remove the personality from the array
        const deletedName = savedPersonalities[index].name;
        savedPersonalities.splice(index, 1);

        // Save the updated array
        savePersonalitiesToStorage();

        // Notify the user
        showNotification(`AI personality "${deletedName}" deleted successfully`, 'success');

        // Update the list and close the edit form
        updateSavedPersonalitiesList();
        const formContainer = document.getElementById('aiPersonalityFormContainer');
        if (formContainer) {
            formContainer.style.display = 'none';
        }
    } else {
        showNotification('Failed to delete AI personality', 'error');
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

// Create AI personality selector modal for choosing AI to add
function createAIPersonalitySelector(personalities, roomCode, onSelected) {

    // Check if modal already exists
    let modal = document.getElementById('aiPersonalityModal');

    if (modal) {
        // If it exists, just make it visible and update its content
        modal.innerHTML = ''; // Clear existing content
        modal.style.display = 'flex'; // Make it visible
    } else {
        // Create a new modal if it doesn't exist
        modal = document.createElement('div');
        modal.className = 'modal';
        modal.id = 'aiPersonalityModal';
        modal.style.display = 'flex';
        document.body.appendChild(modal);
    }

    // Create modal content
    const modalContent = document.createElement('div');
    modalContent.className = 'modal-content ai-selector compact';

    // Add header
    const header = document.createElement('h2');
    header.textContent = 'Select AI Personality';
    modalContent.appendChild(header);

    // Add personality list container with scrolling
    const listContainer = document.createElement('div');
    listContainer.className = 'ai-personality-list-container';

    // Add personality list
    const list = document.createElement('div');
    list.className = 'ai-personality-list';

    // Add default option
    const defaultOption = document.createElement('div');
    defaultOption.className = 'ai-personality-option';
    defaultOption.innerHTML = `
        <div class="ai-option-header">
            <strong>Default AI</strong>
        </div>
        <p class="ai-option-description">Standard AI player with balanced chat and guessing</p>
    `;
    defaultOption.addEventListener('click', () => {
        // Call the onSelected callback with null personality (default)
        if (typeof onSelected === 'function') {
            onSelected(null);
        }
        hideAIPersonalityModal();
    });
    list.appendChild(defaultOption);

    // Add saved personalities
    personalities.forEach((personality, index) => {
        const option = document.createElement('div');
        option.className = 'ai-personality-option';

        // Get a brief description from the personality prompt
        let description = "";
        if (personality.corePersonalityPrompt) {
            const previewLen = 60;
            description = personality.corePersonalityPrompt.substring(0, previewLen) +
                (personality.corePersonalityPrompt.length > previewLen ? "..." : "");
        } else {
            description = "Custom AI with unique personality";
        }

        option.innerHTML = `
            <div class="ai-option-header">
                <strong>${personality.name || 'Saved AI ' + (index + 1)}</strong>
            </div>
            <p class="ai-option-description">${description}</p>
        `;

        option.addEventListener('click', () => {
            // Call the onSelected callback with the selected personality
            if (typeof onSelected === 'function') {
                onSelected(personality);
            }
            hideAIPersonalityModal();
        });
        list.appendChild(option);
    });

    listContainer.appendChild(list);
    modalContent.appendChild(listContainer);

    // Add close button
    const closeBtn = document.createElement('button');
    closeBtn.className = 'close-btn';
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', () => {
        hideAIPersonalityModal();
    });
    modalContent.appendChild(closeBtn);

    // Add the content to the modal
    modal.appendChild(modalContent);

    return modal;
}

// Helper function to hide the AI personality modal specifically
function hideAIPersonalityModal() {
    const modal = document.getElementById('aiPersonalityModal');
    if (modal) {
        // Hide the modal rather than removing it
        modal.style.display = 'none';
    }
}

// Export functions to global scope
window.aiPersonalityEditor = {
    initAIPersonalityEditor,
    openAIPersonalityEditor,
    openSavedPersonalitiesEditor,
    getSavedPersonalities,
    createAIPersonalitySelector,
    hideAIPersonalityModal
};