// promptBuilder.js - Handles crafting different prompts to geminiService
const PROMPT_CONFIG = require('./public/shared-config');
const DEFAULT_CHAT_PROMPT = "You're playing a drawing game with friends. Look at this drawing and the chat history, then send a single casual, funny message as if you're a player. Don't guess what the drawing is. Instead, comment on the drawing process, react to other messages, or make a light joke. But surprising and sometimes controversial. Respond with your only chat message and nothing else.";

function formatChatHistory(chatHistory, messageCount = 10) {
    return chatHistory.slice(-messageCount).map(msg =>
        `${msg.username || 'System'}: ${msg.message}`
    ).join('\n');
}

function buildImageGenerationPrompt(guess, customPrompt) {
    const promptTemplate = customPrompt || PROMPT_CONFIG.IMAGE_GEN_PROMPT;
    return promptTemplate.replace('{guess}', guess);
}

function buildAIGuessPrompt(recentChatHistory, username, corePersonalityPrompt, customGuessPrompt) {
    recentChatHistory = formatChatHistory(recentChatHistory);
    const actionPrompt = customGuessPrompt || PROMPT_CONFIG.GUESS_PROMPT;
    const personalityPrompt = corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;
    return `You are ${username}. Your personality: ${personalityPrompt}\n\nRecent chat history:\n${recentChatHistory}\n\n${actionPrompt}`;
}

function buildAIChatPrompt(recentChatHistory, username, corePersonalityPrompt, customChatPrompt) {
    recentChatHistory = formatChatHistory(recentChatHistory);
    const actionPrompt = customChatPrompt || DEFAULT_CHAT_PROMPT;
    const personalityPrompt = corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;
    return `You are ${username}. Your personality: ${personalityPrompt}\n\nRecent chat history:\n${recentChatHistory}\n\n${actionPrompt}`;
}

function buildAIDrawingConceptPrompt(recentChatHistory, username, corePersonalityPrompt, currentPrompt) {
    recentChatHistory = formatChatHistory(recentChatHistory);
    const drawPrompt = `You need to draw ${currentPrompt}. Based on your personality and the chat history, describe briefly how you will draw it.`;
    const personalityPrompt = corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;
    return `You are ${username}. Your personality: ${personalityPrompt}\n\nRecent chat history:\n${recentChatHistory}\n\n${drawPrompt}`;
}

function buildAIDrawingCreationPrompt(drawingSubject) {
    return `Create a fun black and white Pictionary-style drawing of a "${drawingSubject}". Make it look hand-drawn and somewhat recognizable ${drawingSubject}. The drawing should be stylized like a human would draw it when playing Pictionary - simple lines, no shading, minimal details.`;
}

function buildAIVotingPrompt(recentChatHistory, username, corePersonalityPrompt, options) {
    recentChatHistory = formatChatHistory(recentChatHistory);
    const optionsList = options.map((option, index) =>
        `${index + 1}. Guess "${option.guess}" by ${option.playerName}`
    ).join('\n');

    const votePrompt = `Here are the options to vote on:\n${optionsList}\n\nBased on your personality and the chat history, vote for the best one by specifying the number and provide a brief reason. Format your response as 'Vote: [number]\nReason: [reason]'`;
    const personalityPrompt = corePersonalityPrompt || PROMPT_CONFIG.CORE_PERSONALITY_PROMPT;
    return `You are ${username}. Your personality: ${personalityPrompt}\n\nRecent chat history:\n${recentChatHistory}\n\n${votePrompt}`;
}


module.exports = {
    buildImageGenerationPrompt,
    buildAIGuessPrompt,
    buildAIChatPrompt,
    buildAIDrawingConceptPrompt,
    buildAIDrawingCreationPrompt,
    buildAIVotingPrompt,
    formatChatHistory,
    DEFAULT_CHAT_PROMPT
};