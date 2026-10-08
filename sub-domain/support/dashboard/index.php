<?php
declare(strict_types=1);
require __DIR__ . "/../auth.php";
$user = require_user($pdo);

/* =========================
   CHECK FOR LINK
   ========================= */
  $email = $_SESSION["user"]["email"] ?? null;
  if (!empty($email)){
  $stmt = $pdo->prepare("SELECT email,recovery_code_hash FROM registered_users WHERE email = ?");
  $stmt->execute([$email]);
  $get_hash = $stmt->fetch();
  $got_hash = $get_hash['recovery_code_hash'] ?? null;
  
  $stmt = $pdo->prepare("SELECT recovery_code_hash,player_id,username,level,xp,xp_lower,xp_upper,player_avatar_id FROM users WHERE recovery_code_hash = ?");
  $stmt->execute([$got_hash]);
  $get_player = $stmt->fetch();
  
  $username = $get_player["username"] ?? null;
  }

/* -------------------------------------------------
   XP / LEVEL MATH (Calculated via actual XP vs bounds)
   ------------------------------------------------- */
$level = 1;
$progressPct = 0;

if (isset($get_player) && $get_player) {
    $level       = (int)($get_player["level"] ?? 1);
    $currentXp   = (int)($get_player["xp"] ?? 0); 
    $xpLower     = (int)($get_player["xp_lower"] ?? 0);
    $xpUpper     = (int)($get_player["xp_upper"] ?? 0);

    $xpThisLevel = $xpUpper - $xpLower;
    $xpIntoLevel = $currentXp - $xpLower;

    if ($xpThisLevel > 0) {
        $progressPct = ($xpIntoLevel / $xpThisLevel) * 100;
    } else {
        $progressPct = 0;
    }
    
    if ($progressPct < 0)   $progressPct = 0;
    if ($progressPct > 100) $progressPct = 100;
}

$owned_morties = [];

