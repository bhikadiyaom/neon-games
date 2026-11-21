THREE GAMES IN THIS FOLDER
==========================
  Neon Arena   (top-down team shooter) ......... double-click "Start Game Server.bat"
  Neon Strike  (first-person 3D shooter) ....... double-click "Start Neon Strike.bat"
  Snake Clash  (snake battle, free for all) .... double-click "Start Snake Clash.bat"
  Each game has its OWN port, so you can run them at the same time:
    Neon Arena  -> http://localhost:3000     Neon Strike -> http://localhost:3003     Snake Clash -> http://localhost:3004
  Your colleague uses the same address with YOUR PC's IP (the start window prints it), e.g. http://192.168.1.68:3003
  Run "Allow Through Firewall.bat" once (it now opens 3000, 3002, 3003 and 3004).
  Starting a game again only restarts that same game; it never stops another program.
  If another program already uses the port, the start file says so (change the PORT line in it).
  Neon Strike and Snake Clash instructions are in the last sections of this file.


NEON ARENA - LAN multiplayer deathmatch
=======================================

HOST (one PC, needs Node.js):
  0. First time only: double-click "Allow Through Firewall.bat" and click Yes.
     (Without this, other PCs can't connect, especially when your network is set to "Public".)
  1. Double-click "Start Game Server.bat".
  2. If Windows Firewall also asks about Node.js, tick both boxes and click Allow.
  3. The window prints a line like:  Your colleague:  http://192.168.1.68:3000

EVERYONE ELSE (just a browser, nothing to install):
  Open that http://...:3000 address in Chrome/Edge, type a name, press PLAY.

CONTROLS
  WASD / arrows = move    Mouse = aim    Click, Space or either Ctrl key = shoot    Tab = scoreboard
  Esc = open the dashboard (settings) during a game, Esc again or RESUME to go back
  Bullets bounce once off walls. You can't hurt yourself or your teammates.
  Green + packs heal 40 HP. You get 1.5s of spawn shield.

DASHBOARD (settings)
  The start screen has a Game settings panel. Press Esc in game to open it again.
  Changes apply to the running match for everyone straight away and are remembered
  (saved in settings.json next to server.js).
  ONLY THE HOST PC (the one running the server) can change settings. Everyone else sees
  them read-only. Open the game on the host PC to change them.
    Play style ........ Multiplayer, or Solo vs bots (practice on your own)
    Team mode ......... Zone Battle (kills + capture zone) or Team Deathmatch (kills only)
    Win at points ..... 0-200, steps of 5 (default 30; 0 = no limit, play forever)
    Player speed ...... 200-450 (default 290)
    Speed boost in zone  0-60% extra speed while standing in the zone (default 20%)
    Capture time ...... 3-20 seconds (default 6)
    Zone size ......... 70-200 px radius (default 110)
    Points per capture  1-20 (default 5)
    Number of bots .... 1-8 in solo (bots fill both teams evenly around the humans)
    Bot difficulty .... Easy / Normal / Hard

WINNING
  When a team's score reaches the "Win at points" target (kills count 1 each, zone captures
  count their points), the match freezes and a winner screen shows the final score and the MVP
  (most kills). After 10 seconds a new match starts automatically with scores reset to 0.
  If both teams are tied at the target, play continues until one of them leads.

SOLO MODE
  Choose "Solo vs bots" in the dashboard, then PLAY. You get AI teammates and AI enemies
  (5 bots = a 3 vs 3 match). Your colleague can still join the same match; bots rebalance.
  The match is paused whenever no human is connected.

TEAMS (Red vs Blue, always)
  Pick Auto / Red / Blue on the join screen. Your team is locked for the whole match; there is
  no way to switch in game. Teams are kept even: if the team you pick already has more players,
  you are put on the smaller one. Red spawns on the left, Blue on the right.
  Every kill adds 1 to your team's score, shown at the top of the screen.

