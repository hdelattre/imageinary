# Imageinary

An online Pictionary-style game with AI image generation. Players take turns drawing a given prompt, while others guess what's being drawn. After the drawing phase, an AI generates an image based on the drawing and guesses, which players then vote on.

## Features

- Create or join game rooms with unique codes
- Automatic handling of duplicate usernames by appending numbers
- Real-time drawing with color picker, eraser, and undo functionality
- Guessing system with real-time updates
- AI image generation based on drawings and guesses
- Voting system for generated images
- Scoring based on votes and correct guesses

## How to Play

1. **Create or Join a Room**: Enter your username and either create a new room or join an existing one with a room code.
2. **Drawing Phase**: The drawer has 40 seconds to draw the given prompt.
3. **Guessing Phase**: Other players guess what's being drawn (occurs simultaneously with the drawing phase).
4. **Image Generation**: After the drawing phase, an AI generates an image based on the drawing and guesses.
5. **Voting Phase**: All players vote "Like" or "Dislike" on the generated image.
6. **Scoring**:
   - If more than 50% of players vote "Like", the drawer gets a point.
   - Otherwise, players who correctly guessed the prompt get points.
7. **Next Round**: The role of drawer rotates to the next player.

## Setup Instructions

1. Install dependencies:
   ```bash
   npm install
   ```

2. Set up your Gemini API key in your environment variables:
   ```bash
   export GEMINI_API_KEY=your_api_key_here
   ```

3. Run the server:
   ```bash
   npm start
   ```

4. Open your browser and navigate to `http://localhost:3000`.

## Technical Details

- **Frontend**: HTML, CSS, JavaScript with Socket.IO client
- **Backend**: Node.js, Express, Socket.IO
- **Image Generation**: Google's Generative AI (Gemini)
- **Data Storage**: In-memory (game state is lost on server restart)
