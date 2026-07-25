const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const dgram = require('dgram');
const udpServer = dgram.createSocket('udp4');
const udpSessionRegistry = new Map();
const livePlayerPositions = new Map();
const udpClientEndpoints = new Map();
const app = express();
// Middleware to parse JSON body
app.use(express.json());

// ---------------- 1. DATABASE CONFIGURATION ----------------
const pool = mysql.createPool({
    host: 'localhost',
    user: 'db_username',
    password: 'db_password',
    database: 'db_name',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});


// ---------------- HELPERS ----------------
async function requireUserBySession(sessionId) {
    const [rows] = await pool.execute("SELECT * FROM users WHERE session_id = ? LIMIT 1", [sessionId]);
    if (!rows.length) {
        const error = new Error("Not authenticated");
        error.statusCode = 401;
        throw error;
    }
    return rows[0];
}
const activeSseConnections = new Map();

// Clean stale database sessions (Players who haven't pinged or seen in 45 seconds)
setInterval(async () => {
    try {
        // 1. Fetch all players who are inside a valid room but haven't updated 'last_seen' in 45 seconds
        const [stalePlayers] = await pool.execute(`
            SELECT player_id, room_id 
            FROM users 
            WHERE room_id IS NOT NULL 
              AND room_id != '0' 
              AND room_id != '' 
              AND last_seen < NOW() - INTERVAL 45 SECOND
        `);

        for (const player of stalePlayers) {
            const player_id = String(player.player_id);
            const room_id = String(player.room_id);

            console.log(`[Timeout!] Player ${player_id} has timed out from room ${room_id}.`);

            // 2. Remove the player's room mapping and state fields in the database
            await pool.execute(`
                UPDATE users 
                SET room_id = '', 
                    state = NULL 
                WHERE player_id = ?
            `, [player_id]);

            // 3. Broadcast the 'room:user-removed' event via your SSE event queue pipeline
            // This alerts every other client in that map to instantly destroy the player's avatar
            await publishEvent(room_id,"room:user-removed",{ player_id: player_id },player_id).catch(err => console.error(`[Timeout Worker] SSE Publish failed:`, err.message));
            //await publishEvent(room_id,"room:user-removed",player_id).catch(err => console.error(`[Timeout Worker] SSE Publish failed:`, err.message));
			
            // 4. Optional: Clean up their streaming references if they are still tracked in memory
            if (typeof activeSseConnections !== 'undefined' && activeSseConnections.has(player_id)) {
                activeSseConnections.delete(player_id);
            }
        }
    } catch (err) {
        console.error("[Timeout Worker Error]:", err.message);
    }
}, 15000); // Runs every 15 seconds to sweep the database efficiently

// ---------------- 2. UTILITIES & AUTHENTICATION HELPERS ----------------

// Helper: Base64URL Encode
function base64urlEncode(strOrBuffer) {
    const buffer = Buffer.isBuffer(strOrBuffer) ? strOrBuffer : Buffer.from(strOrBuffer);
    return buffer.toString('base64')
        .replace(/=/g, '')
        .replace(/\+/g, '-')
        .replace(/\//g, '_');
}

// Helper: Base64URL Decode
function base64urlDecode(data) {
    let base64 = data.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4) {
        base64 += '=';
    }
    return Buffer.from(base64, 'base64').toString('utf8');
}

// Extract JWT payloads without signature checking for validation validation matching
function decodeJwtPayload(jwt) {
    const parts = jwt.split('.');
    if (parts.length < 2) return null;
    try {
        return JSON.parse(base64urlDecode(parts[1]));
    } catch (e) {
        return null;
    }
}

/** Matches normalize_tags from auth.php */
function normalizeTags(tags) {
    if (Array.isArray(tags)) return tags;
    if (typeof tags === 'string') {
        try {
            const decoded = JSON.parse(tags);
            return Array.isArray(decoded) ? decoded : [];
        } catch (e) {
            return [];
        }
    }
    return [];
}

function payloadInvolvesPlayer(payloadJson, playerId) {
    try {
        const d = JSON.parse(payloadJson);
        if (!d || typeof d !== 'object') return false;

        const keys = [
            "player_id", "attacker_player_id", "defender_player_id",
            "challenger_player_id", "challenged_player_id", "owner_player_id"
        ];

        for (const key of keys) {
            if (d[key] && String(d[key]) === playerId) return true;
        }

        if (Array.isArray(d.turn_datas)) {
            for (const t of d.turn_datas) {
                if (!t || typeof t !== 'object') continue;
                if (t.attacker_player_id && String(t.attacker_player_id) === playerId) return true;
                if (t.defender_player_id && String(t.defender_player_id) === playerId) return true;
            }
        }
    } catch (e) {
        return false;
    }
    return false;
}

// ---------------- 3. CORE DATABASE SSE CURSORS ----------------

async function cursorSet(playerId, lastId) {
    //await pool.execute("UPDATE users SET last_event_id = ?, last_seen = NOW() WHERE player_id = ?", [lastId, playerId]);
}

async function roomMaxEventId(roomId) {
    const [rows] = await pool.execute("SELECT COALESCE(MAX(id), 0) AS max_id FROM event_queue WHERE room_id = ?", [roomId]);
    return rows.length ? parseInt(rows[0].max_id, 10) : 0;
}

async function getActiveDeckMorties(playerId) {
    const [decks] = await pool.execute("SELECT owned_morty_ids FROM decks WHERE player_id = ? LIMIT 1", [playerId]);
    if (!decks.length || !decks[0].owned_morty_ids) return [];

    let rawIds = decks[0].owned_morty_ids;
    let mortyIds = [];

    try {
        mortyIds = typeof rawIds === 'string' ? JSON.parse(rawIds) : rawIds;
    } catch (e) {
        mortyIds = String(rawIds).split(',').map(id => id.trim()).filter(Boolean);
    }

    if (!Array.isArray(mortyIds) || !mortyIds.length) return [];

    const placeholders = mortyIds.map(() => '?').join(',');
    const [morties] = await pool.execute(
        `SELECT owned_morty_id, morty_id, hp, variant, is_locked, is_trading_locked, fight_pit_id 
         FROM owned_morties WHERE owned_morty_id IN (${placeholders})`, 
        mortyIds
    );

    const normalized = morties.map(m => ({
        ...m,
        hp: parseInt(m.hp, 10),
        is_locked: [1, '1', true, 'true'].includes(m.is_locked),
        is_trading_locked: [1, '1', true, 'true'].includes(m.is_trading_locked),
        fight_pit_id: (!m.fight_pit_id || String(m.fight_pit_id).toLowerCase() === 'null') ? null : m.fight_pit_id
    }));

    const ordered = [];
    for (const id of mortyIds) {
        const found = normalized.find(m => String(m.owned_morty_id) === String(id));
        if (found) ordered.push(found);
    }

    return ordered;
}

// ---------------- 4. CORE COMPREHENSIVE EVENT PUBLISHER (From events.php) ----------------

async function publishEvent(roomId, event, payload, playerId = null) {
    let pickup_id = null;
    let placement = null;
    let wild_morty_id = null;
    let morty_id = null;
    let state = null;
    let division = null;
    let variant = null;
    let shiny_if_potion = 0;
    let pick_up_contents = null;
    const zone_id = "[1,1]";
    let bot_id = null;
    let username = null;
    let player_avatar_id = null;
    let owned_morties = null;
    let battle_start = null;
    let get_current_raid = null;
    let battle_turn_result = null;
    let battle_move_timer_started = null;
    let emote = null;
    let only_show_to_player_id = null;

    // Globally capture placement arrays across all incoming types
    if (payload && payload.placement && Array.isArray(payload.placement)) {
        placement = `${payload.placement[0]},${payload.placement[1]}`;
    }

    if (event === "room:pickup-added") {
        pickup_id = payload.pickup_id || null;
        pick_up_contents = payload.contents ? JSON.stringify(payload.contents) : JSON.stringify([]);
    }
    
    if (event === "room:pickup-removed") {
        pickup_id = payload.pickup_id || null;
    }

    if (event === "room:wild-morty-added") {
        wild_morty_id = payload.wild_morty_id || null;
        morty_id = payload.morty_id || null;
        state = payload.state || "WORLD";
        division = payload.division || null;
        variant = payload.variant || null;
        shiny_if_potion = payload.shiny_if_potion ? 1 : 0;
    }

    if (event === "room:bot-added") {
        bot_id = payload.bot_id || null;
        username = payload.username || null;
        player_avatar_id = payload.player_avatar_id || null;
        state = payload.state || "WORLD";
        owned_morties = payload.owned_morties ? JSON.stringify(payload.owned_morties) : JSON.stringify([]);
    }

    if (event === "shard:raid-boss-state-changed") {
        get_current_raid = JSON.stringify(payload);
    }

    if (event === "room:user-added") {
        roomId = payload.room_id || null;
        playerId = payload.player_id || null;
        state = payload.state || null;
        username = payload.username || null;
        player_avatar_id = payload.player_avatar_id || null;
    }

    if (event === "room:user-removed") {
        playerId = payload.player_id || null;
    }

    if (event === "room:wild-morty-state-changed") {
        wild_morty_id = payload.wild_morty_id || null;
        state = payload.state || null;
    }
	
    if (event === "room:bot-state-changed") {
        bot_id = payload.bot__id || null;
        state = payload.state || null;
    }

    if (event === "room:user-state-changed") {
        playerId = payload.player_id || null;
        state = payload.state || null;
    }

    if (event === "battle:start") {
        battle_start = JSON.stringify(payload);
        only_show_to_player_id = playerId;
    }

    if (event === "battle:turn-result") {
        battle_turn_result = JSON.stringify(payload);
    }

    if (event === "battle:move-timer-started") {
        battle_move_timer_started = JSON.stringify(payload);
    }

    if (event === "emote:room") {
        playerId = payload.player_id || null;
        emote = payload.emote || null;
    }

    const query = `
        INSERT INTO event_queue (
            room_id, event_name, player_id, emote, current_raid, battle_start, 
            battle_turn_result, battle_move_timer_started, bot_id, username, 
            player_avatar_id, wild_morty_id, morty_id, placement, state, 
            division, zone_id, variant, shiny_if_potion, pickup_id, 
            pick_up_contents, owned_morties, only_show_to_player_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

    await pool.execute(query, [
        roomId, event, playerId, emote, get_current_raid, battle_start,
        battle_turn_result, battle_move_timer_started, bot_id, username,
        player_avatar_id, wild_morty_id, morty_id, placement, state,
        division, zone_id, variant, shiny_if_potion, pickup_id,
        pick_up_contents, owned_morties, only_show_to_player_id
    ]);
}

// -------------------- 5. GAME COMPLIANCE CONFIG ROUTES --------------------

app.post('/trading/config', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const configData = {
        config_id: req.body.config_id || "DEFAULT",
        premium_trade_cost: req.body.premium_trade_cost !== undefined ? parseInt(req.body.premium_trade_cost, 10) : 3,
        max_trades: req.body.max_trades !== undefined ? parseInt(req.body.max_trades, 10) : 3,
        trade_cooldown_minutes: req.body.trade_cooldown_minutes !== undefined ? parseInt(req.body.trade_cooldown_minutes, 10) : 1440
    };

    const responseString = JSON.stringify(configData);
    const etagHash = crypto.createHash('md5').update(responseString).digest('hex');
    res.setHeader('ETag', `W/"${etagHash}"`);

    return res.send(responseString);
});


app.post('/decks/slots/config', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const slotConfigData = {
        config_data: {
            config_id: "MP",
            starting_deck_slots: 3,
            max_deck_slots: 9,
            cost_additional_slot: 10
        }
    };

    const responseString = JSON.stringify(slotConfigData);
    const etagHash = crypto.createHash('md5').update(responseString).digest('hex');
    res.setHeader('ETag', `W/"${etagHash}"`);

    return res.send(responseString);
});


app.post('/morty/slots/config', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const mortyConfigData = {
        config_data: {
            config_id: "MP",
            starting_morty_slots: 350,
            max_morty_slots: 750,
            increment_slot_count: 100,
            cost_additional_slot: 5
        }
    };

    const responseString = JSON.stringify(mortyConfigData);
    const etagHash = crypto.createHash('md5').update(responseString).digest('hex');
    res.setHeader('ETag', `W/"${etagHash}"`);

    return res.send(responseString);
});

// -------------------- 6. COMPLAINT PRODUCTION AUTHENTICATION ROUTE --------------------

app.post('/user/login', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const { secret, consent_identifier } = req.body;

    try {
        const [rows] = await pool.execute('SELECT * FROM users WHERE secret = ?', [secret]);
        const user = rows[0];

        if (!user) {
            return res.status(400).json({
                error: { code: "SECRET_INVALID" }
            });
        }

        const player_id = user.player_id;
        const username = user.username;
        const level = parseInt(user.level, 10);
        const tags = user.tags;
        
        const session_id = crypto.randomUUID(); 
        const ping_url = 'https://game.conspiracyrick.com/session/ping-dynamic';
        
        const iat = Math.floor(Date.now() / 1000); 
        const exp = iat + 60; 

        await pool.execute('UPDATE users SET session_id = ?, last_seen = NOW() WHERE player_id = ?', [session_id, player_id]);

        const randomBytes = crypto.randomBytes(32);
        const noshare = base64urlEncode(randomBytes);

        const header = { alg: "HS256", typ: "JWT" };
        const payload = {
            player_id,
            username,
            level,
            tags,
            session_id,
            ping_url,
            iat,
            exp
        };

        const base64Header = base64urlEncode(JSON.stringify(header));
        const base64Payload = base64urlEncode(JSON.stringify(payload));
        
        const signatureInput = `${base64Header}.${base64Payload}`;
        const signature = crypto.createHmac('sha256', noshare)
                                .update(signatureInput)
                                .digest(); 
        
        const base64Signature = base64urlEncode(signature);
        const jwt = `${base64Header}.${base64Payload}.${base64Signature}`;

        const responseData = {
            session_url: `https://game.conspiracyrick.com/sse/?token=${jwt}`,
            session_url_ttl: "60"
        };

        const responseString = JSON.stringify(responseData);
        const etagHash = crypto.createHash('md5').update(responseString).digest('hex');
        res.setHeader('ETag', `W/"${etagHash}"`);

        return res.send(responseString);

    } catch (error) {
        console.error(error);
        return res.status(500).json({ error: { code: "SERVER_ERROR" } });
    }
});

// -------------------- DYNAMIC POSITION/SESSION PING --------------------
app.post('/session/ping-dynamic', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : "";

    if (session_id === "") {
        return res.status(400).json({ success: false, error: "Missing session_id" });
    }

    try {
        // 1. Identify the user hitting the ping route
        const [rows] = await pool.execute(
            "SELECT player_id FROM users WHERE session_id = ? LIMIT 1",
            [session_id]
        );
        const user = rows[0];

        if (user) {
            const player_id = String(user.player_id);

            // 2. Keep database timestamp fresh
            await pool.execute(
                "UPDATE users SET last_seen = NOW() WHERE player_id = ? LIMIT 1",
                [player_id]
            );

            // 3. Extract the active stream and push the session:keep-alive event directly down the pipe
            const targetSseSend = activeSseConnections.get(player_id);
            if (targetSseSend) {
                // event: session:keep-alive
                // data: 0
                targetSseSend("session:keep-alive", "0");
            }
        }

        // 4. Return standard HTTP response confirmation back to client
        return res.json({ success: true });

    } catch (err) {
        console.error("[Ping Dynamic Error]:", err.message);
        return res.status(500).json({ success: false, error: "SERVER_ERROR" });
    }
});

