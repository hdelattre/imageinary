// Shared configuration between client and server
const PROMPT_CONFIG = {
    // Default prompt for AI generation
    DEFAULT_PROMPT: "Make this pictionary sketch look hyperrealistic but also stay faithful to the borders and shapes in the sketch even if it looks weird. It must look like the provided sketch! Do not modify important shapes/silhouettes in the sketch, just fill them in. Make it look like the provided guess: {guess}",
    MAX_PROMPT_LENGTH: 1024, // Maximum length of prompt in characters
    VALID_CHARS: '{}./!?-,\'',
    // Function to valid/clean up prompt
    validatePrompt: (prompt) => {
        // Check if prompt is empty
        if (!prompt) {
            return { 
                valid: false, 
                prompt: null,
                error: 'Prompt cannot be empty'
            };
        }

        // Check if prompt includes the {guess} placeholder
        if (!prompt.includes('{guess}')) {
            return { 
                valid: false, 
                prompt: null,
                error: 'Missing {guess} placeholder'
            };
        }
 
        // Check if prompt exceeds maximum length
        if (prompt.length > PROMPT_CONFIG.MAX_PROMPT_LENGTH) {
            const trimmed = prompt.slice(0, PROMPT_CONFIG.MAX_PROMPT_LENGTH);
            return { 
                valid: true, 
                prompt: trimmed,
                warning: `Trimmed to ${PROMPT_CONFIG.MAX_PROMPT_LENGTH} chars`
            };
        }

        // Prompt is valid
        return { valid: true, prompt: prompt };
    }
};

// For client-side
if (typeof window !== 'undefined') {
    window.PROMPT_CONFIG = PROMPT_CONFIG;
}

// For server-side
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PROMPT_CONFIG;
}