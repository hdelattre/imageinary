// Prompt Editor Module
let customPrompt = localStorage.getItem('imageinary_custom_prompt') || PROMPT_CONFIG.DEFAULT_PROMPT;
let isEditingRoomPrompt = false;

// Function to open prompt editor with a specific prompt
function openPromptEditorWithPrompt(prompt) {
    // Hide the view prompt button while the editor is open
    const viewPromptBtn = document.getElementById('viewPromptBtn');
    if (viewPromptBtn) {
        viewPromptBtn.style.display = 'none';
    }

    const promptTemplate = document.getElementById('promptTemplate');

    // Save the current room prompt for reference
    window.currentRoomPrompt = prompt;
    isEditingRoomPrompt = true;

    // Set initial value
    promptTemplate.value = prompt;
    document.getElementById('promptEditorModal').style.display = 'flex';
}

function closePromptEditor() {
    document.getElementById('promptEditorModal').style.display = 'none';
}

// Function to save the current prompt (handles both regular and room prompts)
function savePrompt() {
    // Verify socket is available
    if (isEditingRoomPrompt && !socket) {
        console.error('PromptEditor expected socket connection and cannot update room prompt.');
        return false;
    }

    const saveBtn = document.getElementById('savePromptBtn');
    const originalText = saveBtn.textContent;
    const promptValue = document.getElementById('promptTemplate').value.trim();
    const validation = PROMPT_CONFIG.validatePrompt(promptValue);

    if (!validation.valid) {
        // Show error message
        saveBtn.textContent = 'Error: ' + validation.error;
        saveBtn.style.backgroundColor = '#e74c3c';
        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.style.backgroundColor = '';
        }, 2000);
        return false;
    }

    // Get validated prompt (which may have been trimmed)
    const newPrompt = validation.prompt;

    // If editing a room prompt, update it on the server
    if (isEditingRoomPrompt) {
        const roomCode = document.getElementById('currentRoom').textContent;
        // Send the updated prompt to the server
        socket.emit('updateRoomPrompt', { roomCode, prompt: newPrompt });

        // Show success feedback on the view prompt button
        const viewPromptBtn = document.getElementById('viewPromptBtn');
        if (viewPromptBtn) {
            const btnOriginalBg = viewPromptBtn.style.backgroundColor;
            viewPromptBtn.style.backgroundColor = '#4CAF50';
            setTimeout(() => {
                viewPromptBtn.style.backgroundColor = btnOriginalBg;
            }, 2000);
        }
    }
    else {
        // Update local storage for future games
        customPrompt = newPrompt;
        localStorage.setItem('imageinary_custom_prompt', newPrompt);
    }

    // Handle any warnings (like trimming)
    if (validation.warning) {
        saveBtn.textContent = validation.warning;
        saveBtn.style.backgroundColor = '#f39c12';
        setTimeout(() => {
            saveBtn.textContent = isEditingRoomPrompt ? 'Room Prompt Updated!' : 'Saved Successfully!';
            saveBtn.style.backgroundColor = '#4CAF50';
            setTimeout(() => {
                saveBtn.textContent = originalText;
                saveBtn.style.backgroundColor = '';
            }, 1500);
        }, 1500);
    } else {
        // Show success feedback
        saveBtn.textContent = isEditingRoomPrompt ? 'Room Prompt Updated!' : 'Saved Successfully!';
        saveBtn.style.backgroundColor = '#4CAF50';
        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.style.backgroundColor = '';
        }, 2000);
    }

    // Close the modal
    closePromptEditor();

    // Show the view prompt button again when saving
    if (isEditingRoomPrompt) {
        const viewPromptBtn = document.getElementById('viewPromptBtn');
        if (viewPromptBtn) {
            viewPromptBtn.style.display = '';
        }
    }

    return true;
}

