// zorkPromptBuilder.js - Handles crafting prompts for the Social Zork game

/**
 * Builds a prompt for generating an image of a scene description
 * @param {string} description - The scene description
 * @param {string} style - The image style to use
 * @returns {string} - The complete image generation prompt
 */
function buildImagePrompt(description, style = "fantasy illustration") {
    return `Create a detailed ${style} of the following text adventure scene:

${description}

The illustration should be vivid, detailed, and evocative of classic text adventure games like Zork.
Use appropriate lighting, perspective, and composition to create an immersive scene.
The style should be cohesive and suitable for a fantasy adventure game.`;
}

/**
 * Builds a prompt for generating ONLY the text result of a player's action
 * @param {string} worldDescription - The current world state description
 * @param {string[]} inventory - Array of items in the player's inventory
 * @param {string} action - The player's action
 * @param {string} playerName - The player's name
 * @returns {string} - The text-only action result prompt
 */
function buildActionResultTextPrompt(worldDescription, inventory, action, playerName, history = []) {
    const inventoryText = inventory.length > 0 ? inventory.join(', ') : "empty";

    // Format chat history if available
    let historyText = "";
    if (history && history.length > 0) {
        historyText = `\nRecent conversation and world updates:\n${history.map(entry => {
            if (entry.type === 'world') {
                return `[WORLD UPDATE] ${entry.content}`;
            } else {
                return `${entry.username || 'Unknown'}: ${entry.content}`;
            }
        }).join('\n')}\n`;
    }

    return `You are the game master of a text adventure game like Zork. The current scene is:

${worldDescription}

The player's inventory contains: ${inventoryText}
${historyText}
Player ${playerName} performs this action: "${action}"

Write a short, detailed description of the outcome of this action (2-4 sentences). Be creative, responsive to the player's input, and maintain the atmosphere of a classic text adventure. Do not use bullet points or lists, just flowing text.

Example format:
You examine the mailbox carefully. As you open it, you find a weathered letter inside addressed to "Occupant." The mailbox creaks as you close it again.`;
}

/**
 * Builds a prompt for generating an image based on a text description
 * @param {string} actionDescription - The text description of the action result
 * @param {string} style - The image style to use
 * @returns {string} - The image generation prompt
 */
function buildActionImageFromTextPrompt(actionDescription, style = "fantasy illustration") {
    return `Create a detailed ${style} depicting this text adventure scene:

${actionDescription}

The illustration should be vivid, detailed, and evocative of classic text adventure games like Zork.
Use appropriate lighting, perspective, and composition to create an immersive scene.
The style should be cohesive and suitable for a fantasy adventure game.`;
}

/**
 * Builds a prompt for generating the canonical (final) text result of the winning action
 * This includes inventory changes in structured format but no image request
 * @param {string} worldDescription - The current world state description
 * @param {string[]} inventory - Array of items in the player's inventory
 * @param {string} action - The winning action
 * @param {string} playerName - The player's name who submitted the action
 * @returns {string} - The text-only canonical result prompt
 */
function buildCanonicalResultTextPrompt(worldDescription, inventory, action, playerName, history = []) {
    const inventoryText = inventory.length > 0 ? inventory.join(', ') : "empty";

    // Format chat history if available
    let historyText = "";
    if (history && history.length > 0) {
        historyText = `\nRecent conversation and world updates:\n${history.map(entry => {
            if (entry.type === 'world') {
                return `[WORLD UPDATE] ${entry.content}`;
            } else {
                return `${entry.username || 'Unknown'}: ${entry.content}`;
            }
        }).join('\n')}\n`;
    }

    return `You are the game master of a collaborative text adventure game like Zork. The current scene is:

${worldDescription}

The player's inventory contains: ${inventoryText}
${historyText}
The winning action to perform is: "${action}" (from player ${playerName})

Write a rich, detailed description (2-4 sentences) of the new world state. Be responsive to the player's action, maintaining the atmosphere of a classic text adventure.

After writing the description, provide a structured inventory update in JSON format as follows:
{"items_added": ["item1", "item2"], "items_removed": ["item3"]}

Use empty arrays for no changes. Only include items actually added or removed.

Example response:
You carefully open the mailbox. Inside, you find a weathered leaflet that appears to be some kind of advertisement. You take the leaflet and close the creaky mailbox door.

{"items_added": ["leaflet"], "items_removed": []}`;
}

