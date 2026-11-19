// This script runs in the renderer process. It must NOT use 'require()' or Node.js APIs.
// All session handling is done via the 'api' bridge in the main process.

const checkAndLoadSession = async () => {
    try {
        const result = await window.api.checkSession();
        
        if (!result.active || result.session.user_type !== 'shop_user') {
            // No session or wrong user type -> redirect to login
            console.log('No active session found, redirecting to login.');
            window.location.href = '../../index.html';
            return;
        }

        console.log('Logged in user:', result.session.username);
        // You can use result.session to populate the dashboard UI here
        // Example: document.getElementById('welcomeMessage').innerText = `Welcome, ${result.session.username}`;

    } catch (error) {
        console.error("IPC Session Check Error:", error);
        alert("A critical application error occurred. Check console."); // Using alert() temporarily for critical error
        // Fallback to login if session check fails
        window.location.href = '../../index.html'; 
    }
};

// Logout button
document.getElementById('logoutBtn').addEventListener('click', async () => {
    try {
        const result = await window.api.logout();
        if (result.success) {
            window.location.href = '../../index.html'; // Redirect to login
        } else {
            console.error("Logout failed:", result.error);
            // alert("Logout failed. Please restart the app.");
        }
    } catch (error) {
        console.error("IPC Logout Error:", error);
    }
});

// Run session check on page load
checkAndLoadSession();

document.getElementById('playGameButton').addEventListener('click', () => {
  // Just tell main process: "User wants to play"
  window.api.openGamePage();
});

