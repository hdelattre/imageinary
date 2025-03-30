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

function getScaledCoordinates(e, canvas) {
    const rect = canvas.getBoundingClientRect();
    const scaleX = canvas.width / rect.width;
    const scaleY = canvas.height / rect.height;
    const clientX = e.type.startsWith('touch') ? e.touches[0].clientX : e.clientX;
    const clientY = e.type.startsWith('touch') ? e.touches[0].clientY : e.clientY;
    return {
        x: (clientX - rect.left) * scaleX,
        y: (clientY - rect.top) * scaleY
    };
}

// Debounce drawing updates to save data
function debounce(func, wait) {
    let timeout;
    function debounced(...args) {
        clearTimeout(timeout);
        timeout = setTimeout(() => {
            timeout = null; // Clear timeout after execution
            func.apply(this, args);
        }, wait);
    }
    // Add a flush method to execute the pending call immediately
    debounced.flush = function() {
        if (timeout) {
            clearTimeout(timeout);
            timeout = null;
            func.apply(this); // Call with the last arguments passed
        }
    };
    return debounced;
}

function restrictToDrawer(callback) {
    return function(e) {
        if (socket.id === document.getElementById('drawer')?.dataset?.id) {
            callback(e);
        }
    };
}

function getDrawingStyles() {
    const colorPicker = document.getElementById('colorPicker');
    const brushSize = document.getElementById('brushSize');
    return {
        strokeStyle: isEraser ? '#ffffff' : (colorPicker?.value || '#000000'),
        lineWidth: parseInt(brushSize?.value || 5, 10) // Default value if missing
    };
}

function startDrawPath(x, y) {
    drawing = true;
    ctx.beginPath();
    ctx.moveTo(x, y);
    lastX = x;
    lastY = y;
    undoStack.push(canvas.toDataURL());
}

function addToDrawPath(x, y) {
    if (!drawing) return;
    const { strokeStyle, lineWidth } = getDrawingStyles();
    ctx.strokeStyle = strokeStyle;
    ctx.lineWidth = lineWidth;

    // Draw line
    if (lastX && lastY) {
        ctx.beginPath();
        ctx.moveTo(lastX, lastY);
        ctx.lineTo(x, y);
        ctx.stroke();
    }

    lastX = x;
    lastY = y;
    sendDrawingUpdateDebounced();
}

function endDrawPath() {
    if (!drawing) return;
    drawing = false;
    lastX = null;
    lastY = null;
    sendDrawingUpdateFinal();
}

// Optimized drawing update function with debouncing
const sendDrawingUpdateDebounced = debounce(sendDrawingUpdate, 20);
const sendDrawingUpdateFinal = function() { sendDrawingUpdateDebounced.flush(); };

// 4. Improved touch event handling with multi-touch support
let activeTouchId = null;
let lastX, lastY;

// Mouse event listeners
canvas.addEventListener('mousedown', restrictToDrawer((e) => {
    const { x, y } = getScaledCoordinates(e, canvas);
    startDrawPath(x, y);
}));

canvas.addEventListener('mousemove', restrictToDrawer((e) => {
    const { x, y } = getScaledCoordinates(e, canvas);
    addToDrawPath(x, y);
}));

canvas.addEventListener('mouseup', restrictToDrawer(() => {
    endDrawPath();
}));

canvas.addEventListener('mouseleave', restrictToDrawer(() => {
    endDrawPath();
}));

// Touch event handlers for drawing
canvas.addEventListener('touchstart', handleTouchStart, { passive: false });
canvas.addEventListener('touchmove', handleTouchMove, { passive: false });
canvas.addEventListener('touchend', handleTouchEnd, { passive: false });

function handleTouchStart(e) {
    e.preventDefault(); // Prevent scrolling/zooming
    if (socket.id !== document.getElementById('drawer')?.dataset?.id) return;

    const touch = e.touches[0];
    activeTouchId = touch.identifier;

    const { x, y } = getScaledCoordinates({ ...e, touches: [touch] }, canvas);
    startDrawPath(x, y);
}

function handleTouchMove(e) {
    e.preventDefault();
    if (activeTouchId === null) return;

    // Find the active touch by identifier
    const touch = Array.from(e.touches).find(t => t.identifier === activeTouchId);
    if (!touch) return;

    const { x, y } = getScaledCoordinates({ ...e, touches: [touch] }, canvas);
    addToDrawPath(x, y);
}

// Track last tap for double-tap detection
let lastTap = 0;

function handleTouchEnd(e) {
    e.preventDefault();
    if (activeTouchId === null) return;

    // Check if this touch end event contains our active touch
    const touch = Array.from(e.changedTouches).find(t => t.identifier === activeTouchId);
    if (touch) {
        activeTouchId = null;

        endDrawPath();

        // Double-tap detection integrated with touch handling
        const now = new Date().getTime();
        const timeDiff = now - lastTap;
        if (timeDiff < 300 && timeDiff > 0) {
            // Double tap detected
            if (socket.id === document.getElementById('drawer')?.dataset?.id) {
                undo();
            }
        }
        lastTap = now;
    }
}