/**
 * Builds a prompt for generating the result of a player's action (legacy method)
 * @param {string} worldDescription - The current world state description
 * @param {string[]} inventory - Array of items in the player's inventory
 * @param {string} action - The player's action
 * @param {string} playerName - The player's name
 * @param {string} style - The image style to use
 * @returns {string} - The complete action result prompt
 */
function buildActionResultPrompt(worldDescription, inventory, action, playerName, style = "fantasy illustration", history = []) {
    const inventoryText = inventory.length > 0 ? inventory.join(', ') : "empty";

    // Format chat history if available
    let historyText = "";
    if (history && history.length > 0) {
        historyText = `\nRecent conversation and world updates:\n${history.map(entry => {
            if (entry.type === 'world') {
                return `[WORLD UPDATE] ${entry.content}`;
            } else {
                return `${entry.username || 'Unknown'}: ${entry.content}`;
            }
        }).join('\n')}\n`;
    }

    return `You are the game master of a text adventure game like Zork. The current scene is:

${worldDescription}

The player's inventory contains: ${inventoryText}
${historyText}
Player ${playerName} performs this action: "${action}"

You MUST generate an image of this action being taken using this style: ${style}

Also include a short, detailed description of the outcome of this action (2-4 sentences). Be creative, responsive to the player's input, and maintain the atmosphere of a classic text adventure. Do not use bullet points or lists, just flowing text.

Example format:
You examine the mailbox carefully. As you open it, you find a weathered letter inside addressed to "Occupant." The mailbox creaks as you close it again.`;
}

/**
 * Builds a prompt for generating the canonical (final) result of the winning action
 * This includes inventory changes in structured format
 * @param {string} worldDescription - The current world state description
 * @param {string[]} inventory - Array of items in the player's inventory
 * @param {string} action - The winning action
 * @param {string} playerName - The player's name who submitted the action
 * @param {string} style - The image style to use
 * @returns {string} - The complete canonical result prompt
 */
function buildCanonicalResultPrompt(worldDescription, inventory, action, playerName, style = "fantasy illustration", history = []) {
    const inventoryText = inventory.length > 0 ? inventory.join(', ') : "empty";

    // Format chat history if available
    let historyText = "";
    if (history && history.length > 0) {
        historyText = `\nRecent conversation and world updates:\n${history.map(entry => {
            if (entry.type === 'world') {
                return `[WORLD UPDATE] ${entry.content}`;
            } else {
                return `${entry.username || 'Unknown'}: ${entry.content}`;
            }
        }).join('\n')}\n`;
    }

    return `You are the game master of a collaborative text adventure game like Zork. The current scene is:

${worldDescription}

The player's inventory contains: ${inventoryText}
${historyText}
The winning action to perform is: "${action}" (from player ${playerName})

You MUST generate an image of the new state of the game after the action is taken in this style: ${style}

Also include a rich, detailed description (2-4 sentences) of the new world state. Be responsive to the player's action, maintaining the atmosphere of a classic text adventure.

After writing the description, provide a structured inventory update in JSON format as follows:
{"items_added": ["item1", "item2"], "items_removed": ["item3"]}

Use empty arrays for no changes. Only include items actually added or removed.

Example response:
You carefully open the mailbox. Inside, you find a weathered leaflet that appears to be some kind of advertisement. You take the leaflet and close the creaky mailbox door.

{"items_added": ["leaflet"], "items_removed": []}`;
}

module.exports = {
    buildImagePrompt,
    buildActionResultPrompt,
    buildActionResultTextPrompt,
    buildActionImageFromTextPrompt,
    buildCanonicalResultPrompt,
    buildCanonicalResultTextPrompt
};