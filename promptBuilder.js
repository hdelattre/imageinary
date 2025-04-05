// promptBuilder.js - Handles crafting different prompts to geminiService
const PROMPT_CONFIG = require('./public/shared-config');

// Default prompt constants
const DEFAULT_CHAT_PROMPT = "You're playing a drawing game with friends. Look at this drawing and the chat history, then send a single casual, funny message as if you're a player. Don't guess what the drawing is. Instead, comment on the drawing process, react to other messages, or make a light joke. But surprising and sometimes controversial. Respond with your only chat message and nothing else.";

/**
 * Builds an image generation prompt using the custom prompt template and a guess
 * @param {string} guess - The user's guess
 * @param {string} customPrompt - Custom prompt template to use (with {guess} placeholder)
 * @returns {string} - The formatted generation prompt
 */
function buildImageGenerationPrompt(guess, customPrompt) {
    // Use custom prompt template if available, otherwise use default
    const promptTemplate = customPrompt || PROMPT_CONFIG.IMAGE_GEN_PROMPT;

    // Replace the placeholder with the actual guess
    return promptTemplate.replace('{guess}', guess);
}

/**
 * Builds a prompt for AI guessing based on a drawing
 * @param {string} recentChatHistory - Recent chat history for context
 * @param {string} username - The AI player's username
 * @param {string} corePersonalityPrompt - The AI's personality description (uses core personality default if null)
 * @param {string} customGuessPrompt - Custom guess prompt to use (uses default if null)
 * @returns {string} - The complete prompt for the AI to make a guess
 */
function buildAIGuessPrompt(recentChatHistory, username, corePersonalityPrompt, customGuessPrompt) {
    // Use the AI's custom guess prompt if available, otherwise use default
    const actionPrompt = customGuessPrompt || PROMPT_CONFIG.GUESS_PROMPT;

    // Use default core personality if not provided
    const personalityPrompt = corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;

    // Set up the guess prompt with updated structure including personality and username
    return `You are ${username}. Your personality: ${personalityPrompt}\n\nRecent chat history:\n${recentChatHistory}\n\n${actionPrompt}`;
}

/**
 * Builds a prompt for AI chat messages based on a drawing
 * @param {string} recentChatHistory - Recent chat history for context
 * @param {string} username - The AI player's username
 * @param {string} corePersonalityPrompt - The AI's personality description (uses core personality default if null)
 * @param {string} customChatPrompt - Custom chat prompt to use (uses default if null)
 * @returns {string} - The complete prompt for the AI to generate a chat message
 */
function buildAIChatPrompt(recentChatHistory, username, corePersonalityPrompt, customChatPrompt) {
    // Use the AI's custom chat prompt if available, otherwise use default
    const actionPrompt = customChatPrompt || DEFAULT_CHAT_PROMPT;

    // Use default core personality if not provided
    const personalityPrompt = corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;

    // Set up the chat prompt with updated structure including personality and username
    return `You are ${username}. Your personality: ${personalityPrompt}\n\nRecent chat history:\n${recentChatHistory}\n\n${actionPrompt}`;
}

/**
 * Builds a prompt for AI drawing creation
 * @param {string} recentChatHistory - Recent chat history for context
 * @param {string} username - The AI player's username
 * @param {string} corePersonalityPrompt - The AI's personality description (uses core personality default if null)
 * @param {string} currentPrompt - The word/concept to be drawn
 * @returns {string} - The complete prompt for the AI to describe how it will draw
 */
function buildAIDrawingConceptPrompt(recentChatHistory, username, corePersonalityPrompt, currentPrompt) {
    // Drawing concept prompt with personality and context
    const drawPrompt = `You need to draw ${currentPrompt}. Based on your personality and the chat history, describe briefly how you will draw it.`;

    // Use default core personality if not provided
    const personalityPrompt = corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;

    // Set up the drawing prompt with updated structure
    return `You are ${username}. Your personality: ${personalityPrompt}\n\nRecent chat history:\n${recentChatHistory}\n\n${drawPrompt}`;
}

/**
 * Builds a prompt for actual AI drawing generation
 * @param {string} drawingSubject - The word/concept to be drawn
 * @returns {string} - The prompt for generating a Pictionary-style drawing
 */
function buildAIDrawingCreationPrompt(drawingSubject) {
    return `Create a fun black and white Pictionary-style drawing of a "${drawingSubject}". Make it look hand-drawn and somewhat recognizable ${drawingSubject}. The drawing should be stylized like a human would draw it when playing Pictionary - simple lines, no shading, minimal details.`;
}

/**
 * Builds a prompt for AI voting on generated images
 * @param {string} recentChatHistory - Recent chat history for context
 * @param {string} username - The AI player's username
 * @param {string} corePersonalityPrompt - The AI's personality description (uses core personality default if null)
 * @param {Array} options - List of options the AI can vote for
 * @returns {string} - The complete prompt for the AI to vote on images
 */
function buildAIVotingPrompt(recentChatHistory, username, corePersonalityPrompt, options) {
    // Create options list for voting
    const optionsList = options.map((option, index) =>
        `${index + 1}. Guess "${option.guess}" by ${option.playerName}`
    ).join('\n');

    // Create voting prompt
    const votePrompt = `Here are the options to vote on:\n${optionsList}\n\nBased on your personality and the chat history, vote for the best one by specifying the number and provide a brief reason. Format your response as 'Vote: [number]\nReason: [reason]'`;

    // Use default core personality if not provided
    const personalityPrompt = corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;

    // Set up the complete prompt with personality and context
    return `You are ${username}. Your personality: ${personalityPrompt}\n\nRecent chat history:\n${recentChatHistory}\n\n${votePrompt}`;
}

/**
 * Creates a formatted chat history string from recent messages
 * @param {Array} chatHistory - Array of chat message objects
 * @param {number} messageCount - Number of recent messages to include
 * @returns {string} - Formatted chat history string
 */
function formatRecentChatHistory(chatHistory, messageCount = 5) {
    return chatHistory.slice(-messageCount).map(msg =>
        `${msg.username || 'System'}: ${msg.message}`
    ).join('\n');
}


module.exports = {
    // Prompt builders
    buildImageGenerationPrompt,
    buildAIGuessPrompt,
    buildAIChatPrompt,
    buildAIDrawingConceptPrompt,
    buildAIDrawingCreationPrompt,
    buildAIVotingPrompt,
    formatRecentChatHistory,

    // Constants
    DEFAULT_CHAT_PROMPT
};