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
      --panel-glow: 0 0 0 1px rgba(80,255,170,0.06), 0 24px 60px rgba(0,0,0,0.65), 0 0 50px rgba(56,255,150,0.06);
      --text: rgba(232, 255, 248, 0.97);
      --muted: rgba(200, 235, 220, 0.62);
      --danger: #ef3b46;
      --danger-2: #a01820;
    }

    *{ box-sizing: border-box; }
    html, body{ height: 95%; }

    body{
      color: #adff2f; 
      font-family: 'Orbitron', 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 1px;
      padding: 20px;
      background-color: #0d1b15;
      background-image: url('../images/bk.png');
      background-repeat: no-repeat;
      background-position: center center;
      background-size: cover;
      background-attachment: fixed;
      -webkit-font-smoothing: antialiased;
    }

    .app-shell{
      max-width: 1180px;
      margin: 0 auto;
      display: grid;
      gap: 14px;
    }

    /* ================= IDENTITY BAR ================= */
    .identity-bar{
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
    }
    .identity-avatar{
      width: 100px;
      height: 100px;
      border-radius: 50%;
      flex: 0 0 auto;
      object-fit: cover;
      object-position: 50% 10%;
      border: 2px solid rgba(255,255,255,0.3);
      background: rgba(255,255,255,0.04);
    }
    .identity-name{
      font-size: 20px;
      font-weight: 800;
      color: var(--portal-green);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .identity-email{
      font-size: 12.5px;
      color: var(--muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .identity-right{
      display: flex;
      align-items: center;
      gap: 12px;
      flex-wrap: wrap;
    }
    .pill-connected{
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 10px 16px;
      border-radius: 999px;
      border: 1px solid rgba(61,255,160,0.4);
      background: rgba(61,255,160,0.10);
      font-size: 13px;
      font-weight: 700;
      color: var(--text);
      white-space: nowrap;
    }
    .pill-connected svg{ width: 15px; height: 15px; flex: 0 0 auto; }
    .btn-leave{
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
      background: linear-gradient(135deg, var(--danger), var(--danger-2));
      box-shadow: 0 10px 26px rgba(239,59,70,0.25);
      white-space: nowrap;
    }

    /* ================= MAIN GRID ================= */
    .main-grid{
      display: grid;
      grid-template-columns: 1.15fr 0.85fr;
      gap: 14px;
      align-items: start;
    }
    @media (max-width: 1100px){ .main-grid{ grid-template-columns: 1fr; } }

    .panel{
      border-radius: 22px;
      border: 1px solid var(--panel-border);
      background: var(--panel);
      box-shadow: var(--panel-glow);
      padding: 16px;
    }

    /* Stack sidebar panels vertically on the right */
    .right-panels-column {
      display: flex;
      flex-direction: column;
      gap: 14px;
    }

.tabs-row{
  text-align:center;
  display: flex;
  align-items: center;
  gap: 5px;
  margin-bottom: 0px;
}
.tab-btn{
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
      padding: 8px 16px;
      border-top-left-radius: 20px;
      border-top-right-radius: 20px;
      border-bottom-left-radius: 0px;
      border-bottom-right-radius: 0px;
  font-size: 13px;
  font-weight: 800;
  cursor: pointer;
  color: rgba(220, 255, 235, 0.75);
  background: linear-gradient(180deg, rgba(28,68,52,0.95), rgba(10,32,24,0.95));
  border: 1.5px solid rgba(120, 255, 180, 0.30);
  border-bottom: none;
  transition: all 0.2s ease;
  position: relative;
  bottom: -16px;
  z-index: 2;
}

.tab-btn:hover{
  border-color: rgba(120, 255, 180, 0.55);
  color: #eafff5;
}
.tab-btn.active{
  color: #ffffff;
  border-color: rgba(120, 255, 180, 0.8);
  border-bottom: 1px solid transparent; /* blends into container like before */
  background: linear-gradient(180deg, rgba(45,110,80,0.95), rgba(16,50,38,0.95));
  box-shadow: 0 -2px 10px rgba(61, 255, 160, 0.35);
}
.tabs-spacer{ flex: 1; }

/* ---- Tab Content Panes (Flush Container Layout) ---- */
.tab-content-container {
    border-top-left-radius: 0;
    border-top-right-radius: 22px;
    border-bottom-left-radius: 22px;
    border-bottom-right-radius: 22px;

    border: 1px solid rgba(61, 255, 160, 0.8);
    background: rgba(6, 22, 20, 0.95);
    box-shadow: 0 0 10px rgba(61, 255, 160, 0.4);

    /* Push content down a little more */
    padding: 16px 16px 16px;

    /* Leave a little gap below the tabs */
    margin-top: 14px;

    position: relative;
    z-index: 1;
}
    .tab-pane {
      display: none;
    }
    .tab-pane.active {
      display: block;
    }

    /* ---- Online Players List Styling ---- */
    .player-list {
      max-height: 480px;
      overflow-y: auto;
      padding-right: 6px;
      display: grid;
      gap: 8px;
    }
    .player-item {
	  color:white;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 10px 14px;
      border-radius: 10px;
      background: rgba(255,255,255,0.04);
      border: 1px solid rgba(255,255,255,0.08);
      font-size: 13px;
    }
.player-status {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-weight: 700;
}

/* Online state styling */
.player-status.online {
  color: var(--portal-green, #22c55e);
}
.player-status.online::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--portal-green, #22c55e);
  box-shadow: 0 0 8px var(--portal-green, #22c55e);
}

/* Offline state styling */
.player-status.offline {
  color: #ef4444; /* Standard alert red (or use your custom red variable) */
}
.player-status.offline::before {
  content: "";
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #ef4444;
  box-shadow: 0 0 8px #ef4444; /* Subtle red glow */
}

/* ---- View Toggle ---- */
.morty-toolbar{
  display: flex;
  justify-content: flex-end;
  margin-bottom: 10px;
}
.view-toggle{
  display: inline-flex;
  border-radius: 10px;
  border: 1px solid rgba(120, 255, 180, 0.30);
  background: rgba(10, 30, 20, 0.6);
  overflow: hidden;
}
.view-toggle-btn{
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 30px;
  border: none;
  cursor: pointer;
  background: transparent;
  color: rgba(220, 255, 235, 0.55);
  transition: all 0.15s ease;
}
.view-toggle-btn svg{ width: 15px; height: 15px; }
.view-toggle-btn:hover{ color: #eafff5; }
.view-toggle-btn.active{
  background: rgba(61, 255, 160, 0.22);
  color: #ffffff;
}
.view-toggle-btn + .view-toggle-btn{
  border-left: 1px solid rgba(120, 255, 180, 0.20);
}

/* ---- List View (fully independent styling) ---- */
.morty-list{
  display: grid;
  gap: 6px;
  max-height: 480px;
  overflow-y: auto;
  padding-right: 6px;
}
.morty-row{
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 14px 8px 8px;
  border-radius: 10px;
  background: rgba(10, 20, 28, 0.6);
  border: 1px solid rgba(255,255,255,0.08);
}
.morty-row-thumb{
  position: relative;
  width: 44px;
  height: 44px;
  flex: 0 0 auto;
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
.morty-row-lock svg{ width: 14px; height: 14px; color: #fff; }
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
}
.morty-list::-webkit-scrollbar{ width: 6px; }
.morty-list::-webkit-scrollbar-thumb{ background: rgba(61,255,160,0.35); border-radius: 6px; }
.morty-list::-webkit-scrollbar-track{ background: rgba(255,255,255,0.04); }


    /* ---- Morty grid ---- */
    .morty-grid{
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 10px;
      max-height: 480px;
      overflow-y: auto;
      padding-right: 6px;
    }
    .morty-grid::-webkit-scrollbar, .player-list::-webkit-scrollbar{ width: 6px; }
    .morty-grid::-webkit-scrollbar-thumb, .player-list::-webkit-scrollbar-thumb{ background: rgba(61,255,160,0.35); border-radius: 6px; }
    .morty-grid::-webkit-scrollbar-track, .player-list::-webkit-scrollbar-track{ background: rgba(255,255,255,0.04); }

    @media (max-width: 620px){ .morty-grid{ grid-template-columns: repeat(2, 1fr); } }

    .morty-thumb-wrap {
      position: relative;
      width: 100%;
      aspect-ratio: 1 / 1;
      background: linear-gradient(160deg, rgba(61,255,160,0.10), rgba(53,224,232,0.06));
    }
    .morty-thumb-wrap img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
/* --- NEW LEVEL OVERLAY STYLES --- */
.morty-level-overlay {
  position: absolute;
  bottom: 4px;      /* Slightly inset from the bottom edge */
  right: 4px;       /* Anchors directly to the right edge */
  z-index: 3;
  background: rgba(0, 0, 0, 0.85); /* Slightly transparent dark bg looks cleaner */
  border-radius: 6px;
  padding: 2px 6px;
  font-size: 12px;
  font-weight: 800;
  color: #A6A2A1;
  text-shadow: 0 1px 2px rgba(0,0,0,0.9);
  letter-spacing: 0.05em;
  white-space: nowrap; /* Prevents text like "Lvl 10" from wrapping into two lines */
}

    .morty-card{
      position: relative;
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
      text-shadow: 0 1px 3px rgba(0,0,0,0.9);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
	  text-align:center;
    }
    .morty-thumb-wrap{
      position: relative;
      width: 100%;
      aspect-ratio: 1 / 1;
      background: linear-gradient(160deg, rgba(61,255,160,0.10), rgba(53,224,232,0.06));
    }
    .morty-thumb-wrap img{
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .lock-icon{
      position: absolute;
      z-index: 3;
      width: 100%;
      height: 100%;
      background: rgba(0,0,0,0.6);
      display: grid;
      place-items: center;
    }
    .lock-icon svg{ width: 11px; height: 11px; color: #fff; }

    /* ---- Right panel ---- */
    .panel h2{
      margin: 0 0 12px;
      font-size: 15px;
      font-weight: 800;
      letter-spacing: 0.02em;
      color: var(--text);
    }

    .info-block{
      display: flex;
      align-items: center;
      gap: 14px;
    }
    .info-rows{ flex: 1; min-width: 0; }
    .info-row{
      padding: 7px 0;
      font-size: 15px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .info-row .label{ font-weight: 700; color: var(--text); }
    .info-row .value{ color: white; font-weight: 600; }
    .info-row .value.code{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 15.5px; }

    .xp-container {
        display: flex;
        align-items: center;
        gap: 12px;
        margin-top: 14px;
    }

    .lvl-label {
        font-size: 24px;
        font-weight: 900;
        color: #ffffff;
        font-style: italic;
        letter-spacing: -0.02em;
        text-shadow: 0 2px 4px rgba(0,0,0,0.5);
        white-space: nowrap;
    }

    .xp-capsule {
        position: relative;
        flex: 1;
        height: 40px;
        border-radius: 999px;
        background: #2b3b4a;
        border: 3px solid #000000;
        overflow: hidden;
        box-shadow: 0 4px 6px rgba(0,0,0,0.3);
    }

    .xp-capsule-fill {
        height: 100%;
        width: 0%;
        background: repeating-linear-gradient(
            135deg,
            #ff8c00 0px,
            #ff8c00 20px,
            #ffa500 20px,
            #ffa500 40px
        );
        transition: width 0.4s ease;
    }

    .xp-capsule-text {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        font-weight: 800;
        font-size: 13px;
        letter-spacing: 0.03em;
        color: #ffffff;
        text-shadow: 0 1px 3px rgba(0,0,0,0.8);
    }

    .empty-state{
      padding: 22px 14px;
      text-align: center;
      color: var(--muted);
      font-size: 13.5px;
      border: 1px dashed rgba(255,255,255,0.14);
      border-radius: 12px;
      line-height: 1.5;
    }
    .codeBox{
      margin-top: 10px;
      padding: 14px;
      border-radius: 12px;
      border: 1px dashed rgba(61,255,160,0.4);
      background: rgba(0,0,0,0.3);
      font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      font-size: 16px;
      letter-spacing: 0.1em;
      text-align: center;
      display: none;
    }
    .msg{
      margin-top: 10px;
      padding: 12px;
      border-radius: 12px;
      font-size: 13px;
      border: 1px solid transparent;
      display: none;
    }
    .msg.ok{ background: rgba(61,255,160,0.10); border-color: rgba(61,255,160,0.3); }
    .msg.err{ background: rgba(239,59,70,0.12); border-color: rgba(239,59,70,0.3); }
    .rowBtns{ display: flex; gap: 10px; flex-wrap: wrap; margin-top: 12px; }
    .btn{
      border: 0; cursor: pointer; border-radius: 12px; padding: 11px 16px;
      font-weight: 700; font-size: 13px; text-decoration: none;
      display: inline-flex; align-items: center; justify-content: center; gap: 8px;
    }
    .btn.primary{ background: linear-gradient(135deg, var(--portal-green), var(--portal-cyan)); color: #04140b; }
    .btn.ghost{ background: rgba(255,255,255,0.06); border: 1px solid var(--panel-border); color: var(--text); }
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
          Go into the game on your phone, open Settings &rarr; FAQ, log in to your account, then select "Link Account."
        </div>
        <?php
          $userAgent = strtolower($_SERVER['HTTP_USER_AGENT'] ?? '');
          if (stripos($userAgent, 'android') !== false):
        ?>
          <div class="rowBtns">
            <a class="btn primary" href="pocketmortys://Braze?LinkAccount=<?= htmlspecialchars($got_hash) ?>">
              Link Account
            </a>
          </div>
        <?php endif; ?>
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