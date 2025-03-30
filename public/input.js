// Only prevent default on elements that shouldn't trigger actions
document.addEventListener('touchend', function(event) {
    const nonActionTags = ['DIV', 'SPAN', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'CANVAS'];

    // Don't prevent default on interactive elements (buttons, inputs, etc.)
    if (nonActionTags.includes(event.target.tagName) &&
        !event.target.classList.contains('copyable') &&
        !event.target.onclick) {
        event.preventDefault();
    }
}, { passive: false });

// Prevent scrolling when interacting with the canvas
document.addEventListener('touchmove', function(e) {
    if (e.target.tagName === 'CANVAS') {
        e.preventDefault();
    }
}, { passive: false });

canvas.addEventListener('mousedown', (e) => {
    if (socket.id === document.getElementById('drawer').dataset.id) {
        drawing = true;
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        ctx.beginPath();
        ctx.moveTo(x, y);
        undoStack.push(canvas.toDataURL());
    }
});

canvas.addEventListener('mousemove', (e) => {
    if (drawing) {
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (e.clientX - rect.left) * scaleX;
        const y = (e.clientY - rect.top) * scaleY;
        ctx.strokeStyle = isEraser ? '#ffffff' : document.getElementById('colorPicker').value;
        ctx.lineWidth = document.getElementById('brushSize').value;
        ctx.lineTo(x, y);
        ctx.stroke();

        // Throttle updates to prevent flooding the server
        drawingUpdateBuffer++;
        if (drawingUpdateBuffer >= 5) { // Send every 5 drawing movements
            drawingUpdateBuffer = 0;
            sendDrawingUpdate();
        }
    }
});

canvas.addEventListener('mouseup', () => {
    drawing = false;
    // Always send final state after finishing a stroke
    if (socket.id === document.getElementById('drawer').dataset.id) {
        sendDrawingUpdate();
    }
});

canvas.addEventListener('mouseleave', () => {
    drawing = false;
    // Always send final state after finishing a stroke
    if (socket.id === document.getElementById('drawer').dataset.id) {
        sendDrawingUpdate();
    }
});

// Touch event handlers for drawing
canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
canvas.addEventListener('touchend', handleTouchEnd, { passive: false });

function handleTouchStart(e) {
    e.preventDefault(); // Prevent scrolling/zooming
    if (socket.id === document.getElementById('drawer').dataset.id) {
        drawing = true;
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (touch.clientX - rect.left) * scaleX;
        const y = (touch.clientY - rect.top) * scaleY;
        ctx.beginPath();
        ctx.moveTo(x, y);
        undoStack.push(canvas.toDataURL());
    }
}

function handleTouchMove(e) {
    e.preventDefault();
    if (drawing) {
        const touch = e.touches[0];
        const rect = canvas.getBoundingClientRect();
        const scaleX = canvas.width / rect.width;
        const scaleY = canvas.height / rect.height;
        const x = (touch.clientX - rect.left) * scaleX;
        const y = (touch.clientY - rect.top) * scaleY;
        ctx.strokeStyle = isEraser ? '#ffffff' : document.getElementById('colorPicker').value;
        ctx.lineWidth = document.getElementById('brushSize').value;
        ctx.lineTo(x, y);
        ctx.stroke();
        drawingUpdateBuffer++;
        if (drawingUpdateBuffer >= 5) {
            drawingUpdateBuffer = 0;
            sendDrawingUpdate();
        }
    }
}

function handleTouchEnd(e) {
    e.preventDefault();
    drawing = false;
    if (socket.id === document.getElementById('drawer').dataset.id) {
        sendDrawingUpdate();
    }
}