// Function to reset prompt to appropriate value
function resetPrompt() {
    const resetBtn = document.getElementById('resetPromptBtn');
    const originalText = resetBtn.textContent;
    const promptTemplate = document.getElementById('promptTemplate');

    // If we're editing a room prompt, use the saved room prompt
    if (isEditingRoomPrompt && window.currentRoomPrompt) {
        promptTemplate.value = window.currentRoomPrompt;
        resetBtn.textContent = 'Reset to Room Prompt';
    } else {
        // Otherwise use the default prompt
        promptTemplate.value = PROMPT_CONFIG.DEFAULT_PROMPT;
        customPrompt = PROMPT_CONFIG.DEFAULT_PROMPT;
        localStorage.setItem('imageinary_custom_prompt', PROMPT_CONFIG.DEFAULT_PROMPT);
        resetBtn.textContent = 'Reset Successfully!';
    }

    // Show success feedback
    resetBtn.style.backgroundColor = '#4CAF50';
    setTimeout(() => {
        resetBtn.textContent = originalText;
        resetBtn.style.backgroundColor = '';
    }, 2000);
}

function initPromptEditor() {
    if (!socket) {
        console.log("PromptEditor expected global socket and cannot init");
        return;
    }

    // Setup socket
    socket.on('testImageResult', (data) => {
        if (data.error) {
            document.getElementById('testImageContainer').innerHTML = `<div class="error">${data.error}</div>`;
        } else {
            document.getElementById('testImageContainer').innerHTML = `<img src="${data.imageSrc}" alt="Generated test image" class="test-image">`;
        }
    });

    socket.on('roomPrompt', (data) => {
        console.log('Received room prompt data:', data);
        if (data.isHost) {
            openPromptEditorWithPrompt(data.prompt);
        } else {
            showPromptModal(data.prompt);
        }
    });

    // Set initial prompt in the editor (ensure it's within length limit)
    const promptTemplate = document.getElementById('promptTemplate');
    promptTemplate.value = customPrompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);

    // Setup test canvas
    const testCanvas = document.getElementById('testCanvas');
    const testCtx = testCanvas.getContext('2d');
    testCtx.fillStyle = 'white';
    testCtx.fillRect(0, 0, testCanvas.width, testCanvas.height);
    testCtx.lineCap = 'round';
    testCtx.lineJoin = 'round';

    let testDrawing = false;

    // Event handlers for the prompt editor
    document.getElementById('promptEditorBtn').addEventListener('click', () => {
        // Reset flag - this is just the regular prompt editor, not a room prompt
        isEditingRoomPrompt = false;
        promptTemplate.value = customPrompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
        document.getElementById('promptEditorModal').style.display = 'flex';
    });

    document.getElementById('closePromptEditorBtn').addEventListener('click', () => {
        document.getElementById('promptEditorModal').style.display = 'none';
        // Reset the editing state
        isEditingRoomPrompt = false;

        // Show the view prompt button again when the editor is closed
        const viewPromptBtn = document.getElementById('viewPromptBtn');
        if (viewPromptBtn) {
            viewPromptBtn.style.display = '';
        }
    });

    // Unified handlers for both regular and room prompts
    document.getElementById('savePromptBtn').addEventListener('click', savePrompt);
    document.getElementById('resetPromptBtn').addEventListener('click', resetPrompt);

    // Test canvas drawing events
    testCanvas.addEventListener('mousedown', (e) => {
        testDrawing = true;
        const rect = testCanvas.getBoundingClientRect();
        const scaleX = testCanvas.width / rect.width;
        const scaleY = testCanvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        testCtx.beginPath();
        testCtx.moveTo(x, y);
    });

    testCanvas.addEventListener('mousemove', (e) => {
        if (!testDrawing) return;
        const rect = testCanvas.getBoundingClientRect();
        const scaleX = testCanvas.width / rect.width;
        const scaleY = testCanvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        testCtx.strokeStyle = document.getElementById('testColorPicker').value;
        testCtx.lineWidth = 3;
        testCtx.lineTo(x, y);
        testCtx.stroke();
    });

    testCanvas.addEventListener('mouseup', () => {
        testDrawing = false;
    });

    testCanvas.addEventListener('mouseleave', () => {
        testDrawing = false;
    });

    // Touch events for test canvas
    testCanvas.addEventListener('touchstart', handleTestTouchStart, { passive: false });
    testCanvas.addEventListener('touchmove', handleTestTouchMove, { passive: false });
    testCanvas.addEventListener('touchend', handleTestTouchEnd, { passive: false });

    function handleTestTouchStart(e) {
        e.preventDefault();
        testDrawing = true;
        const touch = e.touches[0];
        const rect = testCanvas.getBoundingClientRect();
        const scaleX = testCanvas.width / rect.width;
        const scaleY = testCanvas.height / rect.height;
        const x = (touch.clientX - rect.left) * scaleX;
        const y = (touch.clientY - rect.top) * scaleY;
        testCtx.beginPath();
        testCtx.moveTo(x, y);
    }

    function handleTestTouchMove(e) {
        e.preventDefault();
        if (!testDrawing) return;
        const touch = e.touches[0];
        const rect = testCanvas.getBoundingClientRect();
        const scaleX = testCanvas.width / rect.width;
        const scaleY = testCanvas.height / rect.height;
        const x = (touch.clientX - rect.left) * scaleX;
        const y = (touch.clientY - rect.top) * scaleY;
        testCtx.strokeStyle = document.getElementById('testColorPicker').value;
        testCtx.lineWidth = 3;
        testCtx.lineTo(x, y);
        testCtx.stroke();
    }

    function handleTestTouchEnd(e) {
        e.preventDefault();
        testDrawing = false;
    }

    // Test buttons and generation
    document.getElementById('testClearBtn').addEventListener('click', () => {
        testCtx.fillStyle = 'white';
        testCtx.fillRect(0, 0, testCanvas.width, testCanvas.height);
        document.getElementById('testImageContainer').innerHTML = '';
    });

    document.getElementById('testGenerateBtn').addEventListener('click', () => {
        // Verify socket is available
        if (!socket) {
            console.error('Socket not initialized. Cannot generate test image.');
            alert('Connection error. Please try again later.');
            return;
        }

        const guess = document.getElementById('testGuessInput').value.trim();
        if (!guess) {
            alert('Please enter a sample guess!');
            return;
        }

        const drawingData = testCanvas.toDataURL();
        const promptToUse = promptTemplate.value.trim();

        if (!promptToUse.includes('{guess}')) {
            alert('Prompt must include {guess} placeholder!');
            return;
        }

        // Show loading indicator
        document.getElementById('testImageContainer').innerHTML = '<div class="loading">Generating image...</div>';

        // Send to server for test generation
        socket.emit('testGenerateImage', {
            drawingData,
            guess,
            promptTemplate: promptToUse
        });
    });
}

