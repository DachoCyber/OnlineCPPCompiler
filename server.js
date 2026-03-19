const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const fs = require('fs').promises;
const path = require('path');
const os = require('os');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const PORT = 3000;
const TEMP_DIR = path.join(__dirname, 'temp');
const MAX_CONCURRENT = 10; // FIX: basic rate limiting

fs.mkdir(TEMP_DIR, { recursive: true }).catch(console.error);

// Active Python processes keyed by sessionId
const processes = new Map();

// ─── Helper: safe JSON read ───────────────────────────────────────────────────
async function readResultFile(sessionId) {
    const resultFile = path.join(TEMP_DIR, `result_${sessionId}.json`);
    try {
        const data = await fs.readFile(resultFile, 'utf8');
        return JSON.parse(data);
    } catch {
        return null;
    }
}

// ─── Helper: wait until result file exists (up to maxMs) ─────────────────────
async function waitForResultFile(sessionId, maxMs = 8000) {
    const resultFile = path.join(TEMP_DIR, `result_${sessionId}.json`);
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
        try {
            const data = await fs.readFile(resultFile, 'utf8');
            const parsed = JSON.parse(data);
            // Only return once Python has written a valid success/fail result
            if (typeof parsed.success === 'boolean') return parsed;
        } catch {
            // not ready yet
        }
        await new Promise(r => setTimeout(r, 100));
    }
    return null;
}

// ─── /compile ────────────────────────────────────────────────────────────────
app.post('/compile', async (req, res) => {
    const { code, sessionId } = req.body;

    if (!sessionId || sessionId === 'null' || sessionId === 'undefined') {
        return res.status(400).json({ success: false, errors: 'Invalid sessionId' });
    }

    // FIX: basic concurrent process limit
    if (processes.size >= MAX_CONCURRENT) {
        return res.status(429).json({ success: false, errors: 'Server busy, try again shortly' });
    }

    console.log(`[${sessionId}] Compile request received`);

    const filename   = path.join(TEMP_DIR, `code_${sessionId}.cpp`);
    const resultFile = path.join(TEMP_DIR, `result_${sessionId}.json`);

    // FIX: delete any stale result file from a previous session with the same id
    await fs.unlink(resultFile).catch(() => {});

    try {
        await fs.writeFile(filename, code);
    } catch (err) {
        return res.status(500).json({ success: false, errors: 'Could not save source file: ' + err.message });
    }

    // Spawn Python compiler as a background process
    const pythonProcess = spawn('python3', ['compiler.py', filename, sessionId], {
        detached: false
    });

    processes.set(sessionId, pythonProcess);

    pythonProcess.stdout.on('data', d => console.log(`[${sessionId}] py-stdout: ${d.toString().trim()}`));
    pythonProcess.stderr.on('data', d => console.log(`[${sessionId}] py-stderr: ${d.toString().trim()}`));

    pythonProcess.on('close', async (code) => {
        console.log(`[${sessionId}] Python process exited with code ${code}`);
        processes.delete(sessionId);

        // Clean up source file; result file is cleaned by /stop or the periodic sweep
        await fs.unlink(filename).catch(() => {});
    });

    // FIX: don't wait for Python to finish — wait only until the result file is
    // written (compilation done, execution starting). This unblocks the frontend
    // quickly while the program continues running in the background.
    const result = await waitForResultFile(sessionId, 15000);

    if (!result) {
        // Compilation took too long or Python crashed before writing result
        pythonProcess.kill('SIGKILL');
        processes.delete(sessionId);
        return res.json({ success: false, errors: 'Compilation timed out or compiler crashed' });
    }

    console.log(`[${sessionId}] Sending initial result to frontend`);
    res.json(result);
});

// ─── /input ──────────────────────────────────────────────────────────────────
app.post('/input', async (req, res) => {
    const { input, sessionId } = req.body;

    if (!sessionId || sessionId === 'null') {
        return res.json({ success: false, error: 'Invalid session' });
    }

    const inputFile = path.join(TEMP_DIR, `input_${sessionId}.txt`);

    try {
        // FIX: write without trailing newline — Python backend adds '\n' when sending to stdin
        await fs.writeFile(inputFile, input, 'utf8');
        console.log(`[${sessionId}] Input saved: "${input}"`);
        res.json({ success: true });
    } catch (err) {
        console.error(`[${sessionId}] Error saving input:`, err);
        res.json({ success: false, error: err.message });
    }
});

