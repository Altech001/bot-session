// itxxwasi.js
const express = require('express');
const cors = require('cors');
const { makeWASocket, useMultiFileAuthState, Browsers, DisconnectReason } = require('maher-zubair-baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const axios = require('axios');
const FormData = require('form-data');

const app = express();
const port = process.env.PORT || 8000;

// Middleware
app.use(cors()); // Enable CORS for all routes
app.use(express.json());

const wasiQrRouter = require('./wasiqr.js');
app.use('/wasiqr', wasiQrRouter);

// --- File Upload Logic ---

// Set up temporary storage for uploads
const upload = multer({ dest: 'temp_uploads/' });

// Ensure temp directory exists
if (!fs.existsSync('temp_uploads')) {
    fs.mkdirSync('temp_uploads');
}

// Function to upload file to Catbox.moe
async function uploadToCatbox(filePath) {
    return new Promise(async (resolve, reject) => {
        if (!fs.existsSync(filePath)) {
            return reject(new Error("File not Found"));
        }
        try {
            const form = new FormData();
            form.append('reqtype', 'fileupload');
            form.append('fileToUpload', fs.createReadStream(filePath));
            
            const { data } = await axios.post('https://catbox.moe/user/api.php', form, {
                headers: {
                    ...form.getHeaders(),
                },
            });

            // The response from catbox.moe is the direct URL of the uploaded file.
            if (data.startsWith('http')) {
                resolve(data);
            } else {
                reject(new Error(data || "Failed to upload to Catbox"));
            }
        } catch (err) {
            // Check if the error response has more details
            const errorMessage = err.response ? JSON.stringify(err.response.data) : String(err);
            reject(new Error(errorMessage));
        }
    });
}


// POST endpoint for file uploads
app.post('/upload', upload.single('file'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded.' });
    }

    const filePath = req.file.path;

    try {
        const url = await uploadToCatbox(filePath);
        res.json({ url });
    } catch (error) {
        console.error("Upload Error:", error.message);
        res.status(500).json({ error: 'Failed to upload file. ' + error.message });
    } finally {
        // Clean up the temporary file
        fs.unlink(filePath, (err) => {
            if (err) {
                console.error("Failed to delete temp file:", err);
            }
        });
    }
});


// --- WhatsApp Pairing Code Logic ---

// Function to generate a random ID
function generateRandomId() {
    const timestamp = new Date().getTime().toString();
    const random = Math.random().toString(36).substring(2, 8);
    return `${timestamp}-${random}`;
}

// GET endpoint to generate pairing code
app.get('/code', async (req, res) => {
    const phoneNumber = req.query.number;
    if (!phoneNumber) {
        return res.status(400).json({ code: 'Phone number is required' });
    }

    const sessionId = generateRandomId();
    const sessionFile = `./temp/${sessionId}`;

    // Ensure temp directory exists
    if (!fs.existsSync('./temp')) {
        fs.mkdirSync('./temp');
    }

    try {
        const { state, saveCreds } = await useMultiFileAuthState(sessionFile);

        const socket = makeWASocket({
            logger: pino({ level: 'fatal' }), // Use 'info' for debugging
            printQRInTerminal: false,
            browser: Browsers.macOS('Desktop'),
            auth: state,
        });

        // Handle connection updates
        socket.ev.on('connection.update', (update) => {
            const { connection, lastDisconnect } = update;
            if (connection === 'close') {
                const shouldReconnect = (lastDisconnect.error)?.output?.statusCode !== DisconnectReason.loggedOut;
                if (!shouldReconnect) {
                    // Clean up temp session folder
                    fs.rm(sessionFile, { recursive: true, force: true }, (err) => {
                        if(err) console.error(`Failed to delete session file: ${sessionFile}`, err);
                    });
                }
            }
        });

        // Save credentials when they are updated
        socket.ev.on('creds.update', saveCreds);

        // Request pairing code after a short delay
        if (!socket.authState.creds.registered) {
            setTimeout(async () => {
                try {
                    const code = await socket.requestPairingCode(phoneNumber);
                    res.json({ code: code.replace(/([0-9]{3})([0-9]{3})([0-9]{3})/, '$1-$2-$3') });
                } catch (error) {
                    console.error('Failed to request pairing code:', error);
                    res.status(500).json({ code: 'Failed to generate pairing code' });
                }
            }, 3000); // 3-second delay to allow socket to initialize
        }

    } catch (error) {
        console.error('Error setting up WhatsApp socket:', error);
        res.status(500).json({ code: 'Internal Server Error' });
    }
});



// --- Health Check Endpoint & Keep-Alive for Render ---
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'OK' });
});

// Start the server
app.listen(port, '0.0.0.0', () => {
    console.log(`Server running at http://localhost:${port}`);
    
    // Keep-alive logic
    const selfPingUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${port}`;
    if (selfPingUrl) {
        setInterval(() => {
            axios.get(`${selfPingUrl}/health`)
                .then(response => console.log(`Keep-alive ping successful. Status: ${response.status}`))
                .catch(error => console.error(`Keep-alive ping failed: ${error.message}`));
        }, 14 * 60 * 1000); // 14 minutes
    }
});
