<?php
define('ADMIN_PASSWORD', '@7Pde^F875Ep$HHRZ5$#');
define('ADMIN_MAP_KEY',  'G&^k&re&7ZWSxCbY5j&q');
define('NODE_SERVER',    'http://127.0.0.1:3000'); // server-side only, never sent to browser

session_start();

// ── Data proxy endpoint ───────────────────────────────────────────
// Browser fetches ?data=1, PHP fetches from Node and returns JSON
if (isset($_GET['data'])) {
    if (!isset($_SESSION['admin'])) {
        http_response_code(401);
        echo json_encode(['error' => 'Unauthorized']);
        exit;
    }

    $url = NODE_SERVER . '/admin/live-map';

    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_TIMEOUT        => 5,
        CURLOPT_HTTPHEADER     => [
            'x-admin-key: ' . ADMIN_MAP_KEY
        ]
    ]);

    $body = curl_exec($ch);
    $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $err  = curl_error($ch);
    curl_close($ch);

    header('Content-Type: application/json');

    if ($err) {
        http_response_code(502);
        echo json_encode(['error' => 'Could not reach game server: ' . $err]);
        exit;
    }

    if ($code !== 200) {
        http_response_code($code);
        echo json_encode(['error' => "Game server returned HTTP $code"]);
        exit;
    }

    echo $body;
    exit;
}
// ── End proxy ─────────────────────────────────────────────────────

if ($_SERVER['REQUEST_METHOD'] === 'POST' && isset($_POST['password'])) {
    if ($_POST['password'] === ADMIN_PASSWORD) {
        $_SESSION['admin'] = true;
    } else {
        $error = "Wrong password.";
    }
}