// -------------------- CORE SSE PIPELINE ENGINE --------------------
app.get('/sse', async (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');

    const sseSend = (event, dataJson, id = null) => {
        //if (id !== null) res.write(`id: ${id}\n`);
        res.write(`event: ${event}\n`);
        res.write(`data: ${dataJson}\n\n`);
    };

    const token = req.query.token || null;
    const profile = token ? decodeJwtPayload(token) : null;
    const session_id = String(profile?.session_id || "");

    if (session_id === "") {
        res.status(400);
        sseSend("error", JSON.stringify({ error: "Missing session_id" }));
        return res.end();
    }

    let user;
    try {
        user = await requireUserBySession(session_id);
    } catch (err) {
        res.status(err.statusCode || 500);
        sseSend("error", JSON.stringify({ error: err.message }));
        return res.end();
    }

    const player_id = String(user.player_id);
    const tags = normalizeTags(user.tags);
    const ping_url = String(profile?.ping_url || "https://game.conspiracyrick.com/session/ping-dynamic");

    // --- 1. REGISTER CONNECTION FOR DYNAMIC PING ROUTING ---
    activeSseConnections.set(player_id, sseSend);

    const sessionPayload = {
        player_id,
        session_id,
        username: String(user.username),
        level: parseInt(user.level, 10),
        tags: tags,
        ping_interval: 30,
        ping_url,
        keep_alive: 30,
        server_instance: "/ip-10-100-0-46/0/1142",
        worlds: [
            { world_id: "1", player_level: { min: 1, max: 50 } },
            { world_id: "2", player_level: { min: 5, max: 50 } },
            { world_id: "3", player_level: { min: 15, max: 50 } },
            { world_id: "4", player_level: { min: 30, max: 50 } },
            { world_id: "5", player_level: { min: 5, max: 50 } },
            { world_id: "6", player_level: { min: 10, max: 50 } },
            { world_id: "7", player_level: { min: 15, max: 50 } }
        ],
        owned_morty_limit: 750
    };

    sseSend("session:start", JSON.stringify(sessionPayload));

    let room_id = "";
    let connectionActive = true;

    // --- 2. CLEAN UP REGISTRY MAP ON CLOSE ---
    req.on('close', () => { 
        connectionActive = false; 
        activeSseConnections.delete(player_id);
    });

    // Room entry wait-stage loop
    while (connectionActive) {
        const [roomCheck] = await pool.execute("SELECT room_id FROM users WHERE player_id = ? LIMIT 1", [player_id]);
        room_id = roomCheck.length ? String(roomCheck[0].room_id) : "";

        if (room_id !== "" && room_id !== "0") break;

        // Note: Automatic fallback pings are omitted here because /session/ping-dynamic 
        // drives the keep-alive timeline for the client directly.
        await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (!connectionActive || room_id === "" || room_id === "0") return res.end();

    let clientLastEventId = null;
    if (req.headers['last-event-id'] && /^\d+$/.test(req.headers['last-event-id'])) {
        clientLastEventId = parseInt(req.headers['last-event-id'], 10);
    } else if (req.query.since && /^\d+$/.test(String(req.query.since))) {
        clientLastEventId = parseInt(String(req.query.since), 10);
    }

    const isFreshConnect = (clientLastEventId === null);
    let last_id = 0;

    if (isFreshConnect) {
        const [pickups] = await pool.execute(
            `SELECT id, pickup_id, placement, pick_up_contents FROM event_queue 
             WHERE room_id = ? AND event_name = 'room:pickup-added' AND pickup_id_collected_by_player_id IS NULL ORDER BY id ASC`, [room_id]
        );
        for (const p of pickups) {
            const coords = String(p.placement || "0,0").split(",");
            sseSend("room:pickup-added", JSON.stringify({
                pickup_id: p.pickup_id,
                placement: [parseInt(coords[0] || 0, 10), parseInt(coords[1] || 0, 10)],
                contents: JSON.parse(p.pick_up_contents || "[]")
            }), p.id);
        }

        const [wilds] = await pool.execute(
            `SELECT id, wild_morty_id, morty_id, placement, state, division, variant, shiny_if_potion FROM event_queue 
             WHERE room_id = ? AND event_name = 'room:wild-morty-added' ORDER BY id ASC`, [room_id]
        );
        for (const w of wilds) {
            const coords = String(w.placement || "0,0").split(",");
            sseSend("room:wild-morty-added", JSON.stringify({
                morty_id: w.morty_id,
                placement: [parseInt(coords[0] || 0, 10), parseInt(coords[1] || 0, 10)],
                state: w.state || "WORLD",
                division: parseInt(w.division || 1, 10),
                variant: w.variant || "Normal",
                shiny_if_potion: Boolean(w.shiny_if_potion),
                _created: new Date().toISOString(),
                _updated: new Date().toISOString(),
                wild_morty_id: w.wild_morty_id
            }), w.id);
        }

        const [bots] = await pool.execute(
            `SELECT id, bot_id, username, player_avatar_id, placement, state, owned_morties FROM event_queue 
             WHERE room_id = ? AND event_name = 'room:bot-added' ORDER BY id ASC`, [room_id]
        );
        for (const b of bots) {
            const coords = String(b.placement || "0,0").split(",");
            sseSend("room:bot-added", JSON.stringify({
                username: b.username,
                player_avatar_id: b.player_avatar_id,
                state: b.state || "WORLD",
                level: 1,
                owned_morties: JSON.parse(b.owned_morties || "[]"),
                streak: 0,
                bot_id: b.bot_id,
                placement: [parseInt(coords[0] || 0, 10), parseInt(coords[1] || 0, 10)]
            }), b.id);
        }

        last_id = await roomMaxEventId(room_id);
        //await cursorSet(player_id, last_id);
    } else {
        last_id = clientLastEventId;
        //await cursorSet(player_id, last_id);
    }

    const privateEvents = ["battle:start", "battle:move-timer-started", "battle:turn-result"];

    // Core Event Streaming Loop
    while (connectionActive) {
        //await pool.execute("UPDATE users SET last_seen = NOW() WHERE player_id = ?", [player_id]);

        const [events] = await pool.execute(
            `SELECT id, room_id, event_name, player_id, emote, current_raid, battle_start, battle_turn_result, 
                    battle_move_timer_started, bot_id, username, player_avatar_id, wild_morty_id, morty_id, 
                    placement, state, division, zone_id, variant, shiny_if_potion, pickup_id, pick_up_contents, 
                    owned_morties, only_show_to_player_id 
             FROM event_queue WHERE room_id = ? AND id > ? ORDER BY id ASC LIMIT 200`,
            [room_id, last_id]
        );

        for (const row of events) {
            const eventName = String(row.event_name);
            const eid = parseInt(row.id, 10);
            const targetPid = String(row.player_id || "");
            let payload = null;

            if (privateEvents.includes(eventName)) {
                if (targetPid !== "" && targetPid !== player_id) {
                    last_id = eid;
                    continue;
                }
                const fallBackPayload = row.battle_start || row.battle_turn_result || row.battle_move_timer_started || "{}";
                if (targetPid === "" && !payloadInvolvesPlayer(fallBackPayload, player_id)) {
                    last_id = eid;
                    continue;
                }
            }

            const coords = String(row.placement || "0,0").split(",");
            const placementArr = [parseInt(coords[0] || 0, 10), parseInt(coords[1] || 0, 10)];

            switch (eventName) {
                case "room:pickup-added": {
                    payload = JSON.stringify({
                        pickup_id: row.pickup_id,
                        placement: placementArr,
                        contents: JSON.parse(row.pick_up_contents || "[]")
                    });
                    break;
                }
                case "room:wild-morty-added": {
                    payload = JSON.stringify({
                        morty_id: row.morty_id,
                        placement: placementArr,
                        state: row.state || "WORLD",
                        division: parseInt(row.division || 1, 10),
                        variant: row.variant || "Normal",
                        shiny_if_potion: Boolean(row.shiny_if_potion),
                        _created: new Date().toISOString(),
                        _updated: new Date().toISOString(),
                        wild_morty_id: row.wild_morty_id
                    });
                    break;
                }
                case "room:bot-added": {
                    payload = JSON.stringify({
                        username: row.username,
                        player_avatar_id: row.player_avatar_id,
                        state: row.state || "WORLD",
                        level: 1,
                        owned_morties: JSON.parse(row.owned_morties || "[]"),
                        streak: 0,
                        bot_id: row.bot_id,
                        placement: placementArr
                    });
                    break;
                }
                case "shard:raid-boss-state-changed": {
                    payload = String(row.current_raid || "");
                    break;
                }
                case "room:bot-state-changed": {
                    payload = JSON.stringify({ bot_id: row.bot_id, state: row.state });
                    break;
                }
                case "room:wild-morty-state-changed": {
                    payload = JSON.stringify({ wild_morty_id: row.wild_morty_id, state: row.state });
                    break;
                }
                case "room:user-state-changed": {
                    payload = JSON.stringify({ 
                        player_id: String(row.player_id), 
                        state: String(row.state || "WORLD")
                    });
                    break;
                }
                case "battle:start": {
                    payload = String(row.battle_start || "");
                    break;
                }
                case "battle:turn-result": {
                    payload = String(row.battle_turn_result || "");
                    break;
                }
                case "battle:move-timer-started": {
                    payload = String(row.battle_move_timer_started || "");
                    break;
                }
                case "room:pickup-removed": {
                    payload = JSON.stringify({ pickup_id: row.pickup_id });
                    break;
                }
                case "emote:room": {
                    payload = JSON.stringify({ player_id: row.player_id, emote: row.emote });
                    break;
                }
                case "room:user-added": {
                    const [uRows] = await pool.execute("SELECT * FROM users WHERE player_id = ?", [row.player_id]);
                
                    const activeDeck = await getActiveDeckMorties(row.player_id);
                    payload = JSON.stringify({
                        player_id: row.player_id,
                        username: String(row.username || ""),
                        player_avatar_id: String(row.player_avatar_id || ""),
                        level: row.level,
                        owned_morties: activeDeck,
                        state: row.state || "WORLD",
                        placement: [30, 35] 
                    });
                    break;
                }
                case "room:user-removed": {
                    payload = JSON.stringify({ player_id: row.player_id });
                    break;
                }
				case "room:user-modified": {
                    const [uRows] = await pool.execute("SELECT * FROM users WHERE player_id = ?", [row.player_id]);
                
                    const activeDeck = await getActiveDeckMorties(row.player_id);
                    payload = JSON.stringify({
					    player_id: row.player_id,
					    username: row.username,
					    player_avatar_id: row.player_avatar_id || "AvatarRickDefault",
					    level: row.level,
					    owned_morties: activeDeck,
					    state: row.state || "WORLD"
                    });
                    break;
                }
                default:
                    payload = "{}";
            }

            sseSend(eventName, payload, eid);
            last_id = eid;
        }

        //await cursorSet(player_id, last_id);
        
        await new Promise(resolve => setTimeout(resolve, 100)); // 10 ticks per second
    }

    res.end();
});

// -------------------- 8. PLAYER DETAILS & INVENTORY --------------------

app.post('/session/player-details', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const { session_id } = req.body;
    if (!session_id) return res.status(401).json({ error: { code: "NOT_AUTHENTICATED" } });

    try {
        const user = await requireUserBySession(session_id);
        const player_id = user.player_id;

        const [
            [mortyRows],
            [deckRows],
            [itemRows],
            [avatarRows],
            [dexRows]
        ] = await Promise.all([
            pool.execute(`
                SELECT m.*, a.attack_id, a.position, a.pp, a.pp_stat 
                FROM owned_morties m 
                LEFT JOIN owned_attacks a ON m.owned_morty_id = a.owned_morty_id 
                WHERE m.player_id = ? ORDER BY m.owned_morty_id ASC, a.position ASC`, [player_id]),
            pool.execute(`SELECT deck_id, owned_morty_ids FROM decks WHERE player_id = ?`, [player_id]),
            pool.execute(`SELECT item_id, quantity FROM owned_items WHERE player_id = ?`, [player_id]),
            pool.execute(`SELECT player_avatar_id FROM owned_avatars WHERE player_id = ? LIMIT 1`, [player_id]),
            pool.execute(`SELECT morty_id, caught FROM mortydex WHERE player_id = ?`, [player_id])
        ]);

        const mortyMap = new Map();
        for (const row of mortyRows) {
            if (!mortyMap.has(row.owned_morty_id)) {
                mortyMap.set(row.owned_morty_id, {
                    owned_morty_id: String(row.owned_morty_id),
                    morty_id: String(row.morty_id),
                    level: parseInt(row.level, 10),
                    xp: parseInt(row.xp, 10),
                    hp: parseInt(row.hp, 10),
                    hp_stat: parseInt(row.hp_stat, 10),
                    attack_stat: parseInt(row.attack_stat, 10),
                    defence_stat: parseInt(row.defence_stat, 10),
                    variant: row.variant || 'Normal',
                    speed_stat: parseInt(row.speed_stat, 10),
                    is_locked: [1, '1', true, 'true'].includes(row.is_locked),
                    is_trading_locked: [1, '1', true, 'true'].includes(row.is_trading_locked),
                    fight_pit_id: (!row.fight_pit_id || row.fight_pit_id === 'null') ? null : row.fight_pit_id,
                    evolution_points: parseInt(row.evolution_points, 10),
                    owned_attacks: [],
                    xp_lower: parseInt(row.xp_lower || 0, 10),
                    xp_upper: parseInt(row.xp_upper || 0, 10)
                });
            }
            if (row.attack_id) {
                mortyMap.get(row.owned_morty_id).owned_attacks.push({
                    attack_id: String(row.attack_id),
                    position: parseInt(row.position, 10),
                    pp: parseInt(row.pp, 10),
                    pp_stat: parseInt(row.pp_stat, 10)
                });
            }
        }

        const activeDeckRow = deckRows.find(d => d.deck_id === user.active_deck_id);
        const deckIds = activeDeckRow ? JSON.parse(activeDeckRow.owned_morty_ids || "[]") : [];
        
        const ownedMorties = [];
        const processedIds = new Set();
        
        for (const id of deckIds) {
            if (mortyMap.has(id)) {
                ownedMorties.push(mortyMap.get(id));
                processedIds.add(id);
            }
        }
        for (const [id, morty] of mortyMap) {
            if (!processedIds.has(id)) ownedMorties.push(morty);
        }

        const decks = deckRows.map(d => ({
            deck_id: parseInt(d.deck_id, 10),
            owned_morty_ids: JSON.parse(d.owned_morty_ids || "[]")
        }));

        let avatars = [];
        try {
            const rawAvatars = JSON.parse(avatarRows[0]?.player_avatar_id || "[]");
            avatars = rawAvatars.map(a => ({ player_avatar_id: String(a) }));
        } catch(e) {}

        return res.json({
            player_id: String(user.player_id),
            username: user.username,
            player_avatar_id: user.player_avatar_id || 'AvatarRickDefault',
            level: parseInt(user.level, 10),
            xp: parseInt(user.xp, 10),
            streak: parseInt(user.streak, 10),
            coins: parseInt(user.coins, 10),
            coupons: parseInt(user.coupons, 10),
            permits: parseInt(user.permits, 10),
            challenge_reward: false,
            owned_morties: ownedMorties,
            active_deck_id: parseInt(user.active_deck_id, 10),
            decks_owned: parseInt(user.decks_owned, 10),
            decks: decks,
            owned_items: itemRows,
            owned_avatars: avatars,
            mortydex: dexRows.map(r => ({ morty_id: String(r.morty_id), caught: Boolean(r.caught) })),
            tags: [],
            play_shiny_potion: null,
            xp_lower: parseInt(user.xp_lower, 10),
            xp_upper: parseInt(user.xp_upper, 10)
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
});

// -------------------- 9. AVATAR MIGRATION --------------------

app.post('/session/player-avatar/migrate', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');

    return res.json({ success: true });
});

// -------------------- 10. FRIEND LIST MANAGEMENT --------------------

app.post('/session/friend/list', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const session_id = req.body.session_id || null;

    if (!session_id) {
        return res.status(401).send("Not authenticated");
    }

    try {
        const user = await requireUserBySession(session_id);
        const player_id = user.player_id;

        const [requestsSent] = await pool.execute(`
            SELECT p.username, p.player_avatar_id, p.level, p.player_id AS player_id, r.created AS _created
            FROM friend_list r JOIN users p ON p.player_id = r.player_id_b
            WHERE r.player_id_a = ? AND r.pending = 'true' ORDER BY r.created DESC
        `, [player_id]);

        const [requestsReceived] = await pool.execute(`
            SELECT p.username, p.player_avatar_id, p.level, p.player_id AS player_id, r.created AS _created
            FROM friend_list r JOIN users p ON p.player_id = r.player_id_a
            WHERE r.player_id_b = ? AND r.pending = 'true' ORDER BY r.created DESC
        `, [player_id]);

        const [friends] = await pool.execute(`
            SELECT p.username, p.player_avatar_id, p.level, p.player_id, COALESCE(p.wins, 0) AS wins, COALESCE(p.losses, 0) AS losses,
                CASE WHEN p.last_seen IS NOT NULL AND p.last_seen >= (NOW() - INTERVAL 1 MINUTE) THEN 'true' ELSE 'false' END AS online,
                p.donation_request AS donation_request
            FROM friend_list r JOIN users p ON p.player_id = CASE WHEN r.player_id_a = ? THEN r.player_id_b WHEN r.player_id_b = ? THEN r.player_id_a END
            WHERE ? IN (r.player_id_a, r.player_id_b) AND r.pending != 'true' ORDER BY p.username ASC
        `, [player_id, player_id, player_id]);

        const formatPlayerNode = (node) => ({
            ...node,
            level: parseInt(node.level || 1, 10),
            wins: node.wins !== undefined ? parseInt(node.wins, 10) : undefined,
            losses: node.losses !== undefined ? parseInt(node.losses, 10) : undefined
        });

        const result = {
            requests_sent: requestsSent.map(formatPlayerNode),
            requests_received: requestsReceived.map(formatPlayerNode),
            friends: friends.map(formatPlayerNode),
            poll_period: 5,
            donation_request: { morty_id: null, next_countdown: 0, donation: null },
            limit_friends: 30
        };

        return res.json(result);

    } catch (error) {
        console.error(error);
        return res.status(error.statusCode || 500).json({
            error: error.message,
            file: "server.js",
            line: error.stack ? error.stack.split('\n')[1].trim() : "unknown"
        });
    }
});

// Utility helper to mirror your PHP pm_error function
function pmError(res, status, code) {
    return res.status(status).json({
        error: {
            code: code
        }
    });
}

// POST endpoint for sending friend requests
app.post('/session/friend/request', async (req, res) => {
    try {
        const { session_id, player_id: target_player_id } = req.body;

        // Validation checks
        if (!session_id) {
            return pmError(res, 401, "NOT_AUTHENTICATED");
        }
        if (!target_player_id) {
            return pmError(res, 400, "MISSING_PLAYER_ID");
        }

        // 1) Find the sender by session_id
        const [senderRows] = await pool.query(
            "SELECT player_id, wins FROM users WHERE session_id = ? LIMIT 1", 
            [session_id]
        );
        const sender = senderRows[0];

        if (!sender) {
            return pmError(res, 401, "NOT_AUTHENTICATED");
        }

        const sender_player_id = sender.player_id;
        const wins_sender = parseInt(sender.wins, 10);

        // 2) Block self friend request
        if (sender_player_id === target_player_id) {
            return pmError(res, 400, "FRIEND_SELF");
        }

        // 3) Make sure target exists
        const [targetRows] = await pool.query(
            "SELECT player_id, wins FROM users WHERE player_id = ? LIMIT 1", 
            [target_player_id]
        );
        const target = targetRows[0];

        if (!target) {
            return pmError(res, 404, "PLAYER_NOT_FOUND");
        }

        const wins_target = parseInt(target.wins, 10);

        // UTC timestamp formatted to ISO string (e.g. 2026-07-23T04:43:24.000Z)
        const date = new Date().toISOString();

        // 4) Prevent duplicates in BOTH directions
        const [existsRows] = await pool.query(
            `SELECT 1 FROM friend_list 
             WHERE (player_id_a = ? AND player_id_b = ?) 
                OR (player_id_a = ? AND player_id_b = ?) 
             LIMIT 1`,
            [sender_player_id, target_player_id, target_player_id, sender_player_id]
        );

        if (existsRows.length > 0) {
            return pmError(res, 400, "FRIEND_DUPLICATE");
        }

        // 5) Insert a pending request (Sender = A, Target = B)
        await pool.query(
            `INSERT INTO friend_list (player_id_a, player_id_b, pending, direction, created, modified) 
             VALUES (?, ?, ?, ?, ?, ?)`,
            [sender_player_id, target_player_id, 'true', 'false', date, date]
        );

        // Construct JSON response payload
        const responseData = {
            player_id_a: sender_player_id,
            player_id_b: target_player_id,
            wins_a: wins_sender,
            wins_b: wins_target,
            pending: true,
            direction: false,
            _created: date,
            _modified: date
        };

        // Calculate MD5 ETag matching your PHP md5(json_encode) logic
        const jsonString = JSON.stringify(responseData);
        const etag = `W/"${crypto.createHash('md5').update(jsonString).digest('hex')}"`;

        // Set ETag and return response
        res.setHeader('ETag', etag);
        return res.type('json').send(jsonString);

    } catch (err) {
        console.error('Server error on friend request:', err);
        return res.status(500).json({ error: { code: "SERVER_ERROR" } });
    }
});

// POST endpoint for user search (e.g. searching by username)
app.post('/session/friend/search', async (req, res) => {
    try {
        const { session_id, query } = req.body;

        // PHP's empty($session_id) check
        if (!session_id) {
            return res.status(401).send("Not authenticated");
        }

        // 1) Authenticate requesting user by session_id
        const [userRows] = await pool.query(
            "SELECT * FROM users WHERE session_id = ? LIMIT 1", 
            [session_id]
        );
        const user = userRows[0];

        if (!user) {
            return res.status(401).send("Not authenticated");
        }

        // 2) Search for target user by username
        const [searchRows] = await pool.query(
            "SELECT * FROM users WHERE username = ? LIMIT 1", 
            [query]
        );
        const searchUser = searchRows[0];

        // If target user is found, format payload and send response
        if (searchUser) {
            const responseData = {
                player_id: searchUser.player_id,
                username: searchUser.username,
                player_avatar_id: searchUser.player_avatar_id,
                level: parseInt(searchUser.level, 10)
            };

            const jsonString = JSON.stringify(responseData);

            // Compute MD5 ETag matching 'W/"' . md5($response) . '"'
            const etag = `W/"${crypto.createHash('md5').update(jsonString).digest('hex')}"`;

            res.setHeader('ETag', etag);
            return res.type('json').send(jsonString);
        }

        // If no user matches the query, end response smoothly
        return res.status(404).json({ error: "User not found" });

    } catch (err) {
        console.error("Error performing user search:", err);
        return res.status(500).send("Internal Server Error");
    }
});

// POST endpoint for accepting or declining friend requests
app.post('/session/friend/response', async (req, res) => {
    try {
        const data = req.body;

        // Ensure payload is an object
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return res.status(400).json({ error: "Invalid JSON body" });
        }

        const sessionId = data.session_id || "";
        const senderPlayerId = data.player_id || "";
        const approve = data.approve;

        // Input validation: ensure required fields exist and approve is boolean
        if (!sessionId || !senderPlayerId || typeof approve !== 'boolean') {
            return res.status(400).json({
                error: "Missing/invalid fields",
                required: { session_id: "string", player_id: "string", approve: "boolean" }
            });
        }

        // 1) Resolve the current user's player_id from session_id
        const [userRows] = await pool.query(
            "SELECT player_id FROM users WHERE session_id = ? LIMIT 1",
            [sessionId]
        );
        const row = userRows[0];

        if (!row || !row.player_id) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const myPlayerId = row.player_id;

        // Prevent self-request edge case
        if (myPlayerId === senderPlayerId) {
            return res.status(400).json({ 
                error: "player_id cannot be the same as the authenticated user" 
            });
        }

        // 2) Find the pending friend request row (either orientation)
        const [reqRows] = await pool.query(
            `SELECT player_id_a, player_id_b, pending, direction
             FROM friend_list
             WHERE pending = 'true'
               AND (
                    (player_id_a = ? AND player_id_b = ?)
                 OR (player_id_a = ? AND player_id_b = ?)
               )
             ORDER BY created DESC
             LIMIT 1`,
            [senderPlayerId, myPlayerId, myPlayerId, senderPlayerId]
        );
        const reqRow = reqRows[0];

        if (!reqRow) {
            return res.status(400).json({ error: "No pending friend request found" });
        }

        // Set response header to prevent caching matching PHP's Cache-Control: no-store
        res.setHeader('Cache-Control', 'no-store');

        // 3) Approve or reject
        if (approve === true) {
            // ISO UTC format string for modified column
            const now = new Date().toISOString();

            await pool.query(
                `UPDATE friend_list
                 SET pending = 'false',
                     modified = ?
                 WHERE pending = 'true'
                   AND (
                        (player_id_a = ? AND player_id_b = ?)
                     OR (player_id_a = ? AND player_id_b = ?)
                   )
                 LIMIT 1`,
                [now, senderPlayerId, myPlayerId, myPlayerId, senderPlayerId]
            );

            // Echo literal '1' string
            return res.status(200).send('1');
        }

        // Reject = delete the pending request row
        await pool.query(
            `DELETE FROM friend_list
             WHERE pending = 'true'
               AND (
                    (player_id_a = ? AND player_id_b = ?)
                 OR (player_id_a = ? AND player_id_b = ?)
               )
             LIMIT 1`,
            [senderPlayerId, myPlayerId, myPlayerId, senderPlayerId]
        );

        // Echo literal '1' string
        return res.status(200).send('1');

    } catch (err) {
        console.error("Error processing friend response:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});


app.post('/session/emote/room', async (req, res) => {
    // Set headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const body = req.body || {};
        const session_id = String(body.session_id || '');
        const emote = String(body.emote || '');

        if (!session_id || !emote) {
            return res.status(400).json({ error: "Missing session_id or emote" });
        }

        // Keep emote small + safe (matches your examples)
        if (emote.length > 24 || !/^[a-zA-Z0-9]+$/.test(emote)) {
            return res.status(400).json({ error: "Invalid emote" });
        }

        // Find the user and their room
        const [rows] = await pool.execute(`
            SELECT player_id, room_id
            FROM users
            WHERE session_id = ?
            LIMIT 1
        `, [session_id]);

        const u = rows[0];

        if (!u) {
            return res.status(401).json({ error: "Not authenticated" });
        }

        const player_id = String(u.player_id);
        const room_id = String(u.room_id || '');

        if (!room_id || room_id === "0") {
            return res.status(409).json({ error: "Player is not in a room" });
        }

        // Mark active
        await pool.execute(`
            UPDATE users SET last_seen = NOW() WHERE session_id = ? LIMIT 1
        `, [session_id]);

        // Publish the exact event + payload shape your client expects
        await publishEvent(room_id, "emote:room", {
            player_id: player_id,
            emote: emote
        });

        return res.status(200).json({ success: true });

    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Server error", detail: e.message });
    }
});


app.post('/session/gacha-info', (req, res) => {
    // Custom response headers matching your PHP setup
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const gachaData = {
        gacha_promo: {
            gacha_promo_id: "GachaMPPromo20230207_2025",
            period: [1769438400, 1870042600],
            image_url: "https://assets.bps-pmnet.com/Media/Promos/GachaBackgrounds/Cust1605801458922.png",
            drop_chance: "0.06",
            gacha_promo_content: [
                {
                    morty_id: "MortyBirdingMan",
                    speed: [46, 59],
                    attack: [50, 63],
                    defence: [60, 73],
                    hp: [86, 101],
                    level: [32, 34],
                    owned_attacks: [
                        {
                            attack_id: "AttackSparkle",
                            pp_stat: 10,
                            effects: [{ stat: "Accuracy", type: "Stat", power: 3, to_self: true, accuracy: 0.95 }],
                            position: 0,
                            pp: 10
                        },
                        {
                            attack_id: "AttackArtsyFartsy",
                            pp_stat: 5,
                            effects: [
                                { type: "Hit", power: 85, accuracy: 0.95, continue_on_miss: false },
                                { type: "Poison", accuracy: 1 }
                            ],
                            position: 1,
                            pp: 5
                        },
                        {
                            attack_id: "AttackStarGaze",
                            pp_stat: 15,
                            effects: [{ stat: "Speed", type: "Stat", power: -2, accuracy: 0.95 }],
                            position: 2,
                            pp: 15
                        },
                        {
                            attack_id: "AttackUpbeat",
                            pp_stat: 10,
                            effects: [
                                { type: "Hit", power: 90, accuracy: 0.75, continue_on_miss: false },
                                { stat: "Speed", type: "Stat", power: 1, to_self: true, accuracy: 0.75 },
                                { stat: "Attack", type: "Stat", power: 1, to_self: true, accuracy: 0.75 }
                            ],
                            position: 3,
                            pp: 10
                        }
                    ]
                },
                {
                    morty_id: "MortyChick",
                    speed: [69, 83],
                    attack: [60, 73],
                    defence: [66, 80],
                    hp: [103, 119],
                    level: [32, 34],
                    owned_attacks: [
                        {
                            attack_id: "AttackServingUp",
                            pp_stat: 8,
                            effects: [{ type: "Hit", power: 95, accuracy: 0.9 }],
                            position: 0,
                            pp: 8
                        },
                        {
                            attack_id: "AttackHarden",
                            pp_stat: 15,
                            effects: [{ stat: "Defence", type: "Stat", power: 2, to_self: true, accuracy: 0.95 }],
                            position: 1,
                            pp: 15
                        },
                        {
                            attack_id: "AttackWetTongue",
                            pp_stat: 5,
                            effects: [
                                { type: "Hit", power: 15, accuracy: 0.95 },
                                { type: "Hit", power: 20 },
                                { type: "Hit", power: 30, accuracy: 0.8 },
                                { type: "Hit", power: 35, accuracy: 0.5 }
                            ],
                            position: 2,
                            pp: 5
                        },
                        {
                            attack_id: "AttackSalivate",
                            pp_stat: 15,
                            effects: [{ stat: "Attack", type: "Stat", power: 2, to_self: true, accuracy: 0.95 }],
                            position: 3,
                            pp: 15
                        }
                    ]
                },
                {
                    morty_id: "MortyRobotChicken",
                    speed: [76, 90],
                    attack: [50, 63],
                    defence: [66, 80],
                    hp: [103, 119],
                    level: [32, 34],
                    owned_attacks: [
                        {
                            attack_id: "AttackLaserStare",
                            pp_stat: 8,
                            effects: [
                                { stat: "Accuracy", type: "Stat", power: 2, to_self: true, accuracy: 0.8 },
                                { stat: "Attack", type: "Stat", power: 2, to_self: true, accuracy: 0.8 }
                            ],
                            position: 0,
                            pp: 8
                        },
                        {
                            attack_id: "AttackDinnerTime",
                            pp_stat: 5,
                            effects: [{ type: "Hit", power: 120, accuracy: 0.95 }],
                            position: 1,
                            pp: 5
                        },
                        {
                            attack_id: "AttackFlutter",
                            pp_stat: 8,
                            effects: [{ type: "Hit", power: 100, accuracy: 0.95 }],
                            position: 2,
                            pp: 8
                        },
                        {
                            attack_id: "AttackBlink",
                            pp_stat: 12,
                            effects: [{ stat: "Accuracy", type: "Stat", power: 2, to_self: true, accuracy: 0.95 }],
                            position: 3,
                            pp: 12
                        }
                    ]
                },
                {
                    morty_id: "MortyDrone",
                    speed: [69, 83],
                    attack: [69, 83],
                    defence: [69, 83],
                    hp: [106, 122],
                    level: [32, 34],
                    owned_attacks: [
                        {
                            attack_id: "AttackStaticShock",
                            pp_stat: 5,
                            effects: [
                                { stat: "Defence", type: "Stat", power: 2, to_self: true },
                                { type: "Paralyse", accuracy: 0.5, continue_on_miss: false },
                                { type: "Paralyse", to_self: true }
                            ],
                            position: 0,
                            pp: 5
                        },
                        {
                            attack_id: "AttackCrush",
                            pp_stat: 8,
                            effects: [{ type: "Hit", power: 90, accuracy: 0.95 }],
                            position: 1,
                            pp: 8
                        },
                        {
                            attack_id: "AttackWall",
                            pp_stat: 10,
                            effects: [{ stat: "Defence", type: "Stat", power: 3, to_self: true, accuracy: 0.95 }],
                            position: 2,
                            pp: 10
                        },
                        {
                            attack_id: "AttackGrab",
                            pp_stat: 5,
                            effects: [
                                { type: "Paralyse", accuracy: 0.6, continue_on_miss: false },
                                { stat: "Attack", type: "Stat", power: -1 }
                            ],
                            position: 3,
                            pp: 5
                        }
                    ]
                },
                {
                    morty_id: "MortyTurkerSoldier",
                    speed: [50, 63],
                    attack: [50, 63],
                    defence: [49, 62],
                    hp: [98, 114],
                    level: [32, 34],
                    owned_attacks: [
                        {
                            attack_id: "AttackPerchAndPoop",
                            pp_stat: 10,
                            effects: [
                                { type: "Hit", power: 50, accuracy: 0.9 },
                                { type: "Hit", power: 50, accuracy: 0.9, continue_on_miss: false },
                                { stat: "Defence", type: "Stat", power: -1, accuracy: 0.95 }
                            ],
                            position: 0,
                            pp: 10
                        },
                        {
                            attack_id: "AttackGobbleTango",
                            pp_stat: 5,
                            effects: [{ type: "Hit", power: 100, accuracy: 0.8 }],
                            position: 1,
                            pp: 5
                        },
                        {
                            attack_id: "AttackPray",
                            pp_stat: 10,
                            effects: [{ stat: "Attack", type: "Stat", power: 3, to_self: true, accuracy: 0.95 }],
                            position: 2,
                            pp: 10
                        },
                        {
                            attack_id: "AttackDefend",
                            pp_stat: 10,
                            effects: [{ stat: "Defence", type: "Stat", power: 3, to_self: true, accuracy: 0.95 }],
                            position: 3,
                            pp: 10
                        }
                    ]
                }
            ]
        },
        drop_rates: [80, 12, 6, 2],
        gacha_promo_chance: "0.06",
        gacha: [
            {
                gacha_id: "GachaMPProduct1",
                cost: 5,
                gacha_content: [
                    {
                        quantity: 1,
                        reward: "ITEM",
                        parameters: {
                            ids: [
                                "ItemMortyChip",
                                "ItemPureSerum",
                                "ItemHalzinger",
                                "ItemPureHalzinger",
                                "ItemFullRecover",
                                "ItemMrMeeseek",
                                "ItemMegaSeedAttack",
                                "ItemMegaSeedDefence",
                                "ItemMegaSeedSpeed",
                                "ItemMegaSeedLevelUp"
                            ],
                            division_chances: null
                        }
                    },
                    {
                        quantity: 1,
                        reward: "MORTY",
                        parameters: { division_chances: null }
                    },
                    {
                        quantity: 2,
                        reward: "MORTY",
                        parameters: { division_guarantee: 2, division_chances: null }
                    }
                ],
                level: [32, 34]
            },
            {
                gacha_id: "GachaMPProduct2",
                cost: 15,
                gacha_content: [
                    {
                        quantity: 1,
                        reward: "MORTY",
                        parameters: { division_guarantee: 3, division_chances: null }
                    },
                    {
                        quantity: 3,
                        reward: "MORTY",
                        parameters: { division_guarantee: 2, division_chances: null }
                    },
                    {
                        quantity: 4,
                        reward: "ITEM",
                        parameters: {
                            ids: [
                                "ItemMortyChip",
                                "ItemPureSerum",
                                "ItemHalzinger",
                                "ItemPureHalzinger",
                                "ItemFullRecover",
                                "ItemMrMeeseek",
                                "ItemMegaSeedAttack",
                                "ItemMegaSeedDefence",
                                "ItemMegaSeedSpeed",
                                "ItemMegaSeedLevelUp"
                            ],
                            division_chances: null
                        }
                    },
                    {
                        quantity: 3,
                        reward: "MORTY",
                        parameters: { division_chances: null }
                    }
                ],
                level: [32, 34]
            },
            {
                gacha_id: "GachaMPProduct3",
                cost: 40,
                gacha_content: [
                    {
                        quantity: 4,
                        reward: "MORTY",
                        parameters: { division_guarantee: 2, division_chances: null }
                    },
                    {
                        quantity: 3,
                        reward: "MORTY",
                        parameters: { division_chances: null }
                    },
                    {
                        quantity: 1,
                        reward: "MORTY",
                        parameters: { division_guarantee: 4, division_chances: null }
                    },
                    {
                        quantity: 2,
                        reward: "MORTY",
                        parameters: { division_guarantee: 3, division_chances: null }
                    },
                    {
                        quantity: 10,
                        reward: "ITEM",
                        parameters: {
                            ids: [
                                "ItemMortyChip",
                                "ItemPureSerum",
                                "ItemHalzinger",
                                "ItemPureHalzinger",
                                "ItemFullRecover",
                                "ItemMrMeeseek",
                                "ItemMegaSeedAttack",
                                "ItemMegaSeedDefence",
                                "ItemMegaSeedSpeed",
                                "ItemMegaSeedLevelUp"
                            ],
                            division_chances: null
                        }
                    }
                ],
                level: [32, 34]
            }
        ]
    };

    return res.status(200).json(gachaData);
});


// -------------------- 11. DIMENSIONS OWNERSHIP --------------------
app.post('/session/dimensions/query', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const dimensionsData = {
        dimension_1_owned: true,
        dimension_2_owned: true,
        dimension_3_owned: true,
        dimension_4_owned: true,
        dimension_5_owned: true,
        dimension_6_owned: true,
        dimension_7_owned: true
    };

    return res.json(dimensionsData);
});



// -------------------- 12. JOIN ROOM --------------------
app.post('/session/join-room', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = String(req.body.session_id || "");
    const world_id_in = String(req.body.world_id || "");

    if (!session_id || !world_id_in) {
        return res.status(400).json({ error: "Missing session_id or world_id" });
    }

    try {
        const me = await requireUserBySession(session_id);
        const player_id = me.player_id;

        const [rooms] = await pool.execute(
            `SELECT room_id, room_udp_host, room_udp_port, world_id, zone_id 
             FROM room_ids WHERE world_id = ? LIMIT 1`, 
            [world_id_in]
        );

        if (!rooms.length) {
            return res.status(400).json({ error: "NO_ROOM_FOUND" });
        }
        
        const room = rooms[0];
        const room_id = room.room_id;

        await pool.execute(
            `UPDATE users SET room_id = ?, state = 'WORLD', last_seen = NOW() WHERE player_id = ?`,
            [room_id, player_id]
        );

        const [baselineRows] = await pool.execute(`SELECT COALESCE(MAX(id), 0) AS max_id FROM event_queue WHERE room_id = ?`, [room_id]);
        const baseline_event_id = parseInt(baselineRows[0].max_id, 10);
        
        //await pool.execute(`UPDATE users SET last_event_id = ? WHERE player_id = ?`, [baseline_event_id, player_id]);

        const [roomUsers] = await pool.execute(
            `SELECT player_id, username, player_avatar_id, level, state, active_deck_id 
             FROM users WHERE room_id = ? AND last_seen >= (NOW() - INTERVAL 1 MINUTE)`,
            [room_id]
        );
		
		const sessionHex = session_id.replaceAll("-", "");
		// client UDP token received from client
        registerPlayerUdpSession(player_id, sessionHex, room_id);

        const users = [];

        for (const u of roomUsers) {
            let owned_morties = [];
            
            const [decks] = await pool.execute(
                `SELECT owned_morty_ids FROM decks WHERE player_id = ? AND deck_id = ? LIMIT 1`,
                [u.player_id, u.active_deck_id || "0"]
            );

            if (decks.length && decks[0].owned_morty_ids) {
                let mortyIds = [];
                try {
                    mortyIds = typeof decks[0].owned_morty_ids === 'string' 
                        ? JSON.parse(decks[0].owned_morty_ids) 
                        : decks[0].owned_morty_ids;
                } catch (e) {
                    mortyIds = [];
                }

                if (Array.isArray(mortyIds) && mortyIds.length > 0) {
                    const placeholders = mortyIds.map(() => '?').join(',');
                    const [mortyRows] = await pool.execute(
                        `SELECT * FROM owned_morties WHERE owned_morty_id IN (${placeholders})`,
                        mortyIds
                    );

                    for (const m of mortyRows) {
                        owned_morties.push({
                            owned_morty_id: m.owned_morty_id,
                            morty_id: m.morty_id,
                            hp: parseInt(m.hp || 0, 10),
                            variant: m.variant || "Normal",
                            is_locked: [1, '1', true, 'true'].includes(m.is_locked),
                            is_trading_locked: [1, '1', true, 'true'].includes(m.is_trading_locked),
                            fight_pit_id: (!m.fight_pit_id || String(m.fight_pit_id).toLowerCase() === 'null') ? null : m.fight_pit_id
                        });
                    }
                }
            }
			
            let currentPlacement = [30,35];

            if (player_id === u.player_id) {
                currentPlacement = [30,36];
            } else {
                const livePos = livePlayerPositions.get(u.player_id);

                if (livePos) {
                    currentPlacement = [
                        livePos.x,
                        livePos.y
                    ];
                }
            }
			
            users.push({
                player_id: u.player_id,
                username: u.username,
                player_avatar_id: u.player_avatar_id,
                level: parseInt(u.level || 1, 10),
                owned_morties: owned_morties,
                state: u.state || "WORLD",
				"shiny_if_potion": false,
		        "streak": u.streak,
				placement: currentPlacement // Handled and overwritten immediately by the active UDP server loop
            });
        }

        const [pickupRows] = await pool.execute(
            `SELECT pickup_id, placement, pick_up_contents FROM event_queue 
             WHERE room_id = ? AND event_name = 'room:pickup-added' AND pickup_id_collected_by_player_id IS NULL`,
            [room_id]
        );

        const pickups = pickupRows.map(p => {
            const pos = String(p.placement || "0,0").split(",");
            let contents = [];
            try { contents = JSON.parse(p.pick_up_contents || "[]"); } catch(e) {}
            if (contents && contents.type && !Array.isArray(contents)) { contents = [contents]; }

            return {
                pickup_id: p.pickup_id,
                placement: [parseInt(pos[0] || 0, 10), parseInt(pos[1] || 0, 10)],
                contents: Array.isArray(contents) ? contents : []
            };
        });

        const [wildRows] = await pool.execute(
            `SELECT * FROM event_queue WHERE room_id = ? AND event_name = 'room:wild-morty-added'`,
            [room_id]
        );

        const wild_morties = wildRows.map(w => {
            const pos = String(w.placement || "0,0").split(",");
            const safeDate = w.created_at ? new Date(w.created_at).toISOString() : new Date().toISOString();
            
            return {
                morty_id: w.morty_id,
                placement: [parseInt(pos[0] || 0, 10), parseInt(pos[1] || 0, 10)],
                state: w.state || "WORLD",
                division: parseInt(w.division || 1, 10),
                variant: w.variant || "Normal",
                shiny_if_potion: Boolean(w.shiny_if_potion),
                _created: safeDate,
                _updated: safeDate,
                wild_morty_id: w.wild_morty_id
            };
        });

        const [botRows] = await pool.execute(
            `SELECT bot_id, username, player_avatar_id, placement, state, division, zone_id, shiny_if_potion, owned_morties 
             FROM event_queue WHERE room_id = ? AND event_name = 'room:bot-added'`,
            [room_id]
        );

        const bots = botRows.map(b => {
            const pos = String(b.placement || "0,0").split(",");
            let parsedMorties = [];
            try { parsedMorties = JSON.parse(b.owned_morties || "[]"); } catch(e) {}

            return {
                username: b.username,
                player_avatar_id: b.player_avatar_id,
                state: b.state || "WORLD",
                level: 1,
                owned_morties: parsedMorties,
                shiny_if_potion: Boolean(b.shiny_if_potion),
                streak: 0,
                bot_id: b.bot_id,
                placement: [parseInt(pos[0] || 0, 10), parseInt(pos[1] || 0, 10)]
            };
        });

        const responseData = {
            room_id: room.room_id,
            room_udp_host: room.room_udp_host,
            room_udp_port: String(room.room_udp_port),
            world_id: String(room.world_id),
            zone_id: room.zone_id,
            incentive: {
                incentive_id: "NPCAd",
                rewards: [
                    { type: "ITEM", amount: 1, item_id: "ItemSerum", rarity: 100 },
                    { type: "ITEM", amount: 1, item_id: "ItemParalysisCure", rarity: 75 },
                    { type: "COIN", amount: 200 }
                ],
                token: ""
            },
            users: users,
            pickups: pickups,
            wild_morties: wild_morties,
            bots: bots
        };
		
        //await pool.execute(
        //    `UPDATE users SET room_id = ?, state = 'WORLD', last_seen = NOW() WHERE player_id = ?`,
        //    [room_id, player_id]
        //);
		
		// --- BROADCAST PLAYER JOINED NOW THAT SSE PIPELINE IS ESTABLISHED ---
        const [uRows] = await pool.execute("SELECT username, player_avatar_id, state FROM users WHERE player_id = ?", [player_id]);
        if (uRows.length) {
            const publishPayload = {
                room_id: room_id,
                player_id: player_id,
                username: uRows[0].username,
                player_avatar_id: uRows[0].player_avatar_id,
                state: uRows[0].state || "WORLD",
				"shiny_if_potion": false,
		        "streak": uRows[0].streak,
                placement: [30, 35]
            };
            publishEvent(room_id, "room:user-added", publishPayload, player_id).catch(console.error);
        }

        return res.json(responseData);

    } catch (err) {
        console.error(err);
        return res.status(err.statusCode || 500).json({ error: err.message });
    }
});

// -------------------- LEAVE ROOM --------------------
app.post('/session/leave-room', async (req, res) => {
    // Match headers from your original production script
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : "";

    if (session_id === "") {
        return res.status(400).json({ 
            success: false, 
            error: "Missing session_id" 
        });
    }

    try {
        // 1. Validate user and pull current room mapping using your existing helper
        const user = await requireUserBySession(session_id);
        const player_id = user.player_id;
        const room_id = user.room_id;

        // 2. Broadcast leave event to everyone else via your existing event queue publisher
        // We look up the room_id from the user profile just like the PHP script's query
        if (room_id && room_id !== "0" && room_id !== "") {
            await publishEvent(
                String(room_id), 
                "room:user-removed", 
                { player_id: String(player_id) }, 
                player_id
            );
            
            // Optional: If you want to explicitly wipe their room status in the DB upon leaving:
            // await pool.execute("UPDATE users SET room_id = '0', state = NULL WHERE player_id = ?", [player_id]);
        }

        // 3. Send clean success response
        return res.json({ 
            success: true 
        });

    } catch (err) {
        // Handle unauthenticated session errors thrown by requireUserBySession gracefully
        if (err.statusCode === 401) {
            return res.status(404).json({
                success: false,
                error: "Invalid session"
            });
        }

        console.error("[Leave Room API] Server Error:", err.message);
        return res.status(500).json({ 
            success: false, 
            error: "SERVER_ERROR" 
        });
    }
});

// POST /inappdeletion/request-account-deletion
app.post('/inappdeletion/request-account-deletion', (req, res) => {
    // PHP's json_decode(file_get_contents('php://input'), true) 
    // maps directly to req.body thanks to express.json() middleware
    const playerId = req.body.uuid;

    // Optional validation to ensure a uuid was actually provided
    if (!playerId) {
        return res.status(400).json({ error: "Missing uuid parameter." });
    }

    // Set matching response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    // Note: Express automatically sets 'X-Powered-By: Express' by default.
    // Note: cors() middleware automatically manages 'Access-Control-Allow-Origin: *'.

    // Mirroring your echo statement: matching content-type behavior.
    // If you need to send back raw text matching the exact echo output:
    return res.send(playerId);
    
    // Alternatively, if your client expects a strict JSON object back:
    // return res.json({ uuid: playerId });
});

// -------------------- UPDATE PLAYER STATE --------------------
app.post('/session/state', async (req, res) => {
    // Match the headers from your PHP setup
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : '';
    const new_state = req.body.state ? String(req.body.state) : '';

    // Validation check for standard required parameters
    if (session_id === '' || new_state === '') {
        return res.status(400).json({ 
            error: "Bad Request. Missing session_id or state parameters." 
        });
    }

    try {
        // 1. Fetch the user's current identity, room mapping, and state from the database
        const user = await requireUserBySession(session_id);
        const player_id = String(user.player_id);
        const current_db_state = String(user.state || '');
        const room_id = String(user.room_id || '');

        // 2. Check if the incoming state is different from what the database says
        if (new_state !== current_db_state) {
            
            // Update the state in the users table
            await pool.execute(
                "UPDATE users SET state = ?, last_seen = NOW() WHERE player_id = ?",
                [new_state, player_id]
            );

            // If the player is actively mapped to a valid room shard, broadcast the change to the SSE queue
            if (room_id && room_id !== "0" && room_id !== "") {
                await publishEvent(
                    room_id, 
                    "room:user-state-changed", 
                    { player_id: player_id, state: new_state }, 
                    player_id
                );
            }
        }

        // 3. Mirror the original PHP output format exactly back to the client
        return res.json({
            state: new_state
        });

    } catch (err) {
        if (err.statusCode === 401) {
            return res.status(401).json({
                error: "Not authenticated"
            });
        }
        
        console.error("[State API] Server Error:", err.message);
        return res.status(500).json({
            error: "SERVER_ERROR"
        });
    }
});




// -------------------- COLLECT & RESPAWN WORLD PICKUPS --------------------

/**
 * Generates a standard RFC4122 version-4 compliant UUID string.
 */
function uuidv4() {
    return crypto.randomUUID();
}

/**
 * Core dynamic drop-table configurations matching loot mechanics.
 */
const PICKUP_POINTS = [
    [65, 79], [2, 79], [48, 87], [34, 83],
    [8, 57], [57, 48], [25, 87], [42, 64]
];

function weightedPick(choices) {
    let total = 0;
    for (const c of choices) {
        total += parseInt(c.weight, 10);
    }

    const roll = Math.floor(Math.random() * Math.max(1, total)) + 1;
    let acc = 0;

    for (const c of choices) {
        acc += parseInt(c.weight, 10);
        if (roll <= acc) {
            return c.value;
        }
    }
    return choices[choices.length - 1].value;
}

function pickRarity() {
    return weightedPick([
        { value: 5, weight: 55 },
        { value: 75, weight: 30 },
        { value: 100, weight: 15 }
    ]);
}

function getLootTableByRarity() {
    return {
        5: ["ItemMegaSeedSpeed", "ItemTinCan", "ItemCircuitBoard", "ItemCable", "ItemPlutonicRock", "ItemBacteriaCell"],
        75: ["ItemPoisonCure", "ItemCable", "ItemCircuitBoard"],
        100: ["ItemSerum", "ItemDarkEnergyBall", "ItemCircuitBoard", "ItemPlutonicRock"]
    };
}

function pickItemId(rarity, exclude = []) {
    const table = getLootTableByRarity();
    let pool = table[rarity] || ["ItemCircuitBoard"];

    if (exclude.length > 0) {
        const filtered = pool.filter(item => !exclude.includes(item));
        if (filtered.length > 0) {
            pool = filtered;
        }
    }
    return pool[Math.floor(Math.random() * pool.length)];
}

async function getAvailableSpawn(connection, roomId) {
    const [rows] = await connection.execute(`
        SELECT placement 
        FROM event_queue 
        WHERE room_id = ? 
          AND event_name = 'room:pickup-added' 
          AND pickup_id_collected_by_player_id IS NULL
    `, [roomId]);

    const used = {};
    for (const row of rows) {
        if (!row.placement) continue;
        const parts = row.placement.split(',');
        if (parts.length === 2) {
            used[`${parts[0]},${parts[1]}`] = true;
        }
    }

    const available = [];
    for (const pt of PICKUP_POINTS) {
        const key = `${pt[0]},${pt[1]}`;
        if (!used[key]) {
            available.push(pt);
        }
    }

    const targetPool = available.length > 0 ? available : PICKUP_POINTS;
    return targetPool[Math.floor(Math.random() * targetPool.length)];
}

function randomPickupContents(exclude = []) {
    const kind = weightedPick([
        { value: "single", weight: 70 },
        { value: "bundle", weight: 30 }
    ]);

    if (kind === "single") {
        const rarity = pickRarity();
        return [{
            type: "ITEM",
            amount: 1,
            item_id: pickItemId(rarity, exclude),
            rarity: rarity
        }];
    }

    const count = Math.floor(Math.random() * (4 - 2 + 1)) + 2; // random_int(2,4)
    const items = [];
    const picked = [];

    for (let i = 0; i < count; i++) {
        const rarity = pickRarity();
        const item = pickItemId(rarity, [...exclude, ...picked]);
        picked.push(item);

        items.push({
            type: "ITEM",
            amount: 1,
            item_id: item,
            rarity: rarity
        });
    }

    items.push({
        type: "COIN",
        amount: Math.floor(Math.random() * (250 - 120 + 1)) + 120 // random_int(120,250)
    });

    return items;
}

async function makeNewPickup(connection, roomId, exclude = []) {
    const pos = await getAvailableSpawn(connection, roomId);
    return {
        pickup_id: uuidv4(),
        placement: `${pos[0]},${pos[1]}`, // Match native string format splitting expectations
        contents: randomPickupContents(exclude)
    };
}

/**
 * Shared Local Helper to inject custom events into global streaming pipelines
 */
async function publishLocalEvent(connection, roomId, eventName, payload) {
    const placement = payload.placement || null;
    const pickupId = payload.pickup_id || null;
    
    // Extract contents block if generating a pickup spawn sequence
    let serializedContents = null;
    if (payload.contents) {
        serializedContents = JSON.stringify(payload.contents);
    }

    await connection.execute(`
        INSERT INTO event_queue (room_id, event_name, pickup_id, placement, pick_up_contents, created_at)
        VALUES (?, ?, ?, ?, ?, NOW())
    `, [roomId, eventName, pickupId, placement, serializedContents]);
}

/**
 * Inventory Modification Handlers bounded inside active transactional connections
 */
async function grantItem(connection, playerId, itemId, amount) {
    const [rows] = await connection.execute(`
        SELECT id, quantity FROM owned_items 
        WHERE player_id = ? AND item_id = ? LIMIT 1
    `, [playerId, itemId]);

    const current = rows.length ? parseInt(rows[0].quantity, 10) : 0;
    const newQty = Math.min(10, current + amount); // Max item stack limitation match
    const added = Math.max(0, newQty - current);

    if (rows.length) {
        await connection.execute(`
            UPDATE owned_items SET quantity = ? WHERE id = ?
        `, [newQty, rows[0].id]);
    } else {
        await connection.execute(`
            INSERT INTO owned_items (player_id, item_id, quantity) 
            VALUES (?, ?, ?)
        `, [playerId, itemId, newQty]);
    }

    return {
        type: "ITEM",
        item_id: itemId,
        quantity: newQty,
        amount_received: added,
        amount: amount
    };
}

async function grantCoins(connection, playerId, amount) {
    await connection.execute(`
        UPDATE users SET coins = coins + ? WHERE player_id = ?
    `, [amount, playerId]);

    const [rows] = await connection.execute(`
        SELECT coins FROM users WHERE player_id = ? LIMIT 1
    `, [playerId]);

    const currentCoins = rows.length ? parseInt(rows[0].coins, 10) : 0;

    return {
        type: "COIN",
        quantity: currentCoins,
        amount_received: amount,
        amount: amount
    };
}

// ROUTE HANDLER DEFINITION
app.post('/session/collect-pickup', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sessionId = req.body.session_id ? String(req.body.session_id) : "";
    const pickupId = req.body.pickup_id ? String(req.body.pickup_id) : "";

    if (!sessionId || !pickupId) {
        return res.status(400).json({ error: "Missing session_id or pickup_id" });
    }

    // Get a specific connection from the pool to execute multi-step transactions
    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Resolve and Lock player state row context
        const [playerRows] = await connection.execute(`
            SELECT player_id, room_id FROM users 
            WHERE session_id = ? LIMIT 1 FOR UPDATE
        `, [sessionId]);

        if (!playerRows.length) {
            throw new Error("Invalid session");
        }

        const playerId = playerRows[0].player_id;
        const roomId = playerRows[0].room_id;

        // 2. Resolve and Lock targeting pickup row item status
        const [pickupRows] = await connection.execute(`
            SELECT id, pickup_id, placement, pick_up_contents 
            FROM event_queue 
            WHERE room_id = ? 
              AND event_name = 'room:pickup-added' 
              AND pickup_id = ? 
              AND pickup_id_collected_by_player_id IS NULL 
            ORDER BY id DESC LIMIT 1 FOR UPDATE
        `, [roomId, pickupId]);

        if (!pickupRows.length) {
            throw new Error("Pickup already collected or missing");
        }

        const targetPickupRow = pickupRows[0];
        let contents = null;

        try {
            contents = JSON.parse(targetPickupRow.pick_up_contents);
        } catch (parseErr) {
            contents = targetPickupRow.pick_up_contents; 
        }

        // 🔥 Normalize bad legacy data payloads matching legacy fallback wrappers
        if (typeof contents === 'string') {
            contents = [{
                type: "ITEM",
                amount: 1,
                item_id: contents
            }];
        }

        if (contents && typeof contents === 'object' && !Array.isArray(contents) && contents.type) {
            contents = [contents];
        }

        if (!Array.isArray(contents)) {
            throw new Error("Invalid pickup contents format");
        }

        // 3. Flag requested map entity element status marker as claimed
        await connection.execute(`
            UPDATE event_queue 
            SET pickup_id_collected_by_player_id = ? 
            WHERE id = ?
        `, [playerId, targetPickupRow.id]);

        // 4. Disburse items/currencies loops
        const results = [];
        const exclude = [];

        for (const reward of contents) {
            if (reward.type === "ITEM") {
                exclude.push(reward.item_id);
                const itemResult = await grantItem(connection, playerId, reward.item_id, parseInt(reward.amount, 10));
                results.push(itemResult);
            } else if (reward.type === "COIN") {
                const coinResult = await grantCoins(connection, playerId, parseInt(reward.amount, 10));
                results.push(coinResult);
            }
        }

        // 5. Broadcast removal marker payload update message
        await publishLocalEvent(connection, roomId, "room:pickup-removed", {
            pickup_id: pickupId
        });

        // 6. Automatically generate random replacement map asset point drops
        const newPickupData = await makeNewPickup(connection, roomId, exclude);
        await publishLocalEvent(connection, roomId, "room:pickup-added", newPickupData);

        // Commit transaction atomic balance states across tables cleanly
        await connection.commit();

        return res.json({
            pickup_id: pickupId,
            contents: results
        });

    } catch (transactionError) {
        // Rollback engine states seamlessly to reverse half-executed modifications
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error("Rollback failed:", rollbackErr);
        }

        console.error(">>> [PICKUP TRANSACTION EXCEPTION]:", transactionError.message);
        return res.status(500).json({
            error: "Server error",
            detail: transactionError.message
        });
    } finally {
        // Always release connection wrapper instances back into the pool pipeline
        connection.release();
    }
});



