<?php
declare(strict_types=1);
require __DIR__ . "/../auth.php";
$user = require_user($pdo);

header('Content-Type: application/json');

// Pagination params
$page  = max(1, (int)($_GET['page'] ?? 1));
$limit = max(1, min(100, (int)($_GET['limit'] ?? 20))); // Default 20 per page, max 100
$offset = ($page - 1) * $limit;

try {
    // 1. Get global counts in one fast query
    $countSql = "SELECT 
                    COUNT(*) AS total_players,
                    COUNT(DISTINCT created_with_ip) AS unique_players,
                    COUNT(CASE WHEN last_seen >= (NOW() - INTERVAL 1 MINUTE) THEN 1 END) AS online_count
                FROM users";
    $counts = $pdo->query($countSql)->fetch(PDO::FETCH_ASSOC);

    // 2. Fetch paginated subset of players
    $sql = "SELECT 
                username, 
                last_seen,
                (last_seen >= (NOW() - INTERVAL 1 MINUTE)) AS is_online
            FROM users 
            ORDER BY is_online DESC, last_seen DESC
            LIMIT :limit OFFSET :offset";

    $stmt = $pdo->prepare($sql);
    $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
    $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
    $stmt->execute();
    $players = $stmt->fetchAll(PDO::FETCH_ASSOC);

    echo json_encode([
        'success'      => true,
        'page'         => $page,
        'limit'        => $limit,
        'total_pages'  => ceil($counts['total_players'] / $limit),
        'online_count' => (int)$counts['online_count'],
        'total_players' => (int)$counts['total_players'],
        'unique_players' => (int)$counts['unique_players'],
        'players'      => $players
    ]);
} catch (\Throwable $e) {
    http_response_code(500);
    echo json_encode(['success' => false, 'error' => 'Database error']);
}