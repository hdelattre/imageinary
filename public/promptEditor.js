// Prompt Editor Module
let imagePrompt = localStorage.getItem('imageinary_image_prompt') || PROMPT_CONFIG.IMAGE_GEN_PROMPT;
let chatPrompt = localStorage.getItem('imageinary_chat_prompt') || PROMPT_CONFIG.CHAT_PROMPT;
let guessPrompt = localStorage.getItem('imageinary_guess_prompt') || PROMPT_CONFIG.GUESS_PROMPT;
let isEditingRoomPrompt = false;

// Function to open prompt editor with a specific prompt
function openPromptEditorWithPrompt(prompts) {
    const viewPromptBtn = document.getElementById('viewPromptBtn');
    if (viewPromptBtn) {
        viewPromptBtn.style.display = 'none';
    }

    const promptTemplate = document.getElementById('promptTemplate');
    const chatPromptTemplate = document.getElementById('chatPromptTemplate');
    const guessPromptTemplate = document.getElementById('guessPromptTemplate');

    // Save the current room prompts for reference
    window.currentRoomPrompts = prompts; // Store all prompts
    isEditingRoomPrompt = true;

    // Set initial values
    promptTemplate.value = prompts.imagePrompt || PROMPT_CONFIG.IMAGE_GEN_PROMPT;
    chatPromptTemplate.value = prompts.chatPrompt || PROMPT_CONFIG.CHAT_PROMPT;
    guessPromptTemplate.value = prompts.guessPrompt || PROMPT_CONFIG.GUESS_PROMPT;
    document.getElementById('promptEditorModal').style.display = 'flex';
}

function closePromptEditor() {
    document.getElementById('promptEditorModal').style.display = 'none';
}

// Function to save the current prompts (handles both regular and room prompts)
function savePrompt() {
    if (isEditingRoomPrompt && !socket) {
        console.error('PromptEditor expected socket connection and cannot update room prompt.');
        return false;
    }

    const saveBtn = document.getElementById('savePromptBtn');
    const originalText = saveBtn.textContent;
    const promptValue = document.getElementById('promptTemplate').value.trim();
    const chatPromptValue = document.getElementById('chatPromptTemplate').value.trim();
    const guessPromptValue = document.getElementById('guessPromptTemplate').value.trim();
    const requiredPlaceholders = isEditingRoomPrompt ? ['guess'] : [];
    const validation = PROMPT_CONFIG.validatePrompt(promptValue, requiredPlaceholders);

    if (!validation.valid) {
        saveBtn.textContent = 'Error: ' + validation.error;
        saveBtn.style.backgroundColor = '#e74c3c';
        setTimeout(() => {
            saveBtn.textContent = originalText;
            saveBtn.style.backgroundColor = '';
        }, 2000);
        return false;
    }

    if (isEditingRoomPrompt) {
        const roomCode = document.getElementById('currentRoom').textContent;
        socket.emit('updateRoomPrompt', roomCode, {
            imagePrompt: promptValue,
            chatPrompt: chatPromptValue,
            guessPrompt: guessPromptValue
        });

        const viewPromptBtn = document.getElementById('viewPromptBtn');
        if (viewPromptBtn) {
            const btnOriginalBg = viewPromptBtn.style.backgroundColor;
            viewPromptBtn.style.backgroundColor = '#4CAF50';
            setTimeout(() => {
                viewPromptBtn.style.backgroundColor = btnOriginalBg;
            }, 2000);
        }
    } else {
        imagePrompt = promptValue;
        chatPrompt = chatPromptValue;
        guessPrompt = guessPromptValue;
        localStorage.setItem('imageinary_image_prompt', promptValue);
        localStorage.setItem('imageinary_chat_prompt', chatPromptValue);
        localStorage.setItem('imageinary_guess_prompt', guessPromptValue);
    }

    saveBtn.textContent = isEditingRoomPrompt ? 'Room Prompts Updated!' : 'Saved Successfully!';
    saveBtn.style.backgroundColor = '#4CAF50';
    setTimeout(() => {
        saveBtn.textContent = originalText;
        saveBtn.style.backgroundColor = '';
    }, 2000);

    closePromptEditor();

    if (isEditingRoomPrompt) {
        const viewPromptBtn = document.getElementById('viewPromptBtn');
        if (viewPromptBtn) {
            viewPromptBtn.style.display = '';
        }
    }

    return true;
}

