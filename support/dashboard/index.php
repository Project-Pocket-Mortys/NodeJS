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
  $got_hash = $get_hash['recovery_code_hash'];
  
  $stmt = $pdo->prepare("SELECT recovery_code_hash,player_id,username,level,xp,xp_lower,xp_upper,player_avatar_id FROM users WHERE recovery_code_hash = ?");
  $stmt->execute([$got_hash]);
  $get_player = $stmt->fetch();
  
  $username = $get_player["username"] ?? null;
  }

/* -------------------------------------------------
   XP / LEVEL MATH (Calculated via lower/upper bounds)
   ------------------------------------------------- */
$level = 1;
$progressPct = 0;

if ($get_player) {
    $level   = (int)($get_player["level"] ?? 1);
    $xpLower = (int)($get_player["xp_lower"] ?? 0);
    $xpUpper = (int)($get_player["xp_upper"] ?? 0);

    $xpThisLevel = $xpUpper - $xpLower;

    // Since xpTotal is excluded, we derive progress based on the relationship 
    // between lower and upper bounds, or update this to your specific proxy value.
    // To have the bar fill based on a valid percentage range:
    $progressPct = ($xpThisLevel > 0) ? (($xpLower / $xpUpper) * 100) : 0;
    
    if ($progressPct < 0) $progressPct = 0;
    if ($progressPct > 100) $progressPct = 100;
}

$owned_morties = [];