// -------------------- RAID EVENT CHECK --------------------
// Helper function to format a JavaScript Date object back into standard MySQL YYYY-MM-DD HH:mm:ss format
function formatDbTimestamp(dateVal) {
    if (!dateVal) return "";
    const d = new Date(dateVal);
    if (isNaN(d.getTime())) return String(dateVal); // Fallback if it's already a string
    
    const pad = (num) => String(num).padStart(2, '0');
    
    const year = d.getFullYear();
    const month = pad(d.getMonth() + 1);
    const day = pad(d.getDate());
    const hours = pad(d.getHours());
    const minutes = pad(d.getMinutes());
    const seconds = pad(d.getSeconds());
    
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

app.post('/event/check', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : (req.query.session_id ? String(req.query.session_id) : "");
    const world_id = req.body.world_id ? parseInt(req.body.world_id, 10) : (req.query.world_id ? parseInt(req.query.world_id, 10) : 1);

    if (session_id === "") {
        return res.status(400).json({ success: false, error: "Missing session_id" });
    }

    try {
        // 1) Lookup player account metadata + current shard room from users
        const [userRows] = await pool.execute(
            "SELECT player_id, room_id FROM users WHERE session_id = ? LIMIT 1",
            [session_id]
        );
        const u = userRows[0];

        if (!u) {
            return res.status(401).json({ success: false, error: "Not authenticated" });
        }

        const player_id = String(u.player_id);
        const room_id = u.room_id ? String(u.room_id) : "";

        if (room_id === "" || room_id === "0") {
            return res.status(409).json({ success: false, error: "Player is not in a room" });
        }

        // 2) Verify room target registry mapping exists in room_ids matching database
        const [roomCheck] = await pool.execute(
            "SELECT 1 FROM room_ids WHERE room_id = ? LIMIT 1",
            [room_id]
        );
        if (!roomCheck.length) {
            return res.status(409).json({ success: false, error: "Room does not exist", room_id: room_id });
        }

        // 3) Query the priority event lifecycle state from the events database schema
        const [eventRows] = await pool.execute(`
            SELECT * FROM events 
            WHERE current_state IN ('build_up', 'active')
            ORDER BY 
                CASE current_state
                    WHEN 'active' THEN 0
                    WHEN 'build_up' THEN 1
                    ELSE 2
                END, 
                event_state_next_timestamp ASC 
            LIMIT 1
        `);
        const event = eventRows[0] || null;

        if (event) {
            const state = event.current_state ? String(event.current_state) : null;

            if (state === "active" || state === "build_up") {
                // Construct payload schema with corrected clean timestamp layout
                const payload = {
                    raid_event_id: String(event.raid_event_id || ""),
                    shard_id: String(event.shard_id || ""),
                    current_state: String(event.current_state || ""),
                    world_id: event.world_id !== undefined ? parseInt(event.world_id, 10) : world_id,
                    spawn_location: String(event.spawn_location || ""),
                    boss_id: String(event.boss_id || ""),
                    asset_id: String(event.asset_id || ""),
                    threat_lvl: parseInt(event.threat_lvl || 0, 10),
                    total_damage: String(event.total_damage || "0"),
                    initial_health: parseInt(event.initial_health || 0, 10),
                    max_health_bars: parseInt(event.max_health_bars || 0, 10),
                    // FIXED: Cleanses the JS Date Object back into a strict "YYYY-MM-DD HH:MM:SS" format string
                    event_state_next_timestamp: formatDbTimestamp(event.event_state_next_timestamp),
                    has_ran: [1, '1', true, 'true'].includes(event.has_ran),
                    permit_start: parseInt(event.permit_start || 0, 10),
                    permit_buy_in: parseInt(event.permit_buy_in || 0, 10),
                    ticket_buy_in: parseInt(event.ticket_buy_in || 0, 10)
                };

                // Inject the event tracking array into the room event queue
                await publishEvent(room_id, "shard:raid-boss-state-changed", payload, player_id);
            }
        }

        // 4) Keep player activity warm in database session registries
        //await pool.execute(
        //    "UPDATE users SET last_seen = NOW() WHERE player_id = ? LIMIT 1",
        //   [player_id]
        //);

        return res.json({ success: true });

    } catch (err) {
        console.error("[Raid Event API] Server Error:", err.message);
        return res.status(500).json({ success: false, error: "SERVER_ERROR" });
    }
});