// Function to reset prompts to appropriate values
function resetPrompt() {
    const resetBtn = document.getElementById('resetPromptBtn');
    const originalText = resetBtn.textContent;
    const promptTemplate = document.getElementById('promptTemplate');
    const chatPromptTemplate = document.getElementById('chatPromptTemplate');
    const guessPromptTemplate = document.getElementById('guessPromptTemplate');

    if (isEditingRoomPrompt && window.currentRoomPrompts) {
        promptTemplate.value = window.currentRoomPrompts.imagePrompt || PROMPT_CONFIG.IMAGE_GEN_PROMPT;
        chatPromptTemplate.value = window.currentRoomPrompts.chatPrompt || PROMPT_CONFIG.CHAT_PROMPT;
        guessPromptTemplate.value = window.currentRoomPrompts.guessPrompt || PROMPT_CONFIG.GUESS_PROMPT;
        resetBtn.textContent = 'Reset to Room Prompts';
    } else {
        promptTemplate.value = PROMPT_CONFIG.IMAGE_GEN_PROMPT;
        chatPromptTemplate.value = PROMPT_CONFIG.CHAT_PROMPT;
        guessPromptTemplate.value = PROMPT_CONFIG.GUESS_PROMPT;
        imagePrompt = PROMPT_CONFIG.IMAGE_GEN_PROMPT;
        chatPrompt = PROMPT_CONFIG.CHAT_PROMPT;
        guessPrompt = PROMPT_CONFIG.GUESS_PROMPT;
        localStorage.setItem('imageinary_image_prompt', PROMPT_CONFIG.IMAGE_GEN_PROMPT);
        localStorage.setItem('imageinary_chat_prompt', PROMPT_CONFIG.CHAT_PROMPT);
        localStorage.setItem('imageinary_guess_prompt', PROMPT_CONFIG.GUESS_PROMPT);
        resetBtn.textContent = 'Reset Successfully!';
    }

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

    // Setup socket handlers
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
            openPromptEditorWithPrompt(data.prompts);
        } else {
            showPromptModal(data.prompts);
        }
    });

    // Add chat and guess prompt sections directly to the modal
    const promptEditorContent = document.querySelector('.modal-content.prompt-editor');
    if (promptEditorContent) {
        // Chat Prompt Section
        const chatPromptSection = document.createElement('div');
        chatPromptSection.id = 'chatPromptSection';
        chatPromptSection.className = 'form-group';

        const chatPromptLabel = document.createElement('label');
        chatPromptLabel.setAttribute('for', 'chatPromptTemplate');
        chatPromptLabel.textContent = 'Chat Prompt:';
        chatPromptSection.appendChild(chatPromptLabel);

        const chatPromptTextarea = document.createElement('textarea');
        chatPromptTextarea.id = 'chatPromptTemplate';
        chatPromptTextarea.className = 'prompt-textarea';
        chatPromptTextarea.rows = 5;
        chatPromptTextarea.placeholder = 'Enter chat prompt template';
        chatPromptTextarea.value = chatPrompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
        chatPromptSection.appendChild(chatPromptTextarea);

        const chatPromptHint = document.createElement('p');
        chatPromptHint.className = 'form-hint';
        chatPromptHint.textContent = 'This prompt controls how AI players behave when chatting';
        chatPromptSection.appendChild(chatPromptHint);

        // Guess Prompt Section
        const guessPromptSection = document.createElement('div');
        guessPromptSection.id = 'guessPromptSection';
        guessPromptSection.className = 'form-group';

        const guessPromptLabel = document.createElement('label');
        guessPromptLabel.setAttribute('for', 'guessPromptTemplate');
        guessPromptLabel.textContent = 'Guess Prompt:';
        guessPromptSection.appendChild(guessPromptLabel);

        const guessPromptTextarea = document.createElement('textarea');
        guessPromptTextarea.id = 'guessPromptTemplate';
        guessPromptTextarea.className = 'prompt-textarea';
        guessPromptTextarea.rows = 5;
        guessPromptTextarea.placeholder = 'Enter guess prompt template';
        guessPromptTextarea.value = guessPrompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
        guessPromptSection.appendChild(guessPromptTextarea);

        const guessPromptHint = document.createElement('p');
        guessPromptHint.className = 'form-hint';
        guessPromptHint.textContent = 'This prompt controls how AI players make guesses';
        guessPromptSection.appendChild(guessPromptHint);

        // Insert chat and guess sections before the existing image prompt section
        const existingPromptSection = promptEditorContent.querySelector('.form-group'); // Assuming the image prompt is the first form-group
        if (existingPromptSection) {
            promptEditorContent.insertBefore(chatPromptSection, existingPromptSection);
            promptEditorContent.insertBefore(guessPromptSection, existingPromptSection);
        } else {
            // Fallback: append if no existing section found (shouldn't happen if HTML is correct)
            promptEditorContent.insertBefore(chatPromptSection, promptEditorContent.querySelector('.button-row'));
            promptEditorContent.insertBefore(guessPromptSection, promptEditorContent.querySelector('.button-row'));
        }

        // Set initial image prompt value
        const promptTemplate = document.getElementById('promptTemplate');
        promptTemplate.value = imagePrompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
    }

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
        isEditingRoomPrompt = false;
        const promptTemplate = document.getElementById('promptTemplate');
        const chatPromptTemplate = document.getElementById('chatPromptTemplate');
        const guessPromptTemplate = document.getElementById('guessPromptTemplate');
        promptTemplate.value = imagePrompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
        chatPromptTemplate.value = chatPrompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
        guessPromptTemplate.value = guessPrompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
        document.getElementById('promptEditorModal').style.display = 'flex';
    });

    document.getElementById('closePromptEditorBtn').addEventListener('click', () => {
        document.getElementById('promptEditorModal').style.display = 'none';
        isEditingRoomPrompt = false;
        const viewPromptBtn = document.getElementById('viewPromptBtn');
        if (viewPromptBtn) {
            viewPromptBtn.style.display = '';
        }
    });

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

    document.getElementById('testClearBtn').addEventListener('click', () => {
        testCtx.fillStyle = 'white';
        testCtx.fillRect(0, 0, testCanvas.width, testCanvas.height);
        document.getElementById('testImageContainer').innerHTML = '';
    });

    document.getElementById('testGenerateBtn').addEventListener('click', () => {
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
        const promptToUse = document.getElementById('promptTemplate').value.trim();
        const validation = PROMPT_CONFIG.validatePrompt(promptToUse, ['guess']);
        if (!validation.valid) {
            alert('Invalid prompt: ' + validation.error);
            return;
        }

        document.getElementById('testImageContainer').innerHTML = '<div class="loading">Generating image...</div>';
        socket.emit('testGenerateImage', { drawingData, guess, promptTemplate: promptToUse });
    });
}