CAPTURE ZONE
  A glowing circle sits at a random place on the map (any side, not just the enemy's).
  Stand inside it with no enemy inside and the ring fills (6 seconds by default). When it
  completes your team gets +5 points and the zone reappears at another random spot, well away
  from the last. Everyone standing inside the zone also moves faster (+20% by default).
  If both teams are inside it shows CONTESTED and progress freezes. If an enemy holds it
  alone, they wear down your progress first. Leaving makes progress fade slowly.

TROUBLESHOOTING
  - Colleague can't connect: firewall. Allow Node.js on Private networks
    (Windows Security > Firewall > Allow an app), or make sure the network is set to "Private".
  - Two PCs connected by one cable with no router: wait about a minute. Windows gives both
    PCs 169.254.x.x addresses on its own. Restart the server and use the 169.254... address it prints.
  - Port 3000 busy: run   set PORT=4000 && node server.js
    (then everyone uses :4000 instead; the firewall rule only opens 3000)


SNAKE CLASH - LAN snake battle (folder: snake-clash)
====================================================
START: double-click "Start Snake Clash.bat" (same steps and address as Neon Arena, see above).

GOAL
  Eat the glowing pellets to grow the longest snake. Everyone plays against everyone.

CONTROLS
  Mouse ............ steer (your snake chases the pointer)
  A / D or arrows .. turn left / right (use instead of the mouse)
  Click, Space, Shift or W (hold) = BOOST. Boosting is fast but burns your length and
  leaves a trail of pellets that anyone can eat.
  Esc .............. open the dashboard during the game (Esc again or RESUME to go back)

RULES
  - Hit another snake's body with your HEAD and you die. Your body turns into pellets for
    whoever gets there first. Make other snakes crash into YOU instead.
  - Hitting your own body is safe. Hitting the red border kills you.
  - Head-on crashes kill both snakes.
  - After dying you respawn in 3 seconds with a short spawn shield (you pass through snakes).

DASHBOARD (host PC only; others see the settings read-only)
  Bots ............. 0-8 computer snakes. Use this to play SOLO or to fill the arena.
  Snake speed ...... 120-300 (default 190)
  Food amount ...... 40-500 pellets on the map (default 180)
  Settings are saved in snake-clash\settings.json.


NEON STRIKE - LAN first-person 3D shooter (folder: fps-strike)
==============================================================
START: double-click "Start Neon Strike.bat" (same steps and address as the other games).
Players only need a browser. Nothing to install, no internet needed.

CONTROLS
  W A S D .......... move            Mouse ........ look (click the game once to capture it)
  Click / Space .... fire (hold = automatic)         R ........ reload
  1 / 2 / 3 or mouse wheel ... Rifle / Shotgun / Sniper
  Shift ............ sprint          Tab ........ scoreboard      M ... minimap: small / large / off
  Arrow keys ....... also turn (use these if the mouse capture does not work)
  Esc .............. dashboard (frees the mouse). RESUME or click the game to go back.

WEAPONS (each has a magazine; reload is automatic when empty)
  Rifle   30 rounds, fast automatic fire, medium damage, long range
  Shotgun 6 shells, 7 pellets per blast, deadly up close and weak at range
  Sniper  5 rounds, slow, 80 damage per hit (two hits kill)
  Green + packs heal 40 HP and come back after 15 seconds. You spawn with a 2 second shield.

MODES
  Deathmatch ......... everyone against everyone, first to the kill limit wins
  Team Deathmatch .... Red vs Blue, no friendly fire, team kills count toward the limit
  When someone wins the match freezes, a winner screen shows, and a new match starts after
  10 seconds.

DASHBOARD (host PC only for match settings; your own controls are saved per PC)
  Game mode ......... Deathmatch or Team Deathmatch
  Enemy radar ....... ON (default): the minimap shows EVERY enemy as a ring with a line for
                      the way they face; teammates are solid dots. A yellow halo means they
                      just fired. OFF: only teammates and players who just fired show up.
  Play style ........ Multiplayer, or Solo vs bots (computer players with AI)
  Win at kills ...... 0-100 in steps of 5 (default 20; 0 = never ends)
  Move speed ........ 60-160%
  Number of bots .... 1-8 (they fill both teams evenly around the humans)
  Bot difficulty .... Easy / Normal / Hard (Hard bots react and aim much faster)
  Mouse sensitivity, field of view, volume ... local to each player's own PC
  Match settings are saved in fps-strike\settings.json.

NOTES
  - Movement is decided by each player's own browser (smooth, no lag); the server decides
    hits, damage, ammo and kills. It is built for friends on a LAN, not for cheat-proof play.
  - The 3D view is drawn with the browser's 2D canvas (a raycaster, like the classic 90s
    shooters), so it runs on any normal PC without a graphics card.