// -------------------- RAID TIERS REWARDS CONFIGURATION --------------------
app.post('/event/brackets', (req, res) => {
    // 1. Establish absolute client response compliance headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    // 2. Encapsulate reward brackets matching structural layout expectations
    const rewardsData = {
        results: [
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 1, reward_bracket_end: 1, base_quantity: 2, base_type: "ITEM", base_parameters: { ids: ["ItemPlutonicRock"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 3, reward_bracket_end: 3, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemHalzinger"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 4, reward_bracket_end: 10, base_quantity: 2, base_type: "ITEM", base_parameters: { ids: ["ItemMortyChip"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 201, reward_bracket_end: 300, base_quantity: 100, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 1, reward_bracket_end: 1, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemFullRecover"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 3, reward_bracket_end: 3, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemPlutonicRock"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 4, reward_bracket_end: 10, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemGreatSerum"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 301, reward_bracket_end: 500, base_quantity: 50, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 2, reward_bracket_end: 2, base_quantity: 4, base_type: "ITEM", base_parameters: { ids: ["ItemMortyChip"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 2, reward_bracket_end: 2, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemFullRecover"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 4, reward_bracket_end: 10, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemHalzinger"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 101, reward_bracket_end: 200, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemMortyChip"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 301, reward_bracket_end: 500, base_quantity: 50, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 1, reward_bracket_end: 1, base_quantity: 7, base_type: "ITEM", base_parameters: { ids: ["ItemMortyChip"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 3, reward_bracket_end: 3, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemGreatSerum"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 11, reward_bracket_end: 100, base_quantity: 1, base_type: "COUPON", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 101, reward_bracket_end: 200, base_quantity: 133, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 301, reward_bracket_end: 500, base_quantity: 50, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 2, reward_bracket_end: 2, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemGreatSerum"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 3, reward_bracket_end: 3, base_quantity: 1, base_type: "MORTY", base_parameters: { ids: ["MortyNoDinos"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 4, reward_bracket_end: 10, base_quantity: 5, base_type: "COUPON", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 101, reward_bracket_end: 200, base_quantity: 134, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 501, reward_bracket_end: 750, base_quantity: 37, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 1, reward_bracket_end: 1, base_quantity: 2000, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 2, reward_bracket_end: 2, base_quantity: 1450, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 3, reward_bracket_end: 3, base_quantity: 1050, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 11, reward_bracket_end: 100, base_quantity: 1, base_type: "MORTY", base_parameters: { ids: ["MortyNoDinos"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 201, reward_bracket_end: 300, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemMortyChip"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 1, reward_bracket_end: 1, base_quantity: 1, base_type: "MORTY", base_parameters: { ids: ["MortyNoDinos"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 1, reward_bracket_end: 1, base_quantity: 2, base_type: "ITEM", base_parameters: { ids: ["ItemGreatSerum"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 2, reward_bracket_end: 2, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemPlutonicRock"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 4, reward_bracket_end: 10, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemPlutonicRock"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 101, reward_bracket_end: 200, base_quantity: 133, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 301, reward_bracket_end: 500, base_quantity: 50, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 2, reward_bracket_end: 2, base_quantity: 1, base_type: "MORTY", base_parameters: { ids: ["MortyNoDinos"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 3, reward_bracket_end: 3, base_quantity: 10, base_type: "COUPON", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 4, reward_bracket_end: 10, base_quantity: 750, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 201, reward_bracket_end: 300, base_quantity: 100, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 501, reward_bracket_end: 750, base_quantity: 37, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 1, reward_bracket_end: 1, base_quantity: 2, base_type: "ITEM", base_parameters: { ids: ["ItemHalzinger"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 2, reward_bracket_end: 2, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemHalzinger"] }, bonus_quantity: 1, bonus_type: null, bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 4, reward_bracket_end: 10, base_quantity: 1, base_type: "MORTY", base_parameters: { ids: ["MortyNoDinos"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedAttack"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 11, reward_bracket_end: 100, base_quantity: 1, base_type: "ITEM", base_parameters: { ids: ["ItemMortyChip"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 501, reward_bracket_end: 750, base_quantity: 39, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 1, reward_bracket_end: 1, base_quantity: 35, base_type: "COUPON", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 2, reward_bracket_end: 2, base_quantity: 20, base_type: "COUPON", base_parameters: null, bonus_quantity: 1, bonus_type: "COUPON", bonus_parameters: null },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 3, reward_bracket_end: 3, base_quantity: 3, base_type: "ITEM", base_parameters: { ids: ["ItemMortyChip"] }, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 11, reward_bracket_end: 100, base_quantity: 550, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 201, reward_bracket_end: 300, base_quantity: 100, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedSpeed"] } },
            { raid_event_id: "RaidBossKillerAsteroid_2025", reward_bracket_start: 501, reward_bracket_end: 750, base_quantity: 37, base_type: "COIN", base_parameters: null, bonus_quantity: 1, bonus_type: "ITEM", bonus_parameters: { ids: ["ItemMegaSeedDefence"] } }
        ]
    };

    // 3. Stringify data explicitly to construct a reliable hash fingerprint
    const responseString = JSON.stringify(rewardsData);
    const etagHash = crypto.createHash('md5').update(responseString).digest('hex');
    res.setHeader('ETag', `W/"${etagHash}"`);

    // 4. Send raw text stream directly down the wire
    return res.send(responseString);
});

// -------------------- RAID BOSS / EVENT LEADERBOARD --------------------
app.post('/shard/scores', async (req, res) => {
    // Set matching production compliance headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    // Safely pull session context from payload if present to flag the request's active player
    const requestSessionId = req.body.session_id ? String(req.body.session_id) : "";

    try {
        // 1. Identify who is requesting the leaderboard to accurately flag "is_player": "true"
        let requestingPlayerId = null;
        if (requestSessionId !== "") {
            const [authRows] = await pool.execute(
                "SELECT player_id FROM users WHERE session_id = ? LIMIT 1",
                [requestSessionId]
            );
            if (authRows.length) {
                requestingPlayerId = String(authRows[0].player_id);
            }
        }

        // 2. Query the scoreboard table or users table ordered by your leaderboard score metric
        // Replace 'raid_score' or 'level' with whatever column tracks your event ranking metric
        const [leaderboardRows] = await pool.execute(`
            SELECT player_id, username, player_avatar_id, COALESCE(raid_score, 0) AS event_score 
            FROM users 
            ORDER BY event_score DESC, player_id ASC 
            LIMIT 100
        `);

        const results = [];
        let runningRank = 1;

        // 3. Formulate the rank slots dynamically keeping structural compliance
        for (const row of leaderboardRows) {
            const rowPlayerId = String(row.player_id);
            const isCurrentPlayer = (requestingPlayerId !== null && rowPlayerId === requestingPlayerId);

            results.push({
                rank_id: String(runningRank),
                username: row.username || "Player",
                avatar: row.player_avatar_id || "AvatarRickDefault",
                score: parseInt(row.event_score, 10),
                is_player: isCurrentPlayer ? "true" : "false" // Matches expected strict string representation
            });

            runningRank++;
        }

        // 4. Construct the precise payload wrapper structure
        const responseData = {
            event_id: req.body.event_id || "RaidBossKillerAsteroid_2025",
            results: results
        };

        // 5. Generate matching ETag hashes for mobile engine local-state catching checks
        const responseString = JSON.stringify(responseData);
        const etagHash = crypto.createHash('md5').update(responseString).digest('hex');
        res.setHeader('ETag', `W/"${etagHash}"`);

        return res.send(responseString);

    } catch (err) {
        console.error(">>> [RAID LEADERBOARD CRITICAL ERROR]:", err);
        return res.status(500).json({
            error: { code: "SERVER_ERROR", message: err.message }
        });
    }
});

// -------------------- INITIATE WILD MORTY BATTLE (PvWM) --------------------
// Helper functions (assuming defined in scope)
const parseIdList = (str) => String(str || "").split(',').map(id => id.trim()).filter(Boolean);
const toBool = (val) => val === true || val === 1 || String(val).toLowerCase() === 'true';

app.post('/session/battle-wild-morty', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sessionId = req.body.session_id ? String(req.body.session_id) : "";
    const wildMortyIdInput = req.body.wild_morty_id ? String(req.body.wild_morty_id) : "";

    if (!sessionId || !wildMortyIdInput) {
        return res.status(400).json({ success: false, error: "Missing session_id or wild_morty_id" });
    }

    try {
        // 1. Resolve active user session context
        const [userRows] = await pool.execute(
            "SELECT player_id, room_id FROM users WHERE session_id = ? LIMIT 1",
            [sessionId]
        );
        if (!userRows.length) {
            return res.status(401).json({ success: false, error: "Not authenticated" });
        }

        const playerId = String(userRows[0].player_id);
        const roomId = String(userRows[0].room_id || "");

        if (!roomId || roomId === "0") {
            return res.status(409).json({ success: false, error: "Player is not in a room" });
        }

        // 2. Validate targeted room container instance
        const [roomRows] = await pool.execute(
            "SELECT 1 FROM room_ids WHERE room_id = ? LIMIT 1",
            [roomId]
        );
        if (!roomRows.length) {
            return res.status(409).json({ success: false, error: "Room does not exist", room_id: roomId });
        }

        // 3. Extract the wild entity target instance from the event queue log map
        const [wildRows] = await pool.execute(`
            SELECT wild_morty_id, morty_id, placement, state, division, variant, shiny_if_potion 
            FROM event_queue 
            WHERE room_id = ? 
              AND event_name = 'room:wild-morty-added' 
              AND wild_morty_id = ? 
            ORDER BY id DESC LIMIT 1
        `, [roomId, wildMortyIdInput]);

        if (!wildRows.length) {
            return res.status(409).json({ success: false, error: "Morty does not exist" });
        }

        const wildPayload = wildRows[0];
        const extractedMortyTemplateId = wildPayload.morty_id;

        // 4. Gather full target player information parameters
        const [playerRows] = await pool.execute(`
            SELECT player_id, username, player_avatar_id, level, xp, streak, coins, coupons, permits, xp_lower, xp_upper, active_deck_id 
            FROM users WHERE player_id = ? LIMIT 1
        `, [playerId]);

        if (!playerRows.length) {
            return res.status(404).json({ success: false, error: "Player not found" });
        }
        const playerRow = playerRows[0];

        // 5. Decode user active party structures to parse active deck configuration
        let deckMortyIds = [];
        const activeDeckId = String(playerRow.active_deck_id || "");

        if (activeDeckId && activeDeckId !== "0") {
            const [deckRows] = await pool.execute(
                "SELECT owned_morty_ids FROM decks WHERE deck_id = ? LIMIT 1",
                [activeDeckId]
            );
            if (deckRows.length && deckRows[0].owned_morty_ids) {
                deckMortyIds = parseIdList(deckRows[0].owned_morty_ids);
            }
        }

        // 6. Gather collection map arrays of owned sub-assets
        const [ownedMortiesRows] = await pool.execute(`
            SELECT owned_morty_id, morty_id, level, xp, hp, variant, hp_stat, xp_lower, xp_upper, is_locked, is_trading_locked 
            FROM owned_morties WHERE player_id = ? ORDER BY created_at ASC
        `, [playerId]);

        if (!ownedMortiesRows.length) {
            return res.status(400).json({ success: false, error: "Player has no owned Morties" });
        }

        // Fallback: If no custom deck is set or found, use the first owned Morty as team baseline
        if (deckMortyIds.length === 0) {
            deckMortyIds = [ownedMortiesRows[0].owned_morty_id];
        }

        // Compile attack profiles map grouped by owned instances
        const attacksByOwnedMorty = {};
        const ownedMortyIds = ownedMortiesRows.map(m => m.owned_morty_id);
        const placeholders = ownedMortyIds.map(() => '?').join(',');
        
        const [attackRows] = await pool.execute(`
            SELECT owned_morty_id, attack_id, position, pp, pp_stat 
            FROM owned_attacks 
            WHERE owned_morty_id IN (${placeholders}) 
            ORDER BY owned_morty_id ASC, position ASC
        `, ownedMortyIds);

        for (const a of attackRows) {
            const oid = a.owned_morty_id;
            if (!attacksByOwnedMorty[oid]) attacksByOwnedMorty[oid] = [];
            attacksByOwnedMorty[oid].push({
                attack_id: a.attack_id,
                position: parseInt(a.position, 10),
                pp: parseInt(a.pp, 10),
                pp_stat: parseInt(a.pp_stat, 10)
            });
        }

        // 7. Establish the lead living fighter index
        let activeOwnedMorty = "";
        for (const oid of deckMortyIds) {
            const matchedMorty = ownedMortiesRows.find(m => m.owned_morty_id === oid);
            if (matchedMorty && parseInt(matchedMorty.hp, 10) > 0) {
                activeOwnedMorty = oid;
                break;
            }
        }
        // Last-resort fallback if everything is fainted, take first deck element
        if (!activeOwnedMorty && deckMortyIds.length > 0) {
            activeOwnedMorty = deckMortyIds[0];
        }

        // 8. Assemble active battle configuration team array payload
        const ownedMortiesPayloadArray = [];
        const deckMortyMap = new Set(deckMortyIds);

        for (const m of ownedMortiesRows) {
            if (!deckMortyMap.has(m.owned_morty_id)) continue;
            const oid = m.owned_morty_id;
            ownedMortiesPayloadArray.push({
                owned_morty_id: oid,
                morty_id: m.morty_id,
                level: parseInt(m.level, 10),
                xp_lower: parseInt(m.xp_lower || 0, 10),
                xp_upper: parseInt(m.xp_upper || 0, 10),
                xp: parseInt(m.xp, 10),
                hp: parseInt(m.hp, 10),
                variant: m.variant,
                hp_stat: parseInt(m.hp_stat, 10),
                is_locked: toBool(m.is_locked),
                is_trading_locked: toBool(m.is_trading_locked),
                owned_attacks: attacksByOwnedMorty[oid] || []
            });
        }

        // 9. Fetch user item inventory metrics
        const [itemRows] = await pool.execute(
            "SELECT item_id, quantity FROM owned_items WHERE player_id = ? ORDER BY item_id ASC",
            [playerId]
        );
        const ownedItems = itemRows.map(it => ({
            item_id: String(it.item_id),
            quantity: parseInt(it.quantity, 10)
        }));

        // 10. Build complex structured payloads matching client mapping demands
        const moveLog = {
            cooldown: {},
            count: {},
            cooldown_next: { ITEM: 1 },
            last_move_type: {}
        };

        const playerPayload = {
            player_id: playerRow.player_id,
            username: playerRow.username,
            player_avatar_id: playerRow.player_avatar_id,
            level: parseInt(playerRow.level, 10),
            xp: parseInt(playerRow.xp, 10),
            streak: parseInt(playerRow.streak, 10),
            coins: parseInt(playerRow.coins, 10),
            coupons: parseInt(playerRow.coupons, 10),
            permits: parseInt(playerRow.permits, 10),
            owned_morties: ownedMortiesPayloadArray,
            owned_items: ownedItems,
            tags: [],
            xp_lower: parseInt(playerRow.xp_lower || 0, 10),
            xp_upper: parseInt(playerRow.xp_upper || 0, 10),
            _meta: { session_id: sessionId, isPlayerInDB: true, isControlledByAI: false, isRaidBoss: false },
            active_owned_morty: activeOwnedMorty,
            move_log: moveLog
        };

        const wildOwnedPlayerId = crypto.randomUUID();
        const opponentHP = 20; // Explicit structural logic assignment matches source

        const opponentPayload = {
            player_id: wildOwnedPlayerId,
            username: "AWILDMORTY",
            player_avatar_id: "NOAVATAR",
            owned_morties: [{
                owned_morty_id: wildMortyIdInput,
                morty_id: extractedMortyTemplateId,
                level: 5,
                xp: 5,
                hp: opponentHP,
                variant: wildPayload.variant || "Normal",
                hp_stat: opponentHP
            }],
            streak: 0,
            shiny_if_potion: toBool(wildPayload.shiny_if_potion || false),
            _meta: { isPlayerInDB: false, isControlledByAI: true, isRaidBoss: false },
            active_owned_morty: wildMortyIdInput
        };

        // 11. Extract metadata and write state record into the battles engine tracker table
        const battleId = crypto.randomUUID();
        const opponentActiveMortyId = opponentPayload.active_owned_morty;
        const opponentMortyTemplateId = opponentPayload.owned_morties[0].morty_id;
        const opponentHpValue = opponentPayload.owned_morties[0].hp;

        const playerActiveMortyId = activeOwnedMorty;
        const matchedActiveMorty = ownedMortiesPayloadArray.find(m => m.owned_morty_id === activeOwnedMorty);
        const playerHpValue = matchedActiveMorty ? matchedActiveMorty.hp : 0;

        await pool.execute(`
            INSERT INTO battles (
                battle_id, player_id, opponent_id, wild_morty_id, 
                opponent_active_morty, opponent_morty_id, opponent_hp, 
                player_active_morty, player_hp, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW())
        `, [
            battleId, playerId, wildOwnedPlayerId, extractedMortyTemplateId,
            opponentActiveMortyId, opponentMortyTemplateId, opponentHpValue,
            playerActiveMortyId, playerHpValue
        ]);

        // 12. Broadcast operational synchronization signals to SSE lines
        const finalBroadcastPayload = {
            battle_id: battleId,
            battle_type: "PvWM",
            player: playerPayload,
            opponent: opponentPayload,
            meta: {}
        };
        
        await publishEvent(roomId, "battle:start", finalBroadcastPayload, playerId);
        await publishEvent(roomId, "room:wild-morty-state-changed", { wild_morty_id: wildMortyIdInput, state: "BATTLE" });
        //await publishEvent(roomId, "room:user-state-changed", { player_id: playerId, state: "BATTLE" });

        return res.json({ success: true });

    } catch (err) {
        console.error(">>> [WILD MORTY BATTLE INITIATION CRITICAL ERROR]:", err);
        return res.status(500).json({ success: false, error: "Server error", detail: err.message });
    }
});

// ============================================================================
// ⏱️ BATTLE READY & INITIALIZATION
// ============================================================================
app.post('/session/battle/ready', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sessionId = req.body.session_id ? String(req.body.session_id) : "";
    const battleId  = req.body.battle_id ? String(req.body.battle_id) : "";

    if (!sessionId || !battleId) {
        return res.status(400).json({ success: false, error: "Missing session_id or battle_id" });
    }

    try {
        // 1. Authenticate user context via session
        const [userRows] = await pool.execute(
            "SELECT player_id, room_id FROM users WHERE session_id = ? LIMIT 1",
            [sessionId]
        );
        if (!userRows.length) {
            return res.status(401).json({ success: false, error: "Not authenticated" });
        }

        const playerId = String(userRows[0].player_id);
        const roomId   = String(userRows[0].room_id || "");

        if (!roomId || roomId === "0") {
            return res.status(409).json({ success: false, error: "Player is not in a room" });
        }

        // 2. Verify targeted room instance exists
        const [roomRows] = await pool.execute(
            "SELECT 1 FROM room_ids WHERE room_id = ? LIMIT 1",
            [roomId]
        );
        if (!roomRows.length) {
            return res.status(409).json({ success: false, error: "Room does not exist", room_id: roomId });
        }
		
		await publishEvent(roomId, "room:user-state-changed", { player_id: playerId, state: "BATTLE" });

        // 4. Construct payload tracking the specific battle details
        const battlePayload = {
            battle_id: battleId,
            timeout: 30
        };

        // 6. Broadcast the clock frame to kick off the client UI clock tracking 
        await publishEvent(roomId, "battle:move-timer-started", battlePayload, playerId);

        return res.json({ success: true });

    } catch (err) {
        console.error(">>> [BATTLE INITIALIZE CRITICAL FAILURE]:", err);
        return res.status(500).json({ success: false, error: "Server error", detail: err.message });
    }
});

// ============================================================================
// ⚔️ ROUTE: PROCESS BATTLE TURN ACTION
// ============================================================================
app.post('/session/battle/move', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    // ========================
    // INPUT VALIDATION
    // ========================
    const sessionId    = req.body.session_id ? String(req.body.session_id) : "";
    const battleId     = req.body.battle_id ? String(req.body.battle_id) : "";
    const type         = req.body.type ? String(req.body.type) : "";
    const ownedMortyId = req.body.owned_morty_id ? String(req.body.owned_morty_id) : "";
    const moveId       = req.body.move_id ? String(req.body.move_id) : "";

    if (!sessionId || !battleId || !type) {
        return res.status(400).json({ success: false });
    }

    try {
        // ========================
        // PLAYER LOOKUP
        // ========================
        const [userRows] = await pool.execute(
            "SELECT player_id, room_id FROM users WHERE session_id = ? LIMIT 1",
            [sessionId]
        );
        if (!userRows.length) {
            return res.status(401).json({ success: false });
        }

        const playerId = userRows[0].player_id;
        const roomId   = userRows[0].room_id;

        // ========================
        // GET BATTLE STATE
        // ========================
        const [battleRows] = await pool.execute(
            "SELECT * FROM battles WHERE battle_id = ? LIMIT 1",
            [battleId]
        );
        if (!battleRows.length) {
            return res.json({ success: false });
        }
        const battle = battleRows[0];

        // ========================
        // HELPERS
        // ========================
        const getAiMove = () => {
            const moves = ["AttackBatteringRam", "AttackVileSpew"];
            return moves[Math.floor(Math.random() * moves.length)];
        };

        // ========================
        // TURN LOGIC ENGINE
        // ========================
        let outcome = "CONTINUE";
        let turnDatas = [];
        let xpDatas = [];

        let playerHp = battle.player_hp !== undefined ? Number(battle.player_hp) : 0;
        let enemyHp  = battle.opponent_hp !== undefined ? Number(battle.opponent_hp) : 0;

        const aiMove = getAiMove();

        // ------------------------
        // CASE A: ITEM (CATCH)
        // ------------------------
        if (type === "ITEM" && moveId === "ItemMortyChip") {
            const success = (Math.floor(Math.random() * 100) + 1) > 40;

            const opponentId = battle.opponent_id;
            const wildOwnedMortyId = battle.opponent_active_morty;
            const wildMortyId = battle.wild_morty_id || "UnknownMorty";

            // Optional item decrement query omitted matching your comment layout

            // Retrieve updated item configuration
            const [itemRows] = await pool.execute(
                "SELECT quantity FROM owned_items WHERE player_id = ? AND item_id = 'ItemMortyChip'",
                [playerId]
            );
            const remaining = itemRows.length ? Number(itemRows[0].quantity || 0) : 0;

            turnDatas.push({
                type: "ITEM",
                attacker_player_id: playerId,
                defender_player_id: opponentId,
                item_id: "ItemMortyChip",
                owned_morty_id: wildOwnedMortyId,
                success: success
            });

            if (success) {
                outcome = "CAUGHT";
                const newOwnedMortyId = crypto.randomUUID();

                const newMorty = {
                    owned_morty_id: newOwnedMortyId,
                    player_id: playerId,
                    morty_id: wildMortyId,
                    level: Math.floor(Math.random() * (50 - 30 + 1)) + 30,
                    xp: Math.floor(Math.random() * (90000 - 50000 + 1)) + 50000,
                    hp: Math.floor(Math.random() * (150 - 100 + 1)) + 100,
                    hp_stat: Math.floor(Math.random() * (150 - 100 + 1)) + 100,
                    attack_stat: Math.floor(Math.random() * (90 - 60 + 1)) + 60,
                    defence_stat: Math.floor(Math.random() * (90 - 60 + 1)) + 60,
                    speed_stat: Math.floor(Math.random() * (90 - 60 + 1)) + 60,
                    variant: "Normal",
                    owned_attacks: [
                        { attack_id: "AttackFanArt", pp: 5, position: 0 },
                        { attack_id: "AttackWetTongue", pp: 5, position: 1 },
                        { attack_id: "AttackScratchAndSniff", pp: 5, position: 2 },
                        { attack_id: "AttackLick", pp: 18, position: 3 }
                    ]
                };

                await publishEvent(roomId, "battle:turn-result", {
                    battle_id: battleId,
                    outcome: "CAUGHT",
                    turn_datas: turnDatas,
                    player_datas: {
                        player: {
                            owned_items: [
                                { item_id: "ItemMortyChip", quantity: remaining }
                            ],
                            rewards: [
                                {
                                    type: "MORTY",
                                    morty_id: wildMortyId,
                                    level: newMorty.level,
                                    added_to_active_deck: true,
                                    owned_morty_limit_reached: false,
                                    variant: "Normal",
                                    owned_morty: newMorty
                                }
                            ],
                            attacks_to_learn: [],
                            move_log: {
                                cooldown: { ATTACK: 0, ITEM: 1 },
                                count: { ATTACK: 1, ITEM: 1 },
                                cooldown_next: { ITEM: 2 },
                                last_move_type: "ITEM"
                            }
                        },
                        opponent: {}
                    }
                }, playerId);

                // Side effects run sequentially at block terminal boundary
            }
        }

        // ------------------------
        // CASE B: ATTACK ACTION
        // ------------------------
        if (type === "ATTACK") {
            const playerDamage = 20; // Fixed rand(20, 20)
            const aiDamage     = Math.floor(Math.random() * (3 - 1 + 1)) + 1;

            const enemyHpAfter  = Math.max(enemyHp - playerDamage, 0);
            const playerHpAfter = Math.max(playerHp - aiDamage, 0);

            // Step 1: Push Player Turn Event Sequence
            turnDatas.push({
                type: "ATTACK",
                attacker_player_id: playerId,
                defender_player_id: battle.opponent_id,
                attack_id: moveId,
                element_modifier: 1,
                effect_datas: [{
                    type: "Hit",
                    is_accurate: true,
                    to_self: false,
                    continue_on_miss: false,
                    is_critical: false,
                    damage: playerDamage,
                    defender_morty_datas: [{
                        owned_morty_id: battle.opponent_active_morty,
                        hp: enemyHpAfter
                    }]
                }],
                attacker_morty_datas: [{
                    owned_morty_id: ownedMortyId,
                    owned_attacks: [{
                        attack_id: moveId,
                        pp: Math.floor(Math.random() * 5) + 1
                    }]
                }]
            });

            enemyHp = enemyHpAfter;

            // Step 2: Validate Target State Prior to Counteraction
            if (enemyHp > 0) {
                turnDatas.push({
                    type: "ATTACK",
                    attacker_player_id: battle.opponent_id,
                    defender_player_id: playerId,
                    attack_id: aiMove,
                    element_modifier: 1,
                    effect_datas: [
                        {
                            type: "Hit",
                            is_accurate: true,
                            to_self: false,
                            continue_on_miss: false,
                            is_critical: false,
                            damage: aiDamage,
                            defender_morty_datas: [{
                                owned_morty_id: ownedMortyId,
                                hp: playerHpAfter
                            }]
                        }
                    ],
                    attacker_morty_datas: [{
                        owned_morty_id: battle.opponent_active_morty,
                        owned_attacks: [{
                            attack_id: aiMove,
                            pp: 1
                        }]
                    }]
                });

                playerHp = playerHpAfter;
                if (playerHp <= 0) {
                    outcome = "LOSE";
                }
            } else {
                // Enemy eliminated -> Process Victory Calculation
                outcome = "WIN";
                const xpEarned = 10;
                const currentXpEarned = 100;
                const updateTotalXp = currentXpEarned + xpEarned;
                const xpLower = 100;
                const updateXpLower = xpLower + xpEarned;

                xpDatas = [{
                    owned_morty_id: ownedMortyId,
                    xp_earned: xpEarned,
                    owned_morty_datas: [{
                        level: 5,
                        xp: updateTotalXp,
                        hp: 20,
                        hp_stat: 20,
                        attack_stat: 11,
                        defence_stat: 10,
                        speed_stat: 10,
                        variant: "Normal",
                        xp_lower: updateXpLower,
                        xp_upper: 225
                    }]
                }];
            }
        }

        // ========================
        // COMMIT STATE TO STORAGE
        // ========================
        await pool.execute(
            "UPDATE battles SET player_hp = ?, opponent_hp = ? WHERE battle_id = ?",
            [playerHp, enemyHp, battleId]
        );

        // ========================
        // CONDITIONAL EMISSION PIPELINE
        // ========================
        if (type === "RUN") {
            const wildMortyId = battle.opponent_active_morty;
            await publishEvent(roomId, "room:wild-morty-state-changed", { wild_morty_id: wildMortyId, state: "WORLD" });
            await publishEvent(roomId, "room:user-state-changed", { player_id: playerId, state: "WORLD" });
            
            await publishEvent(roomId, "battle:turn-result", {
                battle_id: battleId,
                outcome: "RUN",
                turn_datas: turnDatas,
                player_datas: {
                    player: {
                        attacks_to_learn: [],
                        move_log: {
                            cooldown: { ATTACK: 0, RUN: 0 },
                            count: { ATTACK: turnDatas.length, RUN: 1 },
                            cooldown_next: { ITEM: 1 },
                            last_move_type: type
                        }
                    },
                    opponent: {}
                },
                battle_abandoned: true
            }, playerId);

        } else {
            if (outcome === "WIN") {
                const wildMortyId = battle.opponent_active_morty;
                await publishEvent(roomId, "room:wild-morty-state-changed", { wild_morty_id: wildMortyId, state: "WORLD" });
                await publishEvent(roomId, "room:user-state-changed", { player_id: playerId, state: "WORLD" });

                await publishEvent(roomId, "battle:turn-result", {
                    battle_id: battleId,
                    outcome: "WIN",
                    turn_datas: turnDatas,
                    player_datas: {
                        player: {
							"player_xp_datas":{
							"streak":1,"streak_old":0,"xp_earned":50,"xp_multiplier":1,
							"player_datas":[
							    {
								    "level":1,
								    "xp":50,
								    "xp_lower":27,
								    "xp_upper":64
							    }
							]},
                            xp_datas: xpDatas,
                            rewards: [
                                {
                                    type: "ITEM",
                                    item_id: "ItemCircuitBoard",
                                    quantity: 10,
                                    amount_received: 0,
                                    amount: 1
                                }
                            ],
                            attacks_to_learn: [],
                            move_log: {
                                cooldown: { ATTACK: 0 },
                                count: { ATTACK: turnDatas.length },
                                cooldown_next: { ITEM: 1 },
                                last_move_type: type
                            },
                        },
                        opponent: {}
                    }
                }, playerId);
			

            } else if (outcome !== "CAUGHT") {
                // Evaluates for standard CONTINUE status updates
                await publishEvent(roomId, "battle:turn-result", {
                    battle_id: battleId,
                    outcome: outcome,
                    turn_datas: turnDatas,
                    player_datas: {
                        player: {
                            move_log: {
                                cooldown: { ATTACK: 0 },
                                count: { ATTACK: turnDatas.length },
                                cooldown_next: { ITEM: 1 },
                                last_move_type: type
                            }
                        },
                        opponent: {}
                    }
                }, playerId);
            }
        }

        // Post-Turn Cleanups for absolute resolution shifts (Lose / Caught)
        if (outcome === "LOSE" || outcome === "CAUGHT") {
            const wildMortyId = battle.opponent_active_morty;
            await publishEvent(roomId, "room:wild-morty-state-changed", { wild_morty_id: wildMortyId, state: "WORLD" });
            await publishEvent(roomId, "room:user-state-changed", { player_id: playerId, state: "WORLD" });
        }

        // ========================
        // FINAL COMPONENT RESPONSE
        // ========================
        return res.json({ success: true });

    } catch (err) {
        console.error(">>> [CRITICAL REEVALUATION ROUTE FAILURE]:", err);
        return res.status(500).json({ success: false });
    }
});

// ============================================================================
// 🗺️ ROUTE: GET ROOM DETAILS & SYNCHRONIZE OVERWORLD ENTITIES
// ============================================================================
app.post('/session/room-details', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const sessionId = req.body.session_id ? String(req.body.session_id) : "";
    if (!sessionId) {
        return res.json({ error: "Missing session_id" });
    }

    // Helper to generate ISO8601 strings with forced Z signature
    const iso8601Z = (dateInput) => {
        const d = dateInput ? new Date(dateInput) : new Date();
        return d.toISOString();
    };

    try {
        // --------------------------------------------------------------------
        // 1. Resolve requesting player context
        // --------------------------------------------------------------------
        const [selfRows] = await pool.execute(`
            SELECT player_id, room_id 
            FROM users 
            WHERE session_id = ? 
            LIMIT 1
        `, [sessionId]);

        if (!selfRows.length) {
            return res.json({ error: "Invalid session" });
        }

        const roomId = selfRows[0].room_id;

        // --------------------------------------------------------------------
        // 2. Room metadata extraction
        // --------------------------------------------------------------------
        const [roomRows] = await pool.execute(`
            SELECT * FROM room_ids 
            WHERE room_id = ? 
            LIMIT 1
        `, [roomId]);

        if (!roomRows.length) {
            return res.json({ error: "Room not found" });
        }
        const room = roomRows[0];

        // --------------------------------------------------------------------
        // 3. USERS (Real Players with Flattened Bulk Asset Fetching)
        // --------------------------------------------------------------------
        const [activeUsers] = await pool.execute(`
            SELECT player_id, username, player_avatar_id, level, active_deck_id, state 
            FROM users 
            WHERE room_id = ? 
              AND last_seen >= (NOW() - INTERVAL 5 MINUTE)
        `, [roomId]);

        const usersPayload = [];

        if (activeUsers.length > 0) {
            const playerIds = activeUsers.map(u => u.player_id);
            const activeDeckIds = activeUsers.map(u => u.active_deck_id).filter(id => id && id !== '0');

            // Fetch Decks matching player deck targets in bulk
            let deckMap = {};
            if (activeDeckIds.length > 0) {
                const deckPlaceholders = activeDeckIds.map(() => '?').join(',');
                const [decks] = await pool.execute(`
                    SELECT player_id, deck_id, owned_morty_ids 
                    FROM decks 
                    WHERE deck_id IN (${deckPlaceholders})
                `, activeDeckIds);

                for (const d of decks) {
                    deckMap[`${d.player_id}_${d.deck_id}`] = d.owned_morty_ids;
                }
            }

            // Gather all requested Morty IDs across all active player sets to run a single optimized bulk query
            let allTargetMortyIds = [];
            const userDeckAssignments = activeUsers.map(u => {
                const lookupKey = `${u.player_id}_${u.active_deck_id}`;
                const rawMortyIds = deckMap[lookupKey];
                let parsedIds = [];
                if (rawMortyIds) {
                    try {
                        // Support both raw comma strings or JSON array fallbacks
                        parsedIds = typeof rawMortyIds === 'string' && rawMortyIds.startsWith('[')
                            ? JSON.parse(rawMortyIds)
                            : String(rawMortyIds).split(',').map(id => id.trim()).filter(Boolean);
                    } catch (e) {
                        parsedIds = [];
                    }
                }
                allTargetMortyIds = allTargetMortyIds.concat(parsedIds);
                return { user: u, deckIds: parsedIds };
            });

            // Perform bulk query for morties if target items exist
            let mortiesGlobalMap = {};
            if (allTargetMortyIds.length > 0) {
                const uniqueMortyIds = [...new Set(allTargetMortyIds)];
                const mortyPlaceholders = uniqueMortyIds.map(() => '?').join(',');
                
                const [mortyRows] = await pool.execute(`
                    SELECT player_id, owned_morty_id, morty_id, hp, variant, is_locked, is_trading_locked, fight_pit_id 
                    FROM owned_morties 
                    WHERE owned_morty_id IN (${mortyPlaceholders})
                `, uniqueMortyIds);

                for (const m of mortyRows) {
                    mortiesGlobalMap[m.owned_morty_id] = m;
                }
            }

            // Map and assemble the structural payload for users
            for (const assignment of userDeckAssignments) {
                const u = assignment.user;
                const userOwnedMorties = [];

                for (const targetId of assignment.deckIds) {
                    const m = mortiesGlobalMap[targetId];
                    // Ensure the Morty profile exists and truly belongs to the querying player context
                    if (m && String(m.player_id) === String(u.player_id)) {
                        userOwnedMorties.push({
                            owned_morty_id: m.owned_morty_id,
                            morty_id: m.morty_id,
                            hp: Number(m.hp || 0),
                            variant: m.variant || "Normal",
                            is_locked: m.is_locked === true || m.is_locked === 1,
                            is_trading_locked: m.is_trading_locked === true || m.is_trading_locked === 1,
                            fight_pit_id: m.fight_pit_id && m.fight_pit_id !== "null" ? m.fight_pit_id : null
                        });
                    }
                }
				
				
				let currentPlacement = [30,35];
                const livePos = livePlayerPositions.get(u.player_id);

                if (livePos) { currentPlacement = [livePos.x,livePos.y]; }

                usersPayload.push({
                    player_id: u.player_id,
                    username: u.username,
                    player_avatar_id: u.player_avatar_id,
                    level: Number(u.level || 0),
                    owned_morties: userOwnedMorties,
                    state: u.state || "WORLD",
					"shiny_if_potion": false,
					"streak": u.streak,
					placement: currentPlacement // Handled and overwritten immediately by the active UDP server loop
                });
            }
        }

        // --------------------------------------------------------------------
        // 4. PICKUPS
        // --------------------------------------------------------------------
        const [pickupRows] = await pool.execute(`
            SELECT pickup_id, placement, pick_up_contents 
            FROM event_queue 
            WHERE room_id = ? 
              AND event_name = 'room:pickup-added' 
              AND pickup_id_collected_by_player_id IS NULL
        `, [roomId]);

        const pickupsPayload = [];
        for (const p of pickupRows) {
            const pos = String(p.placement || "").split(',');
            if (pos.length !== 2) continue;

            let contents = [];
            try {
                const parsed = typeof p.pick_up_contents === 'string' 
                    ? JSON.parse(p.pick_up_contents) 
                    : p.pick_up_contents;
                
                if (parsed && typeof parsed === 'object') {
                    contents = Array.isArray(parsed) ? parsed : [parsed];
                }
            } catch (e) {
                contents = [];
            }

            pickupsPayload.push({
                pickup_id: p.pickup_id,
                placement: [Number(pos[0]), Number(pos[1])],
                contents: contents
            });
        }

        // --------------------------------------------------------------------
        // 5. WILD MORTIES
        // --------------------------------------------------------------------
        const [wildRows] = await pool.execute(`
            SELECT wild_morty_id, morty_id, placement, state, division, variant, shiny_if_potion, created_at, updated 
            FROM event_queue 
            WHERE room_id = ? 
              AND event_name = 'room:wild-morty-added'
        `, [roomId]);

        const wildMortiesPayload = [];
        for (const w of wildRows) {
            const pos = String(w.placement || "").split(',');
            if (pos.length !== 2) continue;

            wildMortiesPayload.push({
                morty_id: w.morty_id,
                placement: [Number(pos[0]), Number(pos[1])],
                state: w.state || "WORLD",
                division: Number(w.division || 0),
                variant: w.variant || "Normal",
                shiny_if_potion: w.shiny_if_potion === true || w.shiny_if_potion === 1,
                _created: iso8601Z(w.created_at),
                _updated: iso8601Z(w.updated),
                wild_morty_id: w.wild_morty_id
            });
        }

        // --------------------------------------------------------------------
        // 6. BOTS
        // --------------------------------------------------------------------
        const [botRows] = await pool.execute(`
            SELECT bot_id, username, player_avatar_id, placement, state, division, zone_id, shiny_if_potion, owned_morties 
            FROM event_queue 
            WHERE room_id = ? 
              AND event_name = 'room:bot-added'
        `, [roomId]);

        const botsPayload = [];
        for (const b of botRows) {
            const pos = String(b.placement || "0,0").split(',');
            
            let botMorties = [];
            try {
                botMorties = typeof b.owned_morties === 'string' 
                    ? JSON.parse(b.owned_morties) 
                    : b.owned_morties || [];
            } catch (e) {
                botMorties = [];
            }

            botsPayload.push({
                username: b.username,
                player_avatar_id: b.player_avatar_id,
                state: b.state,
                level: 1,
                owned_morties: botMorties,
                shiny_if_potion: b.shiny_if_potion === true || b.shiny_if_potion === 1,
                streak: 0,
                bot_id: b.bot_id,
                placement: [Number(pos[0] || 0), Number(pos[1] || 0)]
            });
        }

        // --------------------------------------------------------------------
        // 7. baseline_event_id (Calculated but commented out matching source)
        // --------------------------------------------------------------------
        /*
        const [baselineRows] = await pool.execute(`
            SELECT COALESCE(MAX(id), 0) AS max_id 
            FROM event_queue 
            WHERE room_id = ?
        `, [roomId]);
        const baselineEventId = Number(baselineRows[0].max_id || 0);
        */

        // --------------------------------------------------------------------
        // FINAL DISPATCH PIPELINE
        // --------------------------------------------------------------------
        return res.json({
            room_id: room.room_id,
            room_udp_host: room.room_udp_host,
            room_udp_port: String(room.room_udp_port || ""),
            world_id: String(room.world_id || ""),
            zone_id: room.zone_id,
            users: usersPayload,
            pickups: pickupsPayload,
            wild_morties: wildMortiesPayload,
            bots: botsPayload
        });

    } catch (err) {
        console.error(">>> [ROOM DETAILS SYNC CRITICAL EXCEPTION]:", err);
        return res.status(500).json({ error: "Server error", detail: err.message });
    }
});

// -------------------- AnatomyParkFTUE1 --------------------
app.post('/session/battle-custom-battle', async (req, res) => {
    // Match headers from your original PHP script
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : '';
    const dimension_id = req.body.dimension_id ? String(req.body.dimension_id) : '';

    // 1. Validation check
    if (session_id === '' || dimension_id === '') {
        return res.status(400).json({
            error: { code: "BAD_REQUEST" }
        });
    }

    try {
        // Optional: If you need to verify the session exists in the database before processing:
        // await requireUserBySession(session_id);

        return res.json({});

    } catch (err) {
        if (err.statusCode === 401) {
            return res.status(401).json({
                error: { code: "NOT_AUTHENTICATED" }
            });
        }
    }
});

// -------------------- CHECK DIMENSION STATUS / DISPENSE --------------------
app.post('/session/dimensions/check-if-dimension-ftue-rewards-dispensed', async (req, res) => {
    // Match headers from your original PHP script
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : '';
    const dimension_id = req.body.dimension_id ? String(req.body.dimension_id) : '';

    // 1. Validation check
    if (session_id === '' || dimension_id === '') {
        return res.status(400).json({
            error: { code: "BAD_REQUEST" }
        });
    }

    try {
        // Optional: If you need to verify the session exists in the database before processing:
        // await requireUserBySession(session_id);

        // 2. Business logic check for dimension_id '5'
        if (dimension_id === '5') {
            return res.json({
                dispensed: true
            });
        }
        if (dimension_id === '6') {
            return res.json({
                dispensed: true
            });
        }
        if (dimension_id === '7') {
            return res.json({
                dispensed: true
            });
        }

        // 3. Fallback response (matching a blank/null success if conditions aren't met, or append commented rewards if needed)
        // If you ever want to re-enable the commented-out PHP avatar reward block, you would uncomment this:
        /*
        return res.json({
            rewards: [{
                id: "AvatarFrank",
                amount: 1,
                type: "AVATAR",
                player_avatar_id: "AvatarFrank"
            }]
        });
        */

        return res.json({});

    } catch (err) {
        if (err.statusCode === 401) {
            return res.status(401).json({
                error: { code: "NOT_AUTHENTICATED" }
            });
        }
        
        console.error("[Dimensions Dispense API] Server Error:", err.message);
        return res.status(500).json({
            error: { code: "SERVER_ERROR" }
        });
    }
});

// -------------------- DISPENSE --------------------
app.post('/session/dimensions/dispense-dimension-ftue-rewards', async (req, res) => {
    // Match headers from your original PHP script
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : '';
    const dimension_id = req.body.dimension_id ? String(req.body.dimension_id) : '';

    // 1. Validation check
    if (session_id === '' || dimension_id === '') {
        return res.status(400).json({
            error: { code: "BAD_REQUEST" }
        });
    }

    try {
        // Optional: If you need to verify the session exists in the database before processing:
        // await requireUserBySession(session_id);

        // 2. Business logic check for dimension_id '5'
        if (dimension_id === '5') {
            return res.json({
                dispensed: true
            });
        }
        if (dimension_id === '6') {
            return res.json({
                dispensed: true
            });
        }
        if (dimension_id === '7') {
        return res.json({
            rewards: [{
                id: "AvatarFrank",
                amount: 1,
                type: "AVATAR",
                player_avatar_id: "AvatarFrank"
            }]
        });
        }

        // 3. Fallback response (matching a blank/null success if conditions aren't met, or append commented rewards if needed)
        // If you ever want to re-enable the commented-out PHP avatar reward block, you would uncomment this:
        /*
        return res.json({
            rewards: [{
                id: "AvatarFrank",
                amount: 1,
                type: "AVATAR",
                player_avatar_id: "AvatarFrank"
            }]
        });
        */

        return res.json({});

    } catch (err) {
        if (err.statusCode === 401) {
            return res.status(401).json({
                error: { code: "NOT_AUTHENTICATED" }
            });
        }
        
        console.error("[Dimensions Dispense API] Server Error:", err.message);
        return res.status(500).json({
            error: { code: "SERVER_ERROR" }
        });
    }
});
// Replaces: function getUserIP()
function getUserIP(req) {
    if (req.headers['cf-connecting-ip']) {
        return req.headers['cf-connecting-ip'];
    }
    if (req.headers['x-forwarded-for']) {
        return req.headers['x-forwarded-for'].split(',')[0].trim();
    }
    return req.socket.remoteAddress;
}

// Replaces: function uuidv4()
function uuidv4() {
    return crypto.randomUUID();
}

// Helper to generate md5 hashes for ETags matching PHP's md5()
function generateMd5(content) {
    return crypto.createHash('md5').update(content).digest('hex');
}
// --------------------------------------------------------------------
// REGISTER / AUTH ENTRANCE ENDPOINT
// --------------------------------------------------------------------
app.post('/user/register', async (req, res) => {
    const ip = getUserIP(req);
    const data = req.body;

    // Verify input frame presence (Replaces input parsing checks)
    if (!data || Object.keys(data).length === 0) {
        return res.status(400).json({ error: 'No input received' });
    }

    const username = data.username ?? null;

    if (!username) {
        return res.status(400).json({
            error: { code: "USERNAME_MISSING" }
        });
    }

    let connection;
    try {
        connection = await pool.getConnection();

        // Check if a recovery code layout entry profile exists
        // Replaces: SELECT id, recovery_code_hash FROM users LIMIT 1
        const [usersLimit] = await connection.execute('SELECT id, player_id, secret, recovery_code_hash FROM users LIMIT 1');
        const firstUser = usersLimit[0];

        // ----------------------------------------------------------------
        // CONDITIONAL FLOW A: RECOVERY AUTHENTICATION PATTERN
        // ----------------------------------------------------------------
        if (firstUser && firstUser.recovery_code_hash && await bcrypt.compare(username, firstUser.recovery_code_hash)) {
            const code = firstUser.recovery_code_hash;
            
            // Replaces recovery profile targeting execution block
            const [matchedUsers] = await connection.execute('SELECT * FROM users WHERE recovery_code_hash = ?', [code]);
            const targetUser = matchedUsers[0];

            const responsePayload = JSON.stringify({ secret: targetUser.secret });
            const etag = `W/"${generateMd5(responsePayload)}"`;
            
            res.setHeader('ETag', etag);
            return res.send(responsePayload);
        }

        // ----------------------------------------------------------------
        // CONDITIONAL FLOW B: REGISTRATION PATTERN
        // ----------------------------------------------------------------
        // Replaces character filtering layout regex
        if (!/^[a-zA-Z0-9_]+$/.test(username)) {
            return res.status(400).json({
                error: { code: "USERNAME_INVALID" }
            });
        }

        // Check if username exists
        const [userCheck] = await connection.execute('SELECT 1 FROM users WHERE username = ?', [username]);
        if (userCheck.length > 0) {
            return res.status(400).json({
                error: { code: "USERNAME_DUPLICATE" }
            });
        }

        const player_avatar_ids = data.player_avatar_ids || [];
        const avatar = player_avatar_ids[0] || null;
        const avatarJson = JSON.stringify(player_avatar_ids);
        
        const secret = uuidv4();
        let player_id = uuidv4();
        const owned_morty_id = uuidv4();
        const owned_morty_idJson = JSON.stringify([owned_morty_id]);

        let success = false;
        
        // Emulate the loop tracking transactional retries for safety collision exceptions
        do {
            try {
                await connection.beginTransaction();

                // stmt_1: Insert user account baseline profile
                await connection.execute(`
                    INSERT INTO users (secret, player_id, username, player_avatar_id, level, xp, streak, active_deck_id, decks_owned, tags, xp_lower, xp_upper, created_with_ip)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [secret, player_id, username, avatar, '1', '27', '0', '0', '3', '[]', '27', '64', ip]);

                // stmt_2: Map starting deck index structure
                await connection.execute(`
                    INSERT INTO decks (player_id, deck_id, owned_morty_ids)
                    VALUES (?, ?, ?)
                `, [player_id, '0', owned_morty_idJson]);

                // stmt_3: Assign items inventory slots
                await connection.execute('INSERT INTO owned_items (player_id, item_id, quantity) VALUES (?, ?, ?)', [player_id, 'ItemMortyChip', '1']);
                await connection.execute('INSERT INTO owned_items (player_id, item_id, quantity) VALUES (?, ?, ?)', [player_id, 'ItemSerum', '1']);

                // stmt_4: Append owned avatars arrays
                await connection.execute('INSERT INTO owned_avatars (player_id, player_avatar_id) VALUES (?, ?)', [player_id, avatarJson]);

                // stmt_5: Document MortyDex capture reference
                await connection.execute('INSERT INTO mortydex (player_id, morty_id, caught) VALUES (?, ?, ?)', [player_id, 'MortyDefault', 'true']);

                // stmt_6: Generate first default Morty assignment context
                await connection.execute(`
                    INSERT INTO owned_morties (player_id, owned_morty_id, morty_id, level, xp, hp, hp_stat, attack_stat, defence_stat, variant, speed_stat, is_locked, is_trading_locked, fight_pit_id, evolution_points, xp_lower, xp_upper)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [player_id, owned_morty_id, 'MortyDefault', '5', '125', '20', '20', '11', '10', 'Normal', '10', '0', 'false', 'null', '0', '125', '216']);

                // stmt_7: Inject standard attack patterns mapped mapping context execution
                await connection.execute(`
                    INSERT INTO owned_attacks (owned_morty_id, attack_id, position, pp, pp_stat)
                    VALUES (?, ?, ?, ?, ?)
                `, [owned_morty_id, 'AttackOutburst', '0', '12', '12']);

                await connection.commit();
                success = true;
            } catch (err) {
                await connection.rollback();
                // Check for MySQL target collision keys error code (Duplicate entry)
                if (err.code === 'ER_DUP_ENTRY' || err.errno === 1062) {
                    // Regenerate matching identification tracking seeds on collision
                    player_id = uuidv4();
                    success = false;
                } else {
                    throw err; // Escalate non-duplicate database failures
                }
            }
        } while (!success);

        // ----------------------------------------------------------------
        // COLLECT REGISTRATION DATA FOR THE OUTPUT RESPONSE
        // ----------------------------------------------------------------
        const [userRows] = await connection.execute('SELECT * FROM users WHERE player_id = ?', [player_id]);
        const user = userRows[0];

        const [mortyRows] = await connection.execute('SELECT * FROM owned_morties WHERE player_id = ?', [player_id]);
        
        // Dynamically bundle child attack listings into each extracted array
        for (let morty of mortyRows) {
            const [attackRows] = await connection.execute(
                'SELECT attack_id, position, pp, pp_stat FROM owned_attacks WHERE owned_morty_id = ?',
                [morty.owned_morty_id]
            );
            morty.owned_attacks = attackRows;
        }

        const [deckRows] = await connection.execute('SELECT deck_id, owned_morty_ids FROM decks WHERE player_id = ?', [player_id]);
        for (let deck of deckRows) {
            if (typeof deck.owned_morty_ids === 'string' && deck.owned_morty_ids.startsWith('[')) {
                deck.owned_morty_ids = JSON.parse(deck.owned_morty_ids);
            } else {
                deck.owned_morty_ids = [deck.owned_morty_ids];
            }
        }

        const [itemRows] = await connection.execute('SELECT item_id, quantity FROM owned_items WHERE player_id = ?', [player_id]);
        const [mortydexRows] = await connection.execute('SELECT morty_id, caught FROM mortydex WHERE player_id = ?', [player_id]);
        
        const [avatarRows] = await connection.execute('SELECT player_avatar_id FROM owned_avatars WHERE player_id = ?', [player_id]);
        let avatars = [];
        if (avatarRows.length > 0 && avatarRows[0].player_avatar_id) {
            avatars = JSON.parse(avatarRows[0].player_avatar_id);
        }

        // Return structured JSON data payload matching explicit casting variables
        const finalPayload = JSON.stringify({
            player_id: user.player_id,
            username: user.username,
            player_avatar_ids: avatars,
            level: Number(user.level),
            xp: Number(user.xp),
            streak: Number(user.streak),
            owned_morties: mortyRows,
            active_deck_id: Number(user.active_deck_id),
            decks_owned: Number(user.decks_owned),
            decks: deckRows,
            owned_items: itemRows,
            mortydex: mortydexRows,
            tags: typeof user.tags === 'string' ? JSON.parse(user.tags) : user.tags,
            xp_lower: Number(user.xp_lower),
            xp_upper: Number(user.xp_upper),
            secret: user.secret
        });

        const finalEtag = `W/"${generateMd5(finalPayload)}"`;
        res.setHeader('ETag', finalEtag);
        return res.send(finalPayload);

    } catch (globalError) {
        console.error("Pipeline Runtime Exception:", globalError);
        return res.status(500).json({ error: "Internal Server Error" });
    } finally {
        if (connection) connection.release();
    }
});

// -------------------- dispense-item --------------------
app.post('/session/dispense-item', async (req, res) => {
    // Match the headers from your PHP script
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : '';
    const item_id = req.body.item_id ? String(req.body.item_id) : '';

    // Validation check
    if (session_id === '' || item_id === '') {
        return res.status(400).json({
            error: { code: "BAD_REQUEST" }
        });
    }

    try {
        // 1. Validate user via session
        const user = await requireUserBySession(session_id);
        const player_id = user.player_id;

        // 2. Check if item already exists
        const [rows] = await pool.execute(`
            SELECT quantity 
            FROM owned_items 
            WHERE player_id = ? AND item_id = ?
            LIMIT 1
        `, [player_id, item_id]);

        if (rows.length > 0) {
            // The user already has this item, throw conflict error
            return res.status(409).json({
                error: { code: "ITEM_ALREADY_OWNED" }
            });
        }

        // 3. Insert new item (only if it didn't exist)
        await pool.execute(`
            INSERT INTO owned_items (player_id, item_id, quantity)
            VALUES (?, ?, 1)
        `, [player_id, item_id]);

        // 4. Success payload response
        return res.json({
            id: item_id,
            amount: 1,
            type: "ITEM",
            item_id: item_id
        });

    } catch (err) {
        // Handle unauthorized exceptions thrown from helper methods
        if (err.statusCode === 401) {
            return res.status(401).json({
                error: { code: "NOT_AUTHENTICATED" }
            });
        }
        
        console.error("[Item API] Internal server error:", err.message);
        return res.status(500).json({
            error: { code: "SERVER_ERROR" }
        });
    }
});


app.post('/session/challenge/list', (req, res) => {
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const challenges = [
        {
            challenge_id: "9e5d1da5-e8d1-46a0-bb66-3ffc6b9c21ee",
            target: 3,
            reward_type: "COUPON",
            reward_amount: 1,
            reward_id: null,
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "BattleWinPvWM",
            tag_id: null,
            challange_name: null,
            progress: 3,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "98d200db-fb67-46df-94ea-d73667b52ec0",
            target: 1,
            reward_type: "ITEM",
            reward_amount: 1,
            reward_id: "ItemGreatSerum",
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "PurchaseItemName",
            tag_id: "ItemPoisonCure",
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "7c812c30-29d4-47d1-bd83-31c25ce921ff",
            target: 1,
            reward_type: "COIN",
            reward_amount: 200,
            reward_id: null,
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "PurchaseItemName",
            tag_id: "ItemGreatSerum",
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "a0d87751-c5d3-46a7-b9c6-d12607ec514b",
            target: 1,
            reward_type: "COIN",
            reward_amount: 500,
            reward_id: null,
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "UseItemName",
            tag_id: "ItemMegaSeedLevelUp",
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "5433a483-b571-448d-a096-19d097f55447",
            target: 4,
            reward_type: "COIN",
            reward_amount: 100,
            reward_id: null,
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "BattleCompleteArena",
            tag_id: null,
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "783a59bc-7694-4124-8ca3-baca6f7e9b47",
            target: 2,
            reward_type: "COIN",
            reward_amount: 200,
            reward_id: null,
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "EvolveMorty",
            tag_id: null,
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "b2cd638c-ef0c-4c47-bf3f-6b08ef6c07f1",
            target: 5,
            reward_type: "COIN",
            reward_amount: 100,
            reward_id: null,
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "WildMorty",
            tag_id: null,
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "715473f3-bf86-4310-b5b7-163e324feaa2",
            target: 4,
            reward_type: "COIN",
            reward_amount: 100,
            reward_id: null,
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "BattleCompleteArena",
            tag_id: null,
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "5c27e488-3a08-43cd-b40e-323168e772eb",
            target: 5,
            reward_type: "ITEM",
            reward_amount: 1,
            reward_id: "ItemCable",
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "BattleCatchPvWMElement",
            tag_id: "Rock",
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        },
        {
            challenge_id: "9b99c800-b69f-44e3-b7e1-651644e94b83",
            target: 1,
            reward_type: "ITEM",
            reward_amount: 1,
            reward_id: "ItemParalysisCure",
            reward_parameters: null,
            cooldown: 0,
            is_daily: true,
            tag: "UseItemName",
            tag_id: "ItemPoisonCure",
            challange_name: null,
            progress: 0,
            cooldown_expires: null,
            in_cooldown: false,
            end_time: "2026-01-28T04:59:59.999Z"
        }
    ];

    return res.status(200).json(challenges);
});

// POST /session/player-avatar/set-active
app.post('/session/player-avatar/set-active', async (req, res) => {
    // Set headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const body = req.body || {};
        const session_id = String(body.session_id || '');
        const player_avatar_id = String(body.player_avatar_id || '');

        // Parameter validation
        if (!session_id || !player_avatar_id) {
            return res.status(400).json({ success: false, error: "Missing parameters" });
        }

        // Update active avatar by session_id
        const [result] = await pool.execute(`
            UPDATE users
            SET player_avatar_id = ?
            WHERE session_id = ?
            LIMIT 1
        `, [player_avatar_id, session_id]);

        // Check if any row was actually updated
        if (result.affectedRows === 0) {
            return res.status(401).json({ success: false, error: "Invalid session" });
        }

        // Respond
        return res.status(200).json({ success: true });

    } catch (e) {
        console.error(e);
        return res.status(500).json({ success: false, error: "Server error", detail: e.message });
    }
});

// POST /session/player-avatar/buy
app.post('/session/player-avatar/buy', async (req, res) => {
    // Set headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    try {
        const body = req.body || {};
        const session_id = String(body.session_id || '');
        const player_avatar_id = String(body.player_avatar_id || '');

        // Parameter validation
        if (!session_id || !player_avatar_id) {
            return res.status(400).json({ error: "Missing parameters" });
        }

        // Get player by session_id
        const [rows] = await pool.execute(`
            SELECT 
                u.player_id,
                u.coins,
                u.player_avatar_id AS current_avatar,
                oa.player_avatar_id AS owned_avatars
            FROM users u
            JOIN owned_avatars oa ON oa.player_id = u.player_id
            WHERE u.session_id = ?
            LIMIT 1
        `, [session_id]);

        const player = rows[0];

        if (!player) {
            return res.status(401).json({ error: "Invalid session" });
        }

        // Parse owned_avatars JSON array safely
        let owned_avatars = [];
        try {
            if (typeof player.owned_avatars === 'string') {
                owned_avatars = JSON.parse(player.owned_avatars);
            } else if (Array.isArray(player.owned_avatars)) {
                // mysql2 auto-parses JSON columns into native JS arrays/objects
                owned_avatars = player.owned_avatars; 
            }
        } catch (e) {
            owned_avatars = [];
        }

        if (!Array.isArray(owned_avatars)) {
            owned_avatars = [];
        }

        // Add avatar if not already owned
        if (!owned_avatars.includes(player_avatar_id)) {
            owned_avatars.push(player_avatar_id);
        }

        // Write JSON array back to DB
        await pool.execute(`
            UPDATE owned_avatars
            SET player_avatar_id = ?
            WHERE player_id = ?
        `, [JSON.stringify(owned_avatars), player.player_id]);

        // Equip avatar if different from current
        if (player.current_avatar !== player_avatar_id) {
            await pool.execute(`
                UPDATE users
                SET player_avatar_id = ?
                WHERE player_id = ?
            `, [player_avatar_id, player.player_id]);
        }

        // Respond
        return res.status(200).json({
            coins: Number(player.coins),
            coins_deducted: 0,
            result: {
                type: "AVATAR",
                player_avatar_id: player_avatar_id
            }
        });

    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Server error", detail: e.message });
    }
});

// POST /session/buy-item (or whatever your path is)
app.post('/session/buy-item', async (req, res) => {
    // Set response headers
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const MAX_ITEM_LIMIT = 10;

    try {
        const body = req.body || {};
        const session_id = String(body.session_id || '');
        const item_id = String(body.item_id || '');

        // Validation
        if (!session_id || !item_id) {
            return res.status(400).json({
                error: { code: "BAD_REQUEST" }
            });
        }

        // Validate user session
        const [users] = await pool.execute(
            'SELECT player_id,coins,coupons FROM users WHERE session_id = ? LIMIT 1',
            [session_id]
        );

        const user = users[0];

        if (!user) {
            return res.status(401).json({
                error: { code: "NOT_AUTHENTICATED" }
            });
        }

        const player_id = user.player_id;
		const coins = user.coins;
		const coupons = user.coupons;

        // Check if item already exists in inventory
        const [items] = await pool.execute(
            'SELECT quantity FROM owned_items WHERE player_id = ? AND item_id = ? LIMIT 1',
            [player_id, item_id]
        );

        const existingItem = items[0];
        let final_qty = 1;

        if (existingItem) {
            const current_qty = Number(existingItem.quantity);

            // Limit reached
            if (current_qty >= MAX_ITEM_LIMIT) {
                return res.status(409).json({
                    error: { code: "ITEM_LIMIT" }
                });
            }

            // Update quantity
            final_qty = Math.min(current_qty + 1, MAX_ITEM_LIMIT);

            await pool.execute(
                'UPDATE owned_items SET quantity = ? WHERE player_id = ? AND item_id = ?',
                [final_qty, player_id, item_id]
            );
        } else {
            // Insert new item record
            await pool.execute(
                'INSERT INTO owned_items (player_id, item_id, quantity) VALUES (?, ?, 1)',
                [player_id, item_id]
            );

            final_qty = 1;
        }

        // Success response
        return res.status(200).json({
            coins: coins, // Replace with real player coins value if needed
            coupons: coupons,
            result: {
                type: "ITEM",
                item_id: item_id,
                quantity: final_qty,
                amount_received: 1,
                amount: 1
            }
        });

    } catch (e) {
        console.error("Item processing error:", e);
        return res.status(500).json({
            error: { code: "SERVER_ERROR" }
        });
    }
});


// POST /session/heal
app.post('/session/heal', async (req, res) => {
    // Set response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');

    const body = req.body || {};
    const session_id = String(body.session_id || '');

    if (!session_id) {
        return res.status(401).json({ error: { code: "NOT_AUTHENTICATED" } });
    }

    // Helper functions inside route context
    const toBool = (v) => {
        if (v === null || v === undefined) return false;
        if (typeof v === 'boolean') return v;
        const s = String(v).trim().toLowerCase();
        return ["1", "true", "yes", "y", "on"].includes(s);
    };

    const toNull = (v) => {
        if (v === null || v === undefined) return null;
        const s = String(v).trim();
        if (s === "" || s.toLowerCase() === "null") return null;
        return s;
    };

    const decodeOwnedIds = (raw) => {
        if (!raw) return [];
        let input = String(raw).trim();
        
        // Attempt 1: Direct JSON parse
        try {
            const parsed = JSON.parse(input);
            if (Array.isArray(parsed)) return parsed.map(String).filter(x => x !== "");
        } catch (e) {}

        // Attempt 2: Strip outer quotes & escaped backslashes (e.g. "[\"id1\",\"id2\"]")
        try {
            let unescaped = input.replace(/\\"/g, '"');
            if (unescaped.startsWith('"') && unescaped.endsWith('"')) {
                unescaped = unescaped.slice(1, -1);
            }
            const parsed = JSON.parse(unescaped);
            if (Array.isArray(parsed)) return parsed.map(String).filter(x => x !== "");
        } catch (e) {}

        return [];
    };

    let connection;

    try {
        // 1) Fetch User by session_id
        const [users] = await pool.execute('SELECT * FROM users WHERE session_id = ? LIMIT 1', [session_id]);
        const user = users[0];

        if (!user) {
            return res.status(401).json({ error: { code: "INVALID_SESSION" } });
        }

        const player_id = String(user.player_id || '');
        if (!player_id) {
            return res.status(500).json({ error: { code: "NO_PLAYER_ID" } });
        }

        const active_deck_id = Number(user.active_deck_id ?? -1);
        if (active_deck_id < 0) {
            return res.status(400).json({ error: { code: "NO_ACTIVE_DECK" } });
        }

        // 2) Deck -> owned IDs
        const [decks] = await pool.execute(
            'SELECT owned_morty_ids FROM decks WHERE player_id = ? AND deck_id = ? LIMIT 1',
            [player_id, active_deck_id]
        );
        const deck = decks[0];

        const ownedIds = decodeOwnedIds(deck?.owned_morty_ids);
        if (ownedIds.length === 0) {
            return res.status(400).json({ error: { code: "DECK_EMPTY" } });
        }

        // 3) Heal HP + PP inside a SQL Transaction
        connection = await pool.getConnection();
        await connection.beginTransaction();

        const placeholders = ownedIds.map(() => '?').join(',');

        // Heal HP to full
        const sqlHp = `
            UPDATE owned_morties
            SET hp = hp_stat
            WHERE player_id = ? AND owned_morty_id IN (${placeholders})
        `;
        await connection.execute(sqlHp, [player_id, ...ownedIds]);

        // Heal PP to full
        const sqlPp = `
            UPDATE owned_attacks
            SET pp = pp_stat
            WHERE owned_morty_id IN (${placeholders})
        `;
        await connection.execute(sqlPp, ownedIds);

        await connection.commit();

        // 4) Fetch morties ordered by deck order
        const sqlMorties = `
            SELECT *
            FROM owned_morties
            WHERE player_id = ? AND owned_morty_id IN (${placeholders})
            ORDER BY FIELD(owned_morty_id, ${placeholders})
        `;
        const [morties] = await pool.execute(sqlMorties, [player_id, ...ownedIds, ...ownedIds]);

        // 5) Fetch attacks
        const sqlAttacks = `
            SELECT owned_morty_id, attack_id, position, pp, pp_stat
            FROM owned_attacks
            WHERE owned_morty_id IN (${placeholders})
            ORDER BY owned_morty_id ASC, position ASC
        `;
        const [attRows] = await pool.execute(sqlAttacks, ownedIds);

        // Group attacks by owned_morty_id
        const attByOwned = {};
        for (const a of attRows) {
            const oid = String(a.owned_morty_id);
            if (!attByOwned[oid]) attByOwned[oid] = [];
            attByOwned[oid].push({
                attack_id: String(a.attack_id),
                position: Number(a.position),
                pp: Number(a.pp),
                pp_stat: Number(a.pp_stat)
            });
        }

        // 6) Build owned_morties array maintaining deck order
        const mortyById = {};
        for (const m of morties) {
            mortyById[String(m.owned_morty_id)] = m;
        }

        const owned_morties = [];
        for (const oid of ownedIds) {
            if (!mortyById[oid]) continue;
            const m = mortyById[oid];

            owned_morties.push({
                owned_morty_id: String(m.owned_morty_id),
                morty_id: String(m.morty_id),
                level: Number(m.level),
                xp: Number(m.xp),
                hp: Number(m.hp),
                hp_stat: Number(m.hp_stat),
                attack_stat: Number(m.attack_stat),
                defence_stat: Number(m.defence_stat),
                variant: String(m.variant || "Normal"),
                speed_stat: Number(m.speed_stat),
                is_locked: toBool(m.is_locked),
                is_trading_locked: toBool(m.is_trading_locked),
                fight_pit_id: toNull(m.fight_pit_id),
                evolution_points: Number(m.evolution_points || 0),
                owned_attacks: attByOwned[oid] || [],
                xp_lower: Number(m.xp_lower || 0),
                xp_upper: Number(m.xp_upper || 0)
            });
        }

        // 7) Output Player payload
        const player = {
            player_id: String(user.player_id),
            username: String(user.username),
            player_avatar_id: String(user.player_avatar_id),
            level: Number(user.level),
            xp: Number(user.xp),
            streak: Number(user.streak || 0),
            owned_morties: owned_morties,
            xp_lower: Number(user.xp_lower || 0),
            xp_upper: Number(user.xp_upper || 0),
            tags: []
        };

        return res.status(200).json(player);

    } catch (e) {
        if (connection) {
            await connection.rollback();
        }
        console.error("Heal Route Error:", e);
        return res.status(500).json({
            error: {
                code: "SERVER_ERROR",
                message: e.message
            }
        });
    } finally {
        if (connection) {
            connection.release();
        }
    }
});

// Handle preflight OPTIONS requests for CORS
app.options('/session/heal', (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    return res.sendStatus(204);
});


app.get('/promos/active', (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    
    return res.status(200).json({
        SP: {},
        MP: {}
    });
});


// POST /session/owned_morties/lock
app.post('/session/owned_morties/lock', async (req, res) => {
    try {
        const { session_id, player_id, owned_morty_id, is_locked } = req.body;

        const targetPlayerId = player_id || session_id;
        if (!targetPlayerId) {
            return res.status(400).json({ error: "Missing player reference identifier." });
        }

        // 1) Query user profile attributes from DB (includes active_deck_id)
        const [userRows] = await pool.query(
            `SELECT player_id, username, player_avatar_id, level, xp, streak, 
                    active_deck_id, decks_owned, tags 
             FROM users 
             WHERE player_id = ? OR session_id = ? 
             LIMIT 1`,
            [targetPlayerId, targetPlayerId]
        );

        const user = userRows[0];
        if (!user) {
            return res.status(404).json({ error: "Player profile missing." });
        }

        // 2) OPTIONAL: Update lock status if owned_morty_id and is_locked are provided
        if (owned_morty_id && typeof is_locked === 'boolean') {
            await pool.query(
                `UPDATE owned_morties 
                 SET is_locked = ? 
                 WHERE owned_morty_id = ? AND player_id = ?`,
                [is_locked ? 1 : 0, owned_morty_id, user.player_id]
            );
        }

        // 3) Query player deck configurations
        const [deckRows] = await pool.query(
            `SELECT deck_id, owned_morty_ids 
             FROM decks 
             WHERE player_id = ?`,
            [user.player_id]
        );

        // Format decks list
        const formattedDecks = deckRows.map(d => ({
            deck_id: parseInt(d.deck_id, 10),
            owned_morty_ids: typeof d.owned_morty_ids === 'string' 
                ? JSON.parse(d.owned_morty_ids) 
                : (d.owned_morty_ids || [])
        }));

        // Parse tags safely
        let parsedTags = [];
        try {
            parsedTags = typeof user.tags === 'string' ? JSON.parse(user.tags) : (user.tags || []);
        } catch (e) {
            parsedTags = [];
        }

        // 4) XP Bracket Calculation
        const currentLevel = parseInt(user.level, 10) || 1;
        const xpHolder = parseInt(user.xp, 10) || 0;
        const xpLower = Math.pow(currentLevel, 3);
        const xpUpper = Math.pow(currentLevel + 1, 3);

        // Extract active_deck_id from the user profile
        const activeDeckId = parseInt(user.active_deck_id, 10) || 0;

        // Construct final payload
        const payload = {
            player_id: user.player_id,
            username: user.username,
            player_avatar_id: user.player_avatar_id || "AvatarRickDefault",
            level: currentLevel,
            xp: xpHolder,
            streak: parseInt(user.streak, 10) || 0,
            active_deck_id: activeDeckId,
            decks_owned: parseInt(user.decks_owned, 10) || 1,
            decks: formattedDecks,
            xp_lower: xpLower,
            xp_upper: xpUpper,
            tags: parsedTags
        };

        return res.type('json').send(JSON.stringify(payload));

    } catch (err) {
        console.error("Error retrieving locked owned morties state:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});

app.post('/session/battle-bot', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sessionId = req.body.session_id ? String(req.body.session_id) : "";
    const botIdInput = req.body.bot_id ? String(req.body.bot_id) : "";

    if (!sessionId || !botIdInput) {
        return res.status(400).json({ success: false, error: "Missing session_id or bot_id" });
    }

    try {
        // 1. Resolve active user session context
        const [userRows] = await pool.execute(
            "SELECT player_id, room_id FROM users WHERE session_id = ? LIMIT 1",
            [sessionId]
        );
        if (!userRows.length) {
            return res.status(401).json({ success: false, error: "Not authenticated" });
        }

        const playerId = String(userRows[0].player_id);
        const roomId = String(userRows[0].room_id || "");

        if (!roomId || roomId === "0") {
            return res.status(409).json({ success: false, error: "Player is not in a room" });
        }

        // 2. Validate targeted room container instance
        const [roomRows] = await pool.execute(
            "SELECT 1 FROM room_ids WHERE room_id = ? LIMIT 1",
            [roomId]
        );
        if (!roomRows.length) {
            return res.status(409).json({ success: false, error: "Room does not exist", room_id: roomId });
        }

        // 3. Extract the wild entity target instance from the event queue log map
        const [botRows] = await pool.execute(`
            SELECT bot_id, username, morty_id, player_avatar_id, owned_morties, placement, state, division, variant, shiny_if_potion 
            FROM event_queue 
            WHERE room_id = ? 
              AND event_name = 'room:bot-added' 
              AND bot_id = ? 
            ORDER BY id DESC LIMIT 1
        `, [roomId, botIdInput]);

        if (!botRows.length) {
            return res.status(409).json({ success: false, error: "Bot does not exist" });
        }

        const botPayload = botRows[0];


// Safely parse owned_morties (handles string, array, undefined, null)
let morties = [];
try {
    if (typeof botPayload.owned_morties === 'string') {
        morties = JSON.parse(botPayload.owned_morties);
    } else if (Array.isArray(botPayload.owned_morties)) {
        morties = botPayload.owned_morties;
    }
} catch (e) {
    console.error("Failed to parse bot owned_morties JSON:", e);
    morties = [];
}

// Ensure morties is an array
if (!Array.isArray(morties)) {
    morties = [];
}

// 1. Collect ALL Morties formatted for the opponent payload
const opponentOwnedMorties = morties.map((m) => ({
    owned_morty_id: m.owned_morty_id || botIdInput,
    morty_id: m.morty_id || botPayload.morty_id || "MortyAndroid",
    level: parseInt(m.level || 5, 10),
    xp: parseInt(m.xp || 5, 10),
    hp: parseInt(m.hp || 20, 10),
    variant: m.variant || botPayload.variant || "Normal",
    hp_stat: parseInt(m.hp_stat || m.hp || 20, 10)
}));


        // 4. Gather full target player information parameters
        const [playerRows] = await pool.execute(`
            SELECT player_id, username, player_avatar_id, level, xp, streak, coins, coupons, permits, xp_lower, xp_upper, active_deck_id 
            FROM users WHERE player_id = ? LIMIT 1
        `, [playerId]);

        if (!playerRows.length) {
            return res.status(404).json({ success: false, error: "Player not found" });
        }
        const playerRow = playerRows[0];

        // 5. Decode user active party structures to parse active deck configuration
        let deckMortyIds = [];
        const activeDeckId = String(playerRow.active_deck_id || "");

        if (activeDeckId && activeDeckId !== "0") {
            const [deckRows] = await pool.execute(
                "SELECT owned_morty_ids FROM decks WHERE deck_id = ? LIMIT 1",
                [activeDeckId]
            );
            if (deckRows.length && deckRows[0].owned_morty_ids) {
                deckMortyIds = parseIdList(deckRows[0].owned_morty_ids);
            }
        }

        // 6. Gather collection map arrays of owned sub-assets
        const [ownedMortiesRows] = await pool.execute(`
            SELECT owned_morty_id, morty_id, level, xp, hp, variant, hp_stat, xp_lower, xp_upper, is_locked, is_trading_locked 
            FROM owned_morties WHERE player_id = ? ORDER BY created_at ASC
        `, [playerId]);

        if (!ownedMortiesRows.length) {
            return res.status(400).json({ success: false, error: "Player has no owned Morties" });
        }

        // Fallback: If no custom deck is set or found, use the first owned Morty as team baseline
        if (deckMortyIds.length === 0) {
            deckMortyIds = [ownedMortiesRows[0].owned_morty_id];
        }

        // Compile attack profiles map grouped by owned instances
        const attacksByOwnedMorty = {};
        const ownedMortyIds = ownedMortiesRows.map(m => m.owned_morty_id);
        const placeholders = ownedMortyIds.map(() => '?').join(',');
        
        const [attackRows] = await pool.execute(`
            SELECT owned_morty_id, attack_id, position, pp, pp_stat 
            FROM owned_attacks 
            WHERE owned_morty_id IN (${placeholders}) 
            ORDER BY owned_morty_id ASC, position ASC
        `, ownedMortyIds);

        for (const a of attackRows) {
            const oid = a.owned_morty_id;
            if (!attacksByOwnedMorty[oid]) attacksByOwnedMorty[oid] = [];
            attacksByOwnedMorty[oid].push({
                attack_id: a.attack_id,
                position: parseInt(a.position, 10),
                pp: parseInt(a.pp, 10),
                pp_stat: parseInt(a.pp_stat, 10)
            });
        }

        // 7. Establish the lead living fighter index
        let activeOwnedMorty = "";
        for (const oid of deckMortyIds) {
            const matchedMorty = ownedMortiesRows.find(m => m.owned_morty_id === oid);
            if (matchedMorty && parseInt(matchedMorty.hp, 10) > 0) {
                activeOwnedMorty = oid;
                break;
            }
        }
        // Last-resort fallback if everything is fainted, take first deck element
        if (!activeOwnedMorty && deckMortyIds.length > 0) {
            activeOwnedMorty = deckMortyIds[0];
        }

        // 8. Assemble active battle configuration team array payload
        const ownedMortiesPayloadArray = [];
        const deckMortyMap = new Set(deckMortyIds);

        for (const m of ownedMortiesRows) {
            if (!deckMortyMap.has(m.owned_morty_id)) continue;
            const oid = m.owned_morty_id;
            ownedMortiesPayloadArray.push({
                owned_morty_id: oid,
                morty_id: m.morty_id,
                level: parseInt(m.level, 10),
                xp_lower: parseInt(m.xp_lower || 0, 10),
                xp_upper: parseInt(m.xp_upper || 0, 10),
                xp: parseInt(m.xp, 10),
                hp: parseInt(m.hp, 10),
                variant: m.variant,
                hp_stat: parseInt(m.hp_stat, 10),
                is_locked: toBool(m.is_locked),
                is_trading_locked: toBool(m.is_trading_locked),
                owned_attacks: attacksByOwnedMorty[oid] || []
            });
        }

        // 9. Fetch user item inventory metrics
        const [itemRows] = await pool.execute(
            "SELECT item_id, quantity FROM owned_items WHERE player_id = ? ORDER BY item_id ASC",
            [playerId]
        );
        const ownedItems = itemRows.map(it => ({
            item_id: String(it.item_id),
            quantity: parseInt(it.quantity, 10)
        }));

        // 10. Build complex structured payloads matching client mapping demands
        const moveLog = {
            cooldown: {},
            count: {},
            cooldown_next: { ITEM: 1 },
            last_move_type: {}
        };

        const playerPayload = {
            player_id: playerRow.player_id,
            username: playerRow.username,
            player_avatar_id: playerRow.player_avatar_id,
            level: parseInt(playerRow.level, 10),
            xp: parseInt(playerRow.xp, 10),
            streak: parseInt(playerRow.streak, 10),
            coins: parseInt(playerRow.coins, 10),
            coupons: parseInt(playerRow.coupons, 10),
            permits: parseInt(playerRow.permits, 10),
            owned_morties: ownedMortiesPayloadArray,
            owned_items: ownedItems,
            tags: [],
            xp_lower: parseInt(playerRow.xp_lower || 0, 10),
            xp_upper: parseInt(playerRow.xp_upper || 0, 10),
            _meta: { session_id: sessionId, isPlayerInDB: true, isControlledByAI: false, isRaidBoss: false },
            active_owned_morty: activeOwnedMorty,
            move_log: moveLog
        };

// Grab the first Morty's owned_morty_id (or fallback to botIdInput)
const activeOpponentMortyId = opponentOwnedMorties[0]?.owned_morty_id || botIdInput;

const opponentPayload = {
    player_id: botPayload.bot_id,
    username: botPayload.username,
    player_avatar_id: botPayload.player_avatar_id,
    owned_morties: opponentOwnedMorties,
    streak: 0,
    shiny_if_potion: toBool(botPayload.shiny_if_potion || false),
    _meta: { isPlayerInDB: false, isControlledByAI: true, isRaidBoss: false },
    active_owned_morty: activeOpponentMortyId // Fixed here
};

        // 11. Extract metadata and write state record into the battles engine tracker table
        const battleId = crypto.randomUUID();
        const opponentActiveMortyId = opponentPayload.active_owned_morty;

        // Safely find the active opponent Morty object from the parsed morties array
        const matchedOpponentMorty = opponentPayload.owned_morties.find(
            m => m.owned_morty_id === opponentActiveMortyId
        ) || opponentPayload.owned_morties[0];

        const opponentMortyTemplateId = matchedOpponentMorty ? matchedOpponentMorty.morty_id : "MortyAndroid";
        const opponentHpValue = matchedOpponentMorty ? matchedOpponentMorty.hp : 20;

        const playerActiveMortyId = activeOwnedMorty;
        const matchedActiveMorty = ownedMortiesPayloadArray.find(m => m.owned_morty_id === activeOwnedMorty);
        const playerHpValue = matchedActiveMorty ? matchedActiveMorty.hp : 0;

        await pool.execute(`
            INSERT INTO battles (
                battle_id, player_id, bot_id, 
                opponent_active_morty, opponent_morty_id, opponent_hp, 
                player_active_morty, player_hp, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW())
        `, [
            battleId, playerId, botIdInput,
            opponentActiveMortyId, opponentMortyTemplateId, opponentHpValue,
            playerActiveMortyId, playerHpValue
        ]);

        // 12. Broadcast operational synchronization signals to SSE lines
        const finalBroadcastPayload = {
            battle_id: battleId,
            battle_type: "PvB",
            player: playerPayload,
            opponent: opponentPayload,
            meta: {}
        };
        
        await publishEvent(roomId, "battle:start", finalBroadcastPayload, playerId);
        await publishEvent(roomId, "room:bot-state-changed", { bot_id: botIdInput, state: "BATTLE" });
        //await publishEvent(roomId, "room:user-state-changed", { player_id: playerId, state: "BATTLE" });

        return res.json({ success: true });
		
    } catch (err) {
        console.error(">>> [BATTLE BOT INITIATION CRITICAL ERROR]:", err);
        return res.status(500).json({ success: false, error: "Server error", detail: err.message });
    }
});



















// UDP SERVER
const udpPlayers = new Map();

// sessionHex -> {
//   playerId,
//   address,
//   port,
//   x,
//   y,
//   frame,
//   direction,
//   xFlags,
//   yFlags,
//   sequence,
//   lastSeen
// }


function hexToUuid(hex){
    return (
        hex.substring(0,8)+"-"+
        hex.substring(8,12)+"-"+
        hex.substring(12,16)+"-"+
        hex.substring(16,20)+"-"+
        hex.substring(20,32)
    );
}


function registerPlayerUdpSession(playerId, sessionHex, roomId) {
    udpPlayers.set(sessionHex, {
        playerId,
        roomId,
        address: null,
        port: null,
        lastSeen: Date.now()
    });
}

function decodePacket(buffer){

    if(buffer.length !== 24){
        throw new Error(
            `Invalid packet size ${buffer.length}`
        );
    }


    return {

        session:
            buffer.subarray(0,16).toString("hex"),

        sequence:
            buffer.readUInt16LE(16),

        x:
            buffer.readUInt8(18),

        xFlags:
            buffer.readUInt8(19),

        y:
            buffer.readUInt8(20),

        yFlags:
            buffer.readUInt8(21),

        frame:
            buffer.readUInt8(22),

        direction:
            buffer.readUInt8(23)
    };

}

function relayMovement(senderPlayerId, target, msg) {
    const idHex = senderPlayerId.replace(/-/g, "");
    const idBuffer = Buffer.from(idHex, "hex");

    if (idBuffer.length !== 16) {
        console.error(`[UDP RELAY ERROR] bad playerId "${senderPlayerId}" -> ${idBuffer.length} bytes, expected 16`);
        return;
    }

    const relayPacket = Buffer.concat([idBuffer, msg.subarray(16)]);

    udpServer.send(relayPacket, 0, relayPacket.length, target.port, target.address);
    //console.log("[UDP RELAY]", senderPlayerId, "->", target.playerId, relayPacket.toString("hex"));
}

udpServer.on('message', (msg, rinfo) => {
    //console.log("[RELAY RAW]", msg.toString("hex"));
    try {
        const packet = decodePacket(msg);
        const player = udpPlayers.get(packet.session);
        if (!player) {
            console.log("[UNKNOWN SESSION]", packet.session);
            return;
        }

        player.address = rinfo.address;
        player.port = rinfo.port;
        player.lastPacket = Buffer.from(msg);
        player.lastSeen = Date.now();
		
		// --- NEW: keep the live position map in sync ---
        livePlayerPositions.set(player.playerId, {
            x: packet.x,
            y: packet.y,
            frame: packet.frame,
            direction: packet.direction,
            roomId: player.roomId,
            lastUpdated: Date.now()
        });

        //console.log(`[UDP MOVE] Player:${player.playerId} - Pos:${packet.x},${packet.y} - Seq:${packet.sequence} - Frame:${packet.frame} - Dir:${packet.direction}`);

// in the relay loop:
for (const [targetSession, target] of udpPlayers) {
    if (targetSession === packet.session) continue;
    if (!target.address) continue;
    if (target.roomId !== player.roomId) continue; // room isolation
    relayMovement(player.playerId, target, msg);
}


    } catch (err) {
        console.error("[UDP ERROR]", err);
    }
});





udpServer.bind(
13001,
'0.0.0.0',
()=>{

console.log("UDP Movement Engine listening on 13001");

});









const PORT = 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`Server is running locally at http://localhost:${PORT}`);
});