// Prompt display only modal
function showPromptModal(prompts) {
    const viewPromptBtn = document.getElementById('viewPromptBtn');
    if (viewPromptBtn) {
        viewPromptBtn.style.display = 'none';
    }

    const viewPromptText = document.getElementById('viewPromptText');
    viewPromptText.textContent = `Image Prompt: ${prompts.imagePrompt || ""}\nChat Prompt: ${prompts.chatPrompt || ""}\nGuess Prompt: ${prompts.guessPrompt || ""}`;
    document.getElementById('promptViewModal').style.display = 'flex';
}

function setupPromptViewHandlers() {
    const closePromptViewBtn = document.getElementById('closePromptViewBtn');
    if (closePromptViewBtn) {
        closePromptViewBtn.addEventListener('click', () => {
            document.getElementById('promptViewModal').style.display = 'none';
            const viewPromptBtn = document.getElementById('viewPromptBtn');
            if (viewPromptBtn) {
                viewPromptBtn.style.display = '';
            }
        });
    }
}

function viewRoomPrompt() {
    if (!socket) {
        console.error('Socket not initialized. Cannot get room prompt.');
        return;
    }

    const roomCode = document.getElementById('currentRoom').textContent;
    socket.emit('getRoomPrompts', roomCode);
}

window.addEventListener('load', () => {
    setupPromptViewHandlers();
});

window.promptEditor = {
    initPromptEditor,
    savePrompt,
    resetPrompt,
    openPromptEditorWithPrompt,
    showPromptModal,
    viewRoomPrompt,
    getCustomPrompts: () => ({ imagePrompt, chatPrompt, guessPrompt })
};