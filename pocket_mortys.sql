CREATE TABLE `challenges` (
  `id` int NOT NULL,
  `challenge_id` varchar(36) COLLATE utf8mb4_general_ci NOT NULL,
  `target` int DEFAULT '0',
  `reward_type` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reward_amount` int DEFAULT '0',
  `reward_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `reward_parameters` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `cooldown` int DEFAULT '0',
  `is_daily` tinyint(1) DEFAULT '1',
  `tag` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `tag_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `challange_name` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `progress` int DEFAULT '0',
  `cooldown_expires` timestamp NULL DEFAULT NULL,
  `in_cooldown` tinyint(1) DEFAULT '0',
  `end_time` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `challenges` (`id`, `challenge_id`, `target`, `reward_type`, `reward_amount`, `reward_id`, `reward_parameters`, `cooldown`, `is_daily`, `tag`, `tag_id`, `challange_name`, `progress`, `cooldown_expires`, `in_cooldown`, `end_time`) VALUES
(1, '9e5d1da5-e8d1-46a0-bb66-3ffc6b9c21ee', 3, 'COUPON', 1, NULL, NULL, 0, 1, 'BattleWinPvWM', NULL, NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(2, '98d200db-fb67-46df-94ea-d73667b52ec0', 1, 'ITEM', 1, 'ItemGreatSerum', NULL, 0, 1, 'PurchaseItemName', 'ItemPoisonCure', NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(3, '7c812c30-29d4-47d1-bd83-31c25ce921ff', 1, 'COIN', 200, NULL, NULL, 0, 1, 'PurchaseItemName', 'ItemGreatSerum', NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(4, 'a0d87751-c5d3-46a7-b9c6-d12607ec514b', 1, 'COIN', 500, NULL, NULL, 0, 1, 'UseItemName', 'ItemMegaSeedLevelUp', NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(5, '5433a483-b571-448d-a096-19d097f55447', 4, 'COIN', 100, NULL, NULL, 0, 1, 'BattleCompleteArena', NULL, NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(6, '783a59bc-7694-4124-8ca3-baca6f7e9b47', 2, 'COIN', 200, NULL, NULL, 0, 1, 'EvolveMorty', NULL, NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(7, 'b2cd638c-ef0c-4c47-bf3f-6b08ef6c07f1', 5, 'COIN', 100, NULL, NULL, 0, 1, 'WildMorty', NULL, NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(8, '715473f3-bf86-4310-b5b7-163e324feaa2', 4, 'COIN', 100, NULL, NULL, 0, 1, 'BattleCompleteArena', NULL, NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(9, '5c27e488-3a08-43cd-b40e-323168e772eb', 5, 'ITEM', 1, 'ItemCable', NULL, 0, 1, 'BattleCatchPvWMElement', 'Rock', NULL, 0, NULL, 0, '2026-01-28 04:59:59'),
(10, '9b99c800-b69f-44e3-b7e1-651644e94b83', 1, 'ITEM', 1, 'ItemParalysisCure', NULL, 0, 1, 'UseItemName', 'ItemPoisonCure', NULL, 0, NULL, 0, '2026-01-28 04:59:59');

CREATE TABLE `completed_trades` (
  `id` int NOT NULL,
  `completed_trade_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `request_player_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `offer_player_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `morty_request_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `morty_offer_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `trade_offer_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `trade_request_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `is_free_trade` tinyint(1) DEFAULT '1',
  `fulfilled_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `completed_trades` (`id`, `completed_trade_id`, `request_player_id`, `offer_player_id`, `morty_request_id`, `morty_offer_id`, `trade_offer_id`, `trade_request_id`, `is_free_trade`, `fulfilled_at`) VALUES
(1, 'c5874f46a414d02924dddcb580bcbc2a', 'f8a69ceb-1ef8-4d0b-81dc-d6d59e425163', '89811bec-bf25-4c52-bde9-ec3438947c05', 'aad4a06f-c1ca-4c96-9e8b-ef1c2abbc039', 'd9003aac-9633-4f44-9d88-1efd3b000ecc', 'ffd9fc1fb804ea2fdc5c5bcd5b6df2af', 'f19e7fee-f20d-4c3e-96f2-7440814e4df6', 0, '2026-04-05 08:18:56');

CREATE TABLE `decks` (
  `id` int NOT NULL,
  `player_id` text COLLATE utf8mb4_general_ci,
  `deck_id` int DEFAULT NULL,
  `owned_morty_ids` text COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `deck_config` (
  `id` int NOT NULL,
  `config_id` varchar(255) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'MP',
  `starting_deck_slots` int NOT NULL DEFAULT '3',
  `max_deck_slots` int NOT NULL DEFAULT '9',
  `cost_additional_slot` int NOT NULL DEFAULT '10'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `deck_config` (`id`, `config_id`, `starting_deck_slots`, `max_deck_slots`, `cost_additional_slot`) VALUES
(1, 'MP', 3, 9, 10);

CREATE TABLE `events` (
  `id` int NOT NULL,
  `raid_event_id` text COLLATE utf8mb4_general_ci,
  `shard_id` text COLLATE utf8mb4_general_ci,
  `current_state` text COLLATE utf8mb4_general_ci NOT NULL,
  `world_id` int DEFAULT NULL,
  `spawn_location` text COLLATE utf8mb4_general_ci,
  `boss_id` text COLLATE utf8mb4_general_ci,
  `asset_id` text COLLATE utf8mb4_general_ci,
  `threat_lvl` int DEFAULT NULL,
  `total_damage` bigint DEFAULT NULL,
  `initial_health` bigint DEFAULT NULL,
  `max_health_bars` bigint DEFAULT NULL,
  `event_state_next_timestamp` timestamp NULL DEFAULT NULL,
  `has_ran` tinyint(1) DEFAULT '0',
  `permit_start` text COLLATE utf8mb4_general_ci,
  `permit_buy_in` text COLLATE utf8mb4_general_ci,
  `ticket_buy_in` text COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `events` (`id`, `raid_event_id`, `shard_id`, `current_state`, `world_id`, `spawn_location`, `boss_id`, `asset_id`, `threat_lvl`, `total_damage`, `initial_health`, `max_health_bars`, `event_state_next_timestamp`, `has_ran`, `permit_start`, `permit_buy_in`, `ticket_buy_in`) VALUES
(1, 'RaidBossKillerAsteroid_2025', '78496e72-fb88-11f0-b2fd-8b24d97da62f', 'build_up', 1, '37,58', 'killer_asteroid', 'RaidBossKillerAsteroid', 10, 0, 30860800, 60275, '2030-01-01 00:00:00', 0, '50', '1', '0');


CREATE TABLE `friend_list` (
  `id` int NOT NULL,
  `player_id_a` text COLLATE utf8mb4_general_ci,
  `player_id_b` text COLLATE utf8mb4_general_ci,
  `pending` text COLLATE utf8mb4_general_ci,
  `direction` text COLLATE utf8mb4_general_ci,
  `created` text COLLATE utf8mb4_general_ci NOT NULL,
  `modified` text COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `gachas` (
  `id` int NOT NULL,
  `gacha_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `cost` int NOT NULL DEFAULT '0',
  `lvl_min` int NOT NULL,
  `lvl_max` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `gachas` (`id`, `gacha_id`, `cost`, `lvl_min`, `lvl_max`) VALUES
(1, 'GachaMPProduct1', 5, 32, 34),
(2, 'GachaMPProduct2', 10, 32, 34),
(3, 'GachaMPProduct3', 30, 32, 34);

CREATE TABLE `gacha_contents` (
  `id` int NOT NULL,
  `gacha_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `reward` enum('ITEM','MORTY') COLLATE utf8mb4_general_ci NOT NULL,
  `quantity` int NOT NULL DEFAULT '1',
  `division_guarantee` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `gacha_contents` (`id`, `gacha_id`, `reward`, `quantity`, `division_guarantee`) VALUES
(1, 'GachaMPProduct1', 'ITEM', 1, NULL),
(2, 'GachaMPProduct1', 'MORTY', 1, NULL),
(3, 'GachaMPProduct1', 'MORTY', 2, 2),
(4, 'GachaMPProduct2', 'MORTY', 1, 3),
(5, 'GachaMPProduct2', 'MORTY', 3, 2),
(6, 'GachaMPProduct2', 'ITEM', 4, NULL),
(7, 'GachaMPProduct2', 'MORTY', 3, NULL),
(8, 'GachaMPProduct3', 'MORTY', 4, 2),
(9, 'GachaMPProduct3', 'MORTY', 3, NULL),
(10, 'GachaMPProduct3', 'MORTY', 1, 4),
(11, 'GachaMPProduct3', 'MORTY', 2, 3),
(12, 'GachaMPProduct3', 'ITEM', 10, NULL);

CREATE TABLE `gacha_content_items` (
  `id` int NOT NULL,
  `gacha_content_id` int NOT NULL,
  `item_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `gacha_content_items` (`id`, `gacha_content_id`, `item_id`) VALUES
(1, 1, 'ItemMortyChip'),
(2, 1, 'ItemPureSerum'),
(3, 1, 'ItemHalzinger'),
(4, 1, 'ItemPureHalzinger'),
(5, 1, 'ItemFullRecover'),
(6, 1, 'ItemMrMeeseek'),
(7, 1, 'ItemMegaSeedAttack'),
(8, 1, 'ItemMegaSeedDefence'),
(9, 1, 'ItemMegaSeedSpeed'),
(10, 1, 'ItemMegaSeedLevelUp'),
(11, 6, 'ItemMortyChip'),
(12, 6, 'ItemPureSerum'),
(13, 6, 'ItemHalzinger'),
(14, 6, 'ItemPureHalzinger'),
(15, 6, 'ItemFullRecover'),
(16, 6, 'ItemMrMeeseek'),
(17, 6, 'ItemMegaSeedAttack'),
(18, 6, 'ItemMegaSeedDefence'),
(19, 6, 'ItemMegaSeedSpeed'),
(20, 6, 'ItemMegaSeedLevelUp'),
(21, 12, 'ItemMortyChip'),
(22, 12, 'ItemPureSerum'),
(23, 12, 'ItemHalzinger'),
(24, 12, 'ItemPureHalzinger'),
(25, 12, 'ItemFullRecover'),
(26, 12, 'ItemMrMeeseek'),
(27, 12, 'ItemMegaSeedAttack'),
(28, 12, 'ItemMegaSeedDefence'),
(29, 12, 'ItemMegaSeedSpeed'),
(30, 12, 'ItemMegaSeedLevelUp');

CREATE TABLE `gacha_drop_rates` (
  `id` int NOT NULL,
  `gacha_promo_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `division` int NOT NULL,
  `chance` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `gacha_drop_rates` (`id`, `gacha_promo_id`, `division`, `chance`) VALUES
(1, 'GachaMPPromo20230207_2026', 1, 80),
(2, 'GachaMPPromo20230207_2026', 2, 12),
(3, 'GachaMPPromo20230207_2026', 3, 6),
(4, 'GachaMPPromo20230207_2026', 4, 2);

CREATE TABLE `gacha_promos` (
  `id` int NOT NULL,
  `gacha_promo_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `period_start` int NOT NULL,
  `period_end` int NOT NULL,
  `image_url` text COLLATE utf8mb4_general_ci,
  `drop_chance` decimal(8,6) NOT NULL DEFAULT '0.000000',
  `gacha_promo_chance` decimal(8,6) NOT NULL DEFAULT '0.000000',
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `gacha_promos` (`id`, `gacha_promo_id`, `period_start`, `period_end`, `image_url`, `drop_chance`, `gacha_promo_chance`, `created_at`) VALUES
(1, 'GachaMPPromo20230207_2026', 1769438400, 1780042600, 'https://assets.bps-pmnet.com/Media/Promos/GachaBackgrounds/Cust1605801458922.png', 0.060000, 0.060000, '2026-02-05 21:09:03');

CREATE TABLE `gacha_promo_attack_effects` (
  `id` int NOT NULL,
  `promo_attack_id` int NOT NULL,
  `effect_type` varchar(32) COLLATE utf8mb4_general_ci NOT NULL,
  `stat` varchar(32) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `power` int DEFAULT NULL,
  `accuracy` decimal(6,4) DEFAULT NULL,
  `to_self` tinyint(1) DEFAULT NULL,
  `continue_on_miss` tinyint(1) DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `gacha_promo_attack_effects` (`id`, `promo_attack_id`, `effect_type`, `stat`, `power`, `accuracy`, `to_self`, `continue_on_miss`) VALUES
(1, 1, 'Stat', 'Accuracy', 3, 0.9500, 1, NULL),
(2, 2, 'Hit', NULL, 85, 0.9500, NULL, 0),
(3, 2, 'Poison', NULL, NULL, 1.0000, NULL, NULL),
(4, 3, 'Stat', 'Speed', -2, 0.9500, NULL, NULL),
(5, 4, 'Hit', NULL, 90, 0.7500, NULL, 0),
(6, 4, 'Stat', 'Speed', 1, 0.7500, 1, NULL),
(7, 4, 'Stat', 'Attack', 1, 0.7500, 1, NULL),
(8, 5, 'Hit', NULL, 95, 0.9000, NULL, NULL),
(9, 6, 'Stat', 'Defence', 2, 0.9500, 1, NULL),
(10, 7, 'Hit', NULL, 15, 0.9500, NULL, NULL),
(11, 7, 'Hit', NULL, 20, NULL, NULL, NULL),
(12, 7, 'Hit', NULL, 30, 0.8000, NULL, NULL),
(13, 7, 'Hit', NULL, 35, 0.5000, NULL, NULL),
(14, 8, 'Stat', 'Attack', 2, 0.9500, 1, NULL),
(15, 9, 'Stat', 'Accuracy', 2, 0.8000, 1, NULL),
(16, 9, 'Stat', 'Attack', 2, 0.8000, 1, NULL),
(17, 10, 'Hit', NULL, 120, 0.9500, NULL, NULL),
(18, 11, 'Hit', NULL, 100, 0.9500, NULL, NULL),
(19, 12, 'Stat', 'Accuracy', 2, 0.9500, 1, NULL),
(20, 13, 'Stat', 'Defence', 2, NULL, 1, NULL),
(21, 13, 'Paralyse', NULL, NULL, 0.5000, NULL, 0),
(22, 13, 'Paralyse', NULL, NULL, NULL, 1, NULL),
(23, 14, 'Hit', NULL, 90, 0.9500, NULL, NULL),
(24, 15, 'Stat', 'Defence', 3, 0.9500, 1, NULL),
(25, 16, 'Paralyse', NULL, NULL, 0.6000, NULL, 0),
(26, 16, 'Stat', 'Attack', -1, NULL, NULL, NULL),
(27, 17, 'Hit', NULL, 50, 0.9000, NULL, NULL),
(28, 17, 'Hit', NULL, 50, 0.9000, NULL, 0),
(29, 17, 'Stat', 'Defence', -1, 0.9500, NULL, NULL),
(30, 18, 'Hit', NULL, 100, 0.8000, NULL, NULL),
(31, 19, 'Stat', 'Attack', 3, 0.9500, 1, NULL),
(32, 20, 'Stat', 'Defence', 3, 0.9500, 1, NULL);

CREATE TABLE `gacha_promo_mortys` (
  `id` int NOT NULL,
  `gacha_promo_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `morty_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `variant` varchar(16) COLLATE utf8mb4_general_ci NOT NULL DEFAULT 'Normal',
  `lvl_min` int NOT NULL,
  `lvl_max` int NOT NULL,
  `hp_min` int NOT NULL,
  `hp_max` int NOT NULL,
  `atk_min` int NOT NULL,
  `atk_max` int NOT NULL,
  `def_min` int NOT NULL,
  `def_max` int NOT NULL,
  `spd_min` int NOT NULL,
  `spd_max` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `gacha_promo_mortys` (`id`, `gacha_promo_id`, `morty_id`, `variant`, `lvl_min`, `lvl_max`, `hp_min`, `hp_max`, `atk_min`, `atk_max`, `def_min`, `def_max`, `spd_min`, `spd_max`) VALUES
(1, 'GachaMPPromo20230207_2026', 'MortyBirdingMan', 'Normal', 32, 34, 86, 101, 50, 63, 60, 73, 46, 59),
(2, 'GachaMPPromo20230207_2026', 'MortyChick', 'Normal', 32, 34, 103, 119, 60, 73, 66, 80, 69, 83),
(3, 'GachaMPPromo20230207_2026', 'MortyRobotChicken', 'Normal', 32, 34, 103, 119, 50, 63, 66, 80, 76, 90),
(4, 'GachaMPPromo20230207_2026', 'MortyDrone', 'Normal', 32, 34, 106, 122, 69, 83, 69, 83, 69, 83),
(5, 'GachaMPPromo20230207_2026', 'MortyTurkerSoldier', 'Normal', 32, 34, 98, 114, 50, 63, 49, 62, 50, 63);

CREATE TABLE `gacha_promo_morty_attacks` (
  `id` int NOT NULL,
  `gacha_promo_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `morty_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `position` int NOT NULL,
  `attack_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `pp` int NOT NULL,
  `pp_stat` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `gacha_promo_morty_attacks` (`id`, `gacha_promo_id`, `morty_id`, `position`, `attack_id`, `pp`, `pp_stat`) VALUES
(1, 'GachaMPPromo20230207_2026', 'MortyBirdingMan', 0, 'AttackSparkle', 10, 10),
(2, 'GachaMPPromo20230207_2026', 'MortyBirdingMan', 1, 'AttackArtsyFartsy', 5, 5),
(3, 'GachaMPPromo20230207_2026', 'MortyBirdingMan', 2, 'AttackStarGaze', 15, 15),
(4, 'GachaMPPromo20230207_2026', 'MortyBirdingMan', 3, 'AttackUpbeat', 10, 10),
(5, 'GachaMPPromo20230207_2026', 'MortyChick', 0, 'AttackServingUp', 8, 8),
(6, 'GachaMPPromo20230207_2026', 'MortyChick', 1, 'AttackHarden', 15, 15),
(7, 'GachaMPPromo20230207_2026', 'MortyChick', 2, 'AttackWetTongue', 5, 5),
(8, 'GachaMPPromo20230207_2026', 'MortyChick', 3, 'AttackSalivate', 15, 15),
(9, 'GachaMPPromo20230207_2026', 'MortyRobotChicken', 0, 'AttackLaserStare', 8, 8),
(10, 'GachaMPPromo20230207_2026', 'MortyRobotChicken', 1, 'AttackDinnerTime', 5, 5),
(11, 'GachaMPPromo20230207_2026', 'MortyRobotChicken', 2, 'AttackFlutter', 8, 8),
(12, 'GachaMPPromo20230207_2026', 'MortyRobotChicken', 3, 'AttackBlink', 12, 12),
(13, 'GachaMPPromo20230207_2026', 'MortyDrone', 0, 'AttackStaticShock', 5, 5),
(14, 'GachaMPPromo20230207_2026', 'MortyDrone', 1, 'AttackCrush', 8, 8),
(15, 'GachaMPPromo20230207_2026', 'MortyDrone', 2, 'AttackWall', 10, 10),
(16, 'GachaMPPromo20230207_2026', 'MortyDrone', 3, 'AttackGrab', 5, 5),
(17, 'GachaMPPromo20230207_2026', 'MortyTurkerSoldier', 0, 'AttackPerchAndPoop', 10, 10),
(18, 'GachaMPPromo20230207_2026', 'MortyTurkerSoldier', 1, 'AttackGobbleTango', 5, 5),
(19, 'GachaMPPromo20230207_2026', 'MortyTurkerSoldier', 2, 'AttackPray', 10, 10),
(20, 'GachaMPPromo20230207_2026', 'MortyTurkerSoldier', 3, 'AttackDefend', 10, 10);

CREATE TABLE `mortydex` (
  `id` int NOT NULL,
  `player_id` text COLLATE utf8mb4_general_ci,
  `morty_id` text COLLATE utf8mb4_general_ci,
  `caught` tinytext COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `owned_avatars` (
  `id` int NOT NULL,
  `player_id` text COLLATE utf8mb4_general_ci,
  `player_avatar_id` text COLLATE utf8mb4_general_ci
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `owned_items` (
  `id` int NOT NULL,
  `player_id` text COLLATE utf8mb4_general_ci,
  `item_id` text COLLATE utf8mb4_general_ci,
  `quantity` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `owned_morties` (
  `id` int NOT NULL,
  `player_id` text COLLATE utf8mb4_general_ci,
  `owned_morty_id` text COLLATE utf8mb4_general_ci,
  `morty_id` text COLLATE utf8mb4_general_ci,
  `level` bigint DEFAULT NULL,
  `xp` bigint DEFAULT NULL,
  `hp` bigint DEFAULT NULL,
  `hp_stat` bigint DEFAULT NULL,
  `attack_stat` bigint DEFAULT NULL,
  `defence_stat` bigint DEFAULT NULL,
  `variant` text COLLATE utf8mb4_general_ci,
  `speed_stat` bigint DEFAULT NULL,
  `is_locked` tinyint(1) DEFAULT '0',
  `is_trading_locked` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `fight_pit_id` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `evolution_points` bigint DEFAULT NULL,
  `xp_lower` bigint DEFAULT NULL,
  `xp_upper` bigint DEFAULT NULL,
  `attacks_array` longtext COLLATE utf8mb4_general_ci,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `registered_users` (
  `id` int UNSIGNED NOT NULL,
  `email` varchar(190) COLLATE utf8mb4_general_ci NOT NULL,
  `password_hash` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `recovery_code_hash` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `recovery_code_created_at` timestamp NULL DEFAULT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login` timestamp NULL DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `room_ids` (
  `id` int NOT NULL,
  `room_id` text COLLATE utf8mb4_general_ci NOT NULL,
  `room_udp_host` text COLLATE utf8mb4_general_ci,
  `room_udp_port` text COLLATE utf8mb4_general_ci,
  `world_id` text COLLATE utf8mb4_general_ci NOT NULL,
  `zone_id` text COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

INSERT INTO `room_ids` (`id`, `room_id`, `room_udp_host`, `room_udp_port`, `world_id`, `zone_id`) VALUES
(1, '56092cc3-d968-4d2d-8c54-98ed0817hu97', 'ip_address', '13001', '1', '[1-1]');

CREATE TABLE `trades` (
  `id` int NOT NULL,
  `trade_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `player_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `morty_trade_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `requested_morty_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `request_variant` varchar(20) COLLATE utf8mb4_general_ci DEFAULT 'Normal',
  `is_free_trade` tinyint(1) DEFAULT '1',
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `trade_offers` (
  `id` int NOT NULL,
  `trade_offer_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `trade_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `player_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `morty_offer_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` datetime DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `users` (
  `id` int UNSIGNED NOT NULL,
  `banned` int NOT NULL DEFAULT '0',
  `recovery_code_hash` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `secret` varchar(255) COLLATE utf8mb4_general_ci NOT NULL,
  `room_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `world_id` int NOT NULL DEFAULT '1',
  `session_id` varchar(128) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `player_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `username` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `player_avatar_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `level` int DEFAULT '1',
  `xp` bigint DEFAULT '0',
  `streak` int DEFAULT '0',
  `coins` bigint DEFAULT '0',
  `coupons` bigint DEFAULT '0',
  `permits` bigint DEFAULT '0',
  `wins` bigint NOT NULL DEFAULT '0',
  `losses` bigint NOT NULL DEFAULT '0',
  `active_deck_id` int DEFAULT NULL,
  `decks_owned` int DEFAULT '1',
  `morty_slots` int NOT NULL DEFAULT '350',
  `tags` text COLLATE utf8mb4_general_ci,
  `xp_lower` bigint DEFAULT NULL,
  `xp_upper` bigint DEFAULT NULL,
  `donation_request` text COLLATE utf8mb4_general_ci,
  `state` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `zone_id` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `expiry_trade` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `last_event_id` bigint DEFAULT '0',
  `last_seen` timestamp NULL DEFAULT NULL,
  `last_seen_ip` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `created` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `created_with_ip` varchar(50) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `raid_score` int DEFAULT '0'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `user_sessions` (
  `id` bigint UNSIGNED NOT NULL,
  `user_id` int UNSIGNED NOT NULL,
  `token_hash` char(64) COLLATE utf8mb4_general_ci NOT NULL,
  `created_at` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expires_at` timestamp NULL DEFAULT NULL,
  `ip` varchar(64) COLLATE utf8mb4_general_ci DEFAULT NULL,
  `user_agent` varchar(255) COLLATE utf8mb4_general_ci DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

ALTER TABLE `challenges`
  ADD PRIMARY KEY (`id`),
  ADD UNIQUE KEY `uk_challenge_id` (`challenge_id`);

ALTER TABLE `completed_trades`
  ADD PRIMARY KEY (`id`),
  ADD KEY `request_player_id` (`request_player_id`),
  ADD KEY `offer_player_id` (`offer_player_id`);

ALTER TABLE `decks`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `deck_config`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `events`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `friend_list`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `mortydex`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `owned_avatars`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `owned_items`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `owned_morties`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `registered_users`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `room_ids`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `trades`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `trade_offers`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `users`
  ADD PRIMARY KEY (`id`),
  ADD KEY `idx_player_id` (`player_id`),
  ADD KEY `idx_username` (`username`);

ALTER TABLE `user_sessions`
  ADD PRIMARY KEY (`id`);

ALTER TABLE `challenges`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `completed_trades`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `decks`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `deck_config`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `events`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `friend_list`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `mortydex`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `owned_avatars`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `owned_items`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `owned_morties`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `registered_users`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `room_ids`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `trades`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `trade_offers`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `users`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;

ALTER TABLE `user_sessions`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=1;
COMMIT;