const express = require('express');
const crypto = require('crypto');
const bcrypt = require('bcrypt');
const mysql = require('mysql2/promise');
const jwt = require('jsonwebtoken');
const dgram = require('dgram');
const udpServer = dgram.createSocket('udp4');
const livePlayerPositions = new Map();
const activeSseConnections = new Map();      // player_id -> sseSend
const activeRoomSseConnections = new Map();  // room_id -> Set of sseSend
const SpawnedMorties = new Map();
const SpawnedItems = new Map();
const SpawnedBots = new Map();
const Battles = new Map();
const app = express();
// Middleware to parse JSON body
app.use(express.json());

// Helper functions (assuming defined in scope)
const parseIdList = (str) => String(str || "").split(',').map(id => id.trim()).filter(Boolean);
const toBool = (val) => val === true || val === 1 || String(val).toLowerCase() === 'true';

// ---------------- 1. DATABASE CONFIGURATION ----------------
const pool = mysql.createPool({
    host: 'localhost',
    user: 'yourusername',
    password: 'yourpassword',
    database: 'yourdb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// ==================== CONFIGS & HELPERS ====================
const PICKUPS_CONFIG = {
    count: 3,
    crate: {
        probability: 0.2,
        contains_min: 2,
        contains_max: 3,
        coins_min: 100,
        coins_max: 200,
        contents: [
            { type: "ITEM", amount: 1, item_id: "ItemMortyChip", rarity: 50 },
            { type: "ITEM", amount: 1, item_id: "ItemSerum", rarity: 100 },
            { type: "ITEM", amount: 1, item_id: "ItemHalzinger", rarity: 25 },
            { type: "ITEM", amount: 1, item_id: "ItemPoisonCure", rarity: 75 },
            { type: "ITEM", amount: 1, item_id: "ItemParalysisCure", rarity: 75 },
            { type: "ITEM", amount: 1, item_id: "ItemPlutonicRock", rarity: 100 },
            { type: "ITEM", amount: 1, item_id: "ItemMegaSeedAttack", rarity: 5 },
            { type: "ITEM", amount: 1, item_id: "ItemMegaSeedDefence", rarity: 5 },
            { type: "ITEM", amount: 1, item_id: "ItemMegaSeedSpeed", rarity: 5 }
        ]
    },
    contents: [
        { type: "ITEM", amount: 1, item_id: "ItemBattery", rarity: 100 },
        { type: "ITEM", amount: 1, item_id: "ItemFleeb", rarity: 100 },
        { type: "ITEM", amount: 1, item_id: "ItemBacteriaCell", rarity: 100 },
        { type: "ITEM", amount: 1, item_id: "ItemCircuitBoard", rarity: 100 },
        { type: "ITEM", amount: 1, item_id: "ItemDarkEnergyBall", rarity: 100 },
        { type: "ITEM", amount: 1, item_id: "ItemTinCan", rarity: 100 },
        { type: "ITEM", amount: 1, item_id: "ItemCable", rarity: 100 },
        { type: "ITEM", amount: 1, item_id: "ItemTurbulentJuiceTube", rarity: 100 }
    ]
};

const PICKUP_PLACEMENTS = [
    [65, 79], [2, 79], [48, 87], [34, 83],
    [8, 57], [57, 48], [25, 87], [42, 64]
];

const WILD_MORTIES_CONFIG = {
    count: 8,
    morties: [
        { morty_id: "MortyScruffy", rarity: 100 },
        { morty_id: "MortyOld", rarity: 100 },
        { morty_id: "MortyRabbit", rarity: 100 },
        { morty_id: "MortyStrawberry", rarity: 100 },
        { morty_id: "MortyBlueShirt", rarity: 100 },
        { morty_id: "MortySpoon", rarity: 100 },
        { morty_id: "MortySpooky", rarity: 100 },
        { morty_id: "MortyGreaser", rarity: 100 },
        { morty_id: "MortyStrayCat", rarity: 100 },
        { morty_id: "MortyVNeck", rarity: 100 },
        { morty_id: "MortyMullet", rarity: 100 },
        { morty_id: "MortyBirdosaur", rarity: 100 },
        { morty_id: "MortySurvivor", rarity: 100 },
        { morty_id: "MortyRookie", rarity: 100 },
        { morty_id: "MortyFawn", rarity: 20 },
        { morty_id: "MortyMascot", rarity: 20 },
        { morty_id: "MortyCowboy", rarity: 20 },
        { morty_id: "MortyCup", rarity: 20 },
        { morty_id: "MortyPunk", rarity: 20 },
        { morty_id: "MortySexyDevil", rarity: 20 },
        { morty_id: "MortyWildMascot", rarity: 5 },
        { morty_id: "MortyAnimatronic", rarity: 5 },
        { morty_id: "MortyEgg", rarity: 5 }
    ]
};

const WILD_MORTY_PLACEMENTS = [
    [21, 84], [12, 84], [5, 82], [32, 72], [38, 82],
    [49, 84], [15, 4], [61, 68], [42, 75], [13, 56],
    [24, 57], [52, 61], [61, 33], [36, 59], [24, 76],
    [55, 79], [37, 76], [13, 62], [32, 76], [47, 68]
];

function shuffleArray(array) {
    const arr = [...array];
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
}

function getWeightedRandom(pool, defaultRarity = 1) {
    const validPool = pool.map(item => ({
        ...item,
        weight: typeof item.rarity === 'number' ? item.rarity : defaultRarity
    }));
    const totalWeight = validPool.reduce((sum, item) => sum + item.weight, 0);
    let randomNum = Math.random() * totalWeight;

    for (const item of validPool) {
        if (randomNum < item.weight) return item;
        randomNum -= item.weight;
    }
    return validPool[0];
}

function getRandomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

// ==================== EXACT CLIENT SCHEMAS ====================
function populateRoomPickups(roomId) {
    const key = String(roomId);
    const shuffledPlacements = shuffleArray(PICKUP_PLACEMENTS);
    const formattedPickups = [];

    for (let i = 0; i < PICKUPS_CONFIG.count; i++) {
        const placement = shuffledPlacements[i];
        const isCrate = Math.random() < PICKUPS_CONFIG.crate.probability;
        const pickupId = `${isCrate ? 'crate' : 'pickup'}_${Date.now()}_${i}_${getRandomInt(100, 999)}`;
        const contents = [];

        if (isCrate) {
            const itemCount = getRandomInt(PICKUPS_CONFIG.crate.contains_min, PICKUPS_CONFIG.crate.contains_max);
            const coins = getRandomInt(PICKUPS_CONFIG.crate.coins_min, PICKUPS_CONFIG.crate.coins_max);
            
            contents.push({ type: "COIN", amount: coins });
            for (let c = 0; c < itemCount; c++) {
                const item = getWeightedRandom(PICKUPS_CONFIG.crate.contents);
                contents.push({ type: item.type, amount: item.amount, item_id: item.item_id, rarity: item.rarity });
            }
        } else {
            const item = getWeightedRandom(PICKUPS_CONFIG.contents);
            contents.push({ type: item.type, amount: item.amount, item_id: item.item_id, rarity: item.rarity });
        }

        formattedPickups.push({
            pickup_id: String(pickupId),
            placement: [Number(placement[0]), Number(placement[1])],
            contents: contents
        });
    }

    SpawnedItems.set(key, formattedPickups);
    return formattedPickups;
}

function populateRoomMorties(roomId) {
    const key = String(roomId);
    const shuffledPlacements = shuffleArray(WILD_MORTY_PLACEMENTS);
    const safeDate = new Date().toISOString();
    const formattedMorties = [];

    for (let i = 0; i < WILD_MORTIES_CONFIG.count; i++) {
        const placement = shuffledPlacements[i];
        const selected = getWeightedRandom(WILD_MORTIES_CONFIG.morties, 0);
        const wildMortyId = `wild_morty_${Date.now()}_${i}_${getRandomInt(100, 999)}`;

        formattedMorties.push({
            morty_id: String(selected.morty_id),
            placement: [Number(placement[0]), Number(placement[1])],
            state: "WORLD",
            division: getRandomInt(1, 4), // Matches schema range 1-4
            variant: "Normal",
            shiny_if_potion: Math.random() < 0.2, // Realistic shiny distribution
            _created: safeDate,
            _updated: safeDate,
            wild_morty_id: String(wildMortyId)
        });
    }

    SpawnedMorties.set(key, formattedMorties);
    return formattedMorties;
}

function respawnWildMorty(roomId, oldWildMortyId) {
    const key = String(roomId);
    let morties = SpawnedMorties.get(key) || [];

    // 1. Remove the defeated/caught Morty from memory
    morties = morties.filter(m => m.wild_morty_id !== oldWildMortyId);

    // 2. Pick a placement coordinates set not currently occupied by remaining Morties
    const usedPlacements = new Set(morties.map(m => `${m.placement[0]},${m.placement[1]}`));
    const availablePlacements = WILD_MORTY_PLACEMENTS.filter(
        p => !usedPlacements.has(`${p[0]},${p[1]}`)
    );

    // Fallback to full list if all coordinates are occupied
    const poolToPickFrom = availablePlacements.length > 0 ? availablePlacements : WILD_MORTY_PLACEMENTS;
    const placement = poolToPickFrom[Math.floor(Math.random() * poolToPickFrom.length)];

    // 3. Generate the replacement Morty
    const selected = getWeightedRandom(WILD_MORTIES_CONFIG.morties, 0);
    const safeDate = new Date().toISOString();
    const newWildMortyId = `wild_morty_${Date.now()}_${getRandomInt(100, 999)}`;

    const newMorty = {
        morty_id: String(selected.morty_id),
        placement: [Number(placement[0]), Number(placement[1])],
        state: "WORLD",
        division: getRandomInt(1, 4),
        variant: "Normal",
        shiny_if_potion: Math.random() < 0.2,
        _created: safeDate,
        _updated: safeDate,
        wild_morty_id: String(newWildMortyId)
    };

    // 4. Save back to memory map
    morties.push(newMorty);
    SpawnedMorties.set(key, morties);

    return newMorty;
}

function getOrPopulateRoomItems(roomId) {
    const key = String(roomId);
    return SpawnedItems.has(key) ? SpawnedItems.get(key) : populateRoomPickups(key);
}

function getOrPopulateRoomMorties(roomId) {
    const key = String(roomId);
    return SpawnedMorties.has(key) ? SpawnedMorties.get(key) : populateRoomMorties(key);
}

// Random spawn locations for bots
const BOT_PLACEMENTS = [
    [49, 84], [24, 76], [24, 57], [30, 45], [40, 60], 
    [15, 20], [60, 30], [55, 75]
];

// Array of possible bot avatars
const BOT_AVATARS = [
    "AvatarRickDefault", 
    "AvatarTycoonRick", // Replaced AvatarRickBusiness
    "AvatarCopRick",    // Fixed from AvatarRickCop
    "AvatarRickAqua", 
    "AvatarRickDoofus"
];

function populateRoomBots(roomId, playerLevel = 1) {
    const key = String(roomId);
    const bots = [];
    const botCount = 3; // Adjust how many bots you want per room
    const shuffledPlacements = shuffleArray(BOT_PLACEMENTS);

    for (let i = 0; i < botCount; i++) {
        const placement = shuffledPlacements[i % shuffledPlacements.length];
        const botId = `bot_${Date.now()}_${i}_${getRandomInt(1000, 9999)}`;
        
        // Fluctuate the bot's level slightly around the player's level (e.g., -1 to +2)
        const botLevel = Math.max(1, playerLevel + getRandomInt(-1, 2));
        
        // Give the bot 1 to 3 random Morties
        const numMorties = getRandomInt(1, 3);
        const owned_morties = [];
        
        for (let j = 0; j < numMorties; j++) {
            // Re-using your WILD_MORTIES_CONFIG pool
            const selectedMorty = getWeightedRandom(WILD_MORTIES_CONFIG.morties, 1);
            owned_morties.push({
                owned_morty_id: `bot_morty_${Date.now()}_${j}_${getRandomInt(100, 999)}`,
                morty_id: String(selectedMorty.morty_id),
                hp: 20 + (botLevel * 2), // Arbitrary HP scaling if the client relies on it
                variant: "Normal"
            });
        }

        bots.push({
            bot_id: botId,
            username: "Bot",
            player_avatar_id: BOT_AVATARS[getRandomInt(0, BOT_AVATARS.length - 1)],
            state: "WORLD",
            level: botLevel,
            owned_morties: owned_morties,
            shiny_if_potion: true,
            streak: 0,
            placement: [Number(placement[0]), Number(placement[1])]
        });
    }

    SpawnedBots.set(key, bots);
    return bots;
}

function getOrPopulateRoomBots(roomId, playerLevel = 1) {
    const key = String(roomId);
    return SpawnedBots.has(key) ? SpawnedBots.get(key) : populateRoomBots(key, playerLevel);
}

// --- SERVER-DRIVEN WORLD INITIALIZATION ---
async function initializeWorldRooms() {
    try {
        console.log(">>> Initializing world rooms and pre-spawning entities...");
        const [rooms] = await pool.execute("SELECT room_id FROM room_ids");
        
        for (const room of rooms) {
            const rId = String(room.room_id);
            // Server generates everything autonomously
            populateRoomPickups(rId);
            populateRoomMorties(rId);
            populateRoomBots(rId, 1); // Default level 1 baseline on boot
        }
        console.log(`>>> Successfully pre-spawned entities for ${rooms.length} rooms.`);
    } catch (err) {
        console.error(">>> Error during world room initialization:", err);
    }
}

initializeWorldRooms();

// Express health check endpoint 
app.get('/', (req, res) => { res.status(200).json(); });

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

// Clean stale database sessions (Players who haven't pinged or seen in 60 seconds)
setInterval(async () => {
    try {
        // 1. Fetch all players who are inside a valid room but haven't updated 'last_seen' in 60 seconds
        const [stalePlayers] = await pool.execute(`
            SELECT player_id, room_id 
            FROM users 
            WHERE room_id IS NOT NULL 
              AND room_id != '0' 
              AND room_id != '' 
              AND last_seen < NOW() - INTERVAL 60 SECOND
        `);

        for (const player of stalePlayers) {
            const player_id = String(player.player_id);
            const room_id = String(player.room_id);

            //console.log(`[Timeout!] Player ${player_id} has timed out from room ${room_id}.`);

// ============================================================
// RETURN ANY WILD MORTIES BELONGING TO THIS TIMED-OUT PLAYER
// ============================================================

if (typeof Battles !== 'undefined' && Battles instanceof Map) {

    for (const battle of Battles.keys()) {

        // Battles stores the entire battle object as the Map key
        if (!battle || typeof battle !== 'object') {
            continue;
        }

        // Only Wild Morty battles
        if (String(battle.battle_type || "") !== "PvWM") {
            continue;
        }

        const battlePlayerId = String(
            battle.meta?.player_id || ""
        );

        // This battle does not belong to the timed-out player
        if (battlePlayerId !== player_id) {
            continue;
        }

        const battleRoomId = String(
            battle.meta?.room_id || room_id
        );

        const wildMortyId = String(
            battle.meta?.wild_morty_id || ""
        );

        //console.log(`[Timeout!] Player ${player_id} had Wild Morty ${wildMortyId} ` + `in battle ${battle.battle_id}. Returning Morty to WORLD.`);

        // Get the Morties currently spawned in that room
        const roomMorties = SpawnedMorties.get(battleRoomId);

        if (roomMorties && wildMortyId) {

            const wildPayload = roomMorties.find(
                m => String(m.wild_morty_id) === wildMortyId
            );

            if (wildPayload) {

                // Return the Morty to the WORLD state
                wildPayload.state = "WORLD";
                wildPayload._updated = new Date().toISOString();

                SpawnedMorties.set(battleRoomId, roomMorties);

                // Notify everyone currently in the room
                await broadcastRoomSSE(
                    battleRoomId,
                    "room:wild-morty-state-changed",
                    {
                        wild_morty_id: wildMortyId,
                        state: "WORLD"
                    }
                );

                //console.log(`[Timeout!] Wild Morty ${wildMortyId} returned to WORLD ` + `in room ${battleRoomId}.`);

            } else {
                //console.warn(`[Timeout!] Wild Morty ${wildMortyId} was not found ` + `in room ${battleRoomId}.`);
            }
        }

        // Remove this battle from the Battles Map.
        // Because the battle object itself is the key:
        Battles.delete(battle);

        //console.log(`[Timeout!] Removed abandoned PvWM battle ${battle.battle_id}.`);
    }
}

            // ============================================================
            // 2. REMOVE THE PLAYER'S ROOM MAPPING / STATE
            // ============================================================

            await pool.execute(`
                UPDATE users 
                SET room_id = '', 
                    state = NULL 
                WHERE player_id = ?
            `, [player_id]);

            // ============================================================
            // 3. TELL OTHER PLAYERS THAT THIS PLAYER LEFT
            // ============================================================

            await broadcastRoomSSE(
                String(room_id),
                "room:user-removed",
                {
                    room_id: String(room_id),
                    player_id: String(player_id)
                },
                player_id
            );

            // ============================================================
            // 4. CLEAN UP SSE CONNECTION
            // ============================================================

            if (
                typeof activeSseConnections !== 'undefined' &&
                activeSseConnections.has(player_id)
            ) {
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

function broadcastRoomSSE(roomId, eventName, payload, excludePlayerId = null) {
    const data = typeof payload === "string"
        ? payload
        : JSON.stringify(payload);

    const roomConnections = activeRoomSseConnections.get(String(roomId));

    if (!roomConnections) {
        return;
    }

    for (const sseSend of roomConnections) {
        // Find which player owns this SSE connection
        let connectionPlayerId = null;

        for (const [playerId, connection] of activeSseConnections) {
            if (connection === sseSend) {
                connectionPlayerId = playerId;
                break;
            }
        }

        // Don't send the event to the player who triggered it
        if (
            excludePlayerId !== null &&
            String(connectionPlayerId) === String(excludePlayerId)
        ) {
            continue;
        }

        try {
            sseSend(eventName, data);
        } catch (err) {
            console.error(`SSE failed for ${connectionPlayerId}:`, err);
        }
    }
}

function sendPrivateSSE(playerId, eventName, payload) {
    const sseSend = activeSseConnections.get(String(playerId));

    if (!sseSend) {
        return false;
    }

    const data = typeof payload === "string"
        ? payload
        : JSON.stringify(payload);

    try {
        sseSend(eventName, data);
        return true;
    } catch (err) {
        console.error(`Private SSE failed for ${playerId}:`, err);
        return false;
    }
}

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

        const roomConnections = activeRoomSseConnections.get(room_id);

        if (roomConnections) {
            roomConnections.delete(sseSend);

            if (roomConnections.size === 0) {
                activeRoomSseConnections.delete(room_id);
            }
        }
    });

    // Room entry wait-stage loop
    while (connectionActive) {
        const [roomCheck] = await pool.execute("SELECT room_id FROM users WHERE player_id = ? LIMIT 1", [player_id]);
        room_id = roomCheck.length ? String(roomCheck[0].room_id) : "";

        if (room_id !== "" && room_id !== "0") break;

        await new Promise(resolve => setTimeout(resolve, 250));
    }

    if (!connectionActive || room_id === "" || room_id === "0") return res.end();
	
	if (!activeRoomSseConnections.has(room_id)) {
        activeRoomSseConnections.set(room_id, new Set());
    }
    activeRoomSseConnections.get(room_id).add(sseSend);

    let clientLastEventId = null;
    if (req.headers['last-event-id'] && /^\d+$/.test(req.headers['last-event-id'])) {
        clientLastEventId = parseInt(req.headers['last-event-id'], 10);
    } else if (req.query.since && /^\d+$/.test(String(req.query.since))) {
        clientLastEventId = parseInt(String(req.query.since), 10);
    }

    const isFreshConnect = (clientLastEventId === null);
    let last_id = 0;

    if (isFreshConnect) {
        // -----------------------------------------------------------
        // 1. FETCH CACHED/POPULATED ROOM PICKUPS FROM MAP
        // -----------------------------------------------------------
        const roomPickups = getOrPopulateRoomItems(room_id);
        
        roomPickups.forEach((pickup) => {
            sseSend("room:pickup-added", JSON.stringify({
                pickup_id: pickup.pickup_id,
                placement: pickup.placement,
                contents: pickup.contents
            }));
        });

        // -----------------------------------------------------------
        // 2. FETCH CACHED/POPULATED ROOM WILD MORTIES FROM MAP
        // -----------------------------------------------------------
        const roomMorties = getOrPopulateRoomMorties(room_id);
        
        roomMorties.forEach((morty) => {
            sseSend("room:wild-morty-added", JSON.stringify({
                morty_id: morty.morty_id,
                placement: morty.placement,
                state: morty.state || "WORLD",
                division: morty.division || 1,
                variant: morty.variant || "Normal",
                shiny_if_potion: Boolean(morty.shiny_if_potion),
                _created: morty._created || new Date().toISOString(),
                _updated: morty._updated || new Date().toISOString(),
                wild_morty_id: morty.wild_morty_id
            }));
        });

        // -----------------------------------------------------------
        // 3. FETCH CACHED/POPULATED BOTS FROM MAP
        // -----------------------------------------------------------
        const playerLevelForBots = parseInt(user.level || 1, 10);
        const roomBots = getOrPopulateRoomBots(room_id, playerLevelForBots);
        
        roomBots.forEach((b) => {
            sseSend("room:bot-added", JSON.stringify({
                username: b.username,
                player_avatar_id: b.player_avatar_id,
                state: b.state || "WORLD",
                level: b.level,
                owned_morties: b.owned_morties,
                streak: b.streak,
                bot_id: b.bot_id,
                placement: b.placement
            }));
        });

    } else {
        
    }
    // Core Event Streaming Loop
    while (connectionActive) {
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
		    pool.execute(`SELECT * FROM owned_morties WHERE player_id = ? ORDER BY owned_morty_id ASC`, [player_id]),
            pool.execute(`SELECT deck_id, owned_morty_ids FROM decks WHERE player_id = ?`, [player_id]),
            pool.execute(`SELECT item_id, quantity FROM owned_items WHERE player_id = ?`, [player_id]),
            pool.execute(`SELECT player_avatar_id FROM owned_avatars WHERE player_id = ? LIMIT 1`, [player_id]),
            pool.execute(`SELECT morty_id, caught FROM mortydex WHERE player_id = ?`, [player_id])
        ]);

        const mortyMap = new Map();

        for (const row of mortyRows) {

        let ownedAttacks = [];

        try {
            ownedAttacks = JSON.parse(row.attacks_array || "[]").map(a => ({
                attack_id: String(a.attack_id),
                position: parseInt(a.position),
                pp: parseInt(a.pp),
                pp_stat: parseInt(a.pp)
            }));
        } catch (e) {
            ownedAttacks = [];
        }

            mortyMap.set(row.owned_morty_id, {
                owned_morty_id: String(row.owned_morty_id),
                morty_id: String(row.morty_id),
                level: parseInt(row.level),
                xp: parseInt(row.xp),
                hp: parseInt(row.hp),
                hp_stat: parseInt(row.hp_stat),
                attack_stat: parseInt(row.attack_stat),
                defence_stat: parseInt(row.defence_stat),
                variant: row.variant,
                speed_stat: parseInt(row.speed_stat),
                is_locked: [1, '1', true, 'true'].includes(row.is_locked),
                is_trading_locked: [1, '1', true, 'true'].includes(row.is_trading_locked),
                fight_pit_id: (!row.fight_pit_id || row.fight_pit_id === 'null') ? null : row.fight_pit_id,
                evolution_points: parseInt(row.evolution_points),
                owned_attacks: ownedAttacks,
                xp_lower: parseInt(row.xp_lower),
                xp_upper: parseInt(row.xp_upper)
            });
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
            xp_lower: parseInt(user.xp_lower),
            xp_upper: parseInt(user.xp_upper)
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
        await broadcastRoomSSE(room_id, "emote:room", {
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
		
// ------------------------------------------------------------
// HANDLE PREVIOUS ROOM / ROOM CHANGE
// ------------------------------------------------------------

const [previousRoomRows] = await pool.execute(
    `SELECT room_id
     FROM users
     WHERE player_id = ?
     LIMIT 1`,
    [player_id]
);

const previousRoomId = previousRoomRows.length
    ? String(previousRoomRows[0].room_id || "")
    : "";

const newRoomId = String(room_id);

const playerSse = activeSseConnections.get(String(player_id));

if (
    previousRoomId !== "" &&
    previousRoomId !== "0"
) {
    // Tell the other players in the old room
    // that this player is leaving.
    broadcastRoomSSE(
        previousRoomId,
        "room:user-removed",
        {
            room_id: previousRoomId,
            player_id: String(player_id)
        },
        player_id
    );

    // --------------------------------------------------------
    // MOVING TO A DIFFERENT ROOM
    // --------------------------------------------------------

    if (previousRoomId !== newRoomId) {

        if (playerSse) {
            const oldConnections =
                activeRoomSseConnections.get(previousRoomId);

            if (oldConnections) {
                oldConnections.delete(playerSse);

                if (oldConnections.size === 0) {
                    activeRoomSseConnections.delete(previousRoomId);
                }
            }
        }

        //console.log(`[ROOM MOVE] ${player_id}: ${previousRoomId} -> ${newRoomId}`);
    }

    // --------------------------------------------------------
    // REJOINING THE SAME ROOM
    // --------------------------------------------------------

    else {
        //console.log(`[ROOM REJOIN] ${player_id} rejoining ${newRoomId}`);
    }
}

        await pool.execute(
            `UPDATE users SET room_id = ?, state = 'WORLD', last_seen = NOW() WHERE player_id = ?`,
            [room_id, player_id]
        );
		
		// ------------------------------------------------------------
// ENSURE PLAYER IS SUBSCRIBED TO THE NEW ROOM SSE
// ------------------------------------------------------------

if (playerSse) {
    if (!activeRoomSseConnections.has(newRoomId)) {
        activeRoomSseConnections.set(newRoomId, new Set());
    }

    activeRoomSseConnections
        .get(newRoomId)
        .add(playerSse);

    //console.log(`[SSE ROOM REGISTER] player=${player_id} room=${newRoomId}`);
}

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
			
			let currentPlacement;
			// edit spawns here when our player joins.
            if (player_id === u.player_id) {
                if (world_id_in == 1){
                    currentPlacement = [30, 35];
                } else if (world_id_in == 2){
                    currentPlacement = [21, 72];
                } else if (world_id_in == 3){
                    currentPlacement = [31, 50];
                } else if (world_id_in == 4){
                    currentPlacement = [31, 74];
                } else if (world_id_in == 5){
                    currentPlacement = [34, 15];
                } else if (world_id_in == 6){
                    currentPlacement = [49, 12];
                } else if (world_id_in == 7){
                    currentPlacement = [40, 84];
                }
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
                level: u.level,
                owned_morties: owned_morties,
                state: u.state
            });
        }

        const pickups = SpawnedItems.get(room_id) || populateRoomPickups(room_id);
        const wild_morties = SpawnedMorties.get(room_id) || populateRoomMorties(room_id);
        const bots = SpawnedBots.get(room_id) || populateRoomBots(room_id, parseInt(me.level || 1, 10));

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
		
        // --- BROADCAST PLAYER JOINED TO OTHER PLAYERS IN THE ROOM ---
        const joiningUser = users.find(u => String(u.player_id) === String(player_id));

        if (joiningUser) {
            let currentPlacement;

            if (world_id_in == 1) {
                currentPlacement = [30, 35];
            } else if (world_id_in == 2) {
                currentPlacement = [21, 72];
            } else if (world_id_in == 3) {
                currentPlacement = [31, 50];
            } else if (world_id_in == 4) {
                currentPlacement = [31, 74];
            } else if (world_id_in == 5) {
                currentPlacement = [34, 15];
            } else if (world_id_in == 6) {
                currentPlacement = [49, 12];
            } else if (world_id_in == 7) {
                currentPlacement = [40, 84];
            }

            const publishPayload = {
                room_id: String(room_id),
                player_id: String(joiningUser.player_id),
                username: joiningUser.username,
                player_avatar_id: joiningUser.player_avatar_id,
                level: joiningUser.level,
                owned_morties: joiningUser.owned_morties,
                state: joiningUser.state || "WORLD",
                shiny_if_potion: false,
                streak: 0,
                placement: currentPlacement
            };

           // Send to everyone in the room EXCEPT the player who just joined.
           broadcastRoomSSE(String(room_id), "room:user-added", publishPayload, String(player_id));
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
            await broadcastRoomSSE(String(room_id), "room:user-removed", { room_id: String(room_id), player_id: String(player_id) }, player_id);
			
			//console.log("room id: ", String(room_id), "room:user-removed", {  room_id: String(room_id), player_id: String(player_id) }, player_id);
            
            // Optional: If you want to explicitly wipe their room status in the DB upon leaving:
            await pool.execute("UPDATE users SET room_id = NULL, state = NULL WHERE player_id = ?", [player_id]);
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
                await broadcastRoomSSE(
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

// ============================================================================
// 📦 COLLECT PICKUP ROUTE (Removes old, generates & adds new to SpawnedItems)
// ============================================================================
app.post('/session/collect-pickup', async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const sessionId = req.body.session_id ? String(req.body.session_id) : "";
    const pickupId = req.body.pickup_id ? String(req.body.pickup_id) : "";

    if (!sessionId || !pickupId) {
        return res.status(400).json({ error: "Missing session_id or pickup_id" });
    }

    const connection = await pool.getConnection();

    try {
        await connection.beginTransaction();

        // 1. Resolve player and room context
        const [playerRows] = await connection.execute(`
            SELECT player_id, room_id FROM users 
            WHERE session_id = ? LIMIT 1 FOR UPDATE
        `, [sessionId]);

        if (!playerRows.length) {
            throw new Error("Invalid session");
        }

        const playerId = playerRows[0].player_id;
        const roomId = String(playerRows[0].room_id);

        // 2. Locate and remove the pickup from the in-memory SpawnedItems Map
        const roomItems = SpawnedItems.get(roomId);
        if (!roomItems) {
            throw new Error("Room items not found in memory");
        }

        let collectedPickup = null;

        if (roomItems instanceof Map) {
            collectedPickup = roomItems.get(pickupId);
            if (collectedPickup) {
                roomItems.delete(pickupId);
            }
        } else if (Array.isArray(roomItems)) {
            const index = roomItems.findIndex(p => String(p.pickup_id) === pickupId);
            if (index !== -1) {
                collectedPickup = roomItems[index];
                roomItems.splice(index, 1);
            }
        } else if (typeof roomItems === 'object') {
            collectedPickup = roomItems[pickupId];
            if (collectedPickup) {
                delete roomItems[pickupId];
            }
        }

        if (!collectedPickup) {
            throw new Error("Pickup already collected or missing");
        }

        const contents = collectedPickup.contents || [];

        // 3. Disburse items/currencies to player in DB (Fully checks existing stack limits & rows)
        const results = [];
        for (const reward of contents) {
            if (reward.type === "ITEM") {
                const itemResult = await grantItem(connection, playerId, reward.item_id, parseInt(reward.amount, 10));
                results.push(itemResult);
            } else if (reward.type === "COIN") {
                const coinResult = await grantCoins(connection, playerId, parseInt(reward.amount, 10));
                results.push(coinResult);
            }
        }

        // 4. Generate a brand new replacement pickup using your exact config rules
        const currentPlacements = [];
        if (roomItems instanceof Map) {
            for (const item of roomItems.values()) {
                if (item.placement) currentPlacements.push(item.placement.join(','));
            }
        } else if (Array.isArray(roomItems)) {
            for (const item of roomItems) {
                if (item.placement) currentPlacements.push(item.placement.join(','));
            }
        } else if (typeof roomItems === 'object') {
            for (const item of Object.values(roomItems)) {
                if (item.placement) currentPlacements.push(item.placement.join(','));
            }
        }

        const availablePlacements = PICKUP_PLACEMENTS.filter(p => !currentPlacements.includes(p.join(',')));
        const placementSource = availablePlacements.length > 0 ? availablePlacements : PICKUP_PLACEMENTS;
        const chosenPlacement = placementSource[Math.floor(Math.random() * placementSource.length)];

        const isCrate = Math.random() < PICKUPS_CONFIG.crate.probability;
        const newPickupId = `${isCrate ? 'crate' : 'pickup'}_${Date.now()}_${Math.floor(Math.random() * 1000)}_${getRandomInt(100, 999)}`;
        const newContents = [];

        if (isCrate) {
            const itemCount = getRandomInt(PICKUPS_CONFIG.crate.contains_min, PICKUPS_CONFIG.crate.contains_max);
            const coins = getRandomInt(PICKUPS_CONFIG.crate.coins_min, PICKUPS_CONFIG.crate.coins_max);
            
            newContents.push({ type: "COIN", amount: coins });
            for (let c = 0; c < itemCount; c++) {
                const item = getWeightedRandom(PICKUPS_CONFIG.crate.contents);
                newContents.push({ type: item.type, amount: item.amount, item_id: item.item_id, rarity: item.rarity });
            }
        } else {
            const item = getWeightedRandom(PICKUPS_CONFIG.contents);
            newContents.push({ type: item.type, amount: item.amount, item_id: item.item_id, rarity: item.rarity });
        }

        const newPickupPayload = {
            pickup_id: String(newPickupId),
            placement: [Number(chosenPlacement[0]), Number(chosenPlacement[1])],
            contents: newContents
        };

        // 5. Insert the new replacement pickup directly into the SpawnedItems Map
        if (roomItems instanceof Map) {
            roomItems.set(newPickupId, newPickupPayload);
        } else if (Array.isArray(roomItems)) {
            roomItems.push(newPickupPayload);
        } else if (typeof roomItems === 'object') {
            roomItems[newPickupId] = newPickupPayload;
        }

        // 6. Broadcast removal and addition marker payloads update messages
        await broadcastRoomSSE(roomId, "room:pickup-removed", {
            pickup_id: pickupId
        });

        await broadcastRoomSSE(roomId, "room:pickup-added", newPickupPayload);

        // Commit transaction atomic balance states across tables cleanly
        await connection.commit();

        return res.json({
            pickup_id: pickupId,
            contents: results
        });

    } catch (transactionError) {
        try {
            await connection.rollback();
        } catch (rollbackErr) {
            console.error("Rollback failed:", rollbackErr);
        }

        console.error(">>> [COLLECT PICKUP EXCEPTION]:", transactionError.message);
        return res.status(500).json({
            error: "Server error",
            detail: transactionError.message
        });
    } finally {
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

				const payloadStr = JSON.stringify(payload);
				
				// --- 2. IMMEDIATE REAL-TIME SSE EMIT ---
                const sseSend = activeSseConnections.get(player_id);
                if (sseSend) {
                    sseSend("shard:raid-boss-state-changed", payloadStr);
                }
				
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
		
		// Get Morties ONLY from the player's current room
        const roomMorties = SpawnedMorties.get(roomId) || [];

        const wildPayload = roomMorties.find(
            m => String(m.wild_morty_id) === String(wildMortyIdInput)
        );

        if (!wildPayload) {
            //console.log(`[PvWM] Morty ${wildMortyIdInput} does not exist in room ${roomId}`);

            return res.status(409).json({
                success: false,
                error: "Morty does not exist in this room"
            });
        }

        // Prevent battling an already-engaged Morty
        if (wildPayload.state !== "WORLD") {
            return res.status(409).json({
                success: false,
                error: "Morty is already in battle"
            });
        }

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

        if (deckMortyIds.length === 0) {
            deckMortyIds = [ownedMortiesRows[0].owned_morty_id];
        }

        // Compile attack profiles map grouped by owned instances
        const attacksByOwnedMorty = {};

        const ownedMortyIds = ownedMortiesRows.map(m => m.owned_morty_id);
        const placeholders = ownedMortyIds.map(() => '?').join(',');

        const [attackRows] = await pool.execute(`
            SELECT owned_morty_id, attacks_array
            FROM owned_morties
            WHERE owned_morty_id IN (${placeholders})
            ORDER BY owned_morty_id ASC
        `, ownedMortyIds);


        for (const a of attackRows) {
            const oid = a.owned_morty_id;

            attacksByOwnedMorty[oid] = [];

            try {
                let attacks = a.attacks_array || [];

                // MySQL JSON columns may already be objects
                if (typeof attacks === "string") {
                    attacks = JSON.parse(attacks);
                }

                for (const attack of attacks) {
                    attacksByOwnedMorty[oid].push({
                        attack_id: String(attack.attack_id),
                        position: parseInt(attack.position, 10),
                        pp: parseInt(attack.pp, 10),
                        pp_stat: parseInt(attack.pp_stat ?? attack.pp, 10)
                    });
                }

            } catch (err) {
                attacksByOwnedMorty[oid] = [];
            }
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
        const opponentHP = 20;

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

        // 10. Store Battle State in Memory Map instead of MySQL INSERT
        const battleId = crypto.randomUUID();
        const matchedActiveMorty = ownedMortiesPayloadArray.find(m => m.owned_morty_id === activeOwnedMorty);

        // 11. Broadcast operational synchronization signals
        const finalBroadcastPayload = {
            battle_id: battleId,
            battle_type: "PvWM",
            player: playerPayload,
            opponent: opponentPayload,
            meta: {
            player_id: playerId,
            room_id: roomId,
            wild_morty_id: wildMortyIdInput
            }
        };
        
        const payloadStr = JSON.stringify(finalBroadcastPayload);
        const sseSend = activeSseConnections.get(playerId);
        if (sseSend) {
            sseSend("battle:start", payloadStr);
        }
		
		Battles.set(finalBroadcastPayload);
            
        await broadcastRoomSSE(roomId, "room:wild-morty-state-changed", { wild_morty_id: wildMortyIdInput, state: "BATTLE" });

        // Immediately lock it in memory
        wildPayload.state = "BATTLE";
        wildPayload._updated = new Date().toISOString();

        SpawnedMorties.set(roomId, roomMorties);

        //console.log(`[PvWM] ${wildMortyIdInput} locked as BATTLE in room ${roomId}`);

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
		
		await broadcastRoomSSE(roomId, "room:user-state-changed", { player_id: playerId, state: "BATTLE" });

        // 4. Construct payload tracking the specific battle details
        const battlePayload = {
            battle_id: battleId,
            timeout: 30
        };

        // 6. Broadcast the clock frame to kick off the client UI clock tracking 
        await sendPrivateSSE(roomId, "battle:move-timer-started", battlePayload, playerId);

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
    const sessionId = req.body.session_id ? String(req.body.session_id) : "";
    const battleId = req.body.battle_id ? String(req.body.battle_id) : "";
    const type = req.body.type ? String(req.body.type) : "";
    const ownedMortyId = req.body.owned_morty_id ? String(req.body.owned_morty_id) : "";
    const moveId = req.body.move_id ? String(req.body.move_id) : "";

    if (!sessionId || !battleId || !type) {
        return res.status(400).json({
            success: false
        });
    }

    try {
        // ========================
        // PLAYER LOOKUP
        // ========================
        const [userRows] = await pool.execute(
            "SELECT player_id, username, player_avatar_id, level, room_id, active_deck_id FROM users WHERE session_id = ? LIMIT 1",
            [sessionId]
        );
        if (!userRows.length) {
            return res.status(401).json({
                success: false
            });
        }

        const playerId = userRows[0].player_id;
        const player_username = userRows[0].username;
        const player_avatar_id = userRows[0].player_avatar_id;
        const level = userRows[0].level;

        const roomId = userRows[0].room_id;
        const activeDeckId = userRows[0].active_deck_id;

        //console.log(">>> Incoming battle_id from request:", battleId);
        //console.log(">>> Current Battles keys in memory:", Array.from(Battles.keys()));
        //console.log(">>> Current Battles values in memory:", Array.from(Battles.values()));

        // ========================
        // RETRIEVE & VERIFY BATTLE
        // ========================
        const targetBattleId = req.body.battle_id || req.params.battle_id || battleId;
        let battle = null;

        // 1. Direct get if targetBattleId is used as a key
        if (targetBattleId && Battles.has(targetBattleId)) {
            battle = Battles.get(targetBattleId);
        }

        // 2. Search values where the object itself has battle_id
        if (!battle) {
            battle = Array.from(Battles.values()).find(b => b && (b.battle_id === targetBattleId || b.battle_id === battleId));
        }

        // 3. Search keys if keys are objects containing battle_id
        if (!battle) {
            for (const key of Battles.keys()) {
                if (key && typeof key === 'object' && (key.battle_id === targetBattleId || key.battle_id === battleId)) {
                    battle = Battles.get(key) || key;
                    break;
                }
            }
        }

        if (battle) {
            //console.log(">>> [BATTLE FOUND SUCCESSFULLY]:");
            //console.log("Player owned_morties:", JSON.stringify(battle.player?.owned_morties, null, 2));
            //console.log("Player owned_items:", JSON.stringify(battle.player?.owned_items, null, 2));
            //console.log("Opponent owned_morties:", JSON.stringify(battle.opponent?.owned_morties, null, 2));
        } else {
            //console.log(">>> Battle not found in memory!");
            return res.status(404).json({
                success: false,
                error: "Battle not found"
            });
        }

        // Security check: Verify the authenticated player owns this active battle
        const battlePlayerId = battle.player_id || (battle.player && battle.player.player_id);
        if (battlePlayerId && battlePlayerId !== playerId) {
            return res.status(403).json({
                success: false,
                error: "Unauthorized battle access"
            });
        }

        // Optional check: Ensure the battle is still active
        if (battle.state && battle.state !== "ACTIVE") {
            return res.status(400).json({
                success: false,
                error: "Battle is no longer active"
            });
        }

        if (battle.battle_type == "PvWM") {
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

            const aiMove = getAiMove();

            const opponentId = battle.opponent?.player_id;
            const wildOwnedMortyId = battle.opponent?.owned_morties?.[0]?.owned_morty_id;
            const wildMortyId = battle.opponent?.owned_morties?.[0]?.morty_id;

            let playerHp = battle.player?.owned_morties?.[0]?.hp;
            let enemyHp = battle.opponent?.owned_morties?.[0]?.hp;
			
			
			// Get Morties ONLY from the player's current room
			const roomMorties = SpawnedMorties.get(roomId) || [];

			const wildPayload = roomMorties.find(
                m => String(m.wild_morty_id) === String(wildOwnedMortyId)
			);

			if (!wildPayload) {
				//console.log(`[PvWM] Morty ${wildOwnedMortyId} does not exist in room ${roomId}`);
                return res.status(409).json({success: false,error: "Morty does not exist in this room"});
            }

            //console.log(">>> Opponent Player ID:", opponentId);
            //console.log(">>> Opponent Owned Morty ID:", wildOwnedMortyId);
            //console.log(">>> Wild Morty ID:", wildMortyId);

            // ------------------------
            // CASE A: ITEM (CATCH)
            // ------------------------
            if (type === "ITEM" && moveId === "ItemMortyChip") {
                const success = (Math.floor(Math.random() * 100) + 1) <= 50;

                // Retrieve updated item configuration
                const [itemRows] = await pool.execute(
                    "SELECT item_id, quantity FROM owned_items WHERE player_id = ?",
                    [playerId]
                );

                const ownedItems = itemRows.map(row => {
                    let qty = Number(row.quantity || 0);
                    if (row.item_id === moveId) {
                        qty = Math.max(0, qty - 1);
                    }
                    return {
                        item_id: row.item_id,
                        quantity: qty
                    };
                });

                turnDatas.push({
                    type: "ITEM",
                    attacker_player_id: playerId,
                    defender_player_id: opponentId,
                    item_id: moveId,
                    owned_morty_id: wildOwnedMortyId,
                    success: success
                });

                if (success) {
				    const key = String(roomId);
				    let roomMorties = SpawnedMorties.get(key) || [];

				    // 1. Remove the old wild Morty from memory
				    if (Array.isArray(roomMorties)) {
                        roomMorties = roomMorties.filter(m => m.wild_morty_id !== wildOwnedMortyId);
				    }

				    // 2. Determine non-overlapping placements
				    const currentPlacements = roomMorties.map(m => m.placement ? m.placement.join(',') : '');
				    const availablePlacements = WILD_MORTY_PLACEMENTS.filter(
                        p => !currentPlacements.includes(p.join(','))
				    );
				    const placementSource = availablePlacements.length > 0 ? availablePlacements : WILD_MORTY_PLACEMENTS;
				    const chosenPlacement = placementSource[Math.floor(Math.random() * placementSource.length)];

				    // 3. Construct new wild Morty payload
				    const selectedMorty = getWeightedRandom(WILD_MORTIES_CONFIG.morties, 0);
				    const safeDate = new Date().toISOString();
				    const newWildMortyId = `wild_morty_${Date.now()}_${getRandomInt(100, 999)}`;

				    const newWildMorty = {
                        morty_id: String(selectedMorty.morty_id),
                        placement: [Number(chosenPlacement[0]), Number(chosenPlacement[1])],
                        state: "WORLD",
                        division: getRandomInt(1, 4),
                        variant: "Normal",
                        shiny_if_potion: Math.random() < 0.2,
                        _created: safeDate,
                        _updated: safeDate,
                        wild_morty_id: String(newWildMortyId)
                    };

                    // 4. Update SpawnedMorties Map
                    roomMorties.push(newWildMorty);
                    SpawnedMorties.set(key, roomMorties);

                    // 5. Broadcast despawn & spawn events to the room
                    await broadcastRoomSSE(roomId, "room:wild-morty-removed", { wild_morty_id: wildOwnedMortyId });
                    await broadcastRoomSSE(roomId, "room:wild-morty-added", { wild_morty: newWildMorty });

                    outcome = "CAUGHT";
                    const newOwnedMortyId = crypto.randomUUID();

                    const newMorty = {
                        owned_morty_id: newOwnedMortyId,
                        player_id: playerId,
                        morty_id: wildMortyId,
                        level: 5,
                        xp: 250,
                        hp: 20,
                        hp_stat: 20,
                        attack_stat: 80,
                        defence_stat: 50,
                        speed_stat: 20,
                        variant: "Normal",
                        owned_attacks: [{
                                attack_id: "AttackFanArt",
                                pp: 5,
                                position: 0
                            },
                            {
                                attack_id: "AttackWetTongue",
                                pp: 5,
                                position: 1
                            },
                            {
                                attack_id: "AttackScratchAndSniff",
                                pp: 5,
                                position: 2
                            },
                            {
                                attack_id: "AttackLick",
                                pp: 18,
                                position: 3
                            }
                        ]
                    };

                    // Insert the caught Morty into your database table
                    await pool.execute(`INSERT INTO owned_morties (player_id, owned_morty_id, morty_id, level, xp, hp, hp_stat, attack_stat, defence_stat, speed_stat, variant, attacks_array) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [playerId, newMorty.owned_morty_id, newMorty.morty_id, newMorty.level, newMorty.xp, newMorty.hp, newMorty.hp_stat, newMorty.attack_stat, newMorty.defence_stat, newMorty.speed_stat, newMorty.variant, newMorty.owned_attacks]);

                    const [deckRows] = await pool.execute(`SELECT owned_morty_ids FROM decks WHERE player_id = ? AND deck_id = ?`, [playerId, activeDeckId]);

                    let activeDeckArray = [];
                    if (deckRows.length && deckRows[0].owned_morty_ids) {
                        try {
                            activeDeckArray = typeof deckRows[0].owned_morty_ids === 'string' ?
                                JSON.parse(deckRows[0].owned_morty_ids) :
                                deckRows[0].owned_morty_ids;
                        } catch (e) {
                            activeDeckArray = [];
                        }
                    }

                    const currentOwnedCount = Array.isArray(activeDeckArray) ? activeDeckArray.length : 0;
                    const MAX_DECK_LIMIT = 5;
                    const isDeckFull = currentOwnedCount >= MAX_DECK_LIMIT;

                    // 1. Push the new owned morty ID into the array if the deck is not full
                    if (!isDeckFull) {
                        activeDeckArray.push(newOwnedMortyId);

                        // 2. Update the decks table with the new JSON string array
                        await pool.execute(`UPDATE decks SET owned_morty_ids = ? WHERE player_id = ? AND deck_id = ?`, [JSON.stringify(activeDeckArray), playerId, activeDeckId]);

                        await broadcastRoomSSE(roomId, "room:user-modified", {
                            player_id: playerId,
                            username: player_username,
                            player_avatar_id: player_avatar_id,
                            level: level,
                            owned_morties: activeDeckArray,
                            state: "WORLD"
                        }, playerId);


                    }

                    await sendPrivateSSE(roomId, "battle:turn-result", {
                        battle_id: battleId,
                        outcome: "CAUGHT",
                        turn_datas: turnDatas,
                        player_datas: {
                            player: {
                                owned_items: ownedItems,
                                rewards: [{
                                    type: "MORTY",
                                    morty_id: wildMortyId,
                                    level: newMorty.level,
                                    added_to_active_deck: !isDeckFull,
                                    owned_morty_limit_reached: false,
                                    variant: "Normal",
                                    owned_morty: newMorty
                                }],
                                attacks_to_learn: [],
                                move_log: {
                                    cooldown: {
                                        ATTACK: 0,
                                        ITEM: 1
                                    },
                                    count: {
                                        ATTACK: 1,
                                        ITEM: 1
                                    },
                                    cooldown_next: {
                                        ITEM: 2
                                    },
                                    last_move_type: "ITEM"
                                }
                            },
                            opponent: {}
                        }
                    }, playerId);

                    // Side effects run sequentially at block terminal boundary
                } else {

                    const playerDamage = 20; // Fixed rand(20, 20)
                    const aiDamage = Math.floor(Math.random() * (3 - 1 + 1)) + 1;

                    const enemyHpAfter = Math.max(enemyHp - playerDamage, 0);
                    const playerHpAfter = Math.max(playerHp - aiDamage, 0);

                    turnDatas.push({
                        type: "ATTACK",
                        attacker_player_id: opponentId,
                        defender_player_id: playerId,
                        attack_id: aiMove,
                        element_modifier: 1,
                        effect_datas: [{
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
                        }],
                        attacker_morty_datas: [{
                            owned_morty_id: wildOwnedMortyId,
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
                }

                // Evaluates for standard CONTINUE status updates
                await sendPrivateSSE(roomId, "battle:turn-result", {
                    battle_id: battleId,
                    outcome: outcome,
                    turn_datas: turnDatas,
                    player_datas: {
                        player: {
                            owned_items: ownedItems,
                            move_log: {
                                cooldown: {
                                    ATTACK: 0
                                },
                                count: {
                                    ATTACK: turnDatas.length
                                },
                                cooldown_next: {
                                    ITEM: 1
                                },
                                last_move_type: type
                            }
                        },
                        opponent: {}
                    }
                }, playerId);


            }

            // ------------------------
            // CASE B: ATTACK ACTION
            // ------------------------
            if (type === "ATTACK") {
                const playerDamage = 20; // Fixed rand(20, 20)
                const aiDamage = Math.floor(Math.random() * (3 - 1 + 1)) + 1;

                const enemyHpAfter = Math.max(enemyHp - playerDamage, 0);
                const playerHpAfter = Math.max(playerHp - aiDamage, 0);

                // Step 1: Push Player Turn Event Sequence
                turnDatas.push({
                    type: "ATTACK",
                    attacker_player_id: playerId,
                    defender_player_id: opponentId,
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
                            owned_morty_id: wildOwnedMortyId,
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
                        attacker_player_id: opponentId,
                        defender_player_id: playerId,
                        attack_id: aiMove,
                        element_modifier: 1,
                        effect_datas: [{
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
                        }],
                        attacker_morty_datas: [{
                            owned_morty_id: wildOwnedMortyId,
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

                    await sendPrivateSSE(roomId, "battle:turn-result", {
                        battle_id: battleId,
                        outcome: outcome,
                        turn_datas: turnDatas,
                        player_datas: {
                            player: {
                                attacks_to_learn: [],
                                move_log: {
                                    cooldown: {
                                        ATTACK: 0,
                                        RUN: 0
                                    },
                                    count: {
                                        ATTACK: turnDatas.length,
                                        RUN: 1
                                    },
                                    cooldown_next: {
                                        ITEM: 1
                                    },
                                    last_move_type: type
                                }
                            },
                            opponent: {}
                        },
                        battle_abandoned: true
                    }, playerId);

                } else {
                    // Enemy eliminated -> Process Victory Calculation
                    outcome = "WIN";
                    const currentXpEarned = 0;
                    const xpEarned = 0;
                    const updateTotalXp = currentXpEarned + xpEarned;

                    xpDatas = [{
                        owned_morty_id: ownedMortyId,
                        xp_earned: 220,
                        owned_morty_datas: [{
                            level: 5,
                            xp: 210,
                            hp: playerHp,
                            hp_stat: 20,
                            attack_stat: 11,
                            defence_stat: 10,
                            speed_stat: 10,
                            variant: "Normal",
                            xp_lower: 0,
                            xp_upper: 220
                        }]
                    }];
                }
            }

            // ========================
            // COMMIT STATE TO STORAGE
            // ========================
            // Update in-memory map state for PvWM
            battle.player.owned_morties[0].hp = playerHp;
            battle.opponent.owned_morties[0].hp = enemyHp;

            // ========================
            // CONDITIONAL EMISSION PIPELINE
            // ========================
            if (type === "RUN") {
                // Immediately lock it in memory
                wildPayload.state = "WORLD";
                wildPayload._updated = new Date().toISOString();
				
                await sendPrivateSSE(roomId, "battle:turn-result", {
                    battle_id: battleId,
                    outcome: "RUN",
                    turn_datas: turnDatas,
                    player_datas: {
                        player: {
                            attacks_to_learn: [],
                            move_log: {
                                cooldown: {
                                    ATTACK: 0,
                                    RUN: 0
                                },
                                count: {
                                    ATTACK: turnDatas.length,
                                    RUN: 1
                                },
                                cooldown_next: {
                                    ITEM: 1
                                },
                                last_move_type: type
                            }
                        },
                        opponent: {}
                    },
                    battle_abandoned: true
                }, playerId);
				
				await broadcastRoomSSE(roomId, "room:wild-morty-state-changed", {
                    wild_morty_id: wildOwnedMortyId,
                    state: "WORLD"
                });
                await broadcastRoomSSE(roomId, "room:user-state-changed", {
                    player_id: playerId,
                    state: "WORLD"
                });

            }


            if (outcome === "WIN") {
                sendPrivateSSE(playerId, "battle:turn-result", {
                    battle_id: battleId,
                    outcome: "WIN",
                    turn_datas: turnDatas,
                    player_datas: {
                        player: {
                            player_xp_datas: {
                                streak: 0,
                                streak_old: 0,
                                xp_earned: 60,
                                xp_multiplier: 0,
                                player_datas: [{
                                    level: 1,
                                    xp: 60,
                                    xp_lower: 0,
                                    xp_upper: 64
                                }]
                            },
                            xp_datas: xpDatas,
                            rewards: [{
                                type: "ITEM",
                                item_id: "ItemCircuitBoard",
                                quantity: 10,
                                amount_received: 0,
                                amount: 1
                            }],
                            attacks_to_learn: [],
                            move_log: {
                                cooldown: {
                                    ATTACK: 0
                                },
                                count: {
                                    ATTACK: turnDatas.length
                                },
                                cooldown_next: {
                                    ITEM: 1
                                },
                                last_move_type: type
                            }
                        },
                        opponent: {}
                    }
                });

				const key = String(roomId);
                let roomMorties = SpawnedMorties.get(key) || [];

                // 1. Remove the old wild Morty from memory
                if (Array.isArray(roomMorties)) {
                    roomMorties = roomMorties.filter(m => m.wild_morty_id !== wildOwnedMortyId);
                }

                // 2. Determine non-overlapping placements
                const currentPlacements = roomMorties.map(m => m.placement ? m.placement.join(',') : '');
                const availablePlacements = WILD_MORTY_PLACEMENTS.filter(
                    p => !currentPlacements.includes(p.join(','))
                );
                const placementSource = availablePlacements.length > 0 ? availablePlacements : WILD_MORTY_PLACEMENTS;
                const chosenPlacement = placementSource[Math.floor(Math.random() * placementSource.length)];

                // 3. Construct new wild Morty payload
                const selectedMorty = getWeightedRandom(WILD_MORTIES_CONFIG.morties, 0);
                const safeDate = new Date().toISOString();
                const newWildMortyId = `wild_morty_${Date.now()}_${getRandomInt(100, 999)}`;

                const newWildMorty = {
                    morty_id: String(selectedMorty.morty_id),
                    placement: [Number(chosenPlacement[0]), Number(chosenPlacement[1])],
                    state: "WORLD",
                    division: getRandomInt(1, 4),
                    variant: "Normal",
                    shiny_if_potion: Math.random() < 0.2,
                    _created: safeDate,
                    _updated: safeDate,
                    wild_morty_id: String(newWildMortyId)
                };

                // 4. Update SpawnedMorties Map
                roomMorties.push(newWildMorty);
                SpawnedMorties.set(key, roomMorties);
				
				broadcastRoomSSE(roomId, "room:wild-morty-removed", { wild_morty_id: wildOwnedMortyId });
				broadcastRoomSSE(roomId, "room:wild-morty-added", { wild_morty: newWildMorty });
				broadcastRoomSSE(roomId, "room:user-state-changed", { player_id: playerId, state: "WORLD" });
            }

            // Post-Turn Cleanups for absolute resolution shifts (Lose / Caught)
            if (outcome === "LOSE") {
                // Immediately lock it in memory
                wildPayload.state = "WORLD";
                wildPayload._updated = new Date().toISOString();
				
                await broadcastRoomSSE(roomId, "room:wild-morty-state-changed", {
                    wild_morty_id: wildOwnedMortyId,
                    state: "WORLD"
                });
                await broadcastRoomSSE(roomId, "room:user-state-changed", {
                    player_id: playerId,
                    state: "WORLD"
                });
            }
			
			Battles.delete(battleId);
        } // end of PvWM battle

        // ========================
        // FINAL COMPONENT RESPONSE
        // ========================
        return res.json({
            success: true
        });

    } catch (err) {
        console.error(">>> [CRITICAL REEVALUATION ROUTE FAILURE]:", err);
        return res.status(500).json({
            success: false
        });
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

        const playerId = selfRows[0].player_id;
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
            SELECT player_id, username, player_avatar_id, level, active_deck_id, state, streak 
            FROM users 
            WHERE room_id = ? 
              AND last_seen >= (NOW() - INTERVAL 5 MINUTE)
        `, [roomId]);

        const usersPayload = [];

        if (activeUsers.length > 0) {
            // 1. Get all unique player_ids to bulk fetch their active decks
            const playerIds = activeUsers.map(u => u.player_id);
            const playerPlaceholders = playerIds.map(() => '?').join(',');

            // Fetch decks for these players
            const [decks] = await pool.execute(`
                SELECT player_id, deck_id, owned_morty_ids 
                FROM decks 
                WHERE player_id IN (${playerPlaceholders})
            `, playerIds);

            // Map deck list by `${player_id}_${deck_id}`
            const deckMap = {};
            for (const d of decks) {
                // Handle numerical 0 deck_id safely by converting to String
                const deckKey = `${d.player_id}_${String(d.deck_id)}`;
                deckMap[deckKey] = d.owned_morty_ids;
            }

            // 2. Extract owned_morty_ids for each player's active deck
            let allTargetMortyIds = [];
            const userDeckAssignments = activeUsers.map(u => {
                // active_deck_id can be 0, so convert explicitly to String
                const targetDeckId = u.active_deck_id !== null && u.active_deck_id !== undefined ? String(u.active_deck_id) : "0";
                const lookupKey = `${u.player_id}_${targetDeckId}`;
                const rawMortyIds = deckMap[lookupKey];

                let parsedIds = [];
                if (rawMortyIds) {
                    try {
                        // Handle JSON array format OR comma-separated string
                        parsedIds = typeof rawMortyIds === 'string' && rawMortyIds.trim().startsWith('[')
                            ? JSON.parse(rawMortyIds)
                            : String(rawMortyIds).split(',').map(id => id.trim()).filter(Boolean);

                        parsedIds = parsedIds.map(id => String(id));
                    } catch (e) {
                        parsedIds = [];
                    }
                }

                allTargetMortyIds = allTargetMortyIds.concat(parsedIds);
                return { user: u, mortyIds: parsedIds };
            });

            // 3. Bulk fetch Morties from owned_morties by owned_morty_id
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
                    // Key by player_id + owned_morty_id to prevent cross-player ID collisions
                    mortiesGlobalMap[`${m.player_id}_${m.owned_morty_id}`] = m;
                }
            }

            // 4. Construct response payload for each active user
            for (const assignment of userDeckAssignments) {
                const u = assignment.user;
                const userOwnedMorties = [];

                for (const targetOwnedMortyId of assignment.mortyIds) {
                    const m = mortiesGlobalMap[`${u.player_id}_${targetOwnedMortyId}`];
                    if (m) {
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

                // Look up live position for ANY user (self or other players in room) using u.player_id
                const livePos = livePlayerPositions.get(u.player_id);

                let currentPlacement;
                if (livePos) {
                    currentPlacement = [livePos.x, livePos.y];
                } else {
                    // Optional fallback spawn position if position hasn't been broadcasted yet
                    currentPlacement = [0, 0]; 
                }

                usersPayload.push({
                    player_id: u.player_id,
                    username: u.username,
                    player_avatar_id: u.player_avatar_id,
                    level: Number(u.level || 0),
                    owned_morties: userOwnedMorties,
                    state: u.state,
                    shiny_if_potion: false,
                    streak: u.streak,
                    placement: currentPlacement
                });
            }
        }

        const pickups = SpawnedItems.get(roomId) || populateRoomPickups(roomId);
        const wild_morties = SpawnedMorties.get(roomId) || populateRoomMorties(roomId);
        const bots = SpawnedBots.get(roomId) || populateRoomBots(roomId, parseInt(me.level || 1, 10));

        // --------------------------------------------------------------------
        // FINAL DISPATCH PIPELINE
        // --------------------------------------------------------------------
        return res.json({
            room_id: roomId,
            room_udp_host: room.room_udp_host,
            room_udp_port: String(room.room_udp_port || ""),
            world_id: String(room.world_id || ""),
            zone_id: room.zone_id,
            users: usersPayload,
            pickups: pickups,
            wild_morties: wild_morties,
            bots: bots
        });

    } catch (err) {
        console.error(">>> [ROOM DETAILS SYNC CRITICAL EXCEPTION]:", err);
        return res.status(500).json({ error: "Server error", detail: err.message });
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
            rewards: [{
                id: "AvatarFrank",
                amount: 1,
                type: "AVATAR",
                player_avatar_id: "AvatarFrank"
            }]
        });
        }
        if (dimension_id === '6') {
        return res.json({
            rewards: [{
                id: "AvatarDrXenonBloom",
                amount: 1,
                type: "AVATAR",
                player_avatar_id: "AvatarDrXenonBloom"
            }]
        });
        }
        if (dimension_id === '7') {
        return res.json({
            rewards: [{
                id: "AvatarBethTheDestroyer",
                amount: 1,
                type: "AVATAR",
                player_avatar_id: "AvatarBethTheDestroyer"
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
		
		// Check if users ip address already exists
        //const [useriPCheck] = await connection.execute('SELECT 1 FROM users WHERE created_with_ip = ?', [ip]);
        //if (useriPCheck.length > 0) {
        //    return res.status(400).json({
        //        error: { code: "USERNAME_LOGIN_ERROR" }
        //    });
        //}

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
                    INSERT INTO owned_morties (player_id, owned_morty_id, morty_id, level, xp, hp, hp_stat, attack_stat, defence_stat, variant, speed_stat, is_locked, is_trading_locked, fight_pit_id, evolution_points, xp_lower, xp_upper, attacks_array)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `, [player_id, owned_morty_id, 'MortyDefault', '5', '125', '20', '20', '11', '10', 'Normal', '10', '0', 'false', 'null', '0', '125', '216', '{"attack_id":"AttackOutburst","pp":12,"pp_stat":12,"position":0}']);

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
        
for (let morty of mortyRows) {

    let attacks = morty.attacks_array;

    // Convert string JSON to object if needed
    if (typeof attacks === "string") {
        try {
            attacks = JSON.parse(attacks);
        } catch (err) {
            attacks = null;
        }
    }

    // Wrap single attack object into array
    if (attacks && !Array.isArray(attacks)) {
        attacks = [attacks];
    }

    morty.owned_attacks = attacks || [];

    // Remove database field if you don't want it returned
    delete morty.attacks_array;
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


app.post('/session/challenge/list', async (req, res) => {
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    try {
        const query = `
            SELECT 
                challenge_id,
                target,
                reward_type,
                reward_amount,
                reward_id,
                reward_parameters,
                cooldown,
                is_daily,
                tag,
                tag_id,
                challange_name,
                progress,
                cooldown_expires,
                in_cooldown,
                end_time
            FROM challenges
        `;

        const [rows] = await pool.query(query);

        // Format MySQL values to match expected JSON types (booleans & ISO dates)
        const challenges = rows.map(row => ({
            challenge_id: row.challenge_id,
            target: row.target,
            reward_type: row.reward_type,
            reward_amount: row.reward_amount,
            reward_id: row.reward_id,
            reward_parameters: row.reward_parameters,
            cooldown: row.cooldown,
            is_daily: Boolean(row.is_daily),
            tag: row.tag,
            tag_id: row.tag_id,
            challange_name: row.challange_name,
            progress: row.progress,
            cooldown_expires: row.cooldown_expires ? new Date(row.cooldown_expires).toISOString() : null,
            in_cooldown: Boolean(row.in_cooldown),
            end_time: row.end_time ? new Date(row.end_time).toISOString() : null
        }));

        return res.status(200).json(challenges);
    } catch (error) {
        console.error('Error fetching challenges:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});

app.post('/session/challenge/claim-reward', async (req, res) => {
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    // Handle payload from headers or body
    const challenge_id = req.body?.challenge_id || req.headers['challenge_id'];
    const session_id = req.body?.session_id || req.headers['session_id'];

    if (!challenge_id || !session_id) {
        return res.status(400).json({ error: 'Missing challenge_id or session_id' });
    }

    try {
        // 1. Fetch challenge details from DB
        const [rows] = await pool.query(`SELECT * FROM challenges WHERE challenge_id = ?`,[challenge_id]);

        if (rows.length === 0) {
            return res.status(404).json({ error: 'Challenge not found' });
        }

        const challengeData = rows[0];

        // 2. Calculate cooldown expiration (e.g. current time + cooldown seconds)
        const now = Math.floor(Date.now() / 1000);
        const cooldownDuration = challengeData.cooldown || 86400; // default 24h if set to 0
        const cooldownExpires = now + cooldownDuration;

        // 3. Mark challenge as in cooldown in DB
        //await pool.query(`UPDATE challenges SET in_cooldown = 1, cooldown_expires = FROM_UNIXTIME(?) WHERE challenge_id = ?`,[cooldownExpires, challenge_id]);

        // 4. Determine total item quantity in user inventory (example logic)
        let totalQuantity = challengeData.reward_amount;
        if (challengeData.reward_type === 'ITEM' && challengeData.reward_id) {
            // Option to fetch existing user quantity from user inventory table:
            // const [inv] = await db.query(`SELECT quantity FROM user_items WHERE session_id = ? AND item_id = ?`, [session_id, challengeData.reward_id]);
            // totalQuantity = (inv[0]?.quantity || 0) + challengeData.reward_amount;
        }

        // 5. Construct payload matching exact client response format
        const responseData = {
            challenge: {
                challenge_id: challengeData.challenge_id,
                target: challengeData.target,
                reward_type: challengeData.reward_type,
                reward_amount: challengeData.reward_amount,
                reward_id: challengeData.reward_id,
                reward_parameters: challengeData.reward_parameters,
                cooldown: challengeData.cooldown,
                is_daily: Boolean(challengeData.is_daily),
                tag: challengeData.tag,
                tag_id: challengeData.tag_id,
                challange_name: challengeData.challange_name,
                progress: challengeData.progress,
                cooldown_expires: cooldownExpires,
                in_cooldown: true,
                end_time: challengeData.end_time ? new Date(challengeData.end_time).toISOString() : null
            },
            reward: {
                type: challengeData.reward_type,
                item_id: challengeData.reward_id,
                quantity: totalQuantity,
                amount_received: challengeData.reward_amount,
                amount: challengeData.reward_amount
            },
            challenge_reward: true
        };

        return res.status(200).json(responseData);

    } catch (error) {
        console.error('Error claiming challenge reward:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
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
		
		const SHOP_ITEMS = {
		    ItemShinyPotion: { currency: 'coupons', price: 5 },
		    ItemMortyChip: { currency: 'coins', price: 500 },
		    ItemSerum: { currency: 'coins', price: 250 },
		    ItemGreatSerum: { currency: 'coins', price: 500 },
		    ItemPoisonCure: { currency: 'coins', price: 500 },
		    ItemParalysisCure: { currency: 'coins', price: 500 },
		    ItemPlutonicRock: { currency: 'coins', price: 200 }
        };
		
		const shopItem = SHOP_ITEMS[item_id];
		
		if (!shopItem) {
		    return res.status(409).json({
                error: { code: "ITEM_NOT_AVAILABLE" }
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
		let coupons = user.coupons;
        let coins = user.coins;

        // Check if item already exists in inventory
        const [items] = await pool.execute(
            'SELECT quantity FROM owned_items WHERE player_id = ? AND item_id = ? LIMIT 1',
            [player_id, item_id]
        );

        const existingItem = items[0];

        // Check item limit BEFORE charging the player
        if (existingItem) {
            const current_qty = Number(existingItem.quantity);
            // Limit reached
            if (current_qty >= MAX_ITEM_LIMIT) {
                return res.status(409).json({
                    error: { code: "ITEM_LIMIT" }
                });
            }
        }

        // Charge player
        if (shopItem.currency === 'coupons') {

            if (coupons < shopItem.price) {
                return res.status(409).json({
                    error: { code: "NO_COUPON" }
                });
            }

            coupons -= shopItem.price;

        } else if (shopItem.currency === 'coins') {

            if (coins < shopItem.price) {
                return res.status(409).json({
                    error: { code: "NO_COIN" }
                });
            }

            coins -= shopItem.price;
        }

        // Save new currency balance
        await pool.execute(
            'UPDATE users SET coins = ?, coupons = ? WHERE player_id = ?',
            [coins, coupons, player_id]
        );

        let final_qty = 1;

        if (existingItem) {
            const current_qty = Number(existingItem.quantity);
			
            // Update quantity
            final_qty = Math.min(current_qty + 1, MAX_ITEM_LIMIT);
            await pool.execute('UPDATE owned_items SET quantity = ? WHERE player_id = ? AND item_id = ?', [final_qty, player_id, item_id]);
        } else {
            // Insert new item record
            await pool.execute('INSERT INTO owned_items (player_id, item_id, quantity) VALUES (?, ?, 1)',[player_id, item_id]);
            final_qty = 1;
        }

        // Success response
        return res.status(200).json({
            coins: coins,
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

    const parseAttacksArray = (rawAttacks) => {
        if (!rawAttacks) return [];
        let parsed = rawAttacks;
        if (typeof rawAttacks === 'string') {
            try {
                parsed = JSON.parse(rawAttacks);
            } catch (e) {
                return [];
            }
        }
        if (!Array.isArray(parsed)) return [];

        return parsed.map((a, idx) => {
            const maxPp = Number(a.pp_stat ?? a.max_pp ?? a.pp ?? 0);
            return {
                attack_id: String(a.attack_id || ''),
                pp: Number(a.pp ?? maxPp),
                pp_stat: maxPp,
                position: Number(a.position ?? idx)
            };
        });
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

        // 3a) Fetch current morties to read their JSON attacks_array
        const [rowsToHeal] = await connection.execute(
            `SELECT owned_morty_id, hp_stat, attacks_array FROM owned_morties WHERE player_id = ? AND owned_morty_id IN (${placeholders})`,
            [player_id, ...ownedIds]
        );

        // 3b) Update each Morty's HP to hp_stat and restore PP in attacks_array JSON array
        for (const row of rowsToHeal) {
            const attacks = parseAttacksArray(row.attacks_array);
            const healedAttacks = attacks.map(att => ({
                attack_id: att.attack_id,
                pp: att.pp_stat, // Restore PP to full
                pp_stat: att.pp_stat,
                position: att.position
            }));

            await connection.execute(
                `UPDATE owned_morties 
                 SET hp = hp_stat, attacks_array = ? 
                 WHERE player_id = ? AND owned_morty_id = ?`,
                [JSON.stringify(healedAttacks), player_id, row.owned_morty_id]
            );
        }

        await connection.commit();

        // 4) Fetch morties ordered by deck order
        const sqlMorties = `
            SELECT *
            FROM owned_morties
            WHERE player_id = ? AND owned_morty_id IN (${placeholders})
            ORDER BY FIELD(owned_morty_id, ${placeholders})
        `;
        const [morties] = await pool.execute(sqlMorties, [player_id, ...ownedIds, ...ownedIds]);

        // 5) Build owned_morties array maintaining deck order
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
                hp: Number(m.hp_stat), // Returns fully healed HP
                hp_stat: Number(m.hp_stat),
                attack_stat: Number(m.attack_stat),
                defence_stat: Number(m.defence_stat),
                variant: String(m.variant || "Normal"),
                speed_stat: Number(m.speed_stat),
                is_locked: toBool(m.is_locked),
                is_trading_locked: toBool(m.is_trading_locked),
                fight_pit_id: toNull(m.fight_pit_id),
                evolution_points: Number(m.evolution_points || 0),
                owned_attacks: parseAttacksArray(m.attacks_array).map(a => ({
                    attack_id: a.attack_id,
                    position: a.position,
                    pp: a.pp_stat, // Returns fully healed PP
                    pp_stat: a.pp_stat
                })),
                xp_lower: Number(m.xp_lower || 0),
                xp_upper: Number(m.xp_upper || 0)
            });
        }

        // 6) Output Player payload
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

// -------------------- INITIATE BOT BATTLE (PvB) --------------------
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
            SELECT owned_morty_id, attacks_array
            FROM owned_morties 
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
		
		const battleType = "PvB";

        await pool.execute(`
            INSERT INTO battles (
                battle_id, battle_type, player_id, bot_id, 
                opponent_active_morty, opponent_morty_id, opponent_hp, 
                player_active_morty, player_hp, state, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'ACTIVE', NOW())
        `, [
            battleId, battleType, playerId, botIdInput,
            opponentActiveMortyId, opponentMortyTemplateId, opponentHpValue,
            playerActiveMortyId, playerHpValue
        ]);

        // 12. Broadcast operational synchronization signals to SSE lines
        const finalBroadcastPayload = {
            battle_id: battleId,
            battle_type: battleType,
            player: playerPayload,
            opponent: opponentPayload,
            meta: {}
        };
        
        await sendPrivateSSE(roomId, "battle:start", finalBroadcastPayload, playerId);
        await broadcastRoomSSE(roomId, "room:bot-state-changed", { bot_id: botIdInput, state: "BATTLE" });
        //await broadcastRoomSSE(roomId, "room:user-state-changed", { player_id: playerId, state: "BATTLE" });

        return res.json({ success: true });
		
    } catch (err) {
        console.error(">>> [BATTLE BOT INITIATION CRITICAL ERROR]:", err);
        return res.status(500).json({ success: false, error: "Server error", detail: err.message });
    }
});

// -------------------- Anatomy Park FTUE1 PvCB --------------------
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

app.post('/session/battle-boss', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Accept-Encoding');

  // Express sets X-Powered-By: Express automatically by default,
  // but you can set it explicitly if needed:
  res.setHeader('X-Powered-By', 'Express');

  res.json({
    success: true
  });
});


// -------------------- PvF --------------------
app.post('/session/battle-invite/create', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('X-Powered-By', 'Express');

  try {
    const { session_id, opponent_player_id, battle_type } = req.body;

    if (!session_id || !opponent_player_id || !battle_type) {
      return res.status(400).json({ success: false, error: 'Missing required fields' });
    }

    // 1. Resolve active user session context and sender's active deck ID
    const [userRows] = await pool.execute(
        "SELECT player_id, username, player_avatar_id, level, room_id, active_deck_id FROM users WHERE session_id = ? LIMIT 1",
        [session_id]
    );
    if (!userRows.length) {
        return res.status(401).json({ success: false, error: "Not authenticated" });
    }

    const sender = userRows[0];
    const playerId = String(sender.player_id);
    const username = String(sender.username);
    const player_avatar_id = String(sender.player_avatar_id);
    const player_level = String(sender.level);
    const roomId = String(sender.room_id || "");

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

    // 3. Fetch opponent's user profile data and active_deck_id
    const [opponentRows] = await pool.execute(
        "SELECT player_id, username, player_avatar_id, level, active_deck_id FROM users WHERE player_id = ? LIMIT 1",
        [opponent_player_id]
    );
    if (!opponentRows.length) {
        return res.status(404).json({ success: false, error: "Opponent player not found" });
    }

    const opponent = opponentRows[0];

    // Robust helper with debugging logs to trace data flow
    const getMortiesFromActiveDeck = async (targetPlayerId, activeDeckId) => {
        //console.log(`[DEBUG] Looking up active_deck_id: ${activeDeckId} for player_id: ${targetPlayerId}`);
        
        if (activeDeckId === null || activeDeckId === undefined) {
            //console.log(`[DEBUG] active_deck_id is null/undefined for player ${targetPlayerId}`);
            return [];
        }

        // Grab the row from the decks table
        const [deckRows] = await pool.query(
            "SELECT owned_morty_ids FROM decks WHERE player_id = ? AND deck_id = ? LIMIT 1",
            [targetPlayerId, activeDeckId]
        );

        if (!deckRows.length) {
            //console.log(`[DEBUG] No deck found in 'decks' table for player_id: ${targetPlayerId} and deck_id: ${activeDeckId}`);
            return [];
        }

        //console.log(`[DEBUG] Raw deck row found:`, deckRows[0]);

        const rawIds = deckRows[0].owned_morty_ids;
        let mortyIdsArray = [];

        try {
            if (typeof rawIds === 'string') {
                // Try parsing as JSON first
                mortyIdsArray = JSON.parse(rawIds);
            } else if (Array.isArray(rawIds)) {
                mortyIdsArray = rawIds;
            }
        } catch (e) {
            // If JSON parse fails, fallback to comma separation or plain string conversion
            mortyIdsArray = String(rawIds).split(',').map(id => id.trim()).filter(Boolean);
        }

        if (!Array.isArray(mortyIdsArray)) {
            mortyIdsArray = [mortyIdsArray];
        }

        //console.log(`[DEBUG] Extracted owned_morty_ids array:`, mortyIdsArray);

        if (mortyIdsArray.length === 0) return [];

        const placeholders = mortyIdsArray.map(() => '?').join(',');

        // Query owned_morties matching the player and extracted IDs
        // Note: owned_morty_id is a text field in owned_morties, so we match against it
        const [morties] = await pool.query(
            `SELECT owned_morty_id, morty_id, hp, variant, is_locked, is_trading_locked, fight_pit_id 
             FROM owned_morties 
             WHERE player_id = ? AND owned_morty_id IN (${placeholders})`,
            [targetPlayerId, ...mortyIdsArray]
        );

        //console.log(`[DEBUG] Successfully fetched ${morties.length} morties from owned_morties`);
        return morties;
    };

    // Fetch opponent's exact active deck morties
    const opponentMortiesRows = await getMortiesFromActiveDeck(opponent_player_id, opponent.active_deck_id);

    // Fetch sender's exact active deck morties
    const senderMortiesRows = await getMortiesFromActiveDeck(playerId, sender.active_deck_id);

    // 4. Generate invite metadata
    const battleInviteId = uuidv4();
    const battleInviteTtl = 25; // seconds

    // 5. Generate the JWT token for the invite
    const tokenPayload = {
      from_player_id: playerId,
      to_player_id: opponent_player_id,
      battle_invite_id: battleInviteId,
      battle_type: battle_type
    };

    const token = jwt.sign(tokenPayload, process.env.JWT_SECRET || 'super_secret_battle_key_2026', { expiresIn: `${battleInviteTtl}s` });

    // 6. Construct HTTP response payload
    const payload = {
      battle_invite_id: battleInviteId,
      battle_invite_ttl: battleInviteTtl,
      to_player: {
        player_id: String(opponent.player_id),
        username: String(opponent.username),
        player_avatar_id: String(opponent.player_avatar_id),
        level: Number(opponent.level),
        owned_morties: opponentMortiesRows
      },
      token: token,
      battle_type: battle_type
    };

    // 7. Construct Event payload
    const eventpayload = {
      battle_invite_id: battleInviteId,
      battle_invite_ttl: battleInviteTtl,
      from_player: {
        player_id: String(playerId),
        username: String(username),
        player_avatar_id: String(player_avatar_id),
        level: Number(player_level),
        owned_morties: senderMortiesRows
      },
      token: token,
      battle_type: battle_type
    };

    // 8. Publish the event to the room
    await sendPrivateSSE(roomId, "battle-invite:received", eventpayload, opponent.player_id);

    // 9. Return the full structured payload to the HTTP response
    res.json(payload);

  } catch (error) {
    //console.error('Error creating battle invite:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/session/battle-invite/response', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Accept-Encoding');
  res.setHeader('X-Powered-By', 'Express');

  try {
    const { session_id, token, accept } = req.body;

    if (!session_id || !token || typeof accept !== 'boolean') {
      return res.status(400).json({ success: false, error: 'Missing required fields or invalid types' });
    }

    // 1. Verify and decode the JWT battle invite token
    let decodedToken;
    try {
      decodedToken = jwt.verify(token, process.env.JWT_SECRET || 'super_secret_battle_key_2026');
    } catch (err) {
      return res.status(401).json({ success: false, error: 'Invalid or expired battle invite token' });
    }

    const { from_player_id, to_player_id, battle_invite_id, battle_type } = decodedToken;

    // 2. Resolve the responding user (must be the recipient: to_player_id)
    const [userRows] = await pool.execute(
        "SELECT player_id, username, player_avatar_id, level, room_id FROM users WHERE session_id = ? LIMIT 1",
        [session_id]
    );
    if (!userRows.length) {
        return res.status(401).json({ success: false, error: "Not authenticated" });
    }

    const responder = userRows[0];
    const responderPlayerId = String(responder.player_id);
    const roomId = String(responder.room_id || "");

    // Verify that the user responding matches the intended target of the invite
    if (responderPlayerId !== String(to_player_id)) {
        return res.status(403).json({ success: false, error: "Unauthorized to respond to this invite" });
    }

    if (!roomId || roomId === "0") {
        return res.status(409).json({ success: false, error: "Player is not in a room" });
    }

    // 3. Fetch sender details for the event payload mapping
    const [senderRows] = await pool.execute(
        "SELECT player_id, username, player_avatar_id, level FROM users WHERE player_id = ? LIMIT 1",
        [from_player_id]
    );
    if (!senderRows.length) {
        return res.status(404).json({ success: false, error: "Inviting player not found" });
    }
    const sender = senderRows[0];

    // 4. Handle Acceptance vs Declination logic
    if (!accept) {
      // Publish decline event to the inviting player
      const declineEventPayload = {
        battle_invite_id: battle_invite_id
      };

      await sendPrivateSSE(roomId, "battle-invite:declined", declineEventPayload, from_player_id);

      return res.json({ success: true, accepted: false });
    }

    // If accepted: Publish accepted event back to the sender
    const acceptEventPayload = {
      battle_invite_id: battle_invite_id,
      battle_type: battle_type,
      opponent: {
        player_id: String(responder.player_id),
        username: String(responder.username)
      }
    };

    await sendPrivateSSE(roomId, "battle-invite:accepted", acceptEventPayload, from_player_id);

    // Return successful response to responder including opponent profile details
    res.json({
      success: true,
      accepted: true,
      battle_invite_id: battle_invite_id,
      battle_type: battle_type,
      opponent: {
        player_id: String(sender.player_id),
        username: String(sender.username)
      }
    });

  } catch (error) {
    console.error('Error handling battle invite response:', error);
    res.status(500).json({ success: false, error: 'Internal server error' });
  }
});

app.post('/session/battle-invite/revoke', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Vary', 'Accept-Encoding');

  // Express sets X-Powered-By: Express automatically by default,
  // but you can set it explicitly if needed:
  res.setHeader('X-Powered-By', 'Express');

  res.json({
    success: true
  });
});











app.post('/arena/events/list', (req, res) => {
    // 1. Set required HTTP headers matching the Pocket Mortys client expectations
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    // 2. Define active arena/event configuration
    // (You can move these values to your DB or a dynamic config file later)
    const eventConfig = {
        event_id: "daddb670-cdca-11ef-aa7c-d3a467998ef3",
        current_phase: "active",
        starting_energy: 100,
        energy_refill_time_minutes: 10,
        battle_energy_cost: 0,
        battle_premium_energy_cost: 0,
        max_regen_energy: 100,
        maintenance: false
    };

    // 3. Construct the response payload
    const responsePayload = {
        events: [
            {
                event_id: eventConfig.event_id,
                current_phase: eventConfig.current_phase,
                reward_time_remaining: 739971457,
                phase_time_remaining: 737971457,
                data_time: new Date().toISOString(),
                starting_energy: eventConfig.starting_energy,
                energy_refill_time_minutes: eventConfig.energy_refill_time_minutes,
                battle_energy_cost: eventConfig.battle_energy_cost,
                battle_premium_energy_cost: eventConfig.battle_premium_energy_cost,
                max_regen_energy: eventConfig.max_regen_energy,
                maintenance: eventConfig.maintenance
            }
        ]
    };

    // 4. Send response
    return res.status(200).json(responsePayload);
});



app.post('/arena/scores/list', async (req, res) => {
    // 1. Set standard response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const eventId = req.query.event_id || req.body?.event_id || "dace41f4-cdca-11ef-acec-8f82efc7517f";
    const currentPlayerId = req.headers['x-player-id'] || req.query.player_id || "dfd1bb4f-5a40-4841-ac32-d4ae2ba72b1f";
    const nowIso = new Date().toISOString();

    try {
        /* 
        // Example MySQL Query Structure:
        const [scoreRows] = await pool.execute(`
            SELECT 
                player_id, username, last_battle_time, avatar, level, 
                event_id, shard_id, score, streak, reward_rank, 
                team_json, rank_id, index_num, is_player, target
            FROM arena_leaderboard 
            WHERE event_id = ? 
            ORDER BY score DESC 
            LIMIT 50
        `, [eventId]);
        */

        // 2. Default/Mock Leaderboard Payload (matching your structure)
        const scoreResults = [
		    {
                player_id: currentPlayerId,
                username: "ConspiracyRick",
                last_battle_time: nowIso,
                avatar: "AvatarScroogeRick",
                level: 13,
                event_id: eventId,
                shard_id: 3,
                score: 9999,
                streak: 1,
                current_time: nowIso,
                reward_rank: 1,
                team_details: [],
                team: [
                    { id: "MortyOrangeShirt", variant: "Normal" },
                    { id: "MortySpace", variant: "Normal" },
                    { id: "MortyBossJerry", variant: "Normal" },
                    { id: "MortyHippie", variant: "Normal" },
                    { id: "MortyDragonsSweat", variant: "Shiny" }
                ],
                rank_id: 1,
                index: 2,
                is_player: true,
                target: 126
            },
            {
                player_id: "97ed62f6-db9c-4f4f-9db0-013b7bbf904d",
                username: "killingintheofna",
                last_battle_time: "2026-01-15T05:31:27.787Z",
                avatar: "AvatarRickGrunge",
                level: 2,
                event_id: eventId,
                shard_id: 3,
                score: 150,
                streak: 1,
                current_time: nowIso,
                reward_rank: 2,
                team_details: [],
                team: [
                    { id: "MortyDefault", variant: "Normal" },
                    { id: "MortySquid", variant: "Shiny" },
                    { id: "MortyDethklokFan", variant: "Normal" },
                    { id: "MortyFestival", variant: "Normal" },
                    { id: "MortyAsstManager", variant: "Normal" }
                ],
                rank_id: 2,
                index: 3
            },
            {
                player_id: "4f43e7e5-4381-4829-afd3-0d3c3d40c094",
                username: "MandatoryMilitar",
                last_battle_time: "2026-01-15T05:21:46.057Z",
                avatar: "AvatarRickSupremeGuard",
                level: 39,
                event_id: eventId,
                shard_id: 3,
                score: 150,
                streak: 1,
                current_time: nowIso,
                reward_rank: 3,
                team_details: [],
                team: [
                    { id: "MortyTheOneTrue", variant: "Normal" },
                    { id: "MortySeason4", variant: "Normal" },
                    { id: "MortyGotron", variant: "Normal" },
                    { id: "MortyGotron", variant: "Normal" },
                    { id: "MortyQueen", variant: "Normal" }
                ],
                rank_id: 3,
                index: 4
            }
        ];

        // Ensure current_time is dynamically synced for all results
        const updatedResults = scoreResults.map(entry => ({
            ...entry,
            current_time: nowIso
        }));

        // 3. Assemble full response object
        const responseData = {
            id: eventId,
            results: updatedResults,
            promotion_trophy_amount: 161,
            relegation_trophy_amount: 128
        };

        return res.status(200).json(responseData);

    } catch (err) {
        console.error("Error retrieving arena scores:", err);
        return res.status(500).json({ error: "Internal Server Error" });
    }
});


app.post('/arena/energy/fetch', async (req, res) => {
    // 1. Set standard response headers expected by Unity client
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    try {
        // Extract player ID from headers or request body
        const playerId = req.headers['x-player-id'] || req.body?.player_id;

        // Default values when energy is full
        let energyAmount = 100;
        let energyTime = null; // null indicates energy is at max capacity / not currently regenerating

        /* 
        // Example DB Integration Logic:
        if (playerId) {
            const [rows] = await pool.execute(
                `SELECT energy_amount, energy_time FROM player_arena_energy WHERE player_id = ?`,
                [playerId]
            );

            if (rows.length > 0) {
                energyAmount = rows[0].energy_amount;
                // energy_time represents ISO timestamp or Unix timestamp when next unit regenerates
                energyTime = rows[0].energy_time ? new Date(rows[0].energy_time).toISOString() : null;
            }
        }
        */

        // Construct response payload
        const responsePayload = {
            energy_amount: energyAmount,
            energy_time: energyTime
        };

        return res.status(200).json(responsePayload);

    } catch (err) {
        console.error("Error handling /arena/energy/fetch:", err);
        
        // Fallback response in case of database or parsing errors
        return res.status(200).json({
            energy_amount: 100,
            energy_time: null
        });
    }
});


app.post('/arena/rewards/list', (req, res) => {
    // 1. Set standard response headers matching client requirements
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    // 2. Define the rewards payload structure
    const rewardsPayload = {
        rewards: [
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 11,
                bracket_end: 50,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyBronzeAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 201,
                bracket_end: 400,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyStoneAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 651,
                bracket_end: 1000,
                base_quantity: 1,
                base_type: "COUPON",
                sort_order: 1,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 401,
                bracket_end: 650,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyStoneAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 101,
                bracket_end: 200,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyStoneAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1001,
                bracket_end: 1500,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 1,
                base_parameters: { ids: ["ItemSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 51,
                bracket_end: 100,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyBronzeAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1,
                bracket_end: 1,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyIronAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 3,
                bracket_end: 3,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyIronAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1501,
                bracket_end: 2000,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 1,
                base_parameters: { ids: ["ItemSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 2,
                bracket_end: 2,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyIronAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 4,
                bracket_end: 10,
                base_quantity: 1,
                base_type: "MORTY",
                sort_order: 1,
                base_parameters: { ids: ["MortyIronAge"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 3,
                bracket_end: 3,
                base_quantity: 4,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 101,
                bracket_end: 200,
                base_quantity: 2,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 201,
                bracket_end: 400,
                base_quantity: 2,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 2,
                bracket_end: 2,
                base_quantity: 5,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 401,
                bracket_end: 650,
                base_quantity: 3,
                base_type: "ITEM",
                sort_order: 2,
                base_parameters: { ids: ["ItemSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 401,
                bracket_end: 650,
                base_quantity: 1,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 4,
                bracket_end: 10,
                base_quantity: 3,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 51,
                bracket_end: 100,
                base_quantity: 2,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1,
                bracket_end: 1,
                base_quantity: 7,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 651,
                bracket_end: 1000,
                base_quantity: 2,
                base_type: "ITEM",
                sort_order: 2,
                base_parameters: { ids: ["ItemSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 11,
                bracket_end: 50,
                base_quantity: 3,
                base_type: "COUPON",
                sort_order: 2,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 101,
                bracket_end: 200,
                base_quantity: 2,
                base_type: "ITEM",
                sort_order: 2,
                base_parameters: { ids: ["ItemGreatSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1,
                bracket_end: 1,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 3,
                base_parameters: { ids: ["ItemSensationalSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 101,
                bracket_end: 200,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 3,
                base_parameters: { ids: ["ItemMegaSeedSpeed"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 11,
                bracket_end: 50,
                base_quantity: 3,
                base_type: "ITEM",
                sort_order: 3,
                base_parameters: { ids: ["ItemGreatSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 3,
                bracket_end: 3,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 3,
                base_parameters: { ids: ["ItemSensationalSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 51,
                bracket_end: 100,
                base_quantity: 2,
                base_type: "ITEM",
                sort_order: 3,
                base_parameters: { ids: ["ItemGreatSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 2,
                bracket_end: 2,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 3,
                base_parameters: { ids: ["ItemSensationalSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 201,
                bracket_end: 400,
                base_quantity: 2,
                base_type: "ITEM",
                sort_order: 3,
                base_parameters: { ids: ["ItemGreatSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 4,
                bracket_end: 10,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 4,
                base_parameters: { ids: ["ItemSensationalSerum"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 2,
                bracket_end: 2,
                base_quantity: 3,
                base_type: "ITEM",
                sort_order: 4,
                base_parameters: { ids: ["ItemMegaSeedSpeed"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 3,
                bracket_end: 3,
                base_quantity: 3,
                base_type: "ITEM",
                sort_order: 4,
                base_parameters: { ids: ["ItemMegaSeedSpeed"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 51,
                bracket_end: 100,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 4,
                base_parameters: { ids: ["ItemMegaSeedSpeed"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1,
                bracket_end: 1,
                base_quantity: 4,
                base_type: "ITEM",
                sort_order: 4,
                base_parameters: { ids: ["ItemMegaSeedSpeed"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 3,
                bracket_end: 3,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 5,
                base_parameters: { ids: ["ItemMegaSeedAttack"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 2,
                bracket_end: 2,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 5,
                base_parameters: { ids: ["ItemMegaSeedAttack"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 11,
                bracket_end: 50,
                base_quantity: 1,
                base_type: "ITEM",
                sort_order: 5,
                base_parameters: { ids: ["ItemMegaSeedSpeed"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1,
                bracket_end: 1,
                base_quantity: 2,
                base_type: "ITEM",
                sort_order: 5,
                base_parameters: { ids: ["ItemMegaSeedAttack"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 4,
                bracket_end: 10,
                base_quantity: 2,
                base_type: "ITEM",
                sort_order: 5,
                base_parameters: { ids: ["ItemMegaSeedSpeed"] }
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 101,
                bracket_end: 200,
                base_quantity: 900,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 4,
                bracket_end: 10,
                base_quantity: 1300,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 201,
                bracket_end: 400,
                base_quantity: 800,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 3501,
                bracket_end: 8000,
                base_quantity: 100,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 651,
                bracket_end: 1000,
                base_quantity: 600,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 2,
                bracket_end: 2,
                base_quantity: 1750,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 51,
                bracket_end: 100,
                base_quantity: 1000,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 11,
                bracket_end: 50,
                base_quantity: 1100,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 2501,
                bracket_end: 3500,
                base_quantity: 150,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1501,
                bracket_end: 2000,
                base_quantity: 400,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1,
                bracket_end: 1,
                base_quantity: 2000,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 2001,
                bracket_end: 2500,
                base_quantity: 200,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 1001,
                bracket_end: 1500,
                base_quantity: 500,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 401,
                bracket_end: 650,
                base_quantity: 700,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            },
            {
                rewards_name: "REWARDS_LIVE_Through_Ages_Morty",
                bracket_start: 3,
                bracket_end: 3,
                base_quantity: 1500,
                base_type: "COIN",
                sort_order: 1000,
                base_parameters: null
            }
        ]
    };

    // 3. Return JSON response
    return res.status(200).json(rewardsPayload);
});

app.post('/arena/rewards/pending/list', async (req, res) => {
    // 1. Set required headers matching client expectations
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    try {
        // Extract player ID from headers or request body
        const playerId = req.headers['x-player-id'] || req.body?.player_id;

        // Default: No pending rewards available
        let pendingRewards = [];

        /*
        // Optional Database Lookup Logic:
        if (playerId) {
            // Retrieve unclaimed rewards for the player, if any
            const [rows] = await pool.execute(
                `SELECT * FROM player_pending_arena_rewards WHERE player_id = ? AND claimed = 0`,
                [playerId]
            );
            
            // Map records if pending rewards exist
            pendingRewards = rows.map(reward => ({
                reward_id: reward.id,
                rewards_name: reward.rewards_name,
                base_type: reward.base_type,
                base_quantity: reward.base_quantity,
                base_parameters: reward.base_parameters ? JSON.parse(reward.base_parameters) : null
            }));
        }
        */

        return res.status(200).json({
            result: pendingRewards
        });

    } catch (err) {
        console.error("Error handling /arena/rewards/pending/list:", err);

        // Fallback safely to empty rewards list on error
        return res.status(200).json({
            result: []
        });
    }
});

app.post('/moving-mortys/events/list', async (req, res) => {
    // Set headers expected by the Unity client
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    try {
        // Return active event data or schedule for the next event
        const responsePayload = {
            event_data: [],
            next_event_active: "2026-08-30T14:00:00.000Z"
        };

        return res.status(200).json(responsePayload);

    } catch (err) {
        console.error("Error handling /moving-mortys/events/list:", err);

        return res.status(200).json({
            event_data: [],
            next_event_active: new Date().toISOString()
        });
    }
});

app.post('/inappdeletion/get-account-data-storage-time', (req, res) => {
    // 1. Set required HTTP response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    // 2. Return the JSON payload
    return res.status(200).json({
        time_anyUnits: 12
    });
});

app.post('/lte/fyre/events/list', (req, res) => {
    // Set standard game server response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    // Return empty JSON object
    return res.status(200).json({});
});

app.post('/event/pendingRewards', (req, res) => {
    // Set standard game server response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    // Return empty JSON object
    return res.status(200).json({});
});

// Helper function to validate UUID v4/v1 format
function isUuid(str) {
    if (typeof str !== 'string') return false;
    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    return uuidRegex.test(str);
}

app.post('/session/deck/edit', async (req, res) => {
    // 1. Set response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ success: false, error: "Invalid JSON" });
    }

    const sessionId = data.session_id || "";
    const deckId = data.deck_id;
    const list = data.owned_morty_ids;

    if (!sessionId) {
        return res.status(401).json({ success: false, error: "Not authenticated" });
    }
    if (typeof deckId !== 'number' || !Number.isInteger(deckId)) {
        return res.status(400).json({ success: false, error: "deck_id must be int" });
    }
    if (!Array.isArray(list)) {
        return res.status(400).json({ success: false, error: "owned_morty_ids must be array" });
    }

    try {
        // 2. Load user by session_id
        const [userRows] = await pool.execute(`
            SELECT player_id, username, player_avatar_id, level, xp, streak, active_deck_id, decks_owned, xp_lower, xp_upper, tags
            FROM users
            WHERE session_id = ?
            LIMIT 1
        `, [sessionId]);

        if (!userRows.length) {
            return res.status(401).json({ success: false, error: "Invalid session" });
        }

        const user = userRows[0];
        const playerId = user.player_id;
        const decksOwned = parseInt(user.decks_owned || 0, 10);

        if (decksOwned <= 0) {
            return res.status(409).json({ success: false, error: "Player has no decks_owned set" });
        }

        // 3. Validate deck_id range
        if (deckId < 0 || deckId >= decksOwned) {
            return res.status(409).json({
                success: false,
                error: "Invalid deck_id",
                deck_id: deckId,
                decks_owned: decksOwned
            });
        }

        // 4. Normalize list: strings only, trim, remove empties, dedupe (keep order)
        const seen = new Set();
        const ownedMortyIds = [];
        for (const item of list) {
            if (typeof item !== 'string') continue;
            const trimmed = item.trim();
            if (trimmed === "") continue;
            if (seen.has(trimmed)) continue;
            seen.add(trimmed);
            ownedMortyIds.push(trimmed);
        }

        // 5. Max deck size validation
        const MAX_DECK = 5;
        if (ownedMortyIds.length > MAX_DECK) {
            return res.status(409).json({ success: false, error: "Deck too large", max: MAX_DECK });
        }

        // 6. UUID format validation
        const bad = [];
        for (const id of ownedMortyIds) {
            if (!isUuid(id)) {
                bad.push({
                    raw: id,
                    len: id.length,
                    hex: Buffer.from(id, 'utf8').toString('hex')
                });
            }
        }

        if (bad.length > 0) {
            return res.status(409).json({
                success: false,
                error: "Invalid owned_morty_id format",
                invalid: bad
            });
        }

        // 7. Transactional DB Updates
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();

            if (ownedMortyIds.length === 0) {
                // Delete deck row when array is empty
                await connection.execute(
                    "DELETE FROM decks WHERE player_id = ? AND deck_id = ?",
                    [playerId, deckId]
                );
            } else {
                // Verify ownership in owned_morties table
                const placeholders = ownedMortyIds.map(() => '?').join(',');
                const queryParams = [playerId, ...ownedMortyIds];

                const [foundRows] = await connection.execute(`
                    SELECT owned_morty_id
                    FROM owned_morties
                    WHERE player_id = ?
                      AND owned_morty_id IN (${placeholders})
                `, queryParams);

                const foundSet = new Set(foundRows.map(r => r.owned_morty_id));
                const missing = ownedMortyIds.filter(id => !foundSet.has(id));

                if (missing.length > 0) {
                    await connection.rollback();
                    connection.release();
                    return res.status(409).json({
                        success: false,
                        error: "Owned morty not found for player",
                        missing: missing
                    });
                }

                // Prepare JSON string
                const deckJson = JSON.stringify(ownedMortyIds);

                // Check existence for Upsert logic
                const [existsRows] = await connection.execute(
                    "SELECT id FROM decks WHERE player_id = ? AND deck_id = ? LIMIT 1",
                    [playerId, deckId]
                );

                if (existsRows.length > 0) {
                    await connection.execute(
                        "UPDATE decks SET owned_morty_ids = ? WHERE id = ?",
                        [deckJson, existsRows[0].id]
                    );
                } else {
                    await connection.execute(
                        "INSERT INTO decks (player_id, deck_id, owned_morty_ids) VALUES (?, ?, ?)",
                        [playerId, deckId, deckJson]
                    );
                }

                // Update active deck on user record
                await connection.execute(
                    "UPDATE users SET active_deck_id = ? WHERE session_id = ?",
                    [deckId, sessionId]
                );

                user.active_deck_id = deckId;
            }

            await connection.commit();
            connection.release();
        } catch (txErr) {
            await connection.rollback();
            connection.release();
            throw txErr;
        }

        // 8. Reload decks for JSON response
        const [deckRows] = await pool.execute(`
            SELECT deck_id, owned_morty_ids
            FROM decks
            WHERE player_id = ?
            ORDER BY deck_id ASC
        `, [playerId]);

        const decks = [];
        for (const r of deckRows) {
            let ids = [];
            try {
                ids = typeof r.owned_morty_ids === 'string' ? JSON.parse(r.owned_morty_ids) : (r.owned_morty_ids || []);
            } catch (e) {
                ids = [];
            }

            if (!Array.isArray(ids) || ids.length === 0) continue;

            decks.push({
                deck_id: parseInt(r.deck_id, 10),
                owned_morty_ids: ids
            });
        }

        // Decode tags
        let tags = [];
        if (user.tags) {
            try {
                const parsedTags = typeof user.tags === 'string' ? JSON.parse(user.tags) : user.tags;
                if (Array.isArray(parsedTags)) tags = parsedTags;
            } catch (e) {
                tags = [];
            }
        }

        // 9. Send response
        return res.status(200).json({
            player_id: playerId,
            username: user.username,
            player_avatar_id: user.player_avatar_id,
            level: parseInt(user.level),
            xp: parseInt(user.xp),
            streak: parseInt(user.streak),
            active_deck_id: parseInt(user.active_deck_id),
            decks_owned: decksOwned,
            decks: decks,
            xp_lower: parseInt(user.xp_lower),
            xp_upper: parseInt(user.xp_upper),
            tags: tags
        });

    } catch (err) {
        console.error(">>> [EDIT DECK CRITICAL ERROR]:", err);
        return res.status(500).json({
            success: false,
            error: "Server error",
            detail: err.message
        });
    }
});

app.post('/session/deck/set-active', async (req, res) => {
    // 1. Set response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ success: false, error: "Invalid JSON" });
    }

    const sessionId = data.session_id || "";
    const deckId = data.deck_id;

    if (!sessionId) {
        return res.status(401).json({ success: false, error: "Not authenticated" });
    }
    if (typeof deckId !== 'number' || !Number.isInteger(deckId)) {
        return res.status(400).json({ success: false, error: "deck_id must be int" });
    }

    try {
        // 2. Load user by session_id
        const [userRows] = await pool.execute(`
            SELECT player_id, username, player_avatar_id, level, xp, streak, active_deck_id, decks_owned, xp_lower, xp_upper, tags
            FROM users
            WHERE session_id = ?
            LIMIT 1
        `, [sessionId]);

        if (!userRows.length) {
            return res.status(401).json({ success: false, error: "Invalid session" });
        }

        const user = userRows[0];
        const playerId = user.player_id;
        const decksOwned = parseInt(user.decks_owned || 0, 10);

        // 3. Validate deck_id bounds against decks_owned
        if (deckId < 0 || deckId >= decksOwned) {
            return res.status(409).json({
                success: false,
                error: "Invalid deck_id",
                deck_id: deckId,
                decks_owned: decksOwned
            });
        }

        // 4. Verify the target deck exists and is not empty
        const [deckRows] = await pool.execute(`
            SELECT owned_morty_ids
            FROM decks
            WHERE player_id = ? AND deck_id = ?
            LIMIT 1
        `, [playerId, deckId]);

        if (!deckRows.length) {
            return res.status(409).json({ success: false, error: "Deck does not exist", deck_id: deckId });
        }

        let ids = [];
        try {
            ids = typeof deckRows[0].owned_morty_ids === 'string' 
                ? JSON.parse(deckRows[0].owned_morty_ids) 
                : (deckRows[0].owned_morty_ids || []);
        } catch (e) {
            ids = [];
        }

        if (!Array.isArray(ids) || ids.length === 0) {
            return res.status(409).json({ success: false, error: "Cannot activate empty deck", deck_id: deckId });
        }

        // 5. Update user's active deck
        await pool.execute(
            "UPDATE users SET active_deck_id = ? WHERE session_id = ?",
            [deckId, sessionId]
        );

        user.active_deck_id = deckId;

        // 6. Build non-empty decks list for final payload
        const [allDeckRows] = await pool.execute(`
            SELECT deck_id, owned_morty_ids
            FROM decks
            WHERE player_id = ?
            ORDER BY deck_id ASC
        `, [playerId]);

        const decks = [];
        for (const r of allDeckRows) {
            let list = [];
            try {
                list = typeof r.owned_morty_ids === 'string' ? JSON.parse(r.owned_morty_ids) : (r.owned_morty_ids || []);
            } catch (e) {
                list = [];
            }

            if (!Array.isArray(list) || list.length === 0) continue;

            decks.push({
                deck_id: parseInt(r.deck_id, 10),
                owned_morty_ids: list
            });
        }

        // 7. Decode tags safely
        let tags = [];
        if (user.tags) {
            try {
                const parsedTags = typeof user.tags === 'string' ? JSON.parse(user.tags) : user.tags;
                if (Array.isArray(parsedTags)) tags = parsedTags;
            } catch (e) {
                tags = [];
            }
        }

        // 8. Return response object
        return res.status(200).json({
            player_id: playerId,
            username: user.username,
            player_avatar_id: user.player_avatar_id,
            level: parseInt(user.level, 10),
            xp: parseInt(user.xp, 10),
            streak: parseInt(user.streak, 10),
            active_deck_id: parseInt(user.active_deck_id, 10),
            decks_owned: decksOwned,
            decks: decks,
            xp_lower: parseInt(user.xp_lower || 0, 10),
            xp_upper: parseInt(user.xp_upper || 0, 10),
            tags: tags
        });

    } catch (err) {
        console.error(">>> [SET ACTIVE DECK CRITICAL ERROR]:", err);
        return res.status(500).json({
            success: false,
            error: "Server error",
            detail: err.message
        });
    }
});


app.post('/session/incentive/reject', async (req, res) => {
    // Match the headers from your PHP script
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');

    const session_id = req.body.session_id ? String(req.body.session_id) : '';

    // Validation check
    if (session_id === '') {
        return res.status(400).json({
            error: { code: "BAD_REQUEST" }
        });
    }

    try {
        // 1. Validate user via session
        const user = await requireUserBySession(session_id);
        const player_id = user.player_id;

        // 4. Success payload response
        return res.json({
            item_id: "ItemMrMeeseek"
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

app.post('/session/owned_morties/learn-attacks', async (req, res) => {
    // 1. Set response headers
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const data = req.body;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return res.status(400).json({ error: { code: "BAD_REQUEST" } });
    }

    const sessionId = String(data.session_id || '');
    const morties = Array.isArray(data.owned_morties) ? data.owned_morties : [];

    if (sessionId === '' || morties.length === 0) {
        return res.status(400).json({ error: { code: "BAD_REQUEST" } });
    }

    try {
        // ============================
        // 🔐 AUTH
        // ============================
        const [userRows] = await pool.execute(`
            SELECT * FROM users WHERE session_id = ? LIMIT 1
        `, [sessionId]);

        if (!userRows.length) {
            return res.status(401).json({ error: { code: "NOT_AUTHENTICATED" } });
        }

        const user = userRows[0];
        const playerId = user.player_id;

        // ============================
        // 🔥 PROCESS + TRACK UPDATED
        // ============================
        const updatedIds = [];
        const connection = await pool.getConnection();

        try {
            await connection.beginTransaction();

            for (const m of morties) {
                if (!m || typeof m !== 'object') continue;

                const ownedMortyId = String(m.owned_morty_id || '');
                let attackIds = Array.isArray(m.attack_ids) ? m.attack_ids : [];

                if (ownedMortyId === '' || attackIds.length === 0) continue;

                // Limit to 4 attacks (game behavior)
                attackIds = attackIds.slice(0, 4);

                // Verify ownership
                const [checkRows] = await connection.execute(`
                    SELECT owned_morty_id 
                    FROM owned_morties 
                    WHERE owned_morty_id = ? AND player_id = ?
                    LIMIT 1
                `, [ownedMortyId, playerId]);

                if (!checkRows.length) continue;

                // Build JSON structure filtering out null / empty attack slots
                const attacksArray = [];
                let slotIndex = 0;

                for (const rawAttackId of attackIds) {
                    if (rawAttackId !== null && rawAttackId !== undefined && String(rawAttackId).trim() !== '') {
                        attacksArray.push({
                            attack_id: String(rawAttackId),
                            pp: 12,
                            pp_stat: 12,
                            position: slotIndex
                        });
                        slotIndex++;
                    }
                }

                // Update attacks_array directly on owned_morties table
                await connection.execute(`
                    UPDATE owned_morties 
                    SET attacks_array = ?
                    WHERE owned_morty_id = ? AND player_id = ?
                `, [JSON.stringify(attacksArray), ownedMortyId, playerId]);

                updatedIds.push(ownedMortyId);
            }

            await connection.commit();
            connection.release();
        } catch (txErr) {
            await connection.rollback();
            connection.release();
            throw txErr;
        }

        // ============================
        // 🔥 FETCH ONLY UPDATED MORTIES
        // ============================
        if (updatedIds.length === 0) {
            return res.status(200).json({
                player_id: user.player_id,
                username: user.username,
                player_avatar_id: user.player_avatar_id || "AvatarRickDefault",
                level: parseInt(user.level, 10),
                xp: parseInt(user.xp, 10),
                streak: parseInt(user.streak, 10),
                coins: parseInt(user.coins, 10),
                coupons: parseInt(user.coupons, 10),
                permits: parseInt(user.permits, 10),
                owned_morties: [],
                xp_lower: parseInt(user.xp_lower, 10),
                xp_upper: parseInt(user.xp_upper, 10),
                tags: []
            });
        }

        const placeholders = updatedIds.map(() => '?').join(',');
        const queryParams = [playerId, ...updatedIds];

        const [rows] = await pool.execute(`
            SELECT *
            FROM owned_morties
            WHERE player_id = ?
              AND owned_morty_id IN (${placeholders})
        `, queryParams);

        // ============================
        // 🔥 BUILD RESPONSE
        // ============================
        const ownedMorties = rows.map(row => {
            let attacks = [];
            if (row.attacks_array) {
                try {
                    attacks = typeof row.attacks_array === 'string' 
                        ? JSON.parse(row.attacks_array) 
                        : row.attacks_array;
                } catch (e) {
                    attacks = [];
                }
            }

            return {
                owned_morty_id: row.owned_morty_id,
                morty_id: row.morty_id,
                level: parseInt(row.level, 10),
                xp: parseInt(row.xp, 10),
                hp: parseInt(row.hp, 10),
                hp_stat: parseInt(row.hp_stat, 10),
                attack_stat: parseInt(row.attack_stat, 10),
                defence_stat: parseInt(row.defence_stat, 10),
                variant: row.variant || "Normal",
                speed_stat: parseInt(row.speed_stat, 10),
                is_locked: Boolean(row.is_locked),
                is_trading_locked: Boolean(row.is_trading_locked),
                fight_pit_id: row.fight_pit_id ? row.fight_pit_id : null,
                evolution_points: parseInt(row.evolution_points, 10),
                xp_lower: parseInt(row.xp_lower, 10),
                xp_upper: parseInt(row.xp_upper, 10),
                owned_attacks: Array.isArray(attacks) ? attacks : []
            };
        });

        // ============================
        // 🔥 FINAL RESPONSE
        // ============================
        return res.status(200).json({
            player_id: user.player_id,
            username: user.username,
            player_avatar_id: user.player_avatar_id || "AvatarRickDefault",
            level: parseInt(user.level, 10),
            xp: parseInt(user.xp, 10),
            streak: parseInt(user.streak, 10),
            coins: parseInt(user.coins, 10),
            coupons: parseInt(user.coupons, 10),
            permits: parseInt(user.permits, 10),
            owned_morties: ownedMorties,
            xp_lower: parseInt(user.xp_lower, 10),
            xp_upper: parseInt(user.xp_upper, 10),
            tags: []
        });

    } catch (err) {
        console.error(">>> [LEARN ATTACKS CRITICAL ERROR]:", err);
        return res.status(500).json({
            error: { code: "SERVER_ERROR" }
        });
    }
});


const recipes = [
    {
        recipe_id: "RecipeMortyChip",
        item_id_1: "ItemSuperchargedBattery",
        item_id_2: "ItemCircuitBoard",
        item_id_3: "ItemTinCan",
        resultid: "ItemMortyChip"
    },
    {
        recipe_id: "RecipeSerum",
        item_id_1: "ItemBattery",
        item_id_2: "ItemFleeb",
        item_id_3: "",
        resultid: "ItemSerum"
    },
    {
        recipe_id: "RecipeGreatSerum",
        item_id_1: "ItemBattery",
        item_id_2: "ItemPureFleeb",
        item_id_3: "",
        resultid: "ItemGreatSerum"
    },
    {
        recipe_id: "RecipeSensationalSerum",
        item_id_1: "ItemSuperchargedBattery",
        item_id_2: "ItemSerum",
        item_id_3: "",
        resultid: "ItemSensationalSerum"
    },
    {
        recipe_id: "RecipePureSerum",
        item_id_1: "ItemSuperchargedBattery",
        item_id_2: "ItemGreatSerum",
        item_id_3: "",
        resultid: "ItemPureSerum"
    },
    {
        recipe_id: "RecipeHalzinger",
        item_id_1: "ItemBattery",
        item_id_2: "ItemFleeb",
        item_id_3: "ItemBacteriaCell",
        resultid: "ItemHalzinger"
    },
    {
        recipe_id: "RecipePureHalzinger",
        item_id_1: "ItemBattery",
        item_id_2: "ItemPureFleeb",
        item_id_3: "ItemMutantBacteriaCell",
        resultid: "ItemPureHalzinger"
    },
    {
        recipe_id: "RecipePoisonCure",
        item_id_1: "ItemTinCan",
        item_id_2: "ItemBacteriaCell",
        item_id_3: "ItemDarkEnergyBall",
        resultid: "ItemPoisonCure"
    },
    {
        recipe_id: "RecipeParalysisCure",
        item_id_1: "ItemTinCan",
        item_id_2: "ItemTurbulentJuiceTube",
        item_id_3: "ItemDarkEnergyBall",
        resultid: "ItemParalysisCure"
    },
    {
        recipe_id: "RecipeFullRecover",
        item_id_1: "ItemPureFleeb",
        item_id_2: "ItemMutantBacteriaCell",
        item_id_3: "ItemSuperchargedBattery",
        resultid: "ItemFullRecover"
    },
    {
        recipe_id: "RecipePlutonicRock",
        item_id_1: "ItemBattery",
        item_id_2: "ItemBacteriaCell",
        item_id_3: "",
        resultid: "ItemPlutonicRock"
    },
    {
        recipe_id: "RecipePurePlutonicRock",
        item_id_1: "ItemBattery",
        item_id_2: "ItemMutantBacteriaCell",
        item_id_3: "",
        resultid: "ItemPurePlutonicRock"
    },
    {
        recipe_id: "RecipeMegaSeedLevelUp",
        item_id_1: "ItemMegaSeedAttack",
        item_id_2: "ItemMegaSeedDefence",
        item_id_3: "ItemMegaSeedSpeed",
        resultid: "ItemMegaSeedLevelUp"
    },
    {
        recipe_id: "RecipeBattery",
        item_id_1: "ItemTinCan",
        item_id_2: "ItemCable",
        item_id_3: "ItemFleeb",
        resultid: "ItemBattery"
    },
    {
        recipe_id: "RecipeSuperchargedBattery",
        item_id_1: "ItemBattery",
        item_id_2: "ItemTurbulentJuiceTube",
        item_id_3: "",
        resultid: "ItemSuperchargedBattery"
    },
    {
        recipe_id: "RecipePureSqueezedFleeb",
        item_id_1: "ItemFleeb",
        item_id_2: "ItemTurbulentJuiceTube",
        item_id_3: "",
        resultid: "ItemPureFleeb"
    },
    {
        recipe_id: "RecipeMutantBacteriaCell",
        item_id_1: "ItemBacteriaCell",
        item_id_2: "ItemTurbulentJuiceTube",
        item_id_3: "",
        resultid: "ItemMutantBacteriaCell"
    },
    {
        recipe_id: "RecipeDarkEnergyBall",
        item_id_1: "ItemFleeb",
        item_id_2: "ItemBacteriaCell",
        item_id_3: "",
        resultid: "ItemDarkEnergyBall"
    },
    {
        recipe_id: "RecipeBreakfastMedley",
        item_id_1: "ItemChickenBiscuit",
        item_id_2: "ItemIcedCoffee",
        item_id_3: "ItemBreakfastBurger",
        resultid: "ItemBreakfastMedley"
    },
    {
        recipe_id: "RecipeSpicyBBQPizza",
        item_id_1: "ItemPizzaSlice",
        item_id_2: "ItemBBQSauce",
        item_id_3: "ItemJalapeno",
        resultid: "ItemSpicyBBQPizza"
    },
    {
        recipe_id: "RecipeToxicBundle",
        item_id_1: "ItemBenzene",
        item_id_2: "ItemAcetaldehyde",
        item_id_3: "ItemFormaldehyde",
        resultid: "ItemToxicBundle"
    },
    {
        recipe_id: "RecipeVapeIncineratingRocket",
        item_id_1: "ItemBigTube",
        item_id_2: "ItemTrafficCone",
        item_id_3: "ItemRocketFuel",
        resultid: "ItemVapeIncineratingRocket"
    }
];
app.post('/session/recipe/use', async (req, res) => {
    res.setHeader('X-Powered-By', 'Express');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Vary', 'Accept-Encoding');

    const MAX_ITEM_LIMIT = 10;

    const connection = await pool.getConnection();

    try {
        const body = req.body || {};

        const session_id = String(body.session_id || '').trim();
        const recipe_id = String(body.recipe_id || '').trim();

        if (!session_id || !recipe_id) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_REQUEST'
                }
            });
        }

        // ---------------------------------------------------------
        // Find the recipe
        // ---------------------------------------------------------

        const recipe = recipes.find(
            r => String(r.recipe_id) === recipe_id
        );

        if (!recipe) {
            return res.status(400).json({
                error: {
                    code: 'RECIPE_NOT_FOUND'
                }
            });
        }

        // ---------------------------------------------------------
        // Get the player from the session
        // ---------------------------------------------------------

        const [sessionRows] = await connection.execute(
            `
            SELECT player_id
            FROM users
            WHERE session_id = ?
            LIMIT 1
            `,
            [session_id]
        );

        if (!sessionRows.length) {
            return res.status(401).json({
                error: {
                    code: 'INVALID_SESSION'
                }
            });
        }

        const player_id = sessionRows[0].player_id;

        // ---------------------------------------------------------
        // Build required ingredient list
        // ---------------------------------------------------------

        const requiredItems = [
            recipe.item_id_1,
            recipe.item_id_2,
            recipe.item_id_3
        ].filter(itemId => {
            return itemId &&
                   String(itemId).trim() !== '';
        });

        if (!requiredItems.length) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_RECIPE'
                }
            });
        }

        // Prevent duplicate ingredient IDs
        const uniqueRequiredItems = [...new Set(requiredItems)];

        // ---------------------------------------------------------
        // Validate result ID
        // ---------------------------------------------------------

        const resultId = String(recipe.resultid || '').trim();

        if (!resultId) {
            return res.status(400).json({
                error: {
                    code: 'INVALID_RECIPE'
                }
            });
        }

        // ---------------------------------------------------------
        // Start transaction
        // ---------------------------------------------------------

        await connection.beginTransaction();

        // ---------------------------------------------------------
        // Lock the player's required inventory rows
        // ---------------------------------------------------------

        const placeholders = uniqueRequiredItems
            .map(() => '?')
            .join(',');

        const [ownedRows] = await connection.execute(
            `
            SELECT item_id, quantity
            FROM owned_items
            WHERE player_id = ?
              AND item_id IN (${placeholders})
            FOR UPDATE
            `,
            [
                player_id,
                ...uniqueRequiredItems
            ]
        );

        // ---------------------------------------------------------
        // Convert inventory into a lookup
        // ---------------------------------------------------------

        const ownedMap = new Map();

        for (const row of ownedRows) {
            ownedMap.set(
                String(row.item_id),
                Number(row.quantity) || 0
            );
        }

        // ---------------------------------------------------------
        // Make sure player owns EVERY required ingredient
        // ---------------------------------------------------------

        const missingItem = uniqueRequiredItems.find(itemId => {
            return (ownedMap.get(itemId) || 0) < 1;
        });

        if (missingItem) {
            await connection.rollback();

            return res.status(400).json({
                error: {
                    code: 'RECIPE_ITEM_NOT_OWNED'
                }
            });
        }

        // ---------------------------------------------------------
        // Get and LOCK the result item
        // ---------------------------------------------------------

        const [resultRows] = await connection.execute(
            `
            SELECT quantity
            FROM owned_items
            WHERE player_id = ?
              AND item_id = ?
            FOR UPDATE
            `,
            [
                player_id,
                resultId
            ]
        );

        const currentResultQuantity = resultRows.length
            ? Number(resultRows[0].quantity) || 0
            : 0;

        // ---------------------------------------------------------
        // Check MAX ITEM LIMIT
        // ---------------------------------------------------------

        if (currentResultQuantity >= MAX_ITEM_LIMIT) {
            await connection.rollback();

            return res.status(400).json({
                error: {
                    code: 'ITEM_LIMIT_REACHED'
                }
            });
        }

        // ---------------------------------------------------------
        // Consume one of each ingredient
        // NEVER DELETE - set quantity to 0 instead
        // ---------------------------------------------------------

        for (const itemId of uniqueRequiredItems) {
            const currentQuantity = ownedMap.get(itemId);

            const newQuantity = currentQuantity - 1;

            await connection.execute(
                `
                UPDATE owned_items
                SET quantity = ?
                WHERE player_id = ?
                  AND item_id = ?
                `,
                [
                    newQuantity,
                    player_id,
                    itemId
                ]
            );

            // Update our in-memory inventory so the response
            // contains the quantities AFTER crafting.
            ownedMap.set(itemId, newQuantity);
        }

        // ---------------------------------------------------------
        // Add crafted item
        // ---------------------------------------------------------

        const newResultQuantity = currentResultQuantity + 1;

        if (resultRows.length) {
            await connection.execute(
                `
                UPDATE owned_items
                SET quantity = ?
                WHERE player_id = ?
                  AND item_id = ?
                `,
                [
                    newResultQuantity,
                    player_id,
                    resultId
                ]
            );
        } else {
            await connection.execute(
                `
                INSERT INTO owned_items
                    (player_id, item_id, quantity)
                VALUES
                    (?, ?, ?)
                `,
                [
                    player_id,
                    resultId,
                    1
                ]
            );
        }

        // ---------------------------------------------------------
        // Build owned_items AFTER crafting
        // Only show required items that still have quantity > 0
        // ---------------------------------------------------------

        const responseOwnedItems = uniqueRequiredItems.map(itemId => ({
            item_id: itemId,
            quantity: ownedMap.get(itemId) || 0
        }));

        // ---------------------------------------------------------
        // Commit everything
        // ---------------------------------------------------------

        await connection.commit();

        // ---------------------------------------------------------
        // Return response
        // ---------------------------------------------------------

        return res.status(200).json({
            owned_items: responseOwnedItems,
            result: {
                type: 'ITEM',
                item_id: resultId,
                quantity: newResultQuantity,
                amount_received: 1,
                amount: 1
            }
        });

    } catch (error) {

        try {
            await connection.rollback();
        } catch (_) {}

        console.error(
            'Recipe processing error:',
            error
        );

        return res.status(500).json({
            error: {
                code: 'RECIPE_USE_FAILED'
            }
        });

    } finally {
        connection.release();
    }
});



















// UDP SERVER
const udpPlayers = new Map();       // sessionHex -> player object
const playersByRoom = new Map();    // roomId -> Map<sessionHex, player>

function hexToUuid(hex) {
    return (
        hex.substring(0, 8) + "-" +
        hex.substring(8, 12) + "-" +
        hex.substring(12, 16) + "-" +
        hex.substring(16, 20) + "-" +
        hex.substring(20, 32)
    );
}

function registerPlayerUdpSession(playerId, sessionHex, roomId) {
    // Precompute the 16-byte identity buffer ONCE — never redo this per-packet.
    const idHex = playerId.replace(/-/g, "");
    const idBuffer = Buffer.from(idHex, "hex");

    if (idBuffer.length !== 16) {
        console.error(`[UDP REGISTER ERROR] bad playerId "${playerId}" -> ${idBuffer.length} bytes, expected 16`);
        return;
    }

    const player = {
        playerId,
        idBuffer,        // precomputed, reused on every relay
        roomId,
        address: null,
        port: null,
        lastSeen: Date.now()
    };

    udpPlayers.set(sessionHex, player);

    // Room index so relay loops never touch other rooms' players
    if (!playersByRoom.has(roomId)) {
        playersByRoom.set(roomId, new Map());
    }
    playersByRoom.get(roomId).set(sessionHex, player);
}

function unregisterPlayerUdpSession(sessionHex) {
    const player = udpPlayers.get(sessionHex);
    if (!player) return;
    udpPlayers.delete(sessionHex);
    const room = playersByRoom.get(player.roomId);
    if (room) {
        room.delete(sessionHex);
        if (room.size === 0) playersByRoom.delete(player.roomId);
    }
}

function decodePacket(buffer) {
    if (buffer.length !== 24) {
        throw new Error(`Invalid packet size ${buffer.length}`);
    }
    return {
        session: buffer.subarray(0, 16).toString("hex"),
        sequence: buffer.readUInt16LE(16),
        x: buffer.readUInt8(18),
        xFlags: buffer.readUInt8(19),
        y: buffer.readUInt8(20),
        yFlags: buffer.readUInt8(21),
        frame: buffer.readUInt8(22),
        direction: buffer.readUInt8(23)
    };
}

function relayMovement(idBuffer, target, msg) {
    const relayPacket = Buffer.concat([idBuffer, msg.subarray(16)]);
    udpServer.send(relayPacket, 0, relayPacket.length, target.port, target.address);
}

udpServer.on('message', (msg, rinfo) => {
    try {
        const packet = decodePacket(msg);
        const player = udpPlayers.get(packet.session);
        if (!player) {
            console.log("[UNKNOWN SESSION]", packet.session);
            return;
        }

        player.address = rinfo.address;
        player.port = rinfo.port;
        player.lastSeen = Date.now();

        livePlayerPositions.set(player.playerId, {
            x: packet.x,
            y: packet.y,
            frame: packet.frame,
            direction: packet.direction,
            roomId: player.roomId,
            lastUpdated: Date.now()
        });

        // Only scan players in the SAME room, not the whole server
        const roomPlayers = playersByRoom.get(player.roomId);
        if (!roomPlayers) return;

        for (const target of roomPlayers.values()) {
            if (target === player) continue;
            if (!target.address) continue;
            relayMovement(player.idBuffer, target, msg);
        }
    } catch (err) {
        console.error("[UDP ERROR]", err);
    }
});

udpServer.bind(13001, '0.0.0.0', () => {
    console.log("UDP Movement Engine listening on 13001");
});

const PORT = 3000;
const HOST = '0.0.0.0';

app.listen(PORT, HOST, () => {
    console.log(`Server is running locally at http://localhost:${PORT}`);
});