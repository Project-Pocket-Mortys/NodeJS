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

CREATE TABLE `gacha_contents` (
  `id` int NOT NULL,
  `gacha_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `reward` enum('ITEM','MORTY') COLLATE utf8mb4_general_ci NOT NULL,
  `quantity` int NOT NULL DEFAULT '1',
  `division_guarantee` int DEFAULT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `gacha_content_items` (
  `id` int NOT NULL,
  `gacha_content_id` int NOT NULL,
  `item_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

CREATE TABLE `gacha_drop_rates` (
  `id` int NOT NULL,
  `gacha_promo_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `division` int NOT NULL,
  `chance` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

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

CREATE TABLE `gacha_promo_morty_attacks` (
  `id` int NOT NULL,
  `gacha_promo_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `morty_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `position` int NOT NULL,
  `attack_id` varchar(64) COLLATE utf8mb4_general_ci NOT NULL,
  `pp` int NOT NULL,
  `pp_stat` int NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci;

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
  `dev` tinyint(1) NOT NULL DEFAULT '0',
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

ALTER TABLE `event_queue`
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

ALTER TABLE `completed_trades`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

ALTER TABLE `decks`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7022;

ALTER TABLE `deck_config`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

ALTER TABLE `events`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

ALTER TABLE `event_queue`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=11;

ALTER TABLE `friend_list`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=878;

ALTER TABLE `mortydex`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7005;

ALTER TABLE `owned_avatars`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6988;

ALTER TABLE `owned_items`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=15887;

ALTER TABLE `owned_morties`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7271;

ALTER TABLE `registered_users`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=19;

ALTER TABLE `room_ids`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

ALTER TABLE `trades`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=6;

ALTER TABLE `trade_offers`
  MODIFY `id` int NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=2;

ALTER TABLE `users`
  MODIFY `id` int UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=7020;

ALTER TABLE `user_sessions`
  MODIFY `id` bigint UNSIGNED NOT NULL AUTO_INCREMENT, AUTO_INCREMENT=76;
COMMIT;