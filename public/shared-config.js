// Shared configuration between client and server
const PROMPT_CONFIG = {
    // Default prompt for AI generation
    DEFAULT_PROMPT: "Generate an image of {guess}, meticulously shaped to fit the exact outer silhouette and proportions of the provided user drawing. Do not modify the fundamental shape or aspect ratio of the sketch in any way. Fill this constrained form with details to realistically resemble {guess}. The final artwork must have the same overall outline as the sketch, with {guess} elements adapted to this distorted shape. Do not include any background.",
    GUESS_PROMPT: "You are playing Pictionary. Look at this drawing and make a fun creative guess of what it represents. Your guess will be remixed with the drawing by an AI, so you should avoid obvious answers and guess something whacky and interesting that will result in something fun and surprising. Your guess can be a word or phrase. If the drawing seems incomplete or unclear, make your best guess anyway. Respond with just your guess.",
    MAX_PROMPT_LENGTH: 1024, // Maximum length of prompt in characters
    VALID_CHARS: '{}./!?-,\'',
    MAX_AI_PLAYERS: 4, // Maximum number of AI players allowed per room
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