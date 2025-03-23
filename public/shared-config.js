// Shared configuration between client and server
const CONFIG = {
    // Default prompt for AI generation
    DEFAULT_PROMPT: "Make this pictionary sketch look hyperrealistic but also stay faithful to the borders and shapes in the sketch even if it looks weird. It must look like the provided sketch! Do not modify important shapes/silhouettes in the sketch, just fill them in. Make it look like the provided guess: {guess}",
    MAX_PROMPT_LENGTH: 1024 // Maximum length of prompt in characters
};

// For client-side
if (typeof window !== 'undefined') {
    window.CONFIG = CONFIG;
}

// For server-side
if (typeof module !== 'undefined' && module.exports) {
    module.exports = CONFIG;
}