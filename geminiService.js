const { GoogleGenerativeAI } = require('@google/generative-ai');

let genAI;

// Model configuration
const MODELS = {
    IMAGE_GEN: {
        NAME: "IMAGE_GEN",
        REQUESTS_PER_MINUTE: 10,
        model: null // Initialized in initializeGeminiService
    },
    FLASH: {
        NAME: "FLASH",
        REQUESTS_PER_MINUTE: 15,
        model: null
    },
    FLASH_LITE: {
        NAME: "FLASH_LITE",
        REQUESTS_PER_MINUTE: 30,
        model: null
    },
    GEMINI_1_5_FLASH: {
        NAME: "GEMINI_1_5",
        REQUESTS_PER_MINUTE: 15,
        model: null
    },
    GEMINI_2_5_PRO_EXP: {
        NAME: "GEMINI_2_5_PRO_EXP",
        REQUESTS_PER_MINUTE: 5,
        model: null
    }
};

// Track API usage for rate limiting with a rolling window approach
const modelUsage = Object.fromEntries(
    Object.keys(MODELS).map(modelName => [modelName, []])
);

// Track paused models (models that have exceeded their daily quota)
const pausedModels = new Map(); // modelKey -> unpause timestamp

/**
 * Initialize the Gemini service with an API key
 * @param {string} apiKey - The Gemini API key
 */
function initializeGeminiService(apiKey) {
    genAI = new GoogleGenerativeAI(apiKey);

    // Initialize models
    MODELS.IMAGE_GEN.model = genAI.getGenerativeModel({
        model: "gemini-2.0-flash-exp-image-generation",
        generationConfig: { responseModalities: ['Text', 'Image'] },
    });
    MODELS.FLASH.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    MODELS.FLASH_LITE.model = genAI.getGenerativeModel({ model: "gemini-2.0-flash-lite" });
    MODELS.GEMINI_1_5_FLASH.model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    MODELS.GEMINI_2_5_PRO_EXP.model = genAI.getGenerativeModel({ model: "gemini-2.5-pro-exp-03-25" });
}

/**
 * Check if a model is available based on rolling window and pause status
 * @param {string} modelKey - The model key to check
 * @param {number} requestsPerMinute - Maximum requests allowed per minute
 * @returns {boolean} - Whether the model is available
 */
function isModelAvailable(modelKey, requestsPerMinute) {
    const now = Date.now();
    const windowMs = 60 * 1000; // 1 minute window

    // Check if the model is paused
    const unpauseTime = pausedModels.get(modelKey);
    if (unpauseTime) {
        if (now < unpauseTime) {
            return false; // Model is paused
        }
        pausedModels.delete(modelKey);
    }

    // Filter timestamps to keep only those within the last minute
    modelUsage[modelKey] = modelUsage[modelKey].filter(
        timestamp => now - timestamp < windowMs
    );

    // Check if we're under the limit
    return modelUsage[modelKey].length < requestsPerMinute;
}

// Periodic cleanup to remove old timestamps and check paused models (runs every minute)
setInterval(() => {
    const now = Date.now();
    const windowMs = 60 * 1000;

    // Clean up model usage timestamps
    Object.entries(modelUsage).forEach(([modelName, timestamps]) => {
        modelUsage[modelName] = timestamps.filter(t => now - t < windowMs);
    });
}, 60 * 1000);

/**
 * Use a specific model if it's available
 * @param {string} modelName - The model name to use
 * @returns {Object|null} - The model info if available, null otherwise
 */
function useModel(modelName) {
    const modelInfo = MODELS[modelName];
    if (isModelAvailable(modelName, modelInfo.REQUESTS_PER_MINUTE)) {
        modelUsage[modelName].push(Date.now());
        return modelInfo;
    }
    return null;
}

/**
 * Get an available text model
 * @returns {Object|null} - The model info if available, null otherwise
 */
function getTextModel() {
    return useModel(MODELS.FLASH.NAME) || useModel(MODELS.FLASH_LITE.NAME) ||
        useModel(MODELS.GEMINI_1_5_FLASH.NAME);
}

/**
 * Get an available image model
 * @returns {Object|null} - The model info if available, null otherwise
 */
function getImageModel() {
    return useModel(MODELS.IMAGE_GEN.NAME);
}

/**
 * Request a response from Gemini API
 * @param {string} prompt - The text prompt
 * @param {string|null} drawingData - Optional image data as base64 or data URL
 * @param {boolean} textOnly - Whether to use text-only models
 * @returns {Promise<Object>} - The response with text and/or image data
 */