// -- Prompt display only modal --
function showPromptModal(promptText) {
    // Hide the view prompt button while the modal is open
    const viewPromptBtn = document.getElementById('viewPromptBtn');
    if (viewPromptBtn) {
        viewPromptBtn.style.display = 'none';
    }

    const viewPromptText = document.getElementById('viewPromptText');
    viewPromptText.textContent = promptText;
    document.getElementById('promptViewModal').style.display = 'flex';
}

function setupPromptViewHandlers() {
    // Set up the prompt view modal close functionality
    const closePromptViewBtn = document.getElementById('closePromptViewBtn');
    if (closePromptViewBtn) {
        closePromptViewBtn.addEventListener('click', () => {
            document.getElementById('promptViewModal').style.display = 'none';

            // Show the view prompt button again when the modal is closed
            const viewPromptBtn = document.getElementById('viewPromptBtn');
            if (viewPromptBtn) {
                viewPromptBtn.style.display = '';
            }
        });
    }
}

// Function to view or edit room prompt
function viewRoomPrompt() {
    if (!socket) {
        console.error('Socket not initialized. Cannot get room prompt.');
        return;
    }

    const roomCode = document.getElementById('currentRoom').textContent;
    // Get room prompt with host check included
    socket.emit('getRoomPrompt', roomCode);
}

// Export the public functions
window.addEventListener('load', () => {
    // Setup prompt view handler when the page loads
    setupPromptViewHandlers();
});

// Export functions to global scope
window.promptEditor = {
    initPromptEditor,
    savePrompt,
    resetPrompt,
    openPromptEditorWithPrompt,
    showPromptModal,
    viewRoomPrompt,
    getCustomPrompt: () => customPrompt
};