if (!isset($_SESSION['admin'])) {
?>
<!DOCTYPE html>
<html>
<head>
    <title>Admin Login</title>
    <style>
        body { background: #0a0a0a; color: #00ff88; font-family: monospace;
               display: flex; align-items: center; justify-content: center; height: 100vh; margin: 0; }
        input, button { background: #1a1a1a; border: 1px solid #00ff88; color: #00ff88;
                        padding: 10px 16px; font-family: monospace; font-size: 14px; }
        button { cursor: pointer; margin-left: 8px; }
        button:hover { background: #00ff88; color: #0a0a0a; }
        .error { color: #ff4444; margin-top: 10px; }
    </style>
</head>
<body>
    <form method="POST">
        <input type="password" name="password" placeholder="Admin password" autofocus>
        <button type="submit">Enter</button>
        <?php if (isset($error)) echo "<div class='error'>$error</div>"; ?>
    </form>
</body>
</html>
<?php
    exit;
}
?>
<!DOCTYPE html>
<html>
<head>
    <title>Pocket Mortys</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; }

        body {
            background: #0a0a0a;
            color: #00ff88;
            font-family: monospace;
            display: flex;
            flex-direction: column;
            height: 100vh;
            overflow: hidden;
        }

        #header {
            display: flex;
            align-items: center;
            gap: 20px;
            padding: 10px 16px;
            background: #111;
            border-bottom: 1px solid #1a3a2a;
            flex-shrink: 0;
        }

        #header h1 { font-size: 14px; color: #00ff88; }

        #stats { font-size: 12px; color: #888; }
        #stats span { color: #00ff88; }

        #room-filter {
            background: #1a1a1a;
            border: 1px solid #00ff88;
            color: #00ff88;
            padding: 4px 8px;
            font-family: monospace;
            font-size: 12px;
        }

        #status {
            margin-left: auto;
            font-size: 11px;
            color: #888;
        }
        #status.live { color: #00ff88; }
        #status.error { color: #ff4444; }

        #main {
            display: flex;
            flex: 1;
            overflow: hidden;
        }

        #canvas-wrap {
            flex: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            background: #0a0a0a;
            padding: 16px;
        }

        canvas {
            border: 1px solid #1a3a2a;
            background: #0d1a12;
            image-rendering: pixelated;
        }

        #sidebar {
            width: 700px;
            border-left: 1px solid #1a3a2a;
            overflow-y: auto;
            padding: 10px;
            flex-shrink: 0;
        }

        #sidebar h2 { font-size: 13px; color: #888; margin-bottom: 8px; text-transform: uppercase; }

        .player-entry {
            background: #111;
            border: 1px solid #1a3a2a;
            border-radius: 2px;
            padding: 8px 10px;
            margin-bottom: 8px;
            font-size: 14px;
            cursor: pointer;
        }
        .player-entry:hover { border-color: #00ff88; }
        .player-entry .pid  { color: #888; font-size: 11px; }
        .player-entry .pos  { color: #00ff88; }
        .player-entry .room { color: #4a8a6a; font-size: 12px; }

        .bot-entry {
            background: #111;
            border: 1px solid #2a1a3a;
            border-radius: 2px;
            padding: 8px 10px;
            margin-bottom: 6px;
            font-size: 14px;
        }
        .bot-entry .bname { color: #aa88ff; }
        .bot-entry .bstate { font-size: 12px; color: #888; }

        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-track { background: #111; }
        ::-webkit-scrollbar-thumb { background: #1a3a2a; }
    </style>
</head>
<body>

<div id="header">
    <h1>🗺 LIVE PLAYER MAP</h1>
    <div id="stats">
        Players: <span id="stat-players">0</span> &nbsp;|&nbsp;
        <!-- Bots: <span id="stat-bots">0</span> &nbsp;|&nbsp; -->
        Rooms: <span id="stat-rooms">0</span>
    </div>
    <select id="room-filter">
        <option value="">All Rooms</option>
    </select>
    <div id="status">Connecting...</div>
</div>

<div id="main">
    <div id="canvas-wrap">
        <canvas id="map" width="1500" height="1000"></canvas>
    </div>
    <div id="sidebar">
        <h2>Players</h2>
        <div id="player-list"></div>
        <!--<h2 style="margin-top:12px">Bots</h2>
         <div id="bot-list"></div> -->
    </div>
</div>

<script>
const API_URL = '<?= basename(__FILE__) ?>?data=1';
const POLL_MS   = 500;

// Map coordinate space — packet coords are uint8 (0-255), game world uses ~0-90
const WORLD_W   = 100;
const WORLD_H   = 100;

const canvas    = document.getElementById('map');
const ctx       = canvas.getContext('2d');
const statusEl  = document.getElementById('status');
const roomSel   = document.getElementById('room-filter');

// Assign stable colours per player
const playerColors = {};
const palette = ['#00ff88','#00ccff','#ffcc00','#ff6688','#cc88ff','#ff9900','#00ffcc'];
let colourIdx = 0;
function getColor(id) {
    if (!playerColors[id]) {
        playerColors[id] = palette[colourIdx % palette.length];
        colourIdx++;
    }
    return playerColors[id];
}

// World coords -> canvas pixels
function worldToCanvas(x, y) {
    return {
        cx: Math.round((x / WORLD_W) * canvas.width),
        cy: Math.round((y / WORLD_H) * canvas.height)
    };
}

let lastData    = null;
let highlighted = null;

function drawMap(data) {
    const filterRoom = roomSel.value;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Grid
    ctx.strokeStyle = '#0f2a1a';
    ctx.lineWidth   = 1;
    const gridStep  = canvas.width / 10;
    for (let i = 0; i <= 10; i++) {
        ctx.beginPath();
        ctx.moveTo(i * gridStep, 0);
        ctx.lineTo(i * gridStep, canvas.height);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(0, i * gridStep);
        ctx.lineTo(canvas.width, i * gridStep);
        ctx.stroke();
    }
    /*
    // Bots
    for (const bot of data.bots) {
        if (filterRoom && bot.roomId !== filterRoom) continue;
        if (bot.x === null) continue;
        const { cx, cy } = worldToCanvas(bot.x, bot.y);

        ctx.beginPath();
        ctx.arc(cx, cy, 5, 0, Math.PI * 2);
        ctx.fillStyle   = bot.state === 'WORLD' ? '#aa88ff' : '#553388';
        ctx.fill();
        ctx.strokeStyle = '#7755bb';
        ctx.lineWidth   = 1;
        ctx.stroke();

        ctx.fillStyle  = '#aa88ff';
        ctx.font       = '9px monospace';
        ctx.fillText(bot.username || bot.bot_id.slice(0, 8), cx + 7, cy + 3);
    }
    */
    // Players
    for (const p of data.players) {
        if (filterRoom && p.roomId !== filterRoom) continue;

        const { cx, cy } = worldToCanvas(p.x, p.y);
        const color      = getColor(p.player_id);
        const isHl       = highlighted === p.player_id;
        const radius     = isHl ? 8 : 5;

        // Stale check — dim if not updated in 5 seconds
        const age     = Date.now() - p.lastUpdated;
        const opacity = age > 5000 ? 0.3 : 1.0;

        ctx.globalAlpha = opacity;

        // Direction indicator
        const dirs = [ [0,-1],[1,0],[0,1],[-1,0] ]; // up right down left
        const dir  = dirs[p.direction % 4];

        ctx.beginPath();
        ctx.moveTo(
            cx + dir[0] * (radius + 4),
            cy + dir[1] * (radius + 4)
        );
        ctx.lineTo(cx, cy);
        ctx.strokeStyle = color;
        ctx.lineWidth   = 1.5;
        ctx.stroke();

        // Dot
        ctx.beginPath();
        ctx.arc(cx, cy, radius, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();

        if (isHl) {
            ctx.strokeStyle = '#ffffff';
            ctx.lineWidth   = 2;
            ctx.stroke();
        }

// Label
const username = p.username || p.player_id.slice(0, 8);
const labelX = cx + radius + 6;
const labelY = cy + 4;

ctx.font = isHl
    ? 'bold 12px monospace'
    : 'bold 11px monospace';

// Measure username so we can draw a background behind it
const usernameWidth = ctx.measureText(username).width;

// Dark label background
ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
ctx.fillRect(
    labelX - 3,
    labelY - 11,
    usernameWidth + 6,
    15
);

// Black outline around text
ctx.lineWidth = 3;
ctx.strokeStyle = '#000000';
ctx.strokeText(
    username,
    labelX,
    labelY
);

// Actual username
ctx.fillStyle = isHl ? '#ffffff' : color;
ctx.fillText(
    username,
    labelX,
    labelY
);

// Coordinates underneath
ctx.font = '9px monospace';
ctx.fillStyle = '#cccccc';

ctx.lineWidth = 2;
ctx.strokeStyle = '#000000';
ctx.strokeText(
    `[${p.x},${p.y}]`,
    labelX,
    labelY + 11
);

ctx.fillText(
    `[${p.x},${p.y}]`,
    labelX,
    labelY + 11
);

        ctx.globalAlpha = 1.0;
    }
}

function updateSidebar(data) {
    const filterRoom = roomSel.value;

    // Stats
    document.getElementById('stat-players').textContent = data.totalPlayers;
    //document.getElementById('stat-bots').textContent    = data.bots.length;
    document.getElementById('stat-rooms').textContent   = data.rooms.length;

    // Room dropdown
    const currentRooms = new Set([...roomSel.options].map(o => o.value));
    for (const r of data.rooms) {
        if (!currentRooms.has(r.roomId)) {
            const opt      = document.createElement('option');
            opt.value      = r.roomId;
            opt.textContent = `Room ${r.roomId} (${r.playerCount})`;
            roomSel.appendChild(opt);
        }
    }

    // Player list
    const pl = document.getElementById('player-list');
    pl.innerHTML = '';

    for (const p of data.players) {
        if (filterRoom && p.roomId !== filterRoom) continue;

        const color = getColor(p.player_id);
        const div = document.createElement('div');

        div.className = 'player-entry';

        div.innerHTML = `
            <span style="color:${color}">●</span>
            <span class="username">${p.username || 'Unknown'}</span>
            <span class="pos">[${p.x}, ${p.y}]</span>
            <span class="room">Room ${p.roomId}</span><br>
            <span class="pid">${p.player_id}</span>
        `;

        div.onclick = () => {
            highlighted = highlighted === p.player_id ? null : p.player_id;
        };

        pl.appendChild(div);
    }
    /*
    // Bot list
    const bl = document.getElementById('bot-list');
    bl.innerHTML = '';
    for (const b of data.bots) {
        if (filterRoom && b.roomId !== filterRoom) continue;
        const div = document.createElement('div');
        div.className = 'bot-entry';
        div.innerHTML = `
            <span class="bname">${b.username || b.bot_id.slice(0, 10)}</span>
            <span class="bstate"> — ${b.state} @ [${b.x ?? '?'},${b.y ?? '?'}]</span>
        `;
        bl.appendChild(div);
    }
	*/
}

async function poll() {
    try {
        const res = await fetch(API_URL);

        if (!res.ok) throw new Error(`HTTP ${res.status}`);

        const data = await res.json();
        lastData   = data;

        drawMap(data);
        updateSidebar(data);

        statusEl.textContent = `Live — ${new Date().toLocaleTimeString()}`;
        statusEl.className   = 'live';

    } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.className   = 'error';
        // Keep last frame visible on error
        if (lastData) drawMap(lastData);
    }
}

roomSel.onchange = () => { if (lastData) { drawMap(lastData); updateSidebar(lastData); } };

// Kick off
poll();
setInterval(poll, POLL_MS);
</script>
</body>
</html>