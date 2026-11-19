// Disable right-click context menu
document.addEventListener("contextmenu", function(event) {
    event.preventDefault();  // Prevent the context menu from showing
});

// Disable F12 key (Developer Tools)
document.addEventListener("keydown", function(event) {
    // Block F12 (key code 123)
    if (event.keyCode == 123) {
        event.preventDefault();
    }
    // Block Ctrl + Shift + I (key code 73 for 'I')
    if (event.ctrlKey && event.shiftKey && event.keyCode == 73) {
        event.preventDefault();
    }
    // Block Ctrl + U (View Source)
    if (event.ctrlKey && event.keyCode == 85) {
        event.preventDefault();
    }
    // Block Ctrl + Shift + J (Console)
    if (event.ctrlKey && event.shiftKey && event.keyCode == 74) {  // key code 74 for 'J'
        event.preventDefault();
    }
});

// Optional: Prevent access to Developer Tools via DevTools detection
let devtoolsOpen = false;
setInterval(function() {
    if (devtoolsOpen) {
        alert("Developer Tools are open!");  // Optional alert
        devtoolsOpen = false;
    }
}, 1000);

// Detect when Developer Tools are opened or closed
window.addEventListener('devtoolschange', function() {
    devtoolsOpen = true;
});

