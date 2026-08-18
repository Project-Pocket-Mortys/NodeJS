<p align="center">
  <h1 align="center">Project Pocket Mortys</h1>
  <p align="center">
    Community-maintained backend server for Pocket Mortys
  </p>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/node.js-red?style=for-the-badge&amp;logo=nodedotjs" />
  <img src="https://img.shields.io/badge/license-GPLv3-blue?style=for-the-badge&amp;logo=github" />
</p>

## Overview

An independent, community-maintained server implementation for **Pocket Mortys**, designed to preserve online functionality and enable continued gameplay through a custom backend infrastructure.

This repository contains the server-side components required to support client authentication, persistent player data storage, and core gameplay interactions.

## Requirements
- Node.js
- MySQL or MariaDB
- Apache or Nginx

## Instructions
Copy package.json and server.js to a directory of your choosing then go to your command line and type in "npm install" without the quotes.
This will install all the currently required libraries

## To Do
- Battle Bots
- Battle friends
- PVP
- Raid & other event Battles
- Fight Pit battles and scores
- Use Items
- Release Morties
- Blend morties, Buy more deck slots & Upgrade Storage in Morty Daycare
- Challenges (Now just doesn't save.)
- When battling morties we don't own insert into mortydex as false unless caught which should be true
- When we change the positions of morties or decks or morties in decks we need to run room:user-modified
- Correct stats to their proper stats when caught and let it scale for ivs and evs
- Leveling up player level and morties
- Get the swap shop working again
- Rotate Events
- Rotate Morties in Gacha

## Completed
- <s>Crafting</s>
- <s>Battle & catch mortys</s>
- <s>Lock Morties</s>
- <s>Fix item spawning</s>
- <s>Fix Morties roaming</s>
- <s>Evolve Mortys</s>
- <s>Healing</s>
- <s>Buy deck slots</s>
- <s>Learn Attacks</s>
- <s>Swap Stop</s>
- <s>Salesman Rick's</s>

## Legal Disclaimer

This project is **unofficial** and is **not affiliated with or endorsed by** Adult Swim, Turner Broadcasting, or the original Pocket Mortys developers.

All trademarks, service marks, and copyrighted assets belong to their respective owners. This repository does not distribute proprietary game assets.

This project is intended for educational, research, and preservation purposes.

## Contributing

Contributions are welcome.

- Submit bug reports
- Improve server stability and performance
- Enhance documentation
- Assist with protocol analysis and reverse engineering

Please open an issue or submit a pull request.

## Support

Use GitHub Issues for bug reports and feature requests.

## License & Attribution

This project is licensed under the **GNU General Public License v3.0 (GPLv3)**. 

If you use, fork, clone, modify, or convert this code, you are legally required under the terms of the GPLv3 to keep the source open-source and **clearly credit**: 

**Project Pocket Mortys Team**  
https://github.com/Project-Pocket-Mortys
