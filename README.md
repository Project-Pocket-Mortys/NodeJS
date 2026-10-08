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

---

## Overview

**Project Pocket Mortys** is an independent, community-maintained backend server implementation for **Pocket Mortys**.

The project aims to preserve and restore online functionality by providing an alternative backend infrastructure capable of handling the services required by the game client.

The project is continuously being developed, with additional gameplay systems and features being restored or implemented over time.

## Requirements

The server requires the following software:

* **Node.js**
* **MySQL or MariaDB**
* **Apache or Nginx**

Depending on your deployment environment, additional system configuration may be required for networking, reverse proxying, HTTPS, databases, or other server infrastructure.

## Installation

Clone or download the repository to a directory of your choice.

If you are installing the server manually, make sure `package.json` and `server.js` are present in the same directory.

From the project directory, run:

```bash
npm install
```

This will install the currently required Node.js dependencies.

Once the dependencies have been installed, configure the server and database connection according to your environment before starting the server.

## To Do

* Battle friends
* PVP (XP calculated earned win or loss. Use Items as well.)
* Raid & other event Battles
* Fight Pit battles and scores
* Use Items
* Release Morties
* Blend morties, Buy more deck slots
* Challenges (Now just doesn't save.)
* When battling morties we don't own insert into mortydex as false unless caught which should be true
* When we change the positions of morties or decks or morties in decks we need to run room:user-modified
* Correct stats to their proper stats when caught and let it scale for ivs and evs
* Get the swap shop working again
* Rotate Events
* Rotate Morties in Gacha

## Completed

* <s>Leveling up player level and morties</s>
* <s>Battle Bots</s>
* <s>Upgrade Storage in Morty Daycare</s>
* <s>Crafting</s>
* <s>Battle & catch mortys</s>
* <s>Lock Morties</s>
* <s>Fix item spawning</s>
* <s>Fix Morties roaming</s>
* <s>Evolve Mortys</s>
* <s>Healing</s>
* <s>Buy deck slots</s>
* <s>Learn Attacks</s>
* <s>Swap Stop</s>
* <s>Salesman Rick's</s>

## Contributing

Contributions are welcome.

- Submit a pull request (Code MUST be tested and confirmed working)
- Improve server stability and performance
- Enhance documentation
- Assist with protocol analysis and reverse engineering

## Legal Disclaimer

This project is **unofficial** and is **not affiliated with or endorsed by** Adult Swim, Turner Broadcasting, or the original Pocket Mortys developers.

All trademarks, service marks, and copyrighted assets belong to their respective owners. This repository does not distribute proprietary game assets.

This project is intended for educational, research, and preservation purposes.

## License & Attribution

This project is licensed under the **GNU General Public License v3.0 (GPLv3)**.

You are free to use, fork, clone, modify, and redistribute this project, provided that all applicable terms of the GPLv3 are followed.

Any modified, forked, or derivative version of this project that is distributed or made available to others must remain **open source** and must comply with the corresponding source-code and licensing requirements of the GPLv3. Source code for such versions must be made available in accordance with the GPLv3.

**Credit to the Project Pocket Mortys Team must remain clearly and visibly displayed to users. Attribution must not be removed, hidden, obscured, or altered in a way that prevents users from readily identifying the original project.**

The required attribution is:

**Project Pocket Mortys Team**
https://github.com/Project-Pocket-Mortys

This attribution should remain prominently visible in the software, documentation, website, application, or other user-facing interface where the project or a derivative work is used, as reasonably applicable.

Nothing in this notice limits the rights granted by the GPLv3. The complete terms governing the use, modification, and redistribution of this project are provided by the **GNU General Public License v3.0**.

---

<p align="center">
  <strong>Project Pocket Mortys</strong><br>
  Community-maintained server preservation project
</p>