$mortyStmt = $pdo->prepare("
    SELECT *
    FROM owned_morties
    WHERE player_id = ?
");

$mortyStmt->execute([$get_player['player_id']]);

while ($m = $mortyStmt->fetch(PDO::FETCH_ASSOC)) {
    $owned_morties[] = [
        "morty_id"            => $m["morty_id"],
        "level"               => (int)$m["level"],
		"img"                 => "https://pocketmortys.net/media/com_pocketmortys/assets/".$m["morty_id"]."Down_1.png",
        "variant"             => $m["variant"] ?: "Normal",
        "is_locked"           => (bool)$m["is_locked"],
    ];
}



$currentAvatars = [
    ["name" => "RickPrime",    "img" => "assets/avatars/rick-prime.png"],
    ["name" => "MertyJunior",  "img" => "assets/avatars/morty-junior.png"],
    ["name" => "Bimlperson",   "img" => "assets/avatars/birdperson.png"],
];


// online players
$sql = "SELECT username, last_seen FROM users WHERE last_seen >= (NOW() - INTERVAL 5 MINUTE)";
$stmt = $pdo->prepare($sql);
$stmt->execute();
$online_players = $stmt->fetchAll(PDO::FETCH_ASSOC);
$online_count = count($online_players);
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
      --font: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    }

    *{ box-sizing: border-box; }
    html, body{ height: 100%; }

    body{
      margin: 0;
      font-family: var(--font);
      color: var(--text);
      padding: 20px;
      background:
        radial-gradient(1400px 900px at 50% 0%, rgba(61,255,160,0.14), transparent 55%),
        radial-gradient(900px 700px at 90% 80%, rgba(53,224,232,0.08), transparent 55%),
        var(--bg-deep);
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
    @media (max-width: 900px){ .main-grid{ grid-template-columns: 1fr; } }

    .panel{
      border-radius: 22px;
      border: 1px solid var(--panel-border);
      background: var(--panel);
      box-shadow: var(--panel-glow);
      padding: 16px;
    }

    /* ---- Left panel: tabs row ---- */
    .tabs-row{
      display: flex;
      align-items: center;
      gap: 10px;
      margin-bottom: 12px;
    }
    .tab-btn{
      display: inline-flex;
      align-items: center;
      gap: 7px;
      padding: 9px 14px;
      border-radius: 12px;
      font-size: 13px;
      font-weight: 700;
      cursor: pointer;
      border: 1px solid transparent;
      background: transparent;
      color: var(--muted);
    }
    .tab-btn.active{
      color: var(--portal-green);
      border-color: rgba(61,255,160,0.4);
      background: rgba(61,255,160,0.10);
    }
    .tabs-spacer{ flex: 1; }

    /* ---- Tab Content Panes ---- */
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
      color: var(--portal-green);
      font-weight: 700;
    }
    .player-status::before {
      content: "";
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--portal-green);
      box-shadow: 0 0 8px var(--portal-green);
    }

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

    .morty-card{
      position: relative;
      border-radius: 12px;
      border: 1px solid rgba(255,255,255,0.10);
      background: rgba(10,20,28,0.7);
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
      border-radius: 6px;
      background: rgba(0,0,0,0.6);
      display: grid;
      place-items: center;
    }
    .lock-icon svg{ width: 11px; height: 11px; color: #fff; }
    .morty-rarity-bar{
	  font-weight:bold;
	  text-align:center;
      height: 23px;
      width: 100%;
    }

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
      font-size: 13.5px;
      display: flex;
      gap: 6px;
      flex-wrap: wrap;
    }
    .info-row .label{ font-weight: 700; color: var(--text); }
    .info-row .value{ color: var(--muted); font-weight: 600; }
    .info-row .value.code{ font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; font-size: 11.5px; }

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
      <section class="panel">
        <div class="tabs-row">
		  <button class="tab-btn active" type="button" data-target="tab-online">
            Online (<?php echo $online_count; ?>)
          </button>
          <button class="tab-btn" type="button" data-target="tab-morties">
            Owned Morties
          </button>
          <button class="tab-btn" type="button" data-target="tab-events">
            Current Events
          </button>
		  <button class="tab-btn" type="button" data-target="tab-shop">
            Shop
          </button>
          <div class="tabs-spacer"></div>
        </div>

        <!-- TAB 1: Online Players -->
        <div id="tab-online" class="tab-pane active">
          <div class="player-list">
            <?php if (empty($online_players)): ?>
              <div class="empty-state">No other travelers online right now.</div>
            <?php else: ?>
              <?php foreach ($online_players as $op): ?>
                <div class="player-item">
                  <span><?= htmlspecialchars($op['username']); ?></span>
                  <span class="player-status">Online</span>
                </div>
              <?php endforeach; ?>
            <?php endif; ?>
          </div>
        </div>

        <!-- TAB 2: Owned Morties -->
        <div id="tab-morties" class="tab-pane">
          <div class="morty-grid">
            <?php foreach ($owned_morties as $m): ?>
              <div class="morty-card">
                <div class="morty-name-tag"><?= htmlspecialchars($m['morty_id']) ?></div>
                <div class="morty-thumb-wrap">
                  <?php if ((bool)$m['is_locked']): ?>
                    <div class="lock-icon">
                      <svg viewBox="0 0 24 24" fill="none"><rect x="5" y="11" width="14" height="9" rx="2" stroke="currentColor" stroke-width="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="2"/></svg>
                    </div>
                  <?php endif; ?>
                  <img src="<?= htmlspecialchars($m['img']) ?>" alt="<?= htmlspecialchars($m['morty_id']) ?>" />
                </div>
                <div class="morty-rarity-bar">Lvl <?= (int)$m['level'] ?></div>
              </div>
            <?php endforeach; ?>
          </div>
        </div>

        <!-- TAB 3: Current Events -->
        <div id="tab-events" class="tab-pane">
          <div class="empty-state">No active events in this dimension right now. Check back soon!</div>
        </div>

        <!-- TAB 4: Shop -->
        <div id="tab-shop" class="tab-pane">
          <div class="empty-state">The Blips and Chitz shop is currently closed.</div>
        </div>

      </section>

      <!-- ---------- RIGHT: Account Overview ---------- -->
      <aside class="panel">
        <h2>Account Overview</h2>
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
<?php if ($get_player): ?>
<div class="xp-container">
    <div class="lvl-label">LvL <?= (int)$level ?></div>
    <div class="xp-capsule">
        <div class="xp-capsule-fill" style="width: <?= number_format($progressPct, 2, '.', '') ?>%;"></div>
        <div class="xp-capsule-text">XP: <?= number_format($xpLower) ?> / <?= number_format($xpUpper) ?></div>
    </div>
</div>
<?php else: ?>
  <div class="xp-capsule empty">
      <div class="xp-capsule-text">Link your account to track XP</div>
  </div>
<?php endif; ?>
      </aside>
    </div>

    <!-- ================= LINKING / RECOVERY CODE (functional, unchanged) ================= -->
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

<!-- Tab-switching Script -->
  <script>
    const tabButtons = document.querySelectorAll('.tab-btn');
    const tabPanes = document.querySelectorAll('.tab-pane');

    tabButtons.forEach(button => {
      button.addEventListener('click', () => {
        // Remove active class from all buttons and panes
        tabButtons.forEach(btn => btn.classList.remove('active'));
        tabPanes.forEach(pane => pane.classList.remove('active'));

        // Add active class to clicked button
        button.classList.add('active');

        // Target and activate corresponding pane
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