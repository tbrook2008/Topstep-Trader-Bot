const { exec } = require('child_process');

/**
 * Sends an SMS/iMessage to the user using macOS Messages app.
 * @param {string} message 
 */
function sendSMS(message) {
    const phoneNumber = '+17817333348';
    // Escape double quotes and backslashes in the message
    const safeMessage = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const command = `osascript -e 'tell application "Messages" to send "${safeMessage}" to buddy "${phoneNumber}"'`;
    
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`[Notifier] Failed to send SMS: ${error.message}`);
            return;
        }
        if (stderr) {
            console.error(`[Notifier] SMS stderr: ${stderr}`);
            return;
        }
        console.log(`[Notifier] Successfully sent SMS notification: ${message}`);
    });
}

module.exports = {
    sendSMS
};