async function requestGeminiResponse(prompt, drawingData = null, textOnly = false) {
    let geminiModel;
    if (textOnly) {
        geminiModel = getTextModel();
    } else {
        geminiModel = getImageModel();
    }

    if (!geminiModel) {
        throw new Error(`No ${textOnly ? 'text' : 'image'} generation models available due to rate limits`);
    }

    // Log current usage for monitoring (optional)
    if (false) {
        const now = Date.now();
        const windowMs = 60 * 1000;
        const usageInfo = Object.entries(modelUsage)
        .filter(([modelName]) => MODELS[modelName].REQUESTS_PER_MINUTE > 0)
        .map(([modelName, timestamps]) => {
            const currentUsage = timestamps.filter(t => now - t < windowMs).length;
            if (currentUsage <= 0) return '';
            const maxRequests = MODELS[modelName].REQUESTS_PER_MINUTE;
            return `${modelName}=${currentUsage}/${maxRequests}, `;
        })
        .join('');
        console.log(`Model usage: ${usageInfo}`);
    }

    // Prepare the request content based on whether there's drawing data
    let content = [];
    if (drawingData) {
        // Extract base64 string from data URL if needed
        let base64Data = drawingData;
        if (drawingData.startsWith('data:')) {
            base64Data = drawingData.split(',')[1];
            if (!base64Data) {
                throw new Error('Invalid drawing data format');
            }
        }
        content = [
            prompt,
            { inlineData: { data: base64Data, mimeType: 'image/png' } }
        ];
    } else {
        content = [prompt];
    }

    try {
        // Make the request to Gemini
        const response = await geminiModel.model.generateContent(content);

        if (response.response.candidates.length === 0) {
            throw new Error('No candidates returned by the model');
        }

        const candidate = response.response.candidates[0];

        if (candidate.finishReason === 'RECITATION') {
            throw new Error('Model rejected input due to content safety policy');
        }

        if (!candidate || !candidate.content || !candidate.content.parts) {
            throw new Error('Invalid response structure from model');
        }

        // Default response object with both text and image data
        const result = {
            text: '',
            imageData: null,
            metadata: {
                finishReason: candidate.finishReason,
                safetyRatings: candidate.safetyRatings
            }
        };

        // Extract text content if available
        const textParts = candidate.content.parts.filter(part => typeof part.text === 'string');
        if (textParts.length > 0) {
            result.text = textParts.map(part => part.text).join(' ').trim();
        }

        // Extract image data if available (only for image model)
        if (!textOnly) {
            const imagePart = candidate.content.parts.find(part => part.inlineData);
            if (imagePart && imagePart.inlineData && imagePart.inlineData.data) {
                result.imageData = imagePart.inlineData.data;
            }
        }

        return result;

    } catch (error) {
        // Check for quota exceeded error (429 with specific details)
        if (error.status === 429) {
            const now = Date.now();
            let retryDelayMs = 30 * 1000; // Default retry delay (30 seconds)

            // Extract relevant error details once
            const details = error.errorDetails || [];
            const retryInfo = details.find(detail => detail['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
            const quotaFailure = details.find(detail => detail['@type'] === 'type.googleapis.com/google.rpc.QuotaFailure');

            // Handle retry delay if present
            if (retryInfo?.retryDelay) {
                const match = retryInfo.retryDelay.match(/^(\d+)(s)$/);
                if (match) {
                    retryDelayMs = parseInt(match[1]) * 1000; // Convert seconds to milliseconds
                }
            }

            // Check for daily quota violation
            const violation = quotaFailure?.violations?.[0];
            if (violation?.quotaMetric === 'generativelanguage.googleapis.com/generate_content_free_tier_requests' &&
                violation?.quotaId.includes('GenerateRequestsPerDayPerProjectPerModel')) {
                const pauseDurationMs = 30 * 60 * 1000; // 30 minutes
                const unpauseTime = now + pauseDurationMs;
                pausedModels.set(geminiModel.NAME, unpauseTime);

                console.log(`Model ${geminiModel.NAME} paused for 30 minutes due to daily quota exceeded. Unpause at: ${new Date(unpauseTime).toLocaleTimeString()}`);

                // Try again with a different model
                return requestGeminiResponse(prompt, drawingData, textOnly);
            }

            // Handle per-minute/other quota exceeded
            const unpauseTime = now + retryDelayMs;
            pausedModels.set(geminiModel.NAME, unpauseTime);

            console.log(`Model ${geminiModel.NAME} paused due to quota exceeded. Unpause at: ${new Date(unpauseTime).toLocaleTimeString()}`);

            // Try again with a different model
            return requestGeminiResponse(prompt, drawingData, textOnly);
        }

        console.error(`Gemini API error: ${error.message}`);
        throw error; // Re-throw other errors for the caller to handle
    }
}

module.exports = {
    initializeGeminiService,
    requestGeminiResponse
};