if (isset($get_player['player_id'])) {
    $mortyStmt = $pdo->prepare("
        SELECT *
        FROM owned_morties
        WHERE player_id = ?
    ");
    $mortyStmt->execute([$get_player['player_id']]);

    while ($m = $mortyStmt->fetch(PDO::FETCH_ASSOC)) {
        $owned_morties[] = [
            "morty_id"          => $m["morty_id"],
            "level"             => (int)$m["level"],
            "img"               => "https://pocketmortys.net/media/com_pocketmortys/assets/".$m["morty_id"]."Down_1.png",
            "variant"           => $m["variant"] ?: "Normal",
            "is_locked"         => (bool)$m["is_locked"],
        ];
    }
}

// Query all users including created_with_ip
$sql = "SELECT 
            username, 
            last_seen,
            created_with_ip,
            (last_seen >= (NOW() - INTERVAL 5 MINUTE)) AS is_online
        FROM users 
        ORDER BY is_online DESC, last_seen DESC";

$stmt = $pdo->prepare($sql);
$stmt->execute();
$players = $stmt->fetchAll(PDO::FETCH_ASSOC);

// 1. Total row count (total registered accounts)
$total_players = count($players);

// 2. Count of unique players grouped by creation IP
$unique_players = count(array_unique(array_filter(array_column($players, 'created_with_ip'))));

// 3. Online player count
$online_count = array_reduce($players, function($count, $player) {
    return $count + ($player['is_online'] ? 1 : 0);
}, 0);
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta name="color-scheme" content="dark" />
  <title>Dashboard</title>

<style>
:root{
  --bg-deep: #050b10;
  --portal-green: #3dffa0;
  --portal-cyan: #35e0e8;
  --panel: rgba(6, 22, 20, 0.82);
  --panel-border: rgba(80, 255, 170, 0.30);
  --panel-glow:
    0 0 0 1px rgba(80,255,170,0.06),
    0 24px 60px rgba(0,0,0,0.65),
    0 0 50px rgba(56,255,150,0.06);
  --text: rgba(232, 255, 248, 0.97);
  --muted: rgba(200, 235, 220, 0.62);
  --danger: #ef3b46;
  --danger-2: #a01820;
}

/* =========================================================
   GLOBAL
   ========================================================= */

*,
*::before,
*::after{
  box-sizing: border-box;
}

html{
  width: 100%;
  min-height: 100%;

  overflow-x: hidden;

  -webkit-text-size-adjust: 100%;
  text-size-adjust: 100%;
}

body{
  width: 100%;
  min-width: 0;
  min-height: 100vh;
  min-height: 100dvh;

  margin: 0;

  color: #adff2f;

  font-family:
    'Orbitron',
    'Segoe UI',
    Tahoma,
    Geneva,
    Verdana,
    sans-serif;

  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 1px;

  padding-top: max(20px, env(safe-area-inset-top));
  padding-right: max(20px, env(safe-area-inset-right));
  padding-bottom: max(20px, env(safe-area-inset-bottom));
  padding-left: max(20px, env(safe-area-inset-left));

  background-color: #0d1b15;

  background-image: url('../images/bk.png');
  background-repeat: no-repeat;
  background-position: center center;
  background-size: cover;

  /*
   * Fixed backgrounds can behave badly on iOS Safari.
   */
  background-attachment: scroll;

  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;

  overflow-x: hidden;
}

img,
svg,
video,
canvas{
  max-width: 100%;
}

button,
a,
input,
select,
textarea{
  font: inherit;
}

button,
a{
  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

/* =========================================================
   APP SHELL
   ========================================================= */

.app-shell{
  width: 100%;
  max-width: 1180px;
  min-width: 0;

  margin: 0 auto;

  display: grid;
  gap: 14px;
}

/* =========================================================
   IDENTITY BAR
   ========================================================= */

.identity-bar{
  width: 100%;
  min-width: 0;

  display: flex;
  align-items: center;
  justify-content: space-between;

  flex-wrap: wrap;

  gap: 14px;

  padding: 14px 18px;

  border-radius: 22px;

  border: 1px solid var(--panel-border);

  background: var(--panel);

  box-shadow: var(--panel-glow);
}

.identity-left{
  display: flex;
  align-items: center;

  gap: 12px;

  min-width: 0;

  flex: 1 1 320px;
}

.identity-avatar{
  width: 100px;
  height: 100px;

  max-width: 100px;
  max-height: 100px;

  border-radius: 50%;

  flex: 0 0 auto;

  object-fit: cover;
  object-position: 50% 10%;

  border: 2px solid rgba(255,255,255,0.3);

  background: rgba(255,255,255,0.04);
}

.identity-left > div{
  min-width: 0;
  max-width: 100%;
}

.identity-name{
  max-width: 100%;

  font-size: 20px;
  font-weight: 800;

  color: var(--portal-green);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.identity-email{
  max-width: 100%;

  font-size: 12.5px;

  color: var(--muted);

  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.identity-right{
  display: flex;
  align-items: center;
  justify-content: flex-end;

  gap: 12px;

  flex-wrap: wrap;

  min-width: 0;
}

/* =========================================================
   CONNECTED PILL
   ========================================================= */

.pill-connected{
  display: inline-flex;
  align-items: center;

  gap: 8px;

  min-height: 44px;

  padding: 10px 16px;

  border-radius: 999px;

  border: 1px solid rgba(61,255,160,0.4);

  background: rgba(61,255,160,0.10);

  font-size: 13px;
  font-weight: 700;

  color: var(--text);

  white-space: nowrap;

  max-width: 100%;
}

.pill-connected svg{
  width: 15px;
  height: 15px;

  flex: 0 0 auto;
}

/* =========================================================
   LEAVE BUTTON
   ========================================================= */

.btn-leave{
  min-height: 44px;

  border: 0;

  cursor: pointer;

  border-radius: 12px;

  padding: 12px 18px;

  font-weight: 800;
  font-size: 12.5px;

  letter-spacing: 0.05em;

  text-transform: uppercase;

  text-decoration: none;

  color: #fff0f0;

  background:
    linear-gradient(
      135deg,
      var(--danger),
      var(--danger-2)
    );

  box-shadow:
    0 10px 26px rgba(239,59,70,0.25);

  white-space: nowrap;

  display: inline-flex;
  align-items: center;
  justify-content: center;

  text-align: center;
}

/* =========================================================
   MAIN GRID
   ========================================================= */

.main-grid{
  width: 100%;
  min-width: 0;

  display: grid;

  grid-template-columns:
    minmax(0, 1.15fr)
    minmax(300px, 0.85fr);

  gap: 14px;

  align-items: start;
}

.right-panels-column{
  width: 100%;
  min-width: 0;

  display: flex;
  flex-direction: column;

  gap: 14px;
}

/* =========================================================
   PANELS
   ========================================================= */

.panel{
  width: 100%;
  min-width: 0;

  border-radius: 22px;

  border: 1px solid var(--panel-border);

  background: var(--panel);

  box-shadow: var(--panel-glow);

  padding: 16px;

  overflow: hidden;
}

.panel h2{
  margin: 0 0 12px;

  font-size: 15px;

  font-weight: 800;

  letter-spacing: 0.02em;

  color: var(--text);
}

/* =========================================================
   TABS
   ========================================================= */

/*
 * The tabs themselves stay attached to the container.
 *
 * On small screens, the TAB ROW scrolls horizontally.
 * The page itself does NOT scroll horizontally.
 */

.tabs-row{
  width: 100%;
  min-width: 0;

  display: flex;
  align-items: flex-end;

  gap: 5px;

  margin: 0;
  padding: 0;

  overflow-x: auto;
  overflow-y: hidden;

  scrollbar-width: none;

  -webkit-overflow-scrolling: touch;

  overscroll-behavior-x: contain;
}

.tabs-row::-webkit-scrollbar{
  display: none;
}

.tab-btn{
  display: inline-flex;
  align-items: center;
  justify-content: center;

  gap: 7px;

  min-height: 40px;

  padding: 8px 16px;

  border-top-left-radius: 20px;
  border-top-right-radius: 20px;

  border-bottom-left-radius: 0;
  border-bottom-right-radius: 0;

  font-size: 13px;
  font-weight: 800;

  cursor: pointer;

  color: rgba(220,255,235,0.75);

  background:
    linear-gradient(
      180deg,
      rgba(28,68,52,0.95),
      rgba(10,32,24,0.95)
    );

  border: 1.5px solid rgba(120,255,180,0.30);

  /*
   * IMPORTANT:
   * No negative bottom positioning.
   */
  position: relative;
  bottom: 0;

  /*
   * This makes the tab touch the container.
   */
  margin-bottom: -1px;

  z-index: 2;

  flex: 0 0 auto;

  white-space: nowrap;

  transition:
    border-color 0.2s ease,
    color 0.2s ease,
    background 0.2s ease,
    box-shadow 0.2s ease;

  -webkit-tap-highlight-color: transparent;
  touch-action: manipulation;
}

.tab-btn:hover{
  border-color: rgba(120,255,180,0.55);
  color: #eafff5;
}

.tab-btn.active{
  color: #ffffff;

  border-color: rgba(120,255,180,0.8);

  /*
   * The bottom border disappears into the container.
   */
  border-bottom-color: transparent;

  background:
    linear-gradient(
      180deg,
      rgba(45,110,80,0.95),
      rgba(16,50,38,0.95)
    );

  box-shadow:
    0 -2px 10px rgba(61,255,160,0.35);
}

.tabs-spacer{
  flex: 1 0 20px;
  min-width: 20px;
}

/* =========================================================
   TAB CONTENT CONTAINER
   ========================================================= */

.tab-content-container{
  width: 100%;
  min-width: 0;

  margin-top: 0;
  padding: 16px;

  position: relative;
  z-index: 1;

  /* No top border */
  border-top: none;

  /* Keep the other 3 borders */
  border-right: 1px solid rgba(61,255,160,0.8);
  border-bottom: 1px solid rgba(61,255,160,0.8);
  border-left: 1px solid rgba(61,255,160,0.8);

  border-top-left-radius: 0;
  border-top-right-radius: 22px;
  border-bottom-left-radius: 22px;
  border-bottom-right-radius: 22px;

  background: rgba(6,22,20,0.95);

  box-shadow:
    0 0 10px rgba(61,255,160,0.4);
}

.tab-pane{
  display: none;

  width: 100%;
  min-width: 0;
}

.tab-pane.active{
  display: block;
}

/* =========================================================
   PLAYER LIST
   ========================================================= */

.player-list{
  width: 100%;
  min-width: 0;

  max-height: 480px;

  overflow-y: auto;
  overflow-x: hidden;

  padding-right: 6px;

  display: grid;

  gap: 8px;

  -webkit-overflow-scrolling: touch;
}

.player-item{
  width: 100%;
  min-width: 0;

  color: white;

  display: flex;

  justify-content: space-between;
  align-items: center;

  gap: 12px;

  padding: 10px 14px;

  min-height: 44px;

  border-radius: 10px;

  background: rgba(255,255,255,0.04);

  border: 1px solid rgba(255,255,255,0.08);

  font-size: 13px;
}

.player-item > span:first-child{
  min-width: 0;

  overflow: hidden;

  text-overflow: ellipsis;

  white-space: nowrap;
}

.player-status{
  display: inline-flex;

  align-items: center;

  gap: 6px;

  font-weight: 700;

  flex: 0 0 auto;

  white-space: nowrap;
}

.player-status.online{
  color: var(--portal-green, #22c55e);
}

.player-status.online::before{
  content: "";

  width: 8px;
  height: 8px;

  flex: 0 0 8px;

  border-radius: 50%;

  background: var(--portal-green, #22c55e);

  box-shadow:
    0 0 8px var(--portal-green, #22c55e);
}

.player-status.offline{
  color: #ef4444;
}

.player-status.offline::before{
  content: "";

  width: 8px;
  height: 8px;

  flex: 0 0 8px;

  border-radius: 50%;

  background: #ef4444;

  box-shadow:
    0 0 8px #ef4444;
}

/* =========================================================
   MORTY TOOLBAR
   ========================================================= */

.morty-toolbar{
  width: 100%;

  display: flex;

  justify-content: flex-end;

  margin-bottom: 10px;
}

.view-toggle{
  display: inline-flex;

  border-radius: 10px;

  border: 1px solid rgba(120,255,180,0.30);

  background: rgba(10,30,20,0.6);

  overflow: hidden;
}

.view-toggle-btn{
  display: inline-flex;

  align-items: center;
  justify-content: center;

  width: 44px;
  height: 40px;

  border: none;

  cursor: pointer;

  background: transparent;

  color: rgba(220,255,235,0.55);

  transition: all 0.15s ease;

  touch-action: manipulation;
}

.view-toggle-btn svg{
  width: 15px;
  height: 15px;
}

.view-toggle-btn:hover{
  color: #eafff5;
}

.view-toggle-btn.active{
  background: rgba(61,255,160,0.22);

  color: #ffffff;
}

.view-toggle-btn + .view-toggle-btn{
  border-left: 1px solid rgba(120,255,180,0.20);
}

/* =========================================================
   MORTY GRID
   ========================================================= */

.morty-grid{
  width: 100%;
  min-width: 0;

  display: grid;

  grid-template-columns:
    repeat(4, minmax(0, 1fr));

  gap: 10px;

  max-height: 480px;

  overflow-y: auto;
  overflow-x: hidden;

  padding-right: 6px;

  -webkit-overflow-scrolling: touch;
}

.morty-card{
  position: relative;

  width: 100%;
  min-width: 0;

  border-radius: 12px;

  background: #51A5C3;

  overflow: hidden;
}

.morty-name-tag{
  position: absolute;

  top: 6px;
  left: 8px;
  right: 8px;

  z-index: 2;

  font-size: 11px;

  font-weight: 700;

  color: #fff;

  text-shadow:
    0 1px 3px rgba(0,0,0,0.9);

  white-space: nowrap;

  overflow: hidden;

  text-overflow: ellipsis;

  text-align: center;

  pointer-events: none;
}

.morty-thumb-wrap{
  position: relative;

  width: 100%;

  aspect-ratio: 1 / 1;

  background:
    linear-gradient(
      160deg,
      rgba(61,255,160,0.10),
      rgba(53,224,232,0.06)
    );
}

.morty-thumb-wrap img{
  width: 100%;
  height: 100%;

  object-fit: cover;

  display: block;
}

.morty-level-overlay{
  position: absolute;

  bottom: 4px;
  right: 4px;

  z-index: 3;

  background: rgba(0,0,0,0.85);

  border-radius: 6px;

  padding: 2px 6px;

  font-size: 12px;

  font-weight: 800;

  color: #A6A2A1;

  text-shadow:
    0 1px 2px rgba(0,0,0,0.9);

  letter-spacing: 0.05em;

  white-space: nowrap;
}

.lock-icon{
  position: absolute;

  inset: 0;

  z-index: 3;

  width: 100%;
  height: 100%;

  background: rgba(0,0,0,0.6);

  display: grid;

  place-items: center;
}

.lock-icon svg{
  width: 18px;
  height: 18px;

  color: #fff;
}

/* =========================================================
   MORTY LIST
   ========================================================= */

.morty-list{
  width: 100%;
  min-width: 0;

  display: grid;

  gap: 6px;

  max-height: 480px;

  overflow-y: auto;
  overflow-x: hidden;

  padding-right: 6px;

  -webkit-overflow-scrolling: touch;
}

.morty-row{
  width: 100%;
  min-width: 0;

  display: flex;

  align-items: center;

  gap: 12px;

  padding: 8px 14px 8px 8px;

  border-radius: 10px;

  background: rgba(10,20,28,0.6);

  border: 1px solid rgba(255,255,255,0.08);
}

.morty-row-thumb{
  position: relative;

  width: 44px;
  height: 44px;

  flex: 0 0 44px;

  border-radius: 8px;

  overflow: hidden;

  background: #51A5C3;
}

.morty-row-thumb img{
  width: 100%;
  height: 100%;

  object-fit: cover;

  display: block;
}

.morty-row-lock{
  position: absolute;

  inset: 0;

  z-index: 2;

  background: rgba(0,0,0,0.6);

  display: grid;

  place-items: center;
}

.morty-row-lock svg{
  width: 16px;
  height: 16px;

  color: #fff;
}

.morty-row-name{
  flex: 1;

  min-width: 0;

  font-size: 13px;

  font-weight: 700;

  color: var(--text);

  white-space: nowrap;

  overflow: hidden;

  text-overflow: ellipsis;
}

.morty-row-level{
  flex: 0 0 auto;

  font-size: 12px;

  font-weight: 800;

  color: #A6A2A1;

  background: rgba(0,0,0,0.5);

  border-radius: 6px;

  padding: 3px 8px;

  white-space: nowrap;
}

/* =========================================================
   SCROLLBARS
   ========================================================= */

.morty-list::-webkit-scrollbar,
.morty-grid::-webkit-scrollbar,
.player-list::-webkit-scrollbar{
  width: 6px;
}

.morty-list::-webkit-scrollbar-thumb,
.morty-grid::-webkit-scrollbar-thumb,
.player-list::-webkit-scrollbar-thumb{
  background: rgba(61,255,160,0.35);

  border-radius: 6px;
}

.morty-list::-webkit-scrollbar-track,
.morty-grid::-webkit-scrollbar-track,
.player-list::-webkit-scrollbar-track{
  background: rgba(255,255,255,0.04);
}

/* =========================================================
   ACCOUNT INFO
   ========================================================= */

.info-block{
  width: 100%;
  min-width: 0;

  display: flex;

  align-items: center;

  gap: 14px;
}

.info-rows{
  flex: 1;

  min-width: 0;
}

.info-row{
  width: 100%;
  min-width: 0;

  padding: 7px 0;

  font-size: 15px;

  display: flex;

  gap: 6px;

  flex-wrap: wrap;
}

.info-row .label{
  font-weight: 700;

  color: var(--text);
}

.info-row .value{
  color: white;

  font-weight: 600;

  min-width: 0;

  overflow-wrap: anywhere;
}

.info-row .value.code{
  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;

  font-size: 15.5px;

  overflow-wrap: anywhere;

  word-break: break-word;
}

/* =========================================================
   XP
   ========================================================= */

.xp-container{
  width: 100%;
  min-width: 0;

  display: flex;

  align-items: center;

  gap: 12px;

  margin-top: 14px;
}

.lvl-label{
  font-size: 24px;

  font-weight: 900;

  color: #ffffff;

  font-style: italic;

  letter-spacing: -0.02em;

  text-shadow:
    0 2px 4px rgba(0,0,0,0.5);

  white-space: nowrap;

  flex: 0 0 auto;
}

.xp-capsule{
  position: relative;

  flex: 1 1 auto;

  min-width: 0;

  height: 40px;

  border-radius: 999px;

  background: #2b3b4a;

  border: 3px solid #000000;

  overflow: hidden;

  box-shadow:
    0 4px 6px rgba(0,0,0,0.3);
}

.xp-capsule-fill{
  height: 100%;

  width: 0%;

  background:
    repeating-linear-gradient(
      135deg,
      #ff8c00 0px,
      #ff8c00 20px,
      #ffa500 20px,
      #ffa500 40px
    );

  transition: width 0.4s ease;
}

.xp-capsule-text{
  position: absolute;

  inset: 0;

  display: flex;

  align-items: center;

  justify-content: center;

  padding: 0 10px;

  font-weight: 800;

  font-size: 13px;

  letter-spacing: 0.03em;

  color: #ffffff;

  text-shadow:
    0 1px 3px rgba(0,0,0,0.8);

  white-space: nowrap;

  overflow: hidden;

  text-overflow: ellipsis;
}

/* =========================================================
   EMPTY STATE
   ========================================================= */

.empty-state{
  width: 100%;

  padding: 22px 14px;

  text-align: center;

  color: var(--muted);

  font-size: 13.5px;

  border: 1px dashed rgba(255,255,255,0.14);

  border-radius: 12px;

  line-height: 1.5;

  overflow-wrap: anywhere;
}

/* =========================================================
   CODE BOX
   ========================================================= */

.codeBox{
  width: 100%;

  margin-top: 10px;

  padding: 14px;

  border-radius: 12px;

  border: 1px dashed rgba(61,255,160,0.4);

  background: rgba(0,0,0,0.3);

  font-family:
    ui-monospace,
    SFMono-Regular,
    Menlo,
    Monaco,
    Consolas,
    monospace;

  font-size: 16px;

  letter-spacing: 0.1em;

  text-align: center;

  overflow-wrap: anywhere;

  word-break: break-word;

  display: none;
}

/* =========================================================
   MESSAGES
   ========================================================= */

.msg{
  width: 100%;

  margin-top: 10px;

  padding: 12px;

  border-radius: 12px;

  font-size: 13px;

  border: 1px solid transparent;

  display: none;

  overflow-wrap: anywhere;
}

.msg.ok{
  background: rgba(61,255,160,0.10);

  border-color: rgba(61,255,160,0.3);
}

.msg.err{
  background: rgba(239,59,70,0.12);

  border-color: rgba(239,59,70,0.3);
}

/* =========================================================
   BUTTONS
   ========================================================= */

.rowBtns{
  display: flex;

  gap: 10px;

  flex-wrap: wrap;

  margin-top: 12px;
}

.btn{
  min-height: 44px;

  border: 0;

  cursor: pointer;

  border-radius: 12px;

  padding: 11px 16px;

  font-weight: 700;

  font-size: 13px;

  text-decoration: none;

  display: inline-flex;

  align-items: center;

  justify-content: center;

  gap: 8px;

  text-align: center;

  touch-action: manipulation;
}

.btn.primary{
  background:
    linear-gradient(
      135deg,
      var(--portal-green),
      var(--portal-cyan)
    );

  color: #04140b;
}

.btn.ghost{
  background: rgba(255,255,255,0.06);

  border: 1px solid var(--panel-border);

  color: var(--text);
}

/* =========================================================
   TABLET
   ========================================================= */

@media (max-width: 1100px){

  .main-grid{
    grid-template-columns: 1fr;
  }

  .right-panels-column{
    display: grid;

    grid-template-columns:
      repeat(2, minmax(0, 1fr));
  }
}

/* =========================================================
   SMALL TABLET
   ========================================================= */

@media (max-width: 800px){

  body{
    padding-top: max(14px, env(safe-area-inset-top));
    padding-right: max(14px, env(safe-area-inset-right));
    padding-bottom: max(14px, env(safe-area-inset-bottom));
    padding-left: max(14px, env(safe-area-inset-left));
  }

  .identity-bar{
    padding: 14px;
  }

  .identity-left{
    flex-basis: 100%;
  }

  .identity-right{
    width: 100%;

    justify-content: flex-start;
  }

  .right-panels-column{
    grid-template-columns: 1fr;
  }

  .morty-grid{
    grid-template-columns:
      repeat(3, minmax(0, 1fr));
  }

  .tab-content-container{
    padding: 14px;
  }
}

/* =========================================================
   PHONE
   ========================================================= */

@media (max-width: 600px){

  body{
    padding-top: max(10px, env(safe-area-inset-top));
    padding-right: max(10px, env(safe-area-inset-right));
    padding-bottom: max(10px, env(safe-area-inset-bottom));
    padding-left: max(10px, env(safe-area-inset-left));

    letter-spacing: 0.5px;
  }

  .app-shell{
    gap: 10px;
  }

  /* ---------------- IDENTITY ---------------- */

  .identity-bar{
    border-radius: 16px;

    padding: 12px;

    gap: 12px;
  }

  .identity-left{
    width: 100%;

    gap: 10px;
  }

  .identity-avatar{
    width: 64px;
    height: 64px;

    max-width: 64px;
    max-height: 64px;
  }

  .identity-name{
    font-size: 16px;
  }

  .identity-email{
    font-size: 10.5px;
  }

  .identity-right{
    width: 100%;

    display: grid;

    grid-template-columns:
      minmax(0, 1fr)
      auto;

    gap: 8px;
  }

  .pill-connected{
    width: 100%;
    min-width: 0;

    min-height: 44px;

    padding: 8px 10px;

    font-size: 10px;

    overflow: hidden;

    text-overflow: ellipsis;
  }

  .btn-leave{
    min-height: 44px;

    padding: 10px 12px;

    font-size: 10px;
  }

  /* ---------------- PANEL ---------------- */

  .panel{
    border-radius: 16px;

    padding: 12px;
  }

  .panel h2{
    font-size: 14px;
  }

  /* ---------------- TABS ---------------- */

  .tabs-row{
    width: 100%;

    gap: 4px;

    overflow-x: auto;
    overflow-y: hidden;

    /*
     * Prevent the tab row from changing the page width.
     */
    max-width: 100%;
  }

  .tab-btn{
    min-height: 40px;

    padding: 8px 12px;

    font-size: 10px;

    border-top-left-radius: 14px;
    border-top-right-radius: 14px;
  }

  .tab-content-container{
    width: 100%;

    margin-top: 0;

    padding: 10px;

    border-top-left-radius: 0;
    border-top-right-radius: 16px;

    border-bottom-left-radius: 16px;
    border-bottom-right-radius: 16px;
  }

  /* ---------------- MORTIES ---------------- */

  .morty-grid{
    grid-template-columns:
      repeat(2, minmax(0, 1fr));

    gap: 8px;

    max-height: 60vh;
    max-height: 60dvh;
  }

  .morty-list{
    max-height: 60vh;
    max-height: 60dvh;
  }

  .morty-name-tag{
    font-size: 9px;

    top: 5px;
    left: 5px;
    right: 5px;
  }

  .morty-level-overlay{
    font-size: 10px;

    bottom: 3px;
    right: 3px;

    padding: 2px 5px;
  }

  /* ---------------- XP ---------------- */

  .xp-container{
    gap: 8px;
  }

  .lvl-label{
    font-size: 18px;
  }

  .xp-capsule{
    height: 34px;

    border-width: 2px;
  }

  .xp-capsule-text{
    font-size: 10px;

    padding: 0 6px;
  }

  /* ---------------- INFO ---------------- */

  .info-row{
    font-size: 13px;
  }

  .info-row .value.code{
    font-size: 12px;
  }

  /* ---------------- PLAYERS ---------------- */

  .player-list{
    max-height: 60vh;
    max-height: 60dvh;
  }

  .player-item{
    padding: 9px 10px;

    font-size: 11px;
  }

  /* ---------------- BUTTONS ---------------- */

  .rowBtns{
    display: grid;

    grid-template-columns:
      repeat(2, minmax(0, 1fr));
  }

  .rowBtns .btn{
    width: 100%;
  }
}

/* =========================================================
   VERY SMALL PHONES
   ========================================================= */

@media (max-width: 380px){

  body{
    padding-top: max(8px, env(safe-area-inset-top));
    padding-right: max(8px, env(safe-area-inset-right));
    padding-bottom: max(8px, env(safe-area-inset-bottom));
    padding-left: max(8px, env(safe-area-inset-left));
  }

  .identity-avatar{
    width: 54px;
    height: 54px;

    max-width: 54px;
    max-height: 54px;
  }

  .identity-name{
    font-size: 14px;
  }

  .identity-email{
    font-size: 9px;
  }

  .identity-right{
    grid-template-columns: 1fr;
  }

  .pill-connected,
  .btn-leave{
    width: 100%;
  }

  .tab-btn{
    padding-left: 10px;
    padding-right: 10px;

    font-size: 9px;
  }

  .morty-grid{
    gap: 6px;
  }

  .morty-level-overlay{
    font-size: 9px;
  }

  .morty-row{
    gap: 8px;

    padding-right: 8px;
  }

  .morty-row-thumb{
    width: 40px;
    height: 40px;

    flex-basis: 40px;
  }

  .morty-row-name{
    font-size: 11px;
  }

  .morty-row-level{
    font-size: 10px;

    padding: 3px 6px;
  }

  /*
   * On extremely narrow screens the XP label and
   * XP bar stack rather than becoming unusably small.
   */
  .xp-container{
    flex-direction: column;

    align-items: stretch;

    gap: 6px;
  }

  .lvl-label{
    font-size: 16px;
  }

  .xp-capsule{
    width: 100%;
  }

  .rowBtns{
    grid-template-columns: 1fr;
  }
}

/* =========================================================
   LANDSCAPE PHONES
   ========================================================= */

@media (max-width: 800px) and (orientation: landscape){

  .identity-bar{
    flex-wrap: nowrap;
  }

  .identity-left{
    flex-basis: auto;
  }

  .identity-right{
    width: auto;

    display: flex;
  }

  .identity-avatar{
    width: 58px;
    height: 58px;

    max-width: 58px;
    max-height: 58px;
  }

  .morty-grid{
    grid-template-columns:
      repeat(4, minmax(0, 1fr));
  }
}

/* =========================================================
   TOUCH DEVICES
   ========================================================= */

@media (hover: none) and (pointer: coarse){

  .tab-btn,
  .btn,
  .btn-leave,
  .view-toggle-btn{
    -webkit-tap-highlight-color: transparent;
  }

  .tab-btn:hover{
    border-color: rgba(120,255,180,0.30);
    color: rgba(220,255,235,0.75);
  }

  .btn,
  .btn-leave{
    min-height: 44px;
  }
}

/* =========================================================
   REDUCED MOTION
   ========================================================= */

@media (prefers-reduced-motion: reduce){

  *,
  *::before,
  *::after{
    scroll-behavior: auto !important;

    transition-duration: 0.01ms !important;

    animation-duration: 0.01ms !important;

    animation-iteration-count: 1 !important;
  }
}
  </style>
</head>
<body>
  <div class="app-shell">

    <!-- ================= IDENTITY BAR ================= -->
    <div class="identity-bar">
      <div class="identity-left">
    <?php
        $get_avatar = $get_player['player_avatar_id'] ?? 'CharacterRickDefault';
        $get_avatar = str_replace('Avatar', 'Character', $get_avatar);
    ?>
        <img class="identity-avatar" src="https://pocketmortys.net/media/com_pocketmortys/assets/<?= htmlspecialchars($get_avatar) ?>Front.png" alt="" />
        <div style="min-width:0;">
          <div class="identity-name"><?= htmlspecialchars($username ?? "Unlinked Traveler") ?></div>
          <div class="identity-email">Email: <?= htmlspecialchars($user["email"]) ?></div>
        </div>
      </div>
      <div class="identity-right">
        <?php if (!empty($username)): ?>
          <div class="pill-connected">
            <svg viewBox="0 0 24 24" fill="none"><path d="M5 12.5l4.5 4.5L19 7" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Connected to <?= htmlspecialchars($username) ?>
          </div>
        <?php else: ?>
          <div class="pill-connected" style="border-color: rgba(239,59,70,0.4); background: rgba(239,59,70,0.08);">Not linked</div>
        <?php endif; ?>
        <a class="btn-leave" href="../?logout">Leave the Dimension</a>
      </div>
    </div>

    <!-- ================= MAIN GRID ================= -->
    <div class="main-grid">

      <!-- ---------- LEFT: Tabbed Content Panel ---------- -->
      <section style="background: transparent; border: none; box-shadow: none; padding: 0;">
        <div class="tabs-row">
          <button class="tab-btn active" type="button" data-target="tab-morties">
            Owned Morties
          </button>
          <button class="tab-btn" type="button" data-target="tab-events">
            Current Events
          </button>
		  <button class="tab-btn" type="button" data-target="player-tab">
            Player List (<?php echo $online_count; ?>)
          </button>
          <button class="tab-btn" type="button" data-target="tab-shop">
            Shop
          </button>
          <div class="tabs-spacer"></div>
        </div>

        <div class="tab-content-container">

<div id="player-tab" class="tab-pane">
  <div class="player-list" id="playerListContainer">
    <!-- Items rendered dynamically via JS -->
  </div>
  <div style="text-align: center; margin-top: 12px;">
    <button type="button" class="btn ghost" id="btnLoadMore" style="display: none;">
      Load More Players
    </button>
  </div>
</div>

<div id="tab-morties" class="tab-pane active">
  <div class="morty-toolbar">
    <div class="view-toggle">
      <button type="button" class="view-toggle-btn active" data-view="grid" title="Grid view">
        <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="3" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="13" y="3" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="3" y="13" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/><rect x="13" y="13" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="2"/></svg>
      </button>
      <button type="button" class="view-toggle-btn" data-view="list" title="List view">
        <svg viewBox="0 0 24 24" fill="none"><rect x="3" y="4.5" width="18" height="3" rx="1" fill="currentColor"/><rect x="3" y="10.5" width="18" height="3" rx="1" fill="currentColor"/><rect x="3" y="16.5" width="18" height="3" rx="1" fill="currentColor"/></svg>
      </button>
    </div>
  </div>

  <!-- GRID VIEW -->
  <div class="morty-grid" id="mortyGridView">
    <?php foreach ($owned_morties as $m): ?>
      <div class="morty-card">
        <div class="morty-name-tag"><?= htmlspecialchars($m['morty_id']) ?></div>
        <div class="morty-thumb-wrap">
          <?php if ((bool)$m['is_locked']): ?>
            <div class="lock-icon">
              <svg viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="2"/></svg>
            </div>
          <?php endif; ?>
          <div class="morty-level-overlay">Lvl <?= (int)$m['level'] ?></div>
          <img src="<?= htmlspecialchars($m['img']) ?>" alt="<?= htmlspecialchars($m['morty_id']) ?>" />
        </div>
        <div class="morty-rarity-bar"></div>
      </div>
    <?php endforeach; ?>
  </div>

  <!-- LIST VIEW -->
  <div class="morty-list" id="mortyListView" style="display:none;">
    <?php foreach ($owned_morties as $m): ?>
      <div class="morty-row">
        <div class="morty-row-thumb">
          <?php if ((bool)$m['is_locked']): ?>
            <div class="morty-row-lock">
              <svg viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="2"/></svg>
            </div>
          <?php endif; ?>
          <img src="<?= htmlspecialchars($m['img']) ?>" alt="<?= htmlspecialchars($m['morty_id']) ?>" />
        </div>
        <div class="morty-row-name"><?= htmlspecialchars($m['morty_id']) ?></div>
        <div class="morty-row-level">Lvl <?= (int)$m['level'] ?></div>
      </div>
    <?php endforeach; ?>
  </div>
</div>

          <div id="tab-events" class="tab-pane">
            <div class="empty-state">No active events in this dimension right now. Check back soon!</div>
          </div>

          <div id="tab-shop" class="tab-pane">
            <div class="empty-state">The Blips and Chitz shop is currently closed.</div>
          </div>
        </div>
      </section>

      <!-- ---------- RIGHT COLUMN: 2 Panels Stacked ---------- -->
      <div class="right-panels-column">
        <!-- FIRST RIGHT PANEL: Account Overview -->
        <aside class="panel">
          <h2 style="text-align: center;">Account Overview</h2>
          <div class="info-block">
            <div class="info-rows">
              <div class="info-row">
                <span class="label">Player ID:</span>
                <span class="value code"><?= htmlspecialchars($get_player['player_id'] ?? "Not linked") ?></span>
              </div>
              <div class="info-row">
                <span class="label">Username:</span>
                <span class="value"><?= htmlspecialchars($get_player['username'] ?? "Not linked") ?></span>
              </div>
            </div>
          </div>
  <?php if (isset($get_player) && $get_player): ?>
  <div class="xp-container">
      <div class="lvl-label">LvL <?= (int)$level ?></div>
      <div class="xp-capsule">
          <div class="xp-capsule-fill" style="width: <?= number_format($progressPct, 2, '.', '') ?>%;"></div>
          <div class="xp-capsule-text">XP: <?= number_format($currentXp) ?> / <?= number_format($xpUpper) ?></div>
      </div>
  </div>
  <?php else: ?>
    <div class="xp-capsule empty" style="margin-top: 14px;">
        <div class="xp-capsule-text">Link your account to track XP</div>
    </div>
  <?php endif; ?>
        </aside>

        <!-- SECOND RIGHT PANEL: Dimension & Quick Stats -->
        <aside class="panel">
          <h2 style="text-align: center;">Stats</h2>
          <div class="info-block">
            <div class="info-rows">
              <div class="info-row">
                <span class="label">Total Players:</span>
				<span class="value"><?php echo number_format($total_players); ?></span>
              </div>
              <div class="info-row">
                <span class="label">Unique Players:</span>
                <span class="value"><?php  echo number_format($unique_players); ?></span>
              </div>
            </div>
          </div>
        </aside>
      </div>

    </div>

    <!-- ================= LINKING / RECOVERY CODE ================= -->
<?php if (empty($get_player) && !empty($got_hash)): ?>
  <section class="panel">
    <div class="empty-state">
      This is your dashboard. Account information will become available once you link your account.
      Go into the game on your phone, open Settings &rarr; FAQ, log in to your account,
      then select "Link Account."
    </div>

    <div class="rowBtns">
      <a
        class="btn primary"
        href="pocketmortys://Braze?LinkAccount=<?= htmlspecialchars($got_hash) ?>"
      >
        Link Account
      </a>
    </div>
  </section>
<?php endif; ?>

    <?php if (empty($got_hash)): ?>
      <div class="main-grid">
        <section class="panel">
          <h2>Generate Recovery Code</h2>
          <div class="empty-state" style="text-align:left;">
            Generate a code so you can link your accounts.
          </div>
          <div class="rowBtns">
            <button class="btn primary" id="btnGen">Generate Recovery Code</button>
            <button class="btn ghost" id="btnCopy" style="display:none;">Copy</button>
          </div>
          <div id="codeBox" class="codeBox"></div>
          <div id="msgOk" class="msg ok"></div>
          <div id="msgErr" class="msg err"></div>
        </section>

        <aside class="panel">
          <h2>Security Tips</h2>
          <div class="empty-state" style="text-align:left;">
            &bull; Save your code in a password manager.<br>
            &bull; Don't screenshot it on shared devices.
          </div>
        </aside>
      </div>
    <?php endif; ?>

  </div>
<script>
(function() {
    let currentPage = 1;
    let totalPages = 1;
    let isLoading = false;

    const container = document.getElementById('playerListContainer');
    const loadMoreBtn = document.getElementById('btnLoadMore');
    const playerTabBtn = document.querySelector('[data-target="player-tab"]');

    function escapeHtml(str) {
        return (str + '').replace(/[&<>'"]/g, 
            tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
        );
    }

    async function fetchPlayers(page = 1, append = false) {
        if (isLoading) return;
        isLoading = true;

        try {
            const response = await fetch(`get_players.php?page=${page}&limit=20`);
            if (!response.ok) return;

            const data = await response.json();
            if (!data.success) return;

            currentPage = data.page;
            totalPages = data.total_pages;

            // Update online tab badge
            if (playerTabBtn) {
                playerTabBtn.textContent = `Player List (${data.online_count})`;
            }

            if (!data.players || data.players.length === 0) {
                if (!append) container.innerHTML = '<div class="empty-state">No players found.</div>';
                loadMoreBtn.style.display = 'none';
                return;
            }

            let html = '';
            data.players.forEach(p => {
                const isOnline = Boolean(parseInt(p.is_online));
                const statusClass = isOnline ? 'online' : 'offline';
                const statusText = isOnline ? 'Online' : 'Offline';
                const itemClass = isOnline ? 'is-online' : 'is-offline';

                html += `
                    <div class="player-item ${itemClass}">
                        <span>${escapeHtml(p.username)}</span>
                        <span class="player-status ${statusClass}">${statusText}</span>
                    </div>
                `;
            });

            if (append) {
                container.insertAdjacentHTML('beforeend', html);
            } else {
                container.innerHTML = html;
            }

            // Show or hide Load More button
            if (currentPage < totalPages) {
                loadMoreBtn.style.display = 'inline-flex';
            } else {
                loadMoreBtn.style.display = 'none';
            }

        } catch (err) {
            console.error('Failed to load player batch', err);
        } finally {
            isLoading = false;
        }
    }

    // "Load More" click handler
    if (loadMoreBtn) {
        loadMoreBtn.addEventListener('click', () => {
            if (currentPage < totalPages) {
                fetchPlayers(currentPage + 1, true);
            }
        });
    }

    // Initial load
    fetchPlayers(1, false);

    // Refresh page 1 periodically (keep counts updated without blowing up DOM)
    setInterval(() => {
        if (currentPage === 1) {
            fetchPlayers(1, false);
        }
    }, 15000);
})();
</script>
<script>
(function () {
  const toggleBtns = document.querySelectorAll('.view-toggle-btn');
  const gridView = document.getElementById('mortyGridView');
  const listView = document.getElementById('mortyListView');

  function setView(view) {
    if (view === 'list') {
      gridView.style.display = 'none';
      listView.style.display = 'grid';
    } else {
      gridView.style.display = 'grid';
      listView.style.display = 'none';
    }
    toggleBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === view);
    });
    localStorage.setItem('mortyView', view);
  }

  toggleBtns.forEach(btn => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  const saved = localStorage.getItem('mortyView');
  if (saved) setView(saved);
})();
</script>
<!-- Tab-switching Script -->
  <script>
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabPanes.forEach(pane => pane.classList.remove('active'));

        button.classList.add('active');

        const targetId = button.getAttribute('data-target');
        document.getElementById(targetId).classList.add('active');
      });
    });
  </script>
  <?php if (empty($got_hash)): ?>
  <script>
    const btnGen = document.getElementById("btnGen");
    const btnCopy = document.getElementById("btnCopy");
    const codeBox = document.getElementById("codeBox");
    const msgOk = document.getElementById("msgOk");
    const msgErr = document.getElementById("msgErr");

    function showOk(t){ msgErr.style.display="none"; msgOk.textContent=t; msgOk.style.display="block"; }
    function showErr(t){ msgOk.style.display="none"; msgErr.textContent=t; msgErr.style.display="block"; }

    btnGen.addEventListener("click", async () => {
      msgOk.style.display = "none";
      msgErr.style.display = "none";
      codeBox.style.display = "none";
      btnCopy.style.display = "none";
      btnGen.disabled = true;

      try{
        const res = await fetch("/../generate.php", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({})
        });

        const text = await res.text();
        let json;
        try { json = JSON.parse(text); } catch { json = null; }

        if (!res.ok || !json || !json.success){
          return showErr((json && (json.message || json.error)) ? (json.message || json.error) : (text || "Failed."));
        }

        const code = json.recovery_code;
        const message = json.message;
        codeBox.textContent = code;
        codeBox.style.display = "block";
        btnCopy.style.display = "inline-flex";
        showOk(message);

      } catch(e){
        showErr("Network error. Try again.");
      } finally {
        btnGen.disabled = false;
      }
    });

    btnCopy.addEventListener("click", async () => {
      try{
        await navigator.clipboard.writeText(codeBox.textContent);
        showOk("Copied to clipboard. Save it somewhere safe. Refresh page once saved.");
      } catch(e){
        showErr("Copy failed. You can manually select and copy the code.");
      }
    });
  </script>
  <?php endif; ?>
</body>
</html>