// ─── /output-stream/:sessionId (SSE) ─────────────────────────────────────────
// FIX: use proper Server-Sent Events format so the frontend EventSource works correctly
app.get('/output-stream/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    const outputFile = path.join(TEMP_DIR, `output_${sessionId}.txt`);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    let lastSize = 0;
    let closed = false;

    const sendEvent = (text) => {
        if (closed) return;
        // SSE format: each message must be "data: <payload>\n\n"
        const lines = text.split('\n');
        for (const line of lines) {
            if (line !== '') {
                res.write(`data: ${line}\n`);
            }
        }
        res.write('\n'); // end of SSE event
    };

    // Send any content already in the output file
    try {
        const content = await fs.readFile(outputFile, 'utf8');
        if (content) {
            lastSize = Buffer.byteLength(content, 'utf8');
            sendEvent(content);
        }
    } catch {
        // file not yet created — that's fine
    }

    const interval = setInterval(async () => {
        if (closed) {
            clearInterval(interval);
            return;
        }

        try {
            const stats = await fs.stat(outputFile);
            if (stats.size > lastSize) {
                const fh = await fs.open(outputFile, 'r');
                const buf = Buffer.alloc(stats.size - lastSize);
                await fh.read(buf, 0, buf.length, lastSize);
                await fh.close();
                lastSize = stats.size;
                const text = buf.toString('utf8');
                if (text) sendEvent(text);
            }
        } catch {
            // output file may not exist yet
        }

        // Close stream once process is gone and no longer writing
        if (!processes.has(sessionId)) {
            const result = await readResultFile(sessionId);
            if (!result || !result.waitingForInput) {
                console.log(`[${sessionId}] Output stream: program finished, closing`);
                clearInterval(interval);
                if (!closed) { closed = true; res.end(); }
            }
        }
    }, 100);

    req.on('close', () => {
        console.log(`[${sessionId}] Output stream closed by client`);
        closed = true;
        clearInterval(interval);
    });
});

// ─── /program-status/:sessionId ──────────────────────────────────────────────
app.get('/program-status/:sessionId', async (req, res) => {
    const { sessionId } = req.params;

    const isRunning = processes.has(sessionId);
    const result = await readResultFile(sessionId);

    // FIX: finished = result file exists AND Python process has exited
    // (previously this would fire true before the program even started if a stale file existed)
    const finished = !isRunning && result !== null;

    res.json({
        running: isRunning,
        finished,
        waitingForInput: result?.waitingForInput || false,
        executionTime: result?.executionTime || null,
        memory: result?.memory || null,
        success: result?.success || false
    });
});

// ─── /stop ───────────────────────────────────────────────────────────────────
app.post('/stop', async (req, res) => {
    const { sessionId } = req.body;
    console.log(`[${sessionId}] Stop requested`);

    const proc = processes.get(sessionId);
    if (proc) {
        try {
            proc.kill('SIGKILL');
        } catch (e) {
            console.error(`[${sessionId}] Kill failed:`, e.message);
        }
        // FIX: always remove from map even if kill throws
        processes.delete(sessionId);
    }

    const files = [
        `result_${sessionId}.json`,
        `input_${sessionId}.txt`,
        `code_${sessionId}.cpp`,
        `output_${sessionId}.txt`
    ].map(f => path.join(TEMP_DIR, f));

    await Promise.all(files.map(f => fs.unlink(f).catch(() => {})));
    console.log(`[${sessionId}] Stopped and cleaned up`);
    res.json({ success: true });
});

// ─── Periodic cleanup of stale temp files (older than 1 hour) ────────────────
setInterval(async () => {
    try {
        const files = await fs.readdir(TEMP_DIR);
        const now = Date.now();
        for (const file of files) {
            const fp = path.join(TEMP_DIR, file);
            try {
                const { mtimeMs } = await fs.stat(fp);
                if (now - mtimeMs > 3_600_000) {
                    await fs.unlink(fp).catch(() => {});
                    console.log(`Cleaned up stale file: ${file}`);
                }
            } catch {
                // file may have been deleted already
            }
        }
    } catch (err) {
        console.error('Cleanup error:', err);
    }
}, 3_600_000);

// ─── Startup ──────────────────────────────────────────────────────────────────
function getLocalIPs() {
    const ips = [];
    for (const [name, ifaces] of Object.entries(os.networkInterfaces())) {
        for (const iface of ifaces) {
            if (iface.family === 'IPv4' && !iface.internal) {
                ips.push({ name, address: iface.address });
            }
        }
    }
    return ips;
}

app.listen(PORT, '0.0.0.0', () => {
    console.log(`\nServer running on port ${PORT}`);
    getLocalIPs().forEach(({ name, address }) => {
        console.log(`  http://${address}:${PORT}  (${name})`);
    });
    console.log(`  http://localhost:${PORT}`);
});